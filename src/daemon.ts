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
import { appendToLog } from './utils.js';
import { parseSessionFd } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import {
  ATTR,
  CompactionAttrs,
  setCompactionAttrs,
  assistantOutputMessages,
  snippet,
} from './genaiSpans.js';
import { resolveDaemonConfig, daemonConfigFingerprint, missingConfig } from './config.js';
import type { DaemonConfig } from './config.js';
import {
  lastAssistantTextEndsWith,
  newSessionState,
  upsertInstruction,
} from './sessionState.js';
import type {
  SessionState,
  LoadedInstruction,
} from './sessionState.js';

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
    const turn = this.startSessionTurn(session, `Turn ${session.turnNumber}: ${snippet(prompt)}`, prompt);
    if (!turn) return;

    // Drain compaction attrs buffered while no turn was open.
    if (session.pendingCompaction) {
      setCompactionAttrs(turn, session.pendingCompaction);
      session.pendingCompaction = undefined;
    }

    this.log('INFO', `Created turn span (turn ${session.turnNumber})`);
  }

  /** Parked: chat + tool span emission (and the Agent-dispatch subagent marker)
   *  land in the next PRs of this stack; tool calls are only counted for the
   *  turn's tool-count attribute (at PostToolUse) until then. */
  private async handlePreToolUse(sessionId: string, input: PreToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;
    this.log('DEBUG', `PreToolUse (not yet traced): session=${sessionId} tool=${input.tool_name}`);
  }

  private countToolCall(session: SessionState, toolName: string): void {
    session.totalToolCalls += 1;
    session.turnToolCalls += 1;
    session.toolCounts[toolName] = (session.toolCounts[toolName] ?? 0) + 1;
  }

  /** Parked: the permission span event lands with tool spans later in this stack. */
  private async handlePermissionRequest(sessionId: string, input: PermissionRequestHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.log('DEBUG', `PermissionRequest (not yet traced): session=${sessionId} tool=${input.tool_name}`);
  }

  private async handlePostToolUse(sessionId: string, input: PostToolUseHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !input.tool_name) return;
    // Parked: tool spans land later in this stack; count for the turn attrs.
    this.countToolCall(session, input.tool_name);
  }

  private async handlePostToolUseFailure(sessionId: string, input: PostToolUseFailureHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !input.tool_name) return;
    // Parked: tool spans land later in this stack; count for the turn attrs.
    this.countToolCall(session, input.tool_name);
  }

  /** Parked: subagent `invoke_agent` markers land later in this stack. */
  private async handleSubagentStart(sessionId: string, input: SubagentStartHookInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracingEnabled) return;
    this.log('DEBUG', `SubagentStart (not yet traced): session=${sessionId} agent=${input.agent_id}`);
  }

  /** Parked: subagent `invoke_agent` markers land later in this stack. */
  private async handleSubagentStop(sessionId: string, input: SubagentStopHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || !this.tracingEnabled) return;
    this.log('DEBUG', `SubagentStop (not yet traced): session=${sessionId} agent=${input.agent_id}`);
  }

  /** Parked: teammate tracing lands later in this stack. */
  private async handleTeammateIdle(sessionId: string, input: TeammateIdleHookInput): Promise<void> {
    if (!this.tracingEnabled) return;
    this.log('DEBUG', `TeammateIdle (not yet traced): session=${sessionId} teammate=${input.teammate_name}`);
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

    // Parked: per-response chat spans land later in this stack; the turn root
    // carries the parsed output/model until then.

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
   * End every span still open on a session, stamping `orphan_reason` so the
   * trace records why it closed outside its normal path. Called from SessionEnd
   * and drain; finalizing at shutdown is what keeps an interrupted turn's root
   * exported. Idempotent per span. (Only the turn root exists at this stage of
   * the stack; chat/tool/subagent finalize grows back with their emission.)
   */
  private finalizeSession(session: SessionState, orphanReason: string): void {
    this.finalizeOpenTurn(session, orphanReason);
  }

  /**
   * Close the still-open current turn (root) span, stamping `orphanReason`.
   * Called from finalizeSession and from handleUserPromptSubmit when a user
   * interrupt ended the previous turn with no Stop hook: without this the next
   * turn would overwrite the handle and leak the root unexported.
   */
  private finalizeOpenTurn(session: SessionState, orphanReason: string): void {
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
    // Hold open while work is in flight (open turn, pending tool, or tracked
    // subagent) so a long-running turn or tool isn't cut off mid-flight. The
    // INFLIGHT_HOLD_MAX_MS ceiling keeps a stuck session from pinning the
    // daemon indefinitely.
    if (idle < INFLIGHT_HOLD_MAX_MS && this.hasInFlightWork()) {
      this.log('DEBUG', 'Inactivity timeout reached but work in flight — staying up');
      return;
    }
    this.log('INFO', 'Inactivity timeout — shutting down');
    void this.shutdown('inactivity');
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
    // Finalize every live session's still-open spans so an interrupted turn
    // keeps its exported root. Per-session try: one bad session must not abort
    // the flush below.
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
