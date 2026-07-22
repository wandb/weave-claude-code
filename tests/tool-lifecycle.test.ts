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
  fs.writeFileSync(file, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: prompt },
  }) + '\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    file,
    appendPrompt(text: string) {
      fs.appendFileSync(file, JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      }) + '\n');
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
