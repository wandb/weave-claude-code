// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// registerPlugin ref-drift: a CLI upgrade that changes MARKETPLACE_REF must
// follow `plugin install` with `plugin update` to refresh the loaded plugin.

import { test, suite, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_NAME } from '../src/setup.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-claude-bin');
const PLUGIN_SPEC = `weave@${MARKETPLACE_NAME}`;
const KNOWN_MARKETPLACES_REL = path.join('.claude', 'plugins', 'known_marketplaces.json');

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
    seedKnownMarketplace(tmpHome, MARKETPLACE_REF);
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
    seedKnownMarketplace(tmpHome, OLD_REF);
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

  seedKnownMarketplace(tmpHome, 'v9.9.9');
  assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), 'v9.9.9');
  assert.equal(readRegisteredMarketplaceRef('some-other-marketplace'), null);

  fs.writeFileSync(path.join(tmpHome, KNOWN_MARKETPLACES_REL), '{ not valid json');
  assert.equal(readRegisteredMarketplaceRef(MARKETPLACE_NAME), null);
});
