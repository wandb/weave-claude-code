// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ATTR } from '../src/genaiSpans.ts';
import { VERSION } from '../src/setup.ts';
import {
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  spanParentId,
} from './helpers.ts';

type Transcript = {
  file: string;
  append(...entries: Record<string, unknown>[]): void;
};

function makeTranscript(t: TestContext, sessionId: string): Transcript {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-turn-lifecycle-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    file,
    append(...entries) {
      fs.appendFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    },
  };
}

function userEntry(
  text: string,
  options: { timestamp?: string; version?: string } = {},
): Record<string, unknown> {
  return {
    type: 'user',
    ...options,
    message: { role: 'user', content: text },
  };
}

function assistantEntry(
  id: string,
  text: string,
  options: {
    timestamp?: string;
    usage?: Record<string, number>;
    finishReason?: string;
  } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: options.usage ?? { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'text', text }],
      ...(options.finishReason ? { stop_reason: options.finishReason } : {}),
    },
  };
}

function turns(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
}

function chats(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat');
}

test('Stop snapshots only new normalized responses and SessionEnd closes the root', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-stop-snapshots';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('do it', {
    timestamp: '2026-01-01T00:00:00.000Z',
    version: '1.2.3',
  }));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'do it',
  });
  transcript.append(assistantEntry('response-a', 'working', {
    timestamp: '2026-01-01T00:00:01.000Z',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20 },
  }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await flushWeave();

  assert.equal(turns(exporter.getFinishedSpans()).length, 0, 'blockable Stop retains the root');
  assert.deepEqual(chats(exporter.getFinishedSpans()).map(span => span.attributes[ATTR.RESPONSE_ID]), [
    'response-a',
  ]);

  transcript.append(assistantEntry('response-b', 'done', {
    timestamp: '2026-01-01T00:00:02.000Z',
    finishReason: 'end_turn',
  }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  const responseSpans = chats(spans);
  assert.ok(turn);
  assert.equal(responseSpans.length, 2, 'repeated Stop does not replay response-a');
  assert.deepEqual(responseSpans.map(span => span.attributes[ATTR.RESPONSE_ID]), [
    'response-a',
    'response-b',
  ]);
  assert.ok(responseSpans.every(span => spanParentId(span) === turn.spanContext().spanId));
  assert.equal(turn.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(
    turn.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([
      { role: 'assistant', content: 'working' },
      { role: 'assistant', content: 'done' },
    ]),
  );
  assert.deepEqual(turn.attributes[ATTR.RESPONSE_FINISH_REASONS], ['end_turn']);
  assert.equal(turn.attributes[ATTR.WEAVE_INTEGRATION_NAME], 'weave-claude-code');
  assert.equal(turn.attributes[ATTR.WEAVE_INTEGRATION_VERSION], VERSION);
  assert.equal(turn.attributes['weave.integration.meta.claude_code_app_version'], '1.2.3');
  assert.equal(responseSpans[0].attributes[ATTR.USAGE_INPUT_TOKENS], 30);
});

test('the first chat span carries the prompt while Stop retains the root', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-live-prompt';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('where do traces go'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'where do traces go',
  });
  transcript.append(
    assistantEntry('response-a', 'checking'),
    assistantEntry('response-b', 'here', { finishReason: 'end_turn' }),
  );
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 0);
  assert.deepEqual(
    chats(spans).map(span => [span.attributes[ATTR.RESPONSE_ID], span.attributes[ATTR.INPUT_MESSAGES]]),
    [
      ['response-a', JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'where do traces go' }] },
      ])],
      ['response-b', undefined],
    ],
  );
});

test('a mid-turn transcript user line does not copy the prompt onto a replayed chat span', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-live-prompt-offset-shift';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('hello'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'hello' });
  transcript.append(assistantEntry('response-a', 'first'));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  // A plain-string user line starts a new transcript turn without a UserPromptSubmit.
  transcript.append(
    userEntry('<task-notification><task-id>a</task-id></task-notification>'),
    assistantEntry('response-b', 'second'),
  );
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const withPrompt = chats(exporter.getFinishedSpans())
    .filter(span => span.attributes[ATTR.INPUT_MESSAGES] !== undefined)
    .map(span => span.attributes[ATTR.RESPONSE_ID]);
  assert.deepEqual(withPrompt, ['response-a']);
});

test('the prompt skips a first response that has no model', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-live-prompt-no-model';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('hello'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'hello' });
  const modelless = assistantEntry('response-a', 'first');
  delete (modelless.message as Record<string, unknown>).model;
  transcript.append(modelless, assistantEntry('response-b', 'second'));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await flushWeave();

  assert.deepEqual(
    chats(exporter.getFinishedSpans()).map(span => [span.attributes[ATTR.RESPONSE_ID], span.attributes[ATTR.INPUT_MESSAGES]]),
    [['response-b', JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }])]],
  );
});

