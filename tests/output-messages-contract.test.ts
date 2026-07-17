// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// The gen_ai.output.messages contract the Weave Agents chat view renders,
// matching the Codex plugin:
//
//   - The root `invoke_agent` turn span carries ONLY the final assistant
//     message. Interstitial text already renders as ordered `assistant_text`
//     child spans; re-dumping every text block on the root is what collapsed
//     the chat view into one trailing message.
//   - Chat spans carry normalized GenAI parts: `text` / `thinking` blocks map
//     to `{type, content}`, `tool_use` maps to
//     `{type: 'tool_call', toolCallId, toolName, arguments}`. Raw Anthropic
//     block shapes (`{text}`, `{id, name, input}`) must not leak into the
//     attribute, and blocks with no readable content (`redacted_thinking`)
//     are dropped.
//
// Drives the real routeEvent entry point for the main-agent turn (Stop handler
// and emitChatSpanForResponse), and emitChatSpansFromAssistantCalls directly
// for the subagent/teammate path.

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
import { ATTR, OP, emitChatSpansFromAssistantCalls } from '../src/genaiSpans.ts';

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };

function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** One assistant transcript line carrying a single content block, mirroring
 *  how Claude Code splits a response across lines sharing one `message.id`. */
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

function makeDaemon(tracer: unknown, logFile: string) {
  const d = new GlobalDaemon('/tmp/unused-outmsg.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d as unknown as { routeEvent(p: Record<string, unknown>): Promise<void> };
}

function parseOutputMessages(span: ReadableSpan): unknown {
  return JSON.parse(span.attributes[ATTR.OUTPUT_MESSAGES] as string);
}

/**
 * Run one full main-agent turn through routeEvent: user prompt, an assistant
 * response ("let me edit" + Edit tool_use), then the final text-only response
 * ("all done"), and Stop. Returns the finished spans.
 */
async function runTurn(opts: { lastAssistantMessage?: string }): Promise<ReadableSpan[]> {
  const sid = 'sess-outmsg';
  // Under the home dir: the daemon rejects transcript paths outside it.
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-outmsg-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(userText('2026-01-01T00:00:00.000Z', 'do it')) + '\n');

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer, path.join(dir, 'daemon.log'));
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });

    fs.appendFileSync(file, JSON.stringify(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'let me edit' })) + '\n');
    fs.appendFileSync(file, JSON.stringify(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: { file_path: '/foo.ts' } }, 'tool_use')) + '\n');
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: { file_path: '/foo.ts' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });

    fs.appendFileSync(file, JSON.stringify(aLine('msgB', '2026-01-01T00:00:10.000Z', { type: 'text', text: 'all done' }, 'end_turn')) + '\n');
    await d.routeEvent({
      hook_event_name: 'Stop',
      session_id: sid,
      ...(opts.lastAssistantMessage !== undefined ? { last_assistant_message: opts.lastAssistantMessage } : {}),
    });
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('root turn output carries only the final assistant message', async () => {
  const spans = await runTurn({ lastAssistantMessage: 'all done' });
  const turn = spans.find(s => s.attributes[ATTR.OPERATION_NAME] === OP.INVOKE_AGENT);
  assert.ok(turn, 'turn span emitted');
  assert.deepEqual(parseOutputMessages(turn), [{ role: 'assistant', content: 'all done' }]);
});

test('root turn output falls back to the last parsed text block when Stop carries no last_assistant_message', async () => {
  const spans = await runTurn({});
  const turn = spans.find(s => s.attributes[ATTR.OPERATION_NAME] === OP.INVOKE_AGENT);
  assert.ok(turn, 'turn span emitted');
  assert.deepEqual(parseOutputMessages(turn), [{ role: 'assistant', content: 'all done' }]);
});

test('main-agent chat spans carry normalized parts, not raw Anthropic blocks', async () => {
  const spans = await runTurn({ lastAssistantMessage: 'all done' });

  const chatA = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgA');
  assert.ok(chatA, 'chat span for msgA emitted');
  assert.deepEqual(parseOutputMessages(chatA), [
    {
      role: 'assistant',
      parts: [
        { type: 'text', content: 'let me edit' },
        { type: 'tool_call', toolCallId: 'tool_1', toolName: 'Edit', arguments: { file_path: '/foo.ts' } },
      ],
    },
  ]);

  const chatB = spans.find(s => s.attributes[ATTR.RESPONSE_ID] === 'msgB');
  assert.ok(chatB, 'chat span for msgB emitted');
  assert.deepEqual(parseOutputMessages(chatB), [
    { role: 'assistant', parts: [{ type: 'text', content: 'all done' }] },
  ]);
});

test('subagent chat spans (emitChatSpansFromAssistantCalls) carry normalized parts', async () => {
  // Split-line response: thinking, redacted_thinking, text, tool_use. The
  // parser maps each line to its own AssistantCallDetail, so this path emits
  // one chat span per line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-outmsg-sub-'));
  const file = path.join(dir, 'subagent.jsonl');
  fs.writeFileSync(file, [
    userText('2026-01-01T00:00:00.000Z', 'go'),
    aLine('msgC', '2026-01-01T00:00:01.000Z', { type: 'thinking', thinking: 'hmm' }),
    aLine('msgC', '2026-01-01T00:00:02.000Z', { type: 'redacted_thinking', data: 'ENCRYPTED' }),
    aLine('msgC', '2026-01-01T00:00:03.000Z', { type: 'text', text: 'running the tool' }),
    aLine('msgC', '2026-01-01T00:00:04.000Z', { type: 'tool_use', id: 'tool_9', name: 'Bash', input: { command: 'ls' } }, 'tool_use'),
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const { tracer, exporter, provider } = setupTracer();
  try {
    const parsed = parseSessionFile(file);
    assert.ok(parsed);
    const calls = parsed.turns[parsed.turns.length - 1].assistantCalls();
    assert.equal(calls.length, 4, 'msgC is 4 split lines');

    const parent = tracer.startSpan('invoke_agent Explore');
    emitChatSpansFromAssistantCalls(tracer, parent, 'conv-1', calls);
    parent.end();
    await provider.forceFlush();

    // SimpleSpanProcessor exports on span.end, and the emits are sequential,
    // so the chat spans appear in transcript-line order.
    const chats = exporter.getFinishedSpans().filter(s => s.attributes[ATTR.OPERATION_NAME] === OP.CHAT);
    assert.equal(chats.length, 4, 'one chat span per split line');

    assert.deepEqual(parseOutputMessages(chats[0]), [
      { role: 'assistant', parts: [{ type: 'thinking', content: 'hmm' }] },
    ]);
    assert.equal(
      chats[1].attributes[ATTR.OUTPUT_MESSAGES],
      undefined,
      'redacted_thinking-only response carries no output.messages',
    );
    assert.deepEqual(parseOutputMessages(chats[2]), [
      { role: 'assistant', parts: [{ type: 'text', content: 'running the tool' }] },
    ]);
    assert.deepEqual(parseOutputMessages(chats[3]), [
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', toolCallId: 'tool_9', toolName: 'Bash', arguments: { command: 'ls' } }],
      },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
