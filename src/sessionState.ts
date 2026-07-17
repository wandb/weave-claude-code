// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as path from 'path';
import * as weave from 'weave';
import { VERSION } from './setup.js';
import { parseSessionFd, extractAssistantTextBlocks, isTextBlock } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import { sha256Hex } from './utils.js';
import { buildIntegrationAttrs, addPermissionResolvedEvent } from './genaiSpans.js';
import type { CompactionAttrs } from './genaiSpans.js';

/** Stores the tool span opened at PreToolUse so PostToolUse can close it. */
export type PendingToolCall = {
  tool: weave.Tool;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** True once a PermissionRequest event has been emitted for this tool. */
  permissionRequested?: boolean;
}

/** Tracks the chat span (LLM) currently open for a single assistant API
 *  response. Tool spans the model called parent here so the trace tree shows
 *  them nested under the response. The response's text/thinking blocks become
 *  ordered `gen_ai.output.messages` parts on this span, set when it is
 *  finalized (at the next response transition or at Stop), once all its split
 *  transcript lines are present. */
type ActiveChat = {
  /** Response key (Anthropic `message.id`, or index fallback) this chat span
   *  represents; see `chatMessageKey`. */
  responseKey: string;
  llm: weave.LLM;
}

/** Emit `weave.permission_resolved` on a pending tool call's span, if one was requested. */
export function resolvePermissionIfPending(pending: PendingToolCall, approved: boolean): void {
  if (!pending.permissionRequested) return;
  addPermissionResolvedEvent(pending.tool, {
    approved,
    timestamp: new Date(),
  });
}

/** sha256 of the firing prompt — used to correlate an `Agent` PreToolUse with
 *  the subagent's SubagentStart by matching transcript content. */
export function hashPrompt(prompt: string): string {
  return sha256Hex(prompt);
}

/**
 * Directory holding a session's subagent transcripts. Claude Code writes them
 * as siblings of the session transcript in a `<session_id>/subagents/`
 * subdirectory:
 *   session:  <project_dir>/<session_id>.jsonl
 *   subagent: <project_dir>/<session_id>/subagents/agent-<agent_id>.jsonl
 */
export function subagentsDirFor(sessionTranscriptPath: string): string {
  const projectDir = path.dirname(sessionTranscriptPath);
  const sessionDirName = path.basename(sessionTranscriptPath, '.jsonl');
  return path.join(projectDir, sessionDirName, 'subagents');
}

/** Map a parent transcript path + subagent agent_id to the subagent's transcript file. */
export function computeSubagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  return path.join(subagentsDirFor(parentTranscriptPath), `agent-${agentId}.jsonl`);
}

/** Pull the user-message content out of a transcript line. Returns the prompt
 *  string for `{type: 'user', message: {content: string|Array}}` lines, else
 *  undefined. Array-form content is joined across text blocks. */
export function extractUserMessageContent(line: Record<string, unknown> | undefined): string | undefined {
  if (!line || line['type'] !== 'user') return undefined;
  const msg = line['message'];
  if (!msg || typeof msg !== 'object') return undefined;
  const content = (msg as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Keep every text block's text verbatim (including empties) and join with
    // '' (this differs from extractAssistantTextBlocks, which drops empties).
    const parts = content.filter(isTextBlock).map(block => block.text);
    return parts.length > 0 ? parts.join('') : undefined;
  }
  return undefined;
}

/** True if the last assistant call's joined text ends with `suffix`,
 *  ignoring trailing whitespace on either side. */
export function lastAssistantTextEndsWith(
  result: NonNullable<ReturnType<typeof parseSessionFd>>,
  suffix: string,
): boolean {
  const call = result.turns.at(-1)?.assistantCalls().at(-1);
  // Turn exists but parser saw no assistant calls (writer mid-flush).
  if (!call) return false;
  return extractAssistantTextBlocks(call.contentBlocks).join('\n').trimEnd().endsWith(suffix);
}

/** One instruction file surfaced by the `InstructionsLoaded` hook. Accumulated
 *  per session (deduped by path) and stamped as `gen_ai.system_instructions` on
 *  each turn root. */
export type LoadedInstruction = { filePath: string; content: string };

/** Append `item` to `list` in place, replacing any existing entry with the same
 *  filePath so a reloaded file (e.g. `load_reason=compact`) updates rather than
 *  duplicates. Preserves each file's first-seen position. */
export function upsertInstruction(list: LoadedInstruction[], item: LoadedInstruction): void {
  const idx = list.findIndex((i) => i.filePath === item.filePath);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
}

/** Read the subagent transcript's first line, retrying briefly because Claude
 *  Code may not have flushed it yet when SubagentStart fires. Total wait
 *  bounded by the sum of `RETRY_DELAYS_MS`. */
