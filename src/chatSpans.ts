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
      ...(parts.length ? { outputMessages: [{ role: 'assistant', parts }] } : {}),
      usage: buildUsage(response.usage, response.reasoningTokens),
      outputType: 'text',
      ...(response.id ? { responseId: response.id } : {}),
      ...(response.finishReason ? { finishReasons: [response.finishReason] } : {}),
    });
    if (options.agentName) llm.setAttributes({ [ATTR.AGENT_NAME]: options.agentName });
    llm.end({ endTime: parseTimestamp(response.endTime) ?? new Date() });
    options.seen?.add(key);
  }
}
