// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import {
  ATTR, MEMBER, TEAM, assert, assistantEntry, childrenOf, coordinator, dispatch,
  flushWeave, fs, initWeaveInMemory, makeGenaiDaemon, makeTranscript, postDispatch,
  preDispatch, spanParentId, teammateEntries, test, userEntry, writeMetadata,
} from './agent-team-test-helpers.ts';

test('same-name respawns consume distinct transcripts and duplicate idle is idempotent', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'fifo');
  await dispatch(daemon, sid, 'team-call-1', 'first', {
    description: 'first review', prompt: 'first', name: MEMBER,
  });
  await dispatch(daemon, sid, 'team-call-2', 'second', {
    description: 'second review', prompt: 'second', name: MEMBER,
  });

  const firstPath = transcript.subagent(
    'first', ...teammateEntries('teammate-1', 'first result', 'team-msg-1', 'general-purpose'));
  const secondPath = transcript.subagent(
    'second', ...teammateEntries('teammate-2', 'second result', 'team-msg-2', 'general-purpose'));
  writeMetadata(firstPath, 'general-purpose');
  writeMetadata(secondPath, 'general-purpose');

  // A teammate session can also emit SubagentStart. The queued coordinator
  // dispatch owns it, so this must not manufacture a second Agent marker.
  const teammateSession = makeTranscript(t, 'teammate-1', 'team-external');
  teammateSession.append(...teammateEntries(
    'teammate-1', 'first result', 'team-msg-1', 'general-purpose',
  ));
  const secondTeammateSession = makeTranscript(t, 'teammate-2', 'team-external-second');
  secondTeammateSession.append(...teammateEntries(
    'teammate-2', 'second result', 'team-msg-2', 'general-purpose',
  ));
  const externalId = 'external-lifecycle';
  teammateSession.subagent(
    externalId,
    ...teammateEntries('teammate-1', 'first result', 'external-msg', 'general-purpose'),
  );
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: 'teammate-1',
    transcript_path: teammateSession.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: 'teammate-1',
    agent_id: externalId, agent_type: 'general-purpose',
  });

  const firstIdle = {
    hook_event_name: 'TeammateIdle', session_id: 'teammate-1',
    transcript_path: teammateSession.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(firstIdle);
  fs.appendFileSync(firstPath, `${JSON.stringify(assistantEntry(
    'mutated-after-idle',
    { type: 'text', text: 'late mutation' },
  ))}\n`);
  await daemon.routeEvent(firstIdle); // duplicate must not consume call 2
  await daemon.routeEvent({
    ...firstIdle,
    session_id: 'teammate-2',
    transcript_path: secondTeammateSession.file,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span =>
    ['team-call-1', 'team-call-2'].includes(
      String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]),
    ));
  assert.equal(agents.length, 2);
  assert.deepEqual(
    Object.fromEntries(agents.map(span => [
      span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
      span.attributes[ATTR.OUTPUT_MESSAGES],
    ])),
    {
      'team-call-1': JSON.stringify([{ role: 'assistant', content: 'first result' }]),
      'team-call-2': JSON.stringify([{ role: 'assistant', content: 'second result' }]),
    },
  );
  assert.equal(spans.some(span => span.attributes[ATTR.AGENT_ID] === externalId), false);
  assert.deepEqual(
    spans.filter(span => span.attributes[ATTR.WEAVE_DISPLAY_NAME] === `Teammate: ${MEMBER}`)
      .flatMap(turn => childrenOf(spans, turn))
      .map(span => span.attributes[ATTR.RESPONSE_ID])
      .sort(),
    ['team-msg-1', 'team-msg-2'],
  );
});

test('same-session agent-setting lifecycle waits for TeammateIdle', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'team-same-session';
  const transcript = makeTranscript(t, sid, 'same-session');
  transcript.append(
    { type: 'last-prompt', sessionId: sid },
    userEntry('delegate reviews'),
    assistantEntry('same-session-root-msg', {
      type: 'text', text: 'root coordinator output',
    }),
  );
  const daemon = makeGenaiDaemon();
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sid,
    transcript_path: transcript.file, prompt: 'delegate reviews',
  });
  const agentId = 'same-session-agent';
  const subPath = transcript.subagent(
    agentId,
    ...teammateEntries(sid, 'same-session result', 'same-session-msg'),
  );
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: MEMBER,
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: MEMBER, agent_transcript_path: subPath,
  });
  assert.equal(exporter.getFinishedSpans().some(span => span.attributes[ATTR.AGENT_ID] === agentId), false);

  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: sid,
    transcript_path: transcript.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const teammateTurn = spans.find(span =>
    span.attributes[ATTR.WEAVE_DISPLAY_NAME] === `Teammate: ${MEMBER}`);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'same-session-msg');
  assert.ok(agent && teammateTurn && chat);
  assert.equal(spanParentId(chat), teammateTurn.spanContext().spanId);
  assert.notEqual(spanParentId(chat), agent.spanContext().spanId);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'same-session result' }]),
  );
});

