// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import {
  ATTR, MEMBER, TEAM, assert, assistantEntry, coordinator, dispatch, flushWeave, fs,
  makeTranscript, postDispatch, preDispatch, teammateEntries, test, userEntry,
} from './agent-team-test-helpers.ts';
import {
  MAX_TEAM_TRANSCRIPT_BYTES,
  readNewTurns,
  snapshot,
} from '../src/teamTranscripts.ts';

test('oversized teammate snapshots and partial-line extensions fail closed', async (t) => {
  const oversized = makeTranscript(t, 'oversized-team', 'oversized-team');
  fs.writeFileSync(oversized.file, Buffer.alloc(MAX_TEAM_TRANSCRIPT_BYTES + 1, 0x20));
  assert.equal(snapshot(oversized.file), undefined);
  assert.equal(await readNewTurns(oversized.file), undefined);

  const partial = makeTranscript(t, 'partial-team', 'partial-team');
  fs.writeFileSync(partial.file, '{"type":"assistant"');
  const receipt = snapshot(partial.file);
  assert.ok(receipt);
  fs.appendFileSync(
    partial.file,
    Buffer.alloc(MAX_TEAM_TRANSCRIPT_BYTES - receipt.size + 1, 0x20),
  );
  fs.appendFileSync(partial.file, '\n');
  assert.equal(await readNewTurns(partial.file, undefined, receipt), undefined);
});

test('same-inode transcript regression cannot reset and replay progress', async (t) => {
  const transcript = makeTranscript(t, 'regressed-team', 'regressed-team');
  transcript.append(...teammateEntries(
    'regressed-team', 'first result', 'regressed-team-msg',
  ));
  const firstSnapshot = snapshot(transcript.file);
  assert.ok(firstSnapshot);
  const first = await readNewTurns(transcript.file, undefined, firstSnapshot);
  assert.ok(first);

  fs.truncateSync(transcript.file, 0);
  transcript.append(
    { type: 'agent-setting', agentSetting: MEMBER, sessionId: 'regressed-team' },
    {
      type: 'user',
      teamName: TEAM,
      message: { role: 'user', content: 'replacement task' },
    },
    assistantEntry('rewritten-team-msg', [
      { type: 'text', text: 'replacement prefix' },
      { type: 'text', text: 'replacement tail' },
    ]),
  );
  const regressedSnapshot = snapshot(transcript.file);
  assert.ok(regressedSnapshot);
  assert.equal(regressedSnapshot.inode, firstSnapshot.inode);
  assert.equal(
    await readNewTurns(transcript.file, first[1], regressedSnapshot),
    undefined,
  );

  const replacement = `${transcript.file}.replacement`;
  fs.writeFileSync(
    replacement,
    teammateEntries(
      'regressed-team',
      'replacement result',
      'replacement-team-msg',
    ).map(entry => JSON.stringify(entry)).join('\n') + '\n',
  );
  fs.renameSync(replacement, transcript.file);
  const replacedSnapshot = snapshot(transcript.file);
  assert.ok(replacedSnapshot);
  assert.notEqual(replacedSnapshot.inode, firstSnapshot.inode);
  assert.equal(
    await readNewTurns(transcript.file, first[1], replacedSnapshot),
    undefined,
  );
});

test('provider progress advances within one turn and ignores non-provider growth', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'response-progress');
  await dispatch(daemon, sid, 'response-progress-1', 'first');
  await dispatch(daemon, sid, 'response-progress-2', 'second');
  const teammate = makeTranscript(t, 'response-progress-member', 'response-progress-member');
  teammate.append(...teammateEntries(
    'response-progress-member', 'first result', 'response-progress-msg-1',
  ));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'response-progress-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(idle);
  teammate.append({ type: 'progress', message: { role: 'system', content: 'still working' } });
  await daemon.routeEvent(idle);
  teammate.append(assistantEntry(
    'response-progress-msg-2',
    { type: 'text', text: 'second result' },
  ));
  await daemon.routeEvent(idle);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID])
      .startsWith('response-progress-'));
  assert.equal(agents.length, 2);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'response-progress-msg-2'));
});

