// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import {
  ATTR, MEMBER, TEAM, TeamCoordinator, assert, assistantEntry, coordinator, dispatch,
  flushWeave, fs, initWeaveInMemory, makeGenaiDaemon, makeTranscript, postDispatch,
  preDispatch, startQueueBlocker, teammateEntries, test, userEntry, writeMetadata,
} from './agent-team-test-helpers.ts';

test('receipt snapshot discovery fails closed at its candidate limit', (t) => {
  const owner = makeTranscript(t, 'bounded-snapshot-owner', 'bounded-snapshot');
  for (let i = 0; i < 65; i++) {
    owner.subagent(`candidate-${i}`, {
      type: 'agent-setting', agentSetting: MEMBER, sessionId: 'bounded-snapshot-member',
    });
  }
  assert.deepEqual(
    new TeamCoordinator().snapshotTranscripts(
      'bounded-snapshot-member', undefined, [], [owner.file],
    ),
    [],
  );

  const direct = makeTranscript(t, 'bounded-snapshot-member', 'bounded-snapshot-direct');
  direct.append({
    type: 'agent-setting', agentSetting: MEMBER, sessionId: 'bounded-snapshot-member',
  });
  const directSnapshots = new TeamCoordinator().snapshotTranscripts(
    'bounded-snapshot-member', direct.file, [], [owner.file],
  );
  assert.equal(directSnapshots.length, 1);
  assert.equal(directSnapshots[0].path, direct.file);
});

test('receipt discovery reads large first records without charging trailing transcript bytes', (t) => {
  const owner = makeTranscript(t, 'large-snapshot-owner', 'large-snapshot');
  const teammate = owner.subagent('large-candidate', {
    type: 'agent-setting', agentSetting: MEMBER, sessionId: 'large-snapshot-member',
    injectedContext: 'x'.repeat(300 * 1024),
  });
  for (let i = 0; i < 3; i++) {
    owner.subagent(
      `large-irrelevant-${i}`,
      { type: 'agent-setting', agentSetting: MEMBER, sessionId: `irrelevant-${i}` },
      { type: 'progress', data: 'x'.repeat(8 * 1024 * 1024) },
    );
  }
  const snapshots = new TeamCoordinator().snapshotTranscripts(
    'large-snapshot-member', undefined, [], [owner.file],
  );
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].path, teammate);
});

test('metadata correlation accepts a large injected first record', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'large-metadata');
  await dispatch(daemon, sid, 'large-metadata-call', 'review');
  const teammate = transcript.subagent(
    'large-metadata-candidate',
    {
      type: 'agent-setting', agentSetting: MEMBER, sessionId: 'large-metadata-member',
      injectedContext: 'x'.repeat(300 * 1024),
    },
    { type: 'user', teamName: TEAM, message: { role: 'user', content: 'task' } },
    assistantEntry('large-metadata-msg', { type: 'text', text: 'large result' }),
  );
  writeMetadata(teammate);
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'large-metadata-member',
    team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'large-metadata-call');
  assert.ok(agent);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'large result' }]),
  );
});

test('an undeclared team alias does not swallow an unrelated lifecycle without session evidence', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'unrelated-lifecycle');
  await dispatch(daemon, sid, 'pending-team-call', 'review it', {
    description: 'review code', prompt: 'review it', name: MEMBER,
  });

  const unrelated = makeTranscript(t, 'unrelated-session', 'unrelated-session');
  const agentId = 'unrelated-agent';
  unrelated.subagent(
    agentId,
    ...teammateEntries('unrelated-session', 'unrelated result', 'unrelated-msg', 'general-purpose'),
  );
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: 'unrelated-session',
    transcript_path: unrelated.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: 'unrelated-session',
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.AGENT_ID] === agentId).length, 1);
});

test('a matching prompt alone does not swallow an unrelated lifecycle', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'alias-lifecycle');
  const input = { description: 'review code', prompt: 'exact review task', name: MEMBER };
  await dispatch(daemon, sid, 'alias-team-call', 'exact review task', input);

  const teammate = makeTranscript(t, 'alias-member', 'alias-member');
  teammate.append(...teammateEntries(
    'alias-member', 'alias result', 'alias-team-msg', 'general-purpose',
  ));
  const agentId = 'alias-external-agent';
  const subPath = teammate.subagent(
    agentId,
    { type: 'agent-setting', agentSetting: 'general-purpose', sessionId: 'alias-member' },
    userEntry('exact review task'),
  );
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: 'alias-member',
    transcript_path: teammate.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: 'alias-member',
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: 'alias-member',
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'alias-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.some(span => span.attributes[ATTR.AGENT_ID] === agentId), true);
  assert.ok(spans.some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'alias-team-call'));
});

