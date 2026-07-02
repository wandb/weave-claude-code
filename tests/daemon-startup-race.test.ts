// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeUnixSocket } from '../src/utils.ts';
import { waitUntil } from './helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

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
