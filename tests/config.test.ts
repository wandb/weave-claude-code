// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Consolidated config-resolution / CLI tests. Covers:
//  - agent_name resolution: default, set, get/show, WEAVE_AGENT_NAME override
//  - `config set` masking of wandb_api_key vs. full echo of non-secret keys
//  - config-drift detection over the socket (fingerprint, fake daemon, real daemon)
//  - trace base URL resolution across WANDB_BASE_URL / WF_TRACE_SERVER_URL combos
// Each test keeps its original setup/teardown; the socket-drift and base-url
// helpers are distinct per concern and are not shared.

import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDaemonConfig, daemonConfigFingerprint } from '../src/config.ts';
import { seedConfigHome, runCli } from './helpers.ts';

// ─────────────────────────────────────────────────────────────────────────────
// agent_name resolution
//
// `config` support for the customizable top-level agent name.
// The seed settings file deliberately OMITS agent_name to mirror an install
// from before the field existed; `get` must still resolve to the default
// rather than error with "Unknown key".

test('config agent_name: default, set, get/show, and env-var override', async () => {
  const { home } = seedConfigHome('agentname');
  try {
    // get on a file missing the key resolves to the default, not an error.
    const def = await runCli(home, ['config', 'get', 'agent_name']);
    assert.equal(def.code, 0);
    assert.equal(def.stdout.trim(), 'claude-code');

    // set, then get/show reflect the value (surrounding whitespace is trimmed
    // at resolution time, so the effective value is clean).
    const set = await runCli(home, ['config', 'set', 'agent_name', '  my-team-bot  ']);
    assert.equal(set.code, 0);
    assert.equal((await runCli(home, ['config', 'get', 'agent_name'])).stdout.trim(), 'my-team-bot');
    assert.match((await runCli(home, ['config', 'show'])).stdout, /agent_name:\s+my-team-bot \[settings\.json\]/);

    // WEAVE_AGENT_NAME overrides the settings file.
    const env = { WEAVE_AGENT_NAME: 'from-env' };
    assert.equal((await runCli(home, ['config', 'get', 'agent_name'], env)).stdout.trim(), 'from-env');
    assert.match((await runCli(home, ['config', 'show'], env)).stdout, /agent_name:\s+from-env \[WEAVE_AGENT_NAME env var\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// `config set` secret masking
//
// `config set` must mask wandb_api_key in stdout (it didn't, see #66) but
// must still echo non-sensitive keys in full and persist the full secret.

const SECRET = 'wandb_v1_SUPERSECRETvalueDoNotLeak0123456789';

test('config set: masks wandb_api_key, echoes weave_project in full', async () => {
  const { home, settingsFile } = seedConfigHome('cfgset-mask');
  try {
    const apiKey = await runCli(home, ['config', 'set', 'wandb_api_key', SECRET]);
    assert.equal(apiKey.code, 0);
    assert.equal(apiKey.stdout.includes(SECRET), false, `stdout leaked the secret:\n${apiKey.stdout}`);
    assert.match(apiKey.stdout, /wand…/);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).wandb_api_key, SECRET);

    const project = await runCli(home, ['config', 'set', 'weave_project', 'my-entity/my-project']);
    assert.equal(project.code, 0);
    assert.match(project.stdout, /my-entity\/my-project/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// trace base URL resolution
//
// The daemon exports OTLP spans to the Weave trace server, not the wandb API
// host. SaaS `api.wandb.ai` has no OTLP route, so setting `WANDB_BASE_URL` to
// it (the wandb SDK default) must not silently misroute traces.

const SETTINGS = { weave_project: 'e/p', wandb_api_key: 'k' };
const baseUrlFor = (env: Record<string, string>): string =>
  resolveDaemonConfig(SETTINGS as never, env).baseUrl;

test('trace base URL resolution across env combinations', () => {
  // Unset → SaaS trace server default.
  assert.equal(baseUrlFor({}), 'https://trace.wandb.ai');

  // SaaS API host (and trailing-slash / scheme-case variants) remap to the
  // trace server rather than the routeless api host.
  assert.equal(baseUrlFor({ WANDB_BASE_URL: 'https://api.wandb.ai' }), 'https://trace.wandb.ai');
  assert.equal(baseUrlFor({ WANDB_BASE_URL: 'https://api.wandb.ai/' }), 'https://trace.wandb.ai');
  assert.equal(baseUrlFor({ WANDB_BASE_URL: 'HTTPS://API.WANDB.AI' }), 'https://trace.wandb.ai');

  // Self-hosted / dedicated base URL passes through unchanged (trailing slash trimmed).
  assert.equal(baseUrlFor({ WANDB_BASE_URL: 'https://my.wandb.io' }), 'https://my.wandb.io');
  assert.equal(baseUrlFor({ WANDB_BASE_URL: 'https://my.wandb.io/' }), 'https://my.wandb.io');

  // Explicit trace server URL wins over WANDB_BASE_URL and is not remapped.
  assert.equal(
    baseUrlFor({ WF_TRACE_SERVER_URL: 'https://trace.example.io/', WANDB_BASE_URL: 'https://api.wandb.ai' }),
    'https://trace.example.io',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// config-drift detection over the socket
//
// `status` asks the live daemon for the fingerprint of the config it loaded,
// and warns when settings.json now resolves to something different. Nothing is
// written to disk.
//
// Sockets live under /tmp (macOS 104-char path cap); see stale-daemon-socket.test.ts.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const WARNING = /⚠ Config\s+daemon on an older config/;
const STRIP = ['WEAVE_PROJECT', 'WANDB_API_KEY', 'WEAVE_AGENT_NAME', 'WANDB_BASE_URL', 'WEAVE_CLAUDE_DEBUG'];

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-drift-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function writeSettings(home: string, overrides: Record<string, unknown> = {}): { settings: Record<string, unknown>; socketPath: string } {
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const socketPath = path.join(dir, 'daemon.sock');
  const settings = {
    log_file: path.join(dir, 'logs', 'daemon.log'),
    daemon_socket: socketPath,
    weave_project: 'fake-entity/fake-project',
    wandb_api_key: 'fake-api-key',
    agent_name: 'goobers',
    debug: false,
    installed_at: '2026-01-01T00:00:00Z',
    version: '0.0.0-test',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return { settings, socketPath };
}

function runStatus(home: string, args: string[] = [], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of STRIP) delete env[k];
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'status', ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

// Stand-in daemon: accepts a connection and replies to any request with a fixed
// config_hash, mimicking the real daemon's `config-hash` control reply.
async function fakeDaemon(socketPath: string, replyHash: string): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buf = '';
    socket.on('data', (d) => { buf += d.toString(); });
    socket.on('end', () => { socket.end(JSON.stringify({ config_hash: replyHash })); });
    socket.on('error', () => { /* client may hang up */ });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

suite('daemonConfigFingerprint', () => {
  test('is stable for identical config and changes when agent_name changes', () => {
    const base = { weaveProject: 'e/p', apiKey: 'k', baseUrl: 'https://x', agentName: 'goober', debug: false };
    const fp = daemonConfigFingerprint(base);
    assert.equal(daemonConfigFingerprint({ ...base }), fp);
    assert.notEqual(daemonConfigFingerprint({ ...base, agentName: 'goobers' }), fp);
  });

  test('does not contain the raw API key', () => {
    const fp = daemonConfigFingerprint({ weaveProject: 'e/p', apiKey: 'SUPER-SECRET', baseUrl: 'https://x', agentName: 'a', debug: false });
    assert.doesNotMatch(fp, /SUPER-SECRET/);
  });
});

suite('status config-drift warning (socket query)', () => {
  test('warns when the daemon reports a different config than settings.json', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'drift-'));
    const { settings, socketPath } = writeSettings(home); // agent_name: goobers
    const older = daemonConfigFingerprint({ ...resolveDaemonConfig(settings as never, {}), agentName: 'goober' });
    const server = await fakeDaemon(socketPath, older);
    try {
      const pretty = await runStatus(home);
      assert.match(pretty.stdout, WARNING);
      const json = JSON.parse((await runStatus(home, ['--json'])).stdout) as Record<string, unknown>;
      assert.equal(json['config_drift'], true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('does not warn when the daemon reports the same config', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'match-'));
    const { settings, socketPath } = writeSettings(home);
    const current = daemonConfigFingerprint(resolveDaemonConfig(settings as never, {}));
    const server = await fakeDaemon(socketPath, current);
    try {
      const pretty = await runStatus(home);
      assert.doesNotMatch(pretty.stdout, WARNING);
      const json = JSON.parse((await runStatus(home, ['--json'])).stdout) as Record<string, unknown>;
      assert.equal(json['config_drift'], false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('does not warn when no daemon is running', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'down-'));
    writeSettings(home);
    const pretty = await runStatus(home);
    assert.doesNotMatch(pretty.stdout, WARNING);
    const json = JSON.parse((await runStatus(home, ['--json'])).stdout) as Record<string, unknown>;
    assert.equal(json['config_drift'], false);
  });
});

suite('status config-drift against a real daemon', () => {
  test('no drift initially, then drift after settings.json changes', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'real-'));
    const { socketPath } = writeSettings(home); // agent_name: goobers
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    for (const k of STRIP) delete env[k];
    env.WANDB_BASE_URL = 'http://127.0.0.1:1'; // never reach real wandb.ai
    env.WEAVE_INACTIVITY_MS = '20000';

    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], { cwd: REPO_ROOT, env, stdio: 'ignore' });
    try {
      await waitFor(() => fs.existsSync(socketPath));
      // status must resolve baseUrl the same way the daemon did, so it compares equal.
      const matchEnv = { WANDB_BASE_URL: 'http://127.0.0.1:1' };

      const before = await runStatus(home, [], matchEnv);
      assert.doesNotMatch(before.stdout, WARNING, `unexpected drift before any change:\n${before.stdout}`);

      writeSettings(home, { agent_name: 'changed' }); // daemon still holds goobers
      const after = await runStatus(home, [], matchEnv);
      assert.match(after.stdout, WARNING);
    } finally {
      child.kill('SIGTERM');
    }
  });
});
