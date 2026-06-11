// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `config` support for the customizable top-level agent name (#agent_name).
// The seed settings file deliberately OMITS agent_name to mirror an install
// from before the field existed — `get` must still resolve to the default,
// not error with "Unknown key".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

function newHome(label: string): { home: string; settingsFile: string } {
  const home = fs.mkdtempSync(`/tmp/wcp-agentname-${label}-`);
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
  // No `agent_name` key — simulates a pre-existing install.
  fs.writeFileSync(settingsFile, JSON.stringify({
    log_file: path.join(dir, 'logs', 'daemon.log'),
    daemon_socket: path.join(dir, 'daemon.sock'),
    weave_project: null,
    wandb_api_key: null,
    debug: false,
    installed_at: '2026-01-01T00:00:00Z',
    version: '0.0.0-test',
  }));
  return { home, settingsFile };
}

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home };
    delete env.WANDB_API_KEY;
    delete env.WEAVE_PROJECT;
    delete env.WEAVE_AGENT_NAME;
    // Apply test-supplied overrides last so they win over the deletes above.
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

test('config agent_name: default, set (trimmed + persisted), and reject empty', async () => {
  const { home, settingsFile } = newHome('lifecycle');
  try {
    // get on a file missing the key → default, not an error.
    const def = await runCli(home, ['config', 'get', 'agent_name']);
    assert.equal(def.code, 0);
    assert.match(def.stdout, /claude-code/);

    // set trims surrounding whitespace and persists the trimmed value.
    const set = await runCli(home, ['config', 'set', 'agent_name', '  my-team-bot  ']);
    assert.equal(set.code, 0);
    assert.match(set.stdout, /my-team-bot/);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).agent_name, 'my-team-bot');

    // get reflects the new value.
    const got = await runCli(home, ['config', 'get', 'agent_name']);
    assert.equal(got.stdout.trim(), 'my-team-bot');

    // show lists it with its source.
    const show = await runCli(home, ['config', 'show']);
    assert.match(show.stdout, /agent_name:\s+my-team-bot \[settings\.json\]/);

    // whitespace-only is rejected, leaving the stored value untouched.
    const bad = await runCli(home, ['config', 'set', 'agent_name', '   ']);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).agent_name, 'my-team-bot');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('config agent_name: WEAVE_AGENT_NAME env var overrides the settings file', async () => {
  const { home } = newHome('env');
  try {
    await runCli(home, ['config', 'set', 'agent_name', 'from-file']);

    const got = await runCli(home, ['config', 'get', 'agent_name'], { WEAVE_AGENT_NAME: 'from-env' });
    assert.equal(got.stdout.trim(), 'from-env');

    const show = await runCli(home, ['config', 'show'], { WEAVE_AGENT_NAME: 'from-env' });
    assert.match(show.stdout, /agent_name:\s+from-env \[WEAVE_AGENT_NAME env var\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
