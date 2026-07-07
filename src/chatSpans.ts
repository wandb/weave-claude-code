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
 * Populate a chat (LLM) span from the assistant calls of one response, then end
 * it. Split lines share the response's usage, so take it once from the last line
 * (which carries stop_reason), not summed. `agentName` tags the span so the
 * Agents view groups a subagent's/teammate's calls under it; conversation.id is
 * inherited from the parent turn.
 */
export function recordChat(
  llm: weave.LLM,
  group: AssistantCallDetail[],
  conversationId: string,
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
  // agent.name, and conversation.id for cross-session teammate spans (no ambient
  // conversation to inherit from), aren't on record()'s surface — set directly.
  const attrs: Attributes = { [ATTR.CONVERSATION_ID]: conversationId };
  if (agentName) attrs[ATTR.AGENT_NAME] = agentName;
  llm.setAttributes(attrs);
  llm.end({ endTime: parseIsoOrNow(last.timestamp) });
}
