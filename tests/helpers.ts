// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Shared test helpers. The first occurrence lived inline in
// marketplace-ref-drift.test.ts; extracted here once a second test
// (install-source-local.test.ts) needed the same helper.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MARKETPLACE_NAME } from '../src/setup.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

/**
 * Create a throwaway $HOME with a minimal `settings.json` for exercising
 * `config` subcommands. The seed deliberately omits `agent_name` so tests can
 * verify resolution on settings files written before that field existed.
 */
export function seedConfigHome(label: string): { home: string; settingsFile: string } {
  const home = fs.mkdtempSync(`/tmp/wcp-${label}-`);
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    log_file: path.join(dir, 'logs', 'daemon.log'),
    daemon_socket: path.join(dir, 'daemon.sock'),
    weave_project: null,
    wandb_api_key: null,
    debug: false,
    installed_at: '2026-01-01T00:00:00Z',
    version: '0.0.0-test',
  }));
  return { home, settingsFile };
}

/**
 * Run the CLI (via tsx) against a throwaway $HOME, capturing stdout and exit
 * code. Inherited credential/agent env vars are stripped so tests start from a
 * clean slate; `extraEnv` is applied last so a test can opt back into one.
 */
export function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home };
    delete env.WANDB_API_KEY;
    delete env.WEAVE_PROJECT;
    delete env.WEAVE_AGENT_NAME;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

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