test('a stale idle with only non-provider growth cannot confirm the next named Agent', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'stale-idle');
  await dispatch(daemon, sid, 'stale-team-call', 'first team task');
  const teammate = makeTranscript(t, 'stale-team-member', 'stale-team-member');
  teammate.append(...teammateEntries(
    'stale-team-member', 'team result', 'stale-team-msg',
  ));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'stale-team-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(idle);

  const input = { description: 'ordinary work', prompt: 'ordinary next task', name: MEMBER };
  const agentId = 'ordinary-after-stale-idle';
  const subPath = transcript.subagent(
    agentId,
    userEntry('ordinary next task'),
    assistantEntry('ordinary-after-stale-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, sid, 'ordinary-after-stale-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await postDispatch(daemon, sid, 'ordinary-after-stale-call', input);
  teammate.append({ type: 'progress', message: { role: 'system', content: 'bookkeeping' } });
  await daemon.routeEvent(idle);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const ordinary = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'ordinary-after-stale-call');
  assert.ok(ordinary);
  assert.equal(ordinary.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-after-stale-msg'));
});

test('idle history churn cannot evict persistent transcript progress', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'progress-eviction');
  t.after(() => daemon.drain('test cleanup'));
  await dispatch(daemon, sid, 'progress-eviction-call-1', 'first');
  const teammate = makeTranscript(t, 'progress-eviction-member', 'progress-eviction-member');
  teammate.append(...teammateEntries(
    'progress-eviction-member', 'first result', 'progress-eviction-msg-1',
  ));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'progress-eviction-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(idle);

  // Overflow the independent idle-event history without touching this
  // persistent transcript. Its provider cursor must remain intact.
  for (let i = 0; i < 511; i++) {
    await daemon.routeEvent({
      hook_event_name: 'TeammateIdle', session_id: `unmatched-${i}`,
      team_name: `unmatched-team-${i}`, teammate_name: `unmatched-member-${i}`,
    });
  }

  await dispatch(daemon, sid, 'progress-eviction-call-2', 'second');
  teammate.append({ type: 'progress', message: { role: 'system', content: 'no provider output' } });
  await daemon.routeEvent(idle);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'progress-eviction-call-2'), false);
});

test('file aliases cannot replay persistent transcript output', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'progress-alias');
  t.after(() => daemon.drain('test cleanup'));
  await dispatch(daemon, sid, 'progress-alias-call-1', 'first');
  const teammate = makeTranscript(t, 'progress-alias-member', 'progress-alias-member');
  teammate.append(...teammateEntries(
    'progress-alias-member', 'first result', 'progress-alias-msg',
  ));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'progress-alias-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(idle);
  await dispatch(daemon, sid, 'progress-alias-call-2', 'second');
  const alias = teammate.file.replace(/\.jsonl$/, '-alias.jsonl');
  fs.linkSync(teammate.file, alias);
  await daemon.routeEvent({ ...idle, transcript_path: alias });
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'progress-alias-call-2'), false);
  assert.equal(exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'progress-alias-msg').length, 1);
});

test('a physical transcript cannot be relabeled to replay its output', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'progress-relabel');
  t.after(() => daemon.drain('test cleanup'));
  const input = { name: MEMBER, prompt: 'first' };
  await dispatch(daemon, sid, 'progress-relabel-call-1', 'first', input);
  const teammate = makeTranscript(t, 'progress-relabel-member', 'progress-relabel-member');
  teammate.append(...teammateEntries(
    'progress-relabel-member', 'first result', 'progress-relabel-msg',
    'general-purpose',
  ));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'progress-relabel-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(idle);

  await dispatch(daemon, sid, 'progress-relabel-call-2', 'second', {
    name: MEMBER,
    prompt: 'second',
  });
  await daemon.routeEvent({ ...idle, team_name: 'renamed-team' });
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]
      === 'progress-relabel-call-2'), false);
  assert.equal(exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'progress-relabel-msg').length, 1);
});

