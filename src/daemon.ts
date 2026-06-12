// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  Span,
  SpanStatusCode,
  Tracer,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { loadSettings, VERSION } from './setup.js';
import { appendToLog, deepEqual } from './utils.js';
import { parseSessionFd, extractAssistantTextBlocks } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import {
  ATTR,
  DEFAULT_AGENT_NAME,
  CompactionAttrs,
  startTurnSpan,
  startToolSpan,
  startInvokeAgentSpan,
  emitChatSpansFromAssistantCalls,
  addPermissionRequestEvent,
  addPermissionResolvedEvent,
  setCompactionAttrs,
  toolDisplayName,
  promptSnippet,
  jsonStr,
} from './genaiSpans.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Inbound control message sent directly to the socket (not a hook event). */
interface ControlMessage {
  command: 'shutdown';
}

/** Raw hook-event payload forwarded by hook-handler.sh. */
type HookPayload = Record<string, unknown>;

function isControlMessage(payload: unknown): payload is ControlMessage {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as ControlMessage).command === 'shutdown'
  );
}

/** Stores the tool span opened at PreToolUse so PostToolUse can close it. */
interface PendingToolCall {
  span: Span;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** True once a PermissionRequest event has been emitted for this tool. */
  permissionRequested?: boolean;
}

/** Emit `weave.permission_resolved` on a pending tool call's span, if one was requested. */
function resolvePermissionIfPending(pending: PendingToolCall, approved: boolean): void {
  if (!pending.permissionRequested) return;
  addPermissionResolvedEvent(pending.span, {
    approved,
    timestamp: new Date(),
  });
}

/** sha256 of the firing prompt — used to correlate an `Agent` PreToolUse with
 *  the subagent's SubagentStart by matching transcript content. */
function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/**
 * Map a parent transcript path + subagent agent_id to the subagent's transcript
 * file. Claude Code writes subagent transcripts as siblings of the parent in a
 * `<session_id>/subagents/` subdirectory:
 *   parent:   <project_dir>/<session_id>.jsonl
 *   subagent: <project_dir>/<session_id>/subagents/agent-<agent_id>.jsonl
 */
function computeSubagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  const projectDir = path.dirname(parentTranscriptPath);
  const sessionDirName = path.basename(parentTranscriptPath, '.jsonl');
  return path.join(projectDir, sessionDirName, 'subagents', `agent-${agentId}.jsonl`);
}

/** Pull the user-message content out of a transcript line. Returns the prompt
 *  string for `{type: 'user', message: {content: string|Array}}` lines, else
 *  undefined. Array-form content is joined across text blocks. */
function extractUserMessageContent(line: Record<string, unknown> | undefined): string | undefined {
  if (!line || line['type'] !== 'user') return undefined;
  const msg = line['message'];
  if (!msg || typeof msg !== 'object') return undefined;
  const content = (msg as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'text') {
        const t = (block as Record<string, unknown>)['text'];
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.length > 0 ? parts.join('') : undefined;
  }
  return undefined;
}

/** True if the last assistant call's joined text ends with `suffix`,
 *  ignoring trailing whitespace on either side. */
function lastAssistantTextEndsWith(
  result: NonNullable<ReturnType<typeof parseSessionFd>>,
  suffix: string,
): boolean {
  const call = result.turns.at(-1)?.assistantCalls().at(-1);
  // Turn exists but parser saw no assistant calls (writer mid-flush).
  if (!call) return false;
  return extractAssistantTextBlocks(call.contentBlocks).join('\n').trimEnd().endsWith(suffix);
}

/** Read the subagent transcript's first line, retrying briefly because Claude
 *  Code may not have flushed it yet when SubagentStart fires. Total wait
 *  bounded by the sum of `RETRY_DELAYS_MS`. */
const SUBAGENT_TRANSCRIPT_RETRY_DELAYS_MS = [0, 50, 100, 150];
async function readSubagentFirstLineWithRetry(
  transcriptPath: string,
): Promise<Record<string, unknown> | undefined> {
  for (const delay of SUBAGENT_TRANSCRIPT_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const line = readFirstTranscriptLine(transcriptPath);
    if (line && line['type'] === 'user') return line;
  }
  return undefined;
}

/**
 * Tracks a subagent across hook events. Two shapes:
 *   (a) Matched — created at PreToolUse when an Agent tool with subagent_type
 *       is detected; carries `toolUseId`, `promptHash`, and a reference to
 *       the subagent's `invoke_agent` span. `agentId` is filled in at
 *       SubagentStart via content-based correlation: sha256(firing prompt) +
 *       subagent_type.
 *   (b) Orphan — created at SubagentStart when no tracker matches the firing
 *       prompt (the parent's Agent PreToolUse never fired, or its prompt
 *       differs from the subagent transcript's line 1). The `invoke_agent`
 *       span is created at SubagentStart with the current turn span as
 *       parent and no input messages (the firing prompt is unavailable).
 *
 * The subagent is its own `invoke_agent <subagent_type>` span, child of the
 * parent turn's `invoke_agent claude-code` span. Per the Weave Agents chat
 * view (`weave/trace_server/agents/chat_view.py`), nested `invoke_agent`
 * spans render as an `agent_start` lifecycle marker with the inner agent's
 * own assistant text — distinct from an `execute_tool` tool-call event.
 * The Agent tool call does NOT emit an `execute_tool` span; it emits this
 * `invoke_agent` span directly.
 */
interface SubagentTracker {
  subagentType: string;
  detectedAt: Date;
  toolUseId?: string;          // tool_use_id of the spawning Agent tool (matched path only)
  invokeAgentSpan?: Span;      // subagent's `invoke_agent` span; subagent chat/tool spans parent here
  agentId?: string;
  /** sha256 of the prompt passed to the Agent tool; matched against the
   *  subagent's transcript line-1 user message at SubagentStart. */
  promptHash?: string;
  /** True once the invoke_agent span has been ended. Guards against
   *  double-end when PostToolUse and SubagentStop both try to close it. */
  ended?: boolean;
  /** Subagent transcript path — stored at SubagentStart so TeammateIdle can
   *  read all turns without relying on the payload's transcript_path (which
   *  CC sets to the coordinator's path, not the subagent's). */
  transcriptPath?: string;
  /** Set on orphan trackers when SubagentStop fires before TeammateIdle.
   *  Suppresses span closure at SubagentStop so TeammateIdle can close it
   *  with full all-turns content. */
  pendingTeammateIdle?: boolean;
  /** Set when this Agent tool spawn carried a `team_name` (agent-teams model).
   *  The teammate runs in its OWN session, so its TeammateIdle fires under a
   *  different session_id and the per-session lookup misses. The invoke_agent
   *  span is registered in GlobalDaemon.teamMembers and closed there (at the
   *  teammate's TeammateIdle), NOT at the coordinator's PostToolUse(Agent). */
  teamName?: string;
}

