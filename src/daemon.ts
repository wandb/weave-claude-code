// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import type {
  HookInput,
  SessionStartHookInput,
  InstructionsLoadedHookInput,
  UserPromptSubmitHookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PermissionRequestHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TeammateIdleHookInput,
  PreCompactHookInput,
  StopHookInput,
  SessionEndHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import * as weave from 'weave';
import { loadSettings, VERSION } from './setup.js';
import { appendToLog, deepEqual } from './utils.js';
import { parseSessionFd } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import {
  ATTR,
  CompactionAttrs,
  addPermissionRequestEvent,
  setCompactionAttrs,
  toolDisplayName,
  assistantOutputMessages,
  buildUsage,
  contentBlocksToParts,
  providerFromModel,
  parseTimestamp,
  snippet,
  jsonStr,
} from './genaiSpans.js';
import { resolveDaemonConfig, daemonConfigFingerprint, missingConfig } from './config.js';
import type { DaemonConfig } from './config.js';
import {
  resolvePermissionIfPending,
  hashPrompt,
  computeSubagentTranscriptPath,
  subagentsDirFor,
  extractUserMessageContent,
  lastAssistantTextEndsWith,
  readSubagentFirstLineWithRetry,
  newSessionState,
  upsertInstruction,
} from './sessionState.js';
import type {
  PendingToolCall,
  PendingSubagentCall,
  SessionState,
  LoadedInstruction,
} from './sessionState.js';
import type { AssistantCallDetail } from './parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Socket control message (not a hook event): `shutdown` stops the daemon;
 *  `config-hash` replies with the loaded config's fingerprint (drift
 *  detection) plus the daemon's identity (pid, version, entry path). */
type ControlMessage = {
  command: 'shutdown' | 'config-hash';
}

/** Raw hook-event payload forwarded by hook-handler.sh. */
type HookPayload = Record<string, unknown>;

type ToolParent = weave.Turn | weave.SubAgent;

type TeamMember = {
  toolUseId: string;
  call: PendingSubagentCall;
  conversation: weave.Conversation;
  coordinatorTranscriptPath: string;
  ownerSessionId: string;
};

type IdleSubagent = {
  sessionId: string;
  subAgent: weave.SubAgent;
  conversation: weave.Conversation;
  subagentType: string;
  transcriptPath: string;
};

function isControlMessage(payload: unknown): payload is ControlMessage {
  if (typeof payload !== 'object' || payload === null) return false;
  const cmd = (payload as Record<string, unknown>).command;
  return cmd === 'shutdown' || cmd === 'config-hash';
}

/** Real path of the daemon's entry script (npm bin symlink resolved), so
 *  `status` can report which build is actually running. */
function daemonEntryPath(): string {
  const entry = process.argv[1] ?? '';
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
}

function chatMessageKey(call: AssistantCallDetail, callIdx: number): string {
  return call.responseId ?? `idx:${callIdx}`;
}

function parseIsoOrNow(ts: string | undefined): Date {
  return parseTimestamp(ts) ?? new Date();
}

function openChat(parent: weave.Turn | weave.SubAgent, call: AssistantCallDetail): weave.LLM | undefined {
  if (!call.model) return undefined;
  const provider = providerFromModel(call.model);
  return parent.startLLM({
    model: call.model,
    ...(provider ? { providerName: provider } : {}),
    startTime: parseIsoOrNow(call.prevTimestamp ?? call.timestamp),
  });
}

function recordChat(llm: weave.LLM, call: AssistantCallDetail, agentName?: string): void {
  const parts = contentBlocksToParts(call.contentBlocks);
  llm.record({
    ...(parts.length ? { outputMessages: [{ role: 'assistant', parts }] } : {}),
    usage: buildUsage(call.usage, call.reasoningTokens),
    outputType: 'text',
    ...(call.responseId ? { responseId: call.responseId } : {}),
    ...(call.finishReason ? { finishReasons: [call.finishReason] } : {}),
  });
  if (agentName) llm.setAttributes({ [ATTR.AGENT_NAME]: agentName });
  llm.end({ endTime: parseIsoOrNow(call.timestamp) });
}

// Keep resumed sessions warm across long idle gaps.
const INACTIVITY_TIMEOUT_MS = 120 * 60 * 1_000;  // 120 minutes
// Bound how long stuck in-flight work can keep the daemon alive.
const INFLIGHT_HOLD_MAX_MS = 60 * 60 * 1_000;   // 60 minutes
const CONNECTION_TIMEOUT_MS = 5_000;            // 5 seconds per connection

const MAX_SOCKET_PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB per message

