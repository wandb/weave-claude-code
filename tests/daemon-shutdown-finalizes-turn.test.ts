// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTR } from '../src/genaiSpans.ts';
import {
  assistantEntry,
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  makeTranscript,
  spanParentId,
  userEntry,
} from './helpers.ts';

for (const closure of [
  {
    name: 'SessionEnd',
    reason: 'session_ended',
    close: (daemon: ReturnType<typeof makeGenaiDaemon>, sid: string) =>
      daemon.routeEvent({
        hook_event_name: 'SessionEnd',
        session_id: sid,
        reason: 'clear',
      }),
  },
  {
    name: 'daemon drain',
    reason: 'daemon_shutdown',
    close: (daemon: ReturnType<typeof makeGenaiDaemon>) =>
      daemon.drain('inactivity'),
  },
]) {
  test(`${closure.name} exports an open turn and its completed child`, async (t) => {
    const exporter = await initWeaveInMemory();
    exporter.reset();
    const sid = `turn-close-${closure.name}`;
    const transcript = makeTranscript(t, sid, 'turn-close');
    transcript.append(
      userEntry('do it'),
      assistantEntry('msg-a', { type: 'text', text: 'working' }),
    );
    const daemon = makeGenaiDaemon();

    await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
    await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool-1', tool_name: 'Read', tool_input: { file_path: '/foo' } });
    await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool-1', tool_response: 'ok' });
    await closure.close(daemon, sid);
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const turn = spans.find(span =>
      span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
    const chat = spans.find(span =>
      span.attributes[ATTR.RESPONSE_ID] === 'msg-a');
    const tool = spans.find(span =>
      span.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
    assert.ok(turn && chat && tool);
    assert.equal(turn.attributes[ATTR.WEAVE_ORPHAN_REASON], closure.reason);
    assert.equal(spanParentId(chat), turn.spanContext().spanId);
    assert.equal(spanParentId(tool), turn.spanContext().spanId);
    assert.ok(spans.indexOf(chat) < spans.indexOf(turn));
  });
}

test('daemon drain orphans an open Agent under its turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'turn-close-agent';
  const transcript = makeTranscript(t, sid, 'turn-close-agent');
  transcript.append(userEntry('delegate it'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate it' });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'agent-1',
    tool_name: 'Agent', tool_input: { subagent_type: 'reviewer', prompt: 'review' },
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const turn = spans.find(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agent = spans.find(span =>
    span.attributes[ATTR.AGENT_NAME] === 'reviewer');
  assert.ok(turn && agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
  assert.equal(spanParentId(agent), turn.spanContext().spanId);
  assert.deepEqual(agent.endTime, turn.endTime);
});

test('abandoning a permission-pending tool records an orphan, not a denial', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'turn-close-permission';
  const transcript = makeTranscript(t, sid, 'turn-close-permission');
  transcript.append(userEntry('run it'));
  const daemon = makeGenaiDaemon();
  const toolInput = { command: 'sleep 10' };

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'run it' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'pending-tool', tool_name: 'Bash', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Bash', tool_input: toolInput });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const tool = exporter.getFinishedSpans().find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'pending-tool');
  assert.ok(tool);
  assert.equal(tool.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
  assert.equal(tool.status.code, 2);
  assert.equal(
    tool.events.some(event => event.name === ATTR.EVT_PERMISSION_RESOLVED),
    false,
  );
});
