#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = process.argv[2];

if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
  console.error('Usage: node scripts/release/update-marketplace-sha.mjs <40-char commit sha>');
  process.exit(1);
}

const filePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
  throw new Error('.claude-plugin/marketplace.json is missing plugins[0]');
}

if (!data.plugins[0].source || typeof data.plugins[0].source !== 'object') {
  throw new Error('.claude-plugin/marketplace.json is missing plugins[0].source');
}

data.plugins[0].source.sha = sha;
fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
