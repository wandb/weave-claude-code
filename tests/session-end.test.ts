// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// runSessionEnd is the daemonless SessionEnd handler: parse payload → resolve
// config → buildTrace → flush. Tested with an injected in-memory provider so no
// network/daemon is involved. Config-gating and flush behavior are the focus;
// span-tree correctness is covered by build-trace.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { runSessionEnd, resolveTraceRoots, ProviderLike } from '../src/sessionEnd.ts';
import type { Settings } from '../src/setup.ts';

const SETTINGS: Settings = {
  log_file: '/tmp/x.log', weave_project: 'ent/proj', wandb_api_key: 'k',
  agent_name: 'tars', debug: false, installed_at: '2026-01-01T00:00:00Z',
  version: '0.0.0', daemon_socket: '/tmp/x.sock', trace_mode: 'session-end',
};

function makeTranscript(cwd = '/work'): { transcriptPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.wcp-se-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcriptPath, [
    { type: 'user', cwd, message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', model: 'm', usage: {}, content: [{ type: 'text', text: 'ok' }] } },
  ].map(l => JSON.stringify(l)).join('\n'));
  return { transcriptPath, dir };
}

function injectedProvider(): { make: () => ProviderLike; exporter: InMemorySpanExporter; shutdowns: number } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const state = { shutdowns: 0 };
  const wrapper: ProviderLike = {
    getTracer: (n, v) => provider.getTracer(n, v),
    // Count the flush but use forceFlush, not shutdown — InMemorySpanExporter
    // clears its buffer on shutdown(), which would erase what we assert on.
    shutdown: async () => { state.shutdowns += 1; await provider.forceFlush(); },
  };
  return { make: () => wrapper, exporter, get shutdowns() { return state.shutdowns; } } as any;
}

test('runSessionEnd: builds spans and flushes the provider', async () => {
  const { transcriptPath, dir } = makeTranscript();
  const inj = injectedProvider();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath, cwd: '/w' });
    const res = await runSessionEnd(payload, SETTINGS, {}, inj.make);
    assert.equal(res.status, 'ok');
    assert.equal(res.turns, 1);
    assert.equal((inj as any).shutdowns, 1, 'provider flushed exactly once');
    assert.ok(inj.exporter.getFinishedSpans().some(s => s.name === 'invoke_agent tars'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSessionEnd: skips when weave_project/api key unset', async () => {
  const { transcriptPath, dir } = makeTranscript();
  const inj = injectedProvider();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath });
    const res = await runSessionEnd(payload, { ...SETTINGS, weave_project: null }, {}, inj.make);
    assert.equal(res.status, 'skipped');
    assert.equal(inj.exporter.getFinishedSpans().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSessionEnd: skips unparseable / incomplete payloads without throwing', async () => {
  const inj = injectedProvider();
  assert.equal((await runSessionEnd('not json', SETTINGS, {}, inj.make)).status, 'skipped');
  assert.equal((await runSessionEnd('{}', SETTINGS, {}, inj.make)).status, 'skipped');
});

test('runSessionEnd: env WANDB_API_KEY/WEAVE_PROJECT override settings', async () => {
  const { transcriptPath, dir } = makeTranscript();
  const inj = injectedProvider();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath });
    const res = await runSessionEnd(payload, { ...SETTINGS, weave_project: null, wandb_api_key: null },
      { WEAVE_PROJECT: 'e/p', WANDB_API_KEY: 'kk' } as NodeJS.ProcessEnv, inj.make);
    assert.equal(res.status, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSessionEnd: scope resolves from transcript cwd when payload omits it (regression)', async () => {
  // The SessionEnd payload often lacks cwd; without the transcript fallback, a
  // set trace_roots fail-closes and drops everything. Here the payload has NO
  // cwd, trace_roots matches the transcript's recorded cwd → must still build.
  const { transcriptPath, dir } = makeTranscript('/work/scoped-repo');
  const inj = injectedProvider();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath }); // no cwd
    const inScope = await runSessionEnd(payload, { ...SETTINGS, ...({ trace_roots: ['/work/scoped-repo'] } as any) }, {}, inj.make);
    assert.equal(inScope.status, 'ok');
    assert.equal(inScope.turns, 1);
    // And a non-matching root still gates it out (scope still enforced).
    const out = await runSessionEnd(payload, { ...SETTINGS, ...({ trace_roots: ['/work/other'] } as any) }, {}, inj.make);
    assert.equal(out.turns, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSessionEnd: skips subagent/teammate transcripts (parent captures them)', async () => {
  // Agent-teams teammate sessions fire their own SessionEnd; building them would
  // duplicate work the coordinator already nests. They live under .../subagents/.
  const { transcriptPath, dir } = makeTranscript();
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const teammatePath = path.join(sub, 'agent-abc.jsonl');
  fs.copyFileSync(transcriptPath, teammatePath);
  const inj = injectedProvider();
  try {
    const payload = JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: teammatePath, cwd: '/work' });
    const res = await runSessionEnd(payload, SETTINGS, {}, inj.make);
    assert.equal(res.status, 'skipped');
    assert.match(res.reason ?? '', /subagent|teammate/);
    assert.equal(inj.exporter.getFinishedSpans().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTraceRoots: env (comma-sep) wins over settings; empty default', () => {
  assert.deepEqual(resolveTraceRoots(SETTINGS, {}), []);
  assert.deepEqual(resolveTraceRoots({ ...SETTINGS, ...({ trace_roots: ['/a', '/b'] } as any) }, {}), ['/a', '/b']);
  assert.deepEqual(
    resolveTraceRoots({ ...SETTINGS, ...({ trace_roots: ['/a'] } as any) }, { WEAVE_TRACE_ROOTS: '/x, /y ' } as NodeJS.ProcessEnv),
    ['/x', '/y'],
  );
});