/** Cross-session team correlation. In agent-teams (TeamCreate) a teammate is an
 *  independent Claude session whose TeammateIdle fires under the teammate's own
 *  session_id, not the coordinator's — so the per-session SubagentTracking
 *  lookup misses. The coordinator's PreToolUse(Agent, team_name) is the one
 *  reliable anchor; we record its invoke_agent span here keyed by
 *  `${team_name}::${name}`.
 *
 *  Entries are stored as a FIFO queue per key (not a single value) because the
 *  SAME `${team}::${name}` can be spawned more than once in a run — e.g. the
 *  TARS triage flow re-spawns a specialist (Sonnet→Opus) for deeper work. Each
 *  spawn pushes its own TeamMember; each teammate's TeammateIdle consumes the
 *  oldest not-yet-emitted entry (FIFO), so re-spawns never overwrite a live span
 *  (which would leak it and mis-attribute the first teammate's transcript). This
 *  mirrors SubagentTracking.findPendingTeammateIdle for the per-session path. */
interface TeamMember {
  invokeAgentSpan: Span;
  conversationId: string;
  coordinatorTranscriptPath: string;
  emitted: boolean;
}

interface SessionState {
  sessionId: string;
  /** Root ancestor's session id — used as `gen_ai.conversation.id` so resumed
   *  turns stitch with their pre-resume turns server-side. Equals `sessionId`
   *  for fresh (non-forked) sessions. Resolved once at SessionStart by
   *  walking `forkedFrom.sessionId` pointers across transcript files. */
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel?: string;

  currentTurnSpan?: Span;

  turnNumber: number;
  totalToolCalls: number;
  turnToolCalls: number;
  toolCounts: Record<string, number>;

  pendingToolCalls: Map<string, PendingToolCall>;
  subagents: SubagentTracking;

  /** Compaction attrs buffered while no turn span is open. Drained on next UserPromptSubmit. */
  pendingCompaction?: CompactionAttrs;

}

// ─────────────────────────────────────────────────────────────────────────────
// GlobalDaemon
// ─────────────────────────────────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;  // 10 minutes
// Absolute ceiling for holding the daemon open past the normal inactivity
// timeout while cross-session team work is in flight (see checkInactivity).
// Bounds the case where a teammate crashes and never emits TeammateIdle, so an
// unemitted entry can't pin the daemon forever.
const TEAM_INFLIGHT_MAX_MS = 60 * 60 * 1_000;   // 60 minutes
const CONNECTION_TIMEOUT_MS = 5_000;            // 5 seconds per connection

const MAX_SOCKET_PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB per message

/**
 * Per-session container that tracks subagents from PreToolUse (when an Agent
 * tool with subagent_type is detected) through SubagentStop. Single source of
 * truth for the tracker list, with intent-revealing lookup methods.
 */
class SubagentTracking {
  private trackers: SubagentTracker[] = [];

  /** Add a pending tracker at PreToolUse, before SubagentStart correlates an agent_id. */
  add(tracker: SubagentTracker): void {
    this.trackers.push(tracker);
  }

  /**
   * Find the unmatched tracker (no agent_id yet) matching `(promptHash,
   * subagentType)`. FIFO across ties: the oldest pending tracker wins, so two
   * back-to-back identical Agent calls still correlate in dispatch order.
   * Returns undefined if no candidate qualifies.
   */
  findUnmatchedByContent(promptHash: string, subagentType: string): SubagentTracker | undefined {
    let best: SubagentTracker | undefined;
    for (const t of this.trackers) {
      if (t.agentId) continue;
      if (t.promptHash !== promptHash) continue;
      if (t.subagentType !== subagentType) continue;
      if (!best || t.detectedAt.getTime() < best.detectedAt.getTime()) best = t;
    }
    return best;
  }

  byAgentId(agentId: string): SubagentTracker | undefined {
    return this.trackers.find(t => t.agentId === agentId);
  }

  /** Find a tracker awaiting TeammateIdle by its subagentType. Used to
   *  correlate TeammateIdle(teammate_name) with the orphan tracker created
   *  at SubagentStart. Returns the oldest pending match (FIFO). */
  findPendingTeammateIdle(subagentType: string): SubagentTracker | undefined {
    let best: SubagentTracker | undefined;
    for (const t of this.trackers) {
      if (!t.pendingTeammateIdle) continue;
      if (t.subagentType !== subagentType) continue;
      if (!best || t.detectedAt.getTime() < best.detectedAt.getTime()) best = t;
    }
    return best;
  }

  /** Lookup by spawning Agent tool's tool_use_id. Used at PostToolUse to find
   *  the subagent's `invoke_agent` span when the matching toolUseId is not
   *  in `pendingToolCalls` (because the Agent tool emits an invoke_agent
   *  span instead of an execute_tool span). */
  byToolUseId(toolUseId: string): SubagentTracker | undefined {
    return this.trackers.find(t => t.toolUseId === toolUseId);
  }

  remove(tracker: SubagentTracker): void {
    const idx = this.trackers.indexOf(tracker);
    if (idx >= 0) this.trackers.splice(idx, 1);
  }

  size(): number {
    return this.trackers.length;
  }

  all(): SubagentTracker[] {
    return [...this.trackers];
  }
}

