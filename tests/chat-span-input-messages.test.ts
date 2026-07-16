// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression test for `gen_ai.input.messages` on chat spans.
//
// Chat spans used to carry only `gen_ai.output.messages` — the assistant's
// response — with no record of the conversation prefix the model was actually
// sent. The parser now reconstructs a running, within-turn message history and
// snapshots it onto each AssistantCallDetail; the main-agent reconstruction
// (GlobalDaemon.emitChatSpanForResponse) stamps it as `gen_ai.input.messages`.
//
// This asserts both layers: the parser attaches the correct prefix per call
// (turn-opening prompt, then prior assistant + tool_result messages), and the
// emitted chat spans carry it. Prior turns are intentionally NOT included — a
// new turn resets the history (stitching is via gen_ai.conversation.id).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { GlobalDaemon } from '../src/daemon.ts';
import { parseSessionFile, type NormalizedMessage } from '../src/parser.ts';
import { ATTR } from '../src/genaiSpans.ts';

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

function writeTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-input-msgs-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function makeDaemon(tracer: ReturnType<typeof setupTracer>['tracer']): GlobalDaemon {
  const d = new GlobalDaemon('/tmp/unused.sock', '/tmp/unused.log', 'e/p', 'k', 'https://x', false);
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d;
}

// A turn with a tool loop: prompt -> assistant(text + tool_use) -> tool_result
// -> assistant(text). Two API responses, msg1 and msg2.
function toolLoopTranscript(): string {
  return writeTranscript([
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'What is 2+2? Use the calculator.' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', id: 'msg1', model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'text', text: 'Let me compute that.' },
          { type: 'tool_use', id: 'tu_1', name: 'calc', input: { expr: '2+2' } },
        ], stop_reason: 'tool_use' } },
    { type: 'user', timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '4' }] } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'assistant', id: 'msg2', model: 'claude-opus-4-8',
        usage: { input_tokens: 20, output_tokens: 8 },
        content: [{ type: 'text', text: 'The answer is 4.' }], stop_reason: 'end_turn' } },
  ]);
}

test('parser: each chat call carries the running conversation prefix as inputMessages', () => {
  const parsed = parseSessionFile(toolLoopTranscript());
  assert.ok(parsed);
  const calls = parsed.turns.at(-1)!.assistantCalls();
  assert.equal(calls.length, 2);

  // First call sees only the turn-opening user prompt.
  assert.deepEqual(calls[0].inputMessages, [
    { role: 'user', content: 'What is 2+2? Use the calculator.' },
  ] satisfies NormalizedMessage[]);

  // Second call sees the prompt, the first assistant response (with its
  // tool_use preserved in `parts`), and the tool_result.
  assert.deepEqual(calls[1].inputMessages, [
    { role: 'user', content: 'What is 2+2? Use the calculator.' },
    {
      role: 'assistant',
      content: 'Let me compute that.',
      parts: [
        { type: 'text', text: 'Let me compute that.' },
        { type: 'tool_use', id: 'tu_1', name: 'calc', input: { expr: '2+2' } },
      ],
    },
    { role: 'user', content: '', parts: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '4' }] },
  ] satisfies NormalizedMessage[]);
});

test('parser: a new turn resets the prefix — prior turns are not carried', () => {
  const file = writeTranscript([
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'first question' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', id: 'a1', model: 'claude-opus-4-8',
        usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'first answer' }] } },
    // A user text message opens turn 2 (and closes turn 1).
    { type: 'user', timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'second question' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'assistant', id: 'a2', model: 'claude-opus-4-8',
        usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'second answer' }] } },
  ]);
  const parsed = parseSessionFile(file);
  assert.ok(parsed);
  assert.equal(parsed.turns.length, 2);

  const turn2Call = parsed.turns[1].assistantCalls()[0];
  assert.deepEqual(turn2Call.inputMessages, [
    { role: 'user', content: 'second question' },
  ] satisfies NormalizedMessage[], 'turn 2 prefix does not include turn 1');
});

test('daemon: emitted chat spans stamp gen_ai.input.messages', async () => {
  const { tracer, exporter, provider } = setupTracer();
  try {
    const parsed = parseSessionFile(toolLoopTranscript());
    assert.ok(parsed);
    const calls = parsed.turns.at(-1)!.assistantCalls();

    const daemon = makeDaemon(tracer);
    const turn = tracer.startSpan('invoke_agent claude-code');
    const session = {
      conversationId: 'conv-1',
      currentTurnSpan: turn,
      emittedChatSpanResponseKeys: new Set<string>(),
      activeChatSpan: undefined,
    };
    const emit = (key: string) =>
      (daemon as unknown as { emitChatSpanForResponse: (s: unknown, c: unknown, k: string) => void })
        .emitChatSpanForResponse(session, calls, key);
    emit('msg1');
    emit('msg2');
    turn.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const chat1 = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msg1');
    const chat2 = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msg2');
    assert.ok(chat1 && chat2, 'both chat spans emitted');

    assert.deepEqual(
      JSON.parse(chat1.attributes[ATTR.INPUT_MESSAGES] as string),
      [{ role: 'user', content: 'What is 2+2? Use the calculator.' }],
    );
    const chat2Input = JSON.parse(chat2.attributes[ATTR.INPUT_MESSAGES] as string) as NormalizedMessage[];
    assert.equal(chat2Input.length, 3);
    assert.equal(chat2Input[1].role, 'assistant');
    assert.equal(chat2Input[2].role, 'user'); // the tool_result
  } finally {
    await provider.shutdown();
  }
});
