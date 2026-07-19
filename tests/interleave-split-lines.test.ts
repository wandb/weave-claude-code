// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression test for the main-agent chat-span reconstruction.
//
// Claude Code writes a single assistant API response as MULTIPLE transcript
// lines, one per content block (thinking / text / tool_use), all sharing one
// `message.id`, and the parser maps each line to its own AssistantCallDetail.
// An earlier version walked `blockIdx` within a single call's contentBlocks,
// assuming all blocks lived together; against real (split) transcripts that
// emitted nothing for the text/thinking blocks (they were dropped).
//
// Post-SDK-migration each assistant response is a single `chat` span whose
// ordered `gen_ai.output.messages` parts carry the response's blocks in
// transcript order. This drives the actual reconstruction through the Stop
// handler and asserts: thinking / redacted_thinking / text / tool_use are NOT
// dropped, appear in order as parts, and the duplicated per-line usage is
// counted once per response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATTR } from '../src/genaiSpans.ts';
import { flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

/** One assistant transcript line carrying a single content block, mirroring how
 *  Claude Code splits a response. `usage` is the FULL message usage, duplicated
 *  on every line of the same response (verified against real transcripts). */
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
  // One turn:
  //   response msgA: thinking, redacted_thinking, text, tool_use  (4 split lines, shared id)
  //   response msgB: text-only (no tool_use)
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
    // No PreToolUse fires here; both responses are back-filled at Stop, which
    // is the reconstruction path this test exercises.
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const chatA = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgA');
    assert.ok(chatA, 'chat span for msgA emitted');

    // thinking, redacted_thinking (as a [redacted] reasoning part), text, and
    // tool_use are NOT dropped and appear in transcript order as parts.
    assert.deepEqual(partsOf(chatA), [
      { type: 'reasoning', content: 'let me think' },
      { type: 'reasoning', content: '[redacted]' },
      { type: 'text', content: 'first I will edit' },
      { type: 'tool_call', toolCallId: 'tool_1', toolName: 'Edit', arguments: '{}' },
    ], 'thinking, redacted placeholder, text, tool_call: all present, in order');

    // Usage counted ONCE for the response (not 4x for the 4 split lines).
    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508);
    assert.equal(chatA.attributes[ATTR.USAGE_INPUT_TOKENS], 100 + 400);

    // The tool-less final message still renders as its own chat span.
    const chatB = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgB');
    assert.ok(chatB, 'chat span for tool-less msgB emitted');
    assert.deepEqual(partsOf(chatB), [{ type: 'text', content: 'all done' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
