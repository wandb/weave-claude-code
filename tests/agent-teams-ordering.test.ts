// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import {
  ATTR, MEMBER, TEAM, assert, assistantEntry, coordinator, dispatch, flushWeave, fs,
  initWeaveInMemory, makeGenaiDaemon, makeTranscript, postDispatch, preDispatch,
  startQueueBlocker, teammateEntries, test, userEntry, writeMetadata,
} from './agent-team-test-helpers.ts';

test('restart-first receipt stages metadata before queued reconstruction', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const daemon = makeGenaiDaemon();
  const sid = 'team-restart-receipt-owner';
  const transcript = makeTranscript(t, sid, 'restart-receipt');
  transcript.append(userEntry('delegate reviews'));
  const teammatePath = transcript.subagent(
    'restart-receipt-agent',
    ...teammateEntries(
      'restart-receipt-member', 'restart result', 'restart-receipt-msg',
    ),
  );
  writeMetadata(teammatePath);
  const { blocking } = await startQueueBlocker(t, daemon, 'restart-receipt');
  const input = {
    subagent_type: MEMBER, prompt: 'review', team_name: TEAM, name: MEMBER,
  };
  const post = daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    transcript_path: transcript.file, tool_use_id: 'restart-receipt-call',
    tool_name: 'Agent', tool_input: input, tool_response: 'dispatched',
  });
  const idle = daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'restart-receipt-member',
    team_name: TEAM, teammate_name: MEMBER,
  });

  await Promise.all([blocking, post, idle]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'restart-receipt-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'restart result' }]),
  );
});

test('queued duplicate SessionStart paths preserve the first owner root', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const daemon = makeGenaiDaemon();
  const sid = 'team-conflicting-start-owner';
  const first = makeTranscript(t, sid, 'conflicting-start-first');
  first.append(userEntry('delegate reviews'));
  const teammatePath = first.subagent(
    'conflicting-start-agent',
    ...teammateEntries(
      'conflicting-start-member', 'first-root result', 'conflicting-start-msg',
    ),
  );
  writeMetadata(teammatePath);
  const duplicate = makeTranscript(t, sid, 'conflicting-start-duplicate');
  duplicate.append(userEntry('wrong duplicate root'));
  const { blocking } = await startQueueBlocker(t, daemon, 'conflicting-start');
  const input = {
    subagent_type: MEMBER, prompt: 'review', team_name: TEAM, name: MEMBER,
  };
  const queued = [
    daemon.routeEvent({
      hook_event_name: 'SessionStart', session_id: sid,
      transcript_path: first.file, source: 'startup', cwd: '/x',
    }),
    daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit', session_id: sid,
      transcript_path: first.file, prompt: 'delegate reviews',
    }),
    daemon.routeEvent({
      hook_event_name: 'SessionStart', session_id: sid,
      transcript_path: duplicate.file, source: 'startup', cwd: '/x',
    }),
    preDispatch(daemon, sid, 'conflicting-start-call', input),
    postDispatch(daemon, sid, 'conflicting-start-call', input),
    daemon.routeEvent({
      hook_event_name: 'TeammateIdle', session_id: 'conflicting-start-member',
      team_name: TEAM, teammate_name: MEMBER,
    }),
  ];

  await Promise.all([blocking, ...queued]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'conflicting-start-call');
  assert.ok(agent);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'first-root result' }]),
  );
});

test('an idle older than a later normal Pre cannot consume that future dispatch', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'stale-idle');
  const input = { description: 'review code', prompt: 'later review', name: MEMBER };
  const teammate = makeTranscript(t, 'stale-member', 'stale-member');
  teammate.append(...teammateEntries('stale-member', 'stale result', 'stale-msg'));
  const route = daemon as unknown as {
    routeEvent(payload: Record<string, unknown>, sequence: number): Promise<void>;
  };
  await route.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'stale-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  }, 1);
  await route.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'later-call',
    tool_name: 'Agent', tool_input: input,
  }, 2);
  await route.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'later-call',
    tool_name: 'Agent', tool_input: input, tool_response: 'dispatched',
  }, 3);
  await flushWeave();
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'stale-msg'), false);

  await daemon.drain('SIGTERM');
  await flushWeave();
  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'later-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
});

test('restart-first Agent Post registers its dispatch and consumes an earlier idle', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'restart-post');
  const teammate = makeTranscript(t, 'restart-member', 'restart-member');
  teammate.append(...teammateEntries('restart-member', 'restart result', 'restart-team-msg'));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'restart-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'restart-team-call',
    tool_name: 'Agent',
    tool_input: { description: 'review code', prompt: 'restart review', name: MEMBER },
    tool_response: 'dispatched',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'restart-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.equal(agent.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'restart result' },
  ]));
});

