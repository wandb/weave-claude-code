// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for `weave-claude-code status` — both the human-readable output and
// the `--json` output. The stale-socket case is covered separately in
// stale-daemon-socket.test.ts as part of the cross-layer stale-recovery story.

import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeKnownMarketplace } from './helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-status-test-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

interface SettingsOverrides {
  weave_project?: string | null;
  wandb_api_key?: string | null;
}

function writeSettings(home: string, overrides: SettingsOverrides = {}): { socketPath: string; logFile: string } {
  const configDir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  const socketPath = path.join(configDir, 'daemon.sock');
  const logFile = path.join(configDir, 'logs', 'daemon.log');
  const settings = {
    weave_project: 'fake-entity/fake-project',
    wandb_api_key: 'SUPER-SECRET-KEY-DO-NOT-LEAK',
    daemon_socket: socketPath,
    log_file: logFile,
    ...overrides,
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));
  return { socketPath, logFile };
}

function runStatus(home: string, extraArgs: string[] = []): Promise<{ stdout: string; code: number | null }> {
  // Env vars override settings.json values; strip them so each test fully
  // controls its inputs via settings.json.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env['WEAVE_PROJECT'];
  delete env['WANDB_API_KEY'];

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI, 'status', ...extraArgs],
      { cwd: REPO_ROOT, env },
    );
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

