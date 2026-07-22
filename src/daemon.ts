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
import { appendToLog } from './utils.js';
import {
  assistantResponses,
  extractAssistantTextBlocks,
  lastAssistantTextEndsWith,
  parseSessionFd,
} from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import {
  ATTR,
  CompactionAttrs,
  setCompactionAttrs,
  assistantOutputMessages,
  parseTimestamp,
  snippet,
} from './genaiSpans.js';
import { resolveDaemonConfig, daemonConfigFingerprint, missingConfig } from './config.js';
import type { DaemonConfig } from './config.js';
import { emitChatSpans } from './chatSpans.js';
import { newSessionState, turnForPrompt } from './sessionState.js';
import type { SessionState, TurnTrace } from './sessionState.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Inbound control message sent directly to the socket (not a hook event).
 *  `shutdown` stops the daemon; `config-hash` asks it to reply with the
 *  fingerprint of the config it loaded (used by `status` for drift detection)
 *  plus the daemon's runtime identity (pid, version, entry path). */
type ControlMessage = {
  command: 'shutdown' | 'config-hash';
}

/** Raw hook-event payload forwarded by hook-handler.sh. */
type HookPayload = Record<string, unknown>;

function isControlMessage(payload: unknown): payload is ControlMessage {
  if (typeof payload !== 'object' || payload === null) return false;
  const cmd = (payload as Record<string, unknown>).command;
  return cmd === 'shutdown' || cmd === 'config-hash';
}

/** Absolute real path of the daemon's own entry script, resolving the npm bin
 *  symlink to the actual dist/cli.js (or src/cli.ts under tsx). Lets `status`
 *  report which build the running daemon is executing. Falls back to the raw
 *  argv path if it can't be resolved. */
