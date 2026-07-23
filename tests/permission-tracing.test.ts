// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
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

function resolvedPermission(span: import('@opentelemetry/sdk-trace-base').ReadableSpan) {
  return span.events.find(event => event.name === ATTR.EVT_PERMISSION_RESOLVED);
}

function requestedPermission(span: import('@opentelemetry/sdk-trace-base').ReadableSpan) {
  return span.events.find(event => event.name === ATTR.EVT_PERMISSION_REQUEST);
}

test('the plugin forwards PermissionDenied hooks to the daemon', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'),
  ) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  const commands = manifest.hooks?.['PermissionDenied']
    ?.flatMap(group => group.hooks ?? [])
    .map(hook => hook.command);

  assert.ok(commands?.some(command => command?.includes('/hooks/hook-handler.sh')));
});

test('PermissionRequest accepts one hook-modified input and records suggestions', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-updated-input';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('run it'));
  const daemon = makeGenaiDaemon();
  const originalInput = { command: 'echo $WORKSPACE' };
  const updatedInput = { command: 'echo /workspace' };
  const suggestions = [{ type: 'addRules', behavior: 'allow' }];

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'run it' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'modified-tool', tool_name: 'Bash', tool_input: originalInput });
  await daemon.routeEvent({ hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Bash', tool_input: updatedInput, permission_suggestions: suggestions });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'modified-tool', tool_name: 'Bash', tool_input: updatedInput, tool_response: 'ok' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const tool = exporter.getFinishedSpans().find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'modified-tool');
  assert.ok(tool);
  assert.equal(
    requestedPermission(tool)?.attributes[ATTR.EVT_PERMISSION_SUGGESTIONS],
    JSON.stringify(suggestions),
  );
  assert.equal(resolvedPermission(tool)?.attributes[ATTR.EVT_PERMISSION_APPROVED], true);
});

test('tool failure is independent from permission approval', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-failure';
  const transcript = makeTranscript(t, sid, 'permission-failure');
  transcript.append(userEntry('run it'));
  const daemon = makeGenaiDaemon();
  const toolInput = { command: 'exit 1' };

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'run it' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'failed-tool', tool_name: 'Bash', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Bash', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PostToolUseFailure', session_id: sid, tool_use_id: 'failed-tool', tool_name: 'Bash', tool_input: toolInput, error: 'CommandError: exit 1' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const tool = exporter.getFinishedSpans().find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'failed-tool');
  assert.ok(tool);
  assert.equal(resolvedPermission(tool)?.attributes[ATTR.EVT_PERMISSION_APPROVED], true);
  assert.equal(tool.attributes[ATTR.ERROR_TYPE], 'CommandError');
});

test('auto-mode PermissionDenied resolves the exact tool_use_id', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-denied';
  const transcript = makeTranscript(t, sid, 'permission-denied');
  transcript.append(userEntry('read it'));
  const daemon = makeGenaiDaemon();
  const toolInput = { file_path: '/same' };

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'read it' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'denied-tool', tool_name: 'Read', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'allowed-tool', tool_name: 'Read', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PermissionDenied', session_id: sid, tool_use_id: 'denied-tool', tool_name: 'Read', tool_input: toolInput, reason: 'auto mode denied' });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'allowed-tool', tool_name: 'Read', tool_input: toolInput, tool_response: 'ok' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const tools = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
  const denied = tools.find(span => span.attributes['gen_ai.tool.call.id'] === 'denied-tool');
  const allowed = tools.find(span => span.attributes['gen_ai.tool.call.id'] === 'allowed-tool');
  assert.ok(denied && allowed);
  assert.equal(denied.events.some(event => event.name === ATTR.EVT_PERMISSION_REQUEST), false);
  assert.equal(resolvedPermission(denied)?.attributes[ATTR.EVT_PERMISSION_APPROVED], false);
  assert.equal(denied.attributes[ATTR.ERROR_TYPE], 'permission_denied');
  assert.equal(resolvedPermission(allowed), undefined);
});

