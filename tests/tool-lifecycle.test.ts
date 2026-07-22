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
import {
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  spanParentId,
} from './helpers.ts';

function makeTranscript(t: TestContext, sessionId: string, prompt: string) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-tool-lifecycle-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const append = (entry: Record<string, unknown>) => {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  };
  fs.writeFileSync(file, '');
  append({ type: 'user', message: { role: 'user', content: prompt } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    file,
    appendPrompt(text: string) {
      append({ type: 'user', message: { role: 'user', content: text } });
    },
    appendResponse(id: string, text: string) {
      append({
        type: 'assistant',
        message: {
          role: 'assistant',
          id,
          model: 'claude-opus-4-8',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: 'text', text }],
        },
      });
    },
  };
}

function toolSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
}

function turnSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
}

test('ordinary tool calls are traced once while Agent-owned calls remain deferred', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'ordinary-tool';
  const transcript = makeTranscript(t, sessionId, 'read it');
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'read it',
  });
  const tool = {
    session_id: sessionId,
    tool_use_id: 'read-1',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/input.txt' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...tool });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...tool, tool_response: 'contents' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...tool });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...tool, tool_response: 'duplicate' });

  const agent = {
    session_id: sessionId,
    tool_use_id: 'agent-1',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'inspect it' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...agent });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...agent, tool_response: 'done' });
  const child = {
    session_id: sessionId,
    agent_id: 'untraced-agent',
    tool_use_id: 'child-read',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/child.txt' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...child });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...child, tool_response: 'child' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const tools = toolSpans(spans);
  const [turn] = turnSpans(spans);
  assert.equal(tools.length, 1);
  assert.ok(turn);
  assert.equal(tools[0].attributes['gen_ai.tool.call.id'], 'read-1');
  assert.equal(tools[0].attributes['gen_ai.tool.call.result'], 'contents');
  assert.equal(tools[0].attributes[ATTR.WEAVE_DISPLAY_NAME], 'Read: /tmp/input.txt');
  assert.equal(spanParentId(tools[0]), turn.spanContext().spanId);
});

test('PostToolUseFailure records the tool result and error type', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'failed-tool';
  const transcript = makeTranscript(t, sessionId, 'run it');
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'run it' });
  const tool = {
    session_id: sessionId,
    tool_use_id: 'bash-1',
    tool_name: 'Bash',
    tool_input: { command: 'exit 1' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...tool });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure', ...tool, error: 'CommandError: exit 1',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const [span] = toolSpans(exporter.getFinishedSpans());
  assert.ok(span);
  assert.equal(span.attributes['gen_ai.tool.call.result'], 'CommandError: exit 1');
  assert.equal(span.attributes[ATTR.ERROR_TYPE], 'CommandError');
  assert.equal(span.status.code, 2);
});

test('a restart-first terminal hook recovers one exact tool and turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'terminal-tool-restart';
  const transcript = makeTranscript(t, sessionId, 'read after restart');
  const daemon = makeGenaiDaemon();
  const tool = {
    session_id: sessionId,
    transcript_path: transcript.file,
    cwd: '/x',
    tool_use_id: 'recovered-read',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/recovered.txt' },
  };

  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...tool, tool_response: 'contents' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...tool });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...tool, tool_response: 'duplicate' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const tools = toolSpans(spans);
  const turns = turnSpans(spans);
  assert.equal(tools.length, 1);
  assert.equal(turns.length, 1);
  assert.equal(spanParentId(tools[0]), turns[0].spanContext().spanId);
  assert.equal(
    turns[0].attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'read after restart' }] }]),
  );
});

