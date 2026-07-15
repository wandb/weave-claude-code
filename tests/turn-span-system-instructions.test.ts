// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// The loaded instruction files (global/project CLAUDE.md, .claude/rules,
// @-imports) surfaced by the InstructionsLoaded hook are stamped on every turn
// root as `gen_ai.system_instructions` — one OTel text part per file, in load
// order. The base Claude Code system prompt is never exposed to hooks, so this
// captures only the user/project instructions appended to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { startTurnSpan, ATTR } from '../src/genaiSpans.ts';

function setupTracer(): { tracer: ReturnType<BasicTracerProvider['getTracer']>; exporter: InMemorySpanExporter; provider: BasicTracerProvider } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  return { tracer, exporter, provider };
}

function baseArgs(systemInstructions?: string[]) {
  return {
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    turnNumber: 1,
    prompt: 'hello',
    cwd: '/tmp',
    source: 'startup',
    pluginVersion: '0.0.0-test',
    agentName: 'claude-code',
    systemInstructions,
  };
}

test('startTurnSpan: stamps gen_ai.system_instructions as ordered text parts', async () => {
  const { tracer, exporter, provider } = setupTracer();

  startTurnSpan(tracer, baseArgs(['GLOBAL', 'PROJECT'])).end();
  await provider.forceFlush();

  const span = exporter.getFinishedSpans()[0];
  assert.ok(span, 'turn span exported');
  assert.equal(
    span.attributes[ATTR.SYSTEM_INSTRUCTIONS],
    JSON.stringify([
      { type: 'text', content: 'GLOBAL' },
      { type: 'text', content: 'PROJECT' },
    ]),
  );
});

test('startTurnSpan: omits gen_ai.system_instructions when there are none', async () => {
  const { tracer, exporter, provider } = setupTracer();

  // Both undefined and empty-array (the daemon passes [] for a session with no
  // loaded instructions) must leave the attribute unset — not "[]".
  startTurnSpan(tracer, baseArgs(undefined)).end();
  startTurnSpan(tracer, baseArgs([])).end();
  await provider.forceFlush();

  for (const span of exporter.getFinishedSpans()) {
    assert.equal(span.attributes[ATTR.SYSTEM_INSTRUCTIONS], undefined);
  }
});