test('current generic named Agent payload is traced as an implicit-team dispatch', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'implicit');
  const input = { description: 'review code', prompt: 'inspect it', name: MEMBER };
  await dispatch(daemon, sid, 'implicit-call', 'inspect it', input);

  const teammate = makeTranscript(t, 'implicit-member', 'implicit-member');
  teammate.append(
    { type: 'agent-setting', agentSetting: 'general-purpose', sessionId: 'implicit-member' },
    { type: 'user', teamName: TEAM, message: { role: 'user', content: 'task: implicit' } },
    assistantEntry('implicit-msg', { type: 'text', text: 'implicit result' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'implicit-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'implicit-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.AGENT_NAME], MEMBER);
  assert.equal(agent.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'implicit result' },
  ]));
});

test('a tentative named Agent failure still accepts its ordinary Stop transcript', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'named-failure');
  const input = { description: 'background work', prompt: 'ordinary failure', name: 'worker' };
  const agentId = 'ordinary-failed-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('ordinary failure'),
    assistantEntry('ordinary-failed-msg', { type: 'text', text: 'partial result' }),
  );
  await preDispatch(daemon, sid, 'ordinary-failed-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure', session_id: sid,
    tool_use_id: 'ordinary-failed-call', tool_name: 'Agent', tool_input: input,
    error: 'AgentError: failed after partial output',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'ordinary-failed-call');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.ERROR_TYPE], 'AgentError');
  assert.equal(agents[0].attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-failed-msg'));
});

test('agent-setting without a team remains an ordinary recovered lifecycle', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'ordinary-agent-setting');
  const agentId = 'ordinary-setting-agent';
  const subPath = transcript.subagent(
    agentId,
    { type: 'agent-setting', agentSetting: 'general-purpose', sessionId: sid },
    userEntry('ordinary recovered task'),
    assistantEntry('ordinary-setting-msg', { type: 'text', text: 'ordinary recovered result' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.AGENT_ID] === agentId);
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-setting-msg'));
});

test('an ordinary child inside a teammate session remains an ordinary Agent', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'teammate-with-child';
  const daemon = makeGenaiDaemon();
  const coordinatorTranscript = makeTranscript(t, 'child-coordinator', 'child-coordinator');
  coordinatorTranscript.append(userEntry('delegate reviews'));
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: 'child-coordinator',
    transcript_path: coordinatorTranscript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: 'child-coordinator',
    prompt: 'delegate reviews',
  });
  await dispatch(daemon, 'child-coordinator', 'child-coordinator-call', 'parent team task');
  const linked = coordinatorTranscript.subagent(
    'linked-parent', ...teammateEntries(sid, 'parent result', 'linked-parent-msg'),
  );
  writeMetadata(linked);

  const transcript = makeTranscript(t, sid, 'teammate-with-child');
  transcript.append(...teammateEntries(sid, 'parent result', 'parent-team-msg'));
  const agentId = 'ordinary-team-child';
  const subPath = transcript.subagent(
    agentId,
    { type: 'agent-setting', agentSetting: 'general-purpose', sessionId: sid },
    userEntry('ordinary nested task'),
    assistantEntry('ordinary-team-child-msg', { type: 'text', text: 'child result' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.AGENT_ID] === agentId);
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-team-child-msg'));
});

test('name-only Team alias remains the display name when lifecycle type differs', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'alias-type');
  const input = { name: 'instance-alias', prompt: 'research it' };
  const agentId = 'alias-type-agent';
  const subPath = transcript.subagent(
    agentId,
    { type: 'agent-setting', agentSetting: 'general-purpose', sessionId: sid },
    userEntry('research it'),
    { type: 'user', teamName: TEAM, message: { role: 'user', content: 'task: research it' } },
    assistantEntry('alias-type-msg', { type: 'text', text: 'researched' }),
  );

  await preDispatch(daemon, sid, 'alias-type-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await postDispatch(daemon, sid, 'alias-type-call', input);
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: sid,
    transcript_path: transcript.file, team_name: TEAM, teammate_name: 'instance-alias',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'alias-type-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.AGENT_NAME], 'instance-alias');
  assert.equal(agent.attributes[ATTR.AGENT_ID], agentId);
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'alias-type-msg'));
});

