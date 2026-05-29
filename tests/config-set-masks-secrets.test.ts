// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `weave-claude-code config set wandb_api_key <value>` echoes the value to
// stdout on success. `config show` masks the same value to first-4-chars +
// ellipsis, but `set` had no equivalent masking — the literal key leaked into
// terminal scrollback, CI logs, and tool transcripts whenever the install
// flow ran. These tests pin the masking contract for `set` and guard the
// existing non-masking behavior of non-sensitive keys.

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

// A distinctive secret so a substring match on stdout is unambiguous.
const SECRET = 'wandb_v1_SUPERSECRETvalueDoNotLeak0123456789';

interface Workspace {
  home: string;
  settingsFile: string;
}

function newWorkspace(label: string): Workspace {
  const home = fs.mkdtempSync(`/tmp/wcp-cfgset-${label}-`);
  const configDir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  const settingsFile = path.join(configDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      log_file: path.join(configDir, 'logs', 'daemon.log'),
      daemon_socket: path.join(configDir, 'daemon.sock'),
      weave_project: null,
      wandb_api_key: null,
      debug: false,
      installed_at: '2026-01-01T00:00:00Z',
      version: '0.0.0-test',
    }),
  );
  return { home, settingsFile };
}

function runCli(home: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // Scrub WANDB_API_KEY/WEAVE_PROJECT from the parent env so they can't
    // shadow what the CLI reads back from the per-test settings.json.
    const env = { ...process.env, HOME: home };
    delete env.WANDB_API_KEY;
    delete env.WEAVE_PROJECT;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: REPO_ROOT, env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

let workspaces: string[] = [];
beforeEach(() => { workspaces = []; });
afterEach(() => {
  for (const w of workspaces) fs.rmSync(w, { recursive: true, force: true });
});

function workspace(label: string): Workspace {
  const w = newWorkspace(label);
  workspaces.push(w.home);
  return w;
}

suite('config set masks sensitive values in stdout', () => {
  test('wandb_api_key: stdout does not contain the full secret', async () => {
    const w = workspace('mask-stdout');
    const r = await runCli(w.home, ['config', 'set', 'wandb_api_key', SECRET]);
    assert.equal(r.code, 0, `set should succeed — stderr=${r.stderr}`);
    assert.equal(
      r.stdout.includes(SECRET),
      false,
      `stdout leaked the full secret:\n${r.stdout}`,
    );
  });

  test('wandb_api_key: stdout shows the masked prefix (first 4 chars + ellipsis)', async () => {
    const w = workspace('mask-prefix');
    const r = await runCli(w.home, ['config', 'set', 'wandb_api_key', SECRET]);
    assert.equal(r.code, 0, `set should succeed — stderr=${r.stderr}`);
    // Use the same shape `config show` already prints: `wand…`
    assert.match(r.stdout, /wand…/, `stdout should contain masked prefix; got:\n${r.stdout}`);
  });

  test('wandb_api_key: full secret is still persisted to settings.json', async () => {
    const w = workspace('mask-persist');
    const r = await runCli(w.home, ['config', 'set', 'wandb_api_key', SECRET]);
    assert.equal(r.code, 0, `set should succeed — stderr=${r.stderr}`);
    const saved = JSON.parse(fs.readFileSync(w.settingsFile, 'utf8'));
    assert.equal(saved.wandb_api_key, SECRET, 'on-disk value must be the full secret');
  });

  test('weave_project: non-sensitive value is still echoed in full', async () => {
    const w = workspace('echo-project');
    const project = 'my-entity/my-project';
    const r = await runCli(w.home, ['config', 'set', 'weave_project', project]);
    assert.equal(r.code, 0, `set should succeed — stderr=${r.stderr}`);
    assert.match(r.stdout, new RegExp(project.replace('/', '\\/')), `stdout should echo full project; got:\n${r.stdout}`);
  });
});
