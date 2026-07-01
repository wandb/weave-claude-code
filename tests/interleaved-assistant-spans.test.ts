// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression test for the "final assistant message contains the interstitial
// Claude text that should appear between tool calls" bug.
//
// The old emitChatSpansFromAssistantCalls path emitted one chat span per
// assistant API call as a sibling of tool spans, with text content joined and
// tool_use position info dropped. With parallel tool calls, the Weave UI
// rendered all tool spans first and a single chat span at the bottom holding
// every interstitial utterance smushed together.
//
// New behavior: each assistant API call gets a chat span that PARENTS the
// tool spans AND per-block assistant_text / thinking spans that occur during
// that call, in transcript order. Token usage stays on the chat span (where
// it accurately represents one API invocation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  startChatSpan,
  finalizeChatSpan,
  startToolSpan,
  emitAssistantTextSpan,
  emitThinkingSpan,
  OP,
  ATTR,
} from '../src/genaiSpans.ts';

function setupTracer(): {
  tracer: ReturnType<BasicTracerProvider['getTracer']>;
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

function opName(span: ReadableSpan): string {
  return span.attributes[ATTR.OPERATION_NAME] as string;
}

test('chat span parents per-block assistant_text and execute_tool children in transcript order', async () => {
  const { tracer, exporter, provider } = setupTracer();
  const turn = tracer.startSpan('invoke_agent claude-code');

  // Simulated assistant API call:
  //   text "Now let me add the method"
  //   tool_use Edit
  //   text "Now let me add the test"
  //   tool_use Edit
  //   text "All done"
  const chat = startChatSpan(tracer, turn, {
    conversationId: 'conv-1',
    model: 'claude-opus-4-7',
    startedAt: new Date('2026-01-01T00:00:00Z'),
  });

  emitAssistantTextSpan(tracer, chat, {
    conversationId: 'conv-1',
    text: 'Now let me add the method',
  });
  const t1 = startToolSpan(tracer, chat, {
    toolName: 'Edit',
    toolUseId: 'toolu_01',
    toolInput: { file_path: '/foo.ts' },
    conversationId: 'conv-1',
  });
  t1.end();
  emitAssistantTextSpan(tracer, chat, {
    conversationId: 'conv-1',
    text: 'Now let me add the test',
  });
  const t2 = startToolSpan(tracer, chat, {
    toolName: 'Edit',
    toolUseId: 'toolu_02',
    toolInput: { file_path: '/foo.test.ts' },
    conversationId: 'conv-1',
  });
  t2.end();
  emitAssistantTextSpan(tracer, chat, {
    conversationId: 'conv-1',
    text: 'All done',
  });

  finalizeChatSpan(chat, {
    usage: { input_tokens: 1000, output_tokens: 200 },
    endedAt: new Date('2026-01-01T00:00:05Z'),
  });
  turn.end();
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  const turnSpan = spans.find((s) => s.name === 'invoke_agent claude-code');
  const chatSpan = spans.find((s) => s.name === 'chat claude-opus-4-7');
  assert.ok(turnSpan, 'turn span emitted');
  assert.ok(chatSpan, 'chat span emitted with model in name');

  // Chat span parents under the turn.
  assert.equal(chatSpan.parentSpanContext?.spanId, turnSpan.spanContext().spanId);

  // Every assistant_text + execute_tool span parents under the chat span.
  const chatChildren = spans.filter(
    (s) => s.parentSpanContext?.spanId === chatSpan.spanContext().spanId,
  );
  // Order in `chatChildren` reflects end-time ordering (SimpleSpanProcessor
  // exports on span.end). Synchronous zero-duration emits in code order
  // produce monotonic timestamps, so the assertion holds.
  const childOps = chatChildren.map(opName);
  assert.deepEqual(
    childOps,
    [
      OP.ASSISTANT_TEXT,
      OP.EXECUTE_TOOL,
      OP.ASSISTANT_TEXT,
      OP.EXECUTE_TOOL,
      OP.ASSISTANT_TEXT,
    ],
    'children appear in interleaved transcript order',
  );

  // Token usage lives on the chat span, not on the per-block spans.
  assert.equal(chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS], 1000);
  assert.equal(chatSpan.attributes[ATTR.USAGE_OUTPUT_TOKENS], 200);
  for (const child of chatChildren) {
    assert.equal(child.attributes[ATTR.USAGE_INPUT_TOKENS], undefined);
    assert.equal(child.attributes[ATTR.USAGE_OUTPUT_TOKENS], undefined);
  }

  // assistant_text content lands on gen_ai.output.messages as a text part.
  assert.deepEqual(
    JSON.parse(chatChildren[0].attributes[ATTR.OUTPUT_MESSAGES] as string),
    [{ role: 'assistant', parts: [{ type: 'text', content: 'Now let me add the method' }] }],
  );
});

test('emitThinkingSpan: thinking content lands as a thinking part on its own span', async () => {
  const { tracer, exporter, provider } = setupTracer();
  const parent = tracer.startSpan('chat');

  emitThinkingSpan(tracer, parent, {
    conversationId: 'conv-1',
    text: 'Let me reason about this...',
  });

  parent.end();
  await provider.forceFlush();

  const span = exporter
    .getFinishedSpans()
    .find((s) => s.attributes[ATTR.OPERATION_NAME] === OP.THINKING);
  assert.ok(span);
  assert.equal(span.name, OP.THINKING);
  const messages = JSON.parse(span.attributes[ATTR.OUTPUT_MESSAGES] as string);
  assert.deepEqual(messages, [
    {
      role: 'assistant',
      parts: [{ type: 'thinking', content: 'Let me reason about this...' }],
    },
  ]);
});

test('startChatSpan without model: finalizeChatSpan stamps the model and updates the name', async () => {
  const { tracer, exporter, provider } = setupTracer();
  const turn = tracer.startSpan('invoke_agent claude-code');

  const chat = startChatSpan(tracer, turn, {
    conversationId: 'conv-1',
    startedAt: new Date(),
  });
  finalizeChatSpan(chat, {
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'claude-haiku-4-5',
  });
  turn.end();
  await provider.forceFlush();

  const chatSpan = exporter
    .getFinishedSpans()
    .find((s) => s.attributes[ATTR.OPERATION_NAME] === OP.CHAT);
  assert.ok(chatSpan);
  assert.equal(chatSpan.name, 'chat claude-haiku-4-5');
  assert.equal(chatSpan.attributes[ATTR.REQUEST_MODEL], 'claude-haiku-4-5');
  assert.equal(chatSpan.attributes[ATTR.PROVIDER_NAME], 'anthropic');
});
