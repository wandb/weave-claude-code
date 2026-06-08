// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for the TeammateIdle handler's transcript parsing behaviour.
//
// Teammate transcripts differ from subagent transcripts in two ways:
//   1. They live at <project-dir>/<session-id>.jsonl (not under subagents/)
//   2. The first line is an agent-setting record, not a user message:
//      {"type":"agent-setting","agentSetting":"cks-specialist","sessionId":"..."}
//
// Actual TeammateIdle payload schema (confirmed from live TARS triage, NOT CC docs):
//   teammate_name  — agent name, e.g. "cks-specialist"   (docs said: agent_type)
//   team_name      — team name, e.g. "triage-supp-25017" (docs said: agent_id)
//   transcript_path — teammate's transcript path          (docs said: coordinator's)
//
// The integration test below sends this real payload schema through the daemon
// to catch any regression in field-name reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFirstTranscriptLine } from '../src/transcriptFile.ts';
import { parseSessionFile } from '../src/parser.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── test data ─────────────────────────────────────────────────────────────────

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

// ── tests ─────────────────────────────────────────────────────────────────────

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

// The invoke_agent -> chat span-tree shape and cache-inclusive token math are
// covered by the SDK's own genai tests (subagent.ts nesting) and
// genai-span-usage-tokens.test.ts (emitChatSpansViaSDK); the daemon-level
// integration tests below exercise the full TeammateIdle path end-to-end.

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

// ── integration: actual payload field names ───────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

