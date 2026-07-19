// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as weave from 'weave';
import type { AssistantCallDetail } from './parser.js';
import { isToolUseBlock } from './parser.js';
import {
  ATTR,
  buildUsage,
  contentBlocksToParts,
  providerFromModel,
  parseTimestamp,
} from './genaiSpans.js';

/** Stable identity for an assistant API call within a turn. Anthropic returns
 *  a `message.id` on every response; that's the primary key. When it's
 *  missing (legacy transcripts), fall back to the index, which is stable
 *  within a single parse + turn. */
export function chatMessageKey(call: AssistantCallDetail, callIdx: number): string {
  return call.responseId ?? `idx:${callIdx}`;
}

/** All calls belonging to one assistant API response, in transcript order.
 *  Claude Code splits a single response's thinking / text / tool_use blocks
 *  across separate transcript lines that share a `message.id`; the parser maps
 *  each line to its own `AssistantCallDetail`, so this regroups them by key. */
export function callsForResponseKey(
  calls: AssistantCallDetail[],
  key: string,
): AssistantCallDetail[] {
  const group: AssistantCallDetail[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (chatMessageKey(calls[i], i) === key) group.push(calls[i]);
  }
  return group;
}

/** Find the response key of the assistant call whose content contains a
 *  `tool_use` block with `toolUseId`, or undefined if not found (transcript
 *  not flushed yet, or unknown id). */
export function findToolUseResponseKey(
  calls: AssistantCallDetail[],
  toolUseId: string,
): string | undefined {
  for (let ci = 0; ci < calls.length; ci++) {
    for (const block of calls[ci].contentBlocks) {
      if (isToolUseBlock(block) && block.id === toolUseId) {
        return chatMessageKey(calls[ci], ci);
      }
    }
  }
  return undefined;
}

export function parseIsoOrNow(ts: string | undefined): Date {
  return parseTimestamp(ts) ?? new Date();
}

/**
 * Open a chat (LLM) span under a turn or subagent for one response `group`,
 * deriving the provider and backdating the start to the first call's request
 * time. Returns undefined when no call in the group has a model yet
 * (LLMInit.model is required), so the caller can fall back to the turn span
 * and emit the chat span later once the model has flushed.
 */
export function openChatForGroup(parent: weave.Turn | weave.SubAgent, group: AssistantCallDetail[]): weave.LLM | undefined {
  const model = group.map(c => c.model).find(Boolean);
  if (!model) return undefined;
  const provider = providerFromModel(model);
  return parent.startLLM({
    model,
    ...(provider ? { providerName: provider } : {}),
    startTime: parseIsoOrNow(group[0].prevTimestamp ?? group[0].timestamp),
  });
}

/**
 * Populate a chat (LLM) span from the assistant calls of one response, then end
 * it. Split lines share the response's usage, so take it once from the last line
 * (which carries stop_reason), not summed. `agentName` tags the span so the
 * subagent's/teammate's calls stay queryable by agent; conversation.id is
 * inherited from the parent handle chain.
 */
export function recordChat(
  llm: weave.LLM,
  group: AssistantCallDetail[],
  agentName?: string,
): void {
  const last = group.at(-1)!;
  const parts = contentBlocksToParts(group.flatMap(c => c.contentBlocks));
  const finishReason = group.map(c => c.finishReason).find(Boolean);
  llm.record({
    ...(parts.length ? { outputMessages: [{ role: 'assistant', parts }] } : {}),
    usage: buildUsage(last.usage, last.reasoningTokens),
    outputType: 'text',
    ...(last.responseId ? { responseId: last.responseId } : {}),
    ...(finishReason ? { finishReasons: [finishReason] } : {}),
  });
  // agent.name isn't on record()'s surface, so set it directly.
  if (agentName) llm.setAttributes({ [ATTR.AGENT_NAME]: agentName });
  llm.end({ endTime: parseIsoOrNow(last.timestamp) });
}
