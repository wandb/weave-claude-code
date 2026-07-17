// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// A user interrupt ends a turn WITHOUT a Stop hook, so the next
// UserPromptSubmit arrives with the previous turn (and possibly its chat span)
// still open. Regression coverage for two bugs in that window:
//   1. the open turn's handle was silently overwritten, leaking its root span
//      un-exported (rootless trace);
//   2. the stale activeChat's response key, finalized against the NEXT turn's
//      transcript, produced an empty call group and crashed recordChat —
//      killing tool tracing for the rest of the session.

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
  transcriptUserLine,
} from './helpers.ts';

function assistantToolUseLine(msgId: string, toolUseId: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      id: msgId,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 10 },
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 999' } }],
    },
  });
}

test('interrupted turn: next prompt closes the open turn and tool tracing survives', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-interrupt';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-interrupt-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, transcriptUserLine('turn one', { version: '1.2.3', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'turn one' });

    // Turn 1's response msgA starts a tool; the user interrupts before it
    // completes, so neither PostToolUse nor Stop ever fires.
    fs.appendFileSync(file, assistantToolUseLine('msgA', 'tool_1', '2026-01-01T00:00:02.000Z') + '\n');
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Bash', tool_input: { command: 'sleep 999' } });

    // Turn 2 begins: the transcript's new user message starts a new parsed turn,
    // making turn 1's msgA key stale relative to the latest parse.
    fs.appendFileSync(file, transcriptUserLine('turn two', { timestamp: '2026-01-01T00:00:10.000Z' }) + '\n');
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'turn two' });

    // Tool tracing in turn 2 must still work (this crashed on the stale key).
    fs.appendFileSync(file, assistantToolUseLine('msgB', 'tool_2', '2026-01-01T00:00:12.000Z') + '\n');
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_2', tool_name: 'Bash', tool_input: { command: 'sleep 999' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_2', tool_response: 'ok' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const turns = spans.filter((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
    assert.equal(turns.length, 2, 'both turn roots exported (interrupted turn not leaked)');

    const superseded = turns.find((s) => s.attributes[ATTR.WEAVE_ORPHAN_REASON] === 'superseded_by_next_prompt');
    assert.ok(superseded, 'interrupted turn closed with the superseded orphan reason');

    const tools = spans.filter((s) => s.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
    assert.equal(tools.length, 2, 'tool spans from both turns exported (turn 2 tracing survived)');

    // The interrupted turn's chat span is finalized from the transcript with
    // its real usage, not dropped.
    const chats = spans.filter((s) => s.attributes[ATTR.OPERATION_NAME] === 'chat');
    assert.ok(chats.some((c) => c.attributes[ATTR.RESPONSE_ID] === 'msgA'), 'interrupted chat span exported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
