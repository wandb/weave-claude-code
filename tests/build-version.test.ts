// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Dev builds made ahead of the release tag must be distinguishable from the
// published release. `buildVersionFrom` turns `git describe` output into a
// semver build-metadata suffix (the `+…` part, ignored for precedence) so a
// build off `main` reports e.g. `0.2.9+8.gabc1234` while the tagged release
// stays exactly `0.2.9`.

import { test, suite } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildVersionFrom, resolveBuildVersion } from '../scripts/build/git-build-version.mjs';
import { renderVersionModule } from '../scripts/release/version-module-utils.mjs';

suite('buildVersionFrom', () => {
  test('exact clean tag → base version unchanged', () => {
    assert.equal(buildVersionFrom('0.2.9', 'v0.2.9-0-gabc1234'), '0.2.9');
  });

  test('commits ahead of tag → build metadata with count and sha', () => {
    assert.equal(buildVersionFrom('0.2.9', 'v0.2.9-8-gabc1234'), '0.2.9+8.gabc1234');
  });

  test('dirty working tree on the tag → marked dirty', () => {
    assert.equal(buildVersionFrom('0.2.9', 'v0.2.9-0-gabc1234-dirty'), '0.2.9+0.gabc1234.dirty');
  });

  test('commits ahead and dirty → both recorded', () => {
    assert.equal(buildVersionFrom('0.2.9', 'v0.2.9-8-gabc1234-dirty'), '0.2.9+8.gabc1234.dirty');
  });

  test('base version with a pre-release tag is preserved (parses from the end)', () => {
    assert.equal(
      buildVersionFrom('0.2.8-rc.0', 'v0.2.8-rc.0-3-gdef5678'),
      '0.2.8-rc.0+3.gdef5678',
    );
  });

  test('no tags, bare sha from --always → metadata without a count', () => {
    assert.equal(buildVersionFrom('0.2.9', 'abc1234'), '0.2.9+gabc1234');
  });

  test('no tags, bare sha and dirty', () => {
    assert.equal(buildVersionFrom('0.2.9', 'abc1234-dirty'), '0.2.9+gabc1234.dirty');
  });

  test('empty describe output → clean fallback', () => {
    assert.equal(buildVersionFrom('0.2.9', ''), '0.2.9');
  });

  test('unrecognized output → clean fallback, no guessing', () => {
    assert.equal(buildVersionFrom('0.2.9', 'not-a-describe-string!!'), '0.2.9');
  });
});

suite('resolveBuildVersion', () => {
  test('outside a git repository → falls back to the base version', () => {
    const dir = fs.mkdtempSync('/tmp/wcp-buildver-');
    try {
      assert.equal(resolveBuildVersion(dir, '0.2.9'), '0.2.9');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('renderVersionModule', () => {
  test('emits VERSION and BUILD_VERSION so release bumps preserve the build export', () => {
    const dir = fs.mkdtempSync('/tmp/wcp-rendermod-');
    try {
      const modPath = path.join(dir, 'version.mjs');
      fs.writeFileSync(modPath, renderVersionModule({ version: '9.9.9' }));
      assert.match(fs.readFileSync(modPath, 'utf8'), /export const VERSION = '9\.9\.9';/);
      assert.match(fs.readFileSync(modPath, 'utf8'), /export const BUILD_VERSION/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
