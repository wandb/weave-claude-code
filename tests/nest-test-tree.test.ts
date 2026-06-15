// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Locked TDD spec (A1–A8) for buildTrace over a REAL /nest-test run.
// Fixture: tests/fixtures/nest-test — captured from session adb6bee6, the
// current two-turn nest-test procedure (coordinator spawns ONE teammate
// `nest-probe`, drives it across two turns: 3 Bash + turn-1-done, then 2 Bash
// + turn-2-done). The harness left TWO nest-probe transcripts for the one
// teammate (a partial turn-1-only + a complete both-turns) — the re-spawn case
// that exercises merge/dedup. P0 is correct tool→agent attribution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { buildTrace } from '../src/buildTrace.ts';
import { ATTR, OP } from '../src/genaiSpans.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'nest-test');

// buildTrace requires the transcript to live under $HOME and discovers
// subagents at `<transcript-without-.jsonl>/subagents/`. Lay the fixture out
// that way in a temp HOME dir.
function stageFixture(): { transcriptPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.wcp-nesttest-'));
  const transcriptPath = path.join(dir, 'session.jsonl');
  fs.copyFileSync(path.join(FIXTURE, 'session.jsonl'), transcriptPath);
  const subDest = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(subDest, { recursive: true });
  for (const f of fs.readdirSync(path.join(FIXTURE, 'subagents'))) {
    fs.copyFileSync(path.join(FIXTURE, 'subagents', f), path.join(subDest, f));
  }
  return { transcriptPath, dir };
}