const SUBAGENT_TRANSCRIPT_RETRY_DELAYS_MS = [0, 50, 100, 150];
export async function readSubagentFirstLineWithRetry(
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
 * The subagent is its own `invoke_agent <subagent_type>` span under the parent
 * turn, and its chat/tool spans nest beneath it. (Why an `invoke_agent` marker
 * rather than an `execute_tool` span: see the Agent-dispatch branch in
 * `handlePreToolUse`.)
 */
export type SubagentTracker = {
  subagentType: string;
  detectedAt: Date;
  toolUseId?: string;          // tool_use_id of the spawning Agent tool (matched path only)
  subAgent?: weave.SubAgent;   // subagent's `invoke_agent` marker span; its chat/tool spans nest here
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
export type TeamMember = {
  subAgent: weave.SubAgent;
  /** Coordinator's Conversation handle. The teammate's own turn trace starts
   *  from it so the coordinator's conversation.id and integration identity
   *  (which don't inherit cross-session) seed the teammate's span subtree. */
  conversation: weave.Conversation;
  coordinatorTranscriptPath: string;
  emitted: boolean;
}

export type SessionState = {
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

  /** The session's Conversation handle. Seeds `gen_ai.conversation.id`, the
   *  agent identity, and the integration attributes (name, version, meta.*,
   *  built at session creation) onto every turn started from it — and, via
   *  the handle chain, onto all child spans. No ambient state involved, so
   *  events in separate `runIsolated` frames still inherit everything. Unset
   *  when tracing is disabled. */
  conversation?: weave.Conversation;

  currentTurn?: weave.Turn;

  turnNumber: number;
  totalToolCalls: number;
  turnToolCalls: number;
  toolCounts: Record<string, number>;

  pendingToolCalls: Map<string, PendingToolCall>;
  subagents: SubagentTracking;

  /** Chat span (LLM) currently open for an in-progress assistant API call.
   *  Tool spans from PreToolUse parent here; finalized at Stop or on transition
   *  to the next API call. Cleared at Stop. */
  activeChat?: ActiveChat;
  /** Response keys (see `chatMessageKey`) in the current turn for which a chat
   *  span has been opened (open or already finalized). Stop uses this to
   *  identify responses that need a chat span emitted from scratch (responses
   *  with no tool_use blocks never triggered PreToolUse). Reset per turn. */
  emittedChatSpanResponseKeys: Set<string>;

  /** Compaction attrs buffered while no turn span is open. Drained on next UserPromptSubmit. */
  pendingCompaction?: CompactionAttrs;

  /** Instruction files (global/project CLAUDE.md, .claude/rules, @-imports)
   *  captured from InstructionsLoaded, in load order, deduped by path. Stamped
   *  on every turn root as `gen_ai.system_instructions`. */
  systemInstructions: LoadedInstruction[];
}

/**
 * Per-session container that tracks subagents from PreToolUse (when an Agent
 * tool with subagent_type is detected) through SubagentStop. Single source of
 * truth for the tracker list, with intent-revealing lookup methods.
 */
export class SubagentTracking {
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

/** Options for {@link newSessionState}. `turnNumber` seeds the turn counter: 0
 *  for a brand-new session, or the number of turns already on disk when
 *  reconstructing a session lost across a daemon restart (so the resumed turn
 *  keeps counting up instead of resetting to 1). */
type NewSessionStateOptions = {
  sessionId: string;
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel: string | undefined;
  turnNumber: number;
  /** The top-level agent name the conversation (and thus every turn) carries. */
  agentName: string;
  /** When false (tracing disabled), no Conversation handle is created. */
  tracingEnabled: boolean;
};

/** Build a fresh SessionState, starting its Conversation when tracing is on. */
export function newSessionState(options: NewSessionStateOptions): SessionState {
  const { sessionId, conversationId, transcript, cwd, source, initialRequestModel, turnNumber } =
    options;
  // Claude Code stamps its CLI version on each transcript line; capture it
  // best-effort from the head line for the integration metadata. Absent when
  // the writer hasn't flushed yet, the meta key is simply omitted. Built
  // here (not at the SessionStart call site) so a session reconstructed after
  // a daemon restart carries the same integration identity on its spans.
  const headLine = readFirstTranscriptLine(transcript.resolvedPath);
  const version = headLine?.['version'];
  const claudeCodeAppVersion = typeof version === 'string' ? version : undefined;
  const integrationAttrs = buildIntegrationAttrs({
    version: VERSION,
    meta: { claude_code_app_version: claudeCodeAppVersion },
  });
  const conversation = options.tracingEnabled
    ? weave.startConversation({ conversationId, agentName: options.agentName, attributes: integrationAttrs })
    : undefined;

  return {
    sessionId,
    conversationId,
    transcript,
    cwd,
    source,
    initialRequestModel,
    conversation,
    turnNumber,
    totalToolCalls: 0,
    turnToolCalls: 0,
    toolCounts: {},
    pendingToolCalls: new Map(),
    subagents: new SubagentTracking(),
    emittedChatSpanResponseKeys: new Set(),
    systemInstructions: [],
  };
}
