// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Chat-span behavior for assistant responses. Post-SDK-migration each assistant
// response is a single `chat` span whose ordered `gen_ai.output.messages` parts
// carry the response's blocks (thinking / text / tool_use) in transcript order;
// the tools the model called nest under that chat span as `execute_tool`
// children. This file covers:
//
//   - contentBlocksToParts: the pure formatting layer (block -> ordered part).
//   - Handlers state machine (via routeEvent): PreToolUse opens the chat span,
//     Stop finalizes, response transitions, the Stop dedup, and SessionEnd
//     finalizing a still-open span.
//   - Split-line reconstruction: one API response written as multiple transcript
//     lines (one per content block, shared message id) is reconstructed without
//     dropping blocks and with usage counted once.
//   - Usage tokens: `gen_ai.usage.input_tokens` includes cache read + creation
//     (OTel semconv), fixing the >100% cache-hit-rate bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InMemorySpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ATTR, contentBlocksToParts } from '../src/genaiSpans.ts';
import { childrenOf, flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

const USAGE = { input_tokens: 100, output_tokens: 1508, cache_read_input_tokens: 400 };

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
      usage: USAGE,
      ...(stop ? { stop_reason: stop } : {}),
    },
  };
}

/** One tool-less assistant transcript line carrying `text` and a custom `usage`
 *  (used by the usage-token tests, which vary usage per case). */
function usageLine(id: string, ts: string, text: string, usage: Record<string, number>) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', id, model: 'claude-opus-4-7', content: [{ type: 'text', text }], usage, stop_reason: 'end_turn' },
  };
}

function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** Incrementally-appendable transcript. Appends after SessionStart are visible
 *  (getFd caches one fd, re-stat per read). Path must be inside $HOME. */
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

/** Drive one turn whose single tool-less assistant response carries `usage`,
 *  and return the exported `chat` span. */
async function chatSpanForUsage(exporter: InMemorySpanExporter, sid: string, usage: Record<string, number>): Promise<ReadableSpan> {
  exporter.reset();
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-usage-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify(userText('2026-01-01T00:00:00Z', 'do it')),
    JSON.stringify(usageLine('msgA', '2026-01-01T00:00:01Z', 'all done', usage)),
  ].join('\n') + '\n');
  const d = makeGenaiDaemon();
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

// --- contentBlocksToParts: pure block -> ordered part mapping ----------------
// The end-to-end interleave behavior (parts on the chat span, tools nested under
// it) is covered by the handlers / split-line tests below.

test('contentBlocksToParts: interleaved text and tool_use map to ordered parts', () => {
  const parts = contentBlocksToParts([
    { type: 'text', text: 'Now let me add the method' },
    { type: 'tool_use', id: 'toolu_01', name: 'Edit', input: { file_path: '/foo.ts' } },
    { type: 'text', text: 'Now let me add the test' },
    { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: { file_path: '/foo.test.ts' } },
    { type: 'text', text: 'All done' },
  ]);

  assert.deepEqual(parts, [
    { type: 'text', content: 'Now let me add the method' },
    { type: 'tool_call', toolCallId: 'toolu_01', toolName: 'Edit', arguments: '{"file_path":"/foo.ts"}' },
    { type: 'text', content: 'Now let me add the test' },
    { type: 'tool_call', toolCallId: 'toolu_02', toolName: 'Edit', arguments: '{"file_path":"/foo.test.ts"}' },
    { type: 'text', content: 'All done' },
  ]);
});

test('contentBlocksToParts: thinking maps to a reasoning part; redacted_thinking to a placeholder', () => {
  const parts = contentBlocksToParts([
    { type: 'thinking', thinking: 'Let me reason about this...' },
    { type: 'redacted_thinking', data: 'ENCRYPTED' },
    { type: 'text', text: 'answer' },
  ]);

  assert.deepEqual(parts, [
    { type: 'reasoning', content: 'Let me reason about this...' },
    { type: 'reasoning', content: '[redacted]' },
    { type: 'text', content: 'answer' },
  ]);
});

test('contentBlocksToParts: empty text and empty thinking are skipped', () => {
  const parts = contentBlocksToParts([
    { type: 'text', text: '   ' },
    { type: 'thinking', thinking: '' },
    { type: 'text', text: 'kept' },
  ]);
  assert.deepEqual(parts, [{ type: 'text', content: 'kept' }]);
});

// --- Handlers state machine (driven through routeEvent) ----------------------

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

    // Response msgA: text then tool_use (split lines, shared id), flushed
    // before the tool's PreToolUse fires.
    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'));
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: { file_path: '/foo.ts' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });

    // msgB: text-only (no tool_use -> no PreToolUse; back-filled at Stop).
    append(aLine('msgB', '2026-01-01T00:00:10.000Z', { type: 'text', text: 'all done' }, 'end_turn'));
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();

    // Dedup: one chat span per response (Stop back-fill skips already-final msgA).
    assert.equal(chatByResponse(spans, 'msgA').length, 1, 'one chat span for msgA');
    assert.equal(chatByResponse(spans, 'msgB').length, 1, 'one chat span for msgB');

    const chatA = chatByResponse(spans, 'msgA')[0];
    // msgA text + tool_use are ordered output parts on the chat span.
    assert.deepEqual(partsOf(chatA), [
      { type: 'text', content: 'first I will edit' },
      { type: 'tool_call', toolCallId: 'tool_1', toolName: 'Edit', arguments: '{}' },
    ], 'msgA: text then tool_call, in transcript order, as output parts');
    // The tool the model called nests under the chat span as an execute_tool child.
    const aKids = childrenOf(spans, chatA).map(s => s.attributes[ATTR.OPERATION_NAME]);
    assert.deepEqual(aKids, ['execute_tool'], 'msgA: the execute_tool span nests under the chat span');

    // Usage counted once for the split response.
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

    // Second response with its own tool_use -> PreToolUse(tool_B) must finalize
    // msgA's chat span (transition) before opening msgB's.
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

    // No Stop - session ends mid-turn with the chat span still open.
    await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const chatA = chatByResponse(spans, 'msgA')[0];
    assert.ok(chatA, 'chat span for msgA was finalized at SessionEnd (has a response id)');
    // Finalized, not an empty orphan: usage + text output part are present.
    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508, 'usage recovered at SessionEnd');
    const types = partsOf(chatA).map(p => p['type']);
    assert.ok(types.includes('text'), 'assistant text output part recovered at SessionEnd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Split-line reconstruction -----------------------------------------------
// Claude Code writes a single assistant API response as MULTIPLE transcript
// lines, one per content block (thinking / text / tool_use), all sharing one
// `message.id`. An earlier version walked `blockIdx` within a single call's
// contentBlocks and dropped the text/thinking blocks against real (split)
// transcripts. This drives the reconstruction through the Stop handler.

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

// --- Usage tokens (cache-hit-rate bug: Weave UI showed >100%) ----------------
// Anthropic splits prompt usage into three disjoint fields (input_tokens,
// cache_read_input_tokens, cache_creation_input_tokens). OTel GenAI semconv
// requires `gen_ai.usage.input_tokens` to be the TOTAL prompt size. Spec ref:
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md
// Driven end-to-end so the assertion is on the exported `chat` span's attributes.

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
