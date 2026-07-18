// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Consolidated subagent + teammate span coverage. Merged from four suites:
//   - subagent nesting: matched + recursive Agent dispatch nest the subagent's
//     tools and chats under its invoke_agent marker, with identity flowing
//     through the handle chain to every nested span.
//   - daemon subagent recovery: a SubagentStop with no tracker (post-restart,
//     reconstruction #92) still recovers the subagent invoke_agent + chat, and
//     recovery reuses an already-open turn instead of creating a spurious one.
//   - daemon shutdown finalize: a turn root (invoke_agent) opened at
//     UserPromptSubmit is only ended at Stop/SessionEnd; the shutdown drain must
//     finalize live turns (and open subagent markers) so their already-exported
//     children aren't left rootless.
//   - teammate idle: teammate transcript parsing (agent-setting head line,
//     multi-turn) plus per-session and cross-session TeammateIdle tracing. The
//     integration cases spawn a real daemon subprocess and assert its log lines
//     (per-session, cross-session, FIFO re-spawn, inactivity-hold,
//     duplicate-idle).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFirstTranscriptLine } from '../src/transcriptFile.ts';
import { parseSessionFile } from '../src/parser.ts';
import { ATTR } from '../src/genaiSpans.ts';
import {
  childrenOf,
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  spanParentId,
  transcriptAssistantLine,
  transcriptUserLine,
  type DaemonDriver,
} from './helpers.ts';

// ── builders: subagent-nesting ────────────────────────────────────────────────

const userLine = (text: string): string =>
  transcriptUserLine(text, { version: '1.2.3', timestamp: '2026-01-01T00:00:00.000Z' });
const assistantLine = (text: string, usage: Record<string, number>): string =>
  transcriptAssistantLine(text, usage, { timestamp: '2026-01-01T00:00:05.000Z' });

// ── builders: daemon-shutdown ─────────────────────────────────────────────────

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
async function openTurnWithOneCompletedTool(d: DaemonDriver, sid: string, append: (l: unknown) => void, file: string) {
  append(userText('2026-01-01T00:00:00.000Z', 'do the thing'));
  await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
  await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do the thing' });
  append(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'reading' }));
  append(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }, 'tool_use'));
  await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Read', tool_input: { file_path: '/foo' } });
  await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });
}

// ── fixtures: teammate transcripts ────────────────────────────────────────────

/** Write a fake teammate transcript to a temp file and return its path.
 *
 * readFirstTranscriptLine requires the path to be within os.homedir() (security
 * check). We use a subdir of the home directory rather than /tmp to satisfy it.
 */
function writeTeammateTranscript(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-test-'));
  const filePath = path.join(dir, 'abc123.jsonl');
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

const AGENT_SETTING_LINE = {
  type: 'agent-setting',
  agentSetting: 'cks-specialist',
  sessionId: 'abc123-session-id',
};

const MODE_LINE = { type: 'mode', mode: 'normal', sessionId: 'abc123-session-id' };

const USER_LINE = {
  parentUuid: null,
  isSidechain: false,
  teamName: 'triage-supp-12345',
  agentName: 'cks-specialist',
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Investigate the CKS cluster health.' }],
  },
  timestamp: '2026-06-05T10:00:00.000Z',
};

const ASSISTANT_LINE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    id: 'msg_test123',
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 0,
    },
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'The cluster looks healthy. No anomalies detected.' }],
  },
  timestamp: '2026-06-05T10:00:05.000Z',
};

// ── helpers: teammate integration (real daemon subprocess) ────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function spawnDaemon(home: string, extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home, ...extraEnv },
    stdio: 'ignore',
  });
}

const sendEvent = (socketPath: string, payload: object): Promise<void> => new Promise((resolve, reject) => {
  const s = net.createConnection(socketPath);
  s.on('error', reject);
  s.on('connect', () => { s.end(JSON.stringify(payload)); });
  s.on('close', () => resolve());
});

const waitForSocket = (socketPath: string): Promise<void> => new Promise((resolve) => {
  const poll = setInterval(() => {
    if (fs.existsSync(socketPath)) { clearInterval(poll); resolve(); }
  }, 50);
});

const isAlive = (socketPath: string): Promise<boolean> => new Promise((resolve) => {
  const s = net.createConnection(socketPath);
  s.on('error', () => resolve(false));
  s.on('connect', () => { s.destroy(); resolve(true); });
});

