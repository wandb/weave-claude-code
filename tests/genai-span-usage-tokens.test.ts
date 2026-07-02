// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression test for the cache-hit-rate bug (Weave UI showed >100%).
//
// Anthropic's API splits prompt usage into three disjoint fields:
//   input_tokens                - new (uncached) prompt tokens
//   cache_read_input_tokens     - tokens served from prompt cache
//   cache_creation_input_tokens - tokens written to prompt cache
//
// OTel GenAI semconv requires `gen_ai.usage.input_tokens` to be the TOTAL
// prompt size (including cache reads and writes). When the plugin forwarded
// Anthropic's `input_tokens` verbatim, downstream consumers computing
// `cache_read / input_tokens` produced rates greater than 100% (the cache
// portion was larger than the uncached portion). Spec ref:
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md
//
// Driven end-to-end through the daemon so the assertion is on the exported
// `chat` span's attributes (the public contract), not an internal helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InMemorySpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ATTR } from '../src/genaiSpans.ts';
import { flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

interface Driver {
  routeEvent(p: Record<string, unknown>): Promise<void>;
}

function aLine(id: string, ts: string, text: string, usage: Record<string, number>) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', id, model: 'claude-opus-4-7', content: [{ type: 'text', text }], usage, stop_reason: 'end_turn' },
  };
}
function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** Drive one turn whose single tool-less assistant response carries `usage`,
 *  and return the exported `chat` span. */
async function chatSpanForUsage(exporter: InMemorySpanExporter, sid: string, usage: Record<string, number>): Promise<ReadableSpan> {
  exporter.reset();
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-usage-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify(userText('2026-01-01T00:00:00Z', 'do it')),
    JSON.stringify(aLine('msgA', '2026-01-01T00:00:01Z', 'all done', usage)),
  ].join('\n') + '\n');
  const d = makeGenaiDaemon() as unknown as Driver;
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();
    const chat = exporter.getFinishedSpans().find(s => s.name === 'chat');
    assert.ok(chat, 'chat span should be emitted');
    return chat;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('chat span: input_tokens includes cache_read + cache_creation (OTel semconv)', async () => {
  const exporter = await initWeaveInMemory();
  const chatSpan = await chatSpanForUsage(exporter, 'sess-usage-1', {
    input_tokens: 7600,
    output_tokens: 528,
    cache_read_input_tokens: 36500,
    cache_creation_input_tokens: 4100,
  });

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

test('chat span: input_tokens unchanged when no cache fields present', async () => {
  const exporter = await initWeaveInMemory();
  const chatSpan = await chatSpanForUsage(exporter, 'sess-usage-2', { input_tokens: 1000, output_tokens: 200 });

  assert.equal(chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS], 1000);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS], undefined);
  assert.equal(chatSpan.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS], undefined);
});
