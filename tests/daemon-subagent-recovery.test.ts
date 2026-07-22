// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  spanParentId,
  transcriptAssistantLine,
  transcriptUserLine,
} from './helpers.ts';

test('SubagentStop with no tracker (post-restart) recovers the subagent invoke_agent + chat with tokens', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subrecover-'));
  const sid = 'sub-recover-001';
  const agentId = 'a1234567890abcdef';

  const mainPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(mainPath, transcriptUserLine('spawn a subagent') + '\n' + transcriptAssistantLine('working', { input_tokens: 10, output_tokens: 5 }) + '\n');

  const subPath = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(subPath), { recursive: true });
  fs.writeFileSync(subPath, transcriptUserLine('do the subtask') + '\n' + transcriptAssistantLine('subtask done', { input_tokens: 200, output_tokens: 40 }) + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({
      hook_event_name: 'SubagentStop',
      session_id: sid,
      transcript_path: mainPath,
      agent_id: agentId,
      agent_transcript_path: subPath,
      agent_type: 'general-purpose',
    });
    await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => `${s.name}[${s.attributes['gen_ai.agent.name']}]`).join(', ');

    const subInvoke = spans.find(
      (s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent' && s.attributes['gen_ai.agent.name'] === 'general-purpose',
    );
    assert.ok(subInvoke, `expected a recovered subagent invoke_agent span; got: ${names}`);

    const chat = spans.find(
      (s) => s.attributes['gen_ai.operation.name'] === 'chat' && s.attributes['gen_ai.agent.name'] === 'general-purpose',
    );
    assert.ok(chat, `expected the subagent chat span; got: ${names}`);
    assert.ok(Number(chat.attributes['gen_ai.usage.output_tokens']) > 0, 'chat span carries the subagent token usage');
    assert.equal(spanParentId(chat), subInvoke.spanContext().spanId, 'subagent chat nests under the subagent invoke_agent span');

    const turn = spans.find(
      (s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent' && s.attributes['gen_ai.agent.name'] === 'claude-code',
    );
    assert.ok(turn, `expected a reconstructed turn span to parent the subagent; got: ${names}`);
    assert.equal(spanParentId(subInvoke), turn.spanContext().spanId, 'subagent invoke_agent nests under the reconstructed turn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery reuses an already-open turn span instead of creating a spurious second turn', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subrecover2-'));
  const sid = 'sub-recover-002';
  const agentId = 'b1234567890abcdef';

  const mainPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(mainPath, transcriptUserLine('start') + '\n');
  const subPath = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(subPath), { recursive: true });
  fs.writeFileSync(subPath, transcriptUserLine('subtask') + '\n' + transcriptAssistantLine('done', { input_tokens: 50, output_tokens: 7 }) + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, transcript_path: mainPath, prompt: 'go' });
    await d.routeEvent({
      hook_event_name: 'SubagentStop', session_id: sid, transcript_path: mainPath,
      agent_id: agentId, agent_transcript_path: subPath, agent_type: 'Explore',
    });
    await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const turns = spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent' && s.attributes['gen_ai.agent.name'] === 'claude-code');
    assert.equal(turns.length, 1, `exactly one turn span expected, no spurious reconstructed turn; got ${turns.length}`);
    const subInvoke = spans.find((s) => s.attributes['gen_ai.agent.name'] === 'Explore' && s.attributes['gen_ai.operation.name'] === 'invoke_agent');
    assert.ok(subInvoke, 'recovered subagent invoke_agent span present');
    assert.equal(spanParentId(subInvoke), turns[0].spanContext().spanId, 'subagent nests under the pre-existing turn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
