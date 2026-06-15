// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Integration test for the main-agent chat-span STATE MACHINE, driven through
// the real daemon hook handlers (SessionStart → UserPromptSubmit → PreToolUse →
// PostToolUse → Stop / SessionEnd) rather than calling emitChatSpanForResponse
// directly. This exercises the parts the other two interleave tests don't:
//   - advanceMainAgentChatSpan opening a chat span at PreToolUse and parenting
//     the tool span under it,
//   - the response→response transition finalizing the previous chat span,
//   - the emittedChatSpanResponseKeys dedup (no double chat span at Stop),
//   - the SessionEnd path finalizing a still-open chat span (text + usage) when
//     Stop never fired.

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
import { ATTR, OP } from '../src/genaiSpans.ts';

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

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

/** A transcript the handlers read incrementally. `getFd` caches one fd and
 *  re-stats it per read, so appends made after SessionStart are visible. The
 *  path must be inside $HOME (TranscriptFile rejects anything else). */
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

interface Handlers {
  handleSessionStart(s: string, p: Record<string, unknown>): Promise<void>;
  handleUserPromptSubmit(s: string, p: Record<string, unknown>): Promise<void>;
  handlePreToolUse(s: string, a: string | undefined, p: Record<string, unknown>): Promise<void>;
  handlePostToolUse(s: string, p: Record<string, unknown>): Promise<void>;
  handleStop(s: string, p: Record<string, unknown>): Promise<void>;
  handleSessionEnd(s: string, p: Record<string, unknown>): Promise<void>;
  tracer: unknown;
}