test('partial teammate transcript retries without consuming the dispatch', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'partial');
  await dispatch(daemon, sid, 'partial-team-call', 'partial review');
  const teammate = makeTranscript(t, 'partial-member', 'partial-member');
  const [setting, user] = teammateEntries('partial-member', 'partial result', 'partial-msg');
  teammate.append(setting, user);
  const assistant = JSON.stringify(assistantEntry(
    'partial-msg',
    { type: 'text', text: 'partial result' },
  ));
  const split = assistant.length - 2;
  fs.appendFileSync(teammate.file, assistant.slice(0, split));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'partial-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };

  await daemon.routeEvent(idle);
  await flushWeave();
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'partial-team-call'), false);

  fs.appendFileSync(teammate.file, `${assistant.slice(split)}\n`);
  await daemon.routeEvent(idle);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'partial-msg'));
});

test('concurrent idle and duplicate Post emit one teammate response', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'concurrent-completion');
  const input = {
    subagent_type: MEMBER, prompt: 'concurrent review', team_name: TEAM, name: MEMBER,
  };
  await dispatch(daemon, sid, 'concurrent-team-call', 'concurrent review', input);
  const teammate = makeTranscript(t, 'concurrent-member', 'concurrent-member');
  const [setting, user] = teammateEntries(
    'concurrent-member', 'concurrent result', 'concurrent-team-msg',
  );
  teammate.append(setting, user);
  const assistant = JSON.stringify(assistantEntry(
    'concurrent-team-msg',
    { type: 'text', text: 'concurrent result' },
  ));
  const split = assistant.length - 2;
  fs.appendFileSync(teammate.file, assistant.slice(0, split));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'concurrent-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  const finishWrite = new Promise<void>(resolve => setTimeout(() => {
    fs.appendFileSync(teammate.file, `${assistant.slice(split)}\n`);
    resolve();
  }, 25));
  await Promise.all([
    daemon.routeEvent(idle),
    postDispatch(daemon, sid, 'concurrent-team-call', input),
    finishWrite,
  ]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'concurrent-team-call').length, 1);
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'concurrent-team-msg').length, 1);
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.WEAVE_DISPLAY_NAME] === `Teammate: ${MEMBER}`).length, 1);
});

test('a complete idle queued behind a partial idle is reconsidered automatically', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'concurrent-idles');
  await dispatch(daemon, sid, 'concurrent-idles-call', 'review once');
  const partial = makeTranscript(t, 'partial-idle-member', 'partial-idle-member');
  const [setting, user] = teammateEntries(
    'partial-idle-member', 'partial result', 'partial-idle-msg',
  );
  partial.append(setting, user);
  fs.appendFileSync(partial.file, '{"type":"assistant"');
  const complete = makeTranscript(t, 'complete-idle-member', 'complete-idle-member');
  complete.append(...teammateEntries(
    'complete-idle-member', 'complete result', 'complete-idle-msg',
  ));

  await Promise.all([
    daemon.routeEvent({
      hook_event_name: 'TeammateIdle', session_id: 'partial-idle-member',
      transcript_path: partial.file, team_name: TEAM, teammate_name: MEMBER,
    }),
    daemon.routeEvent({
      hook_event_name: 'TeammateIdle', session_id: 'complete-idle-member',
      transcript_path: complete.file, team_name: TEAM, teammate_name: MEMBER,
    }),
  ]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'concurrent-idles-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'complete-idle-msg'));
});

test('cross-session idles commit in global receipt order', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'idle-receipt-order');
  await dispatch(daemon, sid, 'ordered-team-call-1', 'first task');
  await dispatch(daemon, sid, 'ordered-team-call-2', 'second task');

  const first = makeTranscript(t, 'ordered-member-1', 'ordered-member-1');
  const [setting, user] = teammateEntries(
    'ordered-member-1', 'first result', 'ordered-team-msg-1',
  );
  first.append(setting, user);
  const assistant = JSON.stringify(assistantEntry(
    'ordered-team-msg-1',
    { type: 'text', text: 'first result' },
  ));
  const split = assistant.length - 2;
  fs.appendFileSync(first.file, assistant.slice(0, split));
  const second = makeTranscript(t, 'ordered-member-2', 'ordered-member-2');
  second.append(...teammateEntries(
    'ordered-member-2', 'second result', 'ordered-team-msg-2',
  ));

  const firstIdle = daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'ordered-member-1',
    transcript_path: first.file, team_name: TEAM, teammate_name: MEMBER,
  });
  const secondIdle = daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'ordered-member-2',
    transcript_path: second.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await new Promise<void>(resolve => setTimeout(() => {
    fs.appendFileSync(first.file, `${assistant.slice(split)}\n`);
    resolve();
  }, 25));
  await Promise.all([firstIdle, secondIdle]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID])
      .startsWith('ordered-team-call-'));
  assert.deepEqual(Object.fromEntries(agents.map(agent => [
    agent.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
    agent.attributes[ATTR.OUTPUT_MESSAGES],
  ])), {
    'ordered-team-call-1': JSON.stringify([{ role: 'assistant', content: 'first result' }]),
    'ordered-team-call-2': JSON.stringify([{ role: 'assistant', content: 'second result' }]),
  });
});

