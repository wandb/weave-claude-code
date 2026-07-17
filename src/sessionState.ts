// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Session-scoped helpers shared by the daemon's hook handlers. Moved verbatim
// from daemon.ts; no behavior change.

import * as path from 'path';
import type { Baggage } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { VERSION } from './setup.js';
import { parseSessionFd, extractAssistantTextBlocks } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import { addPermissionResolvedEvent, createIntegrationBaggage } from './genaiSpans.js';
import type { CompactionAttrs } from './genaiSpans.js';
import { sha256Hex } from './utils.js';

/** Stores the tool span opened at PreToolUse so PostToolUse can close it. */
export type PendingToolCall = {
  span: Span;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** True once a PermissionRequest event has been emitted for this tool. */
  permissionRequested?: boolean;
}

/** The chat span open for the in-flight assistant response; its tool spans
 *  parent here. Content lands when it is finalized (next response transition,
 *  or Stop), once all its transcript lines are flushed. */
type ActiveChatSpan = {
  /** Response key (Anthropic `message.id`, or index fallback) this chat span
   *  represents; see `chatMessageKey`. */
  responseKey: string;
  span: Span;
}

/** Emit `weave.permission_resolved` on a pending tool call's span, if one was requested. */
export function resolvePermissionIfPending(pending: PendingToolCall, approved: boolean): void {
  if (!pending.permissionRequested) return;
  addPermissionResolvedEvent(pending.span, {
    approved,
    timestamp: new Date(),
  });
}

/**
 * Tracks a subagent across hook events. Matched trackers are created at
 * PreToolUse(Agent) and correlated to an agent_id at SubagentStart by
 * sha256(firing prompt) + type; orphans are created at SubagentStart when
 * nothing matches. Either way the subagent is its own `invoke_agent` span
 * under the turn (why a marker and not `execute_tool`: see the daemon's
 * Agent-dispatch branch).
 */
export type SubagentTracker = {
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
  /** Stored at SubagentStart; TeammateIdle's own transcript_path is the
   *  coordinator's, so this is the reliable copy. */
  transcriptPath?: string;
  /** Orphan awaiting TeammateIdle: SubagentStop leaves the span open so
   *  TeammateIdle can close it with full all-turns content. */
  pendingTeammateIdle?: boolean;
  /** Set for `team_name` spawns: the span is owned by
   *  GlobalDaemon.teamMembers and closed at the teammate's TeammateIdle,
   *  NOT at the coordinator's PostToolUse(Agent). */
  teamName?: string;
}

/** One queued team-member spawn. A teammate is an independent session whose
 *  TeammateIdle fires under its OWN session_id, so the coordinator's
 *  PreToolUse(Agent, team_name) is the only reliable anchor: it queues the
 *  span in GlobalDaemon.teamMembers (FIFO per `${team}::${name}`; the same
 *  name can be re-spawned, and overwriting would leak the first, still-open
 *  span). */
export type TeamMember = {
  invokeAgentSpan: Span;
  conversationId: string;
  coordinatorTranscriptPath: string;
  emitted: boolean;
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
  /** Integration identity (name, version, meta.*) as OTel Baggage, built once
   *  at SessionStart. Activated for every event in `routeEvent` so each span
   *  inherits it via `IntegrationBaggageSpanProcessor`. */
  integrationBaggage: Baggage;

  currentTurnSpan?: Span;

  turnNumber: number;
  totalToolCalls: number;
  turnToolCalls: number;
  toolCounts: Record<string, number>;

  pendingToolCalls: Map<string, PendingToolCall>;
  subagents: SubagentTracking;

  /** Chat span currently open for an in-progress assistant API call. Tool
   *  spans from PreToolUse parent here; finalized at Stop or on transition
   *  to the next API call. Cleared at Stop. */
  activeChatSpan?: ActiveChatSpan;
  /** Response keys with a chat span already opened this turn; Stop emits
   *  fresh spans for the rest (tool-less responses never hit PreToolUse). */
  emittedChatSpanResponseKeys: Set<string>;

  /** Compaction attrs buffered while no turn span is open. Drained on next UserPromptSubmit. */
  pendingCompaction?: CompactionAttrs;

  /** Instruction files from InstructionsLoaded, in load order, deduped by
   *  path; stamped on every turn root as `gen_ai.system_instructions`. */
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

  /** Oldest unmatched tracker (no agent_id yet) for `(promptHash, type)`;
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

  /** Oldest tracker awaiting TeammateIdle for this subagentType (FIFO). */
  findPendingTeammateIdle(subagentType: string): SubagentTracker | undefined {
    let best: SubagentTracker | undefined;
    for (const t of this.trackers) {
      if (!t.pendingTeammateIdle) continue;
      if (t.subagentType !== subagentType) continue;
      if (!best || t.detectedAt.getTime() < best.detectedAt.getTime()) best = t;
    }
    return best;
  }

  /** Lookup by the spawning Agent tool's tool_use_id (PostToolUse settle). */
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
};

/** Build a fresh SessionState. */
export function newSessionState(options: NewSessionStateOptions): SessionState {
  const { sessionId, conversationId, transcript, cwd, source, initialRequestModel, turnNumber } =
    options;
  // Best-effort CC CLI version from the transcript head line; built here so a
  // reconstructed session carries the same integration identity.
  const headLine = readFirstTranscriptLine(transcript.resolvedPath);
  const version = headLine?.['version'];
  const claudeCodeAppVersion = typeof version === 'string' ? version : undefined;
  const integrationBaggage = createIntegrationBaggage({
    version: VERSION,
    meta: { claude_code_app_version: claudeCodeAppVersion },
  });

  return {
    sessionId,
    conversationId,
    transcript,
    cwd,
    source,
    initialRequestModel,
    integrationBaggage,
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

/** sha256 of the firing prompt — used to correlate an `Agent` PreToolUse with
 *  the subagent's SubagentStart by matching transcript content. */
export function hashPrompt(prompt: string): string {
  return sha256Hex(prompt);
}

/**
 * Map a parent transcript path + subagent agent_id to the subagent's transcript
 * file. Claude Code writes subagent transcripts as siblings of the parent in a
 * `<session_id>/subagents/` subdirectory:
 *   parent:   <project_dir>/<session_id>.jsonl
 *   subagent: <project_dir>/<session_id>/subagents/agent-<agent_id>.jsonl
 */
export function computeSubagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  const projectDir = path.dirname(parentTranscriptPath);
  const sessionDirName = path.basename(parentTranscriptPath, '.jsonl');
  return path.join(projectDir, sessionDirName, 'subagents', `agent-${agentId}.jsonl`);
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
export function lastAssistantTextEndsWith(
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
