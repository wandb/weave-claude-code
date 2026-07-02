// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as weave from 'weave';
import type { Attributes } from '@opentelemetry/api';
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

/** Open a chat (LLM) span under `turn` for `model`, deriving the provider. */
export function startChat(turn: weave.Turn, model: string, startTime: Date): weave.LLM {
  const provider = providerFromModel(model);
  return turn.startLLM({ model, ...(provider ? { providerName: provider } : {}), startTime });
}

/**
 * Open a chat (LLM) span for one response `group`, backdating its start to the
 * first call's request time. Returns undefined when no call in the group has a
 * model yet (LLMInit.model is required), so the caller can fall back to the turn
 * span and emit the chat span later once the model has flushed.
 */
export function openChatForGroup(turn: weave.Turn, group: AssistantCallDetail[]): weave.LLM | undefined {
  const model = group.map(c => c.model).find(Boolean);
  if (!model) return undefined;
  return startChat(turn, model, parseIsoOrNow(group[0].prevTimestamp ?? group[0].timestamp));
}

/**
 * Populate a chat (LLM) span from the assistant calls that make up one response,
 * then end it. Split transcript lines share the response's usage, so it is taken
 * once from the last line (which also carries the stop_reason), not summed.
 * `agentName`, when set, tags the span so the Agents view groups a
 * subagent's/teammate's calls under that agent.
 */
export function recordChat(
  llm: weave.LLM,
  group: AssistantCallDetail[],
  conversationId: string,
  agentName?: string,
): void {
  const last = group.at(-1)!;
  const parts = contentBlocksToParts(group.flatMap(c => c.contentBlocks));
  if (parts.length) llm.outputMessages = [{ role: 'assistant', parts }];
  llm.usage = buildUsage(last.usage, last.reasoningTokens);
  const attrs: Attributes = { [ATTR.CONVERSATION_ID]: conversationId, [ATTR.OUTPUT_TYPE]: 'text' };
  if (agentName) attrs[ATTR.AGENT_NAME] = agentName;
  if (last.responseId) attrs[ATTR.RESPONSE_ID] = last.responseId;
  const finishReason = group.map(c => c.finishReason).find(Boolean);
  if (finishReason) attrs[ATTR.RESPONSE_FINISH_REASONS] = [finishReason];
  llm.setAttributes(attrs);
  llm.end({ endTime: parseIsoOrNow(last.timestamp) });
}
