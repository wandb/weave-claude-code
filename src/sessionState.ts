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

/** The chat span (LLM) open for one assistant response; its tool spans parent
 *  here. Ordered `gen_ai.output.messages` parts land at finalize (next response
 *  or Stop), once all the response's split transcript lines are present. */
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

/** sha256 of the firing prompt, used to correlate an `Agent` PreToolUse with
 *  the subagent's SubagentStart by matching transcript content. */
export function hashPrompt(prompt: string): string {
  return sha256Hex(prompt);
}

/** A session's subagent-transcript directory, sibling of the session transcript:
 *  <project_dir>/<session_id>/subagents/. */
export function subagentsDirFor(sessionTranscriptPath: string): string {
  const projectDir = path.dirname(sessionTranscriptPath);
  const sessionDirName = path.basename(sessionTranscriptPath, '.jsonl');
  return path.join(projectDir, sessionDirName, 'subagents');
}

/** Map a parent transcript path + subagent agent_id to the subagent's transcript file. */
export function computeSubagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  return path.join(subagentsDirFor(parentTranscriptPath), `agent-${agentId}.jsonl`);
}

/** User-message content of a `{type: 'user'}` transcript line, else undefined;
 *  array-form content joins across text blocks. */
export function extractUserMessageContent(line: Record<string, unknown> | undefined): string | undefined {
  if (!line || line['type'] !== 'user') return undefined;
  const msg = line['message'];
  if (!msg || typeof msg !== 'object') return undefined;
  const content = (msg as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Join text blocks verbatim, keeping empties (unlike extractAssistantTextBlocks).
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

/** One instruction file from the `InstructionsLoaded` hook, deduped by path;
 *  propagated to every turn root as `gen_ai.system_instructions`. */
export type LoadedInstruction = { filePath: string; content: string };

/** Append `item`, or replace the entry with the same filePath (a reload updates
 *  in place), preserving first-seen order. */
export function upsertInstruction(list: LoadedInstruction[], item: LoadedInstruction): void {
  const idx = list.findIndex((i) => i.filePath === item.filePath);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
}

/** First line of the subagent transcript, retrying briefly (Claude Code may not
 *  have flushed it yet when SubagentStart fires). */
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

/** Tracks a subagent (its own `invoke_agent` span under the turn). Matched:
 *  created at PreToolUse, `agentId` filled at SubagentStart by sha256(prompt) +
 *  type. Orphan: created at SubagentStart when nothing matches. (Marker, not
 *  execute_tool: see handlePreToolUse's Agent-dispatch branch.) */
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
  /** Stored at SubagentStart; the TeammateIdle payload carries the coordinator's
   *  transcript_path, so this is the reliable copy. */
  transcriptPath?: string;
  /** Orphan awaiting TeammateIdle: SubagentStop leaves the span open so
   *  TeammateIdle can close it with full all-turns content. */
  pendingTeammateIdle?: boolean;
  /** Set for `team_name` spawns: the marker is owned by GlobalDaemon.teamMembers
   *  and closed at the teammate's TeammateIdle, not at PostToolUse(Agent). */
  teamName?: string;
}

/** Cross-session team correlation: a teammate runs as its own session, so its
 *  TeammateIdle fires under a different session_id and the per-session lookup
 *  misses; the coordinator's PreToolUse(Agent, team_name) is the anchor. FIFO
 *  per `${team_name}::${name}` so re-spawns don't overwrite a live span. */
export type TeamMember = {
  subAgent: weave.SubAgent;
  /** Coordinator's Conversation handle; seeds conversation.id + integration
   *  identity (which don't inherit cross-session) onto the teammate's subtree. */
  conversation: weave.Conversation;
  coordinatorTranscriptPath: string;
  emitted: boolean;
}

export type SessionState = {
  sessionId: string;
  /** Root ancestor's session id (= `gen_ai.conversation.id`) so resumed turns
   *  stitch with their pre-resume turns; equals `sessionId` for fresh sessions. */
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel?: string;

  /** Conversation handle; seeds conversation.id, agent identity, and integration
   *  attrs onto every turn and (via the handle chain, no ambient state) all child
   *  spans, even across `runIsolated` frames. Unset when tracing is disabled. */
  conversation?: weave.Conversation;

  currentTurn?: weave.Turn;

  turnNumber: number;
  totalToolCalls: number;
  turnToolCalls: number;
  toolCounts: Record<string, number>;

  pendingToolCalls: Map<string, PendingToolCall>;
  subagents: SubagentTracking;

  /** Chat span (LLM) open for the in-progress assistant call; tool spans parent
   *  here. Finalized (and cleared) at Stop, or on transition to the next call. */
  activeChat?: ActiveChat;
  /** Response keys already given a chat span this turn; Stop emits spans for the
   *  rest (responses with no tool_use never hit PreToolUse). Reset per turn. */
  emittedChatSpanResponseKeys: Set<string>;

  /** Compaction attrs buffered while no turn span is open. Drained on next UserPromptSubmit. */
  pendingCompaction?: CompactionAttrs;

  /** Instruction files from InstructionsLoaded, in load order, deduped by path;
   *  propagated to every turn root as `gen_ai.system_instructions`. */
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

  /** Oldest unmatched tracker (no agent_id yet) for (promptHash, subagentType);
   *  FIFO so back-to-back identical Agent calls correlate in dispatch order. */
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

  /** Oldest tracker awaiting TeammateIdle with this subagentType (FIFO). */
  findPendingTeammateIdle(subagentType: string): SubagentTracker | undefined {
    let best: SubagentTracker | undefined;
    for (const t of this.trackers) {
      if (!t.pendingTeammateIdle) continue;
      if (t.subagentType !== subagentType) continue;
      if (!best || t.detectedAt.getTime() < best.detectedAt.getTime()) best = t;
    }
    return best;
  }

  /** Lookup by the spawning Agent call's tool_use_id; at PostToolUse the Agent
   *  call has an invoke_agent marker, not a pendingToolCalls entry. */
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
  // Best-effort CC CLI version from the transcript head line; built here so a
  // reconstructed session carries the same integration identity.
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
