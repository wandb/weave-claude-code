// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// buildTrace is the daemonless core: a pure function that walks a transcript
// (and its subagent transcripts on disk) in one pass and emits the same span
// tree the daemon builds incrementally across hook events.

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

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

// Write a transcript under a fake ~/.claude/projects layout so subagent
// discovery (sibling <session>/subagents/ dir) works. TranscriptFile requires
// the path to live under $HOME; tests run with a real HOME so /tmp won't do —
// we write under os.homedir() and clean up.
function makeSession(lines: unknown[]): { transcriptPath: string; dir: string } {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.wcp-buildtrace-'));
  const transcriptPath = path.join(base, 'session.jsonl');
  fs.writeFileSync(transcriptPath, lines.map(l => JSON.stringify(l)).join('\n'));
  return { transcriptPath, dir: base };
}

function addSubagent(dir: string, agentId: string, toolUseId: string, agentType: string, lines: unknown[]) {
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `agent-${agentId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
  fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType, toolUseId }));
}

const OPTS = { sessionId: 'sess-1', cwd: '/work', source: 'startup', agentName: 'tars', pluginVersion: '9.9.9' };

function names(spans: ReadableSpan[]) { return spans.map(s => s.name).sort(); }

test('buildTrace: single turn with chat + paired tool span', () => {
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'do a thing' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 4 },
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'toolu_R', name: 'Read', input: { file_path: '/etc/hosts' } },
        ],
      },
    },
    {
      type: 'user', timestamp: '2026-01-01T00:00:02Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: 'localhost' }] },
    },
  ]);
  try {
    const turns = buildTrace(tracer, transcriptPath, OPTS);
    provider.forceFlush();
    assert.equal(turns, 1);
    const spans = exporter.getFinishedSpans();

    const turn = spans.find(s => s.name === 'invoke_agent tars')!;
    assert.ok(turn, 'turn span emitted');
    assert.equal(turn.attributes[ATTR.OPERATION_NAME], OP.INVOKE_AGENT);
    assert.equal(turn.attributes[ATTR.WEAVE_TURN_NUMBER], 1);
    assert.equal(turn.attributes[ATTR.WEAVE_TURN_TOOL_COUNT], 1);

    const chat = spans.find(s => s.name === 'chat claude-opus-4-8')!;
    assert.ok(chat, 'chat span emitted');
    assert.equal(chat.parentSpanContext?.spanId, turn.spanContext().spanId);

    const tool = spans.find(s => s.name === 'execute_tool Read')!;
    assert.ok(tool, 'tool span emitted');
    assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
    assert.equal(tool.attributes[ATTR.TOOL_CALL_ID], 'toolu_R');
    assert.equal(tool.attributes[ATTR.TOOL_CALL_RESULT], 'localhost');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: Agent tool_use becomes invoke_agent with nested subagent subtree (all turns)', () => {
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'delegate' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_AG', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'go look' } }],
      },
    },
    {
      type: 'user', timestamp: '2026-01-01T00:00:09Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_AG', content: 'done' }] },
    },
  ]);
  // Subagent ran two turns, each with a Bash call. All must be emitted.
  addSubagent(dir, 'abc123', 'toolu_AG', 'Explore', [
    { type: 'user', message: { role: 'user', content: 'go look' }, timestamp: '2026-01-01T00:00:02Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:03Z',
      message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 2, output_tokens: 2 },
        content: [{ type: 'tool_use', id: 'toolu_B1', name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B1', content: 'a b' }] }, timestamp: '2026-01-01T00:00:04Z' },
    { type: 'user', message: { role: 'user', content: 'now grep' }, timestamp: '2026-01-01T00:00:05Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:06Z',
      message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 2, output_tokens: 2 },
        content: [{ type: 'tool_use', id: 'toolu_B2', name: 'Bash', input: { command: 'grep x' } }] },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B2', content: 'x' }] }, timestamp: '2026-01-01T00:00:07Z' },
  ]);
  try {
    buildTrace(tracer, transcriptPath, OPTS);
    provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const turn = spans.find(s => s.name === 'invoke_agent tars')!;
    const sub = spans.find(s => s.name === 'invoke_agent Explore')!;
    assert.ok(sub, 'subagent invoke_agent span emitted');
    assert.equal(sub.parentSpanContext?.spanId, turn.spanContext().spanId, 'subagent nested under turn');
    assert.equal(sub.attributes[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID], 'toolu_AG');

    // Both Bash calls across both subagent turns must be present and nested under the subagent.
    const bashes = spans.filter(s => s.name === 'execute_tool Bash');
    assert.equal(bashes.length, 2, 'both turns of subagent Bash calls emitted (all-turns)');
    for (const b of bashes) {
      assert.equal(b.parentSpanContext?.spanId, sub.spanContext().spanId);
    }
    // No execute_tool Agent span — Agent maps to invoke_agent, not a tool span.
    assert.equal(spans.filter(s => s.name === 'execute_tool Agent').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: agent-teams teammates correlate by type when meta lacks toolUseId (+ re-spawn)', () => {
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'triage' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_TEAM', name: 'Agent', input: { subagent_type: 'cks-specialist', team_name: 'triage-x', prompt: 'go' } }],
      },
    },
    { type: 'user', timestamp: '2026-01-01T00:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_TEAM', content: 'done' }] } },
  ]);
  // Two teammate transcripts of the SAME type (original + re-spawn), meta has NO toolUseId.
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const teammate = (id: string, bashId: string) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-01-01T00:00:02Z' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', model: 'm', usage: {}, content: [{ type: 'tool_use', id: bashId, name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: bashId, content: 'x' }] }, timestamp: '2026-01-01T00:00:04Z' },
    ].map(l => JSON.stringify(l)).join('\n'));
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'cks-specialist' }));
  };
  teammate('t1', 'toolu_b1');
  teammate('t2', 'toolu_b2');
  try {
    buildTrace(tracer, transcriptPath, OPTS);
    provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const turn = spans.find(s => s.name === 'invoke_agent tars')!;
    // ONE invoke_agent at coordinator level (= one Agent call), matching the daemon.
    const invokes = spans.filter(s => s.name === 'invoke_agent cks-specialist');
    assert.equal(invokes.length, 1, 'one invoke_agent per Agent call');
    assert.equal(invokes[0].parentSpanContext?.spanId, turn.spanContext().spanId);
    // BOTH teammate transcripts' Bash calls are captured (original + re-spawn), nested under it.
    const bashes = spans.filter(s => s.name === 'execute_tool Bash');
    assert.equal(bashes.length, 2, 'both re-spawn transcripts captured');
    for (const b of bashes) assert.equal(b.parentSpanContext?.spanId, invokes[0].spanContext().spanId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: re-spawn leftover sets attrs on a still-open invoke_agent span (regression)', () => {
  // Regression for "operation on ended Span": a re-spawn (leftover) attaches to
  // the invoke_agent span created by the spawning Agent call. If that span were
  // ended before the leftover pass, the re-spawn's RESPONSE_MODEL setAttribute
  // would be silently dropped. Here the CLAIMED transcript has no model and the
  // RE-SPAWN supplies it, so the model can only land if the span is still open.
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:01Z',
      message: { role: 'assistant', model: 'm', usage: {}, content: [{ type: 'tool_use', id: 'toolu_T', name: 'Agent', input: { subagent_type: 'r', team_name: 'tm', prompt: 'p' } }] },
    },
    { type: 'user', timestamp: '2026-01-01T00:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_T', content: 'd' }] } },
  ]);
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  // Claimed transcript: NO model. Re-spawn: HAS model 'respawn-model'.
  fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: 'x' }] } }));
  fs.writeFileSync(path.join(sub, 'agent-a.meta.json'), JSON.stringify({ agentType: 'r' }));
  fs.writeFileSync(path.join(sub, 'agent-b.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:05Z', message: { role: 'assistant', model: 'respawn-model', usage: {}, content: [{ type: 'text', text: 'y' }] } }));
  fs.writeFileSync(path.join(sub, 'agent-b.meta.json'), JSON.stringify({ agentType: 'r' }));
  // Make agent-b newer so it sorts after agent-a (claimed first).
  const now = Date.now();
  fs.utimesSync(path.join(sub, 'agent-a.jsonl'), new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(path.join(sub, 'agent-b.jsonl'), new Date(now), new Date(now));
  try {
    buildTrace(tracer, transcriptPath, OPTS);
    provider.forceFlush();
    const invoke = exporter.getFinishedSpans().find(s => s.name === 'invoke_agent r')!;
    assert.ok(invoke, 'invoke_agent span present');
    assert.equal(invoke.attributes[ATTR.RESPONSE_MODEL], 'respawn-model',
      'model set by the re-spawn leftover must land — proves span was still open');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: multi-turn top-level produces one invoke_agent root per turn', () => {
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'first' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', model: 'm', usage: {}, content: [{ type: 'text', text: 'a' }] } },
    { type: 'user', message: { role: 'user', content: 'second' }, timestamp: '2026-01-01T00:00:02Z' },
    { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', model: 'm', usage: {}, content: [{ type: 'text', text: 'b' }] } },
  ]);
  try {
    const turns = buildTrace(tracer, transcriptPath, OPTS);
    provider.forceFlush();
    assert.equal(turns, 2);
    const roots = exporter.getFinishedSpans().filter(s => s.name === 'invoke_agent tars');
    assert.equal(roots.length, 2);
    assert.deepEqual(roots.map(s => s.attributes[ATTR.WEAVE_TURN_NUMBER]).sort(), [1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: turn root carries aggregate usage and real duration', () => {
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:05Z',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
        content: [{ type: 'text', text: 'done' }],
      },
    },
  ]);
  try {
    buildTrace(tracer, transcriptPath, OPTS);
    provider.forceFlush();
    const turn = exporter.getFinishedSpans().find(s => s.name === 'invoke_agent tars')!;
    // input_tokens = 100 + 30 + 10 = 140 (OTel total); output = 20.
    assert.equal(turn.attributes[ATTR.USAGE_INPUT_TOKENS], 140, 'aggregate input tokens on turn root');
    assert.equal(turn.attributes[ATTR.USAGE_OUTPUT_TOKENS], 20, 'aggregate output tokens on turn root');
    // Real duration from transcript (prevTimestamp 00:00 → 00:05 = 5s), not ~0.
    const durMs = (turn.endTime[0] * 1e3 + turn.endTime[1] / 1e6) - (turn.startTime[0] * 1e3 + turn.startTime[1] / 1e6);
    assert.ok(durMs >= 4000, `turn span should span ~5s, got ${durMs}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: out-of-scope cwd emits nothing (traceRoots gate)', () => {
  const { tracer, exporter, provider } = setup();
  const { transcriptPath, dir } = makeSession([
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', model: 'm', usage: {}, content: [{ type: 'text', text: 'a' }] } },
  ]);
  try {
    // In-scope root → emits; sibling-prefix root → emits nothing.
    const inScope = buildTrace(tracer, transcriptPath, { ...OPTS, cwd: '/work/repo', traceRoots: ['/work/repo'] });
    assert.equal(inScope, 1);
    const out = buildTrace(tracer, transcriptPath, { ...OPTS, cwd: '/work/repo', traceRoots: ['/work/repo-sibling'] });
    provider.forceFlush();
    assert.equal(out, 0);
    // Only the in-scope pass produced a turn span.
    assert.equal(exporter.getFinishedSpans().filter(s => s.name === 'invoke_agent tars').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTrace: missing transcript returns 0, emits nothing', () => {
  const { tracer, exporter, provider } = setup();
  const turns = buildTrace(tracer, path.join(os.homedir(), '.wcp-does-not-exist', 'x.jsonl'), OPTS);
  provider.forceFlush();
  assert.equal(turns, 0);
  assert.equal(exporter.getFinishedSpans().length, 0);
});
