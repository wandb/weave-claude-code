// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ATTR } from '../src/genaiSpans.ts';
import { childrenOf, flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

const USAGE = { input_tokens: 100, output_tokens: 1508, cache_read_input_tokens: 400 };

function aLine(id: string, ts: string, block: Record<string, unknown>, stop?: string) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      content: [block],
      usage: USAGE,
      ...(stop ? { stop_reason: stop } : {}),
    },
  };
}

function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function makeTranscript(sessionId: string): { file: string; append: (line: unknown) => void; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-itest-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  return {
    file,
    dir,
    append: (line: unknown) => fs.appendFileSync(file, JSON.stringify(line) + '\n'),
  };
}

function chatByResponse(spans: ReadableSpan[], id: string): ReadableSpan[] {
  return spans.filter(s => s.attributes[ATTR.OPERATION_NAME] === 'chat' && s.attributes[ATTR.RESPONSE_ID] === id);
}
function partsOf(span: ReadableSpan): Array<Record<string, unknown>> {
  const msgs = JSON.parse(span.attributes[ATTR.OUTPUT_MESSAGES] as string) as Array<{ parts?: Array<Record<string, unknown>> }>;
  return msgs[0]?.parts ?? [];
}

test('handlers: PreToolUse opens the chat span, Stop finalizes; text + tool interleave, usage once, no double-emit', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-A';
  const { file, append, dir } = makeTranscript(sid);
  append(userText('2026-01-01T00:00:00.000Z', 'do the thing'));

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do the thing' });

    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'));
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: { file_path: '/foo.ts' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });

    append(aLine('msgB', '2026-01-01T00:00:10.000Z', { type: 'text', text: 'all done' }, 'end_turn'));
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();

    assert.equal(chatByResponse(spans, 'msgA').length, 1, 'one chat span for msgA');
    assert.equal(chatByResponse(spans, 'msgB').length, 1, 'one chat span for msgB');

    const chatA = chatByResponse(spans, 'msgA')[0];
    assert.deepEqual(partsOf(chatA), [
      { type: 'text', content: 'first I will edit' },
      { type: 'tool_call', toolCallId: 'tool_1', toolName: 'Edit', arguments: '{}' },
    ], 'msgA: text then tool_call, in transcript order, as output parts');
    const aKids = childrenOf(spans, chatA).map(s => s.attributes[ATTR.OPERATION_NAME]);
    assert.deepEqual(aKids, ['execute_tool'], 'msgA: the execute_tool span nests under the chat span');

    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508);
    assert.equal(chatA.attributes[ATTR.USAGE_INPUT_TOKENS], 100 + 400);

    const chatB = chatByResponse(spans, 'msgB')[0];
    assert.deepEqual(partsOf(chatB), [{ type: 'text', content: 'all done' }]);
    assert.equal(childrenOf(spans, chatB).length, 0, 'tool-less msgB has no execute_tool children');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers: a new response transitions and finalizes the previous chat span', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-B';
  const { file, append, dir } = makeTranscript(sid);
  append(userText('2026-01-01T00:00:00.000Z', 'do two things'));

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do two things' });

    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'editing A' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_A', name: 'Edit', input: {} }, 'tool_use'));
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_A', tool_name: 'Edit', tool_input: {} });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_A', tool_response: 'ok' });

    append(aLine('msgB', '2026-01-01T00:00:05.000Z', { type: 'text', text: 'editing B' }));
    append(aLine('msgB', '2026-01-01T00:00:06.000Z', { type: 'tool_use', id: 'tool_B', name: 'Edit', input: {} }, 'tool_use'));
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_B', tool_name: 'Edit', tool_input: {} });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_B', tool_response: 'ok' });

    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    assert.equal(chatByResponse(spans, 'msgA').length, 1, 'msgA finalized exactly once at the transition');
    assert.equal(chatByResponse(spans, 'msgB').length, 1, 'msgB finalized exactly once at Stop');

    for (const id of ['msgA', 'msgB']) {
      const chat = chatByResponse(spans, id)[0];
      const parts = partsOf(chat).map(p => p['type']);
      assert.deepEqual(parts, ['text', 'tool_call'], `${id}: text + tool_call output parts`);
      const kids = childrenOf(spans, chat).map(s => s.attributes[ATTR.OPERATION_NAME]);
      assert.deepEqual(kids, ['execute_tool'], `${id}: execute_tool nests under its chat span`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers: SessionEnd finalizes a still-open chat span with its output + usage (not an empty orphan)', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-C';
  const { file, append, dir } = makeTranscript(sid);
  append(userText('2026-01-01T00:00:00.000Z', 'do the thing'));

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do the thing' });

    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'));
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: {} });

    await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const chatA = chatByResponse(spans, 'msgA')[0];
    assert.ok(chatA, 'chat span for msgA was finalized at SessionEnd (has a response id)');
    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508, 'usage recovered at SessionEnd');
    const types = partsOf(chatA).map(p => p['type']);
    assert.ok(types.includes('text'), 'assistant text output part recovered at SessionEnd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
