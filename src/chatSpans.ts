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

/** Response `message.id`, or the call index for legacy transcripts without ids. */
export function chatMessageKey(call: AssistantCallDetail, callIdx: number): string {
  return call.responseId ?? `idx:${callIdx}`;
}

/** All calls of one assistant response, in transcript order: Claude Code
 *  splits a response across transcript lines sharing a `message.id`. */
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

/** Response key of the call carrying `tool_use` block `toolUseId`; undefined if unflushed. */
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

/** Open a chat (LLM) span backdated to the request start; undefined until a
 *  call in the group has a model (LLMInit requires one). */
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

/** Populate a chat span from one response's calls, then end it. Split lines share
 *  the response's usage: take the last line's (has stop_reason), don't sum. */
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
