// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitChatSpans } from '../src/chatSpans.ts';
import { ATTR } from '../src/genaiSpans.ts';
import type { SpanParent } from '../src/genaiSpans.ts';
import type { AssistantResponse } from '../src/parser.ts';

type StartedChat = {
  init: unknown;
  record?: unknown;
  attributes?: unknown;
  end?: unknown;
};

test('emits each normalized response once without regrouping its content', () => {
  const started: StartedChat[] = [];
  const parent = {
    startLLM(init: unknown) {
      const chat: StartedChat = { init };
      started.push(chat);
      return {
        record(value: unknown) { chat.record = value; },
        setAttributes(value: unknown) { chat.attributes = value; },
        end(value: unknown) { chat.end = value; },
      };
    },
  } as unknown as SpanParent;
  const response: AssistantResponse = {
    id: 'msg-a',
    model: 'claude-opus-4-8',
    startTime: '2026-01-01T00:00:01.000Z',
    endTime: '2026-01-01T00:00:02.000Z',
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
    reasoningTokens: 3,
    content: [
      { type: 'thinking', thinking: 'considering' },
      { type: 'text', text: 'editing' },
      { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: '/x' } },
    ],
    finishReason: 'tool_use',
  };
  const seen = new Set<string>();

  emitChatSpans(parent, [response], { agentName: 'researcher', seen });
  emitChatSpans(parent, [response], { agentName: 'researcher', seen });

  assert.equal(started.length, 1);
  assert.deepEqual(started[0].init, {
    model: 'claude-opus-4-8',
    providerName: 'anthropic',
    startTime: new Date('2026-01-01T00:00:01.000Z'),
  });
  assert.deepEqual(started[0].record, {
    outputMessages: [{
      role: 'assistant',
      parts: [
        { type: 'reasoning', content: 'considering' },
        { type: 'text', content: 'editing' },
        {
          type: 'tool_call',
          toolCallId: 'tool-1',
          toolName: 'Edit',
          arguments: '{"file_path":"/x"}',
        },
      ],
    }],
    usage: {
      inputTokens: 35,
      outputTokens: 4,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
      reasoningTokens: 3,
    },
    outputType: 'text',
    responseId: 'msg-a',
    finishReasons: ['tool_use'],
  });
  assert.deepEqual(started[0].attributes, { [ATTR.AGENT_NAME]: 'researcher' });
  assert.deepEqual(started[0].end, {
    endTime: new Date('2026-01-01T00:00:02.000Z'),
  });
  assert.deepEqual([...seen], ['id:msg-a:0']);
});

test('does not confuse nonconsecutive responses that reuse an id', () => {
  const recordedIds: string[] = [];
  const parent = {
    startLLM() {
      return {
        record(value: { responseId?: string }) {
          if (value.responseId) recordedIds.push(value.responseId);
        },
        setAttributes() {},
        end() {},
      };
    },
  } as unknown as SpanParent;
  const response = (id: string, text: string): AssistantResponse => ({
    id,
    model: 'claude-opus-4-8',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text }],
  });

  emitChatSpans(parent, [
    response('shared', 'first'),
    response('other', 'middle'),
    response('shared', 'last'),
  ], { seen: new Set() });

  assert.deepEqual(recordedIds, ['shared', 'other', 'shared']);
});
