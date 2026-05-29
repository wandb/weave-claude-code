#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

/**
 * Post-tsc finalization for the published build.
 *
 * 1. Copy `src/version.mjs` (the release-automation source of truth, imported
 *    by TypeScript sources) into `dist/`, since `tsc` does not emit `.mjs`
 *    source files itself.
 * 2. Mark `dist/cli.js` executable. The file ships with a `#!/usr/bin/env node`
 *    shebang and is the `bin` entry in package.json, so the published tarball
 *    must preserve mode 0o755 — otherwise `npm install -g` produces a binary
 *    that errors with "permission denied". `tsc` emits 0o644 on Linux CI, so
 *    without this step the published artifact is unrunnable.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = path.join(repoRoot, 'dist');

const versionSource = path.join(repoRoot, 'src', 'version.mjs');
const versionTarget = path.join(distDir, 'version.mjs');

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(versionSource, versionTarget);

fs.chmodSync(path.join(distDir, 'cli.js'), 0o755);