test('persistent progress survives many other teammate transcripts', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'progress-capacity');
  t.after(() => daemon.drain('test cleanup'));
  await dispatch(daemon, sid, 'progress-capacity-persistent-1', 'first');
  const persistent = makeTranscript(t, 'progress-capacity-member', 'progress-capacity-member');
  persistent.append(...teammateEntries(
    'progress-capacity-member', 'old result', 'progress-capacity-msg',
  ));
  const persistentIdle = {
    hook_event_name: 'TeammateIdle', session_id: 'progress-capacity-member',
    transcript_path: persistent.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(persistentIdle);

  for (let i = 0; i < 512; i++) {
    const memberSession = `progress-capacity-churn-${i}`;
    await dispatch(daemon, sid, `progress-capacity-call-${i}`, `task ${i}`);
    const teammate = makeTranscript(t, memberSession, memberSession);
    teammate.append(...teammateEntries(
      memberSession, `result ${i}`, `progress-capacity-msg-${i}`,
    ));
    await daemon.routeEvent({
      hook_event_name: 'TeammateIdle', session_id: memberSession,
      transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
    });
  }

  await dispatch(daemon, sid, 'progress-capacity-persistent-2', 'second');
  await daemon.routeEvent(persistentIdle);
  await flushWeave();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]
      === 'progress-capacity-persistent-2'), false);

  persistent.append(
    { type: 'user', teamName: TEAM, message: { role: 'user', content: 'new task' } },
    assistantEntry('progress-capacity-resumed-msg', {
      type: 'text', text: 'resumed result',
    }),
  );
  await daemon.routeEvent(persistentIdle);
  await flushWeave();
  const resumed = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]
      === 'progress-capacity-persistent-2');
  assert.ok(resumed);
  assert.equal(
    resumed.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'resumed result' }]),
  );

  await dispatch(daemon, sid, 'progress-capacity-new-call', 'new task');
  const fresh = makeTranscript(t, 'progress-capacity-new-member', 'progress-capacity-new');
  fresh.append(...teammateEntries(
    'progress-capacity-new-member', 'new result', 'progress-capacity-new-msg',
  ));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'progress-capacity-new-member',
    transcript_path: fresh.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await flushWeave();
  const freshAgent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]
      === 'progress-capacity-new-call');
  assert.ok(freshAgent);
  assert.equal(
    freshAgent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'new result' }]),
  );
});

test('one persistent teammate session completes twice only after transcript growth', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'persistent');
  await dispatch(daemon, sid, 'persistent-1', 'first');
  await dispatch(daemon, sid, 'persistent-2', 'second');
  const teammate = makeTranscript(t, 'persistent-member', 'persistent-member');
  teammate.append(...teammateEntries('persistent-member', 'first result', 'persistent-msg-1'));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'persistent-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };

  await daemon.routeEvent(idle);
  await daemon.routeEvent(idle);
  teammate.append(
    { type: 'user', teamName: TEAM, message: { role: 'user', content: 'task: second' } },
    assistantEntry('persistent-msg-2', { type: 'text', text: 'second result' }),
  );
  await daemon.routeEvent(idle);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]).startsWith('persistent-'));
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map(agent => agent.attributes[ATTR.OUTPUT_MESSAGES]).sort(), [
    JSON.stringify([{ role: 'assistant', content: 'first result' }]),
    JSON.stringify([{ role: 'assistant', content: 'second result' }]),
  ]);
});

test('each idle reads only the persistent transcript state it observed', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'persistent-receipt-boundary');
  await dispatch(daemon, sid, 'boundary-call-1', 'first');
  await dispatch(daemon, sid, 'boundary-call-2', 'second');
  const teammate = makeTranscript(t, 'boundary-member', 'boundary-member');
  const [setting, user] = teammateEntries(
    'boundary-member', 'first result', 'boundary-msg-1',
  );
  teammate.append(setting, user);
  const firstResponse = JSON.stringify(assistantEntry(
    'boundary-msg-1',
    { type: 'text', text: 'first result' },
  ));
  const split = firstResponse.length - 2;
  fs.appendFileSync(teammate.file, firstResponse.slice(0, split));
  const idle = {
    hook_event_name: 'TeammateIdle', session_id: 'boundary-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };

  const firstIdle = daemon.routeEvent(idle);
  await new Promise(resolve => setTimeout(resolve, 25));
  fs.appendFileSync(teammate.file, [
    `${firstResponse.slice(split)}\n`,
    `${JSON.stringify({
      type: 'user', teamName: TEAM,
      message: { role: 'user', content: 'task: second' },
    })}\n`,
    `${JSON.stringify(assistantEntry(
      'boundary-msg-2',
      { type: 'text', text: 'second result' },
    ))}\n`,
  ].join(''));
  const secondIdle = daemon.routeEvent(idle);
  await Promise.all([firstIdle, secondIdle]);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    String(span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID])
      .startsWith('boundary-call-'));
  assert.deepEqual(Object.fromEntries(agents.map(agent => [
    agent.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
    agent.attributes[ATTR.OUTPUT_MESSAGES],
  ])), {
    'boundary-call-1': JSON.stringify([{ role: 'assistant', content: 'first result' }]),
    'boundary-call-2': JSON.stringify([{ role: 'assistant', content: 'second result' }]),
  });
  assert.deepEqual(agents.map(agent => agent.attributes[ATTR.WEAVE_ORPHAN_REASON]), [
    undefined,
    undefined,
  ]);
});