function toolUseEntry(id: string, toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
      stop_reason: 'tool_use',
    },
  };
}

function toolResultEntry(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  };
}

async function startLiveSession(t: TestContext, sessionId: string) {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('list files'));
  const daemon = makeGenaiDaemon();
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'list files' });
  const preToolUse = (toolUseId: string) => daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sessionId,
    tool_use_id: toolUseId, tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  return { exporter, transcript, daemon, preToolUse };
}

const PROMPT_MESSAGES = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'list files' }] }]);

test('a response is sent before Stop once the next response starts a tool', async (t) => {
  const { exporter, transcript, daemon, preToolUse } = await startLiveSession(t, 'live-chat-next-response');
  transcript.append(toolUseEntry('response-a', 'tool-1'));
  await preToolUse('tool-1');
  transcript.append(toolResultEntry('tool-1'), toolUseEntry('response-b', 'tool-2'));
  await preToolUse('tool-2');
  await flushWeave();

  assert.equal(turns(exporter.getFinishedSpans()).length, 0);
  assert.deepEqual(
    chats(exporter.getFinishedSpans()).map(span => [span.attributes[ATTR.RESPONSE_ID], span.attributes[ATTR.INPUT_MESSAGES]]),
    [['response-a', PROMPT_MESSAGES]],
  );

  transcript.append(toolResultEntry('tool-2'), assistantEntry('response-c', 'done', { finishReason: 'end_turn' }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: 'live-chat-next-response' });
  await flushWeave();
  assert.deepEqual(
    chats(exporter.getFinishedSpans()).map(span => span.attributes[ATTR.RESPONSE_ID]),
    ['response-a', 'response-b', 'response-c'],
  );
});

test('a response still streaming parallel tool calls is not sent early', async (t) => {
  const { exporter, transcript, daemon, preToolUse } = await startLiveSession(t, 'live-chat-parallel');
  // Claude Code runs tool-1 before writing the response's tool-2 block.
  transcript.append(toolUseEntry('response-a', 'tool-1'));
  await preToolUse('tool-1');
  transcript.append(toolResultEntry('tool-1'), toolUseEntry('response-a', 'tool-2'));
  await preToolUse('tool-2');
  transcript.append(toolResultEntry('tool-2'), assistantEntry('response-b', 'done', { finishReason: 'end_turn' }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: 'live-chat-parallel' });
  await flushWeave();

  const [first] = chats(exporter.getFinishedSpans());
  assert.ok(first);
  assert.equal(first.attributes[ATTR.RESPONSE_ID], 'response-a');
  const toolCallIds = JSON.parse(String(first.attributes[ATTR.OUTPUT_MESSAGES]))[0].parts
    .filter((part: { type: string }) => part.type === 'tool_call')
    .map((part: { toolCallId: string }) => part.toolCallId);
  assert.deepEqual(toolCallIds, ['tool-1', 'tool-2']);
});

test('a newer prompt closes an interrupted root without replaying its response', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-interrupted';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('first'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'first' });
  transcript.append(
    assistantEntry('only-once', 'first answer'),
    userEntry('second'),
  );
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'second' });
  transcript.append(userEntry('third'));
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'third' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'only-once').length, 1);
  const rootSpans = turns(spans);
  assert.equal(rootSpans.length, 3);
  const first = rootSpans.find(span => String(span.attributes[ATTR.INPUT_MESSAGES]).includes('first'));
  const second = rootSpans.find(span => String(span.attributes[ATTR.INPUT_MESSAGES]).includes('second'));
  assert.ok(first && second);
  assert.equal(first.attributes[ATTR.WEAVE_ORPHAN_REASON], 'superseded_by_next_prompt');
  assert.equal(second.attributes[ATTR.WEAVE_ORPHAN_REASON], 'superseded_by_next_prompt');
});

test('an identical prompt submitted during transcript lag does not replay prior output', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-repeated-prompt-race';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('same prompt'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-a', prompt: 'same prompt',
  });
  transcript.append(assistantEntry('response-a', 'first answer'));
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-a',
  });

  // The second hook can arrive before its identical user line reaches JSONL.
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-b', prompt: 'same prompt',
  });
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-b',
  });
  await flushWeave();

  const laggingSpans = exporter.getFinishedSpans();
  assert.equal(turns(laggingSpans).length, 1, 'only the completed first root exports during lag');
  assert.deepEqual(
    chats(laggingSpans).map(span => span.attributes[ATTR.RESPONSE_ID]),
    ['response-a'],
    'the lagging second root does not replay the first response',
  );

  transcript.append(
    userEntry('same prompt'),
    assistantEntry('response-b', 'second answer'),
  );
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-b',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId,
    prompt_id: 'prompt-b', reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 2);
  assert.deepEqual(
    chats(spans).map(span => span.attributes[ATTR.RESPONSE_ID]),
    ['response-a', 'response-b'],
  );
});

