// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for marketplace-ref-drift detection in registerPlugin.
//
// When the npm CLI is upgraded after a previous install, the binary's new
// MARKETPLACE_REF differs from what Claude Code last cached in
// known_marketplaces.json. `claude plugin install` is idempotent and would
// leave the installed plugin pinned to the old version. registerPlugin must
// detect that drift and follow up with `claude plugin update`.
//
// (Note: the cross-rename migration from `weave-claude-plugin` →
// `weave-claude-code` does NOT live in the binary — the weave-install skill
// owns it. See skills/weave-install/SKILL.md, "Updating an Existing Install".)
//
// Setup: a fake `claude` binary (tests/fixtures/fake-claude-bin/claude) tracks
// marketplace and plugin state under a per-test HOME. Tests pre-populate that
// state to simulate the three scenarios (fresh, idempotent, drift) and assert
// on the returned PluginResult plus a call log.

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_NAME } from '../src/setup.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-claude-bin');

const PLUGIN_SPEC = `weave@${MARKETPLACE_NAME}`;

function readFakeCalls(home: string): string[] {
  const p = path.join(home, '.claude', 'fake-claude-calls.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

function seedKnownMarketplace(home: string, ref: string): void {
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'known_marketplaces.json'),
    JSON.stringify({
      [MARKETPLACE_NAME]: {
        source: { source: 'github', repo: 'wandb/weave-claude-code', ref },
        installLocation: path.join(dir, 'marketplaces', MARKETPLACE_NAME),
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    }),
  );
}

function seedInstalledPlugin(home: string): void {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'fake-claude-installed-plugins.json'),
    JSON.stringify({ [PLUGIN_SPEC]: { installedAt: '2026-01-01T00:00:00Z' } }),
  );
}

let tmpHome: string;
let savedHome: string | undefined;
let savedPath: string | undefined;
let savedMktName: string | undefined;

beforeEach(() => {
  // Git clone occasionally drops the executable bit on shell scripts; re-stamp
  // so the fixture is invokable regardless of how the repo was checked out.
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

suite('registerPlugin — fresh install', () => {
  test('registers marketplace and installs plugin; no follow-up update', async () => {
    const { registerPlugin, MARKETPLACE_REF } = await import('../src/setup.ts');

    const logFile = path.join(tmpHome, 'log.txt');
    const result = registerPlugin(logFile);

    assert.equal(result.refBefore, null, 'no prior registration');
    assert.equal(result.refAfter, MARKETPLACE_REF, 'registered at current MARKETPLACE_REF');
    assert.equal(result.pluginUpdated, false, 'fresh install never needs `plugin update`');

    const calls = readFakeCalls(tmpHome);
    assert.ok(calls.some((c) => c.startsWith('plugin marketplace add')), 'marketplace add was called');
    assert.ok(calls.some((c) => c.startsWith('plugin install')), 'plugin install was called');
    assert.ok(!calls.some((c) => c.startsWith('plugin update')), 'plugin update was NOT called');
  });
});

suite('registerPlugin — idempotent re-run', () => {
  test('same ref already registered: no plugin update', async () => {
    const { registerPlugin, MARKETPLACE_REF } = await import('../src/setup.ts');

    seedKnownMarketplace(tmpHome, MARKETPLACE_REF);
    seedInstalledPlugin(tmpHome);

    const logFile = path.join(tmpHome, 'log.txt');
    const result = registerPlugin(logFile);

    assert.equal(result.refBefore, MARKETPLACE_REF, 'old ref captured');
    assert.equal(result.refAfter, MARKETPLACE_REF, 'ref unchanged');
    assert.equal(result.pluginUpdated, false, 'no drift → no `plugin update`');

    const calls = readFakeCalls(tmpHome);
    assert.ok(!calls.some((c) => c.startsWith('plugin update')), 'plugin update was NOT called');
  });
});

suite('registerPlugin — ref drift after CLI upgrade', () => {
  test('old ref present, current binary refreshes ref, plugin update is invoked', async () => {
    const { registerPlugin, MARKETPLACE_REF } = await import('../src/setup.ts');

    const OLD_REF = 'v0.0.1';
    assert.notEqual(OLD_REF, MARKETPLACE_REF, 'sanity: old ref must differ from current MARKETPLACE_REF');

    seedKnownMarketplace(tmpHome, OLD_REF);
    seedInstalledPlugin(tmpHome);

    const logFile = path.join(tmpHome, 'log.txt');
    const result = registerPlugin(logFile);

    assert.equal(result.refBefore, OLD_REF, 'pre-add ref captured');
    assert.equal(result.refAfter, MARKETPLACE_REF, 'post-add ref is the new MARKETPLACE_REF');
    assert.equal(result.pluginUpdated, true, 'drift + already-installed → `plugin update` invoked');

    const calls = readFakeCalls(tmpHome);
    assert.ok(calls.some((c) => c.startsWith('plugin update')), 'plugin update WAS called');
  });
});

suite('readRegisteredMarketplaceRef', () => {
  test('returns null when known_marketplaces.json is absent', async () => {
    const { readRegisteredMarketplaceRef } = await import('../src/setup.ts');
    assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), null);
  });

  test('returns the registered ref when present', async () => {
    const { readRegisteredMarketplaceRef } = await import('../src/setup.ts');
    seedKnownMarketplace(tmpHome, 'v9.9.9');
    assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), 'v9.9.9');
  });

  test('returns null when the marketplace name is absent from the file', async () => {
    const { readRegisteredMarketplaceRef } = await import('../src/setup.ts');
    seedKnownMarketplace(tmpHome, 'v1.0.0');
    assert.equal(readRegisteredMarketplaceRef('some-other-marketplace'), null);
  });

  test('returns null when the file is malformed JSON', async () => {
    const { readRegisteredMarketplaceRef } = await import('../src/setup.ts');
    const dir = path.join(tmpHome, '.claude', 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'known_marketplaces.json'), '{ not valid json');
    assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), null);
  });
});
