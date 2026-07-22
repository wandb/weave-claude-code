// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test, type TestContext } from 'node:test';
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

test('a recovered Agent consumes only its first matching post-first result', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-two-post-first';
  const agentId = 'recovered-first-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('dispatch twice'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('same task'),
    assistantEntry('recovered-first-msg', { type: 'text', text: 'first done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch twice' });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: 'Explore',
  });
  for (const [toolUseId, toolResponse] of [['first-result', 'first result'], ['second-result', 'second result']]) {
    await daemon.routeEvent({
      hook_event_name: 'PostToolUse', session_id: sid,
      tool_use_id: toolUseId, tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', prompt: 'same task' },
      tool_response: toolResponse,
    });
  }
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const later = agents.find(span => span !== recovered);
  assert.equal(agents.length, 2);
  assert.ok(recovered && later);
  assert.equal(recovered.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID], 'first-result');
  assert.equal(later.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID], 'second-result');
  assert.equal(
    recovered.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'first result' }]),
  );
  assert.equal(
    later.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'second result' }]),
  );
});

test('exact prompt beyond the first 64 KiB selects the right Agent dispatch', async (t) => {
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
      message: {
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>${'x'.repeat(70 * 1024)}</system-reminder>` }],
      },
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

test('prefix-colliding restart prompts remain separate partial Agent markers', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-incompatible-recovery';
  const agentId = 'prefix-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('dispatch'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('prefix task'),
    assistantEntry('prefix-msg', { type: 'text', text: 'prefix output' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure', session_id: sid, transcript_path: transcript.file,
    tool_use_id: 'fix-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'fix' }, error: 'AgentError: fix failed',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const failed = agents.find(span => span.attributes[ATTR.ERROR_TYPE] === 'AgentError');
  const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'prefix-msg');
  assert.equal(agents.length, 2);
  assert.ok(failed && recovered && chat);
  assert.equal(failed.attributes[ATTR.AGENT_ID], undefined);
  assert.equal(recovered.attributes[ATTR.ERROR_TYPE], undefined);
  assert.equal(spanParentId(chat), recovered.spanContext().spanId);
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

test('ambiguous prompt correlation never fabricates a third marker', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-ambiguous';
  const agentId = 'ambiguous-agent';
  const transcript = makeTranscript(t, sid, 'sub-ambiguous');
  transcript.append(userEntry('dispatch twice'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('different prompt'),
    assistantEntry('ambiguous-msg', { type: 'text', text: 'done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch twice' });
  for (const [toolUseId, prompt] of [['agent-a', 'first'], ['agent-b', 'second']]) {
    await daemon.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: toolUseId,
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt },
    });
  }
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-a', tool_response: 'a' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-b', tool_response: 'b' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore').length, 2);
  const turn = spans.find(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'ambiguous-msg');
  assert.ok(turn && chat);
  assert.equal(spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'ambiguous-msg').length, 1);
  assert.equal(spanParentId(chat), turn.spanContext().spanId);
});

test('ambiguous recovered Agent result never fabricates a third marker', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-ambiguous-recovery';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('dispatch twice'));
  const agentIds = ['recovered-a', 'recovered-b'];
  for (const agentId of agentIds) transcript.subagent(agentId, userEntry('same task'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch twice' });
  for (const agentId of agentIds) {
    await daemon.routeEvent({
      hook_event_name: 'SubagentStart', session_id: sid,
      agent_id: agentId, agent_type: 'Explore',
    });
  }
  const terminal = {
    hook_event_name: 'PostToolUse', session_id: sid,
    tool_use_id: 'ambiguous-result', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'same task' },
    tool_response: 'unknown owner',
  };
  await daemon.routeEvent(terminal);
  await daemon.routeEvent({ ...terminal, hook_event_name: 'PreToolUse' });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 2);
  assert.deepEqual(
    agents.map(span => span.attributes[ATTR.AGENT_ID]).sort(),
    agentIds,
  );
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

test('restart-first SubagentStart recovers a parent for child hooks', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-recovery-start-first';
  const agentId = 'start-first-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid, transcript_path: transcript.file,
    agent_id: agentId, agent_type: 'Explore',
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    tool_use_id: 'missing-start-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'inspect it' },
    tool_response: 'canonical result',
  });
  const subPath = transcript.subagent(
    agentId,
    userEntry('inspect it'),
    assistantEntry('start-first-msg', { type: 'text', text: 'inspected' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'start-first-tool', tool_name: 'Read', tool_input: { file_path: '/x' },
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'start-first-tool', tool_response: 'contents',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid,
    tool_use_id: 'missing-start-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'inspect it' },
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const agent = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const tool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'start-first-tool');
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'start-first-msg');
  assert.equal(agents.length, 1);
  assert.ok(agent && tool && chat);
  assert.equal(spanParentId(tool), agent.spanContext().spanId);
  assert.equal(spanParentId(chat), agent.spanContext().spanId);
  assert.equal(
    agent.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', content: 'inspect it' }]),
  );
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'canonical result' }]),
  );
});

test('a Stop-first recovered Agent keeps its prompt turn open', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-recovery-retained-turn';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('older prompt'));
  const agentId = 'retained-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('background task'),
    assistantEntry('retained-msg', { type: 'text', text: 'still working' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt_id: 'older', prompt: 'older prompt' });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, prompt_id: 'older',
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, prompt_id: 'older',
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
    last_assistant_message: 'continued',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt_id: 'newer', prompt: 'newer prompt' });

  assert.equal(exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code').length, 0);

  await finish(daemon, sid);
  const spans = exporter.getFinishedSpans();
  const turns = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agent = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  assert.equal(spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore').length, 1);
  assert.equal(turns.length, 2);
  assert.ok(agent);
  const parent = turns.find(turn => turn.spanContext().spanId === spanParentId(agent));
  assert.ok(parent);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'still working\ncontinued' }]),
  );
  assert.deepEqual(
    spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat')
      .map(span => span.attributes[ATTR.RESPONSE_ID]).sort(),
    ['retained-msg'],
  );
});

for (const matchingResult of [false, true]) {
  test(`restart recovery ${matchingResult ? 'retains a matching Post outcome' : 'keeps a later Agent call separate'}`, async (t) => {
    const exporter = await initWeaveInMemory();
    exporter.reset();
    const sid = `sub-recovery-${matchingResult}`;
    const agentId = 'recovered-agent';
    const transcript = makeTranscript(t, sid, 'sub-recovery');
    transcript.append(
      userEntry('delegate it'),
      assistantEntry('main-msg', { type: 'text', text: 'working' }),
    );
    const subPath = transcript.subagent(
      agentId,
      userEntry('recover me'),
      assistantEntry('recovered-msg', { type: 'text', text: 'done' }, {
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
    );
    const daemon = makeGenaiDaemon();
    if (matchingResult) {
      await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: transcript.file, prompt: 'delegate it' });
    }

    await daemon.routeEvent({
      hook_event_name: 'SubagentStop', session_id: sid, transcript_path: transcript.file,
      agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
    });
    if (matchingResult) {
      await daemon.routeEvent({
        hook_event_name: 'PostToolUseFailure', session_id: sid, transcript_path: transcript.file,
        tool_use_id: 'lost-agent-call', tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: 'recover me' },
        error: 'AgentError: restart failure',
      });
    } else {
      await daemon.routeEvent({
        hook_event_name: 'PreToolUse', session_id: sid,
        tool_use_id: 'lost-agent-call', tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: 'different task' },
      });
      await daemon.routeEvent({
        hook_event_name: 'PostToolUse', session_id: sid, transcript_path: transcript.file,
        tool_use_id: 'lost-agent-call', tool_name: 'Agent',
        tool_input: { subagent_type: 'Explore', prompt: 'different task' },
        tool_response: 'must not replace the recovered transcript',
      });
    }
    await finish(daemon, sid);

    const spans = exporter.getFinishedSpans();
    const turns = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
      && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
    const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
      && span.attributes[ATTR.AGENT_NAME] === 'Explore');
    const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
    const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'recovered-msg');
    assert.equal(turns.length, 1);
    assert.equal(agents.length, matchingResult ? 1 : 2);
    assert.ok(recovered && chat);
    assert.equal(spanParentId(recovered), turns[0].spanContext().spanId);
    assert.equal(spanParentId(chat), recovered.spanContext().spanId);
    assert.equal(recovered.attributes[ATTR.ERROR_TYPE], matchingResult ? 'AgentError' : undefined);
    assert.equal(
      recovered.attributes[ATTR.WEAVE_ORPHAN_REASON],
      undefined,
    );
    assert.equal(
      recovered.attributes[ATTR.OUTPUT_MESSAGES],
      JSON.stringify([{
        role: 'assistant',
        content: matchingResult ? 'AgentError: restart failure' : 'done',
      }]),
    );
    if (!matchingResult) {
      const later = agents.find(span => span !== recovered);
      assert.ok(later);
      assert.equal(spanParentId(later), turns[0].spanContext().spanId);
      assert.equal(later.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
      assert.equal(
        later.attributes[ATTR.OUTPUT_MESSAGES],
        JSON.stringify([{ role: 'assistant', content: 'must not replace the recovered transcript' }]),
      );
    }
  });
}
