// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Turn-span behaviour across four areas, all exercised in-process against an
// in-memory OTLP exporter via the daemon's routeEvent entry point:
//   1. integration identity stamped on every span (turn, chat, tool)
//   2. the customizable top-level agent name driving gen_ai.agent.name
//   3. interrupted-turn recovery (open turn closed by the next prompt)
//   4. system-instructions capture: buffering, dedup, and per-turn stamping
// Merged from turn-span-integration, turn-span-agent-name, interrupted-turn,
// and system-instructions-integration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { VERSION } from '../src/setup.ts';
import { ATTR, DEFAULT_AGENT_NAME } from '../src/genaiSpans.ts';
import {
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  spanParentId,
  transcriptUserLine,
} from './helpers.ts';

// ---- shared builders ----

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };

function userText(ts: string, text: string, version: string) {
  return { type: 'user', version, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function aLine(id: string, ts: string, block: Record<string, unknown>, stop?: string) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      content: [block],
      usage: USAGE,
      ...(stop ? { stop_reason: stop } : {}),
    },
  };
}

function writeTranscript(sessionId: string, text: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-agentname-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  return { file, dir };
}

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

/** Seed a transcript file with a single user line (the first line carries the
 *  CC CLI version, as real transcripts do) and return its path. */
function seedTranscript(sid: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-sysinstr-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, transcriptUserLine('hi', { version: '1.2.3', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
  return { dir, file };
}

/** Build an InstructionsLoaded payload the way Claude Code does: content-free,
 *  carrying only the path. `content` is written to a real file under `dir` keyed
 *  by `logicalPath`, so re-loading the same logical path rewrites the same file
 *  (exercising dedup) and the daemon reads the content back from disk. */
function makeInstructionsLoader(dir: string) {
  return (sid: string, logicalPath: string, content: string, loadReason: string) => {
    const filePath = path.join(dir, logicalPath.replace(/[/\\]/g, '_'));
    fs.writeFileSync(filePath, content);
    return { hook_event_name: 'InstructionsLoaded', session_id: sid, file_path: filePath, load_reason: loadReason };
  };
}

function turnRoots(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
}

// ---- integration identity ----
// Integration identity rides onto EVERY span (turn root and all children), not
// just the turn root. The daemon builds per-session integration attributes at
// SessionStart and installs them on the session's Conversation; the SDK copies
// them onto every span it emits, and routeEvent re-installs the conversation for
// each event (each runIsolated frame starts with fresh ambient state). So a chat
// or execute_tool span deep in a turn is filterable by integration just like the
// root. Assertions use the literal wire keys, those strings are the contract
// the Weave backend reads into its queryable custom-attribute maps.
//
// Driven through the real routeEvent entry point so the per-event conversation
// re-install is exercised.

test('integration identity stamps weave.integration.* on every span (turn, chat, tool)', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-bag';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-integ-'));
  const file = path.join(dir, `${sid}.jsonl`);
  // First transcript line carries the CC CLI version (real CC transcripts do).
  fs.appendFileSync(file, JSON.stringify(userText('2026-01-01T00:00:00.000Z', 'do it', '1.2.3')) + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });

    // Assistant response msgA: text then tool_use (shared id), flushed before PreToolUse.
    fs.appendFileSync(file, JSON.stringify(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'editing' })) + '\n');
    fs.appendFileSync(file, JSON.stringify(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use')) + '\n');
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: { file_path: '/foo.ts' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const ops = new Set(spans.map((s) => s.attributes['gen_ai.operation.name']));
    assert.ok(ops.has('invoke_agent'), 'turn span present');
    assert.ok(ops.has('chat'), 'chat span present');
    assert.ok(ops.has('execute_tool'), 'tool span present');

    // The per-event conversation re-install must not disturb the trace tree: the
    // turn is still the root (no parent) and every span lives in its trace.
    const turn = spans.find((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent');
    assert.ok(turn, 'turn span present');
    assert.equal(spanParentId(turn), undefined, 'turn span is a trace root');
    for (const s of spans) {
      assert.equal(s.spanContext().traceId, turn.spanContext().traceId, `${s.name} shares the turn trace`);
    }

    // Every span, regardless of depth, must carry the integration identity.
    for (const s of spans) {
      assert.equal(s.attributes['weave.integration.name'], 'weave-claude-code', `${s.name}: integration name`);
      assert.equal(s.attributes['weave.integration.version'], VERSION, `${s.name}: integration version`);
      assert.equal(s.attributes['weave.integration.meta.claude_code_app_version'], '1.2.3', `${s.name}: cc app version`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- agent name ----
// The top-level agent name is user-customizable (settings `agent_name` /
// `WEAVE_AGENT_NAME`). The daemon resolves the effective value and passes it to
// `weave.startTurn`, which the SDK stamps on the `gen_ai.agent.name` attribute
// that drives Weave's Agents-view grouping. (The SDK always names the span
// `invoke_agent`; the agent name lives in the attribute, not the span name.)

test('turn span: agentName drives gen_ai.agent.name', async () => {
  const exporter = await initWeaveInMemory();

  // A custom name and the default both flow through identically.
  for (const name of ['my-custom-agent', DEFAULT_AGENT_NAME]) {
    exporter.reset();
    const sid = `sess-${name}`;
    const { file, dir } = writeTranscript(sid, 'hello');
    const d = makeGenaiDaemon(name);
    try {
      await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/tmp' });
      await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hello' });
      // The turn span only exports on end; SessionEnd finalizes an open turn.
      await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
      await flushWeave();

      const turnSpans = exporter.getFinishedSpans().filter(s => s.name === 'invoke_agent');
      assert.equal(turnSpans.length, 1, 'exactly one turn span');
      assert.equal(turnSpans[0].attributes[ATTR.AGENT_NAME], name, `gen_ai.agent.name must be "${name}"`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- interrupted turn ----
// A user interrupt ends a turn WITHOUT a Stop hook, so the next
// UserPromptSubmit arrives with the previous turn (and possibly its chat span)
// still open. Regression coverage for two bugs in that window:
//   1. the open turn's handle was silently overwritten, leaking its root span
//      un-exported (rootless trace);
//   2. the stale activeChat's response key, finalized against the NEXT turn's
//      transcript, produced an empty call group and crashed recordChat —
//      killing tool tracing for the rest of the session.

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

// ---- system instructions ----
// The daemon captures instruction files from the InstructionsLoaded hook and
// stamps them on every turn root as `gen_ai.system_instructions`. The hook
// carries only file_path (not the contents), so the daemon reads each file from
// disk, these tests write real files and let the daemon read them back. The
// hook fires per file, and its order relative to SessionStart is NOT guaranteed
// (verified in daemon logs: a file can load before SessionStart), so
// instructions arriving before the session exists are buffered and drained when
// the session is created. These tests drive the real routeEvent entry point (as
// production does) so buffering, draining, dedup, and per-turn stamping are all
// exercised end-to-end against the exported spans (the public contract).

test('buffers InstructionsLoaded fired before SessionStart, then accumulates in load order', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-order';
  const { dir, file } = seedTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    const loadInstr = makeInstructionsLoader(dir);
    // Global CLAUDE.md loads BEFORE SessionStart (the real, non-deterministic order).
    await d.routeEvent(loadInstr(sid, '/home/u/.claude/CLAUDE.md', 'GLOBAL', 'session_start'));
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    // Project CLAUDE.md loads AFTER SessionStart.
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'PROJECT', 'session_start'));
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const [turn] = turnRoots(exporter.getFinishedSpans());
    assert.ok(turn, 'turn root exported');
    assert.equal(
      turn.attributes[ATTR.SYSTEM_INSTRUCTIONS],
      JSON.stringify([
        { type: 'text', content: 'GLOBAL' },
        { type: 'text', content: 'PROJECT' },
      ]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-loading the same file replaces its content rather than duplicating', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-dedup';
  const { dir, file } = seedTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    const loadInstr = makeInstructionsLoader(dir);
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'V1', 'session_start'));
    // Same path reloads (e.g. after compaction) with new content.
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'V2', 'compact'));
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const [turn] = turnRoots(exporter.getFinishedSpans());
    assert.ok(turn, 'turn root exported');
    assert.equal(
      turn.attributes[ATTR.SYSTEM_INSTRUCTIONS],
      JSON.stringify([{ type: 'text', content: 'V2' }]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamps system instructions on every turn root (no session span to hang them on)', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-multiturn';
  const { dir, file } = seedTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    const loadInstr = makeInstructionsLoader(dir);
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'PROJECT', 'session_start'));
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'turn one' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'turn two' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const turns = turnRoots(exporter.getFinishedSpans());
    assert.equal(turns.length, 2, 'both turn roots exported');
    const expected = JSON.stringify([{ type: 'text', content: 'PROJECT' }]);
    for (const turn of turns) {
      assert.equal(turn.attributes[ATTR.SYSTEM_INSTRUCTIONS], expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omits gen_ai.system_instructions when no instructions were loaded', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sess-none';
  const { dir, file } = seedTranscript(sid);
  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const [turn] = turnRoots(exporter.getFinishedSpans());
    assert.ok(turn, 'turn root exported');
    assert.equal(turn.attributes[ATTR.SYSTEM_INSTRUCTIONS], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
