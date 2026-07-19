// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATTR } from '../src/genaiSpans.ts';
import { flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

function aLine(id: string, ts: string, block: Record<string, unknown>, stop?: string) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      content: [block],
      usage: { input_tokens: 100, output_tokens: 1508, cache_read_input_tokens: 400 },
      ...(stop ? { stop_reason: stop } : {}),
    },
  };
}

function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function partsOf(span: import('@opentelemetry/sdk-trace-base').ReadableSpan): Array<Record<string, unknown>> {
  const msgs = JSON.parse(span.attributes[ATTR.OUTPUT_MESSAGES] as string) as Array<{ parts?: Array<Record<string, unknown>> }>;
  return msgs[0]?.parts ?? [];
}

test('reconstruction: split thinking/redacted_thinking/text/tool_use lines interleave as ordered parts, none dropped, usage once', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-split';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-splitlines-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, [
    userText('2026-01-01T00:00:00.000Z', 'do the thing'),
    aLine('msgA', '2026-01-01T00:00:01.000Z', { type: 'thinking', thinking: 'let me think' }),
    aLine('msgA', '2026-01-01T00:00:01.500Z', { type: 'redacted_thinking', data: 'ENCRYPTED' }),
    aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }),
    aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'),
    aLine('msgB', '2026-01-01T00:00:10.000Z', { type: 'text', text: 'all done' }, 'end_turn'),
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do the thing' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const chatA = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgA');
    assert.ok(chatA, 'chat span for msgA emitted');

    assert.deepEqual(partsOf(chatA), [
      { type: 'reasoning', content: 'let me think' },
      { type: 'reasoning', content: '[redacted]' },
      { type: 'text', content: 'first I will edit' },
      { type: 'tool_call', toolCallId: 'tool_1', toolName: 'Edit', arguments: '{}' },
    ], 'thinking, redacted placeholder, text, tool_call: all present, in order');

    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508);
    assert.equal(chatA.attributes[ATTR.USAGE_INPUT_TOKENS], 100 + 400);

    const chatB = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgB');
    assert.ok(chatB, 'chat span for tool-less msgB emitted');
    assert.deepEqual(partsOf(chatB), [{ type: 'text', content: 'all done' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
