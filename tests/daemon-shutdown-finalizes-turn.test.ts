// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// A turn's root span (`invoke_agent`) is created at UserPromptSubmit and only
// ended at Stop or SessionEnd. When the daemon exits for any other reason
// (inactivity timeout, SIGTERM/SIGINT/SIGHUP, or a restart control message), its
// already-ended children (completed tool spans, finalized chat spans, closed
// subagent spans) have been exported, but the still-open root had not. The
// result was a rootless trace: tool spans with no user turn to attribute them
// to.
//
// The fix finalizes every live session (ending its turn root) inside the
// shutdown drain, before the exporter is flushed. These tests drive a turn to a
// mid-flight state, run the drain, and assert the root is exported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATTR } from '../src/genaiSpans.ts';
import { flushWeave, initWeaveInMemory, makeGenaiDaemon, spanParentId } from './helpers.ts';

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };

function aLine(id: string, ts: string, block: Record<string, unknown>, stop?: string) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', id, model: 'claude-opus-4-8', content: [block], usage: USAGE, ...(stop ? { stop_reason: stop } : {}) },
  };
}
function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function makeTranscript(sessionId: string): { file: string; append: (line: unknown) => void; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-shutdown-itest-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  return { file, dir, append: (line: unknown) => fs.appendFileSync(file, JSON.stringify(line) + '\n') };
}

/** Drive a session to a mid-turn state: turn open, one tool completed. */
async function openTurnWithOneCompletedTool(d: Harness, sid: string, append: (l: unknown) => void, file: string) {
  append(userText('2026-01-01T00:00:00.000Z', 'do the thing'));
  await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
  await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do the thing' });
  append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'reading' }));
  append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }, 'tool_use'));
  await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Read', tool_input: { file_path: '/foo' } });
  await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });
}

test('daemon shutdown mid-turn exports the turn root span (children are not left rootless)', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-shutdown';
  const { file, append, dir } = makeTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    await openTurnWithOneCompletedTool(d, sid, append, file);

    // Neither Stop nor SessionEnd fired: the daemon exits (inactivity / signal
    // / restart). The drain must finalize the open turn before flushing.
    await d.drain('inactivity');
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const tool = spans.find(s => s.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
    assert.ok(tool, 'the completed tool span exported as a child');

    const root = spans.find(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
    assert.ok(root, 'the turn root span must be exported on shutdown, not leaked');
    assert.equal(root!.attributes[ATTR.AGENT_NAME], 'claude-code');
    assert.equal(root!.attributes[ATTR.CONVERSATION_ID], sid);
    assert.equal(root!.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');

    // The trace is well-formed: the child shares the exported root's trace id.
    assert.equal(tool!.spanContext().traceId, root!.spanContext().traceId, 'child and root share one trace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon shutdown ends an open subagent invoke_agent span under the same trace', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-shutdown-subagent';
  const { file, append, dir } = makeTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    append(userText('2026-01-01T00:00:00.000Z', 'spawn a reviewer'));
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'spawn a reviewer' });

    // Agent tool with subagent_type opens a nested invoke_agent span (Subagent)
    // that a mid-flight shutdown would otherwise leave open.
    append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'tool_use', id: 'agent_1', name: 'Agent', input: { subagent_type: 'code-reviewer', prompt: 'review' } }, 'tool_use'));
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'agent_1', tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer', prompt: 'review' } });

    await d.drain('SIGTERM');
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const invokeAgents = spans.filter(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
    const root = invokeAgents.find(s => s.attributes[ATTR.AGENT_NAME] === 'claude-code');
    const sub = invokeAgents.find(s => s.attributes[ATTR.AGENT_NAME] === 'code-reviewer');
    assert.ok(root, 'turn root exported');
    assert.ok(sub, 'open subagent invoke_agent span exported on shutdown');
    assert.equal(sub!.spanContext().traceId, root!.spanContext().traceId, 'subagent nests under the same trace as the root');
    assert.equal(spanParentId(sub!), root!.spanContext().spanId, 'subagent parents under the turn root');
    assert.equal(sub!.attributes[ATTR.WEAVE_ORPHAN_REASON], 'daemon_shutdown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionEnd still exports the turn root span after the finalize refactor', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-sessionend';
  const { file, append, dir } = makeTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    await openTurnWithOneCompletedTool(d, sid, append, file);
    await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
    await flushWeave();

    const root = exporter.getFinishedSpans().find(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
    assert.ok(root, 'SessionEnd exports the turn root');
    assert.equal(root!.attributes[ATTR.WEAVE_ORPHAN_REASON], 'session_ended');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