test('TeammateIdle: full TARS sequence — SubagentStart → SubagentStop → TeammateIdle traces with all turns', async () => {
  // Replicate the real TARS triage sequence:
  //   1. Coordinator dispatches specialist via Agent tool (PreToolUse not tested here — SubagentStart is the entry point)
  //   2. SubagentStart fires (orphan — no matching PreToolUse tracker) → creates invoke_agent span, stores transcript path
  //   3. SubagentStop fires → span kept open (pendingTeammateIdle=true), tracker stays in SubagentTracking
  //   4. TeammateIdle fires → finds tracker, emits all-turns chat spans, closes span
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

  const daemon = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home },
    stdio: 'ignore',
  });

  const sendEvent = (payload: object): Promise<void> => new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('error', reject);
    s.on('connect', () => { s.end(JSON.stringify(payload)); });
    s.on('close', () => resolve());
  });

  const waitForSocket = (): Promise<void> => new Promise((resolve) => {
    const poll = setInterval(() => {
      if (fs.existsSync(socketPath)) { clearInterval(poll); resolve(); }
    }, 50);
  });

  const readLog = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

  try {
    await waitForSocket();
    await new Promise(r => setTimeout(r, 200));

    // Step 1: Coordinator session starts and submits prompt
    await sendEvent({ hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-99999' });
    await new Promise(r => setTimeout(r, 100));

    // Step 2: SubagentStart (orphan — no matching PreToolUse)
    await sendEvent({
      hook_event_name: 'SubagentStart',
      session_id: coordinatorSessionId,
      agent_id: agentId,
      agent_type: 'cks-specialist',
      transcript_path: agentTranscriptPath,
    });
    await new Promise(r => setTimeout(r, 100));

    // Step 3: SubagentStop — should keep span open (pendingTeammateIdle)
    await sendEvent({
      hook_event_name: 'SubagentStop',
      session_id: coordinatorSessionId,
      agent_id: agentId,
      agent_transcript_path: agentTranscriptPath,
    });
    await new Promise(r => setTimeout(r, 100));

    // Step 4: TeammateIdle — should close span with all-turns content
    // CC sends coordinator's transcript_path (not the agent's) — daemon uses stored path instead
    await sendEvent({
      hook_event_name: 'TeammateIdle',
      session_id: coordinatorSessionId,
      transcript_path: coordinatorPath,  // coordinator's path (as CC sends it)
      teammate_name: 'cks-specialist',
      team_name: 'triage-inttest',
    });
    await new Promise(r => setTimeout(r, 400));

    const log = readLog();
    assert.match(log, /TeammateIdle: traced cks-specialist/, 'should trace cks-specialist');
    assert.doesNotMatch(log, /missing agent_id/, 'should not error on missing agent_id');
    assert.doesNotMatch(log, /no pending tracker for cks-specialist/, 'should find the pending tracker from SubagentStart');
  } finally {
    daemon.kill();
    await new Promise<void>(resolve => daemon.once('exit', () => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── cross-session: agent-teams (TeamCreate) model ───────────────────────────
//
// In agent-teams, the teammate is an independent Claude session. SubagentStart
// does NOT fire for teammates. The sequence is:
//   1. Coordinator: PreToolUse(Agent, team_name) → creates tracker + team member
//   2. Teammate: SessionStart (new session_id)
//   3. Teammate: TeammateIdle (from teammate's session, NOT coordinator's)
// The cross-session team registry bridges coordinator → teammate.

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

  const daemon = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home },
    stdio: 'ignore',
  });

  const sendEvent = (payload: object): Promise<void> => new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('error', reject);
    s.on('connect', () => { s.end(JSON.stringify(payload)); });
    s.on('close', () => resolve());
  });

  const waitForSocket = (): Promise<void> => new Promise((resolve) => {
    const poll = setInterval(() => {
      if (fs.existsSync(socketPath)) { clearInterval(poll); resolve(); }
    }, 50);
  });

  const readLog = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

  try {
    await waitForSocket();
    await new Promise(r => setTimeout(r, 200));

    // Step 1: Coordinator starts and submits prompt
    await sendEvent({ hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-crosstest' });
    await new Promise(r => setTimeout(r, 100));

    // Step 2: PreToolUse(Agent, team_name) in coordinator session
    await sendEvent({
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
    await new Promise(r => setTimeout(r, 100));

    // Verify team member was registered
    let log = readLog();
    assert.match(log, /Team member registered/, 'coordinator PreToolUse should register team member');

    // Step 3: PostToolUse(Agent) — should NOT close the span (team mode)
    await sendEvent({
      hook_event_name: 'PostToolUse',
      session_id: coordinatorSessionId,
      tool_use_id: 'toolu_cross_001',
      tool_name: 'Agent',
      tool_response: 'Agent dispatched',
    });
    await new Promise(r => setTimeout(r, 100));

    // Step 4: Teammate session starts (DIFFERENT session_id)
    await sendEvent({ hook_event_name: 'SessionStart', session_id: teammateSessionId, transcript_path: teammatePath });
    await new Promise(r => setTimeout(r, 100));

    // Step 5: TeammateIdle fires from TEAMMATE's session (the cross-session case)
    await sendEvent({
      hook_event_name: 'TeammateIdle',
      session_id: teammateSessionId,
      transcript_path: teammatePath,
      teammate_name: teammateName,
      team_name: teamName,
    });
    await new Promise(r => setTimeout(r, 400));

    log = readLog();
    assert.match(log, /TeammateIdle: traced cks-specialist team=triage-crosstest \(cross-session\)/, 'should trace via cross-session path');
    assert.doesNotMatch(log, /no pending tracker for cks-specialist/, 'should NOT fall through to per-session path');
  } finally {
    daemon.kill();
    await new Promise<void>(resolve => daemon.once('exit', () => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Cross-session: re-spawn of same team::name nests BOTH (FIFO queue, no overwrite)', async () => {
  // Regression for the re-spawn bug: TARS re-spawns a specialist (Sonnet→Opus)
  // within one run. A second PreToolUse(Agent) for the same `${team}::${name}`
  // must APPEND to a FIFO queue, not overwrite the first still-open span (which
  // would leak it and mis-attribute the first teammate's transcript).
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

  const daemon = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home }, stdio: 'ignore',
  });
  const sendEvent = (payload: object): Promise<void> => new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('error', reject);
    s.on('connect', () => { s.end(JSON.stringify(payload)); });
    s.on('close', () => resolve());
  });
  const waitForSocket = (): Promise<void> => new Promise((resolve) => {
    const poll = setInterval(() => { if (fs.existsSync(socketPath)) { clearInterval(poll); resolve(); } }, 50);
  });
  const readLog = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

  try {
    await waitForSocket();
    await new Promise(r => setTimeout(r, 200));
    await sendEvent({ hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-respawn' });
    await new Promise(r => setTimeout(r, 100));

    // FIRST spawn of cks-specialist
    await sendEvent({ hook_event_name: 'PreToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_r1',
      tool_name: 'Agent', tool_input: { prompt: 'first', subagent_type: teammateName, team_name: teamName, name: teammateName } });
    await new Promise(r => setTimeout(r, 80));
    // SECOND spawn of the SAME team::name (the re-spawn) BEFORE the first idles
    await sendEvent({ hook_event_name: 'PreToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_r2',
      tool_name: 'Agent', tool_input: { prompt: 'second', subagent_type: teammateName, team_name: teamName, name: teammateName } });
    await new Promise(r => setTimeout(r, 120));

    let log = readLog();
    assert.match(log, /queue depth 2/, 'second spawn of same key should APPEND to FIFO queue (depth 2), not overwrite');

    // both teammate sessions start, then both idle
    await sendEvent({ hook_event_name: 'SessionStart', session_id: tm1, transcript_path: tp1 });
    await sendEvent({ hook_event_name: 'SessionStart', session_id: tm2, transcript_path: tp2 });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'TeammateIdle', session_id: tm1, transcript_path: tp1, teammate_name: teammateName, team_name: teamName });
    await new Promise(r => setTimeout(r, 200));
    await sendEvent({ hook_event_name: 'TeammateIdle', session_id: tm2, transcript_path: tp2, teammate_name: teammateName, team_name: teamName });
    await new Promise(r => setTimeout(r, 400));

    log = readLog();
    const traced = log.match(/TeammateIdle: traced cks-specialist team=triage-respawn \(cross-session\)/g) ?? [];
    assert.equal(traced.length, 2, `BOTH re-spawned teammates should nest (no overwrite/leak) — got ${traced.length}`);
  } finally {
    daemon.kill();
    await new Promise<void>(resolve => daemon.once('exit', () => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
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
  const daemon = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home, WEAVE_INACTIVITY_MS: '800' }, stdio: 'ignore',
  });
  const sendEvent = (payload: object): Promise<void> => new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('error', reject);
    s.on('connect', () => { s.end(JSON.stringify(payload)); });
    s.on('close', () => resolve());
  });
  const isAlive = (): Promise<boolean> => new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    s.on('error', () => resolve(false));
    s.on('connect', () => { s.destroy(); resolve(true); });
  });
  const waitForSocket = (): Promise<void> => new Promise((resolve) => {
    const poll = setInterval(() => { if (fs.existsSync(socketPath)) { clearInterval(poll); resolve(); } }, 50);
  });
  const readLog = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

  try {
    await waitForSocket();
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await sendEvent({ hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage supp-inact' });
    // Register a team member (unemitted), then go quiet — NO TeammateIdle.
    await sendEvent({ hook_event_name: 'PreToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_inact_1',
      tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: teammateName, team_name: teamName, name: teammateName } });

    // Wait well past the 800ms timeout (multiple ~500ms check intervals) with no activity.
    await new Promise(r => setTimeout(r, 2600));

    assert.equal(await isAlive(), true, 'daemon must stay UP past the inactivity timeout while a team member is unemitted');
    assert.match(readLog(), /team correlation in flight — staying up/, 'should log that it stayed up for in-flight team work');
  } finally {
    daemon.kill();
    await new Promise<void>(resolve => daemon.once('exit', () => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
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

  const daemon = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home },
    stdio: 'ignore',
  });
  const sendEvent = (payload: object): Promise<void> => new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('error', reject);
    s.on('connect', () => { s.end(JSON.stringify(payload)); });
    s.on('close', () => resolve());
  });
  const waitForSocket = (): Promise<void> => new Promise((resolve) => {
    const poll = setInterval(() => {
      if (fs.existsSync(socketPath)) { clearInterval(poll); resolve(); }
    }, 50);
  });
  const readLog = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

  try {
    await waitForSocket();
    await new Promise(r => setTimeout(r, 200));

    await sendEvent({ hook_event_name: 'SessionStart', session_id: coordinatorSessionId, transcript_path: coordinatorPath });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'UserPromptSubmit', session_id: coordinatorSessionId, transcript_path: coordinatorPath, prompt: '/triage' });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({
      hook_event_name: 'PreToolUse', session_id: coordinatorSessionId,
      tool_use_id: 'toolu_dup_001', tool_name: 'Agent',
      tool_input: { prompt: 'Check storage', subagent_type: 'storage-specialist', team_name: 'triage-duptest', name: 'storage-specialist' },
    });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'PostToolUse', session_id: coordinatorSessionId, tool_use_id: 'toolu_dup_001', tool_name: 'Agent', tool_response: 'dispatched' });
    await new Promise(r => setTimeout(r, 100));
    await sendEvent({ hook_event_name: 'SessionStart', session_id: teammateSessionId, transcript_path: teammatePath });
    await new Promise(r => setTimeout(r, 100));

    // First TeammateIdle — should trace
    await sendEvent({
      hook_event_name: 'TeammateIdle', session_id: teammateSessionId, transcript_path: teammatePath,
      teammate_name: 'storage-specialist', team_name: 'triage-duptest',
    });
    await new Promise(r => setTimeout(r, 300));

    // Second TeammateIdle (duplicate) — should skip
    await sendEvent({
      hook_event_name: 'TeammateIdle', session_id: teammateSessionId, transcript_path: teammatePath,
      teammate_name: 'storage-specialist', team_name: 'triage-duptest',
    });
    await new Promise(r => setTimeout(r, 300));

    const log = readLog();
    const traceMatches = log.match(/TeammateIdle: traced storage-specialist/g) ?? [];
    assert.equal(traceMatches.length, 1, 'should trace exactly once, not twice');

    // The second one should either hit "already emitted" or "no pending tracker" — not trace again
    const skipOrFallthrough = log.includes('already emitted') || log.includes('no pending tracker');
    assert.ok(skipOrFallthrough, 'duplicate idle should be skipped');
  } finally {
    daemon.kill();
    await new Promise<void>(resolve => daemon.once('exit', () => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
