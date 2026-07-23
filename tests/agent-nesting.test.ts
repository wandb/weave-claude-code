// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTR } from '../src/genaiSpans.ts';
import {
  assistantEntry,
  initWeaveInMemory,
  makeGenaiDaemon,
  makeTranscript,
  spanParentId,
  userEntry,
} from './helpers.ts';
import { boundAgent, finish } from './agent-test-helpers.ts';

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

test('a nested Agent result cannot claim a matching root recovery', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-owner-scoped-recovery';
  const rootAgentId = 'root-reviewer';
  const ownerAgentId = 'nested-owner';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  transcript.subagent(rootAgentId, userEntry('same task'));
  transcript.subagent(ownerAgentId, userEntry('outer task'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sid,
    prompt_id: 'prompt-1', prompt: 'delegate it',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid, prompt_id: 'prompt-1',
    agent_id: rootAgentId, agent_type: 'Reviewer',
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    transcript_path: transcript.file, cwd: '/x', prompt_id: 'prompt-1',
    agent_id: ownerAgentId, agent_type: 'Explore',
    tool_use_id: 'nested-agent-result', tool_name: 'Agent',
    tool_input: { subagent_type: 'Reviewer', prompt: 'same task' },
    tool_response: 'nested result',
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    transcript_path: transcript.file, cwd: '/x', prompt_id: 'prompt-1',
    agent_id: 'unknown-owner',
    tool_use_id: 'unowned-agent-result', tool_name: 'Agent',
    tool_input: { subagent_type: 'Reviewer', prompt: 'same task' },
    tool_response: 'must stay unowned',
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const rootAgent = spans.find(span => span.attributes[ATTR.AGENT_ID] === rootAgentId);
  const owner = spans.find(span => span.attributes[ATTR.AGENT_ID] === ownerAgentId);
  const nested = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'nested-agent-result');
  assert.ok(rootAgent && owner && nested);
  assert.equal(spanParentId(nested), owner.spanContext().spanId);
  assert.equal(rootAgent.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID], undefined);
  assert.equal(
    nested.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'nested result' }]),
  );
  assert.equal(spans.some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'unowned-agent-result'), false);
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

for (const firstHook of ['PreToolUse', 'PostToolUse'] as const) {
  test(`restart-first nested ${firstHook} reconstructs the owning Agent`, async (t) => {
    const exporter = await initWeaveInMemory();
    exporter.reset();
    const sid = `nested-restart-${firstHook}`;
    const agentId = `owner-${firstHook}`;
    const transcript = makeTranscript(t, sid, sid);
    transcript.append(userEntry('delegate it'));
    transcript.subagent(agentId, userEntry('inspect the child'));
    const daemon = makeGenaiDaemon();
    const tool = {
      session_id: sid,
      transcript_path: transcript.file,
      cwd: '/x',
      prompt_id: 'prompt-1',
      agent_id: agentId,
      agent_type: 'Explore',
      tool_use_id: `read-${firstHook}`,
      tool_name: 'Read',
      tool_input: { file_path: '/nested.ts' },
    };

    if (firstHook === 'PreToolUse') {
      await daemon.routeEvent({ hook_event_name: firstHook, ...tool });
    }
    await daemon.routeEvent({
      hook_event_name: 'PostToolUse',
      ...tool,
      tool_response: 'contents',
    });
    await finish(daemon, sid);

    const spans = exporter.getFinishedSpans();
    const owner = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
    const child = spans.find(span =>
      span.attributes['gen_ai.tool.call.id'] === tool.tool_use_id);
    const turn = spans.find(span =>
      span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
      && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
    assert.ok(turn && owner && child);
    assert.equal(spanParentId(owner), turn.spanContext().spanId);
    assert.equal(spanParentId(child), owner.spanContext().spanId);
    assert.equal(
      owner.attributes[ATTR.INPUT_MESSAGES],
      JSON.stringify([{ role: 'user', content: 'inspect the child' }]),
    );
    assert.equal(child.attributes['gen_ai.tool.call.result'], 'contents');
  });
}

test('restart-first nested terminal hook without agent_type stays fail-closed', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'nested-restart-no-type';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  transcript.subagent('unknown-owner', userEntry('inspect the child'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'PostToolUse',
    session_id: sid,
    transcript_path: transcript.file,
    cwd: '/x',
    agent_id: 'unknown-owner',
    tool_use_id: 'unowned-read',
    tool_name: 'Read',
    tool_input: { file_path: '/nested.ts' },
    tool_response: 'contents',
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.some(span => span.attributes[ATTR.AGENT_ID] === 'unknown-owner'), false);
  assert.equal(spans.some(span => span.attributes['gen_ai.tool.call.id'] === 'unowned-read'), false);
});
