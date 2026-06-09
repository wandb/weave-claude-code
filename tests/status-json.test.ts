// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for the `weave-claude-code status --json` schema. The shape is a
// public contract: harness integrations (wandb-bench and similar) parse it
// programmatically, so any field rename here is a breaking change.

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
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-status-json-test-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function runStatusJson(home: string): Promise<{ stdout: string; code: number | null }> {
  // Strip env vars that would override settings.json values. Empty-string
  // would not suffice: `process.env['WEAVE_PROJECT'] ?? settings.weave_project`
  // treats '' as set, masking the configured value.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env['WEAVE_PROJECT'];
  delete env['WANDB_API_KEY'];

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI, 'status', '--json'],
      { cwd: REPO_ROOT, env },
    );
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

function writeSettings(home: string, overrides: Record<string, unknown> = {}): { configDir: string; socketPath: string; logFile: string } {
  const configDir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  const socketPath = path.join(configDir, 'daemon.sock');
  const logFile = path.join(configDir, 'logs', 'daemon.log');
  const settings = {
    weave_project: 'fake-entity/fake-project',
    wandb_api_key: 'SUPER-SECRET-KEY-DO-NOT-LEAK',
    daemon_socket: socketPath,
    log_file: logFile,
    ...overrides,
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return { configDir, socketPath, logFile };
}

suite('weave-claude-code status --json', () => {
  test('emits the documented schema with configured settings', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'configured-'));
    const { socketPath, logFile } = writeSettings(home);

    const r = await runStatusJson(home);
    assert.equal(r.code, 0, `expected exit 0 with no stale socket; stdout=${r.stdout}`);

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // Required top-level fields per the documented schema.
    for (const key of [
      'version', 'settings_file', 'cli_path', 'weave_project', 'weave_project_source',
      'api_key_configured', 'daemon_socket', 'log_file', 'ready_to_trace', 'view_traces_url',
    ]) {
      assert.ok(key in parsed, `missing required field: ${key}`);
    }
    assert.equal(typeof parsed['version'], 'string');
    assert.equal(parsed['weave_project'], 'fake-entity/fake-project');
    assert.equal(parsed['weave_project_source'], 'settings.json');
    assert.equal(parsed['api_key_configured'], true);

    const socket = parsed['daemon_socket'] as { path: string; state: string };
    assert.equal(socket.path, socketPath);
    assert.equal(socket.state, 'absent');

    const log = parsed['log_file'] as { path: string; size_bytes: number | null };
    assert.equal(log.path, logFile);
    assert.equal(log.size_bytes, null);

    assert.equal(parsed['ready_to_trace'], true);
    assert.equal(parsed['view_traces_url'], 'https://wandb.ai/fake-entity/fake-project/weave/agents');
  });

  test('exits non-zero and emits a report with null fields when settings file is missing', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'no-settings-'));

    const r = await runStatusJson(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when config is missing; stdout=${r.stdout}`);

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(parsed['weave_project'], null);
    assert.equal(parsed['weave_project_source'], 'not set');
    assert.equal(parsed['api_key_configured'], false);
    assert.equal(parsed['ready_to_trace'], false);
    assert.equal(parsed['view_traces_url'], null);
    const socket = parsed['daemon_socket'] as { path: string | null; state: string | null };
    assert.equal(socket.path, null);
    assert.equal(socket.state, null);
  });

  test('does not include the raw API key value in JSON output', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'no-leak-'));
    writeSettings(home);

    const r = await runStatusJson(home);
    assert.doesNotMatch(r.stdout, /SUPER-SECRET-KEY-DO-NOT-LEAK/, 'JSON status must never include the raw API key');
  });
});
