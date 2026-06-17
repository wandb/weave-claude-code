// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for `weave-claude-code restart`: stop a running daemon and start a
// fresh one, and refuse to spawn an unconfigured daemon.
//
// Sockets live under /tmp (macOS 104-char path cap); see stale-daemon-socket.test.ts.

import { test, suite, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendToSocket, probeUnixSocket, SocketState } from '../src/utils.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

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