test('restart-first tool results preserve SessionEnd prompt identity', async (t) => {
  const scenarios: Array<{
    name: string;
    eventPrompt?: string;
    endPrompt?: string;
    sameRoot: boolean;
  }> = [
    { name: 'same explicit prompt', eventPrompt: 'prompt-a', endPrompt: 'prompt-a', sameRoot: true },
    { name: 'different explicit prompts', eventPrompt: 'prompt-a', endPrompt: 'prompt-b', sameRoot: false },
    { name: 'legacy result then explicit end', endPrompt: 'prompt-b', sameRoot: true },
    { name: 'explicit result then legacy end', eventPrompt: 'prompt-a', sameRoot: false },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const exporter = await initWeaveInMemory();
      exporter.reset();
      const sessionId = `restart-prompt-${scenario.name.replaceAll(' ', '-')}`;
      const transcript = makeTranscript(t, sessionId, 'older');
      transcript.appendResponse('older-response', 'old');
      transcript.appendPrompt('final');
      transcript.appendResponse('final-response', 'finished');
      const daemon = makeGenaiDaemon();

      await daemon.routeEvent({
        hook_event_name: 'PostToolUse', session_id: sessionId,
        prompt_id: scenario.eventPrompt, transcript_path: transcript.file,
        tool_use_id: 'restart-tool', tool_name: 'Read',
        tool_input: { file_path: '/tmp/restart' }, tool_response: 'contents',
      });
      await daemon.routeEvent({
        hook_event_name: 'SessionEnd', session_id: sessionId,
        prompt_id: scenario.endPrompt, transcript_path: transcript.file, reason: 'clear',
      });
      await flushWeave();

      const spans = exporter.getFinishedSpans();
      const tool = toolSpans(spans).find(span =>
        span.attributes['gen_ai.tool.call.id'] === 'restart-tool');
      const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'final-response');
      assert.ok(tool && chat);
      const turns = turnSpans(spans);
      assert.equal(turns.length, scenario.sameRoot ? 1 : 2);
      const finalTurn = turns.find(turn => turn.spanContext().spanId === spanParentId(chat));
      assert.ok(String(finalTurn?.attributes[ATTR.INPUT_MESSAGES]).includes('final'));
      assert.equal(
        spanParentId(tool) === spanParentId(chat),
        scenario.sameRoot,
        'prompt identity determines whether recovery reuses the same root',
      );
    });
  }
});

test('SessionEnd orphans unfinished tools before closing their turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'open-tool-session-end';
  const transcript = makeTranscript(t, sessionId, 'keep reading');
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'keep reading',
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sessionId,
    tool_use_id: 'open-read', tool_name: 'Read', tool_input: { file_path: '/tmp/open.txt' },
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const [tool] = toolSpans(spans);
  const [turn] = turnSpans(spans);
  assert.ok(tool && turn);
  assert.equal(tool.attributes[ATTR.WEAVE_ORPHAN_REASON], 'session_ended');
  assert.equal(tool.status.code, 2);
  assert.equal(spanParentId(tool), turn.spanContext().spanId);
});

test('prompt_id keeps background tools attached to their original turns', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'tool-prompt-ownership';
  const transcript = makeTranscript(t, sessionId, 'first');
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-1', prompt: 'first',
  });
  const first = {
    session_id: sessionId, prompt_id: 'prompt-1',
    tool_use_id: 'read-first', tool_name: 'Read', tool_input: { file_path: '/tmp/first' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...first });

  transcript.appendPrompt('second');
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-2', prompt: 'second',
  });
  const second = {
    session_id: sessionId, prompt_id: 'prompt-2',
    tool_use_id: 'read-second', tool_name: 'Read', tool_input: { file_path: '/tmp/second' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...second });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...second, tool_response: 'second' });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...first, tool_response: 'first' });
  await flushWeave();
  assert.equal(turnSpans(exporter.getFinishedSpans()).length, 1);

  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const turns = turnSpans(spans);
  const tools = toolSpans(spans);
  assert.equal(turns.length, 2);
  assert.equal(tools.length, 2);
  const firstTurn = turns.find(span => String(span.attributes[ATTR.INPUT_MESSAGES]).includes('first'));
  const secondTurn = turns.find(span => String(span.attributes[ATTR.INPUT_MESSAGES]).includes('second'));
  const firstTool = tools.find(span => span.attributes['gen_ai.tool.call.id'] === 'read-first');
  const secondTool = tools.find(span => span.attributes['gen_ai.tool.call.id'] === 'read-second');
  assert.ok(firstTurn && secondTurn && firstTool && secondTool);
  assert.equal(spanParentId(firstTool), firstTurn.spanContext().spanId);
  assert.equal(spanParentId(secondTool), secondTurn.spanContext().spanId);
});