function daemonEntryPath(): string {
  const entry = process.argv[1] ?? '';
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
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
  private pendingInstructions = new Map<string, Map<string, string>>();
  private tracingEnabled = false;

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

    // Bind the socket, exiting cleanly if another daemon already owns it.
    // Concurrent hook invocations can each cold-start a daemon, but only one
    // can bind; the losers exit (process.exit(0)) and their hook still reaches
    // the winner over the socket. See bindSocketWithHerdProtection.
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

  /**
   * Bind the daemon socket, tolerant of a herd of concurrent starts. Listen; on
   * EADDRINUSE/EEXIST, re-probe: a live listener means another daemon won → exit
   * 0; a stale inode is unlinked and retried. Only a confirmed-stale socket is
   * ever unlinked, so a late starter can't delete the winner's live socket.
   */
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
        case 'PostToolUseFailure':
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

  private async buildSession(
    sessionId: string,
    transcript: TranscriptFile,
    options: { source: string; cwd: string; initialRequestModel?: string },
  ): Promise<SessionState> {
    const conversationId = await this.resolveConversationId(
      sessionId,
      transcript.resolvedPath,
      options.source,
    );
    const session = newSessionState({
      sessionId,
      conversationId,
      transcript,
      cwd: options.cwd,
      source: options.source,
      initialRequestModel: options.initialRequestModel,
      agentName: this.config.agentName,
    });
    this.sessions.set(sessionId, session);
    this.drainPendingInstructions(session);
    return session;
  }

  private async handleSessionStart(sessionId: string, input: SessionStartHookInput): Promise<void> {
    if (!this.tracingEnabled || this.sessions.has(sessionId)) return;

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
        // Parent transcript not on disk (e.g., resumed across machines).
        // Stop here — the recorded parent id is still the best stitching
        // key we have, even though we can't verify if IT was a fork too.
        this.log(
          'DEBUG',
          `resolveConversationId: parent transcript not on disk: ${parentPath} — stopping chain walk at ${parent}`,
        );
        break;
      }
      currentPath = parentPath;
    }

    if (current !== sessionId && source !== 'resume') {
      // Fork detected but `source` doesn't say resume — log so the mismatch
      // is visible. We still stitch by the chain root because that's the
      // correct behavior; this just surfaces an unexpected hook payload.
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
    if (!this.tracingEnabled) return undefined;
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
    const session = await this.buildSession(sessionId, transcript, {
      source,
      cwd,
      initialRequestModel,
    });
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

    const session = this.sessions.get(sessionId);
    if (session) {
      session.systemInstructions.set(filePath, content);
    } else {
      // Session not set up yet; buffer until SessionStart / reconstruct drains it.
      const pending = this.pendingInstructions.get(sessionId) ?? new Map();
      pending.set(filePath, content);
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
    if (!pending?.size) return;
    for (const [filePath, content] of pending) session.systemInstructions.set(filePath, content);
    this.log('DEBUG', `Drained ${pending.size} buffered instruction file(s) into session ${session.sessionId}`);
  }

  private transcriptCursor(
    session: SessionState,
    options: {
      userMessage?: string;
      recoverCurrentTurn?: boolean;
      responseOffsetFloor?: number;
    },
  ): { responseOffset: number; startTime?: Date; userText?: string } {
    const parsed = parseSessionFd(session.transcript.getFd());
    if (!parsed) return { responseOffset: 0, userText: options.userMessage };

    const responses = assistantResponses(parsed);
    const current = parsed.turns.at(-1);
    const transcriptHasPrompt = options.userMessage !== undefined
      && current?.userText === options.userMessage;
    const includeCurrent = options.recoverCurrentTurn || transcriptHasPrompt;
    const responseOffset = includeCurrent
      ? responses.length - (current?.responses.length ?? 0)
      : responses.length;
    return {
      responseOffset: Math.max(responseOffset, options.responseOffsetFloor ?? 0),
      startTime: includeCurrent ? parseTimestamp(current?.startTime) : undefined,
      userText: options.userMessage ?? (includeCurrent ? current?.userText : undefined),
    };
  }

  private startSessionTurn(
    session: SessionState,
    options: {
      promptId?: string;
      userMessage?: string;
      recoverCurrentTurn?: boolean;
      responseOffsetFloor?: number;
      makeCurrent?: boolean;
    } = {},
  ): TurnTrace {
    const cursor = this.transcriptCursor(session, options);
    const span = session.conversation.startTurn({
      agentVersion: VERSION,
      model: session.initialRequestModel,
      userMessage: cursor.userText,
      systemInstructions: [...session.systemInstructions.values()],
      startTime: cursor.startTime,
    });
    span.setAttributes({
      [ATTR.WEAVE_CWD]: session.cwd,
      [ATTR.WEAVE_SOURCE]: session.source,
    });
    const turn: TurnTrace = {
      span,
      promptId: options.promptId,
      userText: cursor.userText,
      phase: 'active',
      responseOffset: cursor.responseOffset,
      seenResponses: new Set(),
    };
    session.turns.add(turn);
    if (options.makeCurrent !== false) session.currentTurn = turn;
    if (options.promptId !== undefined) {
      session.turnsByPromptId.set(options.promptId, turn);
    }
    return turn;
  }

  private ensureTurn(session: SessionState, promptId: string | undefined): TurnTrace {
    return turnForPrompt(session, promptId) ?? this.startSessionTurn(session, {
      promptId,
      // A protocol prompt_id cannot safely be joined to the last transcript
      // turn. Legacy hooks have no competing identity and may recover it.
      recoverCurrentTurn: promptId === undefined,
      makeCurrent: !session.currentTurn || session.currentTurn.promptId === promptId,
    });
  }

  private async handleUserPromptSubmit(sessionId: string, input: UserPromptSubmitHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) {
      this.log('ERROR', `Unknown session (no transcript_path to reconstruct): ${sessionId}`);
      return;
    }
    const prompt = input.prompt;
    const previous = session.currentTurn;
    if (input.prompt_id !== undefined && session.turnsByPromptId.has(input.prompt_id)) return;
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} current_turn=${previous ? 'open' : 'none'} prompt=${snippet(prompt, 120)}`,
    );

    let responseOffsetFloor: number | undefined;
    if (previous) {
      previous.responseLimit ??= assistantResponses(
        parseSessionFd(session.transcript.getFd()) ?? { turns: [] },
      ).length;
      responseOffsetFloor = previous.responseLimit;
      this.finalizeTurn(session, previous, 'superseded_by_next_prompt');
    }

    const turn = this.startSessionTurn(session, {
      promptId: input.prompt_id,
      userMessage: prompt,
      responseOffsetFloor,
    });

    // Drain compaction attrs buffered while no turn was open.
    if (session.pendingCompaction) {
      setCompactionAttrs(turn.span, session.pendingCompaction);
      session.pendingCompaction = undefined;
    }

    this.log('INFO', 'Created turn span');
  }

  private async handlePreToolUse(sessionId: string, input: PreToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;
    this.log('DEBUG', `PreToolUse (not yet traced): session=${sessionId} tool=${input.tool_name}`);
  }

  private async handlePermissionRequest(sessionId: string, input: PermissionRequestHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.log('DEBUG', `PermissionRequest (not yet traced): session=${sessionId} tool=${input.tool_name}`);
  }

  private async handleSubagentStart(sessionId: string, input: SubagentStartHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;
    this.log('DEBUG', `SubagentStart (not yet traced): session=${sessionId} agent=${input.agent_id}`);
  }

  private async handleSubagentStop(sessionId: string, input: SubagentStopHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || !this.tracingEnabled) return;
    this.log('DEBUG', `SubagentStop (not yet traced): session=${sessionId} agent=${input.agent_id}`);
  }

  private async handleTeammateIdle(sessionId: string, input: TeammateIdleHookInput): Promise<void> {
    if (!this.tracingEnabled) return;
    this.log('DEBUG', `TeammateIdle (not yet traced): session=${sessionId} teammate=${input.teammate_name}`);
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

    const turn = turnForPrompt(session, input.prompt_id);
    if (turn) {
      setCompactionAttrs(turn.span, attrs);
      this.log('INFO', `PreCompact attached to active turn (session ${sessionId})`);
    } else {
      // Buffer until the next UserPromptSubmit opens a turn span.
      session.pendingCompaction = attrs;
      this.log('INFO', `PreCompact buffered; will attach to next turn (session ${sessionId})`);
    }
  }

  private responsesForTurn(
    parsed: NonNullable<ReturnType<typeof parseSessionFd>>,
    turn: TurnTrace,
  ) {
    return assistantResponses(parsed).slice(turn.responseOffset, turn.responseLimit);
  }

  private recordTurnOutput(
    turn: TurnTrace,
    responses: ReturnType<typeof assistantResponses>,
    options: { lastMessage?: string; orphanReason?: string } = {},
  ): void {
    emitChatSpans(turn.span, responses, { seen: turn.seenResponses });

    const text = responses.flatMap(response => extractAssistantTextBlocks(response.content));
    if (!text.length && options.lastMessage) text.push(options.lastMessage);
    const attributes: Attributes = {};
    if (text.length) attributes[ATTR.OUTPUT_MESSAGES] = assistantOutputMessages(text);
    const finishReasons = responses
      .map(response => response.finishReason)
      .filter((reason): reason is string => Boolean(reason));
    if (finishReasons.length) attributes[ATTR.RESPONSE_FINISH_REASONS] = finishReasons;
    if (options.orphanReason) attributes[ATTR.WEAVE_ORPHAN_REASON] = options.orphanReason;
    if (Object.keys(attributes).length) turn.span.setAttributes(attributes);

    const model = responses.filter(response => response.model).at(-1)?.model;
    if (model) turn.span.record({ model });
  }

  private endTurn(session: SessionState, turn: TurnTrace): void {
    turn.span.end();
    session.turns.delete(turn);
    if (turn.promptId !== undefined
      && session.turnsByPromptId.get(turn.promptId) === turn) {
      session.turnsByPromptId.delete(turn.promptId);
    }
    if (session.currentTurn === turn) session.currentTurn = undefined;
  }

  private async handleStop(sessionId: string, input: StopHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;
    const turn = turnForPrompt(session, input.prompt_id)
      ?? this.ensureTurn(session, input.prompt_id);

    const parsed = await this.parseSessionFileWithRetry(
      session.transcript,
      input.last_assistant_message,
    );
    const responses = parsed ? this.responsesForTurn(parsed, turn) : [];
    const model = responses.filter(response => response.model).at(-1)?.model;
    this.log(
      'DEBUG',
      `Stop: session=${sessionId} transcript_path=${session.transcript.resolvedPath} responses=${responses.length} model=${model ?? 'unknown'} last_assistant_message_present=${Boolean(input.last_assistant_message)}`,
    );

    // Stop hooks are blockable. Snapshot output now, but retain the root so a
    // continuation can add responses under the same prompt.
    this.recordTurnOutput(turn, responses, {
      lastMessage: input.last_assistant_message,
    });
    turn.phase = 'stopped';
    this.log('INFO', 'Recorded turn stop snapshot');
  }

  private async handleSessionEnd(sessionId: string, input: SessionEndHookInput): Promise<void> {
    this.pendingInstructions.delete(sessionId);
    const session = this.sessions.get(sessionId)
      ?? await this.getOrReconstructSession(sessionId, input);
    if (!session) return;

    const parsed = this.parseTranscript(session);
    const finalTranscriptTurn = parsed?.turns.at(-1);
    if (parsed && finalTranscriptTurn) {
      let turn = input.prompt_id === undefined
        ? [...session.turns].find(candidate =>
          candidate.userText !== undefined
          && candidate.userText === finalTranscriptTurn.userText)
          ?? (session.currentTurn?.promptId === undefined ? session.currentTurn : undefined)
        : turnForPrompt(session, input.prompt_id);
      const legacyTurn = session.currentTurn;
      if (!turn && input.prompt_id !== undefined && legacyTurn && legacyTurn.promptId === undefined) {
        turn = legacyTurn;
        turn.promptId = input.prompt_id;
        session.turnsByPromptId.set(input.prompt_id, turn);
      }
      const stoppedUnknownPrompt = input.prompt_id === undefined
        && session.currentTurn?.promptId !== undefined
        && session.currentTurn.phase === 'stopped';
      if (!turn && !stoppedUnknownPrompt) {
        turn = this.startSessionTurn(session, {
          promptId: input.prompt_id,
          userMessage: finalTranscriptTurn.userText,
          recoverCurrentTurn: true,
        });
      }
      if (turn && turn.responseLimit === undefined) {
        turn.responseOffset = Math.max(
          turn.responseOffset,
          assistantResponses(parsed).length - finalTranscriptTurn.responses.length,
        );
        turn.userText ??= finalTranscriptTurn.userText;
      }
    }

    this.log(
      'DEBUG',
      `SessionEnd: session=${sessionId} reason=${input.reason} transcript_path=${session.transcript.resolvedPath} turns=${session.turns.size}`,
    );
    this.finalizeSession(session, 'session_ended', parsed);

    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    session.transcript.close();
    this.log('INFO', `Finished session ${sessionId}`);
  }

  private parseTranscript(
    session: SessionState,
  ): ReturnType<typeof parseSessionFd> {
    try {
      return parseSessionFd(session.transcript.getFd());
    } catch (error) {
      this.log('DEBUG', `Could not recover chat spans while closing turn: ${error}`);
      return null;
    }
  }

  private recordFinalTurnOutput(
    turn: TurnTrace,
    orphanReason: string,
    parsed: ReturnType<typeof parseSessionFd>,
  ): void {
    const responses = parsed ? this.responsesForTurn(parsed, turn) : [];
    const actualOrphanReason = turn.phase === 'active' ? orphanReason : undefined;
    this.recordTurnOutput(turn, responses, { orphanReason: actualOrphanReason });
  }

  private finalizeTurn(session: SessionState, turn: TurnTrace, orphanReason: string): void {
    this.recordFinalTurnOutput(turn, orphanReason, this.parseTranscript(session));
    this.endTurn(session, turn);
  }

  private finalizeSession(
    session: SessionState,
    orphanReason: string,
    parsed = this.parseTranscript(session),
  ): void {
    for (const turn of [...session.turns]) {
      this.recordFinalTurnOutput(turn, orphanReason, parsed);
      this.endTurn(session, turn);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private checkInactivity(): void {
    const idle = Date.now() - this.lastActivity;
    if (idle <= this.inactivityMs) return;
    // Keep in-flight work alive up to the hard hold limit.
    if (idle < INFLIGHT_HOLD_MAX_MS && this.hasInFlightWork()) {
      this.log('DEBUG', 'Inactivity timeout reached but work in flight — staying up');
      return;
    }
    this.log('INFO', 'Inactivity timeout — shutting down');
    void this.shutdown('inactivity');
  }

  /** A blockable Stop leaves its root reopenable but quiescent. Later call
   * state extends this predicate so real background work still pins the daemon. */
  private hasInFlightWork(): boolean {
    for (const s of this.sessions.values()) {
      if ([...s.turns].some(turn => turn.phase === 'active')) return true;
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
    for (const session of this.sessions.values()) {
      try {
        this.finalizeSession(session, 'daemon_shutdown');
      } catch (err) {
        this.log('ERROR', `Error finalizing session ${session.sessionId} at shutdown: ${err}`);
      }
    }
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

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Retry parseSessionFile while the transcript writer catches up to Stop.
   *  If `finalAssistantMessage` is set, require the last assistant call's
   *  text to end with it (mod trailing whitespace) — guards against reading
   *  before the synthesis line lands. Default budget: 5 × 200ms = 1s. */
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
      // Writer caught up: parsed at least one turn AND (no synthesis to verify,
      // OR the last assistant call ends with it).
      if (result?.turns.length && (!expected || lastAssistantTextEndsWith(result, expected))) {
        return result;
      }
      // No next parse to wait for on the last iteration, so skip the sleep.
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return result;
  }

  private enqueueForSession(sessionId: string, fn: () => Promise<void>): void {
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => this.log('ERROR', `Queue error for session ${sessionId}: ${err}`));
    this.sessionQueues.set(sessionId, next);
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
