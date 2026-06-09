// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for the human-readable `weave-claude-code status` output. The stale
// daemon socket case lives in stale-daemon-socket.test.ts; here we cover the
// other branches printPrettyStatus dispatches on: happy path, missing config,
// unreadable config, missing project, missing API key.

import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-status-pretty-test-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function runStatus(home: string): Promise<{ stdout: string; code: number | null }> {
  // Env vars override settings.json values; strip them so each test fully
  // controls its inputs via settings.json.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env['WEAVE_PROJECT'];
  delete env['WANDB_API_KEY'];

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI, 'status'],
      { cwd: REPO_ROOT, env },
    );
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

interface SettingsOverrides {
  weave_project?: string | null;
  wandb_api_key?: string | null;
}

function writeSettings(home: string, overrides: SettingsOverrides = {}): void {
  const configDir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  const settings = {
    weave_project: 'fake-entity/fake-project',
    wandb_api_key: 'fake-api-key',
    daemon_socket: path.join(configDir, 'daemon.sock'),
    log_file: path.join(configDir, 'logs', 'daemon.log'),
    ...overrides,
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));
}

suite('weave-claude-code status (pretty)', () => {
  test('happy path: settings configured, daemon not running, reports "Ready to trace"', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'happy-'));
    writeSettings(home);

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 on happy path; stdout=${r.stdout}`);

    assert.match(r.stdout, /✓ Configuration: /);
    assert.match(r.stdout, /✓ Weave project: fake-entity\/fake-project \(from settings\.json\)/);
    assert.match(r.stdout, /✓ W&B API key: .+ \(from settings\.json\)/);
    assert.match(r.stdout, /Daemon socket: .+ \(not running\)/);
    assert.match(r.stdout, /- Log file: .+ \(not created yet\)/);
    assert.match(r.stdout, /Status: Ready to trace/);
    assert.match(r.stdout, /View traces: https:\/\/wandb\.ai\/fake-entity\/fake-project\/weave\/agents/);
  });

  test('missing settings file: prints "Configuration: not found" and exits non-zero', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'missing-'));

    const r = await runStatus(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when settings is missing; stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Configuration: not found at .+\.weave-claude-code\/settings\.json/);
    assert.match(r.stdout, /Run: weave-claude-code install/);
    // Other status lines should be suppressed: gather returns early before probing.
    assert.doesNotMatch(r.stdout, /Daemon socket:/);
  });

  test('unreadable settings file: prints "Configuration: failed to read" and exits non-zero', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'unreadable-'));
    const configDir = path.join(home, '.weave-claude-code');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ this is not valid JSON');

    const r = await runStatus(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when settings is unreadable; stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Configuration: failed to read/);
    assert.doesNotMatch(r.stdout, /Daemon socket:/);
  });

  test('missing weave_project: prints ✗ and "Configuration incomplete" summary', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'no-project-'));
    writeSettings(home, { weave_project: null });

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 (config-incomplete is not fatal); stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Weave project: not configured/);
    assert.match(r.stdout, /Status: Configuration incomplete .* weave_project/);
    assert.doesNotMatch(r.stdout, /Status: Ready to trace/);
  });

  test('missing wandb_api_key: prints ✗ and "Configuration incomplete" summary', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'no-key-'));
    writeSettings(home, { wandb_api_key: null });

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 (config-incomplete is not fatal); stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ W&B API key: not configured/);
    assert.match(r.stdout, /Status: Configuration incomplete .* wandb_api_key/);
    assert.doesNotMatch(r.stdout, /Status: Ready to trace/);
  });
});
