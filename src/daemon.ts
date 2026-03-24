// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { init, WeaveClient } from 'weave';
import { uuidv7 } from 'uuidv7';
import { loadSettings } from './setup.js';
import { appendToLog, deepEqual } from './utils.js';
import { parseSessionFile } from './parser.js';

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

/** Stores the Weave call ID opened at PreToolUse so PostToolUse can close it. */
interface PendingToolCall {
  weaveCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionWeaveCallId?: string;   // set when PermissionRequest fires; closed in Post/PostFailure
  permissionStartedAt?: string;     // same value used as ended_at — zero-duration, tool execution time is not permission decision time
}

/**
 * Created when a Task tool with subagent_type is detected in PreToolUse.
 * agentId and subagentWeaveCallId are filled in when the matching SubagentStart event arrives.
 */
interface SubagentTracker {
  toolUseId: string;
  traceId: string;               // Shared trace ID for the whole session
  subagentType: string;
  detectedAt: Date;              // Used for temporal proximity matching at SubagentStart
  taskToolWeaveCallId: string;   // Weave call ID of the Agent tool itself (opened at PreToolUse)
  agentId?: string;              // Set when SubagentStart fires
  subagentWeaveCallId?: string;  // Weave call ID of the subagent call (opened at SubagentStart)
}

interface SessionState {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  traceId: string;

  // Weave call IDs
  sessionCallId?: string;
  currentTurnCallId?: string;

  // Tracking
  turnNumber: number;
  totalToolCalls: number;
  toolCounts: Record<string, number>;
  pendingToolCalls: Map<string, PendingToolCall>;

  // Subagent tracking (keyed by toolUseId; secondary index by agentId)
  subagentTrackers: Map<string, SubagentTracker>;
  subagentByAgentId: Map<string, SubagentTracker>;
}

// ─────────────────────────────────────────────────────────────────────────────
// GlobalDaemon
// ─────────────────────────────────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes
const CONNECTION_TIMEOUT_MS = 5_000;            // 5 seconds per connection

