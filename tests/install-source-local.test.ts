// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `registerPlugin` with InstallSource.Local must register the marketplace from
// the npm-installed package on disk (no git clone), so CI/sandbox environments
// without SSH access to GitHub can still install.

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_NAME } from '../src/setup.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-claude-bin');

function readFakeCalls(home: string): string[] {
  const p = path.join(home, '.claude', 'fake-claude-calls.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

function seedLocalPluginTree(npmPrefix: string): string {
  const pkgDir = path.join(npmPrefix, 'lib', 'node_modules', 'weave-claude-code');
  fs.mkdirSync(path.join(pkgDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: MARKETPLACE_NAME, plugins: [] }),
  );
  return pkgDir;
}

let tmpHome: string;
let tmpNpmPrefix: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
let savedMktName: string | undefined;
let savedNpmPrefix: string | undefined;

beforeEach(() => {
  fs.chmodSync(path.join(FAKE_CLAUDE_BIN_DIR, 'claude'), 0o755);
  tmpHome = fs.mkdtempSync('/tmp/wcp-install-source-test-');
  tmpNpmPrefix = fs.mkdtempSync('/tmp/wcp-install-source-npm-');
  savedHome = process.env.HOME;
  savedPath = process.env.PATH;
  savedMktName = process.env.FAKE_CLAUDE_MARKETPLACE_NAME;
  savedNpmPrefix = process.env.npm_config_prefix;
  process.env.HOME = tmpHome;
  process.env.PATH = `${FAKE_CLAUDE_BIN_DIR}:${process.env.PATH}`;
  process.env.FAKE_CLAUDE_MARKETPLACE_NAME = MARKETPLACE_NAME;
  process.env.npm_config_prefix = tmpNpmPrefix;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedMktName === undefined) delete process.env.FAKE_CLAUDE_MARKETPLACE_NAME;
  else process.env.FAKE_CLAUDE_MARKETPLACE_NAME = savedMktName;
  if (savedNpmPrefix === undefined) delete process.env.npm_config_prefix;
  else process.env.npm_config_prefix = savedNpmPrefix;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpNpmPrefix, { recursive: true, force: true });
});

suite('findLocalPluginPath', () => {
  test('returns the npm-installed plugin tree when marketplace.json present', async () => {
    const { findLocalPluginPath } = await import('../src/setup.ts');
    const pkgDir = seedLocalPluginTree(tmpNpmPrefix);

    assert.equal(findLocalPluginPath(), pkgDir);
  });

  test('returns null when no weave-claude-code is npm-installed globally', async () => {
    const { findLocalPluginPath } = await import('../src/setup.ts');

    assert.equal(findLocalPluginPath(), null);
  });

  test('returns null when weave-claude-code exists but marketplace.json is missing', async () => {
    const { findLocalPluginPath } = await import('../src/setup.ts');
    const pkgDir = path.join(tmpNpmPrefix, 'lib', 'node_modules', 'weave-claude-code');
    fs.mkdirSync(pkgDir, { recursive: true });

    assert.equal(findLocalPluginPath(), null);
  });
});

suite('registerPlugin with InstallSource.Local', () => {
  test('registers from the local path, installs the plugin, and skips the drift-update', async () => {
    // Local source bypasses github cloning entirely: marketplace is registered
    // from the npm-installed directory, plugin installs as normal, and the
    // drift-detection update never fires (npm is the version-of-record, so the
    // marketplace "ref" is a directory path with no meaningful comparison).
    const { registerPlugin, InstallSource } = await import('../src/setup.ts');
    const pkgDir = seedLocalPluginTree(tmpNpmPrefix);

    const result = registerPlugin(path.join(tmpHome, 'log.txt'), InstallSource.Local);

    const calls = readFakeCalls(tmpHome);
    const addCall = calls.find((c) => c.startsWith('plugin marketplace add'));
    assert.ok(addCall, 'expected plugin marketplace add to be called');
    assert.ok(addCall.includes(pkgDir), `expected local path ${pkgDir} in: ${addCall}`);
    assert.ok(!addCall.includes('wandb/weave-claude-code#'), `expected no github source in: ${addCall}`);
    assert.ok(calls.some((c) => c.startsWith('plugin install')));
    assert.ok(!calls.some((c) => c.startsWith('plugin update')));
    assert.equal(result.pluginUpdated, false);
  });

  test('throws with a helpful error when no local plugin tree is found', async () => {
    const { registerPlugin, InstallSource } = await import('../src/setup.ts');

    assert.throws(
      () => registerPlugin(path.join(tmpHome, 'log.txt'), InstallSource.Local),
      /npm install -g weave-claude-code/,
    );
  });
});

suite('registerPlugin default source (backward compatibility)', () => {
  test('omitting source still uses the github marketplace ref', async () => {
    const { registerPlugin, MARKETPLACE_SOURCE } = await import('../src/setup.ts');

    registerPlugin(path.join(tmpHome, 'log.txt'));

    const calls = readFakeCalls(tmpHome);
    const addCall = calls.find((c) => c.startsWith('plugin marketplace add'));
    assert.ok(addCall);
    assert.ok(
      addCall.includes(MARKETPLACE_SOURCE),
      `expected github source ${MARKETPLACE_SOURCE}, got: ${addCall}`,
    );
  });
});
