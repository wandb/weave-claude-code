// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// End-to-end tests for the daemon socket lifecycle. Five layers, one file:
//
//   probeUnixSocket  : pure helper in src/utils.ts (alive | stale | absent)
//   hook-socket.mjs  : per-event Node client (probe + send subcommands)
//   cmdStatus        : src/cli.ts surfaces stale state and exits non-zero
//   hook-handler.sh  : bash hook orchestrating probe, cold-start, send
//   daemon signals   : src/daemon.ts unlinks the socket on SIGHUP / exit
//
// macOS limits UNIX socket paths to 104 chars (Linux 108). The per-user tmpdir
// on macOS is already ~48 chars, so paths nested under it silently truncate at
// bind() time. Everything that bind()s a socket lives directly under /tmp.

import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeUnixSocket } from '../src/utils.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'hooks', 'hook-handler.sh');
const HOOK_SOCKET_MJS = path.join(REPO_ROOT, 'hooks', 'hook-socket.mjs');
const FAKE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-weave-claude-code-bin');
const BIND_FIXTURE = new URL('./fixtures/bind-socket-child.mjs', import.meta.url);

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-stale-test-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

interface Workspace {
  home: string;
  configDir: string;
  socketPath: string;
  requestLog: string;
  pidFile: string;
  errorLog: string;
}