test('ambiguous PermissionRequest is not guessed', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-ambiguous';
  const transcript = makeTranscript(t, sid, 'permission-ambiguous');
  transcript.append(userEntry('read twice'));
  const daemon = makeGenaiDaemon();
  const toolInput = { file_path: '/same' };

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'read twice' });
  for (const toolUseId of ['first-read', 'second-read']) {
    await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: toolUseId, tool_name: 'Read', tool_input: toolInput });
  }
  await daemon.routeEvent({ hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Read', tool_input: toolInput });
  for (const toolUseId of ['first-read', 'second-read']) {
    await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: toolUseId, tool_name: 'Read', tool_input: toolInput, tool_response: 'ok' });
  }
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const tools = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
  assert.equal(tools.length, 2);
  assert.ok(tools.every(tool =>
    !tool.events.some(event => event.name === ATTR.EVT_PERMISSION_REQUEST)));
});

test('Agent permission events stay on its invoke-agent span', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const daemon = makeGenaiDaemon();
  const toolInput = { subagent_type: 'Explore', prompt: 'inspect it' };

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate it' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'agent-permission', tool_name: 'Agent', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PermissionRequest', session_id: sid, tool_name: 'Agent', tool_input: toolInput });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-permission', tool_name: 'Agent', tool_input: toolInput, tool_response: 'done' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.ok(agent);
  assert.ok(requestedPermission(agent));
  assert.equal(resolvedPermission(agent)?.attributes[ATTR.EVT_PERMISSION_APPROVED], true);
});

test('restart recovers an Agent denied before it could start', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-agent-restart';
  const transcript = makeTranscript(t, sid, 'permission-agent-restart');
  transcript.append(userEntry('delegate it'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'PermissionDenied', session_id: sid,
    transcript_path: transcript.file, cwd: '/x',
    tool_use_id: 'denied-agent', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'inspect it' },
    reason: 'auto mode denied',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.ERROR_TYPE], 'permission_denied');
  assert.equal(resolvedPermission(agents[0])?.attributes[ATTR.EVT_PERMISSION_APPROVED], false);
});

test('restart-first nested PermissionDenied recovers its owner and stays fail-closed without type', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-nested-restart';
  const ownerId = 'permission-owner';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  transcript.subagent(ownerId, userEntry('inspect permissions'));
  transcript.subagent('missing-owner', userEntry('must stay unowned'));
  const daemon = makeGenaiDaemon();
  const base = {
    session_id: sid,
    transcript_path: transcript.file,
    cwd: '/x',
    prompt_id: 'prompt-1',
  };

  await daemon.routeEvent({
    hook_event_name: 'PermissionDenied',
    ...base,
    agent_id: ownerId,
    agent_type: 'Explore',
    tool_use_id: 'denied-child-agent',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'Reviewer', prompt: 'review it' },
    reason: 'auto mode denied nested dispatch',
  });
  await daemon.routeEvent({
    hook_event_name: 'PermissionDenied',
    ...base,
    agent_id: 'missing-owner',
    tool_use_id: 'unowned-denial',
    tool_name: 'Read',
    tool_input: { file_path: '/x' },
    reason: 'identity incomplete',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const spans = exporter.getFinishedSpans();
  const owner = spans.find(span => span.attributes[ATTR.AGENT_ID] === ownerId);
  const denied = spans.find(span =>
    span.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'denied-child-agent');
  assert.ok(owner && denied);
  assert.equal(spanParentId(denied), owner.spanContext().spanId);
  assert.equal(denied.attributes[ATTR.ERROR_TYPE], 'permission_denied');
  assert.equal(denied.events.some(event => event.name === ATTR.EVT_PERMISSION_REQUEST), false);
  assert.equal(resolvedPermission(denied)?.attributes[ATTR.EVT_PERMISSION_APPROVED], false);
  assert.equal(spans.some(span =>
    span.attributes['gen_ai.tool.call.id'] === 'unowned-denial'), false);
});

test('PermissionDenied stays distinct from a recovered same-type Agent', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'permission-agent-with-recovered';
  const recoveredId = 'running-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate twice'));
  const subPath = transcript.subagent(
    recoveredId,
    userEntry('inspect it'),
    assistantEntry('running-msg', { type: 'text', text: 'done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate twice' });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: recoveredId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PermissionDenied', session_id: sid,
    tool_use_id: 'denied-second-agent', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'inspect it' },
    reason: 'auto mode denied',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === recoveredId);
  const denied = agents.find(span => span.attributes[ATTR.ERROR_TYPE] === 'permission_denied');
  assert.equal(agents.length, 2);
  assert.ok(recovered && denied);
  assert.equal(recovered.attributes[ATTR.ERROR_TYPE], undefined);
});