const readLog = (logPath: string): string => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

async function stopDaemon(daemon: ChildProcess, home: string): Promise<void> {
  daemon.kill();
  await new Promise<void>(resolve => daemon.once('exit', () => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
}

// ── subagent nesting ──────────────────────────────────────────────────────────
//
// The matched subagent path end-to-end: PreToolUse(Agent) opens the
// invoke_agent marker under the turn, SubagentStart correlates the agent_id by
// firing-prompt hash, the subagent's own tools and chat spans nest under the
// marker (weave 0.16.3 Subagent parents children), and PostToolUse(Agent)
// closes the marker with the tool's canonical return. Conversation id and
// integration identity must reach every nested span through the handle chain.

test('matched subagent: tools and chats nest under its invoke_agent marker with full identity', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-nest-001';
  const agentId = 'nest-agent-1';
  const firingPrompt = 'find the flaky test';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subnest-'));
  const coordPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(coordPath, userLine('kick off') + '\n');

  // Subagent transcript at the derived path; line 1 is the firing prompt
  // (byte-identical to the Agent tool's prompt) for content-based correlation.
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
    // The subagent runs its own tool.
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
    assert.equal(subInvoke.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID], 'tu-agent');
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

    // Identity flows through the handle chain to every nested span.
    for (const s of [subInvoke, readTool, chat]) {
      assert.equal(s.attributes[ATTR.CONVERSATION_ID], sid, `${s.name}: conversation id`);
      assert.equal(s.attributes['weave.integration.name'], 'weave-claude-code', `${s.name}: integration name`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recursive dispatch: a subagent spawning a subagent nests the child under its own marker', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = 'sub-nest-002';
  const outerPrompt = 'do the outer task';
  const innerPrompt = 'do the inner task';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subnest2-'));
  const coordPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(coordPath, userLine('kick off') + '\n');
  for (const [agentId, prompt] of [['outer-1', outerPrompt], ['inner-1', innerPrompt]] as const) {
    const p = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, userLine(prompt) + '\n' + assistantLine('done', { input_tokens: 10, output_tokens: 5 }) + '\n');
  }

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: coordPath, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'kick off' });
    // Main agent dispatches the outer subagent.
    await d.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tu-outer',
      tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: outerPrompt },
    });
    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: 'outer-1', agent_type: 'general-purpose' });
    // The OUTER subagent dispatches the inner one (agent_id set on the event).
    await d.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, agent_id: 'outer-1', tool_use_id: 'tu-inner',
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: innerPrompt },
    });
    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: 'inner-1', agent_type: 'Explore' });
    await d.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, agent_id: 'inner-1', tool_use_id: 'tu-read',
      tool_name: 'Read', tool_input: { file_path: '/f.ts' },
    });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, agent_id: 'inner-1', tool_use_id: 'tu-read', tool_response: 'ok' });
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'inner-1', agent_transcript_path: path.join(dir, sid, 'subagents', 'agent-inner-1.jsonl'), agent_type: 'Explore' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, agent_id: 'outer-1', tool_use_id: 'tu-inner', tool_response: 'inner done' });
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'outer-1', agent_transcript_path: path.join(dir, sid, 'subagents', 'agent-outer-1.jsonl'), agent_type: 'general-purpose' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tu-outer', tool_response: 'outer done' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'claude-code');
    const outer = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'general-purpose');
    const inner = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'Explore');
    assert.ok(turn && outer && inner, 'turn + both markers exported');
    assert.equal(spanParentId(outer), turn.spanContext().spanId, 'outer marker nests under the turn');
    assert.equal(spanParentId(inner), outer.spanContext().spanId, 'inner marker nests under the OUTER marker');
    assert.equal(inner.attributes[ATTR.AGENT_ID], 'inner-1', 'inner marker matched (not an orphan)');
    assert.equal(inner.attributes[ATTR.WEAVE_ORPHAN_REASON], undefined, 'no orphan fallback');

    const readTool = spans.find((s) => s.attributes[ATTR.OPERATION_NAME] === 'execute_tool' && s.attributes['gen_ai.tool.name'] === 'Read');
    assert.ok(readTool, 'inner tool exported');
    assert.equal(spanParentId(readTool), inner.spanContext().spanId, 'inner tool nests under the inner marker');
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

