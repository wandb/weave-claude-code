// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATTR } from '../src/genaiSpans.ts';
import {
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  spanParentId,
  transcriptAssistantLine,
  transcriptUserLine,
} from './helpers.ts';

const userLine = (text: string): string =>
  transcriptUserLine(text, { version: '1.2.3', timestamp: '2026-01-01T00:00:00.000Z' });
const assistantLine = (text: string, usage: Record<string, number>): string =>
  transcriptAssistantLine(text, usage, { timestamp: '2026-01-01T00:00:05.000Z' });

test('matched subagent: tools and chats nest under its invoke_agent marker with full identity', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-nest-001';
  const agentId = 'nest-agent-1';
  const firingPrompt = 'find the flaky test';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subnest-'));
  const coordPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(coordPath, userLine('kick off') + '\n');

  const subPath = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(subPath), { recursive: true });
  fs.writeFileSync(subPath, userLine(firingPrompt) + '\n' + assistantLine('found it', { input_tokens: 120, output_tokens: 30 }) + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: coordPath, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'kick off' });
    await d.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tu-agent',
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: firingPrompt, description: 'Find it' },
    });
    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
    await d.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId, tool_use_id: 'tu-read',
      tool_name: 'Read', tool_input: { file_path: '/flaky.test.ts' },
    });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, agent_id: agentId, tool_use_id: 'tu-read', tool_response: 'contents' });
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_transcript_path: subPath, agent_type: 'Explore' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tu-agent', tool_response: 'found the flaky test' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'claude-code');
    assert.ok(turn, 'coordinator turn exported');
    const subInvoke = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'Explore');
    assert.ok(subInvoke, 'subagent invoke_agent marker exported');
    assert.equal(spanParentId(subInvoke), turn.spanContext().spanId, 'marker nests under the turn');
    assert.equal(subInvoke.attributes[ATTR.AGENT_ID], agentId, 'agent id recorded at SubagentStart');
    assert.equal(
      subInvoke.attributes[ATTR.OUTPUT_MESSAGES],
      JSON.stringify([{ role: 'assistant', content: 'found the flaky test' }]),
      'PostToolUse(Agent) closes the marker with the canonical tool return',
    );

    const readTool = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'execute_tool' && s.attributes['gen_ai.tool.name'] === 'Read');
    assert.ok(readTool, 'subagent tool span exported');
    assert.equal(spanParentId(readTool), subInvoke.spanContext().spanId, 'subagent tool nests under the marker');
    assert.equal(readTool.attributes[ATTR.AGENT_NAME], 'Explore', 'subagent tool tagged with the subagent name');

    const chat = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'chat' && s.attributes[ATTR.AGENT_NAME] === 'Explore');
    assert.ok(chat, 'subagent chat span exported');
    assert.equal(spanParentId(chat), subInvoke.spanContext().spanId, 'subagent chat nests under the marker');
    assert.equal(chat.attributes[ATTR.USAGE_INPUT_TOKENS], 120);

    for (const s of [subInvoke, readTool, chat]) {
      assert.equal(s.attributes[ATTR.CONVERSATION_ID], sid, `${s.name}: conversation id`);
      assert.equal(s.attributes['weave.integration.name'], 'weave-claude-code', `${s.name}: integration name`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous correlation does not manufacture a duplicate subagent marker', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-nest-ambiguous';
  const agentId = 'ambiguous-agent';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subnest-ambiguous-'));
  const coordPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(coordPath, userLine('dispatch two explorers') + '\n');

  const subPath = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(subPath), { recursive: true });
  fs.writeFileSync(subPath, userLine('prompt not present on either dispatch') + '\n'
    + assistantLine('ambiguous result', { input_tokens: 20, output_tokens: 5 }) + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: coordPath, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch two explorers' });
    for (const [toolUseId, prompt] of [['tu-agent-a', 'first task'], ['tu-agent-b', 'second task']] as const) {
      await d.routeEvent({
        hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: toolUseId,
        tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt },
      });
    }

    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_transcript_path: subPath, agent_type: 'Explore' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tu-agent-a', tool_response: 'first result' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tu-agent-b', tool_response: 'second result' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
      && s.attributes[ATTR.AGENT_NAME] === 'claude-code');
    assert.ok(turn, 'coordinator turn exported');
    const subagents = spans.filter((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
      && s.attributes[ATTR.AGENT_NAME] === 'Explore');
    assert.equal(subagents.length, 2, 'only the two actual Agent dispatches produce markers');

    const chat = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'chat'
      && s.attributes[ATTR.AGENT_NAME] === 'Explore');
    assert.ok(chat, 'ambiguous subagent chat still exported');
    assert.equal(spanParentId(chat), turn.spanContext().spanId, 'ambiguous chat safely falls back to the turn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
