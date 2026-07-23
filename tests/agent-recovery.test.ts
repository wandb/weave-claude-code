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
import { finish } from './agent-test-helpers.ts';

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
    tool_input: { prompt: 'same task' },
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
    JSON.stringify([{ role: 'assistant', content: 'inspected' }]),
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

test('restart recovery keeps a later Agent call separate', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-recovery-separate';
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

  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, transcript_path: transcript.file,
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
  });
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
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const turns = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const later = agents.find(span => span !== recovered);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'recovered-msg');
  assert.equal(turns.length, 1);
  assert.equal(agents.length, 2);
  assert.ok(recovered && later && chat);
  assert.equal(spanParentId(recovered), turns[0].spanContext().spanId);
  assert.equal(spanParentId(chat), recovered.spanContext().spanId);
  assert.equal(spanParentId(later), turns[0].spanContext().spanId);
  assert.equal(recovered.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(later.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(
    recovered.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'done' }]),
  );
  assert.equal(
    later.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'must not replace the recovered transcript' }]),
  );
});
