// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  Span,
  SpanStatusCode,
  Tracer,
  Context,
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
import { parseSessionFd, UsageSummary, addUsage } from './parser.js';
import { TraceRegistry } from './traceRegistry.js';
import { TranscriptFile } from './transcriptFile.js';
import {
  ATTR,
  AGENT_NAME_CLAUDE_CODE,
  OP,
  startSessionSpan,
  startTurnSpan,
  startToolSpan,
  startSubagentSpan,
  emitChatSpansFromAssistantCalls,
  addPermissionRequestEvent,
  addPermissionResolvedEvent,
  addCompactionEvent,
  toolDisplayName,
  promptSnippet,
  jsonStr,
  ctxFromSpanContext,
  isValidTraceId,
  isValidSpanId,
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

/**
 * Tracks a subagent across hook events. Two shapes:
 *   (a) Matched — created at PreToolUse when an Agent tool with subagent_type
 *       is detected; carries `toolUseId` and `spawningToolCallId`. `agentId`
 *       and `span` are filled in when SubagentStart arrives.
 *   (b) Orphan — created at SubagentStart when no pending tracker is in the
 *       proximity window. Has no spawning tool, so `toolUseId` and
 *       `spawningToolCallId` are absent.
 */
interface SubagentTracker {
  subagentType: string;
  detectedAt: Date;
  toolUseId?: string;          // tool_use_id of the spawning Agent tool (matched path only)
  spawningToolCallId?: string; // back-pointer attr value (matched path only)
  agentId?: string;
  span?: Span;
}

interface SessionState {
  sessionId: string;
  transcript: TranscriptFile;
  cwd: string;

  sessionSpan?: Span;
  currentTurnSpan?: Span;

  turnNumber: number;
  totalToolCalls: number;
  turnToolCalls: number;
  toolCounts: Record<string, number>;
  totalUsage: Record<string, UsageSummary>;

  pendingToolCalls: Map<string, PendingToolCall>;
  subagents: SubagentTracking;
}

interface TraceResolution {
  /** Pre-existing traceId (32-hex) to force on the new session span, or undefined for a fresh trace. */
  reuseTraceId?: string;
  /** Pre-existing session spanId (16-hex) to use as a synthetic remote parent, if available. */
  reuseSessionSpanId?: string;
  source: 'new' | 'registry-session' | 'registry-transcript' | 'env-parent';
}

// ─────────────────────────────────────────────────────────────────────────────
// GlobalDaemon
// ─────────────────────────────────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;  // 10 minutes
const CONNECTION_TIMEOUT_MS = 5_000;            // 5 seconds per connection

const MAX_SOCKET_PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB per message

/**
 * Per-session container that tracks subagents from PreToolUse (when an Agent
 * tool with subagent_type is detected) through SubagentStop. Replaces a pair
 * of maps keyed by toolUseId and agentId — single source of truth for the
 * tracker list, with intent-revealing lookup methods.
 */
class SubagentTracking {
  private trackers: SubagentTracker[] = [];

  /** Add a pending tracker at PreToolUse, before SubagentStart correlates an agent_id. */
  add(tracker: SubagentTracker): void {
    this.trackers.push(tracker);
  }

  /**
   * Find the unmatched tracker (no agent_id yet) whose detectedAt is closest
   * to `now`, within `windowMs`. Returns undefined if no candidate qualifies.
   */
  findUnmatchedByProximity(now: number, windowMs: number): SubagentTracker | undefined {
    let best: SubagentTracker | undefined;
    let bestDelta = Infinity;
    for (const t of this.trackers) {
      if (t.agentId) continue;
      const delta = now - t.detectedAt.getTime();
      if (delta >= 0 && delta < windowMs && delta < bestDelta) {
        bestDelta = delta;
        best = t;
      }
    }
    return best;
  }

  byAgentId(agentId: string): SubagentTracker | undefined {
    for (const t of this.trackers) if (t.agentId === agentId) return t;
    return undefined;
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
  private traceRegistry = new TraceRegistry();

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly weaveProject: string | null,
    private readonly apiKey: string | null,
    private readonly baseUrl: string,
    private readonly debugEnabled: boolean,
  ) {}

  async start(): Promise<void> {
    const loadedRegistryEntries = this.traceRegistry.load();
    this.log('DEBUG', `Loaded trace registry: ${loadedRegistryEntries} entries`);

    // Initialize the OTel tracer if Weave is configured
    if (this.weaveProject && this.apiKey) {
      try {
        this.initTracer();
        this.log('INFO', `OTel tracer initialized — project=${this.weaveProject}, endpoint=${this.baseUrl}/agents/otel/v1/traces`);
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
    const model = (payload['model'] as string | undefined) ?? 'unknown';
    const cwd = (payload['cwd'] as string | undefined) ?? '';
    const envParentTraceId = (payload['weave_trace_id'] as string | undefined) || process.env['WEAVE_TRACE_ID'];
    const envParentSpanId = (payload['weave_parent_call_id'] as string | undefined) || process.env['WEAVE_PARENT_CALL_ID'];

    const resolution = this.resolveTraceForSession(
      sessionId,
      transcript.resolvedPath,
      source,
      envParentTraceId,
      envParentSpanId,
    );

    let sessionSpan: Span | undefined;
    if (this.tracer) {
      // If we have a prior traceId (resume or env), force it via a synthetic remote parent.
      let parentCtx: Context | undefined;
      if (resolution.reuseTraceId) {
        const synthSpanId = resolution.reuseSessionSpanId ?? randomBytes(8).toString('hex');
        parentCtx = ctxFromSpanContext(resolution.reuseTraceId, synthSpanId, true);
      }
      sessionSpan = startSessionSpan(this.tracer, parentCtx, {
        sessionId,
        cwd,
        source,
        pluginVersion: VERSION,
      });
    }

    const traceId = sessionSpan?.spanContext().traceId ?? resolution.reuseTraceId ?? '';
    const sessionSpanId = sessionSpan?.spanContext().spanId;

    this.sessions.set(sessionId, {
      sessionId,
      transcript,
      cwd,
      sessionSpan,
      turnNumber: 0,
      totalToolCalls: 0,
      turnToolCalls: 0,
      toolCounts: {},
      pendingToolCalls: new Map(),
      subagents: new SubagentTracking(),
      totalUsage: {},
    });

    if (traceId) {
      this.upsertTraceRegistry(sessionId, traceId, transcript.resolvedPath, source, sessionSpanId);
    }

    this.log('INFO', `Session created: ${sessionId}`);
    this.log(
      'DEBUG',
      `SessionStart details: session=${sessionId} source=${source} model=${model} cwd=${cwd || '(empty)'} transcript_path=${transcript.resolvedPath} transcript_file=${path.basename(transcript.resolvedPath)} trace_id=${traceId} trace_resolution=${resolution.source} active_sessions=${this.sessions.size}`,
    );
  }

  private async handleUserPromptSubmit(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log('ERROR', `Unknown session: ${sessionId}`);
      return;
    }
    if (!this.tracer || !session.sessionSpan) return;

    const prompt = (payload['prompt'] as string | undefined) ?? '';
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} trace_id=${session.sessionSpan.spanContext().traceId} current_turn_span=${session.currentTurnSpan ? 'open' : 'none'} turn_number=${session.turnNumber} prompt=${promptSnippet(prompt, 120)}`,
    );

    session.turnNumber += 1;
    session.turnToolCalls = 0;
    const turnSpan = startTurnSpan(this.tracer, session.sessionSpan, {
      sessionId: session.sessionId,
      turnNumber: session.turnNumber,
      prompt,
      pluginVersion: VERSION,
      displayName: `Turn ${session.turnNumber}: ${promptSnippet(prompt)}`,
    });
    session.currentTurnSpan = turnSpan;

    this.log('INFO', `Created turn span (turn ${session.turnNumber})`);
  }

  private async handlePreToolUse(sessionId: string, agentId: string | undefined, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracer) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    const toolName = payload['tool_name'] as string | undefined;
    if (!toolUseId || !toolName) return;

    const toolInput = (payload['tool_input'] ?? {}) as Record<string, unknown>;

    // Parent: subagent span if agent_id is set, else current turn span
    const parentSpan = agentId
      ? session.subagents.byAgentId(agentId)?.span ?? session.currentTurnSpan
      : session.currentTurnSpan;
    if (!parentSpan) {
      this.log('ERROR', `PreToolUse: no parent span for session=${sessionId} tool=${toolName}`);
      return;
    }

    const toolSpan = startToolSpan(this.tracer, parentSpan, {
      toolName,
      toolUseId,
      toolInput,
      displayName: toolDisplayName(toolName, toolInput),
    });
    session.pendingToolCalls.set(toolUseId, { span: toolSpan, toolName, toolInput });

    // Agent tools with subagent_type spawn subagents (parent session only). Record the
    // tool_use_id so handleSubagentStart can correlate and produce a subagent span as a
    // flat sibling under the turn (NOT a child of this tool span).
    if (!agentId && toolName === 'Agent' && toolInput['subagent_type']) {
      session.subagents.add({
        toolUseId,
        subagentType: toolInput['subagent_type'] as string,
        detectedAt: new Date(),
        spawningToolCallId: toolUseId,
      });
    }
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

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    resolvePermissionIfPending(pending, false);

    const error = payload['error'] ?? payload['tool_response'];
    pending.span.setAttribute(ATTR.TOOL_CALL_RESULT, jsonStr(error));
    pending.span.setAttribute(ATTR.ERROR_TYPE, this.errorTypeFor(error));
    pending.span.setStatus({ code: SpanStatusCode.ERROR, message: typeof error === 'string' ? error : 'tool failed' });
    pending.span.end();

    session.pendingToolCalls.delete(toolUseId);
    session.totalToolCalls += 1;
    session.turnToolCalls += 1;
    session.toolCounts[pending.toolName] = (session.toolCounts[pending.toolName] ?? 0) + 1;
  }

  private async handleSubagentStart(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracer || !session.currentTurnSpan) return;

    const agentId = payload['agent_id'] as string | undefined;
    if (!agentId) return;

    // Temporal proximity matching: find the closest unmatched SubagentTracker within 5 s.
    // SubagentStart has no explicit parent pointer, so we correlate by timing.
    const PROXIMITY_MS = 5_000;
    const agentType = (payload['agent_type'] as string | undefined) ?? 'unknown';

    let bestTracker = session.subagents.findUnmatchedByProximity(Date.now(), PROXIMITY_MS);
    const matched = !!bestTracker;
    if (!bestTracker) {
      this.log('ERROR', `SubagentStart: no unmatched tracker for agentId=${agentId}, creating orphan`);
      bestTracker = {
        subagentType: agentType,
        detectedAt: new Date(),
      };
      session.subagents.add(bestTracker);
    }

    bestTracker.agentId = agentId;
    bestTracker.span = startSubagentSpan(this.tracer, session.currentTurnSpan, {
      sessionId: session.sessionId,
      subagentType: bestTracker.subagentType,
      agentId,
      spawningToolCallId: bestTracker.spawningToolCallId,
      pluginVersion: VERSION,
    });

    this.log('INFO', `Subagent started: agentId=${agentId} type=${agentType} matched=${matched}`);
  }

  private async handleSubagentStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.tracer) return;

    const agentId = payload['agent_id'] as string | undefined;
    if (!agentId) return;

    const tracker = session.subagents.byAgentId(agentId);
    if (!tracker?.span) {
      this.log('ERROR', `SubagentStop: no tracker for agentId=${agentId}`);
      return;
    }

    // Parse subagent transcript for model info + per-call chat spans.
    const agentTranscriptPath = payload['agent_transcript_path'] as string | undefined;
    let model: string | undefined;
    if (agentTranscriptPath) {
      let agentTranscript: TranscriptFile | undefined;
      try {
        agentTranscript = new TranscriptFile(agentTranscriptPath);
        const parsed = parseSessionFd(agentTranscript.getFd());
        const lastTurn = parsed?.turns[parsed.turns.length - 1];
        model = lastTurn?.primaryModel();

        // Emit chat spans for every assistant call across the subagent's turns
        if (parsed) {
          for (const turn of parsed.turns) {
            emitChatSpansFromAssistantCalls(
              this.tracer,
              tracker.span,
              `${session.sessionId}:${agentId}`,
              turn.assistantCalls(),
            );
          }
        }
      } catch (err) {
        this.log('DEBUG', `SubagentStop: could not parse transcript: ${err}`);
      } finally {
        agentTranscript?.close();
      }
    }

    const lastMessage = (payload['last_assistant_message'] as string | undefined) ?? '';
    if (lastMessage) {
      tracker.span.setAttribute(
        ATTR.OUTPUT_MESSAGES,
        jsonStr([{ role: 'assistant', content: lastMessage }]),
      );
    }
    if (model) {
      tracker.span.setAttribute(ATTR.RESPONSE_MODEL, model);
    }
    tracker.span.end();

    this.log('DEBUG', `Subagent stopped: agentId=${agentId} type=${tracker.subagentType} model=${model ?? 'unknown'} wall_clock=${Date.now() - tracker.detectedAt.getTime()}ms`);

    session.subagents.remove(tracker);
  }

  private async handlePreCompact(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.sessionSpan) return;

    const summary = (payload['summary'] as string | undefined) ?? (payload['compaction_summary'] as string | undefined);
    const itemsBefore = typeof payload['items_before'] === 'number' ? (payload['items_before'] as number) : undefined;
    const itemsAfter = typeof payload['items_after'] === 'number' ? (payload['items_after'] as number) : undefined;

    addCompactionEvent(session.sessionSpan, {
      summary,
      itemsBefore,
      itemsAfter,
    });

    this.log('INFO', `PreCompact event recorded on session ${sessionId}`);
  }

  private async handleStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentTurnSpan || !this.tracer) return;

    // Parse transcript for usage + per-call detail. Retry up to 3 times — the
    // file may still be flushing when Stop fires.
    const parsedSession = await this.parseSessionFileWithRetry(session.transcript);
    const currentTurn = parsedSession?.turns[parsedSession.turns.length - 1];
    const usage = currentTurn?.totalUsage();
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
        session.sessionId,
        currentTurn.assistantCalls(),
      );
    }

    // Accumulate into session totals for roll-up at SessionEnd
    if (usage && model) {
      const existing = session.totalUsage[model];
      session.totalUsage[model] = existing ? addUsage(existing, usage) : { ...usage };
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

    if (session.sessionSpan) {
      this.upsertTraceRegistry(
        session.sessionId,
        session.sessionSpan.spanContext().traceId,
        session.transcript.resolvedPath,
        (payload['reason'] as string | undefined) ?? 'session_end',
        session.sessionSpan.spanContext().spanId,
      );
    }

    // Close any pending tool calls that were never completed
    for (const [toolUseId, pending] of session.pendingToolCalls) {
      resolvePermissionIfPending(pending, false);
      pending.span.setAttribute(ATTR.WEAVE_ORPHAN_REASON, 'session_ended');
      pending.span.setStatus({ code: SpanStatusCode.ERROR, message: 'session ended before tool completed' });
      pending.span.end();
      this.log('DEBUG', `Closed orphaned tool span: ${toolUseId} (${pending.toolName})`);
    }

    // Close any open subagent spans
    for (const tracker of session.subagents.all()) {
      if (tracker.span) {
        tracker.span.setAttribute(ATTR.WEAVE_ORPHAN_REASON, 'session_ended');
        tracker.span.setStatus({ code: SpanStatusCode.ERROR, message: 'session ended before subagent completed' });
        tracker.span.end();
        this.log('DEBUG', `Closed orphaned subagent span: ${tracker.agentId ?? '(unmatched)'}`);
      }
    }

    // Close the current turn if still open
    if (session.currentTurnSpan) {
      session.currentTurnSpan.setAttribute(ATTR.WEAVE_ORPHAN_REASON, 'session_ended');
      session.currentTurnSpan.end();
      this.log('DEBUG', `Closed orphaned turn span`);
    }

    // Close the session span with aggregate counters
    if (session.sessionSpan) {
      session.sessionSpan.setAttribute(ATTR.WEAVE_SESSION_END_REASON, (payload['reason'] as string | undefined) ?? '');
      session.sessionSpan.setAttribute(ATTR.WEAVE_SESSION_TURN_COUNT, session.turnNumber);
      session.sessionSpan.setAttribute(ATTR.WEAVE_SESSION_TOOL_COUNT, session.totalToolCalls);
      session.sessionSpan.setAttribute(ATTR.WEAVE_SESSION_TOOL_COUNTS, jsonStr(session.toolCounts));
      session.sessionSpan.end();
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

  private upsertTraceRegistry(
    sessionId: string,
    traceId: string,
    transcriptPath: string,
    source: string,
    sessionSpanId?: string,
  ): void {
    try {
      this.traceRegistry.upsert(sessionId, traceId, transcriptPath, source, sessionSpanId);
    } catch (err) {
      this.log('ERROR', `Failed to update trace registry: ${err}`);
    }
  }

  private resolveTraceForSession(
    sessionId: string,
    transcriptPath: string,
    sessionSource: string,
    envParentTraceId: string | undefined,
    envParentSpanId: string | undefined,
  ): TraceResolution {
    // Env-supplied parent trace context wins (parent Claude Code is injecting it).
    if (envParentTraceId && isValidTraceId(envParentTraceId)) {
      return {
        reuseTraceId: envParentTraceId.toLowerCase(),
        reuseSessionSpanId: envParentSpanId && isValidSpanId(envParentSpanId) ? envParentSpanId.toLowerCase() : undefined,
        source: 'env-parent',
      };
    }

    if (sessionSource === 'resume') {
      const bySession = this.traceRegistry.getBySessionId(sessionId);
      if (bySession) {
        return {
          reuseTraceId: bySession.traceId,
          reuseSessionSpanId: bySession.sessionSpanId,
          source: 'registry-session',
        };
      }

      const byTranscript = this.traceRegistry.getByTranscriptPath(transcriptPath);
      if (byTranscript) {
        return {
          reuseTraceId: byTranscript.traceId,
          reuseSessionSpanId: byTranscript.sessionSpanId,
          source: 'registry-transcript',
        };
      }
    }

    return { source: 'new' };
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