export class GlobalDaemon {
  private server?: net.Server;
  private running = false;
  private lastActivity = Date.now();
  private sessions = new Map<string, SessionState>();
  private sessionQueues = new Map<string, Promise<void>>();
  private weaveClient: WeaveClient | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly weaveProject: string | null,
    private readonly debugEnabled: boolean,
  ) {}

  async start(): Promise<void> {
    // Initialize Weave client if a project is configured
    if (this.weaveProject) {
      try {
        this.weaveClient = await init(this.weaveProject);
        this.log('INFO', `Weave initialized for project: ${this.weaveProject}`);
      } catch (err) {
        this.log('ERROR', `Failed to initialize Weave: ${err} — continuing without Weave`);
        this.weaveClient = null;
      }
    } else {
      this.log('INFO', 'No weave_project configured — Weave tracking disabled');
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

  // ── connection handling ───────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const chunks: Buffer[] = [];

    const timer = setTimeout(() => {
      this.log('ERROR', 'Connection timed out — closing');
      socket.destroy();
    }, CONNECTION_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.on('end', () => {
      clearTimeout(timer);
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

    const transcriptPath = payload['transcript_path'] as string | undefined;
    if (!transcriptPath || !GlobalDaemon.validateTranscriptPath(transcriptPath)) {
      this.log('ERROR', `Invalid or missing transcript_path for session ${sessionId}`);
      return;
    }

    this.sessions.set(sessionId, {
      sessionId,
      transcriptPath,
      cwd: (payload['cwd'] as string | undefined) ?? '',
      traceId: uuidv7(),
      turnNumber: 0,
      totalToolCalls: 0,
      toolCounts: {},
      pendingToolCalls: new Map(),
      subagentTrackers: new Map(),
      subagentByAgentId: new Map(),
    });

    this.log('INFO', `Session created: ${sessionId}`);
  }

  private async handleUserPromptSubmit(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log('ERROR', `Unknown session: ${sessionId}`);
      return;
    }

    const prompt = (payload['prompt'] as string | undefined) ?? '';

    // Create the top-level session call on the first turn
    if (!session.sessionCallId && this.weaveClient) {
      const callId = uuidv7();
      session.sessionCallId = callId;
      this.weaveClient.saveCallStart({
        project_id: this.weaveClient.projectId,
        id: callId,
        op_name: 'claude_code.session',
        trace_id: session.traceId,
        parent_id: null,
        started_at: new Date().toISOString(),
        display_name: `Claude Code: ${GlobalDaemon.promptSnippet(prompt)}`,
        inputs: { prompt },
        attributes: {
          kind: 'agent',
          session_id: session.sessionId,
          cwd: session.cwd,
        },
      });
      this.log('INFO', `Created session call: ${callId}`);
    }

    // Create a turn call for every prompt
    session.turnNumber += 1;
    const turnCallId = uuidv7();
    session.currentTurnCallId = turnCallId;

    if (this.weaveClient) {
      this.weaveClient.saveCallStart({
        project_id: this.weaveClient.projectId,
        id: turnCallId,
        op_name: 'claude_code.turn',
        trace_id: session.traceId,
        parent_id: session.sessionCallId ?? null,
        started_at: new Date().toISOString(),
        display_name: `Turn ${session.turnNumber}: ${GlobalDaemon.promptSnippet(prompt)}`,
        inputs: { prompt },
        attributes: { kind: 'llm' },
      });
      this.log('INFO', `Created turn call: ${turnCallId} (turn ${session.turnNumber})`);
    }
  }

  private async handlePreToolUse(sessionId: string, agentId: string | undefined, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.weaveClient) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    const toolName = payload['tool_name'] as string | undefined;
    if (!toolUseId || !toolName) return;

    const toolInput = (payload['tool_input'] ?? {}) as Record<string, unknown>;

    // For subagent tool calls, parent is the subagent's Weave call; otherwise the current turn.
    const parentId = agentId
      ? (session.subagentByAgentId.get(agentId)?.subagentWeaveCallId ?? null)
      : (session.currentTurnCallId ?? null);

    const weaveCallId = uuidv7();
    session.pendingToolCalls.set(toolUseId, { weaveCallId, toolName, toolInput });

    this.weaveClient.saveCallStart({
      project_id: this.weaveClient.projectId,
      id: weaveCallId,
      op_name: `claude_code.tool.${toolName}`,
      trace_id: session.traceId,
      parent_id: parentId,
      started_at: new Date().toISOString(),
      display_name: GlobalDaemon.toolDisplayName(toolName, toolInput),
      inputs: toolInput,
      attributes: { kind: 'tool', tool_use_id: toolUseId },
    });

    // Agent tools with subagent_type spawn subagents (parent session only). Record the Weave
    // call ID so handleSubagentStart can nest the subagent call underneath it.
    if (!agentId && toolName === 'Agent' && toolInput['subagent_type']) {
      const tracker: SubagentTracker = {
        toolUseId,
        traceId: session.traceId,
        subagentType: toolInput['subagent_type'] as string,
        detectedAt: new Date(),
        taskToolWeaveCallId: weaveCallId,
      };
      session.subagentTrackers.set(toolUseId, tracker);
    }
  }

  private async handlePermissionRequest(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.weaveClient) return;

    const toolName = payload['tool_name'] as string | undefined;
    if (!toolName) return;

    // Correlate to a pending tool call by tool_name + tool_input so we can close the
    // permission call with the approval outcome in PostToolUse / PostToolUseFailure.
    let pending: PendingToolCall | undefined;
    for (const call of session.pendingToolCalls.values()) {
      if (call.toolName === toolName && !call.permissionWeaveCallId && deepEqual(call.toolInput, payload['tool_input'])) {
        pending = call;
        break;
      }
    }
    if (!pending) {
      this.log('DEBUG', `PermissionRequest: no pending tool call for tool_name=${toolName}`);
      return;
    }

    const permCallId = uuidv7();
    const permStartedAt = new Date().toISOString();
    pending.permissionWeaveCallId = permCallId;
    pending.permissionStartedAt = permStartedAt;

    this.weaveClient.saveCallStart({
      project_id: this.weaveClient.projectId,
      id: permCallId,
      op_name: 'claude_code.permission_request',
      trace_id: session.traceId,
      parent_id: pending.weaveCallId,
      started_at: permStartedAt,
      display_name: `Permission: ${toolName}`,
      inputs: {
        tool_name: toolName,
        tool_input: payload['tool_input'],
        permission_suggestions: payload['permission_suggestions'],
      },
      attributes: { kind: 'tool' },
    });

    this.log('DEBUG', `Permission request for ${toolName}`);
  }

  private async handlePostToolUse(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.weaveClient) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    if (!toolUseId) return;

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    const now = new Date().toISOString();

    if (pending.permissionWeaveCallId) {
      this.weaveClient.saveCallEnd({
        project_id: this.weaveClient.projectId,
        id: pending.permissionWeaveCallId,
        ended_at: pending.permissionStartedAt!,
        output: { approved: true },
        summary: {},
      });
    }

    this.weaveClient.saveCallEnd({
      project_id: this.weaveClient.projectId,
      id: pending.weaveCallId,
      ended_at: now,
      output: { result: payload['tool_response'] },
      summary: {},
    });

    session.pendingToolCalls.delete(toolUseId);
    session.totalToolCalls += 1;
    session.toolCounts[pending.toolName] = (session.toolCounts[pending.toolName] ?? 0) + 1;
  }

  private async handlePostToolUseFailure(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.weaveClient) return;

    const toolUseId = payload['tool_use_id'] as string | undefined;
    if (!toolUseId) return;

    const pending = session.pendingToolCalls.get(toolUseId);
    if (!pending) return;

    const now = new Date().toISOString();

    if (pending.permissionWeaveCallId) {
      this.weaveClient.saveCallEnd({
        project_id: this.weaveClient.projectId,
        id: pending.permissionWeaveCallId,
        ended_at: pending.permissionStartedAt!,
        output: { approved: false },
        summary: {},
      });
    }

    this.weaveClient.saveCallEnd({
      project_id: this.weaveClient.projectId,
      id: pending.weaveCallId,
      ended_at: now,
      output: { error: payload['error'] ?? payload['tool_response'] },
      summary: { is_error: true },
    });

    session.pendingToolCalls.delete(toolUseId);
    session.totalToolCalls += 1;
    session.toolCounts[pending.toolName] = (session.toolCounts[pending.toolName] ?? 0) + 1;
  }

  private async handleSubagentStart(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.weaveClient) return;

    const agentId = payload['agent_id'] as string | undefined;
    if (!agentId) return;

    // Temporal proximity matching: find the closest unmatched SubagentTracker within 5 s.
    // SubagentStart has no explicit parent pointer, so we correlate by timing.
    const PROXIMITY_MS = 5_000;
    const now = Date.now();
    let bestTracker: SubagentTracker | undefined;
    let bestDelta = Infinity;

    for (const tracker of session.subagentTrackers.values()) {
      if (tracker.agentId) continue; // already matched
      const delta = now - tracker.detectedAt.getTime();
      if (delta >= 0 && delta < PROXIMITY_MS && delta < bestDelta) {
        bestDelta = delta;
        bestTracker = tracker;
      }
    }

    const agentType = (payload['agent_type'] as string | undefined) ?? 'unknown';

    if (!bestTracker) {
      // No matching Agent tool call — create an orphan tracker parented to the turn.
      this.log('ERROR', `SubagentStart: no unmatched tracker for agentId=${agentId}, parenting to turn`);
      bestTracker = {
        toolUseId: agentId,
        traceId: session.traceId,
        subagentType: agentType,
        detectedAt: new Date(),
        taskToolWeaveCallId: session.currentTurnCallId ?? '',
        agentId,
      };
      session.subagentTrackers.set(agentId, bestTracker);
    }

    const subagentWeaveCallId = uuidv7();
    bestTracker.agentId = agentId;
    bestTracker.subagentWeaveCallId = subagentWeaveCallId;
    session.subagentByAgentId.set(agentId, bestTracker);

    this.weaveClient.saveCallStart({
      project_id: this.weaveClient.projectId,
      id: subagentWeaveCallId,
      op_name: `claude_code.subagent.${bestTracker.subagentType}`,
      trace_id: bestTracker.traceId,
      parent_id: bestTracker.taskToolWeaveCallId,
      started_at: new Date().toISOString(),
      display_name: bestTracker.subagentType,
      inputs: { subagent_type: bestTracker.subagentType },
      attributes: { kind: 'agent', agent_id: agentId },
    });

    this.log('INFO', `Subagent started: agentId=${agentId} type=${agentType} matched=${bestTracker.toolUseId !== agentId}`);
  }

  private async handleSubagentStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.weaveClient) return;

    const agentId = payload['agent_id'] as string | undefined;
    if (!agentId) return;

    const tracker = session.subagentByAgentId.get(agentId);
    if (!tracker?.subagentWeaveCallId) {
      this.log('ERROR', `SubagentStop: no tracker for agentId=${agentId}`);
      return;
    }

    this.weaveClient.saveCallEnd({
      project_id: this.weaveClient.projectId,
      id: tracker.subagentWeaveCallId,
      ended_at: new Date().toISOString(),
      output: { reason: (payload['reason'] as string | undefined) ?? '' },
      summary: {},
    });

    this.log('DEBUG', `Subagent stopped: agentId=${agentId} type=${tracker.subagentType} wall_clock=${Date.now() - tracker.detectedAt.getTime()}ms`);

    session.subagentTrackers.delete(tracker.toolUseId);
    session.subagentByAgentId.delete(agentId);
  }

  private async handleStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentTurnCallId || !this.weaveClient) return;

    // Parse transcript for usage + model (not available in hook payloads).
    // Retry up to 3 times — the file may still be flushing when Stop fires.
    const parsedSession = await this.parseSessionFileWithRetry(session.transcriptPath);
    const currentTurn = parsedSession?.turns[parsedSession.turns.length - 1];
    const usage = currentTurn?.totalUsage();
    const model = currentTurn?.primaryModel();

    // Weave expects summary.usage keyed by model name: { "model-name": { input_tokens, output_tokens } }
    const usageSummary = usage && model ? { [model]: usage } : {};

    this.weaveClient.saveCallEnd({
      project_id: this.weaveClient.projectId,
      id: session.currentTurnCallId,
      ended_at: new Date().toISOString(),
      output: { assistant_message: (payload['last_assistant_message'] as string | undefined) ?? '' },
      summary: { usage: usageSummary, tool_count: session.totalToolCalls },
    });

    this.log('INFO', `Finished turn ${session.turnNumber} (${session.totalToolCalls} tools)`);
  }

  private async handleSessionEnd(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.sessionCallId && this.weaveClient) {
      this.weaveClient.saveCallEnd({
        project_id: this.weaveClient.projectId,
        id: session.sessionCallId,
        ended_at: new Date().toISOString(),
        output: { reason: (payload['reason'] as string | undefined) ?? '' },
        summary: {
          turn_count: session.turnNumber,
          tool_count: session.totalToolCalls,
          tool_counts: session.toolCounts,
        },
      });
      this.log('INFO', `Finished session ${sessionId}`);
    }

    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
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
    if (this.weaveClient) {
      try {
        await this.weaveClient.waitForBatchProcessing();
      } catch (err) {
        this.log('ERROR', `Error flushing Weave batch: ${err}`);
      }
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    process.exit(0);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Truncate a prompt to a readable display name, collapsing whitespace. */
  private static promptSnippet(prompt: string, maxLen = 60): string {
    const oneLine = prompt.replace(/\s+/g, ' ').trim();
    return oneLine.length <= maxLen ? oneLine : oneLine.slice(0, maxLen - 1) + '…';
  }

  /** Build a human-readable display name for a tool call, e.g. "Read: src/foo.ts". */
  private static toolDisplayName(toolName: string, input: Record<string, unknown>): string {
    const s = (v: unknown) => GlobalDaemon.promptSnippet(String(v ?? ''), 60);
    switch (toolName) {
      case 'Read':
      case 'Edit':
      case 'Write':        return `${toolName}: ${s(input['file_path'])}`;
      case 'Glob':         return `Glob: ${s(input['pattern'])}`;
      case 'Grep':         return `Grep: ${s(input['pattern'])}`;
      case 'Bash':         return `Bash: ${s(input['command'])}`;
      case 'Agent':        return `Agent: ${s(input['description'] ?? input['subagent_type'])}`;
      case 'WebFetch':     return `WebFetch: ${s(input['url'])}`;
      case 'WebSearch':    return `WebSearch: ${s(input['query'])}`;
      default: {
        const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
        return first ? `${toolName}: ${GlobalDaemon.promptSnippet(first, 60)}` : toolName;
      }
    }
  }

  /** Retry parseSessionFile up to `attempts` times with `delayMs` between each.
   *  The transcript file may still be flushing when Stop fires. */
  private async parseSessionFileWithRetry(
    transcriptPath: string,
    attempts = 3,
    delayMs = 500,
  ): Promise<ReturnType<typeof parseSessionFile>> {
    for (let i = 0; i < attempts; i++) {
      const result = parseSessionFile(transcriptPath);
      if (result?.turns.length) return result;
      if (i < attempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return parseSessionFile(transcriptPath);
  }

  private enqueueForSession(sessionId: string, fn: () => Promise<void>): void {
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => this.log('ERROR', `Queue error for session ${sessionId}: ${err}`));
    this.sessionQueues.set(sessionId, next);
  }

  private log(level: 'DEBUG' | 'INFO' | 'ERROR', msg: string): void {
    if (level === 'DEBUG' && !this.debugEnabled) return;
    appendToLog(this.logFile, level, msg);
  }

  /** Validate that a transcript path is within the user's home directory. */
  static validateTranscriptPath(transcriptPath: string): boolean {
    try {
      return path.resolve(transcriptPath).startsWith(os.homedir() + path.sep);
    } catch {
      return false;
    }
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

  if (!weaveProject || !apiKey) {
    const missing = [!weaveProject && 'weave_project', !apiKey && 'WANDB_API_KEY'].filter(Boolean).join(', ');
    appendToLog(logFile, 'INFO', `Daemon not started — missing configuration: ${missing}`);
    process.exit(0);
  }

  // Ensure the Weave SDK sees the API key regardless of whether it came from
  // settings.json or was already in the environment.
  process.env['WANDB_API_KEY'] = apiKey;

  const debugEnabled = !!process.env['WEAVE_CLAUDE_DEBUG'] || settings.debug === true;
  const daemon = new GlobalDaemon(socketPath, logFile, weaveProject, debugEnabled);

  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
