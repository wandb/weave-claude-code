// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Shared test helpers. The first occurrence lived inline in
// marketplace-ref-drift.test.ts; extracted here once a second test
// (install-source-local.test.ts) needed the same helper.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { MARKETPLACE_NAME } from '../src/setup.ts';

/**
 * Read the call log written by the fake `claude` CLI fixture
 * (`tests/fixtures/fake-claude-bin/claude`). One line per invocation, args
 * space-joined. Empty array when the daemon never ran.
 */
export function readFakeCalls(home: string): string[] {
  const p = path.join(home, '.claude', 'fake-claude-calls.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

/**
 * Seed `$HOME/.claude/plugins/known_marketplaces.json` with the given source
 * spec for the weave-claude-code marketplace. Mirrors what the real `claude`
 * CLI writes after `plugin marketplace add` (verified empirically). Tests use
 * this to put the registry in a known state before invoking code paths that
 * read it.
 */
export function writeKnownMarketplace(home: string, source: Record<string, unknown>): void {
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'known_marketplaces.json'),
    JSON.stringify({
      [MARKETPLACE_NAME]: {
        source,
        installLocation: path.join(dir, 'marketplaces', MARKETPLACE_NAME),
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    }),
  );
}