test('Stop(prompt_id) snapshots only its turn and later tools keep their owners', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'stop-selected-prompt';
  const transcript = makeTranscript(t, sessionId, 'older prompt');
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-1', prompt: 'older prompt',
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: 'prompt-1',
    tool_use_id: 'hold-older', tool_name: 'Read', tool_input: { file_path: '/tmp/hold' },
  });

  transcript.appendResponse('older-response', 'older answer');
  transcript.appendPrompt('newer prompt');
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-2', prompt: 'newer prompt',
  });
  transcript.appendResponse('newer-response', 'newer answer');
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-1',
  });
  await flushWeave();

  const afterStop = exporter.getFinishedSpans();
  assert.deepEqual(chatsById(afterStop), ['older-response']);
  assert.equal(turnSpans(afterStop).length, 0, 'blockable Stop retains both roots');

  for (const [promptId, toolUseId] of [
    ['prompt-1', 'continued-older'],
    ['prompt-2', 'newer-tool'],
  ] as const) {
    const tool = {
      session_id: sessionId, prompt_id: promptId, tool_use_id: toolUseId,
      tool_name: 'Read', tool_input: { file_path: `/tmp/${toolUseId}` },
    };
    await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...tool });
    await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...tool, tool_response: 'done' });
  }
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const olderChat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'older-response');
  const newerChat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'newer-response');
  const olderTool = toolSpans(spans).find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'continued-older');
  const newerTool = toolSpans(spans).find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'newer-tool');
  assert.ok(olderChat && newerChat && olderTool && newerTool);
  assert.equal(spanParentId(olderTool), spanParentId(olderChat));
  assert.equal(spanParentId(newerTool), spanParentId(newerChat));
  assert.notEqual(spanParentId(olderChat), spanParentId(newerChat));
});

test('a legacy next prompt orphans its open tool and starts a clean turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'legacy-tool-prompt-boundary';
  const transcript = makeTranscript(t, sessionId, 'first');
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'first',
  });
  const interrupted = {
    session_id: sessionId, tool_use_id: 'interrupted-tool',
    tool_name: 'Bash', tool_input: { command: 'sleep 999' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...interrupted });

  transcript.appendPrompt('second');
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'second',
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', ...interrupted, tool_response: 'too late',
  });
  const next = {
    session_id: sessionId, tool_use_id: 'next-tool',
    tool_name: 'Read', tool_input: { file_path: '/tmp/next' },
  };
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...next });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...next, tool_response: 'next result' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const firstTurn = turnSpans(spans).find(span =>
    String(span.attributes[ATTR.INPUT_MESSAGES]).includes('first'));
  const secondTurn = turnSpans(spans).find(span =>
    String(span.attributes[ATTR.INPUT_MESSAGES]).includes('second'));
  const oldTool = toolSpans(spans).find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'interrupted-tool');
  const nextTool = toolSpans(spans).find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'next-tool');
  assert.ok(firstTurn && secondTurn && oldTool && nextTool);
  assert.equal(oldTool.attributes[ATTR.WEAVE_ORPHAN_REASON], 'superseded_by_next_prompt');
  assert.equal(oldTool.attributes['gen_ai.tool.call.result'], undefined);
  assert.equal(spanParentId(oldTool), firstTurn.spanContext().spanId);
  assert.equal(nextTool.attributes['gen_ai.tool.call.result'], 'next result');
  assert.equal(nextTool.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(spanParentId(nextTool), secondTurn.spanContext().spanId);
});

function chatsById(spans: ReadableSpan[]): unknown[] {
  return spans
    .filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat')
    .map(span => span.attributes[ATTR.RESPONSE_ID]);
}