test('removing an ordinary candidate re-evaluates a buffered ambiguous idle', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const daemon = makeGenaiDaemon();
  const teamOwner = makeTranscript(t, 'reconcile-team-owner', 'reconcile-team-owner');
  const ordinaryOwner = makeTranscript(t, 'reconcile-ordinary-owner', 'reconcile-ordinary-owner');
  for (const [sid, transcript] of [
    ['reconcile-team-owner', teamOwner],
    ['reconcile-ordinary-owner', ordinaryOwner],
  ] as const) {
    transcript.append(userEntry('delegate reviews'));
    await daemon.routeEvent({
      hook_event_name: 'SessionStart', session_id: sid,
      transcript_path: transcript.file, source: 'startup', cwd: '/x',
    });
    await daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate reviews',
    });
  }

  const teamInput = { description: 'team work', prompt: 'team task', name: MEMBER };
  await dispatch(daemon, 'reconcile-team-owner', 'reconcile-team-call', 'team task', teamInput);
  const ordinaryInput = { description: 'ordinary work', prompt: 'ordinary task', name: MEMBER };
  const ordinaryId = 'reconcile-ordinary-agent';
  const ordinaryPath = ordinaryOwner.subagent(
    ordinaryId,
    userEntry('ordinary task'),
    assistantEntry('reconcile-ordinary-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, 'reconcile-ordinary-owner', 'reconcile-ordinary-call', ordinaryInput);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: 'reconcile-ordinary-owner',
    agent_id: ordinaryId, agent_type: MEMBER,
  });
  await postDispatch(
    daemon, 'reconcile-ordinary-owner', 'reconcile-ordinary-call', ordinaryInput,
  );

  const teammate = makeTranscript(t, 'reconcile-member', 'reconcile-member');
  teammate.append(...teammateEntries(
    'reconcile-member', 'team result', 'reconcile-team-msg',
  ));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'reconcile-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'reconcile-team-msg'), false);

  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: 'reconcile-ordinary-owner',
    agent_id: ordinaryId, agent_type: MEMBER, agent_transcript_path: ordinaryPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: 'reconcile-team-owner', reason: 'clear',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: 'reconcile-ordinary-owner', reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'reconcile-team-msg'));
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'reconcile-ordinary-msg'));
  for (const toolUseId of ['reconcile-team-call', 'reconcile-ordinary-call']) {
    const agent = spans.find(span =>
      span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === toolUseId);
    assert.ok(agent);
    assert.equal(agent.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  }
});

test('one disambiguation drains every ready buffered idle', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const daemon = makeGenaiDaemon();
  const teamOwner = makeTranscript(t, 'batch-team-owner', 'batch-team-owner');
  const blockerOwner = makeTranscript(t, 'batch-blocker-owner', 'batch-blocker-owner');
  for (const [sid, transcript] of [
    ['batch-team-owner', teamOwner],
    ['batch-blocker-owner', blockerOwner],
  ] as const) {
    transcript.append(userEntry('delegate reviews'));
    await daemon.routeEvent({
      hook_event_name: 'SessionStart', session_id: sid,
      transcript_path: transcript.file, source: 'startup', cwd: '/x',
    });
    await daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate reviews',
    });
  }

  for (let index = 0; index < 9; index++) {
    const input = { description: 'team work', prompt: `batch task ${index}`, name: MEMBER };
    await dispatch(daemon, 'batch-team-owner', `batch-team-call-${index}`, input.prompt, input);
  }
  const blockerInput = { description: 'ordinary work', prompt: 'blocker task', name: MEMBER };
  const blockerId = 'batch-blocker-agent';
  const blockerPath = blockerOwner.subagent(
    blockerId,
    userEntry('blocker task'),
    assistantEntry('batch-blocker-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, 'batch-blocker-owner', 'batch-blocker-call', blockerInput);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: 'batch-blocker-owner',
    agent_id: blockerId, agent_type: MEMBER,
  });
  await postDispatch(daemon, 'batch-blocker-owner', 'batch-blocker-call', blockerInput);

  for (let index = 0; index < 9; index++) {
    const memberSession = `batch-member-${index}`;
    const teammate = makeTranscript(t, memberSession, memberSession);
    teammate.append(...teammateEntries(
      memberSession, `batch result ${index}`, `batch-team-msg-${index}`,
    ));
    await daemon.routeEvent({
      hook_event_name: 'TeammateIdle', session_id: memberSession,
      transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
    });
  }
  assert.equal(exporter.getFinishedSpans().filter(span =>
    String(span.attributes[ATTR.RESPONSE_ID]).startsWith('batch-team-msg-')).length, 0);

  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: 'batch-blocker-owner',
    agent_id: blockerId, agent_type: MEMBER, agent_transcript_path: blockerPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: 'batch-team-owner', reason: 'clear',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: 'batch-blocker-owner', reason: 'clear',
  });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span =>
    String(span.attributes[ATTR.RESPONSE_ID]).startsWith('batch-team-msg-')).length, 9);
  assert.equal(spans.filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID])
      .startsWith('batch-team-call-')).length, 9);
});
