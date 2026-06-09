// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for `weave-claude-code send-event` and `weave-claude-code probe-socket`,
// the two subcommands that replaced the hook handler's `nc` calls. The hook
// integration suite in stale-daemon-socket.test.ts exercises the bash script
// against a fake bin; these tests exercise the *real* TypeScript implementation
// directly. macOS limits UNIX socket paths to 104 chars, so sockets live under
// /tmp.

import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const BIND_FIXTURE = new URL('./fixtures/bind-socket-child.mjs', import.meta.url);

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-send-probe-test-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

interface RunResult { code: number | null; stderr: string; stdout: string; }

function runCli(args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: REPO_ROOT, env: { ...process.env, ...(opts.env ?? {}) } },
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

// Bind a socket, then SIGKILL the binding process to leave a "stale" inode
// (mirrors the abandonSocket helper in stale-daemon-socket.test.ts).
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
}

function freshSocketPath(label: string): string {
  return path.join(scratch, `${label}-${Date.now()}.sock`);
}

// ─────────────────────────────────────────────────────────────────────────────
suite('probe-socket', () => {
  test('exits 0 when a listener accepts', async () => {
    const sockPath = freshSocketPath('probe-alive');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      const r = await runCli(['probe-socket', '--path', sockPath]);
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('exits 1 when the socket path does not exist', async () => {
    const sockPath = freshSocketPath('probe-absent');
    const r = await runCli(['probe-socket', '--path', sockPath]);
    assert.equal(r.code, 1);
  });

  test('exits 1 when the socket inode is stale', async () => {
    const sockPath = freshSocketPath('probe-stale');
    await abandonSocket(sockPath);
    const r = await runCli(['probe-socket', '--path', sockPath]);
    assert.equal(r.code, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('send-event', () => {
  async function withListener<T>(
    sockPath: string,
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
      server.listen(sockPath, () => resolve());
    });
    try {
      return await fn(received);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  test('delivers stdin payload to the listening socket', async () => {
    const sockPath = freshSocketPath('send-payload');
    await withListener(sockPath, async (received) => {
      const r = await runCli(['send-event', '--path', sockPath], {
        stdin: '{"event":"SessionStart"}',
      });
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
      // Give the server a tick to flush the 'end' event before asserting.
      await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(received, ['{"event":"SessionStart"}']);
    });
  });

  test('merges WEAVE_PARENT_CALL_ID and WEAVE_TRACE_ID into the payload', async () => {
    const sockPath = freshSocketPath('send-merge');
    await withListener(sockPath, async (received) => {
      const r = await runCli(['send-event', '--path', sockPath], {
        stdin: '{"event":"PreToolUse"}',
        env: {
          WEAVE_PARENT_CALL_ID: 'call-abc',
          WEAVE_TRACE_ID: 'trace-xyz',
        },
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
    const sockPath = freshSocketPath('send-passthrough');
    await withListener(sockPath, async (received) => {
      // Explicitly clear the env vars so the test runner's env can't leak in.
      const r = await runCli(['send-event', '--path', sockPath], {
        stdin: '{"event":"Stop","raw":"untouched"}',
        env: { WEAVE_PARENT_CALL_ID: '', WEAVE_TRACE_ID: '' },
      });
      assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(received, ['{"event":"Stop","raw":"untouched"}']);
    });
  });

  test('exits 1 when the socket path does not exist', async () => {
    const sockPath = freshSocketPath('send-absent');
    const r = await runCli(['send-event', '--path', sockPath], { stdin: '{}' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /send-event/);
  });
});
