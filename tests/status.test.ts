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

import { startTestDaemon, writeKnownMarketplace } from './helpers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-status-test-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

interface SettingsOverrides {
  weave_project?: string | null;
  wandb_api_key?: string | null;
  agent_name?: string | null;
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
  delete env['WEAVE_AGENT_NAME'];

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

    assert.match(r.stdout, /Weave Claude Code — ready to trace/);
    assert.match(r.stdout, /✓ Project\s+fake-entity\/fake-project\s+\(settings\.json\)/);
    assert.match(r.stdout, /✓ API key\s+.+\(settings\.json\)/);
    assert.match(r.stdout, /Daemon\s+○ not running/);
    assert.match(r.stdout, /- Log\s+.+\(not created yet\)/);
    assert.match(r.stdout, /wandb\.ai\/fake-entity\/fake-project\/weave\/agents/);
  });

  test('prints the configured agent name', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-agent-set-'));
    writeSettings(home, { agent_name: 'goober' });

    const r = await runStatus(home);
    assert.match(r.stdout, /✓ Agent\s+goober/);
  });

  test('falls back to the default agent name when unset', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-agent-default-'));
    writeSettings(home); // no agent_name key, mirrors settings written before the field existed

    const r = await runStatus(home);
    assert.match(r.stdout, /✓ Agent\s+claude-code/);
  });

  test('missing settings file: prints "Configuration: not found" and exits non-zero', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-missing-'));

    const r = await runStatus(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when settings is missing; stdout=${r.stdout}`);

    assert.match(r.stdout, /Weave Claude Code — not configured/);
    assert.match(r.stdout, /No config at .+\.weave-claude-code\/settings\.json/);
    assert.match(r.stdout, /weave-claude-code install/);
    // Other status sections should be suppressed: gather returns early before probing.
    assert.doesNotMatch(r.stdout, /Daemon/);
  });

  test('unreadable settings file: prints "Configuration: failed to read" and exits non-zero', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-unreadable-'));
    const configDir = path.join(home, '.weave-claude-code');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ this is not valid JSON');

    const r = await runStatus(home);
    assert.notEqual(r.code, 0, `expected non-zero exit when settings is unreadable; stdout=${r.stdout}`);

    assert.match(r.stdout, /config unreadable/);
    assert.doesNotMatch(r.stdout, /Daemon/);
  });

  test('missing weave_project: prints ✗ and "Configuration incomplete" summary', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-no-project-'));
    writeSettings(home, { weave_project: null });

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 (config-incomplete is not fatal); stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ Project\s+not set/);
    assert.match(r.stdout, /Set [^\n]*weave_project to start tracing/);
    assert.doesNotMatch(r.stdout, /ready to trace/);
  });

  test('missing wandb_api_key: prints ✗ and "Configuration incomplete" summary', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'pretty-no-key-'));
    writeSettings(home, { wandb_api_key: null });

    const r = await runStatus(home);
    assert.equal(r.code, 0, `expected exit 0 (config-incomplete is not fatal); stdout=${r.stdout}`);

    assert.match(r.stdout, /✗ API key\s+not set/);
    assert.match(r.stdout, /Set [^\n]*wandb_api_key to start tracing/);
    assert.doesNotMatch(r.stdout, /ready to trace/);
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
      'api_key_configured', 'agent_name', 'plugin_source', 'daemon_socket', 'daemon', 'log_file', 'ready_to_trace',
      'view_traces_url',
    ]) {
      assert.ok(key in parsed, `missing required field: ${key}`);
    }
    assert.equal(typeof parsed['version'], 'string');
    assert.equal(parsed['weave_project'], 'fake-entity/fake-project');
    assert.equal(parsed['weave_project_source'], 'settings.json');
    assert.equal(parsed['api_key_configured'], true);
    assert.equal(parsed['agent_name'], 'claude-code');

    const socket = parsed['daemon_socket'] as { path: string; state: string };
    assert.equal(socket.path, socketPath);
    assert.equal(socket.state, 'absent');

    const log = parsed['log_file'] as { path: string; size_bytes: number | null };
    assert.equal(log.path, logFile);
    assert.equal(log.size_bytes, null);

    assert.equal(parsed['ready_to_trace'], true);
    assert.equal(parsed['view_traces_url'], 'https://wandb.ai/fake-entity/fake-project/weave/agents');
  });

  test('reports the resolved agent name in JSON', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'json-agent-'));
    writeSettings(home, { agent_name: 'goober' });

    const r = await runStatus(home, ['--json']);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(parsed['agent_name'], 'goober');
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
      expectInPretty: 'github wandb/weave-claude-code @ v0.2.7',
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
        expectInPretty: `directory ${dir} @ v1.2.3`,
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
        expectInPretty: `directory ${dir}`,
        expectNotInPretty: `${dir} @`,
        expectJson: { type: 'directory', path: dir, version: null },
      };
    },
  },
  {
    name: 'not registered',
    setup: () => ({
      seed: null,
      expectInPretty: 'not registered',
      expectJson: null,
    }),
  },
];

suite('weave-claude-code status (plugin source)', () => {
  test('renders each source type in pretty and json', async () => {
    for (const c of PLUGIN_SOURCE_CASES) {
      const home = fs.mkdtempSync(path.join(scratch, `src-${c.name.replace(/\s+/g, '-')}-`));
      writeSettings(home);
      const { seed, expectInPretty, expectNotInPretty, expectJson } = c.setup(scratch);
      if (seed) writeKnownMarketplace(home, seed);

      const pretty = await runStatus(home);
      assert.ok(pretty.stdout.includes(expectInPretty), `case "${c.name}" (pretty): expected "${expectInPretty}" in:\n${pretty.stdout}`);
      if (expectNotInPretty) {
        assert.ok(!pretty.stdout.includes(expectNotInPretty), `case "${c.name}" (pretty): did not expect "${expectNotInPretty}" in:\n${pretty.stdout}`);
      }

      const json = await runStatus(home, ['--json']);
      const parsed = JSON.parse(json.stdout) as { plugin_source: unknown };
      assert.deepEqual(parsed.plugin_source, expectJson, `case "${c.name}" (json)`);
    }
  });
});

// A live daemon reports its own identity (pid, version, resolved entry script)
// over the config-hash control reply; status surfaces it so you can tell which
// build is actually running (e.g. a linked local dev build). Uses the real
// daemon harness — the identity reported is the daemon's, not the CLI's.
suite('weave-claude-code status (running daemon identity)', () => {
  test('reports the live daemon pid, version, and entry path', async () => {
    const daemon = await startTestDaemon();
    try {
      const parsed = JSON.parse((await runStatus(daemon.home, ['--json'])).stdout) as Record<string, unknown>;
      const d = parsed['daemon'] as { pid: number | null; version: string | null; path: string | null };
      assert.equal(typeof d.pid, 'number', `daemon pid should be reported; got ${JSON.stringify(d)}`);
      assert.ok((d.pid ?? 0) > 0, 'daemon pid should be positive');
      assert.equal(typeof d.version, 'string', 'daemon version should be reported');
      assert.ok(d.path && /cli\.(ts|js)$/.test(d.path), `daemon entry path should resolve to cli.(ts|js); got ${d.path}`);

      const pretty = (await runStatus(daemon.home)).stdout;
      assert.match(pretty, /✓ Process\s+pid \d+ \(v/);
      assert.match(pretty, /✓ From\s+\S*cli\.(ts|js)/);
    } finally {
      await daemon.stop();
    }
  });

  test('reports null daemon identity when no daemon is running', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'no-daemon-identity-'));
    writeSettings(home);
    const parsed = JSON.parse((await runStatus(home, ['--json'])).stdout) as Record<string, unknown>;
    assert.deepEqual(parsed['daemon'], { pid: null, version: null, path: null });
  });
});
