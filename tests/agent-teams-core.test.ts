// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { TestContext } from 'node:test';
import {
  ATTR,
  MEMBER,
  TEAM,
  assert,
  assistantEntry,
  coordinator,
  dispatch,
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  makeTranscript,
  postDispatch,
  preDispatch,
  spanParentId,
  teammateEntries,
  test,
  userEntry,
} from './agent-team-test-helpers.ts';

const teamInput = (prompt: string): Record<string, unknown> => ({
  subagent_type: MEMBER,
  prompt,
  team_name: TEAM,
  name: MEMBER,
});

async function idle(
  t: TestContext,
  daemon: ReturnType<typeof makeGenaiDaemon>,
  label: string,
  text: string,
  responseId: string,
) {
  const sessionId = `${label}-member`;
  const transcript = makeTranscript(t, sessionId, label);
  transcript.append(...teammateEntries(sessionId, text, responseId));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle',
    session_id: sessionId,
    transcript_path: transcript.file,
    team_name: TEAM,
    teammate_name: MEMBER,
  });
}

test('explicit team dispatch completes on TeammateIdle', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'direct-idle');
  await dispatch(daemon, sid, 'team-call', 'review');
  await idle(t, daemon, 'direct-idle', 'review result', 'team-msg');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'review result' },
  ]));
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'team-msg'));
  assert.ok(spans.some(span =>
    span.attributes[ATTR.WEAVE_DISPLAY_NAME] === `Teammate: ${MEMBER}`));
});

test('an ordinary named background Agent completes through SubagentStop', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'named-background');
  const input = { description: 'background work', prompt: 'ordinary task', name: 'worker' };
  const agentId = 'ordinary-named-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('ordinary task'),
    assistantEntry('ordinary-named-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, sid, 'ordinary-named-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
  });
  await postDispatch(daemon, sid, 'ordinary-named-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
    agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'ordinary-named-call');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-named-msg'));
});

test('an explicit Team call survives SessionEnd', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'session-end');
  await dispatch(daemon, sid, 'deferred-team-call', 'inspect');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });

  const internals = daemon as unknown as { hasInFlightWork(): boolean };
  assert.equal(internals.hasInFlightWork(), true);
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'deferred-team-call'), false);

  await idle(t, daemon, 'session-end', 'inspection result', 'session-end-msg');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'deferred-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(internals.hasInFlightWork(), false);
});

test('SessionEnd closes nested tools before retaining their Team Agent', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'nested-session-end');
  const input = teamInput('inspect');
  await preDispatch(daemon, sid, 'nested-team-call', input);
  const agentId = 'nested-team-agent';
  transcript.subagent(agentId, userEntry('inspect'));
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: sid,
    agent_id: agentId,
    agent_type: MEMBER,
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse',
    session_id: sid,
    agent_id: agentId,
    tool_use_id: 'nested-team-read',
    tool_name: 'Read',
    tool_input: { file_path: '/still-open.ts' },
  });
  await postDispatch(daemon, sid, 'nested-team-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushWeave();

  const nestedTool = exporter.getFinishedSpans().find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'nested-team-read');
  assert.ok(nestedTool);
  assert.equal(nestedTool.attributes[ATTR.WEAVE_ORPHAN_REASON], 'session_ended');
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'nested-team-call'), false);

  await idle(t, daemon, 'nested-session-end', 'nested result', 'nested-team-msg');
  await flushWeave();
  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'nested-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(spanParentId(nestedTool), agent.spanContext().spanId);
});

test('SessionEnd waits for an ordinary named Agent Stop and Post', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'named-session-end');
  const input = { description: 'background work', prompt: 'ordinary task', name: 'worker' };
  const agentId = 'ordinary-ended-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('ordinary task'),
    assistantEntry('ordinary-ended-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, sid, 'ordinary-ended-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
    agent_transcript_path: subPath,
  });
  await postDispatch(daemon, sid, 'ordinary-ended-call', input);
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'ordinary-ended-call');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-ended-msg'));
});

test('new work cancels a deferred SessionEnd', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'resume-after-end');
  await dispatch(daemon, sid, 'resume-team-call', 'late review');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });

  transcript.append(userEntry('continue after resume'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt_id: 'resumed-prompt',
    prompt: 'continue after resume',
  });
  await idle(t, daemon, 'resume-after-end', 'late result', 'resume-after-end-msg');
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code'
    && String(span.attributes[ATTR.INPUT_MESSAGES]).includes('continue after resume')), false);

  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    prompt_id: 'resumed-prompt',
    reason: 'clear',
  });
  await flushWeave();
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code'
    && String(span.attributes[ATTR.INPUT_MESSAGES]).includes('continue after resume')), true);
});

test('a failed team spawn closes its deferred owner', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'failure');
  const input = teamInput('fail review');
  await preDispatch(daemon, sid, 'failed-team-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'failed-team-call'), false);

  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure',
    session_id: sid,
    tool_use_id: 'failed-team-call',
    tool_name: 'Agent',
    tool_input: input,
    error: 'SpawnError: unavailable',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'failed-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.ERROR_TYPE], 'SpawnError');
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(spans.some(span => span.attributes[ATTR.AGENT_NAME] === 'claude-code'));
});

test('legacy team work retains only its exact owning turn', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'legacy-owner-turn');
  await dispatch(daemon, sid, 'legacy-owner-call', 'background review');
  for (const prompt of ['second prompt', 'third prompt']) {
    transcript.append(userEntry(prompt));
    await daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: sid,
      transcript_path: transcript.file,
      prompt,
    });
  }

  const finishedRoots = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  assert.equal(finishedRoots.length, 1);

  await idle(t, daemon, 'legacy-owner-turn', 'background result', 'legacy-owner-msg');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushWeave();
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'legacy-owner-msg'));
});

test('legacy team work does not retain a later turn before an explicit prompt', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'mixed-owner-turn');
  await dispatch(daemon, sid, 'mixed-owner-call', 'background review');

  transcript.append(userEntry('second legacy prompt'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt: 'second legacy prompt',
  });
  transcript.append(userEntry('third explicit prompt'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt_id: 'third-prompt-id',
    prompt: 'third explicit prompt',
  });

  const finishedRoots = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  assert.equal(finishedRoots.length, 1);
  assert.ok(String(finishedRoots[0].attributes[ATTR.INPUT_MESSAGES])
    .includes('second legacy prompt'));

  await idle(t, daemon, 'mixed-owner-turn', 'background result', 'mixed-owner-msg');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    prompt_id: 'third-prompt-id',
    reason: 'clear',
  });
  await flushWeave();
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'mixed-owner-msg'));
});

test('shutdown orphans an explicit Team Agent', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'shutdown');
  await dispatch(daemon, sid, 'shutdown-team-call', 'remote task');
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const root = spans.find(span => span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'shutdown-team-call');
  assert.ok(root && agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
  assert.equal(spanParentId(agent), root.spanContext().spanId);
  assert.deepEqual(agent.endTime, root.endTime);
});
