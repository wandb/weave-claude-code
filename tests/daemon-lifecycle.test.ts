// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Daemon lifecycle: idle/in-flight hold, session reconstruction across a
// restart, the `restart` CLI command, and startup herd-race safety. Each test
// spawns a REAL daemon subprocess (some via startTestDaemon, some manually) and
// tears it down in a finally/after so no daemon leaks. WEAVE_INACTIVITY_MS is
// set per spawned daemon via env, never process-global.

import { test, suite, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendToSocket, probeUnixSocket, SocketState } from '../src/utils.ts';
import { startTestDaemon, waitUntil } from './helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

// ---------------------------------------------------------------------------
// Idle / in-flight hold
//
// The daemon idles out after a quiet window, but the inactivity check only held
// it open for in-flight cross-session *team* work. A plain long-running tool or
// turn (longer than the timeout, with no other session active) tripped the
// timeout mid-flight: the daemon exited, dropped the still-open turn/tool spans,
// and the resumed work landed on a fresh, amnesiac daemon.
//
// The fix: also hold the daemon open while any session has an open turn span, a
// pending tool call, or a tracked subagent.
// ---------------------------------------------------------------------------

function writeInflightTranscript(home: string, sessionId: string): string {
  const dir = path.join(home, '.claude', 'projects', 'test', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do work' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', id: 'm1',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }],
      },
    }),
  ].join('\n') + '\n');
  return file;
}

test('daemon stays up past the inactivity timeout while a turn span is open', async () => {
  const d = await startTestDaemon({ env: { WEAVE_INACTIVITY_MS: '1000' } });
  try {
    const sessionId = 'inflight-001';
    const transcript = writeInflightTranscript(d.home, sessionId);
    await d.send({ hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcript });
    await d.send({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, transcript_path: transcript, prompt: 'a long-running task' });

    // Turn span is open and no further events arrive. Past the 1s timeout
    // (checks fire every ~500ms) the daemon must log that it is holding open
    // for in-flight work, and must NOT decide to shut down.
    const stayedUp = await d.waitForLog(/work in flight — staying up/, 3000);
    assert.ok(stayedUp, `daemon should hold open while a turn is in flight; log was:\n${d.readLog()}`);
    assert.doesNotMatch(d.readLog(), /Inactivity timeout — shutting down/);
    assert.equal(d.hasExited(), false, 'daemon should still be running');
  } finally {
    await d.stop();
  }
});

test('daemon still idles out once the turn closes and nothing is in flight', async () => {
  const d = await startTestDaemon({ env: { WEAVE_INACTIVITY_MS: '1000' } });
  try {
    const sessionId = 'inflight-002';
    const transcript = writeInflightTranscript(d.home, sessionId);
    await d.send({ hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcript });
    await d.send({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, transcript_path: transcript, prompt: 'a quick task' });
    await d.send({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcript });

    // Turn span closed → nothing in flight → the daemon must still decide to
    // idle out (the in-flight hold must not pin it open forever).
    const shuttingDown = await d.waitForLog(/Inactivity timeout — shutting down/, 3500);
    assert.ok(shuttingDown, `daemon should idle out after the turn closes; log was:\n${d.readLog()}`);
  } finally {
    await d.stop();
  }
});

// ---------------------------------------------------------------------------
// Session reconstruction across a daemon restart
//
// The daemon shuts itself down after a short idle window and keeps all session
// state in memory, seeded only at SessionStart. A Claude Code session that
// outlives a daemon restart (e.g. the user steps away, the daemon idles
// out, then they resume the SAME session) sends its next UserPromptSubmit to a
// fresh daemon that never saw its SessionStart, producing "Unknown session"
// and silently dropping all tracing for the rest of that session.
//
// The fix: reconstruct the session from the `transcript_path` carried on the
// event, so the daemon is tolerant of its own restarts.
// ---------------------------------------------------------------------------

/** Write a transcript with `turns` completed user+assistant pairs and return
 *  its path. Lives under the daemon's $HOME so TranscriptFile's within-home
 *  check passes. */
function writeReconTranscript(home: string, sessionId: string, turns: number): string {
  const dir = path.join(home, '.claude', 'projects', 'test', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `prompt ${i}` }] } }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', id: `m${i}`,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'end_turn', content: [{ type: 'text', text: `answer ${i}` }],
      },
    }));
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('UserPromptSubmit for an unknown session reconstructs it from transcript_path and opens a turn span', async () => {
  const d = await startTestDaemon();
  try {
    const sessionId = 'recon-sess-001';
    const transcript = writeReconTranscript(d.home, sessionId, 1);

    // No SessionStart, this session predates this daemon instance.
    await d.send({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: transcript,
      prompt: 'continue the work',
    });

    const traced = await d.waitForLog(/Created turn span/, 3000);
    assert.ok(traced, `expected a turn span for the reconstructed session; log was:\n${d.readLog()}`);

    const log = d.readLog();
    assert.match(log, /Session reconstructed after restart: recon-sess-001/);
    assert.doesNotMatch(log, /Unknown session/);
  } finally {
    await d.stop();
  }
});

test('reconstructed session continues turn numbering from the transcript', async () => {
  const d = await startTestDaemon();
  try {
    const sessionId = 'recon-sess-002';
    // Three completed turns already on disk → the resumed turn is turn 4.
    const transcript = writeReconTranscript(d.home, sessionId, 3);

    await d.send({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: transcript,
      prompt: 'fourth prompt',
    });

    const ok = await d.waitForLog(/Created turn span \(turn 4\)/, 3000);
    assert.ok(ok, `expected the reconstructed turn to be numbered 4; log was:\n${d.readLog()}`);
  } finally {
    await d.stop();
  }
});