export class GlobalDaemon {
  private server?: net.Server;
  private running = false;
  private lastActivity = Date.now();
  /** Inactivity shutdown threshold. Overridable via WEAVE_INACTIVITY_MS (ms) for
   *  testing and for ops (e.g. raising it for long-running agent-teams work). */
  private readonly inactivityMs = Number(process.env.WEAVE_INACTIVITY_MS) || INACTIVITY_TIMEOUT_MS;
  private sessions = new Map<string, SessionState>();
  private sessionQueues = new Map<string, Promise<void>>();
  /** InstructionsLoaded files that arrived before their session existed (the
   *  hook can fire before SessionStart). Keyed by session_id; drained into the
   *  session at SessionStart / reconstruction and cleared (also on SessionEnd). */
  private pendingInstructions = new Map<string, LoadedInstruction[]>();
  private tracingEnabled = false;
  /** Cross-session team correlation (coordinator's PreToolUse(Agent) → the
   *  teammate's TeammateIdle), keyed `${team_name}::${name}`. FIFO queue per
   *  key so a re-spawned name never overwrites a live span. */
  private teamMembers = new Map<string, TeamMember[]>();
  /** Agent calls whose span completion belongs to TeammateIdle, not PostToolUse. */
  private teamDispatches = new Set<PendingSubagentCall>();
  /** Unmatched per-session teammates awaiting TeammateIdle. */
  private idleSubagents = new Map<string, IdleSubagent>();

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly config: DaemonConfig,
  ) {}

  async start(): Promise<void> {
    if (this.config.weaveProject && this.config.apiKey) {
      try {
        await this.initWeave();
        this.log('INFO', `OTel tracer initialized — project=${this.config.weaveProject}, endpoint=${this.config.baseUrl}/agents/otel/v1/traces`);
        this.log('INFO', `View traces: https://wandb.ai/${this.config.weaveProject}/weave/agents`);
      } catch (err) {
        this.log('ERROR', `Failed to initialize OTel tracer: ${err} — continuing without tracing`);
        this.tracingEnabled = false;
      }
    } else {
      this.log('INFO', 'No weave_project / API key configured — tracing disabled');
    }

    // Concurrent hook invocations can each cold-start a daemon; only one
    // binds, the losers exit and their event reaches the winner over the socket.
    await this.bindSocketWithHerdProtection();

    this.running = true;
    this.log('INFO', `Daemon started — socket: ${this.socketPath}`);

    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGINT',  () => void this.shutdown('SIGINT'));
    // Route terminal-close cleanup through shutdown to remove the socket inode.
    process.on('SIGHUP',  () => void this.shutdown('SIGHUP'));
    // The next hook's socket probe handles cleanup after SIGKILL or OOM.
    process.on('exit', () => {
      try { if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath); } catch { /* nothing more we can do */ }
    });

    // Check at most every 60s, but more frequently when the timeout is short
    // (env-overridden for tests) so a low WEAVE_INACTIVITY_MS is honored promptly.
    const checkEveryMs = Math.min(60_000, Math.max(500, Math.floor(this.inactivityMs / 4)));
    setInterval(() => this.checkInactivity(), checkEveryMs).unref();
  }

  /** Probe whether a live daemon is accepting connections on the socket. Uses a
   *  real connect() attempt — the inode existing is not proof of a listener
   *  (an ungraceful exit leaves a stale inode behind). */
  private socketHasLiveListener(): Promise<boolean> {
    if (!fs.existsSync(this.socketPath)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const probe = net.createConnection(this.socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => { probe.destroy(); resolve(false); });
    });
  }

  /** Create a fresh server and listen once, resolving on success and rejecting
   *  on the first listen error. A new server per attempt — one that errored on
   *  listen cannot be reused. Socket is owner-only (umask 0o077). */
  private listenOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const prevUmask = process.umask(0o077);
      // allowHalfOpen lets handleConnection write a reply after the client
      // half-closes (the `config-hash` query). Every branch closes the socket
      // explicitly so the high-frequency hook-event path still ends promptly.
      const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleConnection(socket));
      const onError = (err: Error) => { process.umask(prevUmask); reject(err); };
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        process.umask(prevUmask);
        server.removeListener('error', onError);
        this.server = server;
        resolve();
      });
    });
  }

  /** Bind the socket, tolerant of a start herd: on EADDRINUSE/EEXIST, a live
   *  listener means another daemon won (exit 0); only a confirmed-stale inode
   *  is unlinked and retried, so a late starter can't delete the winner's. */
  private async bindSocketWithHerdProtection(): Promise<void> {
    const MAX_RECLAIM_ATTEMPTS = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.listenOnce();
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EEXIST') throw err;
        if (await this.socketHasLiveListener()) {
          this.log('INFO', 'Another daemon already owns the socket — exiting to avoid a herd');
          process.exit(0);
        }
        // Stale inode from an ungraceful exit — reclaim it and retry.
        if (attempt >= MAX_RECLAIM_ATTEMPTS) throw err;
        try { fs.unlinkSync(this.socketPath); } catch { /* already cleaned; retry */ }
      }
    }
  }

  // ── tracer initialization ───────────────────────────────────────────────

  private async initWeave(): Promise<void> {
    if (!this.config.weaveProject) throw new Error('weaveProject required to init tracer');
    if (!this.config.apiKey) throw new Error('apiKey required to init tracer');

    const [entity, project] = this.config.weaveProject.split('/', 2);
    if (!entity || !project) {
      throw new Error(`Invalid weave_project format: '${this.config.weaveProject}' (expected entity/project)`);
    }

    // weave.init reads the exporter endpoint and API key from the environment.
    process.env['WF_TRACE_SERVER_URL'] = this.config.baseUrl;
    process.env['WANDB_API_KEY'] = this.config.apiKey;

    // Surface exporter failures in the daemon log.
    const otelDiag = (message: string, ...args: unknown[]) =>
      this.log('ERROR', `otel: ${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`);
    diag.setLogger(
      { verbose: otelDiag, debug: otelDiag, info: otelDiag, warn: otelDiag, error: otelDiag },
      DiagLogLevel.WARN,
    );

    await weave.init(this.config.weaveProject);
    this.tracingEnabled = true;
  }

  // ── connection handling ───────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejectedForSize = false;

    const timer = setTimeout(() => {
      this.log('ERROR', 'Connection timed out — closing');
      socket.destroy();
    }, CONNECTION_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SOCKET_PAYLOAD_BYTES) {
        rejectedForSize = true;
        clearTimeout(timer);
        this.log('ERROR', `Socket payload exceeded ${MAX_SOCKET_PAYLOAD_BYTES} bytes — closing connection`);
        socket.destroy();
        return;
      }

      chunks.push(chunk);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      if (rejectedForSize) {
        socket.destroy();
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        socket.end();
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        this.log('ERROR', `Malformed JSON from hook: ${raw.slice(0, 200)}`);
        socket.end();
        return;
      }

      this.lastActivity = Date.now();

      if (isControlMessage(payload)) {
        if (payload.command === 'config-hash') {
          socket.end(JSON.stringify({
            config_hash: daemonConfigFingerprint(this.config),
            pid: process.pid,
            version: VERSION,
            path: daemonEntryPath(),
          }));
        } else {
          socket.end();
          void this.shutdown('control message');
        }
        return;
      }

      // Payload is already buffered, so close now rather than holding the
      // half-open socket open while routeEvent runs.
      socket.end();
      const hookPayload = payload as HookPayload;
      const sessionId = hookPayload['session_id'] as string | undefined;
      if (sessionId) {
        this.enqueueForSession(sessionId, () => this.routeEvent(hookPayload));
      } else {
        void this.routeEvent(hookPayload);
      }
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      this.log('ERROR', `Socket error: ${err.message}`);
    });
  }

  // ── event routing ─────────────────────────────────────────────────────────

  private async routeEvent(payload: HookPayload): Promise<void> {
    const input = payload as HookInput;
    const sessionId = input.session_id;
    if (!sessionId) {
      this.log('ERROR', 'Missing session_id in payload');
      return;
    }

    this.log('INFO', `${input.hook_event_name} session=${sessionId}${input.agent_id ? ` agent=${input.agent_id}` : ''}`);

    // Isolate SDK active-span state across concurrent sessions.
    await weave.runIsolated(() => this.dispatchEvent(input, sessionId));
  }

  private async dispatchEvent(input: HookInput, sessionId: string): Promise<void> {
    try {
      switch (input.hook_event_name) {
        case 'SessionStart':
          await this.handleSessionStart(sessionId, input);
          break;
        case 'InstructionsLoaded':
          // Synchronous: reads the instruction file inline; nothing to await.
          this.handleInstructionsLoaded(sessionId, input);
          break;
        case 'UserPromptSubmit':
          await this.handleUserPromptSubmit(sessionId, input);
          break;
        case 'PreToolUse':
          await this.handlePreToolUse(sessionId, input);
          break;
        case 'PermissionRequest':
          await this.handlePermissionRequest(sessionId, input);
          break;
        case 'PostToolUse':
          await this.handlePostToolUse(sessionId, input);
          break;
        case 'PostToolUseFailure':
          await this.handlePostToolUseFailure(sessionId, input);
          break;
        case 'SubagentStart':
          await this.handleSubagentStart(sessionId, input);
          break;
        case 'SubagentStop':
          await this.handleSubagentStop(sessionId, input);
          break;
        case 'TeammateIdle':
          await this.handleTeammateIdle(sessionId, input);
          break;
        case 'PreCompact':
          await this.handlePreCompact(sessionId, input);
          break;
        case 'Stop':
          await this.handleStop(sessionId, input);
          break;
        case 'SessionEnd':
          await this.handleSessionEnd(sessionId, input);
          break;
        default:
          break;
      }
    } catch (err) {
      this.log('ERROR', `Error handling ${input.hook_event_name}: ${err}`);
    }
  }

  // ── event handlers ────────────────────────────────────────────────────────

  /** Resolve the conversation id, build the SessionState, register it, and drain
   *  buffered instructions. Shared by SessionStart and post-restart rebuild. */
  private async buildSession(
    sessionId: string,
    transcript: TranscriptFile,
    opts: { source: string; cwd: string; initialRequestModel?: string },
  ): Promise<SessionState> {
    const conversationId = await this.resolveConversationId(sessionId, transcript.resolvedPath, opts.source);
    const session = newSessionState({
      sessionId,
      conversationId,
      transcript,
      cwd: opts.cwd,
      source: opts.source,
      initialRequestModel: opts.initialRequestModel,
      agentName: this.config.agentName,
      tracingEnabled: this.tracingEnabled,
    });
    this.sessions.set(sessionId, session);
    this.drainPendingInstructions(session);
    return session;
  }

  private async handleSessionStart(sessionId: string, input: SessionStartHookInput): Promise<void> {
    if (this.sessions.has(sessionId)) return; // idempotent

    const rawPath = input.transcript_path;
    if (!rawPath) {
      this.log('ERROR', `Missing transcript_path for session ${sessionId}`);
      return;
    }

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(rawPath);
    } catch (err) {
      this.log('ERROR', `Invalid transcript_path for session ${sessionId}: ${err}`);
      return;
    }

    const session = await this.buildSession(sessionId, transcript, {
      source: input.source,
      cwd: input.cwd,
      initialRequestModel: input.model,
    });

    const resumed = session.conversationId !== sessionId;
    this.log('INFO', `Session created: ${sessionId}${resumed ? ` (resumed; conversation=${session.conversationId})` : ''}`);
    this.log(
      'DEBUG',
      `SessionStart details: session=${sessionId} conversation=${session.conversationId} source=${session.source} model=${session.initialRequestModel ?? 'unknown'} cwd=${session.cwd || '(empty)'} transcript_path=${transcript.resolvedPath} transcript_file=${path.basename(transcript.resolvedPath)} active_sessions=${this.sessions.size}`,
    );
  }

  private async resolveConversationId(
    sessionId: string,
    transcriptPath: string,
    source: string,
  ): Promise<string> {
    const MAX_CHAIN_DEPTH = 32;
    const MAX_HEAD_READ_ATTEMPTS = 4;
    const HEAD_READ_RETRY_MS = 100;

    const transcriptDir = path.dirname(transcriptPath);
    const seen = new Set<string>([sessionId]);
    let current = sessionId;
    let currentPath = transcriptPath;

    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      let parent: string | undefined;
      // Only the FIRST hop needs retry — ancestor transcripts are static.
      const attempts = depth === 0 ? MAX_HEAD_READ_ATTEMPTS : 1;
      for (let i = 0; i < attempts; i++) {
        const head = readFirstTranscriptLine(currentPath);
        const ff = head?.['forkedFrom'] as Record<string, unknown> | undefined;
        const ffId = ff?.['sessionId'];
        if (typeof ffId === 'string' && ffId) {
          parent = ffId;
          break;
        }
        if (head !== undefined) break; // head parseable but no fork — root
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, HEAD_READ_RETRY_MS));
      }
      if (!parent || seen.has(parent)) break;
      seen.add(parent);

      const parentPath = path.join(transcriptDir, `${parent}.jsonl`);
      current = parent;
      if (!fs.existsSync(parentPath)) {
        // Parent transcript not on disk (e.g. resumed across machines): stop —
        // the recorded parent id is still the best stitching key we have.
        this.log(
          'DEBUG',
          `resolveConversationId: parent transcript not on disk: ${parentPath} — stopping chain walk at ${parent}`,
        );
        break;
      }
      currentPath = parentPath;
    }

    if (current !== sessionId && source !== 'resume') {
      // Unexpected payload (fork found but source isn't 'resume') — still
      // stitch by the chain root; just surface the mismatch.
      this.log(
        'DEBUG',
        `resolveConversationId: forkedFrom chain found but source='${source}' (expected 'resume') session=${sessionId} root=${current}`,
      );
    }
    return current;
  }

  private async getOrReconstructSession(
    sessionId: string,
    input: HookInput,
  ): Promise<SessionState | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const rawPath = input.transcript_path;
    if (!rawPath) return undefined;

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(rawPath);
    } catch (err) {
      this.log('ERROR', `Cannot reconstruct session ${sessionId}: invalid transcript_path: ${err}`);
      return undefined;
    }

    // source/model aren't on every hook variant (this reconstructs from a
    // UserPromptSubmit), so read them best-effort off the raw record.
    const raw = input as Record<string, unknown>;
    const source = (raw['source'] as string | undefined) ?? 'reconstructed';
    const cwd = input.cwd;
    const initialRequestModel = raw['model'] as string | undefined;
    const session = await this.buildSession(sessionId, transcript, { source, cwd, initialRequestModel });
    this.log(
      'INFO',
      `Session reconstructed after restart: ${sessionId} (conversation=${session.conversationId})`,
    );
    return session;
  }

  private handleInstructionsLoaded(sessionId: string, input: InstructionsLoadedHookInput): void {
    if (!this.tracingEnabled) return;
    const filePath = input.file_path;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      this.log('DEBUG', `InstructionsLoaded: unreadable ${filePath}: ${err}`);
      return;
    }

    const instruction: LoadedInstruction = { filePath, content };
    const session = this.sessions.get(sessionId);
    if (session) {
      upsertInstruction(session.systemInstructions, instruction);
    } else {
      // Session not set up yet; buffer until SessionStart / reconstruct drains it.
      const pending = this.pendingInstructions.get(sessionId) ?? [];
      upsertInstruction(pending, instruction);
      this.pendingInstructions.set(sessionId, pending);
    }
    this.log(
      'DEBUG',
      `InstructionsLoaded: session=${sessionId} reason=${input.load_reason} file=${path.basename(filePath)} bytes=${content.length}${session ? '' : ' (buffered)'}`,
    );
  }

  /** Move any instructions buffered before this session existed into its state,
   *  then discard the buffer. */
  private drainPendingInstructions(session: SessionState): void {
    const pending = this.pendingInstructions.get(session.sessionId);
    this.pendingInstructions.delete(session.sessionId);
    if (!pending?.length) return;
    for (const instruction of pending) upsertInstruction(session.systemInstructions, instruction);
    this.log('DEBUG', `Drained ${pending.length} buffered instruction file(s) into session ${session.sessionId}`);
  }

  private startSessionTurn(session: SessionState, userMessage?: string): weave.Turn | undefined {
    if (!session.conversation) return undefined;
    const turn = session.conversation.startTurn({
      agentVersion: VERSION,
      model: session.initialRequestModel,
      userMessage,
      systemInstructions: session.systemInstructions.map((i) => i.content),
      startTime: new Date(),
    });
    turn.setAttributes({
      [ATTR.WEAVE_CWD]: session.cwd,
      [ATTR.WEAVE_SOURCE]: session.source,
    });
    session.currentTurn = turn;
    return turn;
  }

  private async handleUserPromptSubmit(sessionId: string, input: UserPromptSubmitHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) {
      this.log('ERROR', `Unknown session (no transcript_path to reconstruct): ${sessionId}`);
      return;
    }
    if (!this.tracingEnabled) return;

    const prompt = input.prompt;
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} current_turn=${session.currentTurn ? 'open' : 'none'} prompt=${snippet(prompt, 120)}`,
    );

    // Close interrupted turns that never received a Stop hook.
    this.finalizeOpenTurn(session, 'superseded_by_next_prompt');

    const turn = this.startSessionTurn(session, prompt);
    if (!turn) return;

    // Drain compaction attrs buffered while no turn was open.
    if (session.pendingCompaction) {
      setCompactionAttrs(turn, session.pendingCompaction);
      session.pendingCompaction = undefined;
    }

    this.log('INFO', 'Created turn span');
  }

  private async handlePreToolUse(sessionId: string, input: PreToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;

    const agentId = input.agent_id;
    const toolUseId = input.tool_use_id;
    const toolName = input.tool_name;
    if (!toolUseId || !toolName) return;

    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    if (toolName === 'Agent' && toolInput['subagent_type']) {
      const spawner = agentId ? session.activeSubagents.get(agentId)?.subAgent : session.currentTurn;
      if (!spawner) {
        this.log('ERROR', `PreToolUse(Agent): no parent for session=${sessionId}${agentId ? ` agent=${agentId}` : ''}`);
        return;
      }
      const subagentType = toolInput['subagent_type'] as string;
      const prompt = typeof toolInput['prompt'] === 'string' ? toolInput['prompt'] : '';
      const subAgent = spawner.startSubagent({ name: subagentType, agentVersion: VERSION, startTime: new Date() });
      subAgent.setAttributes({
        [ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]: toolUseId,
        ...(prompt ? { [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: prompt }]) } : {}),
      });
      const call: PendingSubagentCall = {
        kind: 'subagent',
        subagentType,
        subAgent,
        promptHash: hashPrompt(prompt),
      };
      session.pendingCalls.set(toolUseId, call);

      const teamName = typeof toolInput['team_name'] === 'string' ? toolInput['team_name'] : undefined;
      const memberName = typeof toolInput['name'] === 'string' && toolInput['name']
        ? toolInput['name']
        : subagentType;
      if (teamName && session.conversation) {
        const key = `${teamName}::${memberName}`;
        const queue = this.teamMembers.get(key) ?? [];
        queue.push({
          toolUseId,
          call,
          conversation: session.conversation,
          coordinatorTranscriptPath: session.transcript.resolvedPath,
          ownerSessionId: sessionId,
        });
        this.teamMembers.set(key, queue);
        this.teamDispatches.add(call);
        this.log('INFO', `Team member registered: ${key} (cross-session nesting, queue depth ${queue.length})`);
      }
      return;
    }

    const parent = this.resolveToolParent(session, agentId);
    if (!parent) {
      this.log('ERROR', `PreToolUse: no parent for session=${sessionId} tool=${toolName}`);
      return;
    }

    const tool = parent.startTool({
      name: toolName,
      args: jsonStr(toolInput),
      toolCallId: toolUseId,
      startTime: new Date(),
    });
    const toolAttrs: Attributes = { [ATTR.WEAVE_DISPLAY_NAME]: toolDisplayName(toolName, toolInput) };
    if ('name' in parent && typeof parent.name === 'string') {
      toolAttrs[ATTR.AGENT_NAME] = parent.name;
    }
    tool.setAttributes(toolAttrs);
    session.pendingCalls.set(toolUseId, { kind: 'tool', tool, toolName, toolInput });
  }

  private resolveToolParent(
    session: SessionState,
    agentId: string | undefined,
  ): ToolParent | undefined {
    if (!agentId) return session.currentTurn;
    return session.activeSubagents.get(agentId)?.subAgent ?? session.currentTurn;
  }

  private async handlePermissionRequest(sessionId: string, input: PermissionRequestHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolName = input.tool_name;
    if (!toolName) return;

    let pending: PendingToolCall | undefined;
    for (const call of session.pendingCalls.values()) {
      if (call.kind !== 'tool') continue;
      if (call.toolName === toolName && !call.permissionRequested && deepEqual(call.toolInput, input.tool_input)) {
        pending = call;
        break;
      }
    }
    if (!pending) {
      this.log('DEBUG', `PermissionRequest: no pending tool call for tool_name=${toolName}`);
      return;
    }

    pending.permissionRequested = true;
    addPermissionRequestEvent(pending.tool, {
      suggestions: input.permission_suggestions,
      timestamp: new Date(),
    });

    this.log('DEBUG', `Permission request recorded for ${toolName}`);
  }

  private async handlePostToolUse(sessionId: string, input: PostToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !input.tool_use_id) return;
    this.settleCall(session, input.tool_use_id, input.tool_response, false);
  }

  private async handlePostToolUseFailure(sessionId: string, input: PostToolUseFailureHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !input.tool_use_id) return;
    this.settleCall(session, input.tool_use_id, input.error, true);
  }

  private settleCall(session: SessionState, toolUseId: string, output: unknown, failure: boolean): void {
    const call = session.pendingCalls.get(toolUseId);
    if (!call) return;

    if (call.kind === 'subagent') {
      // Team dispatches are complete only when TeammateIdle supplies the
      // teammate transcript. PostToolUse merely acknowledges the dispatch.
      if (!this.teamDispatches.has(call)) {
        this.closeSubagent(call.subAgent, output, failure);
        if (call.agentId) session.activeSubagents.delete(call.agentId);
      }
    } else {
      resolvePermissionIfPending(call, !failure);
      call.tool.result = failure ? String(output) : jsonStr(output);
      if (failure) {
        call.tool.setAttributes({ [ATTR.ERROR_TYPE]: this.errorTypeFor(output) });
        call.tool.end({ error: new Error(String(output)) });
      } else {
        call.tool.end();
      }
    }

    session.pendingCalls.delete(toolUseId);
  }

  private closeSubagent(sub: weave.SubAgent, output: unknown, failure: boolean): void {
    if (output !== undefined && output !== null && output !== '') {
      const outputText = typeof output === 'string' ? output : jsonStr(output);
      sub.setAttributes({ [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([outputText]) });
    }
    if (failure) {
      sub.setAttributes({ [ATTR.ERROR_TYPE]: this.errorTypeFor(output) });
      sub.end({ error: new Error(typeof output === 'string' ? output : 'subagent failed') });
    } else {
      sub.end();
    }
  }

  private matchPendingSubagent(
    session: SessionState,
    subagentType: string,
    prompt: string | undefined,
  ): { call: PendingSubagentCall | undefined; candidateCount: number } {
    const promptHash = prompt === undefined ? undefined : hashPrompt(prompt);
    let exact: PendingSubagentCall | undefined;
    let only: PendingSubagentCall | undefined;
    let candidateCount = 0;
    for (const call of session.pendingCalls.values()) {
      if (call.kind !== 'subagent' || call.agentId || call.subagentType !== subagentType) continue;
      candidateCount++;
      only = call;
      if (!exact && promptHash !== undefined && call.promptHash === promptHash) exact = call;
    }
    return { call: exact ?? (candidateCount === 1 ? only : undefined), candidateCount };
  }

  private async handleSubagentStart(sessionId: string, input: SubagentStartHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;

    const agentId = input.agent_id;
    if (!agentId) return;

    const agentType = input.agent_type;

    // SubagentStart has no tool_use_id, so correlate by firing-prompt hash and agent type.
    const subagentPath = computeSubagentTranscriptPath(session.transcript.resolvedPath, agentId);
    const firstLine = await readSubagentFirstLineWithRetry(subagentPath);
    const firingPrompt = extractUserMessageContent(firstLine);
    const { call, candidateCount } = this.matchPendingSubagent(session, agentType, firingPrompt);
    if (!call) {
      const reason = firingPrompt === undefined ? 'transcript unavailable' : 'dispatch correlation ambiguous';
      // A start with no plausible dispatch is the per-session teammate shape:
      // keep one marker open until TeammateIdle emits its full transcript. Do
      // not do this for ambiguous live dispatches, which would duplicate them.
      if (candidateCount === 0 && session.currentTurn && session.conversation) {
        const subAgent = session.currentTurn.startSubagent({ name: agentType, agentVersion: VERSION, startTime: new Date() });
        subAgent.setAttributes({
          [ATTR.WEAVE_DISPLAY_NAME]: `Agent: ${agentType}`,
          [ATTR.WEAVE_ORPHAN_REASON]: 'awaiting TeammateIdle without Agent dispatch',
        });
        subAgent.record({ agentId });
        this.idleSubagents.set(`${sessionId}::${agentId}`, {
          sessionId,
          subAgent,
          conversation: session.conversation,
          subagentType: agentType,
          transcriptPath: subagentPath,
        });
        this.log('INFO', `Subagent started: agentId=${agentId} type=${agentType} awaiting TeammateIdle`);
        return;
      }
      this.log('ERROR', `SubagentStart: ${reason}; leaving agentId=${agentId} type=${agentType} unbound`);
      return;
    }

    call.agentId = agentId;
    call.subAgent.record({ agentId });
    session.activeSubagents.set(agentId, call);
    this.log('INFO', `Subagent started: agentId=${agentId} type=${agentType}`);
  }

  private recoverSubagent(
    session: SessionState,
    agentId: string,
    agentType: string,
  ): weave.SubAgent | undefined {
    const turn = session.currentTurn ?? this.startSessionTurn(session);
    if (!turn) return undefined;
    const subAgent = turn.startSubagent({ name: agentType, agentVersion: VERSION, startTime: new Date() });
    subAgent.setAttributes({
      [ATTR.WEAVE_DISPLAY_NAME]: `Agent: ${agentType}`,
      [ATTR.WEAVE_ORPHAN_REASON]: 'recovered at SubagentStop after daemon restart',
    });
    subAgent.record({ agentId });
    this.log('INFO', `SubagentStop: recovered subagent agentId=${agentId} type=${agentType} after restart`);
    return subAgent;
  }

  private async handleSubagentStop(sessionId: string, input: SubagentStopHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || !this.tracingEnabled) return;

    const agentId = input.agent_id;
    if (!agentId) return;

    const agentType = input.agent_type;
    const agentTranscriptPath = input.agent_transcript_path
      ?? computeSubagentTranscriptPath(session.transcript.resolvedPath, agentId);
    const idle = this.idleSubagents.get(`${sessionId}::${agentId}`);
    if (idle) {
      idle.transcriptPath = agentTranscriptPath;
      this.log('DEBUG', `Subagent stopped: agentId=${agentId} type=${idle.subagentType} awaiting TeammateIdle`);
      return;
    }

    let tracked = session.activeSubagents.get(agentId);
    let candidateCount = 0;
    if (!tracked) {
      const firstLine = await readSubagentFirstLineWithRetry(agentTranscriptPath);
      const match = this.matchPendingSubagent(session, agentType, extractUserMessageContent(firstLine));
      tracked = match.call;
      candidateCount = match.candidateCount;
      if (tracked) {
        tracked.agentId = agentId;
        tracked.subAgent.record({ agentId });
        this.log('INFO', `SubagentStop: late-matched agentId=${agentId} type=${agentType}`);
      }
    }

    if (tracked && this.teamDispatches.has(tracked)) {
      session.activeSubagents.delete(agentId);
      this.log('DEBUG', `Subagent stopped: agentId=${agentId} type=${agentType} awaiting TeammateIdle`);
      return;
    }

    // With no plausible live dispatch, this is restart recovery. If multiple
    // dispatches are ambiguous, keep their markers intact and flatten the chat
    // under the turn rather than manufacture a duplicate invoke_agent span.
    const recovered = !tracked && candidateCount === 0
      ? this.recoverSubagent(session, agentId, agentType)
      : undefined;
    const chatParent = tracked?.subAgent ?? recovered ?? session.currentTurn;

    let model: string | undefined;
    let lastAssistantText = input.last_assistant_message;
    if (agentTranscriptPath && chatParent) {
      let agentTranscript: TranscriptFile | undefined;
      try {
        agentTranscript = new TranscriptFile(agentTranscriptPath);
        const parsed = parseSessionFd(agentTranscript.getFd());
        // Earlier turns may be coordinator pre-context, so emit only the last turn.
        const lastTurn = parsed?.turns.at(-1);
        model = lastTurn?.primaryModel();
        lastAssistantText ??= lastTurn?.textBlocks().join('\n');

        if (lastTurn) {
          this.emitChatSpans(chatParent, lastTurn.assistantCalls(), agentType);
        }
      } catch (err) {
        this.log('DEBUG', `SubagentStop: could not parse transcript: ${err}`);
      } finally {
        agentTranscript?.close();
      }
    }

    const subAgent = tracked?.subAgent ?? recovered;
    if (model && subAgent) subAgent.setAttributes({ [ATTR.RESPONSE_MODEL]: model });
    if (recovered) this.closeSubagent(recovered, lastAssistantText, false);
    session.activeSubagents.delete(agentId);
    this.log('DEBUG', `Subagent stopped: agentId=${agentId} type=${agentType} model=${model ?? 'unknown'}`);
  }

  private async handleTeammateIdle(sessionId: string, input: TeammateIdleHookInput): Promise<void> {
    if (!this.tracingEnabled) return;
    const session = this.sessions.get(sessionId);
    const agentType = input.teammate_name;
    const teamName = input.team_name;
    const key = `${teamName}::${agentType}`;
    const queue = this.teamMembers.get(key);

    // Agent teams run the teammate in a different session. The coordinator's
    // Agent dispatch registered this FIFO entry before that session existed.
    if (queue?.length) {
      const member = queue.shift()!;
      if (!queue.length) this.teamMembers.delete(key);

      const idleTranscript = session?.transcript.resolvedPath ?? input.transcript_path;
      const teammateTranscriptPath = this.resolveTeammateTranscript(
        member.coordinatorTranscriptPath,
        agentType,
        idleTranscript,
      );
      this.emitTeammateTurnTrace(member.call.subAgent, member.conversation, agentType, teammateTranscriptPath);
      this.teamDispatches.delete(member.call);
      const owner = this.sessions.get(member.ownerSessionId);
      owner?.pendingCalls.delete(member.toolUseId);
      if (member.call.agentId) owner?.activeSubagents.delete(member.call.agentId);
      this.log('INFO', `TeammateIdle: traced ${agentType} team=${teamName} (cross-session) transcript=${teammateTranscriptPath ?? '(none)'} (queue depth now ${queue.length})`);
      return;
    }

    // Other team keys registered but not this one: most likely the
    // teammate_name ≠ Agent.name invariant broke — log it, then fall through.
    if (this.teamMembers.size > 0) {
      this.log('INFO', `TeammateIdle: no team entry for ${key} (registered: ${[...this.teamMembers.keys()].join(', ')}) — check teammate_name === Agent.name`);
    }

    // A same-session teammate has no Agent dispatch to bridge from. Consume the
    // oldest unmatched marker of this type that SubagentStart left behind.
    const idleEntry = [...this.idleSubagents].find(([, candidate]) =>
      candidate.sessionId === sessionId && candidate.subagentType === agentType,
    );
    if (!idleEntry) {
      this.log('DEBUG', `TeammateIdle: no pending tracker for ${agentType} team=${teamName} — skipping`);
      return;
    }

    const [idleKey, candidate] = idleEntry;
    const model = this.emitTeammateTurnTrace(
      candidate.subAgent,
      candidate.conversation,
      agentType,
      candidate.transcriptPath,
    );
    this.idleSubagents.delete(idleKey);
    this.log('INFO', `TeammateIdle: traced ${agentType} model=${model ?? 'unknown'} path=${candidate.transcriptPath}`);
  }

  /** Resolve a teammate's OWN transcript: the coordinator's subagents dir
   *  holds `agent-<id>.jsonl` + `agent-<id>.meta.json` ({"agentType": name});
   *  match by agentType, newest mtime wins (re-spawns). Falls back to the idle
   *  session's transcript (TeammateIdle.session_id is unreliable). */
  private resolveTeammateTranscript(
    coordinatorTranscriptPath: string,
    teammateName: string,
    idleTranscriptPath: string | undefined,
  ): string | undefined {
    try {
      const subagentsDir = subagentsDirFor(coordinatorTranscriptPath);
      if (fs.existsSync(subagentsDir)) {
        let best: { path: string; mtime: number } | undefined;
        for (const meta of fs.readdirSync(subagentsDir).filter(f => f.endsWith('.meta.json'))) {
          try {
            const info = JSON.parse(fs.readFileSync(path.join(subagentsDir, meta), 'utf8')) as { agentType?: string };
            if (info.agentType !== teammateName) continue;
            const transcriptPath = path.join(subagentsDir, meta.replace(/\.meta\.json$/, '.jsonl'));
            if (!fs.existsSync(transcriptPath)) continue;
            const mtime = fs.statSync(transcriptPath).mtimeMs;
            if (!best || mtime > best.mtime) best = { path: transcriptPath, mtime };
          } catch { /* skip malformed metadata */ }
        }
        if (best) return best.path;
      }
    } catch (err) {
      this.log('DEBUG', `resolveTeammateTranscript(${teammateName}): ${err}`);
    }
    return idleTranscriptPath;
  }

  /** Emit one chat span per assistant response under `parent`, reconstructed
   *  from transcript data (backdated times, usage, ordered output parts). */
  private emitChatSpans(
    parent: weave.Turn | weave.SubAgent,
    calls: AssistantCallDetail[],
    agentName?: string,
  ): void {
    for (const call of calls) {
      const llm = openChat(parent, call);
      if (llm) recordChat(llm, call, agentName);
    }
  }

  /**
   * Emit a teammate's whole transcript as its OWN turn trace (the spawning
   * coordinator turn has long closed), then close the Subagent marker. The
   * coordinator's Conversation handle seeds conversation.id + integration
   * identity, neither of which inherits cross-session; the turn is backdated
   * to span the transcript so its chat children stay inside its window.
   * Returns the teammate's model, if known.
   */
  private emitTeammateTurnTrace(
    subAgent: weave.SubAgent,
    conversation: weave.Conversation,
    agentType: string,
    transcriptPath: string | undefined,
  ): string | undefined {
    let model: string | undefined;
    let lastAssistantText: string | undefined;
    let transcript: TranscriptFile | undefined;
    try {
      if (!transcriptPath) throw new Error('no teammate transcript path');
      transcript = new TranscriptFile(transcriptPath);
      const parsed = parseSessionFd(transcript.getFd());
      if (parsed?.turns.length) {
        const calls = parsed.turns.flatMap(turn => turn.assistantCalls());
        const first = calls[0];
        const turn = conversation.startTurn({
          agentName: agentType,
          agentVersion: VERSION,
          startTime: parseIsoOrNow(first?.prevTimestamp ?? first?.timestamp),
        });
        turn.setAttributes({ [ATTR.WEAVE_DISPLAY_NAME]: `Teammate: ${agentType}` });
        try {
          for (const parsedTurn of parsed.turns) {
            this.emitChatSpans(turn, parsedTurn.assistantCalls(), agentType);
          }
        } finally {
          turn.end({ endTime: parseIsoOrNow(calls.at(-1)?.timestamp) });
        }
        const lastTurn = parsed.turns.at(-1);
        model = lastTurn?.primaryModel();
        lastAssistantText = lastTurn?.textBlocks().join('\n');
      }
    } catch (err) {
      this.log('DEBUG', `emitTeammateTurnTrace: could not parse ${transcriptPath}: ${err}`);
    } finally {
      transcript?.close();
    }
    if (model) subAgent.setAttributes({ [ATTR.RESPONSE_MODEL]: model });
    if (lastAssistantText) {
      subAgent.setAttributes({ [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([lastAssistantText]) });
    }
    subAgent.end();
    return model;
  }

  private async handlePreCompact(sessionId: string, input: PreCompactHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Claude Code sends compaction fields that are absent from the SDK type.
    const raw = input as Record<string, unknown>;
    const summary = raw['summary'] ?? raw['compaction_summary'];
    const itemsBefore = raw['items_before'];
    const itemsAfter = raw['items_after'];
    const attrs: CompactionAttrs = {
      summary: typeof summary === 'string' ? summary : undefined,
      itemsBefore: typeof itemsBefore === 'number' ? itemsBefore : undefined,
      itemsAfter: typeof itemsAfter === 'number' ? itemsAfter : undefined,
    };

    if (session.currentTurn) {
      setCompactionAttrs(session.currentTurn, attrs);
      this.log('INFO', `PreCompact attached to active turn (session ${sessionId})`);
    } else {
      // Buffer until the next UserPromptSubmit opens a turn span.
      session.pendingCompaction = attrs;
      this.log('INFO', `PreCompact buffered; will attach to next turn (session ${sessionId})`);
    }
  }

  private async handleStop(sessionId: string, input: StopHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentTurn) return;

    // Wait for transcript synthesis to flush before reading the final response.
    const finalAssistantMessage = input.last_assistant_message;
    const parsedSession = await this.parseSessionFileWithRetry(
      session.transcript,
      finalAssistantMessage,
    );
    const currentTurn = parsedSession?.turns.at(-1);
    const model = currentTurn?.primaryModel();
    const transcriptTurns = parsedSession?.turns.length ?? 0;
    this.log(
      'DEBUG',
      `Stop: session=${sessionId} transcript_path=${session.transcript.resolvedPath} transcript_turns=${transcriptTurns} parsed_model=${model ?? 'unknown'} last_assistant_message_present=${Boolean(input.last_assistant_message)}`,
    );

    if (currentTurn) {
      this.emitChatSpans(session.currentTurn, currentTurn.assistantCalls());
    }

    const parsedTexts = currentTurn?.textBlocks() ?? [];
    const lastMessage = input.last_assistant_message ?? '';
    const assistantMessages = parsedTexts.length > 0 ? parsedTexts : (lastMessage ? [lastMessage] : []);

    const turnAttrs: Attributes = {};
    if (assistantMessages.length) {
      turnAttrs[ATTR.OUTPUT_MESSAGES] = assistantOutputMessages(assistantMessages);
    }
    const finishReasons = currentTurn?.assistantCalls().map(c => c.finishReason).filter((r): r is string => !!r);
    if (finishReasons?.length) {
      turnAttrs[ATTR.RESPONSE_FINISH_REASONS] = finishReasons;
    }
    if (Object.keys(turnAttrs).length) session.currentTurn.setAttributes(turnAttrs);
    // Turn.end() re-emits its request model, so update it through record().
    if (model) {
      session.currentTurn.record({ model });
    }
    session.currentTurn.end();
    session.currentTurn = undefined;

    this.log('INFO', 'Finished turn');
  }

  private async handleSessionEnd(sessionId: string, input: SessionEndHookInput): Promise<void> {
    // Discard any never-drained instruction buffer (e.g. a session that emitted
    // InstructionsLoaded but never SessionStart) so the map can't leak.
    this.pendingInstructions.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.log(
      'DEBUG',
      `SessionEnd: session=${sessionId} reason=${input.reason} transcript_path=${session.transcript.resolvedPath} pending_calls=${session.pendingCalls.size} active_subagents=${session.activeSubagents.size}`,
    );

    this.finalizeOpenTurn(session, 'session_ended');
    this.finalizeIdleSubagents(sessionId, 'session_ended');

    this.log('INFO', `Finished session ${sessionId}`);

    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    session.transcript.close();
  }

  private finalizeOpenTurn(session: SessionState, orphanReason: string): void {
    for (const [toolUseId, call] of session.pendingCalls) {
      if (call.kind === 'subagent' && this.teamDispatches.has(call)) {
        this.log('DEBUG', `Deferred team call to TeammateIdle: ${toolUseId}`);
        continue;
      }
      const span = call.kind === 'tool' ? call.tool : call.subAgent;
      if (call.kind === 'tool') resolvePermissionIfPending(call, false);
      span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: orphanReason });
      span.end({ error: new Error(`call did not complete (${orphanReason})`) });
      this.log('DEBUG', `Closed orphaned call: ${toolUseId}`);
    }
    session.pendingCalls.clear();
    session.activeSubagents.clear();

    if (session.currentTurn) {
      try {
        const lastTurn = parseSessionFd(session.transcript.getFd())?.turns.at(-1);
        if (lastTurn) this.emitChatSpans(session.currentTurn, lastTurn.assistantCalls());
      } catch (err) {
        this.log('DEBUG', `Could not recover chat spans while closing turn: ${err}`);
      }
      session.currentTurn.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: orphanReason });
      session.currentTurn.end();
      session.currentTurn = undefined;
      this.log('DEBUG', `Closed orphaned turn span (${orphanReason})`);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private checkInactivity(): void {
    const idle = Date.now() - this.lastActivity;
    if (idle <= this.inactivityMs) return;
    if (idle < INFLIGHT_HOLD_MAX_MS && (this.teamMembers.size > 0 || this.idleSubagents.size > 0)) {
      this.log('DEBUG', 'Inactivity timeout reached but team correlation in flight — staying up');
      return;
    }
    if (idle < INFLIGHT_HOLD_MAX_MS && this.hasInFlightWork()) {
      this.log('DEBUG', 'Inactivity timeout reached but work in flight — staying up');
      return;
    }
    this.log('INFO', 'Inactivity timeout — shutting down');
    void this.shutdown('inactivity');
  }

  /** True if any session has work in flight: an open turn span or pending call.
   *  Keeps the daemon alive across the inactivity
   *  timeout so in-flight work isn't cut off mid-flight (see checkInactivity). */
  private hasInFlightWork(): boolean {
    for (const s of this.sessions.values()) {
      if (s.currentTurn) return true;
      if (s.pendingCalls.size > 0) return true;
    }
    return false;
  }

  private async shutdown(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.drain(reason);
    process.exit(0);
  }

  private async drain(reason: string): Promise<void> {
    this.log('INFO', `Shutdown: ${reason}`);
    this.server?.close();
    for (const queue of this.teamMembers.values()) {
      for (const member of queue) {
        member.call.subAgent.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: 'daemon_shutdown' });
        member.call.subAgent.end({ error: new Error('teammate did not complete before shutdown') });
      }
    }
    this.teamMembers.clear();
    for (const session of this.sessions.values()) {
      try {
        this.finalizeOpenTurn(session, 'daemon_shutdown');
        this.finalizeIdleSubagents(session.sessionId, 'daemon_shutdown');
      } catch (err) {
        this.log('ERROR', `Error finalizing session ${session.sessionId} at shutdown: ${err}`);
      }
    }
    this.teamDispatches.clear();
    if (this.tracingEnabled) {
      try {
        await weave.flushOTel();
      } catch (err) {
        this.log('ERROR', `Error flushing Weave SDK: ${err}`);
      }
    }
    for (const session of this.sessions.values()) {
      session.transcript.close();
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }

  private finalizeIdleSubagents(sessionId: string, orphanReason: string): void {
    for (const [key, idle] of this.idleSubagents) {
      if (idle.sessionId !== sessionId) continue;
      idle.subAgent.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: orphanReason });
      idle.subAgent.end({ error: new Error(`teammate did not complete (${orphanReason})`) });
      this.idleSubagents.delete(key);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Retry the transcript parse while the writer catches up to Stop; when
   *  `finalAssistantMessage` is set, require the last assistant text to end
   *  with it. Budget: 5 × 200ms. */
  private async parseSessionFileWithRetry(
    transcript: TranscriptFile,
    finalAssistantMessage?: string,
    attempts = 5,
    delayMs = 200,
  ): Promise<ReturnType<typeof parseSessionFd>> {
    let fd: number;
    try {
      fd = transcript.getFd();
    } catch (err) {
      this.log('ERROR', `Cannot open transcript for parsing: ${err}`);
      return null;
    }
    const expected = (finalAssistantMessage ?? '').trimEnd();
    let result: ReturnType<typeof parseSessionFd> = null;
    for (let i = 0; i < attempts; i++) {
      result = parseSessionFd(fd);
      if (result?.turns.length && (!expected || lastAssistantTextEndsWith(result, expected))) {
        return result;
      }
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return result;
  }

  private enqueueForSession(sessionId: string, fn: () => Promise<void>): void {
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => this.log('ERROR', `Queue error for session ${sessionId}: ${err}`));
    this.sessionQueues.set(sessionId, next);
  }

  private errorTypeFor(error: unknown): string {
    if (typeof error === 'string') {
      const trimmed = error.trim();
      if (!trimmed) return 'tool_error';
      const match = trimmed.match(/^[A-Z][A-Za-z_]*Error/);
      return match ? match[0] : 'tool_error';
    }
    if (error && typeof error === 'object' && 'type' in error) {
      const t = (error as Record<string, unknown>)['type'];
      if (typeof t === 'string' && t) return t;
    }
    return 'tool_error';
  }

  private log(level: 'DEBUG' | 'INFO' | 'ERROR', msg: string): void {
    if (level === 'DEBUG' && !this.config.debug) return;
    appendToLog(this.logFile, level, msg);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Entry point (invoked by `weave-claude-code daemon`)
// ─────────────────────────────────────────────────────────────────────────────

export async function runDaemon(): Promise<void> {
  const settings = loadSettings();
  const { daemon_socket: socketPath, log_file: logFile } = settings;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const config = resolveDaemonConfig(settings, process.env);

  if (!config.weaveProject || !config.apiKey) {
    const missing = missingConfig(!!config.weaveProject, !!config.apiKey, 'WANDB_API_KEY');
    appendToLog(logFile, 'INFO', `Daemon not started — missing configuration: ${missing}`);
    process.exit(0);
  }

  const daemon = new GlobalDaemon(socketPath, logFile, config);

  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