function newWorkspace(label: string): Workspace {
  const home = fs.mkdtempSync(path.join(scratch, `${label}-`));
  const configDir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  const socketPath = path.join(configDir, 'daemon.sock');
  const settings = {
    weave_project: 'fake-entity/fake-project',
    wandb_api_key: 'fake-api-key',
    daemon_socket: socketPath,
    log_file: path.join(configDir, 'logs', 'daemon.log'),
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return {
    home,
    configDir,
    socketPath,
    requestLog: path.join(home, 'requests.log'),
    pidFile: path.join(home, 'daemon.pid'),
    errorLog: path.join(configDir, 'logs', 'hook-errors.log'),
  };
}

// Reproduce the production failure mode: child binds the socket, then is
// SIGKILL'd. The kernel never unlinks UNIX socket inodes, so the path remains
// as a "stale" socket file with no listener — exactly what the daemon left
// behind on terminal SIGHUP in the original bug.
async function abandonSocket(socketPath: string): Promise<void> {
  const child = fork(BIND_FIXTURE, [socketPath], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('message', (m) => m === 'listening' ? resolve() : reject(new Error(String(m))));
    child.once('exit', (code) => reject(new Error(`bind child exited early: ${code}`)));
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  assert.equal(fs.existsSync(socketPath), true, 'SIGKILL should leave the socket inode behind');
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

function readPid(workspace: Workspace): number | null {
  if (!fs.existsSync(workspace.pidFile)) return null;
  return Number(fs.readFileSync(workspace.pidFile, 'utf8').trim());
}

function killIfAlive(pid: number | null): void {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* probably already gone */ }
}

// ─────────────────────────────────────────────────────────────────────────────
suite('probeUnixSocket', () => {
  test('returns "absent" when the path does not exist', async () => {
    const w = newWorkspace('probe-absent');
    assert.equal(await probeUnixSocket(w.socketPath), 'absent');
  });

  test('returns "alive" while a server is listening', async () => {
    const w = newWorkspace('probe-alive');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(w.socketPath, () => resolve());
    });
    try {
      assert.equal(await probeUnixSocket(w.socketPath), 'alive');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('returns "stale" after the listener died ungracefully', async () => {
    const w = newWorkspace('probe-stale');
    await abandonSocket(w.socketPath);
    assert.equal(await probeUnixSocket(w.socketPath), 'stale');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Direct tests of hooks/hook-socket.mjs, the per-event Node client invoked by
// hook-handler.sh (replaces the previous `nc -U -w1` calls). The bash-level
// integration tests in the `hook-handler.sh` suite below exercise this script
// transitively; these tests pin the script's CLI contract on its own.

interface MjsResult { code: number | null; stderr: string; stdout: string; }

function runMjs(args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<MjsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [HOOK_SOCKET_MJS, ...args],
      { env: { ...process.env, ...(opts.env ?? {}) } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr, stdout }));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

suite('hook-socket.mjs probe', () => {
  test('exits 0 when a listener accepts', async () => {
    const w = newWorkspace('mjs-probe-alive');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(w.socketPath, () => resolve());
    });
    try {
      const r = await runMjs(['probe', w.socketPath]);
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('exits 1 when the socket path does not exist', async () => {
    const w = newWorkspace('mjs-probe-absent');
    const r = await runMjs(['probe', w.socketPath]);
    assert.equal(r.code, 1);
  });

  test('exits 1 when the socket inode is stale', async () => {
    const w = newWorkspace('mjs-probe-stale');
    await abandonSocket(w.socketPath);
    const r = await runMjs(['probe', w.socketPath]);
    assert.equal(r.code, 1);
  });
});

suite('hook-socket.mjs send', () => {
  async function withListener<T>(
    socketPath: string,
    fn: (received: string[]) => Promise<T>,
  ): Promise<T> {
    const received: string[] = [];
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => { buf += d.toString(); });
      c.on('end', () => { received.push(buf); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    try {
      return await fn(received);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  test('delivers stdin payload to the listening socket', async () => {
    const w = newWorkspace('mjs-send-payload');
    await withListener(w.socketPath, async (received) => {
      const r = await runMjs(['send', w.socketPath], { stdin: '{"event":"SessionStart"}' });
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(received, ['{"event":"SessionStart"}']);
    });
  });

  test('merges WEAVE_PARENT_CALL_ID and WEAVE_TRACE_ID into the payload', async () => {
    const w = newWorkspace('mjs-send-merge');
    await withListener(w.socketPath, async (received) => {
      const r = await runMjs(['send', w.socketPath], {
        stdin: '{"event":"PreToolUse"}',
        env: { WEAVE_PARENT_CALL_ID: 'call-abc', WEAVE_TRACE_ID: 'trace-xyz' },
      });
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(received.length, 1);
      const parsed = JSON.parse(received[0]!);
      assert.equal(parsed.event, 'PreToolUse');
      assert.equal(parsed.weave_parent_call_id, 'call-abc');
      assert.equal(parsed.weave_trace_id, 'trace-xyz');
    });
  });

  test('passes payload through unchanged when no Weave env vars are set', async () => {
    const w = newWorkspace('mjs-send-passthrough');
    await withListener(w.socketPath, async (received) => {
      const r = await runMjs(['send', w.socketPath], {
        stdin: '{"event":"Stop","raw":"untouched"}',
        env: { WEAVE_PARENT_CALL_ID: '', WEAVE_TRACE_ID: '' },
      });
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(received, ['{"event":"Stop","raw":"untouched"}']);
    });
  });

  test('exits 1 when the socket path does not exist', async () => {
    const w = newWorkspace('mjs-send-absent');
    const r = await runMjs(['send', w.socketPath], { stdin: '{}' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /hook-socket send/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('weave-claude-code status', () => {
  function runStatus(home: string): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', CLI, 'status'],
        { cwd: REPO_ROOT, env: { ...process.env, HOME: home } },
      );
      let stdout = '';
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ stdout, code }));
    });
  }

  test('reports "stale" and exits non-zero when the socket has no listener', async () => {
    const w = newWorkspace('status-stale');
    await abandonSocket(w.socketPath);
    const r = await runStatus(w.home);
    assert.match(r.stdout, /stale/);
    assert.notEqual(r.code, 0, `expected non-zero exit on stale; stdout was: ${r.stdout}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('hook-handler.sh', () => {
  before(() => {
    // The fake binary loses its executable bit during git clone on some setups;
    // re-stamp it so the integration tests can actually invoke it.
    fs.chmodSync(path.join(FAKE_BIN_DIR, 'weave-claude-code'), 0o755);
  });

  function runHook(w: Workspace, payload: string): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'bash',
        [HOOK_SCRIPT],
        {
          env: {
            ...process.env,
            PATH: `${FAKE_BIN_DIR}:${process.env.PATH}`,
            HOME: w.home,
            WCP_SOCK_PATH: w.socketPath,
            WCP_REQUEST_LOG: w.requestLog,
            WCP_PID_FILE: w.pidFile,
          },
        },
      );
      let stderr = '';
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      child.stdin.end(payload);
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr }));
    });
  }

  test('cold-starts daemon and forwards the payload when no socket exists', async () => {
    const w = newWorkspace('hook-cold');
    try {
      const r = await runHook(w, '{"event":"SessionStart"}\n');
      assert.equal(r.code, 0, `hook should exit 0 — stderr=${r.stderr}`);
      await waitFor(() => fs.existsSync(w.requestLog) && fs.readFileSync(w.requestLog, 'utf8').includes('SessionStart'));
    } finally {
      killIfAlive(readPid(w));
    }
  });

  test('recovers from a stale socket inode (the bug fix)', async () => {
    const w = newWorkspace('hook-stale');
    await abandonSocket(w.socketPath);
    try {
      const r = await runHook(w, '{"event":"SessionStart"}\n');
      assert.equal(r.code, 0, `hook should exit 0 — stderr=${r.stderr}`);
      await waitFor(() => fs.existsSync(w.requestLog) && fs.readFileSync(w.requestLog, 'utf8').includes('SessionStart'));
      const errors = fs.existsSync(w.errorLog) ? fs.readFileSync(w.errorLog, 'utf8') : '';
      assert.doesNotMatch(errors, /Failed to send event to daemon/, 'no failed-send error after recovery');
    } finally {
      killIfAlive(readPid(w));
    }
  });

  test('reuses an already-running daemon on subsequent events (hot path)', async () => {
    const w = newWorkspace('hook-hot');
    let firstPid: number | null = null;
    try {
      await runHook(w, '{"event":"SessionStart"}\n');
      await waitFor(() => readPid(w) !== null);
      firstPid = readPid(w);

      await runHook(w, '{"event":"PreToolUse"}\n');
      await waitFor(() => fs.readFileSync(w.requestLog, 'utf8').includes('PreToolUse'));
      assert.equal(readPid(w), firstPid, 'no new daemon should spawn on the hot path');
    } finally {
      killIfAlive(firstPid);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('daemon signal cleanup', () => {
  test('unlinks the socket file on SIGHUP (terminal close)', async () => {
    const w = newWorkspace('daemon-sighup');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI, 'daemon'],
      {
        cwd: REPO_ROOT,
        // Point WANDB_BASE_URL at a port that refuses connections so the OTel
        // exporter never reaches real wandb.ai during the test.
        env: { ...process.env, HOME: w.home, WANDB_BASE_URL: 'http://127.0.0.1:1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      await waitFor(() => fs.existsSync(w.socketPath), 5000);

      child.kill('SIGHUP');
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('daemon did not exit')), 5000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });

      assert.equal(fs.existsSync(w.socketPath), false, 'daemon must unlink its socket on SIGHUP');
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  });
});