export class GlobalDaemon {
  private server?: net.Server;
  private running = false;
  private lastActivity = Date.now();
  /** Inactivity shutdown threshold. Overridable via WEAVE_INACTIVITY_MS (ms) for
   *  testing and for ops (e.g. raising it for long-running agent-teams work). */
  private readonly inactivityMs = Number(process.env.WEAVE_INACTIVITY_MS) || INACTIVITY_TIMEOUT_MS;
  private sessions = new Map<string, SessionState>();
  private sessionQueues = new Map<string, Promise<void>>();
  private provider: NodeTracerProvider | null = null;
  private tracer: Tracer | null = null;
  /** Cross-session team correlation, keyed by `${team_name}::${name}`. Bridges
   *  the coordinator's PreToolUse(Agent) to each teammate's TeammateIdle. The
   *  value is a FIFO queue: a re-spawned `${team}::${name}` appends rather than
   *  overwriting, so two live spans for the same name never collide. */
  private teamMembers = new Map<string, TeamMember[]>();

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly weaveProject: string | null,
    private readonly apiKey: string | null,
    private readonly baseUrl: string,
    private readonly debugEnabled: boolean,
    private readonly agentName: string,
  ) {}

  async start(): Promise<void> {
    // Initialize the OTel tracer if Weave is configured
    if (this.weaveProject && this.apiKey) {
      try {
        this.initTracer();
        this.log('INFO', `OTel tracer initialized — project=${this.weaveProject}, endpoint=${this.baseUrl}/agents/otel/v1/traces`);
        this.log('INFO', `View traces: https://wandb.ai/${this.weaveProject}/weave/agents`);
      } catch (err) {
        this.log('ERROR', `Failed to initialize OTel tracer: ${err} — continuing without tracing`);
        this.provider = null;
        this.tracer = null;
      }
    } else {
      this.log('INFO', 'No weave_project / API key configured — tracing disabled');
    }

    // Bind the socket, yielding cleanly if another daemon already owns it.
    // Concurrent hook invocations can each cold-start a daemon, but only one
    // can bind; the rest yield. See bindSocketWithHerdProtection.
    await this.bindSocketWithHerdProtection();

    this.running = true;
    this.log('INFO', `Daemon started — socket: ${this.socketPath}`);

    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGINT',  () => void this.shutdown('SIGINT'));
    // Without SIGHUP, Node terminates the process on terminal close with no JS
    // handler — leaving the socket inode behind for the next hook event to
    // mistake for a live daemon. Routing SIGHUP through shutdown() unlinks it.
    process.on('SIGHUP',  () => void this.shutdown('SIGHUP'));
    // Belt-and-suspenders: catch any non-signal exit (uncaught exception,
    // process.exit from elsewhere) and remove the inode. Does NOT cover SIGKILL
    // or OOM — the hook handler's probe handles those at next event.
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
      const server = net.createServer((socket) => this.handleConnection(socket));
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
   * Bind the daemon socket, tolerant of a herd of concurrent starts. Tries to
   * listen; on EADDRINUSE/EEXIST it RE-PROBES the socket rather than blindly
   * unlinking it:
   *   - a LIVE listener means another daemon won the race → yield (exit 0);
   *   - a STALE inode (ungraceful prior exit) is safe to remove → unlink, retry.
   * Only a confirmed-stale socket is ever unlinked, so a late starter can never
   * delete the winner's live socket (which would split the teamMembers map
   * across two daemons and break cross-session nesting).
   *
   * Replaces the old existsSync→probe→unlink→listen sequence, which raced: two
   * daemons that both saw no socket reached listen() together and the loser
   * crashed with EEXIST/EADDRINUSE (exit 1) instead of yielding.
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

  private initTracer(): void {
    if (!this.weaveProject) throw new Error('weaveProject required to init tracer');
    if (!this.apiKey) throw new Error('apiKey required to init tracer');

    const [entity, project] = this.weaveProject.split('/', 2);
    if (!entity || !project) {
      throw new Error(`Invalid weave_project format: '${this.weaveProject}' (expected entity/project)`);
    }

    // Route OTel diagnostics into the daemon log so exporter errors surface.
    if (this.debugEnabled) {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
    }

    const resource = resourceFromAttributes({
      // service.name has always mirrored the agent name; keep that coupling
      // so a custom agent_name renames the OTel service too.
      'service.name': this.agentName,
      'service.version': VERSION,
      'wandb.entity': entity,
      'wandb.project': project,
    });

    const exporter = new OTLPTraceExporter({
      url: `${this.baseUrl}/agents/otel/v1/traces`,
      headers: { 'wandb-api-key': this.apiKey },
    });

    this.provider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    this.provider.register();
    this.tracer = this.provider.getTracer('weave-claude-code', VERSION);
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
      if (rejectedForSize) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return;

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        this.log('ERROR', `Malformed JSON from hook: ${raw.slice(0, 200)}`);
        return;
      }

      this.lastActivity = Date.now();

      if (isControlMessage(payload)) {
        void this.shutdown('control message');
        return;
      }

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
    const eventName = payload['hook_event_name'] as string | undefined;
    const sessionId = payload['session_id'] as string | undefined;
    const agentId = payload['agent_id'] as string | undefined;

    if (!sessionId) {
      this.log('ERROR', 'Missing session_id in payload');
      return;
    }

    this.log('INFO', `${eventName ?? 'unknown'} session=${sessionId}${agentId ? ` agent=${agentId}` : ''}`);

    try {
      switch (eventName) {
        case 'SessionStart':
          await this.handleSessionStart(sessionId, payload);
          break;
        case 'UserPromptSubmit':
          await this.handleUserPromptSubmit(sessionId, payload);
          break;
        case 'PreToolUse':
          await this.handlePreToolUse(sessionId, agentId, payload);
          break;
        case 'PermissionRequest':
          await this.handlePermissionRequest(sessionId, payload);
          break;
        case 'PostToolUse':
          await this.handlePostToolUse(sessionId, payload);
          break;
        case 'PostToolUseFailure':
          await this.handlePostToolUseFailure(sessionId, payload);
          break;
        case 'SubagentStart':
          await this.handleSubagentStart(sessionId, payload);
          break;
        case 'SubagentStop':
          await this.handleSubagentStop(sessionId, payload);
          break;
        case 'TeammateIdle':
          await this.handleTeammateIdle(sessionId, payload);
          break;
        case 'PreCompact':
          await this.handlePreCompact(sessionId, payload);
          break;
        case 'Stop':
          await this.handleStop(sessionId, payload);
          break;
        case 'SessionEnd':
          await this.handleSessionEnd(sessionId, payload);
          break;
        default:
          break;
      }
    } catch (err) {
      this.log('ERROR', `Error handling ${eventName ?? 'unknown'}: ${err}`);
    }
  }

  // ── event handlers ────────────────────────────────────────────────────────

  private async handleSessionStart(sessionId: string, payload: HookPayload): Promise<void> {
    if (this.sessions.has(sessionId)) return; // idempotent

    const rawPath = payload['transcript_path'] as string | undefined;
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

    const source = (payload['source'] as string | undefined) ?? 'unknown';
    const initialRequestModel = payload['model'] as string | undefined;
    const cwd = (payload['cwd'] as string | undefined) ?? '';

    const conversationId = await this.resolveConversationId(sessionId, transcript.resolvedPath, source);

    this.sessions.set(
      sessionId,
      this.newSessionState(sessionId, conversationId, transcript, cwd, source, initialRequestModel, 0),
    );

    const resumed = conversationId !== sessionId;
    this.log('INFO', `Session created: ${sessionId}${resumed ? ` (resumed; conversation=${conversationId})` : ''}`);
    this.log(
      'DEBUG',
      `SessionStart details: session=${sessionId} conversation=${conversationId} source=${source} model=${initialRequestModel ?? 'unknown'} cwd=${cwd || '(empty)'} transcript_path=${transcript.resolvedPath} transcript_file=${path.basename(transcript.resolvedPath)} active_sessions=${this.sessions.size}`,
    );
  }

  /**
   * Resolve the canonical `gen_ai.conversation.id` for a session by walking
   * the `forkedFrom.sessionId` chain to the root. Returns `sessionId` itself
   * for fresh (non-forked) sessions, or when the chain can't be resolved.
   *
   * `claude --continue` / `claude --resume <id>` produce a new process-level
   * session_id but stamp every transcript line with `forkedFrom.sessionId`
   * pointing at the immediate parent. Each transcript file is named after
   * its session id and lives in the same project directory, so walking the
   * chain is just sibling-file reads.
   *
   * SessionStart fires roughly when Claude Code flushes the first transcript
   * line, so we retry briefly if the file isn't readable yet. The hard cap
   * on chain depth is a sanity guard against pathological forking, not a
   * real limit.
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

  /** Build a fresh SessionState. `turnNumber` seeds the turn counter: 0 for a
   *  brand-new session, or the number of turns already on disk when
   *  reconstructing a session lost across a daemon restart (so the resumed turn
   *  keeps counting up instead of resetting to 1). */
  private newSessionState(
    sessionId: string,
    conversationId: string,
    transcript: TranscriptFile,
    cwd: string,
    source: string,
    initialRequestModel: string | undefined,
    turnNumber: number,
  ): SessionState {
    return {
      sessionId,
      conversationId,
      transcript,
      cwd,
      source,
      initialRequestModel,
      turnNumber,
      totalToolCalls: 0,
      turnToolCalls: 0,
      toolCounts: {},
      pendingToolCalls: new Map(),
      subagents: new SubagentTracking(),
    };
  }

  /**
   * Return the tracked session, reconstructing it from the event's
   * `transcript_path` when this daemon never saw its SessionStart. The daemon
   * idles out after a short quiet window and keeps all session state in memory;
   * Claude Code only emits SessionStart on startup/resume/clear/compact, so a
   * session that outlives a daemon restart would otherwise be permanently
   * untraced (the "Unknown session" errors). Every hook event carries
   * `transcript_path`, which is enough to rebuild state and resume tracing.
   */
  private async getOrReconstructSession(
    sessionId: string,
    payload: HookPayload,
  ): Promise<SessionState | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const rawPath = payload['transcript_path'] as string | undefined;
    if (!rawPath) return undefined;

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(rawPath);
    } catch (err) {
      this.log('ERROR', `Cannot reconstruct session ${sessionId}: invalid transcript_path: ${err}`);
      return undefined;
    }

    const source = (payload['source'] as string | undefined) ?? 'reconstructed';
    const cwd = (payload['cwd'] as string | undefined) ?? '';
    const initialRequestModel = payload['model'] as string | undefined;
    const conversationId = await this.resolveConversationId(sessionId, transcript.resolvedPath, source);

    // Seed the turn counter from the turns already on disk so numbering
    // continues across the restart instead of resetting to 1.
    let priorTurns = 0;
    try {
      priorTurns = parseSessionFd(transcript.getFd())?.turns.length ?? 0;
    } catch (err) {
      this.log('DEBUG', `Reconstruct ${sessionId}: could not count prior turns: ${err}`);
    }

    const session = this.newSessionState(
      sessionId, conversationId, transcript, cwd, source, initialRequestModel, priorTurns,
    );
    this.sessions.set(sessionId, session);
    this.log(
      'INFO',
      `Session reconstructed after restart: ${sessionId} (conversation=${conversationId}, prior_turns=${priorTurns})`,
    );
    return session;
  }

  private async handleUserPromptSubmit(sessionId: string, payload: HookPayload): Promise<void> {
    // Reconstruct the session if this daemon never saw its SessionStart (e.g. it
    // idled out mid-session and a fresh daemon took over) so the rest of the
    // session stays traced instead of dropping with "Unknown session".
    const session = await this.getOrReconstructSession(sessionId, payload);
    if (!session) {
      this.log('ERROR', `Unknown session (no transcript_path to reconstruct): ${sessionId}`);
      return;
    }
    if (!this.tracer) return;

    const prompt = (payload['prompt'] as string | undefined) ?? '';
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} current_turn_span=${session.currentTurnSpan ? 'open' : 'none'} turn_number=${session.turnNumber} prompt=${promptSnippet(prompt, 120)}`,
    );

    session.turnNumber += 1;
    session.turnToolCalls = 0;
    const turnSpan = startTurnSpan(this.tracer, {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      turnNumber: session.turnNumber,
      prompt,
      cwd: session.cwd,
      source: session.source,
      pluginVersion: VERSION,
      agentName: this.agentName,
      requestModel: session.initialRequestModel,
      displayName: `Turn ${session.turnNumber}: ${promptSnippet(prompt)}`,
    });
    session.currentTurnSpan = turnSpan;

    // Drain compaction attrs buffered while no turn was open.
    if (session.pendingCompaction) {
      setCompactionAttrs(turnSpan, session.pendingCompaction);
      session.pendingCompaction = undefined;
    }


    this.log(
      'INFO',
      `Created turn span (turn ${session.turnNumber}) trace_id=${turnSpan.spanContext().traceId}`,
    );
  }

  private async handlePreToolUse(sessionId: string, agentId: string | undefined, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracer) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    const toolName = payload['tool_name'] as string | undefined;
    if (!toolUseId || !toolName) return;

    const toolInput = (payload['tool_input'] ?? {}) as Record<string, unknown>;

    // Parent: subagent's invoke_agent span if this PreToolUse comes from inside
    // a subagent, else the current turn span.
    const parentSpan = agentId
      ? session.subagents.byAgentId(agentId)?.invokeAgentSpan ?? session.currentTurnSpan
      : session.currentTurnSpan;
    if (!parentSpan) {
      this.log('ERROR', `PreToolUse: no parent span for session=${sessionId} tool=${toolName}`);
      return;
    }

    // Agent tool with subagent_type → emit a nested `invoke_agent <subagent_type>`
    // span, NOT an `execute_tool Agent` span. The Weave Agents chat view renders
    // nested invoke_agent spans as their own `agent_start` lifecycle marker; an
    // execute_tool wrapper here would mis-render the subagent dispatch as a
    // generic tool call. The Agent tool's PostToolUse closes this span with the
    // subagent's final return as `gen_ai.output.messages`.
    //
    // `promptHash` lets SubagentStart correlate this tracker to the right
    // subagent deterministically by reading the subagent transcript's line 1
    // (the firing prompt) and matching by sha256 + subagent_type.
    if (!agentId && toolName === 'Agent' && toolInput['subagent_type']) {
      const subagentType = toolInput['subagent_type'] as string;
      const prompt = typeof toolInput['prompt'] === 'string' ? (toolInput['prompt'] as string) : '';
      const invokeAgentSpan = startInvokeAgentSpan(this.tracer, parentSpan, {
        agentType: subagentType,
        conversationId: session.conversationId,
        pluginVersion: VERSION,
        inputMessages: prompt ? [{ role: 'user', content: prompt }] : undefined,
        spawningToolCallId: toolUseId,
        displayName: toolDisplayName(toolName, toolInput),
      });
      // Agent-teams: when the Agent tool carries a `team_name`, the teammate
      // runs as its own session and TeammateIdle fires under the teammate's
      // session_id. Register the invoke_agent span in the cross-session team
      // map so TeammateIdle can find it regardless of which session fires it.
      const teamName = typeof toolInput['team_name'] === 'string' ? (toolInput['team_name'] as string) : undefined;
      const memberName = (typeof toolInput['name'] === 'string' && toolInput['name']) ? (toolInput['name'] as string) : subagentType;
      session.subagents.add({
        toolUseId,
        subagentType,
        detectedAt: new Date(),
        invokeAgentSpan,
        promptHash: hashPrompt(prompt),
        teamName,
      });
      if (teamName) {
        // Append to the per-key FIFO queue (do NOT overwrite): the same
        // `${team}::${name}` may be spawned again later in the run (e.g. TARS
        // re-spawns a specialist Sonnet→Opus). Overwriting would orphan the
        // first, still-open span and mis-route its teammate's transcript.
        const key = `${teamName}::${memberName}`;
        const queue = this.teamMembers.get(key) ?? [];
        queue.push({
          invokeAgentSpan,
          conversationId: session.conversationId,
          coordinatorTranscriptPath: session.transcript.resolvedPath,
          emitted: false,
        });
        this.teamMembers.set(key, queue);
        this.log('INFO', `Team member registered: ${key} (cross-session nesting, queue depth ${queue.length})`);
      }
      return;
    }

    const toolSpan = startToolSpan(this.tracer, parentSpan, {
      toolName,
      toolUseId,
      toolInput,
      displayName: toolDisplayName(toolName, toolInput),
    });
    session.pendingToolCalls.set(toolUseId, { span: toolSpan, toolName, toolInput });
  }

  private async handlePermissionRequest(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolName = payload['tool_name'] as string | undefined;
    if (!toolName) return;

    // Correlate to a pending tool call by tool_name + tool_input. Record the
    // permission state; the actual span event is added at PostToolUse[Failure]
    // once we know whether it was approved.
    let pending: PendingToolCall | undefined;
    for (const call of session.pendingToolCalls.values()) {
      if (call.toolName === toolName && !call.permissionRequested && deepEqual(call.toolInput, payload['tool_input'])) {
        pending = call;
        break;
      }
    }
    if (!pending) {
      this.log('DEBUG', `PermissionRequest: no pending tool call for tool_name=${toolName}`);
      return;
    }

    pending.permissionRequested = true;
    addPermissionRequestEvent(pending.span, {
      suggestions: payload['permission_suggestions'],
      timestamp: new Date(),
    });

    this.log('DEBUG', `Permission request recorded for ${toolName}`);
  }

  private async handlePostToolUse(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    if (!toolUseId) return;

    // Subagent dispatch: the matching span is the subagent's invoke_agent
    // span (not a pendingToolCall), so we close it here with the subagent's
    // final assistant text as `gen_ai.output.messages`.
    const subagentTracker = session.subagents.byToolUseId(toolUseId);
    if (subagentTracker?.invokeAgentSpan) {
      if (subagentTracker.teamName) {
        // Agent-teams: the Agent tool returns immediately (teammate runs async
        // in its own session). Do NOT close the invoke_agent span — it would
        // end empty before the teammate works. The team map owns it now.
        session.subagents.remove(subagentTracker);
      } else {
        this.closeSubagentInvokeAgentSpan(subagentTracker, payload['tool_response'], /*failure*/ false);
        session.subagents.remove(subagentTracker);
      }
      session.totalToolCalls += 1;
      session.turnToolCalls += 1;
      session.toolCounts['Agent'] = (session.toolCounts['Agent'] ?? 0) + 1;
      return;
    }

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    resolvePermissionIfPending(pending, true);

    pending.span.setAttribute(ATTR.TOOL_CALL_RESULT, jsonStr(payload['tool_response']));
    pending.span.end();

    session.pendingToolCalls.delete(toolUseId);
    session.totalToolCalls += 1;
    session.turnToolCalls += 1;
    session.toolCounts[pending.toolName] = (session.toolCounts[pending.toolName] ?? 0) + 1;
  }

  private async handlePostToolUseFailure(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    if (!toolUseId) return;

    const error = payload['error'] ?? payload['tool_response'];

    // Subagent dispatch failed (rare). Close the invoke_agent span with ERROR
    // status; subagent chat spans, if any reached SubagentStop, are already
    // attached as children.
    const subagentTracker = session.subagents.byToolUseId(toolUseId);
    if (subagentTracker?.invokeAgentSpan) {
      if (subagentTracker.teamName) {
        // Agent-teams: the team map owns this span (closed at the teammate's
        // TeammateIdle, cross-session). Closing it here would end it early and
        // then double-end when TeammateIdle fires. Mirror handlePostToolUse:
        // just drop the per-session tracker; the queue entry lives on.
        session.subagents.remove(subagentTracker);
      } else {
        this.closeSubagentInvokeAgentSpan(subagentTracker, error, /*failure*/ true);
        session.subagents.remove(subagentTracker);
      }
      session.totalToolCalls += 1;
      session.turnToolCalls += 1;
      session.toolCounts['Agent'] = (session.toolCounts['Agent'] ?? 0) + 1;
      return;
    }

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    resolvePermissionIfPending(pending, false);

    pending.span.setAttribute(ATTR.TOOL_CALL_RESULT, jsonStr(error));
    pending.span.setAttribute(ATTR.ERROR_TYPE, this.errorTypeFor(error));
    pending.span.setStatus({ code: SpanStatusCode.ERROR, message: typeof error === 'string' ? error : 'tool failed' });
    pending.span.end();

    session.pendingToolCalls.delete(toolUseId);
    session.totalToolCalls += 1;
    session.turnToolCalls += 1;
    session.toolCounts[pending.toolName] = (session.toolCounts[pending.toolName] ?? 0) + 1;
  }

  /**
   * Close a subagent's `invoke_agent` span. Idempotent — guarded by
   * `tracker.ended` so PostToolUse and SubagentStop can both safely call this
   * regardless of order. Sets `gen_ai.output.messages` from the canonical
   * tool return string when available; marks the span ERROR on failure.
   */
  private closeSubagentInvokeAgentSpan(
    tracker: SubagentTracker,
    output: unknown,
    failure: boolean,
  ): void {
    const span = tracker.invokeAgentSpan;
    if (!span || tracker.ended) return;

    if (output !== undefined && output !== null && output !== '') {
      const outputText = typeof output === 'string' ? output : jsonStr(output);
      span.setAttribute(
        ATTR.OUTPUT_MESSAGES,
        jsonStr([{ role: 'assistant', content: outputText }]),
      );
    }
    if (failure) {
      span.setAttribute(ATTR.ERROR_TYPE, this.errorTypeFor(output));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: typeof output === 'string' ? output : 'subagent failed',
      });
    }
    span.end();
    tracker.ended = true;
  }

  private async handleSubagentStart(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracer) return;

    const agentId = payload['agent_id'] as string | undefined;
    if (!agentId) return;

    const agentType = (payload['agent_type'] as string | undefined) ?? 'unknown';

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
      // No matching Agent tool call — either the parent's PreToolUse never
      // fired, or the firing prompt couldn't be read from the subagent
      // transcript. Create an orphan tracker AND an orphan `invoke_agent`
      // span so the subagent still produces a valid nested agent invocation
      // in the chat view. The span parents under the current turn (no
      // spawning tool_use_id) and has no input_messages (firing prompt
      // unavailable). Closed at SubagentStop since there will be no
      // PostToolUse for it.
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
      if (session.currentTurnSpan) {
        bestTracker.invokeAgentSpan = startInvokeAgentSpan(this.tracer, session.currentTurnSpan, {
          agentType,
          conversationId: session.conversationId,
          pluginVersion: VERSION,
          displayName: `Agent: ${agentType}`,
        });
        bestTracker.invokeAgentSpan.setAttribute(ATTR.WEAVE_ORPHAN_REASON, reason);
      }
      session.subagents.add(bestTracker);
    }

    bestTracker.agentId = agentId;
    if (bestTracker.invokeAgentSpan) {
      // Stamp the runtime agent_id on the subagent's invoke_agent span — the
      // chat view uses `gen_ai.agent.id` to label the subagent's subtree.
      bestTracker.invokeAgentSpan.setAttribute(ATTR.AGENT_ID, agentId);
    }

    this.log('INFO', `Subagent started: agentId=${agentId} type=${agentType} matched=${matched}`);
  }

  private async handleSubagentStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracer) return;

    const agentId = payload['agent_id'] as string | undefined;
    if (!agentId) return;

    const tracker = session.subagents.byAgentId(agentId);
    if (!tracker) {
      this.log('ERROR', `SubagentStop: no tracker for agentId=${agentId}`);
      return;
    }

    // Chat spans for the subagent's LLM calls parent under the subagent's
    // own invoke_agent span. For orphan trackers without an invoke_agent
    // span (no current turn at SubagentStart), fall back to the turn span.
    const chatParent = tracker.invokeAgentSpan ?? session.currentTurnSpan;

    const agentTranscriptPath = payload['agent_transcript_path'] as string | undefined;
    let model: string | undefined;
    let lastAssistantText: string | undefined;
    if (agentTranscriptPath && chatParent) {
      let agentTranscript: TranscriptFile | undefined;
      try {
        agentTranscript = new TranscriptFile(agentTranscriptPath);
        const parsed = parseSessionFd(agentTranscript.getFd());
        // Use the last turn only. Subagent transcripts are almost always
        // single-turn; the rare 2-turn case occurs when the parent agent's
        // prior assistant message is carried in as pre-context on line 0
        // and the user prompt that fires the subagent appears on line 1.
        // Emitting chat spans from earlier turns would mis-attribute the
        // parent's LLM call to this subagent invocation.
        const lastTurn = parsed?.turns[parsed.turns.length - 1];
        model = lastTurn?.primaryModel();
        lastAssistantText = lastTurn?.textBlocks().join('\n');

        if (lastTurn) {
          emitChatSpansFromAssistantCalls(
            this.tracer,
            chatParent,
            session.conversationId,
            lastTurn.assistantCalls(),
          );
        }
      } catch (err) {
        this.log('DEBUG', `SubagentStop: could not parse transcript: ${err}`);
      } finally {
        agentTranscript?.close();
      }
    }

    if (tracker.invokeAgentSpan) {
      // Stamp the model the subagent actually ran on (Claude Code's
      // SubagentStart payload doesn't carry the model; the transcript does).
      if (model) {
        tracker.invokeAgentSpan.setAttribute(ATTR.RESPONSE_MODEL, model);
      }
      // Orphan path: no PostToolUse will fire, so close the invoke_agent
      // span here — unless TeammateIdle is expected to follow (FleetView/
      // Teammate pattern). In that case, keep the span open so TeammateIdle
      // can emit all-turns content and close it correctly.
      // Matched path: leave the span open for PostToolUse to close with the
      // canonical tool_response and remove the tracker; if we removed the
      // tracker here, byToolUseId at PostToolUse would miss it.
      if (!tracker.ended && !tracker.toolUseId && !tracker.pendingTeammateIdle) {
        this.closeSubagentInvokeAgentSpan(tracker, lastAssistantText, /*failure*/ false);
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

  private async handleTeammateIdle(sessionId: string, payload: HookPayload): Promise<void> {
    if (!this.tracer) return;
    // FAIL-OPEN on a missing session: in the agent-teams model this hook fires
    // under the TEAMMATE's session_id, which may not be registered with this
    // daemon (only the coordinator is). `session` is therefore OPTIONAL for the
    // cross-session team path and only REQUIRED for the per-session fallback.
    // Do NOT early-return on a missing session — that would silently drop
    // cross-session nesting, the whole point of this handler.
    const session = this.sessions.get(sessionId);

    // TeammateIdle payload (actual schema, confirmed from live TARS triage):
    //   session_id    — the teammate's session UUID (NOT the coordinator's)
    //   teammate_name — agent name, e.g. "cks-specialist". INVARIANT: must equal
    //                   the `name` the coordinator passed to the Agent tool (in
    //                   TARS, name === subagent_type), else the lookup misses.
    //   team_name     — team name, e.g. "triage-supp-25017"
    //   transcript_path — CC sets this to the coordinator's transcript (not the
    //                     teammate's), so we ignore it and use the path stored
    //                     at SubagentStart instead.
    //
    // Note: CC docs incorrectly listed agent_id / agent_type — those fields do
    // not appear in practice.
    const agentType = (payload['teammate_name'] as string | undefined) ?? 'teammate';
    const teamName = (payload['team_name'] as string | undefined) ?? '?';

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
      const idleTranscript = session?.transcript.resolvedPath ?? (payload['transcript_path'] as string | undefined);
      const teammateTranscriptPath = this.resolveTeammateTranscript(member.coordinatorTranscriptPath, agentType, idleTranscript);
      this.emitTeammateTranscript(member.invokeAgentSpan, member.conversationId, teammateTranscriptPath);
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

    if (!tracker?.invokeAgentSpan) {
      this.log('DEBUG', `TeammateIdle: no pending tracker for ${agentType} team=${teamName} — skipping`);
      return;
    }

    // Use the transcript path stored at SubagentStart — more reliable than
    // the payload's transcript_path which CC sets to the coordinator's path.
    const transcriptPath = tracker.transcriptPath;

    this.log('DEBUG', `TeammateIdle: agent=${agentType} team=${teamName} transcript=${transcriptPath ?? '(none)'}`);

    let model: string | undefined;
    let lastAssistantText: string | undefined;
    let agentTranscript: TranscriptFile | undefined;
    try {
      if (!transcriptPath) throw new Error('no transcript path stored at SubagentStart');
      agentTranscript = new TranscriptFile(transcriptPath);
      const parsed = parseSessionFd(agentTranscript.getFd());
      if (parsed) {
        // Emit chat spans for ALL turns. Teammates are independent top-level
        // sessions — every turn is their own work. SubagentStop only emitted
        // the last turn; we replace that with full coverage here.
        for (const turn of parsed.turns) {
          emitChatSpansFromAssistantCalls(
            this.tracer,
            tracker.invokeAgentSpan,
            session.conversationId,
            turn.assistantCalls(),
          );
        }
        const lastTurn = parsed.turns[parsed.turns.length - 1];
        model = lastTurn?.primaryModel();
        lastAssistantText = lastTurn?.textBlocks().join('\n');
      }
    } catch (err) {
      this.log('DEBUG', `TeammateIdle: could not parse transcript ${transcriptPath}: ${err}`);
    } finally {
      agentTranscript?.close();
    }

    if (model) tracker.invokeAgentSpan.setAttribute(ATTR.RESPONSE_MODEL, model);
    if (lastAssistantText) {
      tracker.invokeAgentSpan.setAttribute(
        ATTR.OUTPUT_MESSAGES,
        JSON.stringify([{ role: 'assistant', content: lastAssistantText }]),
      );
    }

    this.closeSubagentInvokeAgentSpan(tracker, lastAssistantText, /*failure*/ false);
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
      const projectDir = path.dirname(coordinatorTranscriptPath);
      const sessionDirName = path.basename(coordinatorTranscriptPath, '.jsonl');
      const subagentsDir = path.join(projectDir, sessionDirName, 'subagents');
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

  /** Parse a teammate's transcript and emit its chat spans under the given
   *  invoke_agent span, then end it. Used by the cross-session team path. */
  private emitTeammateTranscript(
    invokeAgentSpan: Span,
    conversationId: string,
    transcriptPath: string | undefined,
  ): void {
    let model: string | undefined;
    let lastAssistantText: string | undefined;
    let t: TranscriptFile | undefined;
    try {
      if (!transcriptPath) throw new Error('no teammate transcript path');
      t = new TranscriptFile(transcriptPath);
      const parsed = parseSessionFd(t.getFd());
      if (parsed && this.tracer) {
        for (const turn of parsed.turns) {
          emitChatSpansFromAssistantCalls(this.tracer, invokeAgentSpan, conversationId, turn.assistantCalls());
        }
        const lastTurn = parsed.turns[parsed.turns.length - 1];
        model = lastTurn?.primaryModel();
        lastAssistantText = lastTurn?.textBlocks().join('\n');
      }
    } catch (err) {
      this.log('DEBUG', `emitTeammateTranscript: could not parse ${transcriptPath}: ${err}`);
    } finally {
      t?.close();
    }
    if (model) invokeAgentSpan.setAttribute(ATTR.RESPONSE_MODEL, model);
    if (lastAssistantText) {
      invokeAgentSpan.setAttribute(
        ATTR.OUTPUT_MESSAGES,
        JSON.stringify([{ role: 'assistant', content: lastAssistantText }]),
      );
    }
    invokeAgentSpan.end();
  }

  private async handlePreCompact(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const attrs: CompactionAttrs = {
      summary: (payload['summary'] as string | undefined) ?? (payload['compaction_summary'] as string | undefined),
      itemsBefore: typeof payload['items_before'] === 'number' ? (payload['items_before'] as number) : undefined,
      itemsAfter: typeof payload['items_after'] === 'number' ? (payload['items_after'] as number) : undefined,
    };

    if (session.currentTurnSpan) {
      setCompactionAttrs(session.currentTurnSpan, attrs);
      this.log('INFO', `PreCompact attached to active turn ${session.turnNumber} (session ${sessionId})`);
    } else {
      // Buffer until the next UserPromptSubmit opens a turn span.
      session.pendingCompaction = attrs;
      this.log('INFO', `PreCompact buffered; will attach to next turn (session ${sessionId})`);
    }
  }

  private async handleStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentTurnSpan || !this.tracer) return;

    // Pass last_assistant_message so the retry waits for the synthesis to
    // flush — otherwise the final chat span drops when the read races the writer.
    const rawFinalMessage = payload['last_assistant_message'];
    const finalAssistantMessage = typeof rawFinalMessage === 'string' ? rawFinalMessage : undefined;
    const parsedSession = await this.parseSessionFileWithRetry(
      session.transcript,
      finalAssistantMessage,
    );
    const currentTurn = parsedSession?.turns[parsedSession.turns.length - 1];
    const model = currentTurn?.primaryModel();
    const transcriptTurns = parsedSession?.turns.length ?? 0;
    this.log(
      'DEBUG',
      `Stop: session=${sessionId} trace_id=${session.currentTurnSpan.spanContext().traceId} transcript_path=${session.transcript.resolvedPath} transcript_turns=${transcriptTurns} parsed_model=${model ?? 'unknown'} last_assistant_message_present=${Boolean(payload['last_assistant_message'])}`,
    );

    // Emit one chat span per LLM call within this turn
    if (currentTurn) {
      emitChatSpansFromAssistantCalls(
        this.tracer,
        session.currentTurnSpan,
        session.conversationId,
        currentTurn.assistantCalls(),
      );
    }

    const parsedTexts = currentTurn?.textBlocks() ?? [];
    const lastMessage = (payload['last_assistant_message'] as string | undefined) ?? '';
    const assistantMessages = parsedTexts.length > 0 ? parsedTexts : (lastMessage ? [lastMessage] : []);

    if (assistantMessages.length) {
      session.currentTurnSpan.setAttribute(
        ATTR.OUTPUT_MESSAGES,
        jsonStr(assistantMessages.map((m) => ({ role: 'assistant', content: m }))),
      );
    }

    // Aggregate finish reasons from per-call detail
    const finishReasons = currentTurn?.assistantCalls().map(c => c.finishReason).filter((r): r is string => !!r);
    if (finishReasons?.length) {
      session.currentTurnSpan.setAttribute(ATTR.RESPONSE_FINISH_REASONS, finishReasons);
    }

    if (model) {
      session.currentTurnSpan.setAttribute(ATTR.REQUEST_MODEL, model);
    }

    session.currentTurnSpan.setAttribute(ATTR.WEAVE_TURN_TOOL_COUNT, session.turnToolCalls);
    session.currentTurnSpan.end();
    session.currentTurnSpan = undefined;

    this.log('INFO', `Finished turn ${session.turnNumber} (${session.turnToolCalls} tools)`);
  }

  private async handleSessionEnd(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.log(
      'DEBUG',
      `SessionEnd: session=${sessionId} reason=${(payload['reason'] as string | undefined) ?? 'unknown'} transcript_path=${session.transcript.resolvedPath} turns=${session.turnNumber} total_tools=${session.totalToolCalls} pending_tools=${session.pendingToolCalls.size} open_subagents=${session.subagents.size()}`,
    );

    // Close any pending tool calls that were never completed
    for (const [toolUseId, pending] of session.pendingToolCalls) {
      resolvePermissionIfPending(pending, false);
      pending.span.setAttribute(ATTR.WEAVE_ORPHAN_REASON, 'session_ended');
      pending.span.setStatus({ code: SpanStatusCode.ERROR, message: 'session ended before tool completed' });
      pending.span.end();
      this.log('DEBUG', `Closed orphaned tool span: ${toolUseId} (${pending.toolName})`);
    }

    // Close the current turn if still open
    if (session.currentTurnSpan) {
      session.currentTurnSpan.setAttribute(ATTR.WEAVE_ORPHAN_REASON, 'session_ended');
      session.currentTurnSpan.end();
      this.log('DEBUG', `Closed orphaned turn span`);
    }

    // Close any subagent invoke_agent spans that didn't receive PostToolUse
    // or SubagentStop. Without this they'd leak open and never export.
    for (const tracker of session.subagents.all()) {
      if (tracker.invokeAgentSpan && !tracker.ended) {
        tracker.invokeAgentSpan.setAttribute(ATTR.WEAVE_ORPHAN_REASON, 'session_ended');
        tracker.invokeAgentSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'session ended before subagent completed' });
        tracker.invokeAgentSpan.end();
        tracker.ended = true;
      }
      this.log('DEBUG', `Subagent tracker not stopped: ${tracker.agentId ?? '(unmatched)'} type=${tracker.subagentType}`);
    }

    this.log('INFO', `Finished session ${sessionId}`);

    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    session.transcript.close();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private checkInactivity(): void {
    const idle = Date.now() - this.lastActivity;
    if (idle <= this.inactivityMs) return;
    // Do NOT shut down while cross-session team correlation is in flight: a
    // shutdown wipes the in-memory teamMembers map and breaks nesting for every
    // still-open specialist span. Agent-teams runs have quiet windows (engineer
    // think-time; gaps between spawn and first teammate report) that would
    // otherwise trip the 10-min timeout mid-triage. Hold open until the team
    // work drains, bounded by TEAM_INFLIGHT_MAX_MS so a crashed teammate that
    // never emits TeammateIdle can't pin the daemon indefinitely.
    if (idle < TEAM_INFLIGHT_MAX_MS && this.hasUnemittedTeamMembers()) {
      this.log('DEBUG', 'Inactivity timeout reached but team correlation in flight — staying up');
      return;
    }
    // Also hold open while ordinary work is in flight: an open turn span, a
    // pending tool call, or a tracked subagent. A long-running tool or turn
    // (longer than the timeout, with no other session active) would otherwise
    // trip the timeout mid-flight — dropping the still-open spans and forcing
    // the resumed work onto a fresh, amnesiac daemon. Same TEAM_INFLIGHT_MAX_MS
    // ceiling so a stuck session can't pin the daemon indefinitely.
    if (idle < TEAM_INFLIGHT_MAX_MS && this.hasInFlightWork()) {
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
      if (s.currentTurnSpan) return true;
      if (s.pendingToolCalls.size > 0) return true;
      if (s.subagents.size() > 0) return true;
    }
    return false;
  }

  private async shutdown(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log('INFO', `Shutdown: ${reason}`);
    this.server?.close();
    // Backstop: close any queued team-member invoke_agent spans whose teammate
    // never emitted a TeammateIdle (e.g. teammate crashed, or daemon exits
    // mid-triage) so they flush as ended spans instead of leaking.
    for (const [, queue] of this.teamMembers) {
      for (const m of queue) {
        if (!m.emitted) { try { m.invokeAgentSpan.end(); } catch { /* best effort */ } }
      }
    }
    this.teamMembers.clear();
    if (this.provider) {
      try {
        await this.provider.shutdown();
      } catch (err) {
        this.log('ERROR', `Error shutting down OTel provider: ${err}`);
      }
    }
    for (const session of this.sessions.values()) {
      session.transcript.close();
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    process.exit(0);
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
    if (level === 'DEBUG' && !this.debugEnabled) return;
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

  const weaveProject = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const apiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
  const baseUrl = (process.env['WANDB_BASE_URL'] ?? 'https://trace.wandb.ai').replace(/\/+$/, '');
  // `||` (not `??`) so an empty/whitespace env var or setting falls through to
  // the default rather than producing a blank `invoke_agent ` span name.
  const agentName =
    process.env['WEAVE_AGENT_NAME']?.trim() ||
    settings.agent_name?.trim() ||
    DEFAULT_AGENT_NAME;

  if (!weaveProject || !apiKey) {
    const missing = [!weaveProject && 'weave_project', !apiKey && 'WANDB_API_KEY'].filter(Boolean).join(', ');
    appendToLog(logFile, 'INFO', `Daemon not started — missing configuration: ${missing}`);
    process.exit(0);
  }

  // Ensure downstream tooling (e.g. wandb settings) still sees the API key.
  process.env['WANDB_API_KEY'] = apiKey;

  const debugEnabled = !!process.env['WEAVE_CLAUDE_DEBUG'] || settings.debug === true;
  const daemon = new GlobalDaemon(socketPath, logFile, weaveProject, apiKey, baseUrl, debugEnabled, agentName);

  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
