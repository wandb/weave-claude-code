#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { readVersionMetadata, writeVersionModule } from './version-module-utils.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nextVersion = process.argv[2];
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!nextVersion || !semverPattern.test(nextVersion)) {
  console.error('Usage: node scripts/release/bump-version.mjs <semver>');
  process.exit(1);
}

const currentMetadata = readVersionMetadata();

if (currentMetadata.version === nextVersion) {
  console.error(`src/version.mjs is already ${nextVersion}`);
  process.exit(1);
}

writeVersionModule({
  version: nextVersion,
});
updateJsonFile('package.json', (data) => {
  data.version = nextVersion;
  return data;
});
updateJsonFile('package-lock.json', (data) => {
  data.version = nextVersion;
  if (data.packages?.['']) {
    data.packages[''].version = nextVersion;
  }
  return data;
});
updateJsonFile('.claude-plugin/plugin.json', (data) => {
  data.version = nextVersion;
  return data;
});
updateJsonFile('.claude-plugin/marketplace.json', (data) => {
  data.version = nextVersion;

  if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
    throw new Error('.claude-plugin/marketplace.json is missing plugins[0]');
  }

  data.plugins[0].version = nextVersion;
  if (!data.plugins[0].source || typeof data.plugins[0].source !== 'object') {
    throw new Error('.claude-plugin/marketplace.json is missing plugins[0].source');
  }
  data.plugins[0].source.ref = `v${nextVersion}`;
  return data;
});

function updateJsonFile(relativePath, updater) {
  const filePath = path.join(repoRoot, relativePath);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const updated = updater(parsed);
  fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`);
}