function makeDaemon(tracer: ReturnType<typeof setupTracer>['tracer']): Handlers {
  const logFile = path.join(os.tmpdir(), `wcp-itest-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d as unknown as Handlers;
}

function childrenOf(spans: ReadableSpan[], parent: ReadableSpan): ReadableSpan[] {
  return spans
    .filter(s => s.parentSpanContext?.spanId === parent.spanContext().spanId)
    .sort((a, b) => hrToNs(a.startTime) - hrToNs(b.startTime));
}
function chatByResponse(spans: ReadableSpan[], id: string): ReadableSpan[] {
  return spans.filter(s => s.attributes[ATTR.OPERATION_NAME] === OP.CHAT && s.attributes[ATTR.RESPONSE_ID] === id);
}

test('handlers: PreToolUse opens the chat span, Stop finalizes; text + tool interleave, usage once, no double-emit', async () => {
  const sid = 'sess-A';
  const { file, append, dir } = makeTranscript(sid);
  append(userText('2026-01-01T00:00:00.000Z', 'do the thing'));

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.handleSessionStart(sid, { transcript_path: file, source: 'startup', cwd: '/x' });
    await d.handleUserPromptSubmit(sid, { prompt: 'do the thing' });

    // Response msgA: text then tool_use (split lines, shared id), flushed
    // before the tool's PreToolUse fires.
    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'));
    await d.handlePreToolUse(sid, undefined, { tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: { file_path: '/foo.ts' } });
    await d.handlePostToolUse(sid, { tool_use_id: 'tool_1', tool_response: 'ok' });

    // Response msgB: text-only final message (no tool_use → never opens a chat
    // span at PreToolUse; must be back-filled at Stop).
    append(aLine('msgB', '2026-01-01T00:00:10.000Z', { type: 'text', text: 'all done' }, 'end_turn'));
    await d.handleStop(sid, {});
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();

    // Exactly one chat span per response (dedup: msgA opened at PreToolUse and
    // finalized at Stop must NOT also be emitted by the Stop back-fill loop).
    assert.equal(chatByResponse(spans, 'msgA').length, 1, 'one chat span for msgA');
    assert.equal(chatByResponse(spans, 'msgB').length, 1, 'one chat span for msgB');

    const chatA = chatByResponse(spans, 'msgA')[0];
    const aKids = childrenOf(spans, chatA).map(s => s.attributes[ATTR.OPERATION_NAME]);
    assert.deepEqual(aKids, [OP.ASSISTANT_TEXT, OP.EXECUTE_TOOL], 'msgA: text then tool, both parented under the chat span');

    // Usage counted once for the split response.
    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508);
    assert.equal(chatA.attributes[ATTR.USAGE_INPUT_TOKENS], 100 + 400);

    const chatB = chatByResponse(spans, 'msgB')[0];
    assert.deepEqual(childrenOf(spans, chatB).map(s => s.attributes[ATTR.OPERATION_NAME]), [OP.ASSISTANT_TEXT]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers: a new response transitions and finalizes the previous chat span', async () => {
  const sid = 'sess-B';
  const { file, append, dir } = makeTranscript(sid);
  append(userText('2026-01-01T00:00:00.000Z', 'do two things'));

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.handleSessionStart(sid, { transcript_path: file, source: 'startup', cwd: '/x' });
    await d.handleUserPromptSubmit(sid, { prompt: 'do two things' });

    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'editing A' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_A', name: 'Edit', input: {} }, 'tool_use'));
    await d.handlePreToolUse(sid, undefined, { tool_use_id: 'tool_A', tool_name: 'Edit', tool_input: {} });
    await d.handlePostToolUse(sid, { tool_use_id: 'tool_A', tool_response: 'ok' });

    // Second response with its own tool_use → PreToolUse(tool_B) must finalize
    // msgA's chat span (transition) before opening msgB's.
    append(aLine('msgB', '2026-01-01T00:00:05.000Z', { type: 'text', text: 'editing B' }));
    append(aLine('msgB', '2026-01-01T00:00:06.000Z', { type: 'tool_use', id: 'tool_B', name: 'Edit', input: {} }, 'tool_use'));
    await d.handlePreToolUse(sid, undefined, { tool_use_id: 'tool_B', tool_name: 'Edit', tool_input: {} });
    await d.handlePostToolUse(sid, { tool_use_id: 'tool_B', tool_response: 'ok' });

    await d.handleStop(sid, {});
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    assert.equal(chatByResponse(spans, 'msgA').length, 1, 'msgA finalized exactly once at the transition');
    assert.equal(chatByResponse(spans, 'msgB').length, 1, 'msgB finalized exactly once at Stop');

    for (const id of ['msgA', 'msgB']) {
      const chat = chatByResponse(spans, id)[0];
      const kids = childrenOf(spans, chat).map(s => s.attributes[ATTR.OPERATION_NAME]);
      assert.deepEqual(kids, [OP.ASSISTANT_TEXT, OP.EXECUTE_TOOL], `${id}: text + tool under its chat span`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('handlers: SessionEnd finalizes a still-open chat span with its text + usage (not an empty orphan)', async () => {
  const sid = 'sess-C';
  const { file, append, dir } = makeTranscript(sid);
  append(userText('2026-01-01T00:00:00.000Z', 'do the thing'));

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.handleSessionStart(sid, { transcript_path: file, source: 'startup', cwd: '/x' });
    await d.handleUserPromptSubmit(sid, { prompt: 'do the thing' });

    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'first I will edit' }));
    append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use'));
    await d.handlePreToolUse(sid, undefined, { tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: {} });

    // No Stop — session ends mid-turn with the chat span still open.
    await d.handleSessionEnd(sid, { reason: 'clear' });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const chatA = chatByResponse(spans, 'msgA')[0];
    assert.ok(chatA, 'chat span for msgA was finalized at SessionEnd (has a response id)');
    // Finalized, not an empty orphan: usage + text child are present.
    assert.equal(chatA.attributes[ATTR.USAGE_OUTPUT_TOKENS], 1508, 'usage recovered at SessionEnd');
    const kids = childrenOf(spans, chatA).map(s => s.attributes[ATTR.OPERATION_NAME]);
    assert.ok(kids.includes(OP.ASSISTANT_TEXT), 'assistant_text child recovered at SessionEnd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function hrToNs(t: [number, number]): number {
  return t[0] * 1e9 + t[1];
}
