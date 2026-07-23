// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import {
  ATTR, MEMBER, TEAM, assert, assistantEntry, coordinator, dispatch, flushWeave,
  makeTranscript, postDispatch, preDispatch, spanParentId, teammateEntries, test,
  userEntry,
} from './agent-team-test-helpers.ts';

test('SessionEnd retains an exact team call despite optional metadata overflow', async (t) => {
  const promptId = 'session-end-prompt';
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'session-end', promptId);
  await dispatch(daemon, sid, 'deferred-team-call', 'inspect');
  for (let i = 0; i < 513; i++) {
    transcript.subagent(`unrelated-${i}`, {
      type: 'agent-setting', agentSetting: MEMBER, sessionId: `unrelated-${i}`,
    });
  }
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sid,
    transcript_path: transcript.file, prompt: 'delegate reviews', prompt_id: promptId,
  });

  const internals = daemon as unknown as { hasInFlightWork(): boolean };
  assert.equal(internals.hasInFlightWork(), true, 'deferred team work pins inactivity');
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'deferred-team-call'), false);

  const teammate = makeTranscript(t, 'fallback-teammate', 'team-fallback');
  teammate.append(...teammateEntries('fallback-teammate', 'fallback result', 'fallback-msg'));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'fallback-teammate',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'deferred-team-call');
  const root = spans.find(span => span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  assert.ok(agent && root);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'fallback result' }]),
  );
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(spanParentId(agent), root.spanContext().spanId);
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'fallback-msg'));
  assert.equal(internals.hasInFlightWork(), false, 'a duplicate prompt does not cancel SessionEnd');
});

test('generic implicit team work survives SessionEnd until TeammateIdle', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'implicit-session-end');
  const input = { description: 'review code', prompt: 'late review', name: MEMBER };
  await dispatch(daemon, sid, 'implicit-late-call', 'late review', input);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'implicit-late-call'), false);

  const teammate = makeTranscript(t, 'implicit-late-member', 'implicit-late-member');
  teammate.append(...teammateEntries(
    'implicit-late-member', 'late result', 'implicit-late-msg', 'general-purpose',
  ));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'implicit-late-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'implicit-late-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
});

test('ambiguous same-session markers fail closed and shutdown orphans all team markers', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'ambiguous');
  for (const agentId of ['idle-a', 'idle-b']) {
    transcript.subagent(
      agentId,
      { type: 'agent-setting', agentSetting: MEMBER, sessionId: sid },
      { type: 'user', teamName: 'local-team', message: { role: 'user', content: 'local task' } },
    );
    await daemon.routeEvent({
      hook_event_name: 'SubagentStart', session_id: sid,
      agent_id: agentId, agent_type: MEMBER,
    });
  }
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: sid,
    transcript_path: transcript.file, team_name: 'local-team', teammate_name: MEMBER,
  });
  await dispatch(daemon, sid, 'shutdown-dispatch', 'remote task');
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.some(span =>
    span.attributes[ATTR.WEAVE_DISPLAY_NAME] === `Teammate: ${MEMBER}`), false);
  const root = spans.find(span => span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agents = spans.filter(span =>
    ['idle-a', 'idle-b'].includes(String(span.attributes[ATTR.AGENT_ID]))
    || span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'shutdown-dispatch');
  assert.ok(root);
  assert.equal(agents.length, 3);
  for (const agent of agents) {
    assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
    assert.equal(spanParentId(agent), root.spanContext().spanId);
    assert.deepEqual(agent.endTime, root.endTime);
  }
});
