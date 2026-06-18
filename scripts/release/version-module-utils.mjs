import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VERSION as currentVersion } from '../../src/version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const versionModulePath = path.join(repoRoot, 'src', 'version.mjs');

export function readVersionMetadata() {
  if (typeof currentVersion !== 'string') {
    throw new Error('Failed to read release metadata from src/version.mjs');
  }

  return {
    version: currentVersion,
  };
}

/**
 * Render the source-of-truth version module. Kept separate from the file write
 * so it can be unit-tested without clobbering src/version.mjs.
 *
 * BUILD_VERSION defaults to VERSION here; the production build overwrites
 * dist/version.mjs with a git-derived value (see
 * scripts/build/copy-version-module.mjs) so dev builds are distinguishable from
 * the published release. Emitting it here keeps the export alive across version
 * bumps, which rewrite this whole file.
 */
export function renderVersionModule({ version }) {
  return [
    '// BEGIN AUTO-MANAGED VERSION',
    '// This section is maintained by release automation. Do not edit manually.',
    `export const VERSION = '${version}';`,
    '// END AUTO-MANAGED VERSION',
    '',
    '// Overwritten with a git-derived build version in dist/ at build time.',
    'export const BUILD_VERSION = VERSION;',
    '',
  ].join('\n');
}

export function writeVersionModule({ version }) {
  fs.writeFileSync(versionModulePath, renderVersionModule({ version }));
}
