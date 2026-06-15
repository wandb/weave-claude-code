// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression test for the cache-hit-rate bug (Weave UI showed >100%).
//
// Anthropic's API splits prompt usage into three disjoint fields:
//   input_tokens                — new (uncached) prompt tokens
//   cache_read_input_tokens     — tokens served from prompt cache
//   cache_creation_input_tokens — tokens written to prompt cache
//
// OTel GenAI semconv requires `gen_ai.usage.input_tokens` to be the TOTAL
// prompt size (including cache reads and writes). When the plugin forwarded
// Anthropic's `input_tokens` verbatim, downstream consumers computing
// `cache_read / input_tokens` produced rates greater than 100% (the cache
// portion was larger than the uncached portion). Spec ref:
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { emitChatSpan, ATTR } from '../src/genaiSpans.ts';

function setupTracer(): { tracer: ReturnType<BasicTracerProvider['getTracer']>; exporter: InMemorySpanExporter; provider: BasicTracerProvider } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  return { tracer, exporter, provider };
}

test('emitChatSpan: input_tokens includes cache_read + cache_creation (OTel semconv)', async () => {
  const { tracer, exporter, provider } = setupTracer();
  const parent = tracer.startSpan('parent');

  const startedAt = new Date('2026-01-01T00:00:00Z');
  const endedAt = new Date('2026-01-01T00:00:01Z');

  emitChatSpan(tracer, parent, {
    conversationId: 'conv-1',
    model: 'claude-opus-4-7',
    startedAt,
    endedAt,
    usage: {
      input_tokens: 7600,
      output_tokens: 528,
      cache_read_input_tokens: 36500,
      cache_creation_input_tokens: 4100,
    },
  });

  parent.end();
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  const chatSpan = spans.find(s => s.name === 'chat claude-opus-4-7');
  assert.ok(chatSpan, 'chat span should be emitted');

  // Total prompt = 7600 + 36500 + 4100 = 48200.
  // Without this fix the value was 7600, making cache_read/input_tokens = 480%.
  assert.equal(
    chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS],
    48200,
    'gen_ai.usage.input_tokens must include cache_read and cache_creation per OTel semconv',
  );

  // Cache fields are reported separately and unchanged.
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS], 36500);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS], 4100);
  assert.equal(chatSpan.attributes[ATTR.USAGE_OUTPUT_TOKENS], 528);
});

test('emitChatSpan: input_tokens unchanged when no cache fields present', async () => {
  const { tracer, exporter, provider } = setupTracer();
  const parent = tracer.startSpan('parent');

  emitChatSpan(tracer, parent, {
    conversationId: 'conv-2',
    model: 'claude-haiku-4-5',
    startedAt: new Date(),
    endedAt: new Date(),
    usage: { input_tokens: 1000, output_tokens: 200 },
  });

  parent.end();
  await provider.forceFlush();

  const chatSpan = exporter.getFinishedSpans().find(s => s.name === 'chat claude-haiku-4-5');
  assert.ok(chatSpan);
  assert.equal(chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS], 1000);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS], undefined);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS], undefined);
});
