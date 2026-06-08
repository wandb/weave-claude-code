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
// https://opentelemetry.io/docs/specs/semconv/gen-ai/anthropic/
//
// After the Weave SDK migration, the totaling lives in
// `emitChatSpansViaSDK` in daemon.ts. We wire an `InMemorySpanExporter`
// through the SDK's public `genai.spanProcessor` setting and assert the
// span's `gen_ai.usage.input_tokens` attribute reflects the sum.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as weave from 'weave';
import { emitChatSpansViaSDK } from '../src/daemon.ts';
import { ATTR } from '../src/genaiSpans.ts';
import type { AssistantCallDetail } from '../src/parser.ts';

// `weave.init` reads WANDB_API_KEY from env; set a dummy so the SDK can
// construct its trace-server stub without attempting a real auth call.
process.env['WANDB_API_KEY'] = 'test-api-key';

const exporter = new InMemorySpanExporter();
await weave.init('test-entity/test-project', {
  genai: { spanProcessor: new SimpleSpanProcessor(exporter) },
});

function makeCall(usage: AssistantCallDetail['usage']): AssistantCallDetail {
  return {
    model: 'claude-opus-4-7',
    usage,
    contentBlocks: [],
    timestamp: '2026-01-01T00:00:01Z',
    prevTimestamp: '2026-01-01T00:00:00Z',
    reasoningTokens: undefined,
    responseId: undefined,
    finishReason: undefined,
  };
}

test('emitChatSpansViaSDK: input_tokens includes cache_read + cache_creation (OTel semconv)', async () => {
  exporter.reset();

  await weave.runIsolated(async () => {
    const turn = weave.startTurn({ agentName: 'claude-code' });
    emitChatSpansViaSDK(turn, 'conv-1', [makeCall({
      input_tokens: 7600,
      output_tokens: 528,
      cache_read_input_tokens: 36500,
      cache_creation_input_tokens: 4100,
    })]);
    turn.end();
  });
  await weave.flushOTel();

  const spans = exporter.getFinishedSpans();
  const chatSpan = spans.find(
    s => s.name === 'chat' && s.attributes[ATTR.REQUEST_MODEL] === 'claude-opus-4-7',
  );
  assert.ok(chatSpan, `chat span should be emitted; saw: ${spans.map(s => s.name).join(', ') || '(none)'}`);

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

test('emitChatSpansViaSDK: input_tokens unchanged when no cache fields present', async () => {
  exporter.reset();

  await weave.runIsolated(async () => {
    const turn = weave.startTurn({ agentName: 'claude-code' });
    emitChatSpansViaSDK(turn, 'conv-2', [{
      ...makeCall({ input_tokens: 1000, output_tokens: 200 }),
      model: 'claude-haiku-4-5',
    }]);
    turn.end();
  });
  await weave.flushOTel();

  const chatSpan = exporter.getFinishedSpans().find(
    s => s.name === 'chat' && s.attributes[ATTR.REQUEST_MODEL] === 'claude-haiku-4-5',
  );
  assert.ok(chatSpan);
  assert.equal(chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS], 1000);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS], undefined);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS], undefined);
});
