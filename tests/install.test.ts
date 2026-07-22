// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Plugin install/registration coverage:
//  - install --source=local: registers the marketplace from the npm-installed
//    package on disk (no git clone).
//  - registerPlugin github ref-drift: a CLI upgrade that changes MARKETPLACE_REF
//    follows `plugin install` with `plugin update`.
//  - readRegisteredMarketplaceRef file/key/parse edge cases.
// The two suites keep separate beforeEach/afterEach because the local-source
// setup also manages `npm_config_prefix`; each suite scopes its own hooks.

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_NAME, MARKETPLACE_REPO } from '../src/setup.ts';
import { readFakeCalls, writeKnownMarketplace } from './helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-claude-bin');
const PLUGIN_SPEC = `weave@${MARKETPLACE_NAME}`;
const KNOWN_MARKETPLACES_REL = path.join('.claude', 'plugins', 'known_marketplaces.json');

function seedLocalPluginTree(npmPrefix: string): string {
  const pkgDir = path.join(npmPrefix, 'lib', 'node_modules', 'weave-claude-code');
  fs.mkdirSync(path.join(pkgDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: MARKETPLACE_NAME, plugins: [] }),
  );
  return pkgDir;
}

function seedInstalledPlugin(home: string): void {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'fake-claude-installed-plugins.json'),
    JSON.stringify({ [PLUGIN_SPEC]: { installedAt: '2026-01-01T00:00:00Z' } }),
  );
}

// `registerPlugin` with InstallSource.Local must register the marketplace from
// the npm-installed package on disk (no git clone), so CI/sandbox environments
// without SSH access to GitHub can still install.
suite('install --source=local', () => {
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

  test('findLocalPluginPath: returns the seeded tree, null otherwise', async () => {
    // Incremental setup: start with no install, then a half-install, then a
    // full install. Each step asserts that findLocalPluginPath reflects the
    // current on-disk state.
    const { findLocalPluginPath } = await import('../src/setup.ts');

    assert.equal(findLocalPluginPath(), null, 'no install: expected null');

    const dir = path.join(tmpNpmPrefix, 'lib', 'node_modules', 'weave-claude-code');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findLocalPluginPath(), null, 'dir without marketplace.json: expected null');

    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: MARKETPLACE_NAME, plugins: [] }),
    );
    assert.equal(findLocalPluginPath(), dir, 'seeded: expected the seeded path');
  });

  test('registerPlugin(Local): registers from the local path, installs the plugin, skips drift-update', async () => {
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

  test('registerPlugin(Local): throws with a helpful error when no local plugin tree is found', async () => {
    const { registerPlugin, InstallSource } = await import('../src/setup.ts');

    assert.throws(
      () => registerPlugin(path.join(tmpHome, 'log.txt'), InstallSource.Local),
      /npm install -g weave-claude-code/,
    );
  });

  test('registerPlugin(): default source falls back to the github marketplace ref', async () => {
    const { registerPlugin, MARKETPLACE_SOURCE } = await import('../src/setup.ts');

    registerPlugin(path.join(tmpHome, 'log.txt'));

    const calls = readFakeCalls(tmpHome);
    const addCall = calls.find((c) => c.startsWith('plugin marketplace add'));
    assert.ok(addCall);
    assert.ok(addCall.includes(MARKETPLACE_SOURCE), `expected github source ${MARKETPLACE_SOURCE}, got: ${addCall}`);
  });
});

// registerPlugin ref-drift: a CLI upgrade that changes MARKETPLACE_REF must
// follow `plugin install` with `plugin update` to refresh the loaded plugin.
suite('marketplace ref-drift', () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedPath: string | undefined;
  let savedMktName: string | undefined;

  beforeEach(() => {
    fs.chmodSync(path.join(FAKE_CLAUDE_BIN_DIR, 'claude'), 0o755);
    tmpHome = fs.mkdtempSync('/tmp/wcp-marketplace-test-');
    savedHome = process.env.HOME;
    savedPath = process.env.PATH;
    savedMktName = process.env.FAKE_CLAUDE_MARKETPLACE_NAME;
    process.env.HOME = tmpHome;
    process.env.PATH = `${FAKE_CLAUDE_BIN_DIR}:${process.env.PATH}`;
    process.env.FAKE_CLAUDE_MARKETPLACE_NAME = MARKETPLACE_NAME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedMktName === undefined) delete process.env.FAKE_CLAUDE_MARKETPLACE_NAME;
    else process.env.FAKE_CLAUDE_MARKETPLACE_NAME = savedMktName;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  suite('registerPlugin', () => {
    test('fresh install: register + install, no update', async () => {
      const { registerPlugin, MARKETPLACE_REF } = await import('../src/setup.ts');
      const result = registerPlugin(path.join(tmpHome, 'log.txt'));

      assert.equal(result.refBefore, null);
      assert.equal(result.refAfter, MARKETPLACE_REF);
      assert.equal(result.pluginUpdated, false);
      const calls = readFakeCalls(tmpHome);
      assert.ok(calls.some((c) => c.startsWith('plugin marketplace add')));
      assert.ok(calls.some((c) => c.startsWith('plugin install')));
      assert.ok(!calls.some((c) => c.startsWith('plugin update')));
    });

    test('idempotent re-run: same ref → no update', async () => {
      const { registerPlugin, MARKETPLACE_REF } = await import('../src/setup.ts');
      writeKnownMarketplace(tmpHome, { source: 'github', repo: MARKETPLACE_REPO, ref: MARKETPLACE_REF });
      seedInstalledPlugin(tmpHome);

      const result = registerPlugin(path.join(tmpHome, 'log.txt'));

      assert.equal(result.refBefore, MARKETPLACE_REF);
      assert.equal(result.refAfter, MARKETPLACE_REF);
      assert.equal(result.pluginUpdated, false);
      assert.ok(!readFakeCalls(tmpHome).some((c) => c.startsWith('plugin update')));
    });

    test('ref drift: refresh marketplace + plugin update', async () => {
      const { registerPlugin, MARKETPLACE_REF } = await import('../src/setup.ts');
      const OLD_REF = 'v0.0.1';
      assert.notEqual(OLD_REF, MARKETPLACE_REF);
      writeKnownMarketplace(tmpHome, { source: 'github', repo: MARKETPLACE_REPO, ref: OLD_REF });
      seedInstalledPlugin(tmpHome);

      const result = registerPlugin(path.join(tmpHome, 'log.txt'));

      assert.equal(result.refBefore, OLD_REF);
      assert.equal(result.refAfter, MARKETPLACE_REF);
      assert.equal(result.pluginUpdated, true);
      assert.ok(readFakeCalls(tmpHome).some((c) => c.startsWith('plugin update')));
    });
  });

  test('readRegisteredMarketplaceRef: file/key/parse edge cases', async () => {
    const { readRegisteredMarketplaceRef } = await import('../src/setup.ts');

    assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), null);

    writeKnownMarketplace(tmpHome, { source: 'github', repo: MARKETPLACE_REPO, ref: 'v9.9.9' });
    assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), 'v9.9.9');
    assert.equal(readRegisteredMarketplaceRef('some-other-marketplace'), null);

    fs.writeFileSync(path.join(tmpHome, KNOWN_MARKETPLACES_REL), '{ not valid json');
    assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), null);
  });
});