test('restart-first name-only Team learns lifecycle type and completes on idle', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'team-restart-name-only';
  const agentId = 'restart-name-only-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const subPath = transcript.subagent(
    agentId,
    { type: 'agent-setting', agentSetting: 'general-purpose', sessionId: sid },
    userEntry('research it'),
    { type: 'user', teamName: TEAM, message: { role: 'user', content: 'task: research it' } },
    assistantEntry('restart-name-msg', { type: 'text', text: 'restart result' }),
  );
  const daemon = makeGenaiDaemon();
  const input = { name: 'instance-alias', prompt: 'research it' };

  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    transcript_path: transcript.file, cwd: '/x',
    tool_use_id: 'restart-name-call', tool_name: 'Agent',
    tool_input: input, tool_response: 'dispatched',
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
    hook_event_name: 'TeammateIdle', session_id: sid,
    transcript_path: transcript.file, team_name: TEAM, teammate_name: 'instance-alias',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'restart-name-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.AGENT_NAME], 'instance-alias');
  assert.equal(agent.attributes[ATTR.AGENT_ID], agentId);
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'restart-name-msg'));
});

test('completed Team alias suppresses a delayed lifecycle with its recorded type', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'delayed-alias-type');
  const input = { name: 'instance-alias', prompt: 'research it' };
  await dispatch(daemon, sid, 'delayed-alias-call', 'research it', input);

  const teammateSessionId = 'delayed-alias-member';
  const teammate = makeTranscript(t, teammateSessionId, teammateSessionId);
  teammate.append(
    {
      type: 'agent-setting',
      agentSetting: 'general-purpose',
      sessionId: teammateSessionId,
    },
    {
      type: 'user',
      teamName: TEAM,
      message: { role: 'user', content: 'task: research it' },
    },
    assistantEntry('delayed-alias-msg', { type: 'text', text: 'researched' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle',
    session_id: teammateSessionId,
    transcript_path: teammate.file,
    team_name: TEAM,
    teammate_name: 'instance-alias',
  });

  const delayedAgentId = 'delayed-alias-lifecycle';
  const delayedPath = teammate.subagent(
    delayedAgentId,
    {
      type: 'agent-setting',
      agentSetting: 'general-purpose',
      sessionId: teammateSessionId,
    },
    {
      type: 'user',
      teamName: TEAM,
      message: { role: 'user', content: 'task: research it' },
    },
    assistantEntry('delayed-lifecycle-msg', { type: 'text', text: 'duplicate result' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'SessionStart',
    session_id: teammateSessionId,
    transcript_path: teammate.file,
    source: 'startup',
    cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: teammateSessionId,
    agent_id: delayedAgentId,
    agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop',
    session_id: teammateSessionId,
    agent_id: delayedAgentId,
    agent_type: 'general-purpose',
    agent_transcript_path: delayedPath,
  });
  await daemon.drain('SIGTERM');
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.some(span => span.attributes[ATTR.AGENT_ID] === delayedAgentId), false);
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]
      === 'delayed-alias-call').length, 1);
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'delayed-alias-msg').length, 1);
  assert.equal(spans.some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'delayed-lifecycle-msg'), false);
});

test('PermissionDenied closes an explicit Team and its deferred root once', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'permission-denied');
  const input = {
    subagent_type: MEMBER,
    prompt: 'review denied work',
    team_name: TEAM,
    name: MEMBER,
  };
  await preDispatch(daemon, sid, 'denied-team-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear',
  });
  await daemon.routeEvent({
    hook_event_name: 'PermissionDenied', session_id: sid,
    tool_use_id: 'denied-team-call', tool_name: 'Agent',
    tool_input: input, reason: 'auto mode denied',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'denied-team-call');
  const roots = spans.filter(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  assert.equal(agents.length, 1);
  assert.equal(roots.length, 1);
  assert.equal(agents[0].attributes[ATTR.ERROR_TYPE], 'permission_denied');
  assert.equal(spans.some(span =>
    span.attributes[ATTR.WEAVE_DISPLAY_NAME] === `Teammate: ${MEMBER}`), false);
});