test('duplicate prompt_id is idempotent', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-prompt-id';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('once'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  const prompt = {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-1', prompt: 'once',
  };
  await daemon.routeEvent(prompt);
  await daemon.routeEvent(prompt);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId,
    prompt_id: 'prompt-1', reason: 'clear',
  });
  await flushWeave();

  assert.equal(turns(exporter.getFinishedSpans()).length, 1);
});

test('an out-of-order Stop does not replace the foreground prompt', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-out-of-order-stop';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('foreground'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'foreground-id', prompt: 'foreground',
  });
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId,
    prompt_id: 'background-id', transcript_path: transcript.file,
  });
  transcript.append(userEntry('next'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'next-id', prompt: 'next',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const foreground = turns(exporter.getFinishedSpans()).find(span =>
    String(span.attributes[ATTR.INPUT_MESSAGES]).includes('foreground'));
  assert.ok(foreground);
  assert.equal(foreground.attributes[ATTR.WEAVE_ORPHAN_REASON], 'superseded_by_next_prompt');
});

test('SessionEnd alone reconstructs the final turn, including its input', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-session-end-restart';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('finish it', { timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantEntry('restart-final', 'finished', {
      timestamp: '2026-01-01T00:00:01.000Z',
      finishReason: 'end_turn',
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId,
    prompt_id: 'final-prompt', transcript_path: transcript.file,
    cwd: '/x', reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'restart-final');
  assert.ok(turn && chat);
  assert.equal(
    turn.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'finish it' }] }]),
  );
  assert.equal(spanParentId(chat), turn.spanContext().spanId);
});

test('shutdown does not synthesize a historical turn for an idle resumed session', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-idle-resume-shutdown';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('historical prompt'),
    assistantEntry('historical-response', 'historical answer'),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'resume', cwd: '/x',
  });
  await daemon.drain('test shutdown');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 0);
  assert.equal(chats(spans).length, 0);
});

test('restart-first Stop does not claim another transcript prompt', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-stop-restart';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('older'),
    assistantEntry('older-response', 'old'),
    userEntry('newer'),
    assistantEntry('newer-response', 'new'),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'older-prompt',
    transcript_path: transcript.file, cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 1);
  assert.equal(chats(spans).length, 0);
});

test('SessionEnd binds a restart-first root with the same prompt_id', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'root-stop-same-prompt-restart';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('final prompt'),
    assistantEntry('final-response', 'finished'),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-a',
    transcript_path: transcript.file, cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId, prompt_id: 'prompt-a',
    transcript_path: transcript.file, reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'final-response');
  assert.ok(turn && chat);
  assert.equal(
    turn.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'final prompt' }] }]),
  );
  assert.equal(spanParentId(chat), turn.spanContext().spanId);
});

test('a prompt arriving before Claude Code creates the transcript still opens a turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'prompt-before-transcript';
  // Deliberately not created yet: Claude Code writes the file after SessionStart.
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-turn-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    transcript_path: file, prompt: 'first prompt', prompt_id: 'prompt-a',
  });

  fs.writeFileSync(file, JSON.stringify(userEntry('first prompt')) + '\n');
  fs.appendFileSync(file, JSON.stringify(assistantEntry('msg-a', 'reply')) + '\n');
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  assert.ok(turn, 'the first prompt must not be dropped');
  assert.equal(
    turn.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'first prompt' }] }]),
  );
  assert.equal(chats(spans).length, 1, 'its response is still recorded');
});

test('a delayed prompt-less tool result attaches to its own turn, not the newest', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'delayed-legacy-tool';
  const transcript = makeTranscript(t, sessionId);
  // Older transcript turn: the prompt and the response that called the tool.
  transcript.append(userEntry('old prompt'));
  transcript.append({
    type: 'assistant',
    message: {
      role: 'assistant', id: 'msg-old', model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'tool_use', id: 'old-tool', name: 'Bash', input: { command: 'ls' } }],
    },
  });
  transcript.append(userEntry('new prompt'));
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: transcript.file };

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', ...base, source: 'startup', cwd: '/x',
  });
  // Legacy hooks carry no prompt_id, so the newer prompt becomes the current turn.
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'new prompt' });
  // Delayed terminal hook for the older tool, still without a prompt_id.
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', ...base, tool_use_id: 'old-tool',
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const [toolSpan] = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
  assert.ok(toolSpan);
  const parent = turns(spans).find(span => span.spanContext().spanId === spanParentId(toolSpan));
  assert.ok(parent, 'the tool hangs off a turn');
  assert.equal(
    parent.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'old prompt' }] }]),
    'the old tool belongs to the turn that called it',
  );
  assert.equal(turns(spans).length, 2, 'the newer turn stays separate');
});
