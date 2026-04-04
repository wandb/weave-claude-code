#!/usr/bin/env node

import process from 'node:process';
import { readVersionMetadata, writeVersionModule } from './version-module-utils.mjs';

const sha = process.argv[2];

if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
  console.error('Usage: node scripts/release/update-version-module-ref.mjs <40-char commit sha>');
  process.exit(1);
}

const currentMetadata = readVersionMetadata();

writeVersionModule({
  version: currentMetadata.version,
  marketplaceRef: sha,
});
