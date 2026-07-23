// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
import { boundAgent, finish } from './agent-test-helpers.ts';

test('subagent topology: marker owns its chat, tools, identity, and canonical result', async (t) => {
  const { exporter, daemon, sid, agentId, subPath } = await boundAgent(t, 'topology');
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'read-call', tool_name: 'Read', tool_input: { file_path: '/flaky.test.ts' },
  });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'read-call', tool_response: 'contents' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call', tool_response: 'canonical result' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const turn = spans.find(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agent = spans.find(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'sub-msg-1');
  const tool = spans.find(span => span.attributes['gen_ai.tool.name'] === 'Read');
  assert.ok(turn && agent && chat && tool);
  assert.equal(spanParentId(agent), turn.spanContext().spanId);
  assert.equal(spanParentId(chat), agent.spanContext().spanId);
  assert.equal(spanParentId(tool), agent.spanContext().spanId);
  assert.equal(agent.attributes[ATTR.AGENT_ID], agentId);
  assert.equal(agent.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID], 'agent-call');
  assert.equal(agent.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'canonical result' },
  ]));
  assert.equal(tool.attributes[ATTR.AGENT_NAME], 'Explore');
  assert.equal(chat.attributes[ATTR.USAGE_INPUT_TOKENS], 120);
  for (const span of [agent, chat, tool]) {
    assert.equal(span.attributes[ATTR.CONVERSATION_ID], sid);
    assert.equal(span.attributes[ATTR.WEAVE_INTEGRATION_NAME], 'weave-claude-code');
  }
});

test('an Agent stays open until its last nested tool completes', async (t) => {
  const { exporter, daemon, sid, agentId, subPath } = await boundAgent(t, 'late-child');
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'late-read', tool_name: 'Read', tool_input: { file_path: '/late.ts' },
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    tool_use_id: 'agent-call', tool_response: 'agent result',
  });
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.AGENT_ID] === agentId), false);

  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    agent_id: agentId, tool_use_id: 'late-read', tool_response: 'contents',
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const tool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'late-read');
  assert.ok(agent && tool);
  assert.equal(spanParentId(tool), agent.spanContext().spanId);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(tool.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
});

for (const { title, label, toolInput, displayName } of [
  {
    title: 'Agent name is display-only when lifecycle agent_type differs',
    label: 'named', toolInput: { name: 'instance-alias', prompt: 'research it' },
    displayName: 'instance-alias',
  },
  {
    title: 'Agent without subtype or name uses the stable display fallback',
    label: 'unnamed', toolInput: { prompt: 'research it' }, displayName: 'Agent',
  },
]) {
  test(title, async (t) => {
    const exporter = await initWeaveInMemory();
    exporter.reset();
    const sid = `sub-${label}-agent`;
    const agentId = `${label}-agent-id`;
    const transcript = makeTranscript(t, sid, sid);
    transcript.append(userEntry('delegate it'));
    const subPath = transcript.subagent(
      agentId,
      userEntry('research it'),
      assistantEntry(`${label}-msg`, { type: 'text', text: 'researched' }),
    );
    const daemon = makeGenaiDaemon();

    await daemon.routeEvent({
      hook_event_name: 'SessionStart', session_id: sid,
      transcript_path: transcript.file, source: 'startup', cwd: '/x',
    });
    await daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate it',
    });
    await daemon.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: `${label}-agent-call`,
      tool_name: 'Agent', tool_input: toolInput,
    });
    await daemon.routeEvent({
      hook_event_name: 'SubagentStart', session_id: sid,
      agent_id: agentId, agent_type: 'general-purpose',
    });
    await daemon.routeEvent({
      hook_event_name: 'SubagentStop', session_id: sid,
      agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
    });
    await daemon.routeEvent({
      hook_event_name: 'PostToolUse', session_id: sid,
      tool_use_id: `${label}-agent-call`, tool_response: 'research result',
    });
    await finish(daemon, sid);

    const spans = exporter.getFinishedSpans();
    const agent = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
    assert.ok(agent);
    assert.equal(agent.attributes[ATTR.AGENT_NAME], displayName);
    assert.equal(agent.attributes[ATTR.OPERATION_NAME], 'invoke_agent');
    assert.equal(spans.filter(span => span.attributes[ATTR.AGENT_ID] === agentId).length, 1);
    assert.equal(spans.some(span =>
      span.attributes['gen_ai.tool.call.id'] === `${label}-agent-call`), false);
  });
}

test('Agent Post before SubagentStop does not create a recovered duplicate', async (t) => {
  const { exporter, daemon, sid, agentId, subPath } = await boundAgent(t, 'post-first');
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call', tool_response: 'done' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 1);
  const chat = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'sub-msg-1');
  assert.ok(chat);
  assert.equal(spanParentId(chat), agents[0].spanContext().spanId);
  assert.equal(
    agents[0].attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'done' }]),
  );
});

test('terminal-first Agent without subtype learns its lifecycle type, not its name', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-terminal-unknown-type';
  const agentId = 'terminal-unknown-type-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    transcript_path: transcript.file, cwd: '/x',
    tool_use_id: 'terminal-agent-call', tool_name: 'Agent',
    tool_input: { name: 'instance-alias', prompt: 'research it' },
    tool_response: 'canonical result',
  });
  const subPath = transcript.subagent(
    agentId,
    userEntry('research it'),
    assistantEntry('terminal-msg', { type: 'text', text: 'researched' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'instance-alias');
  const agent = agents[0];
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'terminal-msg');
  assert.equal(agents.length, 1);
  assert.ok(agent && chat);
  assert.equal(agent.attributes[ATTR.AGENT_ID], agentId);
  assert.equal(
    agent.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
    'terminal-agent-call',
  );
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'canonical result' }]),
  );
  assert.equal(spanParentId(chat), agent.spanContext().spanId);
});

test('duplicate late SubagentStop after completion emits no extra marker or chat', async (t) => {
  const { exporter, daemon, sid, agentId, subPath } = await boundAgent(t, 'late-stop');
  const stop = {
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  };
  await daemon.routeEvent(stop);
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call', tool_response: 'done' });
  await daemon.routeEvent(stop);
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore').length, 1);
  assert.equal(spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'sub-msg-1').length, 1);
});

test('Agent failure before SubagentStop closes the original marker once', async (t) => {
  const { exporter, daemon, sid, agentId, subPath } = await boundAgent(t, 'failure-first');
  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure', session_id: sid, tool_use_id: 'agent-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'do it' },
    error: 'AgentError: failed',
  });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.ERROR_TYPE], 'AgentError');
  assert.equal(
    agents[0].attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'AgentError: failed' }]),
  );
  assert.equal(spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'sub-msg-1').length, 1);
});

test('repeated SubagentStop snapshots retain parenting and emit only new responses', async (t) => {
  const { exporter, daemon, sid, agentId, subPath } = await boundAgent(t, 'repeated-stop');
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'late-tool', tool_name: 'Read', tool_input: { file_path: '/after-stop' },
  });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'late-tool', tool_response: 'ok' });
  fs.appendFileSync(subPath, JSON.stringify(assistantEntry(
    'sub-msg-2',
    { type: 'text', text: 'continued' },
    { finishReason: 'end_turn' },
  )) + '\n');
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call', tool_response: 'done' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const tool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'late-tool');
  assert.ok(agent && tool);
  assert.equal(spanParentId(tool), agent.spanContext().spanId);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'done' }]),
  );
  assert.deepEqual(
    spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat')
      .map(span => span.attributes[ATTR.RESPONSE_ID]).sort(),
    ['sub-msg-1', 'sub-msg-2'],
  );
});