suite('weave-claude-code status (pretty)', () => {
  test('happy path: settings configured, daemon not running, reports "Ready to trace"', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-happy-'));
    writeSettings(home);

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 on happy path; stdout=${r.stdout}`);

    assert.match(r.stdout, /✓ Configuration: /);
    assert.match(r.stdout, /✓ Weave project: fake-entity\/fake-project \(from settings\.json\)/);
    assert.match(r.stdout, /✓ W&B API key: .+ \(from settings\.json\)/);
    assert.match(r.stdout, /Daemon socket: .+ \(not running\)/);
    assert.match(r.stdout, /- Log file: .+ \(not created yet\)/);
    assert.match(r.stdout, /Status: Ready to trace/);
    assert.match(r.stdout, /View traces: https:\/\/wandb\.ai\/fake-entity\/fake-project\/weave\/agents/);
  });

  test('missing settings file: prints "Configuration: not found" and exits non-zero', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-missing-'));

    const r = await runStatus(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when settings is missing; stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Configuration: not found at .+\.weave-claude-code\/settings\.json/);
    assert.match(r.stdout, /Run: weave-claude-code install/);
    // Other status lines should be suppressed: gather returns early before probing.
    assert.doesNotMatch(r.stdout, /Daemon socket:/);
  });

  test('unreadable settings file: prints "Configuration: failed to read" and exits non-zero', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-unreadable-'));
    const configDir = path.join(home, '.weave-claude-code');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ this is not valid JSON');

    const r = await runStatus(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when settings is unreadable; stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Configuration: failed to read/);
    assert.doesNotMatch(r.stdout, /Daemon socket:/);
  });

  test('missing weave_project: prints ✗ and "Configuration incomplete" summary', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-no-project-'));
    writeSettings(home, { weave_project: null });

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 (config-incomplete is not fatal); stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Weave project: not configured/);
    assert.match(r.stdout, /Status: Configuration incomplete .* weave_project/);
    assert.doesNotMatch(r.stdout, /Status: Ready to trace/);
  });

  test('missing wandb_api_key: prints ✗ and "Configuration incomplete" summary', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-no-key-'));
    writeSettings(home, { wandb_api_key: null });

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 (config-incomplete is not fatal); stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ W&B API key: not configured/);
    assert.match(r.stdout, /Status: Configuration incomplete .* wandb_api_key/);
    assert.doesNotMatch(r.stdout, /Status: Ready to trace/);
  });
});

suite('weave-claude-code status --json', () => {
  test('emits the documented schema with configured settings', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'json-configured-'));
    const { socketPath, logFile } = writeSettings(home);

    const r = await runStatus(home, ['--json']);
    assert.equal(r.code, 0, `expected exit 0 with no stale socket; stdout=${r.stdout}`);

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // Required top-level fields per the documented schema.
    for (const key of [
      'version', 'settings_file', 'cli_path', 'weave_project', 'weave_project_source',
      'api_key_configured', 'plugin_source', 'daemon_socket', 'log_file', 'ready_to_trace',
      'view_traces_url',
    ]) {
      assert.ok(key in parsed, `missing required field: ${key}`);
    }
    assert.equal(typeof parsed['version'], 'string');
    assert.equal(parsed['weave_project'], 'fake-entity/fake-project');
    assert.equal(parsed['weave_project_source'], 'settings.json');
    assert.equal(parsed['api_key_configured'], true);

    const socket = parsed['daemon_socket'] as { path: string; state: string };
    assert.equal(socket.path, socketPath);
    assert.equal(socket.state, 'absent');

    const log = parsed['log_file'] as { path: string; size_bytes: number | null };
    assert.equal(log.path, logFile);
    assert.equal(log.size_bytes, null);

    assert.equal(parsed['ready_to_trace'], true);
    assert.equal(parsed['view_traces_url'], 'https://wandb.ai/fake-entity/fake-project/weave/agents');
  });

  test('exits non-zero and emits a report with null fields when settings file is missing', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'json-missing-'));

    const r = await runStatus(home, ['--json']);
    assert.notEqual(r.code, 0, `expected non-zero exit when config is missing; stdout=${r.stdout}`);

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(parsed['weave_project'], null);
    assert.equal(parsed['weave_project_source'], 'not set');
    assert.equal(parsed['api_key_configured'], false);
    assert.equal(parsed['ready_to_trace'], false);
    assert.equal(parsed['view_traces_url'], null);
    const socket = parsed['daemon_socket'] as { path: string | null; state: string | null };
    assert.equal(socket.path, null);
    assert.equal(socket.state, null);
  });

  test('does not include the raw API key value in JSON output', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'json-no-leak-'));
    writeSettings(home);

    const r = await runStatus(home, ['--json']);
    assert.doesNotMatch(r.stdout, /SUPER-SECRET-KEY-DO-NOT-LEAK/, 'JSON status must never include the raw API key');
  });
});

// Parametrized: same flow (write settings + maybe seed known_marketplaces +
// run status) varies only by source spec and expected output. Each case's
// `setup` returns the seed for known_marketplaces.json plus its own pretty
// and JSON expectations; directory cases create a real tmpdir so the
// version-from-package.json path can run end-to-end.
interface PluginSourceCase {
  name: string;
  setup: (scratchDir: string) => {
    seed: Record<string, unknown> | null;
    expectInPretty: string;
    expectNotInPretty?: string;
    expectJson: unknown;
  };
}

const PLUGIN_SOURCE_CASES: ReadonlyArray<PluginSourceCase> = [
  {
    name: 'github source',
    setup: () => ({
      seed: { source: 'github', repo: 'wandb/weave-claude-code', ref: 'v0.2.7' },
      expectInPretty: 'Source: github wandb/weave-claude-code @ v0.2.7',
      expectJson: { type: 'github', repo: 'wandb/weave-claude-code', ref: 'v0.2.7' },
    }),
  },
  {
    name: 'directory source with version',
    setup: (scratchDir) => {
      const dir = fs.mkdtempSync(path.join(scratchDir, 'dir-with-ver-'));
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'weave-claude-code', version: '1.2.3' }),
      );
      return {
        seed: { source: 'directory', path: dir },
        expectInPretty: `Source: directory ${dir} @ v1.2.3`,
        expectJson: { type: 'directory', path: dir, version: '1.2.3' },
      };
    },
  },
  {
    name: 'directory source without readable version',
    setup: (scratchDir) => {
      const dir = fs.mkdtempSync(path.join(scratchDir, 'dir-no-ver-'));
      // Intentionally no package.json; version should fall back to null.
      return {
        seed: { source: 'directory', path: dir },
        expectInPretty: `Source: directory ${dir}`,
        expectNotInPretty: `${dir} @`,
        expectJson: { type: 'directory', path: dir, version: null },
      };
    },
  },
  {
    name: 'not registered',
    setup: () => ({
      seed: null,
      expectInPretty: 'Source: not registered',
      expectJson: null,
    }),
  },
];

suite('weave-claude-code status (plugin source)', () => {
  test('pretty: renders each source type', async () => {
    for (const c of PLUGIN_SOURCE_CASES) {
      const home = fs.mkdtempSync(path.join(scratch, `src-pretty-${c.name.replace(/\s+/g, '-')}-`));
      writeSettings(home);
      const { seed, expectInPretty, expectNotInPretty } = c.setup(scratch);
      if (seed) writeKnownMarketplace(home, seed);

      const r = await runStatus(home);
      assert.ok(r.stdout.includes(expectInPretty), `case "${c.name}": expected "${expectInPretty}" in:\n${r.stdout}`);
      if (expectNotInPretty) {
        assert.ok(!r.stdout.includes(expectNotInPretty), `case "${c.name}": did not expect "${expectNotInPretty}" in:\n${r.stdout}`);
      }
    }
  });

  test('json: emits the documented shape for each source type', async () => {
    for (const c of PLUGIN_SOURCE_CASES) {
      const home = fs.mkdtempSync(path.join(scratch, `src-json-${c.name.replace(/\s+/g, '-')}-`));
      writeSettings(home);
      const { seed, expectJson } = c.setup(scratch);
      if (seed) writeKnownMarketplace(home, seed);

      const r = await runStatus(home, ['--json']);
      const parsed = JSON.parse(r.stdout) as { plugin_source: unknown };
      assert.deepEqual(parsed.plugin_source, expectJson, `case "${c.name}"`);
    }
  });
});