// ---------------------------------------------------------------------------
// `weave-claude-code restart`: stop a running daemon and start a fresh one, and
// refuse to spawn an unconfigured daemon.
//
// Sockets live under /tmp (macOS 104-char path cap); see stale-daemon-socket.test.ts.
// ---------------------------------------------------------------------------

const homes: string[] = [];
const sockets: string[] = [];

after(async () => {
  // Best-effort: stop any daemon a test left running, then remove temp homes.
  for (const s of sockets) {
    if ((await probeUnixSocket(s)) === SocketState.Alive) {
      try { await sendToSocket(s, JSON.stringify({ command: 'shutdown' })); } catch { /* gone */ }
    }
  }
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

function newHome(
  label: string,
  cfg: { weave_project?: string | null; wandb_api_key?: string | null; agent_name?: string | null },
): { home: string; socketPath: string } {
  const home = fs.mkdtempSync(`/tmp/wcp-${label}-`);
  homes.push(home);
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const socketPath = path.join(dir, 'daemon.sock');
  sockets.push(socketPath);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    log_file: path.join(dir, 'logs', 'daemon.log'),
    daemon_socket: socketPath,
    weave_project: cfg.weave_project ?? null,
    wandb_api_key: cfg.wandb_api_key ?? null,
    agent_name: cfg.agent_name ?? null,
    debug: false,
    installed_at: '2026-01-01T00:00:00Z',
    version: '0.0.0-test',
  }, null, 2));
  return { home, socketPath };
}

function runRestart(home: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home };
    delete env.WANDB_API_KEY;
    delete env.WEAVE_PROJECT;
    delete env.WEAVE_AGENT_NAME;
    // Keep the OTel exporter from reaching real wandb.ai; refuse fast instead.
    env.WANDB_BASE_URL = 'http://127.0.0.1:1';
    // Backstop: a daemon leaked by an assertion failure self-exits quickly.
    env.WEAVE_INACTIVITY_MS = '20000';
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'restart'], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

async function waitForState(socketPath: string, want: (s: SocketState) => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (want(await probeUnixSocket(socketPath))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForState timeout after ${timeoutMs}ms (last=${await probeUnixSocket(socketPath)})`);
}

suite('weave-claude-code restart', () => {
  test('refuses to start a daemon and exits non-zero when unconfigured', async () => {
    const { home, socketPath } = newHome('restart-unconfigured', {});
    const r = await runRestart(home);
    assert.notEqual(r.code, 0, `expected non-zero exit; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout + r.stderr, /missing configuration|weave_project/i);
    assert.equal(fs.existsSync(socketPath), false, 'no daemon socket should be created when unconfigured');
  });

  test('stops a running daemon and starts a fresh one', async () => {
    const { home, socketPath } = newHome('restart-happy', {
      weave_project: 'fake-entity/fake-project',
      wandb_api_key: 'fake-api-key',
    });

    // Cold start: no daemon yet, so restart should bring one up.
    const first = await runRestart(home);
    assert.equal(first.code, 0, `cold restart should exit 0; stdout=${first.stdout} stderr=${first.stderr}`);
    await waitForState(socketPath, (s) => s === SocketState.Alive);

    // Warm restart: a daemon is alive, so restart must stop it and start anew.
    const second = await runRestart(home);
    assert.equal(second.code, 0, `warm restart should exit 0; stdout=${second.stdout} stderr=${second.stderr}`);
    await waitForState(socketPath, (s) => s === SocketState.Alive);

    // Cleanup so the detached daemon does not linger.
    await sendToSocket(socketPath, JSON.stringify({ command: 'shutdown' }));
    await waitForState(socketPath, (s) => s !== SocketState.Alive);
  });
});

// ---------------------------------------------------------------------------
// Startup herd race
//
// Herd safety. When several hooks fire at once and each cold-starts a daemon,
// only one can bind the socket; the losers must yield cleanly. The old start()
// guarded with existsSync -> probe -> unlink, then listen() and threw on error.
// Two daemons that both found no socket raced listen(): the loser crashed with
// EEXIST/EADDRINUSE ("Daemon failed to start", exit 1). Seven such crashes
// appeared in one local log over 14 days.
//
// The race is inherent, so a single run is probabilistic (measured on the old
// code: ~2 of 3 herds crash at least one daemon, the rest happen to serialize).
// The assertion here is therefore the POST-FIX invariant, which is
// deterministic once listen() errors are handled by re-probing instead of
// throwing: a herd crashes nobody and leaves exactly one listener.
// ---------------------------------------------------------------------------

test('a herd of concurrent daemon starts crashes nobody and leaves exactly one listener', async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-herd-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      weave_project: 'test/test', wandb_api_key: 'fake-key',
      daemon_socket: socketPath, log_file: logPath, debug: true,
    }),
  );

  const N = 12;
  const procs = Array.from({ length: N }, () =>
    spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
      env: { ...process.env, HOME: home, WANDB_BASE_URL: 'http://127.0.0.1:1' },
      stdio: 'ignore',
    }),
  );
  try {
    await waitUntil(() => fs.existsSync(socketPath), 5000);
    await new Promise((r) => setTimeout(r, 2000)); // let every daemon resolve bind/yield

    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const failures = (log.match(/Daemon failed to start/g) ?? []).length;
    const started = (log.match(/Daemon started/g) ?? []).length;

    assert.equal(failures, 0, `herd must not crash any daemon; log:\n${log}`);
    assert.equal(started, 1, `exactly one daemon should bind, got ${started}; log:\n${log}`);
    assert.equal(await probeUnixSocket(socketPath), 'alive', 'a live listener should own the socket');
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
