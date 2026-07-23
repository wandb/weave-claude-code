// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test, type TestContext } from 'node:test';
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

async function boundAgent(t: TestContext, label: string) {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = `sub-${label}`;
  const agentId = `${label}-agent`;
  const transcript = makeTranscript(t, sid, label);
  transcript.append(userEntry('delegate it'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('do it'),
    assistantEntry('sub-msg-1', { type: 'text', text: 'done' }, {
      usage: { input_tokens: 120, output_tokens: 30 },
      finishReason: 'end_turn',
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate it' });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'agent-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'do it' },
  });
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  return { exporter, daemon, sid, agentId, transcript, subPath };
}

async function finish(daemon: ReturnType<typeof makeGenaiDaemon>, sid: string) {
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();
}

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
    assert.equal(spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
      && span.attributes[ATTR.AGENT_NAME] === displayName).length, 1);
    assert.equal(spans.some(span =>
      span.attributes['gen_ai.tool.call.id'] === `${label}-agent-call`), false);
  });
}

test('declared and wildcard Agent candidates with the same prompt stay ambiguous', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-mixed-type-candidates';
  const agentId = 'mixed-type-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate twice'));
  transcript.subagent(agentId, userEntry('same task'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate twice',
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid,
    tool_use_id: 'declared-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'same task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid,
    tool_use_id: 'wildcard-call', tool_name: 'Agent',
    tool_input: { name: 'instance-alias', prompt: 'same task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] !== 'claude-code');
  assert.equal(agents.length, 2);
  assert.equal(agents.some(span => span.attributes[ATTR.AGENT_ID] === agentId), false);
});

test('nested Agent call stays inside its owning subagent', async (t) => {
  const {
    exporter, daemon, sid, agentId: outerId, transcript, subPath: outerPath,
  } = await boundAgent(t, 'nested-agent');
  const innerId = 'inner-agent';
  const innerPath = transcript.subagent(
    innerId,
    userEntry('inner task'),
    assistantEntry('inner-msg', { type: 'text', text: 'inner done' }),
  );

  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: outerId,
    tool_use_id: 'inner-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Reviewer', prompt: 'inner task' },
  });
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: innerId, agent_type: 'Reviewer' });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: innerId,
    tool_use_id: 'inner-read', tool_name: 'Read', tool_input: { file_path: '/nested.ts' },
  });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, agent_id: innerId, tool_use_id: 'inner-read', tool_response: 'contents' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: innerId, agent_type: 'Reviewer', agent_transcript_path: innerPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, agent_id: outerId, tool_use_id: 'inner-call', tool_response: 'inner result' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: outerId, agent_type: 'Explore', agent_transcript_path: outerPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call', tool_response: 'outer result' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const turn = spans.find(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const outer = spans.find(span => span.attributes[ATTR.AGENT_ID] === outerId);
  const inner = spans.find(span => span.attributes[ATTR.AGENT_ID] === innerId);
  const innerChat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'inner-msg');
  const innerTool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'inner-read');
  assert.ok(turn && outer && inner && innerChat && innerTool);
  assert.equal(spanParentId(outer), turn.spanContext().spanId);
  assert.equal(spanParentId(inner), outer.spanContext().spanId);
  assert.equal(spanParentId(innerChat), inner.spanContext().spanId);
  assert.equal(spanParentId(innerTool), inner.spanContext().spanId);
  assert.equal(inner.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'inner result' },
  ]));
  assert.equal(outer.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'outer result' },
  ]));
});

test('Agent Post before SubagentStop waits for the transcript without duplicating the Agent', async (t) => {
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

test('exact prompt selects the right call among same-type Agent dispatches', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-exact-prompt';
  const agentId = 'exact-agent';
  const transcript = makeTranscript(t, sid, 'sub-exact-prompt');
  transcript.append(userEntry('dispatch twice'));
  const subPath = transcript.subagent(
    agentId,
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] },
    },
    userEntry('second task'),
    assistantEntry('exact-msg', { type: 'text', text: 'second done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch twice' });
  for (const [toolUseId, prompt] of [['agent-first', 'task'], ['agent-second', 'second task']]) {
    await daemon.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: toolUseId,
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt },
    });
  }
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-second', tool_response: 'second result' });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-first', tool_response: 'first result' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const matched = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'exact-msg');
  assert.equal(agents.length, 2);
  assert.ok(matched && chat);
  assert.equal(
    matched.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', content: 'second task' }]),
  );
  assert.equal(spanParentId(chat), matched.spanContext().spanId);
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

test('unknown agent_id is rejected instead of flattened under the turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-unknown';
  const transcript = makeTranscript(t, sid, 'sub-unknown');
  transcript.append(userEntry('start'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'start' });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: 'not-bound',
    tool_use_id: 'wrong-parent', tool_name: 'Read', tool_input: {},
  });
  await finish(daemon, sid);
  assert.equal(exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'execute_tool').length, 0);
});