test('idle receipt snapshots a metadata-selected transcript', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const daemon = makeGenaiDaemon();
  const sid = 'team-metadata-boundary';
  const transcript = makeTranscript(t, sid, 'metadata-boundary');
  transcript.append(userEntry('delegate reviews'));
  const firstInput = {
    subagent_type: MEMBER, prompt: 'first', team_name: TEAM, name: MEMBER,
  };
  const secondInput = {
    subagent_type: MEMBER, prompt: 'second', team_name: TEAM, name: MEMBER,
  };
  const linked = transcript.subagent(
    'metadata-boundary-agent',
    ...teammateEntries(
      'metadata-boundary-member', 'first result', 'metadata-boundary-msg-1',
    ),
  );
  writeMetadata(linked);

  const { blocking } = await startQueueBlocker(t, daemon, 'metadata-boundary');
  const coordinatorStart = daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  const coordinatorPrompt = daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sid,
    transcript_path: transcript.file, prompt: 'delegate reviews',
  });
  const queuedDispatch = [
    preDispatch(daemon, sid, 'metadata-boundary-call-1', firstInput),
    postDispatch(daemon, sid, 'metadata-boundary-call-1', firstInput),
    preDispatch(daemon, sid, 'metadata-boundary-call-2', secondInput),
    postDispatch(daemon, sid, 'metadata-boundary-call-2', secondInput),
  ];
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'metadata-boundary-member',
    team_name: TEAM, teammate_name: MEMBER,
  };
  const firstIdle = daemon.routeEvent(idle);
  fs.appendFileSync(linked, [
    JSON.stringify({
      type: 'user', teamName: TEAM,
      message: { role: 'user', content: 'task: second' },
    }),
    JSON.stringify(assistantEntry(
      'metadata-boundary-msg-2',
      { type: 'text', text: 'second result' },
    )),
    '',
  ].join('\n'));
  const secondIdle = daemon.routeEvent(idle);
  await Promise.all([
    blocking, coordinatorStart, coordinatorPrompt,
    ...queuedDispatch, firstIdle, secondIdle,
  ]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID])
      .startsWith('metadata-boundary-call-'));
  assert.deepEqual(Object.fromEntries(agents.map(agent => [
    agent.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
    agent.attributes[ATTR.OUTPUT_MESSAGES],
  ])), {
    'metadata-boundary-call-1': JSON.stringify([{ role: 'assistant', content: 'first result' }]),
    'metadata-boundary-call-2': JSON.stringify([{ role: 'assistant', content: 'second result' }]),
  });
});

test('ambiguous exact transcript evidence cannot fall through to a weaker owner', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const daemon = makeGenaiDaemon();
  const owners = [
    { sid: 'ambiguous-owner-a', transcript: makeTranscript(t, 'ambiguous-owner-a', 'a') },
    { sid: 'ambiguous-owner-b', transcript: makeTranscript(t, 'ambiguous-owner-b', 'b') },
  ];
  for (const owner of owners) {
    owner.transcript.append(userEntry('delegate reviews'));
    await daemon.routeEvent({
      hook_event_name: 'SessionStart', session_id: owner.sid,
      transcript_path: owner.transcript.file, source: 'startup', cwd: '/x',
    });
    await daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit', session_id: owner.sid, prompt: 'delegate reviews',
    });
    await dispatch(daemon, owner.sid, `${owner.sid}-call`, 'same review');
  }
  for (const agentId of ['ambiguous-meta-a', 'ambiguous-meta-b']) {
    const candidate = owners[0].transcript.subagent(
      agentId,
      ...teammateEntries('ambiguous-idle-member', 'ambiguous result', `${agentId}-msg`),
    );
    writeMetadata(candidate);
  }
  const teammate = makeTranscript(t, 'ambiguous-idle-member', 'ambiguous-idle-member');
  teammate.append(...teammateEntries(
    'ambiguous-idle-member', 'weak result', 'ambiguous-weak-msg',
  ));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'ambiguous-idle-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'ambiguous-weak-msg'), false);
  const agents = spans.filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID])
      .startsWith('ambiguous-owner-'));
  assert.equal(agents.length, 2);
  for (const agent of agents) {
    assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
  }
});

test('completed lifecycle history remains scoped to its exact team', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'team-history');
  const firstInput = {
    subagent_type: MEMBER, prompt: 'team x task', team_name: 'team-x', name: MEMBER,
  };
  await dispatch(daemon, sid, 'team-x-call', 'team x task', firstInput);
  const member = makeTranscript(t, 'shared-team-session', 'shared-team-session');
  member.append(...teammateEntries(
    'shared-team-session', 'team x result', 'team-x-msg',
  ).map(entry => 'teamName' in entry ? { ...entry, teamName: 'team-x' } : entry));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'shared-team-session',
    transcript_path: member.file, team_name: 'team-x', teammate_name: MEMBER,
  });

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: 'shared-team-session',
    transcript_path: member.file, source: 'startup', cwd: '/x',
  });
  const agentId = 'team-y-lifecycle';
  const teamYPath = member.subagent(
    agentId,
    { type: 'agent-setting', agentSetting: MEMBER, sessionId: 'shared-team-session' },
    { type: 'user', teamName: 'team-y', message: { role: 'user', content: 'team y task' } },
    assistantEntry('team-y-msg', { type: 'text', text: 'team y result' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: 'shared-team-session',
    agent_id: agentId, agent_type: MEMBER, agent_transcript_path: teamYPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'shared-team-session',
    transcript_path: teamYPath, team_name: 'team-y', teammate_name: MEMBER,
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'team-y-msg'));
  const teamY = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  assert.ok(teamY);
  assert.equal(teamY.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
});
