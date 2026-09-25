// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { AssistantResponse } from './parser.js';
import {
  ATTR,
  buildUsage,
  contentBlocksToParts,
  parseTimestamp,
  providerFromModel,
} from './genaiSpans.js';
import type { SpanParent } from './genaiSpans.js';

type ChatOptions = {
  agentName?: string;
  /** Used by blockable/repeated stop hooks to emit each response once. */
  seen?: Set<string>;
  /** Recorded on the turn's first chat span; the root span exports only at turn close. */
  userMessage?: string;
};

function responseKey(response: AssistantResponse, index: number): string {
  return response.id
    ? `id:${response.id}:${index}`
    : `legacy:${response.startTime ?? ''}:${response.endTime ?? ''}:${index}`;
}

/** Emit one LLM span per normalized provider response. */
export function emitChatSpans(
  parent: SpanParent,
  responses: AssistantResponse[],
  options: ChatOptions = {},
): void {
  // A non-empty `seen` means an earlier span already carries the prompt.
  let userMessage = options.seen?.size ? undefined : options.userMessage;
  for (const [index, response] of responses.entries()) {
    const key = responseKey(response, index);
    if (!response.model || options.seen?.has(key)) continue;

    const provider = providerFromModel(response.model);
    const llm = parent.startLLM({
      model: response.model,
      ...(provider ? { providerName: provider } : {}),
      startTime: parseTimestamp(response.startTime ?? response.endTime) ?? new Date(),
    });
    const parts = contentBlocksToParts(response.content);
    llm.record({
      ...(userMessage
        ? { inputMessages: [{ role: 'user', parts: [{ type: 'text', content: userMessage }] }] }
        : {}),
      ...(parts.length ? { outputMessages: [{ role: 'assistant', parts }] } : {}),
      usage: buildUsage(response.usage, response.reasoningTokens),
      outputType: 'text',
      ...(response.id ? { responseId: response.id } : {}),
      ...(response.finishReason ? { finishReasons: [response.finishReason] } : {}),
    });
    if (options.agentName) llm.setAttributes({ [ATTR.AGENT_NAME]: options.agentName });
    llm.end({ endTime: parseTimestamp(response.endTime) ?? new Date() });
    options.seen?.add(key);
    userMessage = undefined;
  }
}
