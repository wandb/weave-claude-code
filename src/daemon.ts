// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

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
import { recordTurn } from './traceRegistry.js';
import { appendToLog, deepEqual } from './utils.js';
import { parseSessionFd } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import {
  ATTR,
  AGENT_NAME_CLAUDE_CODE,
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
  private sessions = new Map<string, SessionState>();
  private sessionQueues = new Map<string, Promise<void>>();
  private provider: NodeTracerProvider | null = null;
  private tracer: Tracer | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly weaveProject: string | null,
    private readonly apiKey: string | null,
    private readonly baseUrl: string,
    private readonly debugEnabled: boolean,
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

    // Remove any stale socket left by a previous crash
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    // Restrict socket to owner-only access
    const prevUmask = process.umask(0o077);
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, resolve);
      this.server!.once('error', reject);
    });
    process.umask(prevUmask);

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

    setInterval(() => this.checkInactivity(), 60_000).unref();
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
      'service.name': AGENT_NAME_CLAUDE_CODE,
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
    this.tracer = this.provider.getTracer('weave-claude-plugin', VERSION);
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

    this.sessions.set(sessionId, {
      sessionId,
      conversationId,
      transcript,
      cwd,
      source,
      initialRequestModel,
      turnNumber: 0,
      totalToolCalls: 0,
      turnToolCalls: 0,
      toolCounts: {},
      pendingToolCalls: new Map(),
      subagents: new SubagentTracking(),
    });

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

  private async handleUserPromptSubmit(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log('ERROR', `Unknown session: ${sessionId}`);
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
      session.subagents.add({
        toolUseId,
        subagentType,
        detectedAt: new Date(),
        invokeAgentSpan,
        promptHash: hashPrompt(prompt),
      });
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
      this.closeSubagentInvokeAgentSpan(subagentTracker, payload['tool_response'], /*failure*/ false);
      session.subagents.remove(subagentTracker);
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
      this.closeSubagentInvokeAgentSpan(subagentTracker, error, /*failure*/ true);
      session.subagents.remove(subagentTracker);
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
      // span here using the subagent's final assistant text as the output.
      // Matched path: leave the span open for PostToolUse to close with the
      // canonical tool_response and remove the tracker; if we removed the
      // tracker here, byToolUseId at PostToolUse would miss it.
      if (!tracker.ended && !tracker.toolUseId) {
        this.closeSubagentInvokeAgentSpan(tracker, lastAssistantText, /*failure*/ false);
      }
    }

    this.log(
      'DEBUG',
      `Subagent stopped: agentId=${agentId} type=${tracker.subagentType} model=${model ?? 'unknown'} wall_clock=${Date.now() - tracker.detectedAt.getTime()}ms`,
    );

    // Only remove orphan trackers here. Matched trackers stay until
    // PostToolUse(Agent) closes the invoke_agent span and removes them.
    if (!tracker.toolUseId) {
      session.subagents.remove(tracker);
    }
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

    // Parse transcript for usage + per-call detail. Retry up to 3 times — the
    // file may still be flushing when Stop fires.
    const parsedSession = await this.parseSessionFileWithRetry(session.transcript);
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
    const turnSpanCtx = session.currentTurnSpan.spanContext();
    const turnStartedAt = (() => {
      const raw = (session.currentTurnSpan as unknown as { startTime?: [number, number] }).startTime;
      if (!Array.isArray(raw)) return new Date().toISOString();
      return new Date(raw[0] * 1000 + Math.floor(raw[1] / 1e6)).toISOString();
    })();
    session.currentTurnSpan.end();
    session.currentTurnSpan = undefined;

    // Record a local breadcrumb so `weave-claude-plugin trace recent` can
    // surface the trace_id for this turn without needing DEBUG-level logs.
    recordTurn({
      sessionId,
      turnNumber: session.turnNumber,
      traceId: turnSpanCtx.traceId,
      conversationId: session.conversationId,
      startedAt: turnStartedAt,
      endedAt: new Date().toISOString(),
      toolCount: session.turnToolCalls,
      subagentCount: session.subagents.size(),
      cwd: session.cwd,
    });

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
    if (Date.now() - this.lastActivity > INACTIVITY_TIMEOUT_MS) {
      this.log('INFO', 'Inactivity timeout — shutting down');
      void this.shutdown('inactivity');
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log('INFO', `Shutdown: ${reason}`);
    this.server?.close();
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

  /** Retry parseSessionFile up to `attempts` times with `delayMs` between each.
   *  The transcript file may still be flushing when Stop fires. */
  private async parseSessionFileWithRetry(
    transcript: TranscriptFile,
    attempts = 3,
    delayMs = 500,
  ): Promise<ReturnType<typeof parseSessionFd>> {
    let fd: number;
    try {
      fd = transcript.getFd();
    } catch (err) {
      this.log('ERROR', `Cannot open transcript for parsing: ${err}`);
      return null;
    }
    for (let i = 0; i < attempts; i++) {
      const result = parseSessionFd(fd);
      if (result?.turns.length) return result;
      if (i < attempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return parseSessionFd(fd);
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
// Entry point (invoked by `weave-claude-plugin daemon`)
// ─────────────────────────────────────────────────────────────────────────────

export async function runDaemon(): Promise<void> {
  const settings = loadSettings();
  const { daemon_socket: socketPath, log_file: logFile } = settings;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const weaveProject = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const apiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
  const baseUrl = (process.env['WANDB_BASE_URL'] ?? 'https://trace.wandb.ai').replace(/\/+$/, '');

  if (!weaveProject || !apiKey) {
    const missing = [!weaveProject && 'weave_project', !apiKey && 'WANDB_API_KEY'].filter(Boolean).join(', ');
    appendToLog(logFile, 'INFO', `Daemon not started — missing configuration: ${missing}`);
    process.exit(0);
  }

  // Ensure downstream tooling (e.g. wandb settings) still sees the API key.
  process.env['WANDB_API_KEY'] = apiKey;

  const debugEnabled = !!process.env['WEAVE_CLAUDE_DEBUG'] || settings.debug === true;
  const daemon = new GlobalDaemon(socketPath, logFile, weaveProject, apiKey, baseUrl, debugEnabled);

  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
