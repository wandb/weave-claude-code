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
  snippet,
  jsonStr,
} from './genaiSpans.js';
import { resolveDaemonConfig, daemonConfigFingerprint, missingConfig } from './config.js';
import type { DaemonConfig } from './config.js';
import {
  chatMessageKey,
  callsForResponseKey,
  findToolUseResponseKey,
  parseIsoOrNow,
  openChatForGroup,
  recordChat,
} from './chatSpans.js';
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
  SubagentTracker,
  TeamMember,
  SessionState,
  LoadedInstruction,
} from './sessionState.js';
import type { AssistantCallDetail, ParsedSession } from './parser.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// GlobalDaemon
// ─────────────────────────────────────────────────────────────────────────────

// How long an idle daemon stays warm before self-reaping. Only fires when no
// work is in flight (INFLIGHT_HOLD_MAX_MS guards active work). Long enough that
// mid-session gaps don't reap the daemon and strand the resumed session on a
// fresh one. Override with WEAVE_INACTIVITY_MS.
const INACTIVITY_TIMEOUT_MS = 120 * 60 * 1_000;  // 120 minutes
// Ceiling for holding the daemon open past the inactivity timeout while work is
// in flight (see checkInactivity), so a teammate that never emits TeammateIdle
// or a stuck session can't pin the daemon forever.
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
  /** True once `weave.init` has completed. All span emission is gated on it. */
  private tracingEnabled = false;
  /** Cross-session team correlation, keyed by `${team_name}::${name}`. Bridges
   *  the coordinator's PreToolUse(Agent) to each teammate's TeammateIdle. The
   *  value is a FIFO queue: a re-spawned `${team}::${name}` appends rather than
   *  overwriting, so two live spans for the same name never collide. */
  private teamMembers = new Map<string, TeamMember[]>();

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
    // Without SIGHUP, Node exits on terminal close with no JS handler, leaving
    // the socket inode behind for the next hook to mistake for a live daemon.
    // Routing it through shutdown() unlinks it.
    process.on('SIGHUP',  () => void this.shutdown('SIGHUP'));
    // Catch any non-signal exit (uncaught exception, process.exit elsewhere) and
    // remove the inode. Does not cover SIGKILL/OOM; the hook handler's probe
    // handles those at the next event.
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

    // The Weave SDK has no programmatic apiKey/host in its Settings; it resolves
    // both from the environment (weave login() would instead write a netrc
    // entry, which is wrong for a background daemon). WF_TRACE_SERVER_URL points
    // the OTLP exporter straight at our trace server; WANDB_API_KEY supplies the
    // auth header. We deliberately do NOT set WANDB_BASE_URL (weave treats that
    // as the API host and would derive a wrong trace URL from it).
    process.env['WF_TRACE_SERVER_URL'] = this.config.baseUrl;
    process.env['WANDB_API_KEY'] = this.config.apiKey;

    // Route OTel's internal warnings/errors into the daemon log. The batch
    // exporter fails silently otherwise (a bad key or unreachable trace host
    // drops every span with nothing logged anywhere).
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
    // The socket delivers raw hook JSON; trust it against the SDK's hook schema
    // once here so the dispatch and handlers work with typed, discriminated
    // inputs instead of re-casting every field.
    const input = payload as HookInput;
    const sessionId = input.session_id;
    if (!sessionId) {
      this.log('ERROR', 'Missing session_id in payload');
      return;
    }

    this.log('INFO', `${input.hook_event_name} session=${sessionId}${input.agent_id ? ` agent=${input.agent_id}` : ''}`);

    // Each event runs in its own isolated frame so the SDK's single-active
    // guards (one Conversation/Turn/LLM per frame) never trip across
    // concurrently open sessions. Identity doesn't ride on the frame: the
    // conversation's id and attributes forward through the held handles
    // (conversation → turn → llm/tool/subagent) onto every span.
    await weave.runIsolated(() => this.dispatchEvent(input, sessionId));
  }

  /** Run the handler for a single hook event, narrowing `input` to the event's
   *  variant via the discriminant. Split out from `routeEvent` so the latter can
   *  run it inside the isolated per-event context. */
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

    const source = input.source;
    const initialRequestModel = input.model;
    const cwd = input.cwd;

    const conversationId = await this.resolveConversationId(sessionId, transcript.resolvedPath, source);

    const session = newSessionState({
      sessionId,
      conversationId,
      transcript,
      cwd,
      source,
      initialRequestModel,
      turnNumber: 0,
      agentName: this.config.agentName,
      tracingEnabled: this.tracingEnabled,
    });
    this.sessions.set(sessionId, session);
    this.drainPendingInstructions(session);

    const resumed = conversationId !== sessionId;
    this.log('INFO', `Session created: ${sessionId}${resumed ? ` (resumed; conversation=${conversationId})` : ''}`);
    this.log(
      'DEBUG',
      `SessionStart details: session=${sessionId} conversation=${conversationId} source=${source} model=${initialRequestModel ?? 'unknown'} cwd=${cwd || '(empty)'} transcript_path=${transcript.resolvedPath} transcript_file=${path.basename(transcript.resolvedPath)} active_sessions=${this.sessions.size}`,
    );
  }

  /**
   * Resolve the canonical `gen_ai.conversation.id` by walking the
   * `forkedFrom.sessionId` chain to its root, so resumed sessions
   * (`--continue`/`--resume`, which get a fresh session_id but stamp the parent
   * id on each transcript line) stitch back to the original. Returns `sessionId`
   * itself for fresh sessions or when the chain can't be resolved. Each hop is a
   * sibling-file read; retries the first read since SessionStart races the
   * transcript flush. The depth cap is a guard against pathological forking.
   */
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

  /**
   * Return the tracked session, reconstructing it from the event's
   * `transcript_path` when this daemon never saw its SessionStart. SessionStart
   * only fires on startup/resume/clear/compact, so a session that outlives a
   * daemon restart would otherwise go untraced; every hook carries
   * `transcript_path`, which is enough to rebuild state and resume tracing.
   */
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
    const conversationId = await this.resolveConversationId(sessionId, transcript.resolvedPath, source);

    // Seed the turn counter from the turns already on disk so numbering
    // continues across the restart instead of resetting to 1.
    let priorTurns = 0;
    try {
      priorTurns = parseSessionFd(transcript.getFd())?.turns.length ?? 0;
    } catch (err) {
      this.log('DEBUG', `Reconstruct ${sessionId}: could not count prior turns: ${err}`);
    }

    const session = newSessionState({
      sessionId,
      conversationId,
      transcript,
      cwd,
      source,
      initialRequestModel,
      turnNumber: priorTurns,
      agentName: this.config.agentName,
      tracingEnabled: this.tracingEnabled,
    });
    this.sessions.set(sessionId, session);
    this.drainPendingInstructions(session);
    this.log(
      'INFO',
      `Session reconstructed after restart: ${sessionId} (conversation=${conversationId}, prior_turns=${priorTurns})`,
    );
    return session;
  }

  /**
   * Capture one instruction file (global/project CLAUDE.md, .claude/rules,
   * @-import) from InstructionsLoaded for `gen_ai.system_instructions`. The hook
   * gives only `file_path`, so read the file here (sync, to preserve load order
   * on a session-start burst). The hook can fire before SessionStart, so files
   * arriving early are buffered and drained on creation rather than triggering a
   * reconstruct (which would no-op the real SessionStart and lose its
   * source/model).
   */
  private handleInstructionsLoaded(sessionId: string, input: InstructionsLoadedHookInput): void {
    // Without tracing there is no turn to stamp these on — skip the file reads
    // rather than buffer content that nothing will ever consume.
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

  /**
   * Open a turn under the session's conversation and stamp per-turn session
   * metadata. Each turn is its own trace root; the backend stitches turns into a
   * conversation via `gen_ai.conversation.id` (seeded, with agent identity and
   * integration attributes, from the conversation handle onto the whole
   * subtree). Session metadata is stamped per-turn so it's queryable without a
   * session-level span.
   */
  private startSessionTurn(session: SessionState, displayName: string, userMessage?: string): weave.Turn | undefined {
    if (!session.conversation) return undefined;
    const turn = session.conversation.startTurn({
      agentVersion: VERSION,
      model: session.initialRequestModel,
      userMessage,
      systemInstructions: session.systemInstructions.map((i) => i.content),
      startTime: new Date(),
    });
    turn.setAttributes({
      [ATTR.WEAVE_SESSION_ID]: session.sessionId,
      [ATTR.WEAVE_CWD]: session.cwd,
      [ATTR.WEAVE_SOURCE]: session.source,
      [ATTR.WEAVE_PLUGIN_VERSION]: VERSION,
      [ATTR.WEAVE_TURN_NUMBER]: session.turnNumber,
      [ATTR.WEAVE_DISPLAY_NAME]: displayName,
    });
    session.currentTurn = turn;
    return turn;
  }

  private async handleUserPromptSubmit(sessionId: string, input: UserPromptSubmitHookInput): Promise<void> {
    // Reconstruct the session if this daemon never saw its SessionStart (e.g. it
    // idled out mid-session and a fresh daemon took over) so the rest of the
    // session stays traced instead of dropping with "Unknown session".
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) {
      this.log('ERROR', `Unknown session (no transcript_path to reconstruct): ${sessionId}`);
      return;
    }
    if (!this.tracingEnabled) return;

    const prompt = input.prompt;
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} current_turn=${session.currentTurn ? 'open' : 'none'} turn_number=${session.turnNumber} prompt=${snippet(prompt, 120)}`,
    );

    // A user interrupt ends a turn with no Stop hook, so the previous turn (and
    // its chat span) can still be open here. Close it as superseded before the
    // new turn overwrites the handle, or its root span would never export.
    this.finalizeOpenTurn(session, 'superseded_by_next_prompt');

    session.turnNumber += 1;
    session.turnToolCalls = 0;
    session.emittedChatSpanResponseKeys.clear();
    const turn = this.startSessionTurn(session, `Turn ${session.turnNumber}: ${snippet(prompt)}`, prompt);
    if (!turn) return;

    // Drain compaction attrs buffered while no turn was open.
    if (session.pendingCompaction) {
      setCompactionAttrs(turn, session.pendingCompaction);
      session.pendingCompaction = undefined;
    }

    this.log('INFO', `Created turn span (turn ${session.turnNumber})`);
  }

  private async handlePreToolUse(sessionId: string, input: PreToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;

    const agentId = input.agent_id;
    const toolUseId = input.tool_use_id;
    const toolName = input.tool_name;
    if (!toolUseId || !toolName) return;

    // tool_input is per-tool JSON the SDK types as `unknown`; narrow to index it.
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    // Agent tool with subagent_type opens a nested `invoke_agent` marker, not an
    // `execute_tool Agent` span: the chat view renders nested invoke_agent as an
    // `agent_start` event, while a tool wrapper would mis-render the dispatch.
    // PostToolUse(Agent) closes the marker. Also fires when a subagent spawns its
    // own subagent (agentId set); the parent then resolves to the spawning
    // subagent's marker so the grandchild nests under it. `promptHash` (sha256 of
    // the firing prompt) lets SubagentStart correlate deterministically.
    if (toolName === 'Agent' && toolInput['subagent_type']) {
      // Parent: the spawning subagent's own marker when this dispatch comes
      // from inside a subagent, else the current turn.
      const spawnParent: weave.Turn | weave.SubAgent | undefined = agentId
        ? session.subagents.byAgentId(agentId)?.subAgent ?? session.currentTurn
        : session.currentTurn;
      if (!spawnParent) {
        this.log('ERROR', `PreToolUse(Agent): no parent for session=${sessionId}`);
        return;
      }
      const subagentType = toolInput['subagent_type'] as string;
      const prompt = typeof toolInput['prompt'] === 'string' ? toolInput['prompt'] : '';
      const subAgent = spawnParent.startSubagent({ name: subagentType, agentVersion: VERSION, startTime: new Date() });
      const subAttrs: Attributes = {
        [ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]: toolUseId,
        [ATTR.WEAVE_DISPLAY_NAME]: toolDisplayName(toolName, toolInput),
      };
      if (prompt) subAttrs[ATTR.INPUT_MESSAGES] = jsonStr([{ role: 'user', content: prompt }]);
      subAgent.setAttributes(subAttrs);
      // Agent-teams: when the Agent tool carries a `team_name`, the teammate
      // runs as its own session and TeammateIdle fires under the teammate's
      // session_id. Register the Subagent in the cross-session team map so
      // TeammateIdle can find it regardless of which session fires it.
      const teamName = typeof toolInput['team_name'] === 'string' ? toolInput['team_name'] : undefined;
      const memberName = (typeof toolInput['name'] === 'string' && toolInput['name']) ? toolInput['name'] : subagentType;
      session.subagents.add({
        toolUseId,
        subagentType,
        detectedAt: new Date(),
        subAgent,
        promptHash: hashPrompt(prompt),
        teamName,
      });
      if (teamName && session.conversation) {
        // Append to the per-key FIFO queue (do not overwrite): the same
        // `${team}::${name}` can be spawned again later in the run, and
        // overwriting would orphan the first still-open span and mis-route its
        // teammate's transcript.
        const key = `${teamName}::${memberName}`;
        const queue = this.teamMembers.get(key) ?? [];
        queue.push({
          subAgent,
          conversation: session.conversation,
          coordinatorTranscriptPath: session.transcript.resolvedPath,
          emitted: false,
        });
        this.teamMembers.set(key, queue);
        this.log('INFO', `Team member registered: ${key} (cross-session nesting, queue depth ${queue.length})`);
      }
      return;
    }

    // Parent for the tool span. A subagent's tools nest under its own
    // `invoke_agent` marker, tagged with the subagent's `gen_ai.agent.name` so
    // they also stay queryable by agent (falling back to the turn if the marker
    // is missing). For the main agent, nest under the active response's chat
    // span (advanced from the transcript), falling back to the turn when the
    // machine can't advance yet.
    const tracker = agentId ? session.subagents.byAgentId(agentId) : undefined;
    const parent: weave.Turn | weave.SubAgent | weave.LLM | undefined = agentId
      ? tracker?.subAgent ?? session.currentTurn
      : this.advanceMainAgentChatSpan(session, toolUseId) ?? session.currentTurn;
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
    if (tracker) toolAttrs[ATTR.AGENT_NAME] = tracker.subagentType;
    tool.setAttributes(toolAttrs);
    session.pendingToolCalls.set(toolUseId, { tool, toolName, toolInput });
  }

  /**
   * Advance the main-agent chat-span state machine: find the assistant response
   * that produced `toolUseId`, ensure its chat span (LLM) is open, and return it
   * so the tool nests under it. Finalizes the previous chat span on a transition
   * to a new response. Returns undefined (caller falls back to the turn span)
   * when the transcript isn't parseable yet or the response has no model
   * (LLMInit.model is required). Output parts are set at finalize, not here,
   * because a response's split transcript lines may not all be flushed at
   * PreToolUse time.
   */
  private advanceMainAgentChatSpan(session: SessionState, toolUseId: string): weave.LLM | undefined {
    if (!session.currentTurn) return undefined;

    // Re-parses the whole transcript per main-agent PreToolUse: O(size) per
    // tool call. Off CC's critical path (async daemon), so no editor latency;
    // parse the current turn's tail instead if it shows up in profiling.
    let fd: number;
    try {
      fd = session.transcript.getFd();
    } catch {
      return undefined;
    }
    const parsed = parseSessionFd(fd);
    if (!parsed) return undefined;
    const lastTurn = parsed.turns.at(-1);
    if (!lastTurn) return undefined;
    const calls = lastTurn.assistantCalls();
    const key = findToolUseResponseKey(calls, toolUseId);
    if (!key) {
      // Transcript writer hasn't flushed the assistant message yet. Fall back
      // to the turn span.
      return undefined;
    }

    // Transition to a new API response: finalize the previous chat span first.
    if (session.activeChat && session.activeChat.responseKey !== key) {
      this.finalizeActiveChatSpan(session, calls);
    }

    if (!session.activeChat) {
      // key came from findToolUseResponseKey above, so the group is non-empty.
      const group = callsForResponseKey(calls, key);
      // If the writer hasn't flushed the model yet, fall back to the turn span
      // (matching the undefined-transcript path); the response's chat span is
      // emitted at Stop once the model is present.
      const llm = openChatForGroup(session.currentTurn, group);
      if (!llm) return undefined;
      session.activeChat = { responseKey: key, llm };
      session.emittedChatSpanResponseKeys.add(key);
    }

    return session.activeChat.llm;
  }

  /** Finalize `session.activeChat` from the current transcript and clear it. */
  private finalizeActiveChatSpan(session: SessionState, calls: AssistantCallDetail[]): void {
    const active = session.activeChat;
    if (!active) return;
    this.emitChatSpanForResponse(session, calls, active.responseKey, active.llm);
    session.activeChat = undefined;
  }

  /**
   * Emit a complete chat span (LLM) for one assistant API response `key`. The
   * response's ordered text / thinking / tool_use blocks become
   * `gen_ai.output.messages` parts, so the model's natural interleave shows on
   * the single chat span (its tool calls nest under it as `execute_tool`
   * children). Reuses `existingLlm` when the span was already opened during
   * PreToolUse; otherwise opens a fresh one under the turn span.
   */
  private emitChatSpanForResponse(
    session: SessionState,
    calls: AssistantCallDetail[],
    key: string,
    existingLlm?: weave.LLM,
  ): void {
    if (!session.currentTurn) return;
    const group = callsForResponseKey(calls, key);
    // Empty group: `key` is stale relative to `calls` — an interrupted turn's
    // activeChat finalized against the next turn's parse. Close the span bare
    // rather than fabricate content (or throw on group.at(-1)).
    if (!group.length) {
      existingLlm?.end();
      return;
    }
    // A response with no model yet can't open a chat span (LLMInit.model is
    // required); skip it rather than guess a model.
    const llm = existingLlm ?? openChatForGroup(session.currentTurn, group);
    if (!llm) {
      this.log('DEBUG', `Chat span skipped (no model flushed for response ${key}); usage not recorded`);
      return;
    }
    recordChat(llm, group);
    session.emittedChatSpanResponseKeys.add(key);
  }

  private countToolCall(session: SessionState, toolName: string): void {
    session.totalToolCalls += 1;
    session.turnToolCalls += 1;
    session.toolCounts[toolName] = (session.toolCounts[toolName] ?? 0) + 1;
  }

  private async handlePermissionRequest(sessionId: string, input: PermissionRequestHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolName = input.tool_name;
    if (!toolName) return;

    // Correlate to a pending tool call by tool_name + tool_input. Record the
    // permission state; the actual span event is added at PostToolUse[Failure]
    // once we know whether it was approved.
    let pending: PendingToolCall | undefined;
    for (const call of session.pendingToolCalls.values()) {
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

  /**
   * Settle the Agent-dispatch tracker for `toolUseId` at PostToolUse[Failure],
   * if one exists. An Agent dispatch has no pendingToolCall; its span is the
   * subagent's `invoke_agent` marker, closed here with the tool's return.
   * Exception: team spawns return immediately (the teammate runs async in its
   * own session), so the marker stays open for the teammate's TeammateIdle to
   * close and only the per-session tracker is dropped. Returns true when the
   * tool call was a subagent dispatch.
   */
  private settleSubagentDispatch(
    session: SessionState,
    toolUseId: string,
    output: unknown,
    failure: boolean,
  ): boolean {
    const tracker = session.subagents.byToolUseId(toolUseId);
    if (!tracker?.subAgent) return false;
    if (!tracker.teamName) this.closeSubagent(tracker, output, failure);
    session.subagents.remove(tracker);
    this.countToolCall(session, 'Agent');
    return true;
  }

  private async handlePostToolUse(sessionId: string, input: PostToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolUseId = input.tool_use_id;
    if (!toolUseId) return;

    if (this.settleSubagentDispatch(session, toolUseId, input.tool_response, /*failure*/ false)) return;

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    resolvePermissionIfPending(pending, true);

    pending.tool.result = jsonStr(input.tool_response);
    pending.tool.end();

    session.pendingToolCalls.delete(toolUseId);
    this.countToolCall(session, pending.toolName);
  }

  private async handlePostToolUseFailure(sessionId: string, input: PostToolUseFailureHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolUseId = input.tool_use_id;
    if (!toolUseId) return;

    const error = input.error;

    if (this.settleSubagentDispatch(session, toolUseId, error, /*failure*/ true)) return;

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    resolvePermissionIfPending(pending, false);

    pending.tool.result = error;
    pending.tool.setAttributes({ [ATTR.ERROR_TYPE]: this.errorTypeFor(error) });
    // The SDK records the exception + ERROR status from `error`.
    pending.tool.end({ error: new Error(error) });

    session.pendingToolCalls.delete(toolUseId);
    this.countToolCall(session, pending.toolName);
  }

  /**
   * Close a subagent's `invoke_agent` marker span. Idempotent: guarded by
   * `tracker.ended` so PostToolUse and SubagentStop can both safely call this
   * regardless of order. Sets `gen_ai.output.messages` from the canonical
   * tool return string when available; marks the span ERROR on failure.
   */
  private closeSubagent(
    tracker: SubagentTracker,
    output: unknown,
    failure: boolean,
  ): void {
    const sub = tracker.subAgent;
    if (!sub || tracker.ended) return;

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
    tracker.ended = true;
  }

  private async handleSubagentStart(sessionId: string, input: SubagentStartHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;

    const agentId = input.agent_id;
    if (!agentId) return;

    const agentType = input.agent_type;

    // Content-based deterministic correlation: SubagentStart carries no
    // pointer back to the parent's `tool_use_id`, so we read the subagent's
    // transcript line 1 (the firing user prompt — byte-identical to the
    // parent Agent tool's `tool_input.prompt`) and match by sha256 of that
    // string plus the subagent_type. No temporal window.
    const subagentPath = computeSubagentTranscriptPath(session.transcript.resolvedPath, agentId);
    const firstLine = await readSubagentFirstLineWithRetry(subagentPath);
    const firingPrompt = extractUserMessageContent(firstLine);

    let bestTracker: SubagentTracker | undefined;
    if (firingPrompt !== undefined) {
      bestTracker = session.subagents.findUnmatchedByContent(hashPrompt(firingPrompt), agentType);
    }

    const matched = !!bestTracker;
    if (!bestTracker) {
      // No matching Agent tool call (the parent's PreToolUse never fired, or
      // the firing prompt couldn't be read). Create an orphan tracker + marker
      // so the subagent still renders as a nested invocation; closed at
      // SubagentStop since no PostToolUse will come for it.
      const reason = firingPrompt === undefined
        ? 'transcript line 1 missing or non-user'
        : `no tracker matches (promptHash, type=${agentType})`;
      this.log('ERROR', `SubagentStart: ${reason}; creating orphan for agentId=${agentId} path=${subagentPath}`);
      bestTracker = {
        subagentType: agentType,
        detectedAt: new Date(),
        transcriptPath: subagentPath,
        pendingTeammateIdle: true,
      };
      if (session.currentTurn) {
        bestTracker.subAgent = this.startOrphanSubagent(session.currentTurn, agentType, reason);
      }
      session.subagents.add(bestTracker);
    }

    bestTracker.agentId = agentId;
    if (bestTracker.subAgent) {
      // The chat view uses gen_ai.agent.id to label the subagent's subtree.
      bestTracker.subAgent.record({ agentId });
    }

    this.log('INFO', `Subagent started: agentId=${agentId} type=${agentType} matched=${matched}`);
  }

  /** Open an orphan `invoke_agent` marker under `turn` for a subagent with no
   *  matched Agent tool call, stamping why it exists outside the normal path. */
  private startOrphanSubagent(turn: weave.Turn, agentType: string, orphanReason: string): weave.SubAgent {
    const subAgent = turn.startSubagent({ name: agentType, agentVersion: VERSION, startTime: new Date() });
    subAgent.setAttributes({
      [ATTR.WEAVE_DISPLAY_NAME]: `Agent: ${agentType}`,
      [ATTR.WEAVE_ORPHAN_REASON]: orphanReason,
    });
    return subAgent;
  }

  /** The session's open turn, opening a fresh one if a restart left the
   *  session without a turn, so a subagent recovered at SubagentStop has a parent. */
  private getOrReconstructTurn(session: SessionState): weave.Turn | undefined {
    if (session.currentTurn) return session.currentTurn;
    session.turnNumber ||= 1;
    const turn = this.startSessionTurn(session, `Turn ${session.turnNumber} (reconstructed)`);
    if (turn) this.log('INFO', `Reconstructed turn span (turn ${session.turnNumber}) after restart`);
    return turn;
  }

  /** Rebuild a subagent tracker when SubagentStop finds none: the subagent
   *  started under a daemon that has since restarted. Opens an invoke_agent
   *  span under the turn so the normal emit path records it instead of
   *  dropping it. */
  private recoverSubagentTracker(
    session: SessionState,
    agentId: string,
    agentType: string,
  ): SubagentTracker | undefined {
    const turn = this.getOrReconstructTurn(session);
    if (!turn) return undefined;
    const subAgent = this.startOrphanSubagent(turn, agentType, 'recovered at SubagentStop after daemon restart (no tracker)');
    subAgent.record({ agentId });
    const tracker: SubagentTracker = {
      subagentType: agentType,
      detectedAt: new Date(),
      agentId,
      subAgent,
      transcriptPath: computeSubagentTranscriptPath(session.transcript.resolvedPath, agentId),
    };
    session.subagents.add(tracker);
    this.log('INFO', `SubagentStop: recovered subagent agentId=${agentId} type=${agentType} after restart`);
    return tracker;
  }

  private async handleSubagentStop(sessionId: string, input: SubagentStopHookInput): Promise<void> {
    // Reconstruct the session if a restart lost it (see getOrReconstructSession).
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || !this.tracingEnabled) return;

    const agentId = input.agent_id;
    if (!agentId) return;

    // No tracker: the subagent started under a since-restarted daemon. Recover it.
    const tracker = session.subagents.byAgentId(agentId)
      ?? this.recoverSubagentTracker(session, agentId, input.agent_type);
    if (!tracker) {
      this.log('ERROR', `SubagentStop: no tracker for agentId=${agentId} and none recoverable`);
      return;
    }

    // The subagent's LLM calls nest under its `invoke_agent` marker, so its
    // work (and token usage) reads as the subagent's own subtree. Orphans that
    // never got a marker fall back to the turn; the `gen_ai.agent.name` tag on
    // each chat keeps them queryable by agent either way.
    const chatParent = tracker.subAgent ?? session.currentTurn;

    // Fall back to the stored or agentId-derived path when the payload omits it.
    const agentTranscriptPath =
      input.agent_transcript_path ??
      tracker.transcriptPath ??
      computeSubagentTranscriptPath(session.transcript.resolvedPath, agentId);
    let model: string | undefined;
    let lastAssistantText: string | undefined;
    if (agentTranscriptPath && chatParent) {
      let agentTranscript: TranscriptFile | undefined;
      try {
        agentTranscript = new TranscriptFile(agentTranscriptPath);
        const parsed = parseSessionFd(agentTranscript.getFd());
        // Last turn only: a subagent transcript occasionally carries the
        // parent's prior assistant message as pre-context (a 2-turn parse);
        // emitting earlier turns would mis-attribute the parent's LLM call
        // to this subagent invocation.
        const lastTurn = parsed?.turns.at(-1);
        model = lastTurn?.primaryModel();
        lastAssistantText = lastTurn?.textBlocks().join('\n');

        // pendingTeammateIdle: TeammateIdle will emit the FULL transcript as
        // the teammate's own turn trace; emitting the last turn here too would
        // double-count its chat spans (and their token usage).
        if (lastTurn && !tracker.pendingTeammateIdle) {
          this.emitChatSpans(chatParent, lastTurn.assistantCalls(), tracker.subagentType);
        }
      } catch (err) {
        this.log('DEBUG', `SubagentStop: could not parse transcript: ${err}`);
      } finally {
        agentTranscript?.close();
      }
    }

    if (tracker.subAgent) {
      // Stamp the model the subagent actually ran on (Claude Code's
      // SubagentStart payload doesn't carry the model; the transcript does).
      if (model) {
        tracker.subAgent.setAttributes({ [ATTR.RESPONSE_MODEL]: model });
      }
      // Close only plain orphans (no PostToolUse will fire for them). Matched
      // trackers wait for PostToolUse's canonical tool_response; orphans
      // awaiting TeammateIdle stay open so it can emit all-turns content.
      if (!tracker.ended && !tracker.toolUseId && !tracker.pendingTeammateIdle) {
        this.closeSubagent(tracker, lastAssistantText, /*failure*/ false);
      }
    }

    this.log(
      'DEBUG',
      `Subagent stopped: agentId=${agentId} type=${tracker.subagentType} model=${model ?? 'unknown'} wall_clock=${Date.now() - tracker.detectedAt.getTime()}ms`,
    );

    // Only remove orphan trackers here. Matched trackers stay until
    // PostToolUse(Agent) closes the invoke_agent span and removes them.
    // Orphans awaiting TeammateIdle also stay — TeammateIdle will close and remove.
    if (!tracker.toolUseId && !tracker.pendingTeammateIdle) {
      session.subagents.remove(tracker);
    }
  }

  private async handleTeammateIdle(sessionId: string, input: TeammateIdleHookInput): Promise<void> {
    if (!this.tracingEnabled) return;
    // Fail open on a missing session: this hook fires under the TEAMMATE's
    // session_id, which may not be registered here (only the coordinator is).
    // `session` is optional for the cross-session team path and required only for
    // the per-session fallback, so do not early-return without it.
    const session = this.sessions.get(sessionId);

    // Payload notes: session_id is the teammate's (not the coordinator's), and
    // transcript_path points at the coordinator's transcript, so ignore it and
    // use the path stored at SubagentStart. INVARIANT: teammate_name must equal
    // the `name` the coordinator passed to the Agent tool, or the lookup misses.
    const agentType = input.teammate_name;
    const teamName = input.team_name;

    // ── Cross-session team path (agent-teams / TeamCreate model) ─────────
    // The coordinator's PreToolUse(Agent, team_name) registered the invoke_agent
    // span in teamMembers under `${team_name}::${name}` (a FIFO queue). Consume
    // the OLDEST not-yet-emitted entry, so re-spawns of the same name match in
    // dispatch order instead of overwriting each other.
    const key = `${teamName}::${agentType}`;
    const queue = this.teamMembers.get(key);
    if (queue && queue.length) {
      const member = queue.find(m => !m.emitted);
      if (!member) {
        // All queued spans for this key already emitted — duplicate (repeat)
        // TeammateIdle. Expected; nothing to do.
        this.log('DEBUG', `TeammateIdle: ${key} all ${queue.length} entries already emitted — skipping duplicate idle`);
        return;
      }
      member.emitted = true;
      const idleTranscript = session?.transcript.resolvedPath ?? input.transcript_path;
      const teammateTranscriptPath = this.resolveTeammateTranscript(member.coordinatorTranscriptPath, agentType, idleTranscript);
      this.emitTeammateTurnTrace(member.subAgent, member.conversation, agentType, teammateTranscriptPath);
      // Remove the consumed entry; drop the key once its queue drains.
      const idx = queue.indexOf(member);
      if (idx >= 0) queue.splice(idx, 1);
      if (!queue.length) this.teamMembers.delete(key);
      this.log('INFO', `TeammateIdle: traced ${agentType} team=${teamName} (cross-session) transcript=${teammateTranscriptPath ?? '(none)'} (queue depth now ${queue.length})`);
      return;
    }

    // No team entry for this key. If OTHER team keys ARE registered, this most
    // likely means the teammate_name ≠ Agent.name invariant was violated — log
    // it loudly (not silently) so it is debuggable, then try the per-session path.
    if (this.teamMembers.size > 0) {
      this.log('INFO', `TeammateIdle: no team entry for ${key} (registered: ${[...this.teamMembers.keys()].join(', ')}) — check teammate_name === Agent.name`);
    }

    // ── Per-session path (individual Agent calls without team_name) ──────
    // Requires the firing session to be known to this daemon. Find the orphan
    // tracker created at SubagentStart; SubagentStop left its invoke_agent span
    // open specifically so we can close it here with full all-turns content.
    if (!session) {
      this.log('DEBUG', `TeammateIdle: session ${sessionId} unknown and no team entry for ${key} — skipping`);
      return;
    }
    const tracker = session.subagents.findPendingTeammateIdle(agentType);

    if (!tracker?.subAgent) {
      this.log('DEBUG', `TeammateIdle: no pending tracker for ${agentType} team=${teamName} — skipping`);
      return;
    }

    // Use the transcript path stored at SubagentStart — more reliable than
    // the payload's transcript_path which CC sets to the coordinator's path.
    const transcriptPath = tracker.transcriptPath;

    this.log('DEBUG', `TeammateIdle: agent=${agentType} team=${teamName} transcript=${transcriptPath ?? '(none)'}`);

    // Emit ALL turns from the teammate transcript under a fresh teammate turn
    // trace (the coordinator turn that spawned it has already closed). Teammates
    // are independent top-level sessions: every turn is their own work.
    if (!session.conversation) return;
    const model = this.emitTeammateTurnTrace(tracker.subAgent, session.conversation, agentType, transcriptPath);
    tracker.ended = true;
    session.subagents.remove(tracker);

    this.log('INFO', `TeammateIdle: traced ${agentType} model=${model ?? 'unknown'} path=${transcriptPath ?? '(no transcript)'}`);
  }

  /** Resolve a teammate's OWN transcript. TeammateIdle.session_id is unreliable
   *  (sometimes the teammate's, sometimes the coordinator's), so the idle
   *  session's transcript may be the coordinator's. The authoritative source is
   *  `<coordinator-session-dir>/subagents/agent-<id>.jsonl` paired with a sibling
   *  `agent-<id>.meta.json` carrying `{"agentType": <name>}`. Match by
   *  agentType === teammateName; pick the most-recently-modified if re-spawned. */
  private resolveTeammateTranscript(
    coordinatorTranscriptPath: string,
    teammateName: string,
    idleTranscriptPath: string | undefined,
  ): string | undefined {
    try {
      const subagentsDir = subagentsDirFor(coordinatorTranscriptPath);
      if (fs.existsSync(subagentsDir)) {
        let best: { p: string; mtime: number } | undefined;
        for (const meta of fs.readdirSync(subagentsDir).filter(f => f.endsWith('.meta.json'))) {
          try {
            const info = JSON.parse(fs.readFileSync(path.join(subagentsDir, meta), 'utf8')) as { agentType?: string };
            if (info?.agentType !== teammateName) continue;
            const transcript = path.join(subagentsDir, meta.replace(/\.meta\.json$/, '.jsonl'));
            if (!fs.existsSync(transcript)) continue;
            const mtime = fs.statSync(transcript).mtimeMs;
            if (!best || mtime > best.mtime) best = { p: transcript, mtime };
          } catch { /* skip malformed meta */ }
        }
        if (best) return best.p;
      }
    } catch (err) {
      this.log('DEBUG', `resolveTeammateTranscript(${teammateName}): ${err}`);
    }
    return idleTranscriptPath;
  }

  /**
   * Emit one chat span (LLM) per assistant API response under `parent`,
   * reconstructed from transcript data. Split transcript lines sharing a
   * `message.id` are grouped into one span so a response's usage isn't counted
   * more than once. `agentName` tags each span so a subagent's/teammate's calls
   * stay queryable by agent.
   */
  private emitChatSpans(
    parent: weave.Turn | weave.SubAgent,
    calls: AssistantCallDetail[],
    agentName?: string,
  ): void {
    const emitted = new Set<string>();
    for (let i = 0; i < calls.length; i++) {
      const key = chatMessageKey(calls[i], i);
      if (emitted.has(key)) continue;
      emitted.add(key);
      const group = callsForResponseKey(calls, key);
      const llm = openChatForGroup(parent, group);
      if (llm) recordChat(llm, group, agentName);
    }
  }

  /**
   * Emit a teammate's whole transcript as its own turn trace, then close the
   * teammate's Subagent marker. TeammateIdle fires after the spawning
   * coordinator turn has closed, so the teammate can't nest under it; it gets a
   * fresh turn started from the coordinator's Conversation handle to seed the
   * conversation.id and integration identity (neither inherited cross-session).
   * Backdated to span the transcript's first request through its last response
   * so its chat children stay inside the parent's window. Returns the model.
   */
  private emitTeammateTurnTrace(
    subAgent: weave.SubAgent,
    conversation: weave.Conversation,
    agentType: string,
    transcriptPath: string | undefined,
  ): string | undefined {
    let model: string | undefined;
    let lastAssistantText: string | undefined;
    let t: TranscriptFile | undefined;
    try {
      if (!transcriptPath) throw new Error('no teammate transcript path');
      t = new TranscriptFile(transcriptPath);
      const parsed = parseSessionFd(t.getFd());
      if (parsed?.turns.length) {
        const allCalls = parsed.turns.flatMap((pt) => pt.assistantCalls());
        const first = allCalls[0];
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
          // In a finally so a mid-emit throw can't leak the root un-exported.
          turn.end({ endTime: parseIsoOrNow(allCalls.at(-1)?.timestamp) });
        }
        const lastTurn = parsed.turns.at(-1);
        model = lastTurn?.primaryModel();
        lastAssistantText = lastTurn?.textBlocks().join('\n');
      }
    } catch (err) {
      this.log('DEBUG', `emitTeammateTurnTrace: could not parse ${transcriptPath}: ${err}`);
    } finally {
      t?.close();
    }
    if (model) subAgent.setAttributes({ [ATTR.RESPONSE_MODEL]: model });
    if (lastAssistantText) {
      subAgent.setAttributes({
        [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([lastAssistantText]),
      });
    }
    subAgent.end();
    return model;
  }

  private async handlePreCompact(sessionId: string, input: PreCompactHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // The SDK's PreCompactHookInput exposes trigger/custom_instructions; the
    // Weave Agents backend wants a compaction summary + item counts, which live
    // CC payloads carry but the SDK type doesn't declare, so read them off the
    // raw record.
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
      this.log('INFO', `PreCompact attached to active turn ${session.turnNumber} (session ${sessionId})`);
    } else {
      // Buffer until the next UserPromptSubmit opens a turn span.
      session.pendingCompaction = attrs;
      this.log('INFO', `PreCompact buffered; will attach to next turn (session ${sessionId})`);
    }
  }

  private async handleStop(sessionId: string, input: StopHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentTurn) return;

    // Pass last_assistant_message so the retry waits for the synthesis to
    // flush; otherwise the final chat span drops when the read races the writer.
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

    // Finalize the chat-span state machine for this turn.
    //   - The active chat span (open during PreToolUse) gets its output parts
    //     plus its usage attrs, then ends.
    //   - Assistant calls that never triggered a PreToolUse (final text-only
    //     message, or any other tool-less call) get a fresh chat span emitted
    //     here with their full content as output parts.
    if (currentTurn) {
      const calls = currentTurn.assistantCalls();
      if (session.activeChat) {
        this.finalizeActiveChatSpan(session, calls);
      }
      // Emit a chat span for every response that never opened one during
      // PreToolUse (tool-less responses, or any not yet emitted).
      for (let i = 0; i < calls.length; i++) {
        const key = chatMessageKey(calls[i], i);
        if (session.emittedChatSpanResponseKeys.has(key)) continue;
        this.emitChatSpanForResponse(session, calls, key);
      }
    } else if (session.activeChat) {
      // Parse failed (retry budget exhausted): close the chat span bare rather
      // than leak it un-ended and leave a stale key for the next turn.
      session.activeChat.llm.end();
      session.activeChat = undefined;
    }

    const parsedTexts = currentTurn?.textBlocks() ?? [];
    const lastMessage = input.last_assistant_message ?? '';
    const assistantMessages = parsedTexts.length > 0 ? parsedTexts : (lastMessage ? [lastMessage] : []);

    const turnAttrs: Attributes = { [ATTR.WEAVE_TURN_TOOL_COUNT]: session.turnToolCalls };
    if (assistantMessages.length) {
      turnAttrs[ATTR.OUTPUT_MESSAGES] = assistantOutputMessages(assistantMessages);
    }
    const finishReasons = currentTurn?.assistantCalls().map(c => c.finishReason).filter((r): r is string => !!r);
    if (finishReasons?.length) {
      turnAttrs[ATTR.RESPONSE_FINISH_REASONS] = finishReasons;
    }
    session.currentTurn.setAttributes(turnAttrs);
    // Through record(), not setAttributes: Turn.end() re-emits
    // gen_ai.request.model from its internal field, so a raw attribute write
    // of the parsed model would be clobbered by the initial-request model.
    if (model) {
      session.currentTurn.record({ model });
    }
    session.currentTurn.end();
    session.currentTurn = undefined;

    this.log('INFO', `Finished turn ${session.turnNumber} (${session.turnToolCalls} tools)`);
  }

  private async handleSessionEnd(sessionId: string, input: SessionEndHookInput): Promise<void> {
    // Discard any never-drained instruction buffer (e.g. a session that emitted
    // InstructionsLoaded but never SessionStart) so the map can't leak.
    this.pendingInstructions.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.log(
      'DEBUG',
      `SessionEnd: session=${sessionId} reason=${input.reason} transcript_path=${session.transcript.resolvedPath} turns=${session.turnNumber} total_tools=${session.totalToolCalls} pending_tools=${session.pendingToolCalls.size} open_subagents=${session.subagents.size()}`,
    );

    this.finalizeSession(session, 'session_ended');

    this.log('INFO', `Finished session ${sessionId}`);

    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    session.transcript.close();
  }

  /**
   * End every span still open on a session (pending tools, active chat, current
   * turn root, tracked subagent markers), stamping `orphan_reason` so the trace
   * records why each closed outside its normal path. The active chat span is
   * finalized from the transcript like Stop does; a failed parse falls back to a
   * bare close. Called from SessionEnd and drain; finalizing at shutdown is what
   * keeps an interrupted turn's root exported (else its already-exported
   * children are left rootless). Idempotent per span.
   */
  private finalizeSession(session: SessionState, orphanReason: string): void {
    this.finalizeOpenTurn(session, orphanReason);

    // Close any subagent invoke_agent spans that didn't receive PostToolUse
    // or SubagentStop. Without this they'd leak open and never export.
    for (const tracker of session.subagents.all()) {
      if (tracker.subAgent && !tracker.ended) {
        tracker.subAgent.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: orphanReason });
        tracker.subAgent.end({ error: new Error('subagent did not complete before shutdown') });
        tracker.ended = true;
      }
      this.log('DEBUG', `Subagent tracker not stopped: ${tracker.agentId ?? '(unmatched)'} type=${tracker.subagentType}`);
    }
  }

  /**
   * Close everything still open on the current turn (pending tools, active chat,
   * turn root), stamping `orphanReason`. The chat span is finalized from the
   * now-flushed transcript like Stop does; a failed parse falls back to a bare
   * close. Called from finalizeSession and from handleUserPromptSubmit when a
   * user interrupt ended the previous turn with no Stop hook: the interrupt also
   * kills in-flight tools, and without this the next turn would overwrite the
   * handle and leak the root unexported.
   */
  private finalizeOpenTurn(session: SessionState, orphanReason: string): void {
    for (const [toolUseId, pending] of session.pendingToolCalls) {
      resolvePermissionIfPending(pending, false);
      pending.tool.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: orphanReason });
      pending.tool.end({ error: new Error(`tool did not complete (${orphanReason})`) });
      this.log('DEBUG', `Closed orphaned tool span: ${toolUseId} (${pending.toolName})`);
    }
    session.pendingToolCalls.clear();

    if (session.activeChat) {
      let finalized = false;
      if (session.currentTurn) {
        let parsed: ParsedSession | null = null;
        try {
          parsed = parseSessionFd(session.transcript.getFd());
        } catch {
          parsed = null;
        }
        const lastTurn = parsed?.turns.at(-1);
        if (lastTurn) {
          this.finalizeActiveChatSpan(session, lastTurn.assistantCalls());
          finalized = true;
        }
      }
      if (session.activeChat) {
        session.activeChat.llm.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: orphanReason });
        session.activeChat.llm.end();
        session.activeChat = undefined;
      }
      this.log('DEBUG', finalized ? `Finalized active chat span` : `Closed orphaned chat span`);
    }

    if (session.currentTurn) {
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
    // Don't shut down while cross-session team correlation is in flight: a
    // shutdown wipes the teamMembers map and breaks nesting for every still-open
    // span. Hold open until the team work drains, bounded by INFLIGHT_HOLD_MAX_MS
    // so a crashed teammate can't pin the daemon indefinitely.
    if (idle < INFLIGHT_HOLD_MAX_MS && this.hasUnemittedTeamMembers()) {
      this.log('DEBUG', 'Inactivity timeout reached but team correlation in flight — staying up');
      return;
    }
    // Also hold open while ordinary work is in flight (open turn, pending tool,
    // or tracked subagent) so a long-running turn or tool isn't cut off
    // mid-flight. Same INFLIGHT_HOLD_MAX_MS ceiling so a stuck session can't pin
    // the daemon indefinitely.
    if (idle < INFLIGHT_HOLD_MAX_MS && this.hasInFlightWork()) {
      this.log('DEBUG', 'Inactivity timeout reached but work in flight — staying up');
      return;
    }
    this.log('INFO', 'Inactivity timeout — shutting down');
    void this.shutdown('inactivity');
  }

  /** True if any registered team member still awaits its TeammateIdle. Used to
   *  keep the daemon alive across an agent-teams run's quiet windows. */
  private hasUnemittedTeamMembers(): boolean {
    for (const queue of this.teamMembers.values()) {
      if (queue.some(m => !m.emitted)) return true;
    }
    return false;
  }

  /** True if any session has work in flight: an open turn span, a pending tool
   *  call, or a tracked subagent. Keeps the daemon alive across the inactivity
   *  timeout so in-flight work isn't cut off mid-flight (see checkInactivity). */
  private hasInFlightWork(): boolean {
    for (const s of this.sessions.values()) {
      if (s.currentTurn) return true;
      if (s.pendingToolCalls.size > 0) return true;
      if (s.subagents.size() > 0) return true;
    }
    return false;
  }

  private async shutdown(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.drain(reason);
    process.exit(0);
  }

  /**
   * Everything a shutdown does except the final `process.exit`: end in-flight
   * spans, flush the exporter, release the socket. Split out from `shutdown` so
   * tests can exercise it without terminating the process. Order matters: open
   * sessions are finalized (root turns ended) before `weave.flushOTel()` so
   * those roots make the final export batch instead of being left rootless.
   */
  private async drain(reason: string): Promise<void> {
    this.log('INFO', `Shutdown: ${reason}`);
    this.server?.close();
    // Close any queued team-member spans whose teammate never emitted a
    // TeammateIdle (crashed, or daemon exited first) so they flush as ended,
    // orphan-marked spans instead of leaking.
    for (const [, queue] of this.teamMembers) {
      for (const m of queue) {
        if (m.emitted) continue;
        try {
          m.subAgent.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: 'daemon_shutdown' });
          m.subAgent.end({ error: new Error('teammate did not complete before shutdown') });
        } catch { /* best effort */ }
      }
    }
    this.teamMembers.clear();
    // Finalize every live session's still-open spans (turn root, active chat,
    // pending tools, subagents) so an interrupted turn keeps its exported root.
    // Per-session try: one bad session must not abort the flush below.
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

  /** Categorize an error value into a short identifier for `error.type`. */
  private errorTypeFor(error: unknown): string {
    if (typeof error === 'string') {
      const trimmed = error.trim();
      if (!trimmed) return 'tool_error';
      // Take the first word that looks like a category label
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
