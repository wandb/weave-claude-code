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

export function writeVersionModule({ version }) {
  fs.writeFileSync(
    versionModulePath,
    [
      '// BEGIN AUTO-MANAGED VERSION',
      '// This section is maintained by release automation. Do not edit manually.',
      `export const VERSION = '${version}';`,
      '// END AUTO-MANAGED VERSION',
      '',
    ].join('\n'),
  );
}
