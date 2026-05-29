// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `config set` must mask wandb_api_key in stdout (it didn't — see #66) but
// must still echo non-sensitive keys in full and persist the full secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const SECRET = 'wandb_v1_SUPERSECRETvalueDoNotLeak0123456789';

function newHome(label: string): { home: string; settingsFile: string } {
  const home = fs.mkdtempSync(`/tmp/wcp-cfgset-${label}-`);
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
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

function runCli(home: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home };
    delete env.WANDB_API_KEY;
    delete env.WEAVE_PROJECT;
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

test('config set: masks wandb_api_key, echoes weave_project in full', async () => {
  const { home, settingsFile } = newHome('mask');
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
