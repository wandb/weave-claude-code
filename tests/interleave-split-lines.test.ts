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
// emitted nothing for the text/thinking blocks (they were dropped) and lumped
// any surviving text at the end with emission-time timestamps.
//
// This drives the actual reconstruction (GlobalDaemon.emitChatSpanForResponse,
// reached the same way the Stop handler reaches it) against a realistic
// split-line transcript and asserts: text/thinking are NOT dropped, each lands
// on a span stamped with its transcript timestamp (so it sorts into order
// among the live tool spans), and the duplicated per-line usage is counted
// once per response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { GlobalDaemon } from '../src/daemon.ts';
import { parseSessionFile } from '../src/parser.ts';
import { ATTR, OP } from '../src/genaiSpans.ts';

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

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

function writeTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-interleave-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function makeDaemon(tracer: ReturnType<typeof setupTracer>['tracer']): GlobalDaemon {
  const d = new GlobalDaemon('/tmp/unused.sock', '/tmp/unused.log', 'e/p', 'k', 'https://x', false);
  // Inject the in-memory tracer (normally created by initTracer at startup).
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d;
}

test('reconstruction: split thinking/text/tool_use lines interleave, none dropped, usage counted once', async () => {
  // One turn:
  //   response msgA: thinking, text, tool_use  (3 split lines, shared id)
  //   response msgB: text-only (no tool_use)
  const file = writeTranscript([
    userText('2026-01-01T00:00:00.000Z', 'do the thing'),
    aLine('msgA', '2026-01-01T00:00:01.000Z', { type: 'thinking', thinking: 'let me think' }),
    aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }),
    aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'),
    aLine('msgB', '2026-01-01T00:00:10.000Z', { type: 'text', text: 'all done' }, 'end_turn'),
  ]);

  const { tracer, exporter, provider } = setupTracer();
  try {
    const parsed = parseSessionFile(file);
    assert.ok(parsed);
    const calls = parsed.turns[parsed.turns.length - 1].assistantCalls();
    // Sanity: the parser really does split one response across lines.
    assert.equal(calls.filter(c => c.responseId === 'msgA').length, 3, 'msgA is 3 split lines');

    const daemon = makeDaemon(tracer);
    const turn = tracer.startSpan('invoke_agent claude-code');
    const session = {
      conversationId: 'conv-1',
      currentTurnSpan: turn,
      emittedChatSpanResponseKeys: new Set<string>(),
      activeChatSpan: undefined,
    };

    // Reach the real reconstruction the same way the Stop handler does.
    const emit = (key: string) =>
      (daemon as unknown as { emitChatSpanForResponse: (s: unknown, c: unknown, k: string) => void })
        .emitChatSpanForResponse(session, calls, key);
    emit('msgA');
    emit('msgB');

    turn.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const chatA = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgA');
    assert.ok(chatA, 'chat span for msgA emitted');

    const childrenOf = (parent: ReadableSpan) =>
      spans
        .filter(s => s.parentSpanContext?.spanId === parent.spanContext().spanId)
        .sort((a, b) => hrToNs(a.startTime) - hrToNs(b.startTime));

    const aChildren = childrenOf(chatA);
    // thinking + text are NOT dropped, and appear in transcript order.
    assert.deepEqual(
      aChildren.map(s => s.attributes[ATTR.OPERATION_NAME]),
      [OP.THINKING, OP.ASSISTANT_TEXT],
      'thinking then text, both present (the dropped-text regression)',
    );
    // Each child is stamped with its transcript line timestamp (so it sorts
    // before the tool_use of the same response, whose live span starts later).
    assert.equal(isoOf(aChildren[0].startTime), '2026-01-01T00:00:01.000Z');
    assert.equal(isoOf(aChildren[1].startTime), '2026-01-01T00:00:02.000Z');

    // Usage counted ONCE for the response (not 3x for the 3 split lines).
    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508);
    assert.equal(chatA.attributes[ATTR.USAGE_INPUT_TOKENS], 100 + 400);

    // The tool-less final message still renders, after msgA.
    const chatB = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgB');
    assert.ok(chatB, 'chat span for tool-less msgB emitted');
    assert.equal(childrenOf(chatB).map(s => s.attributes[ATTR.OPERATION_NAME])[0], OP.ASSISTANT_TEXT);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

function hrToNs(t: [number, number]): number {
  return t[0] * 1e9 + t[1];
}
function isoOf(t: [number, number]): string {
  return new Date(t[0] * 1000 + t[1] / 1e6).toISOString();
}
