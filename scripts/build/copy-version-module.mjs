#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

/**
 * Keep the runtime version module available after TypeScript compilation.
 *
 * `src/version.mjs` is the source of truth for release automation and is
 * imported by TypeScript sources, but `tsc` does not emit `.mjs` source files
 * into `dist/`. We copy it explicitly so published builds can still resolve
 * `./version.mjs` at runtime.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcePath = path.join(repoRoot, 'src', 'version.mjs');
const distDir = path.join(repoRoot, 'dist');
const targetPath = path.join(distDir, 'version.mjs');

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