function build(): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const { transcriptPath, dir } = stageFixture();
  try {
    buildTrace(provider.getTracer('test'), transcriptPath, {
      sessionId: 'adb6bee6', cwd: '/work', source: 'startup',
      agentName: 'tars', pluginVersion: '9.9.9',
    });
    return exporter.getFinishedSpans();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const op = (s: ReadableSpan) => s.attributes[ATTR.OPERATION_NAME];
const tool = (s: ReadableSpan) => s.attributes[ATTR.TOOL_NAME];
const agentName = (s: ReadableSpan) => s.attributes[ATTR.AGENT_NAME];
const agentId = (s: ReadableSpan) => s.attributes[ATTR.AGENT_ID];
const id = (s: ReadableSpan) => s.spanContext().spanId;
const parent = (s: ReadableSpan) => s.parentSpanContext?.spanId;

function invokeAgents(spans: ReadableSpan[]) { return spans.filter(s => op(s) === OP.INVOKE_AGENT); }
function childrenOf(spans: ReadableSpan[], parentId: string) {
  return spans.filter(s => parent(s) === parentId);
}
function toolsUnder(spans: ReadableSpan[], parentId: string, name: string) {
  return childrenOf(spans, parentId).filter(s => op(s) === OP.EXECUTE_TOOL && tool(s) === name);
}

test('nest-test tree — A1′: every root is a coordinator turn (invoke_agent @tars); nest-probe is never a root', () => {
  const spans = build();
  const roots = spans.filter(s => !parent(s));
  assert.ok(roots.length >= 1, 'at least one coordinator turn root');
  for (const r of roots) {
    assert.equal(op(r), OP.INVOKE_AGENT, 'root is invoke_agent');
    assert.equal(agentName(r), 'tars', 'root is the coordinator');
  }
  assert.ok(!roots.some(r => agentName(r) === 'nest-probe'), 'nest-probe is not a root');
});

test('nest-test tree — A2/A2′: exactly one nest-probe invoke_agent (re-spawn merged, not duplicated)', () => {
  const spans = build();
  const probes = invokeAgents(spans).filter(s => agentName(s) === 'nest-probe');
  assert.equal(probes.length, 1, 'the two nest-probe transcripts resolve to ONE invoke_agent span');
});

test('nest-test tree — A3: nest-probe parents under the root', () => {
  const spans = build();
  const root = spans.find(s => !parent(s))!;
  const probe = invokeAgents(spans).find(s => agentName(s) === 'nest-probe')!;
  assert.equal(parent(probe), id(root), 'nest-probe.parent == root');
});

test('nest-test tree — A4: nest-probe has a non-empty agent_id, distinct from root (UI can separate them)', () => {
  const spans = build();
  const root = spans.find(s => !parent(s))!;
  const probe = invokeAgents(spans).find(s => agentName(s) === 'nest-probe')!;
  assert.ok(agentId(probe), 'nest-probe agent_id is non-empty');
  assert.notEqual(agentId(probe), agentId(root), 'nest-probe agent_id differs from root');
});

test('nest-test tree — A5/A2′: nest-probe owns exactly 5 Bash + 2 SendMessage (turn-1 NOT double-counted)', () => {
  const spans = build();
  const probe = invokeAgents(spans).find(s => agentName(s) === 'nest-probe')!;
  assert.equal(toolsUnder(spans, id(probe), 'Bash').length, 5, '5 Bash (turn1×3 + turn2×2), deduped');
  assert.equal(toolsUnder(spans, id(probe), 'SendMessage').length, 2, '2 SendMessage (turn-1-done, turn-2-done)');
});

test('nest-test tree — A6: nest-probe Bash spans cover BOTH turns (all-turns attribution)', () => {
  const spans = build();
  const probe = invokeAgents(spans).find(s => agentName(s) === 'nest-probe')!;
  const cmds = toolsUnder(spans, id(probe), 'Bash')
    .map(s => String(s.attributes[ATTR.TOOL_CALL_ARGUMENTS] ?? ''));
  const blob = cmds.join('\n');
  for (const marker of ['turn 1 step 1', 'turn 1 step 2', 'turn 1 step 3', 'turn 2 step 1', 'turn 2 step 2']) {
    assert.ok(blob.includes(marker), `Bash commands include "${marker}"`);
  }
});

test('nest-test tree — A7: coordinator TeamCreate + SendMessage attributed to coordinator roots, not nest-probe', () => {
  const spans = build();
  const roots = spans.filter(s => !parent(s));
  const rootIds = new Set(roots.map(id));
  const probe = invokeAgents(spans).find(s => agentName(s) === 'nest-probe')!;
  const coordTool = (name: string) =>
    spans.filter(s => op(s) === OP.EXECUTE_TOOL && tool(s) === name && rootIds.has(parent(s)!)).length;
  assert.equal(coordTool('TeamCreate'), 1, 'TeamCreate under a coordinator root');
  assert.equal(coordTool('SendMessage'), 1, 'coordinator SendMessage(→nest-probe) under a coordinator root');
  // coordinator's SendMessage must NOT be attributed to the teammate
  assert.equal(
    childrenOf(spans, id(probe)).filter(s => tool(s) === 'SendMessage').length, 2,
    'nest-probe owns only its own 2 SendMessages',
  );
});

test('nest-test tree — A9: child spans carry their owning agent (the field the Agents view groups on)', () => {
  const spans = build();
  const probe = invokeAgents(spans).find(s => agentName(s) === 'nest-probe')!;
  const probeChildren = childrenOf(spans, id(probe)).filter(s => op(s) === OP.EXECUTE_TOOL || op(s) === OP.CHAT);
  assert.ok(probeChildren.length > 0, 'nest-probe has tool/chat children');
  for (const c of probeChildren) {
    assert.equal(agentName(c), 'nest-probe', `child ${op(c)}/${tool(c) ?? ''} attributed to nest-probe`);
    assert.equal(agentId(c), agentId(probe), 'child carries nest-probe agent_id');
  }
  // coordinator's own tool/chat children carry the coordinator's name
  const roots = spans.filter(s => !parent(s));
  const coordChildren = roots.flatMap(r => childrenOf(spans, id(r)))
    .filter(s => op(s) === OP.EXECUTE_TOOL || op(s) === OP.CHAT);
  for (const c of coordChildren) {
    assert.equal(agentName(c), 'tars', `coordinator child ${op(c)}/${tool(c) ?? ''} attributed to coordinator`);
  }
});

test('nest-test tree — A8: no orphans (every span parents to a span in the trace)', () => {
  const spans = build();
  const ids = new Set(spans.map(id));
  const orphans = spans.filter(s => parent(s) && !ids.has(parent(s)!));
  assert.equal(orphans.length, 0, `orphans: ${orphans.map(s => `${op(s)}/${tool(s) ?? ''}`).join(', ')}`);
});