// ── daemon subagent recovery ──────────────────────────────────────────────────
//
// Regression for subagent spans dropped after a daemon restart: reconstruction
// (#92) rebuilds the session but not its subagent trackers, so handleSubagentStop
// found no tracker and dropped the subagent's spans. These drive the real
// routeEvent with an in-memory exporter and assert the recovered span tree.

test('SubagentStop with no tracker (post-restart) recovers the subagent invoke_agent + chat with tokens', async () => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-subrecover-'));
  const sid = 'sub-recover-001';
  const agentId = 'a1234567890abcdef';

  // Main transcript: the in-progress turn the subagent ran under, already on disk.
  const mainPath = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(mainPath, transcriptUserLine('spawn a subagent') + '\n' + transcriptAssistantLine('working', { input_tokens: 10, output_tokens: 5 }) + '\n');

  // Subagent transcript where the daemon derives it (agentId-based sibling dir).
  const subPath = path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(subPath), { recursive: true });
  fs.writeFileSync(subPath, transcriptUserLine('do the subtask') + '\n' + transcriptAssistantLine('subtask done', { input_tokens: 200, output_tokens: 40 }) + '\n');

  const d = makeGenaiDaemon();
  try {
    // Fresh daemon that only sees the subagent's completion, not its start.
    await d.routeEvent({
      hook_event_name: 'SubagentStop',
      session_id: sid,
      transcript_path: mainPath,
      agent_id: agentId,
      agent_transcript_path: subPath,
      agent_type: 'general-purpose',
    });
    // SessionEnd closes the reconstructed turn so it exports.
    await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid });
    await flushWeave();

    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => `${s.name}[${s.attributes['gen_ai.agent.name']}]`).join(', ');

    const subInvoke = spans.find(
      (s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent' && s.attributes['gen_ai.agent.name'] === 'general-purpose',
    );
    assert.ok(subInvoke, `expected a recovered subagent invoke_agent span; got: ${names}`);

    // The subagent's chat spans nest under its invoke_agent marker, and carry
    // its tokens.
    const chat = spans.find(
      (s) => s.attributes['gen_ai.operation.name'] === 'chat' && s.attributes['gen_ai.agent.name'] === 'general-purpose',
    );
    assert.ok(chat, `expected the subagent chat span; got: ${names}`);
    assert.ok(Number(chat.attributes['gen_ai.usage.output_tokens']) > 0, 'chat span carries the subagent token usage');
    assert.equal(spanParentId(chat), subInvoke.spanContext().spanId, 'subagent chat nests under the subagent invoke_agent span');

    // Recovery reconstructs the turn; the subagent nests under it.
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
    // UserPromptSubmit reconstructs the session and opens a turn first; recovery
    // must nest under that existing turn, not create a second one.
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

// ── daemon shutdown finalizes the turn root ───────────────────────────────────
//
// A turn's root span (`invoke_agent`) is created at UserPromptSubmit and only
// ended at Stop or SessionEnd. When the daemon exits for any other reason
// (inactivity timeout, SIGTERM/SIGINT/SIGHUP, or a restart control message), its
// already-ended children (completed tool spans, finalized chat spans, closed
// subagent spans) have been exported, but the still-open root had not. The
// result was a rootless trace: tool spans with no user turn to attribute them
// to. The fix finalizes every live session (ending its turn root) inside the
// shutdown drain, before the exporter is flushed.

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

// ── teammate transcript parsing ───────────────────────────────────────────────
//
// Teammate transcripts differ from subagent transcripts in two ways:
//   1. They live at <project-dir>/<session-id>.jsonl (not under subagents/)
//   2. The first line is an agent-setting record, not a user message:
//      {"type":"agent-setting","agentSetting":"cks-specialist","sessionId":"..."}
//
// TeammateIdle payload fields the handler reads: teammate_name (agent name),
// team_name, and transcript_path (the teammate's, not the coordinator's).

test('readFirstTranscriptLine: returns agentSetting from teammate transcript', () => {
  const filePath = writeTeammateTranscript([AGENT_SETTING_LINE, MODE_LINE, USER_LINE, ASSISTANT_LINE]);
  try {
    const firstLine = readFirstTranscriptLine(filePath);
    assert.ok(firstLine, 'should read first line');
    assert.equal(firstLine['type'], 'agent-setting');
    assert.equal(firstLine['agentSetting'], 'cks-specialist');
    assert.equal(firstLine['sessionId'], 'abc123-session-id');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

test('parseSessionFile: skips agent-setting lines, parses LLM calls from teammate transcript', () => {
  const filePath = writeTeammateTranscript([AGENT_SETTING_LINE, MODE_LINE, USER_LINE, ASSISTANT_LINE]);
  try {
    const parsed = parseSessionFile(filePath);
    assert.ok(parsed, 'parseSessionFile should return non-null');
    assert.equal(parsed.turns.length, 1, 'should produce exactly one turn');

    const turn = parsed.turns[0];
    const calls = turn.assistantCalls();
    assert.equal(calls.length, 1, 'should have one assistant call');

    const call = calls[0];
    assert.equal(call.model, 'claude-opus-4-8');
    assert.equal(call.usage.input_tokens, 1000);
    assert.equal(call.usage.output_tokens, 200);
    assert.equal(call.usage.cache_read_input_tokens, 500);
    assert.equal(call.finishReason, 'end_turn');
    assert.equal(call.responseId, 'msg_test123');

    assert.deepEqual(turn.textBlocks(), ['The cluster looks healthy. No anomalies detected.']);
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

test('TeammateIdle: multi-turn transcript emits chat spans from all turns', () => {
  const turn2User = {
    ...USER_LINE,
    message: { ...USER_LINE.message, content: [{ type: 'text', text: 'Follow-up question.' }] },
    timestamp: '2026-06-05T10:01:00.000Z',
  };
  const turn2Assistant = {
    ...ASSISTANT_LINE,
    message: {
      ...ASSISTANT_LINE.message,
      id: 'msg_turn2',
      usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'Follow-up answer.' }],
    },
    timestamp: '2026-06-05T10:01:05.000Z',
  };

  const filePath = writeTeammateTranscript([
    AGENT_SETTING_LINE, MODE_LINE,
    USER_LINE, ASSISTANT_LINE,
    turn2User, turn2Assistant,
  ]);
  try {
    const parsed = parseSessionFile(filePath);
    assert.ok(parsed);
    assert.equal(parsed.turns.length, 2, 'should have 2 turns');

    let totalCalls = 0;
    for (const turn of parsed.turns) {
      totalCalls += turn.assistantCalls().length;
    }
    assert.equal(totalCalls, 2, 'should have 2 assistant calls across both turns');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

// ── teammate idle span tree (in-process) ──────────────────────────────────────

test('TeammateIdle span tree: teammate turn carries the teammate chat span, tagged by agent name', async () => {
  // Drive the per-session teammate path end-to-end in-process: SubagentStart
  // (orphan) creates the Subagent marker; SubagentStop keeps it open;
  // TeammateIdle emits the teammate's chat spans under a fresh teammate turn
  // (the Subagent is a leaf and can't parent them). Each teammate chat span is
  // tagged with `gen_ai.agent.name` so the Agents view groups it.
  const exporter = await initWeaveInMemory();
  exporter.reset();

  const home = os.homedir();
  const coordSid = 'coord-span-001';
  const coordDir = fs.mkdtempSync(path.join(home, '.weave-tmspan-'));
  const coordPath = path.join(coordDir, `${coordSid}.jsonl`);
  fs.writeFileSync(coordPath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  // Subagent transcript at the path the daemon derives:
  // <coord-dir>/<coordSid>/subagents/agent-<agentId>.jsonl
  const agentId = 'agent-span-abc';
  const subDir = path.join(coordDir, coordSid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`),
    [USER_LINE, ASSISTANT_LINE].map(l => JSON.stringify(l)).join('\n') + '\n');

  const d = makeGenaiDaemon();
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: coordSid, transcript_path: coordPath, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: coordSid, prompt: '/triage' });
    // Orphan SubagentStart (no matching PreToolUse tracker).
    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: coordSid, agent_id: agentId, agent_type: 'cks-specialist' });
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: coordSid, agent_id: agentId });
    await d.routeEvent({ hook_event_name: 'TeammateIdle', session_id: coordSid, teammate_name: 'cks-specialist', team_name: 'triage-span' });
    await flushWeave();

    const spans = exporter.getFinishedSpans();

    // The teammate's own turn root (fresh trace), tagged with the teammate name.
    const teammateTurn = spans.find(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'cks-specialist');
    assert.ok(teammateTurn, 'teammate turn span exists tagged with gen_ai.agent.name');

    // The teammate chat span nests under the teammate turn and is tagged too.
    const chatKids = childrenOf(spans, teammateTurn).filter(s => s.attributes[ATTR.OPERATION_NAME] === 'chat');
    assert.equal(chatKids.length, 1, 'one chat span under the teammate turn');
    const chatSpan = chatKids[0];
    assert.equal(chatSpan.attributes[ATTR.AGENT_NAME], 'cks-specialist', 'chat span tagged with the teammate name');

    // Token counts are correct (cache-inclusive total for input).
    assert.equal(chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS], 1500, 'input_tokens = 1000 + 500 cache_read');
    assert.equal(chatSpan.attributes[ATTR.USAGE_OUTPUT_TOKENS], 200);
  } finally {
    fs.rmSync(coordDir, { recursive: true, force: true });
  }
});

// ── teammate idle integration (real daemon subprocess) ────────────────────────
//
// The integration cases send the real payload schema through a spawned daemon to
// catch regressions in field-name reading and cross-session correlation, and
// assert against the daemon log. Cross-session (agent-teams / TeamCreate): the
// teammate is an independent Claude session, SubagentStart does NOT fire, and a
// team registry bridges the coordinator to the teammate.

test('TeammateIdle: full sequence (SubagentStart, SubagentStop, TeammateIdle) traces with all turns', async () => {
  // Per-session teammate sequence (SubagentStart is the entry point; PreToolUse
  // not tested here):
  //   1. SubagentStart (orphan, no matching tracker): creates invoke_agent span, stores transcript path
  //   2. SubagentStop: span kept open (pendingTeammateIdle=true), tracker stays in SubagentTracking
  //   3. TeammateIdle: finds tracker, emits all-turns chat spans, closes span
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-inttest-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  const coordinatorSessionId = 'inttest-coord-001';

  // Subagent transcript must live where the daemon expects it:
  // <coordinator-transcript-dir>/subagents/agent-<agentId>.jsonl
  const coordinatorTranscriptDir = path.join(home, '.claude', 'projects', 'test', coordinatorSessionId);
  const subagentsDir = path.join(coordinatorTranscriptDir, 'subagents');
  const agentId = 'agent-abc123def456';
  const agentTranscriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);

  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.mkdirSync(subagentsDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    weave_project: 'test/test',
    wandb_api_key: 'fake-key-for-test',
    daemon_socket: socketPath,
    log_file: logPath,
    debug: true,
  }));

  // Multi-turn teammate transcript (two investigation turns)
  fs.writeFileSync(agentTranscriptPath, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Investigate CKS health' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', id: 'msg1',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'Phase 1: cluster looks healthy.' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Dig deeper' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', id: 'msg2',
      usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'Phase 2: no anomalies detected.' }] } }),
  ].join('\n') + '\n');

  const coordinatorPath = path.join(coordinatorTranscriptDir, `${coordinatorSessionId}.jsonl`);
  fs.mkdirSync(coordinatorTranscriptDir, { recursive: true });
  fs.writeFileSync(coordinatorPath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  const daemon = spawnDaemon(home);

  try {
    await waitForSocket(socketPath);
    await sleep(200);

    // Step 1: Coordinator session starts and submits prompt
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-99999' });
    await sleep(100);

    // Step 2: SubagentStart (orphan, no matching PreToolUse)
    await sendEvent(socketPath, {
      hook_event_name: 'SubagentStart',
      session_id: coordinatorSessionId,
      agent_id: agentId,
      agent_type: 'cks-specialist',
      transcript_path: agentTranscriptPath,
    });
    await sleep(100);

    // Step 3: SubagentStop, should keep span open (pendingTeammateIdle)
    await sendEvent(socketPath, {
      hook_event_name: 'SubagentStop',
      session_id: coordinatorSessionId,
      agent_id: agentId,
      agent_transcript_path: agentTranscriptPath,
    });
    await sleep(100);

    // Step 4: TeammateIdle, should close span with all-turns content
    // CC sends coordinator's transcript_path (not the agent's), daemon uses stored path instead
    await sendEvent(socketPath, {
      hook_event_name: 'TeammateIdle',
      session_id: coordinatorSessionId,
      transcript_path: coordinatorPath,  // coordinator's path (as CC sends it)
      teammate_name: 'cks-specialist',
      team_name: 'triage-inttest',
    });
    await sleep(400);

    const log = readLog(logPath);
    assert.match(log, /TeammateIdle: traced cks-specialist/, 'should trace cks-specialist');
    assert.doesNotMatch(log, /missing agent_id/, 'should not error on missing agent_id');
    assert.doesNotMatch(log, /no pending tracker for cks-specialist/, 'should find the pending tracker from SubagentStart');
  } finally {
    await stopDaemon(daemon, home);
  }
});

test('Cross-session: TeammateIdle from teammate session finds coordinator team member', async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-crosstest-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  const coordinatorSessionId = 'cross-coord-001';
  const teammateSessionId = 'cross-teammate-001';
  const teamName = 'triage-crosstest';
  const teammateName = 'cks-specialist';

  // Coordinator transcript dir with subagents/ for transcript resolution
  const coordinatorTranscriptDir = path.join(home, '.claude', 'projects', 'test', coordinatorSessionId);
  const subagentsDir = path.join(coordinatorTranscriptDir, 'subagents');
  const agentId = 'agent-cross-abc123';
  const agentTranscriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const agentMetaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);

  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.mkdirSync(subagentsDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    weave_project: 'test/crosstest',
    wandb_api_key: 'fake-key-for-crosstest',
    daemon_socket: socketPath,
    log_file: logPath,
    debug: true,
  }));

  // Teammate transcript (the specialist's own investigation)
  fs.writeFileSync(agentTranscriptPath, [
    JSON.stringify({ type: 'agent-setting', agentSetting: teammateName, sessionId: teammateSessionId }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Investigate CKS health' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', id: 'msg-cross-1',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'CKS cluster is healthy.' }] } }),
  ].join('\n') + '\n');

  // Meta file for transcript resolution (resolveTeammateTranscript reads this)
  fs.writeFileSync(agentMetaPath, JSON.stringify({ agentType: teammateName }));

  // Coordinator and teammate transcript files
  const coordinatorPath = path.join(coordinatorTranscriptDir, `${coordinatorSessionId}.jsonl`);
  fs.writeFileSync(coordinatorPath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  const teammateTranscriptDir = path.join(home, '.claude', 'projects', 'test', teammateSessionId);
  fs.mkdirSync(teammateTranscriptDir, { recursive: true });
  const teammatePath = path.join(teammateTranscriptDir, `${teammateSessionId}.jsonl`);
  fs.writeFileSync(teammatePath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  const daemon = spawnDaemon(home);

  try {
    await waitForSocket(socketPath);
    await sleep(200);

    // Step 1: Coordinator starts and submits prompt
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-crosstest' });
    await sleep(100);

    // Step 2: PreToolUse(Agent, team_name) in coordinator session
    await sendEvent(socketPath, {
      hook_event_name: 'PreToolUse',
      session_id: coordinatorSessionId,
      tool_use_id: 'toolu_cross_001',
      tool_name: 'Agent',
      tool_input: {
        prompt: 'Investigate CKS health',
        subagent_type: teammateName,
        team_name: teamName,
        name: teammateName,
      },
    });
    await sleep(100);

    // Verify team member was registered
    let log = readLog(logPath);
    assert.match(log, /Team member registered/, 'coordinator PreToolUse should register team member');

    // Step 3: PostToolUse(Agent), should NOT close the span (team mode)
    await sendEvent(socketPath, {
      hook_event_name: 'PostToolUse',
      session_id: coordinatorSessionId,
      tool_use_id: 'toolu_cross_001',
      tool_name: 'Agent',
      tool_response: 'Agent dispatched',
    });
    await sleep(100);

    // Step 4: Teammate session starts (DIFFERENT session_id)
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: teammateSessionId, transcript_path: teammatePath });
    await sleep(100);

    // Step 5: TeammateIdle fires from TEAMMATE's session (the cross-session case)
    await sendEvent(socketPath, {
      hook_event_name: 'TeammateIdle',
      session_id: teammateSessionId,
      transcript_path: teammatePath,
      teammate_name: teammateName,
      team_name: teamName,
    });
    await sleep(400);

    log = readLog(logPath);
    assert.match(log, /TeammateIdle: traced cks-specialist team=triage-crosstest \(cross-session\)/, 'should trace via cross-session path');
    assert.doesNotMatch(log, /no pending tracker for cks-specialist/, 'should NOT fall through to per-session path');
  } finally {
    await stopDaemon(daemon, home);
  }
});

test('Cross-session: re-spawn of same team::name nests BOTH (FIFO queue, no overwrite)', async () => {
  // Regression for the re-spawn bug: the same team::name is spawned twice in one
  // run. A second PreToolUse(Agent) for the same `${team}::${name}` must append
  // to the FIFO queue, not overwrite the first still-open span (which would leak
  // it and mis-attribute the first teammate's transcript).
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-respawntest-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  const coordinatorSessionId = 'respawn-coord-001';
  const teamName = 'triage-respawn';
  const teammateName = 'cks-specialist';
  const tm1 = 'respawn-tm-001';
  const tm2 = 'respawn-tm-002';

  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    weave_project: 'test/respawn', wandb_api_key: 'fake-key', daemon_socket: socketPath, log_file: logPath, debug: true,
  }));

  const coordDir = path.join(home, '.claude', 'projects', 'test', coordinatorSessionId);
  const subagentsDir = path.join(coordDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  const coordinatorPath = path.join(coordDir, `${coordinatorSessionId}.jsonl`);
  fs.writeFileSync(coordinatorPath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  const mkTeammate = (agentId: string, sid: string, text: string): string => {
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), [
      JSON.stringify({ type: 'agent-setting', agentSetting: teammateName, sessionId: sid }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', id: `msg-${agentId}`,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'end_turn', content: [{ type: 'text', text }] } }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: teammateName }));
    const tdir = path.join(home, '.claude', 'projects', 'test', sid);
    fs.mkdirSync(tdir, { recursive: true });
    const tp = path.join(tdir, `${sid}.jsonl`);
    fs.writeFileSync(tp, JSON.stringify({ type: 'system', content: [] }) + '\n');
    return tp;
  };
  const tp1 = mkTeammate('respawn-a1', tm1, 'first cks investigation');
  const tp2 = mkTeammate('respawn-a2', tm2, 'second cks investigation');

  const daemon = spawnDaemon(home);

  try {
    await waitForSocket(socketPath);
    await sleep(200);
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-respawn' });
    await sleep(100);

    // FIRST spawn of cks-specialist
    await sendEvent(socketPath, { hook_event_name: 'PreToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_r1',
      tool_name: 'Agent', tool_input: { prompt: 'first', subagent_type: teammateName, team_name: teamName, name: teammateName } });
    await sleep(80);
    // SECOND spawn of the SAME team::name (the re-spawn) BEFORE the first idles
    await sendEvent(socketPath, { hook_event_name: 'PreToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_r2',
      tool_name: 'Agent', tool_input: { prompt: 'second', subagent_type: teammateName, team_name: teamName, name: teammateName } });
    await sleep(120);

    let log = readLog(logPath);
    assert.match(log, /queue depth 2/, 'second spawn of same key should APPEND to FIFO queue (depth 2), not overwrite');

    // both teammate sessions start, then both idle
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: tm1, transcript_path: tp1 });
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: tm2, transcript_path: tp2 });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'TeammateIdle', session_id: tm1, transcript_path: tp1, teammate_name: teammateName, team_name: teamName });
    await sleep(200);
    await sendEvent(socketPath, { hook_event_name: 'TeammateIdle', session_id: tm2, transcript_path: tp2, teammate_name: teammateName, team_name: teamName });
    await sleep(400);

    log = readLog(logPath);
    const traced = log.match(/TeammateIdle: traced cks-specialist team=triage-respawn \(cross-session\)/g) ?? [];
    assert.equal(traced.length, 2, `BOTH re-spawned teammates should nest (no overwrite/leak) — got ${traced.length}`);
  } finally {
    await stopDaemon(daemon, home);
  }
});

test('Inactivity guard: daemon stays up past timeout while team correlation is in flight', async () => {
  // Regression for the daemon-restart-wipes-map failure: an agent-teams run has
  // quiet windows after spawn (waiting on specialists). The daemon must NOT hit
  // its inactivity timeout while team members are unemitted, or the restart wipes
  // teamMembers and breaks nesting. Uses WEAVE_INACTIVITY_MS to make it fast.
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-inacttest-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  const coordinatorSessionId = 'inact-coord-001';
  const teamName = 'triage-inact';
  const teammateName = 'cks-specialist';

  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    weave_project: 'test/inact', wandb_api_key: 'fake-key', daemon_socket: socketPath, log_file: logPath, debug: true,
  }));
  const coordDir = path.join(home, '.claude', 'projects', 'test', coordinatorSessionId);
  fs.mkdirSync(coordDir, { recursive: true });
  const coordinatorPath = path.join(coordDir, `${coordinatorSessionId}.jsonl`);
  fs.writeFileSync(coordinatorPath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  // 800ms inactivity timeout so the test runs in seconds (vs the 10-min default).
  const daemon = spawnDaemon(home, { WEAVE_INACTIVITY_MS: '800' });

  try {
    await waitForSocket(socketPath);
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await sendEvent(socketPath, { hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-inact' });
    // Register a team member (unemitted), then go quiet, NO TeammateIdle.
    await sendEvent(socketPath, { hook_event_name: 'PreToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_inact_1',
      tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: teammateName, team_name: teamName, name: teammateName } });

    // Wait well past the 800ms timeout (multiple ~500ms check intervals) with no activity.
    await sleep(2600);

    assert.equal(await isAlive(socketPath), true, 'daemon must stay UP past the inactivity timeout while a team member is unemitted');
    assert.match(readLog(logPath), /team correlation in flight — staying up/, 'should log that it stayed up for in-flight team work');
  } finally {
    await stopDaemon(daemon, home);
  }
});

test('Cross-session: duplicate TeammateIdle does not double-emit', async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-duptest-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  const coordinatorSessionId = 'dup-coord-001';
  const teammateSessionId = 'dup-teammate-001';

  const coordinatorTranscriptDir = path.join(home, '.claude', 'projects', 'test', coordinatorSessionId);
  const subagentsDir = path.join(coordinatorTranscriptDir, 'subagents');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.mkdirSync(subagentsDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    weave_project: 'test/duptest',
    wandb_api_key: 'fake-key-for-duptest',
    daemon_socket: socketPath,
    log_file: logPath,
    debug: true,
  }));

  const agentId = 'agent-dup-xyz';
  const agentTranscriptPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(agentTranscriptPath, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Check storage' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', id: 'msg-dup',
      usage: { input_tokens: 50, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'Storage OK.' }] } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'storage-specialist' }));

  const coordinatorPath = path.join(coordinatorTranscriptDir, `${coordinatorSessionId}.jsonl`);
  fs.writeFileSync(coordinatorPath, JSON.stringify({ type: 'system', content: [] }) + '\n');
  const teammateTranscriptDir = path.join(home, '.claude', 'projects', 'test', teammateSessionId);
  fs.mkdirSync(teammateTranscriptDir, { recursive: true });
  const teammatePath = path.join(teammateTranscriptDir, `${teammateSessionId}.jsonl`);
  fs.writeFileSync(teammatePath, JSON.stringify({ type: 'system', content: [] }) + '\n');

  const daemon = spawnDaemon(home);

  try {
    await waitForSocket(socketPath);
    await sleep(200);

    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage' });
    await sleep(100);
    await sendEvent(socketPath, {
      hook_event_name: 'PreToolUse', session_id: coordinatorSessionId,
      tool_use_id: 'toolu_dup_001', tool_name: 'Agent',
      tool_input: { prompt: 'Check storage', subagent_type: 'storage-specialist', team_name: 'triage-duptest', name: 'storage-specialist' },
    });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'PostToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_dup_001', tool_name: 'Agent', tool_response: 'dispatched' });
    await sleep(100);
    await sendEvent(socketPath, { hook_event_name: 'SessionStart', session_id: teammateSessionId, transcript_path: teammatePath });
    await sleep(100);

    // First TeammateIdle, should trace
    await sendEvent(socketPath, {
      hook_event_name: 'TeammateIdle', session_id: teammateSessionId, transcript_path: teammatePath,
      teammate_name: 'storage-specialist', team_name: 'triage-duptest',
    });
    await sleep(300);

    // Second TeammateIdle (duplicate), should skip
    await sendEvent(socketPath, {
      hook_event_name: 'TeammateIdle', session_id: teammateSessionId, transcript_path: teammatePath,
      teammate_name: 'storage-specialist', team_name: 'triage-duptest',
    });
    await sleep(300);

    const log = readLog(logPath);
    const traceMatches = log.match(/TeammateIdle: traced storage-specialist/g) ?? [];
    assert.equal(traceMatches.length, 1, 'should trace exactly once, not twice');

    // The second one should either hit "already emitted" or "no pending tracker", not trace again
    const skipOrFallthrough = log.includes('already emitted') || log.includes('no pending tracker');
    assert.ok(skipOrFallthrough, 'duplicate idle should be skipped');
  } finally {
    await stopDaemon(daemon, home);
  }
});
