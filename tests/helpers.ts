// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Shared test helpers. The first occurrence lived inline in
// marketplace-ref-drift.test.ts; extracted here once a second test
// (install-source-local.test.ts) needed the same helper.

import * as fs from 'node:fs';
import * as path from 'node:path';

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
