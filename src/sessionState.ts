// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as path from 'path';
import * as weave from 'weave';
import { VERSION } from './setup.js';
import { parseSessionFd, extractAssistantTextBlocks, isTextBlock } from './parser.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import { sha256Hex } from './utils.js';
import { ATTR, buildIntegrationAttrs, addPermissionResolvedEvent } from './genaiSpans.js';
import type { CompactionAttrs } from './genaiSpans.js';

/** Stores the tool span opened at PreToolUse so PostToolUse can close it. */
export type PendingToolCall = {
  tool: weave.Tool;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** True once a PermissionRequest event has been emitted for this tool. */
  permissionRequested?: boolean;
}

type ActiveChat = {
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

export function hashPrompt(prompt: string): string {
  return sha256Hex(prompt);
}

export function subagentsDirFor(sessionTranscriptPath: string): string {
  const projectDir = path.dirname(sessionTranscriptPath);
  const sessionDirName = path.basename(sessionTranscriptPath, '.jsonl');
  return path.join(projectDir, sessionDirName, 'subagents');
}

export function computeSubagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  return path.join(subagentsDirFor(parentTranscriptPath), `agent-${agentId}.jsonl`);
}

export function extractUserMessageContent(line: Record<string, unknown> | undefined): string | undefined {
  if (!line || line['type'] !== 'user') return undefined;
  const msg = line['message'];
  if (!msg || typeof msg !== 'object') return undefined;
  const content = (msg as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter(isTextBlock).map(block => block.text);
    return parts.length > 0 ? parts.join('') : undefined;
  }
  return undefined;
}

export function lastAssistantTextEndsWith(
  result: NonNullable<ReturnType<typeof parseSessionFd>>,
  suffix: string,
): boolean {
  const call = result.turns.at(-1)?.assistantCalls().at(-1);
  if (!call) return false;
  return extractAssistantTextBlocks(call.contentBlocks).join('\n').trimEnd().endsWith(suffix);
}

export type LoadedInstruction = { filePath: string; content: string };

export function upsertInstruction(list: LoadedInstruction[], item: LoadedInstruction): void {
  const idx = list.findIndex((i) => i.filePath === item.filePath);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
}

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

export type SubagentTracker = {
  subagentType: string;
  detectedAt: Date;
  toolUseId?: string;
  subAgent?: weave.SubAgent;
  agentId?: string;
  promptHash?: string;
  ended?: boolean;
  transcriptPath?: string;
  pendingTeammateIdle?: boolean;
  teamName?: string;
}

export type TeamMember = {
  subAgent: weave.SubAgent;
  conversation: weave.Conversation;
  coordinatorTranscriptPath: string;
  emitted: boolean;
}

export type SessionState = {
  sessionId: string;
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel?: string;

  conversation?: weave.Conversation;

  currentTurn?: weave.Turn;

  pendingToolCalls: Map<string, PendingToolCall>;
  subagents: SubagentTracking;

  activeChat?: ActiveChat;
  emittedChatSpanResponseKeys: Set<string>;

  /** Compaction attrs buffered while no turn span is open. Drained on next UserPromptSubmit. */
  pendingCompaction?: CompactionAttrs;

  systemInstructions: LoadedInstruction[];
}

export class SubagentTracking {
  private trackers: SubagentTracker[] = [];

  /** Add a pending tracker at PreToolUse, before SubagentStart correlates an agent_id. */
  add(tracker: SubagentTracker): void {
    this.trackers.push(tracker);
  }

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

  findPendingTeammateIdle(subagentType: string): SubagentTracker | undefined {
    let best: SubagentTracker | undefined;
    for (const t of this.trackers) {
      if (!t.pendingTeammateIdle) continue;
      if (t.subagentType !== subagentType) continue;
      if (!best || t.detectedAt.getTime() < best.detectedAt.getTime()) best = t;
    }
    return best;
  }

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

type NewSessionStateOptions = {
  sessionId: string;
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel: string | undefined;
  agentName: string;
  tracingEnabled: boolean;
};

export function newSessionState(options: NewSessionStateOptions): SessionState {
  const { sessionId, conversationId, transcript, cwd, source, initialRequestModel } =
    options;
  // Preserve the Claude Code version when reconstructing a session.
  const headLine = readFirstTranscriptLine(transcript.resolvedPath);
  const version = headLine?.['version'];
  const claudeCodeAppVersion = typeof version === 'string' ? version : undefined;
  const integrationAttrs = buildIntegrationAttrs({
    version: VERSION,
    meta: { claude_code_app_version: claudeCodeAppVersion },
  });
  const conversation = options.tracingEnabled
    ? weave.startConversation({
        conversationId,
        agentName: options.agentName,
        attributes: { ...integrationAttrs, [ATTR.WEAVE_PLUGIN_VERSION]: VERSION },
      })
    : undefined;

  return {
    sessionId,
    conversationId,
    transcript,
    cwd,
    source,
    initialRequestModel,
    conversation,
    pendingToolCalls: new Map(),
    subagents: new SubagentTracking(),
    emittedChatSpanResponseKeys: new Set(),
    systemInstructions: [],
  };
}
