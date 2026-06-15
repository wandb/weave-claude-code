// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Re-running install (createConfig) must NOT wipe an already-configured machine.
// Regression for: a failed/repeat `weave-claude-code install` reset
// weave_project, wandb_api_key, and trace_mode to defaults, losing credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConfig, VERSION, type Settings } from '../src/setup.ts';

test('createConfig: preserves existing project/key/trace_mode, refreshes version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-preserve-'));
  const settingsFile = path.join(dir, 'settings.json');
  const prior: Settings = {
    log_file: path.join(dir, 'logs', 'daemon.log'),
    weave_project: 'my-entity/my-project',
    wandb_api_key: 'secret-key-123',
    agent_name: 'my-bot',
    debug: true,
    installed_at: '2020-01-01T00:00:00Z',
    version: '0.0.1',
    daemon_socket: path.join(dir, 'daemon.sock'),
    trace_mode: 'session-end',
  };
  fs.writeFileSync(settingsFile, JSON.stringify(prior));

  createConfig(dir);

  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Settings;
  assert.equal(after.weave_project, 'my-entity/my-project', 'project preserved');
  assert.equal(after.wandb_api_key, 'secret-key-123', 'api key preserved');
  assert.equal(after.agent_name, 'my-bot', 'agent_name preserved');
  assert.equal(after.debug, true, 'debug preserved');
  assert.equal(after.trace_mode, 'session-end', 'trace_mode preserved');
  assert.equal(after.installed_at, '2020-01-01T00:00:00Z', 'installed_at not reset');
  assert.equal(after.version, VERSION, 'version refreshed to current');
});

test('createConfig: fresh install (no prior file) writes safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-fresh-'));
  createConfig(dir);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Settings;
  assert.equal(s.weave_project, null);
  assert.equal(s.wandb_api_key, null);
  assert.equal(s.trace_mode, 'daemon');
  assert.equal(s.version, VERSION);
});

test('createConfig: unreadable prior settings falls back to defaults (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-corrupt-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
  createConfig(dir);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Settings;
  assert.equal(s.trace_mode, 'daemon');
  assert.equal(s.weave_project, null);
});
