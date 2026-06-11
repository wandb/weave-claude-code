// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// The top-level agent name is user-customizable (settings `agent_name` /
// `WEAVE_AGENT_NAME`). The daemon resolves the effective value and passes it
// to startTurnSpan, which must stamp it on BOTH the span name (`invoke_agent
// <name>`, which drives Weave's Agents-view grouping) and the
// `gen_ai.agent.name` attribute.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { startTurnSpan, ATTR, AGENT_NAME_CLAUDE_CODE } from '../src/genaiSpans.ts';

function setupTracer(): { tracer: ReturnType<BasicTracerProvider['getTracer']>; exporter: InMemorySpanExporter; provider: BasicTracerProvider } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  return { tracer, exporter, provider };
}

function baseArgs(agentName: string) {
  return {
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    turnNumber: 1,
    prompt: 'hello',
    cwd: '/tmp',
    source: 'startup',
    pluginVersion: '0.0.0-test',
    agentName,
  };
}

test('startTurnSpan: custom agentName drives span name and gen_ai.agent.name', async () => {
  const { tracer, exporter, provider } = setupTracer();

  startTurnSpan(tracer, baseArgs('my-custom-agent')).end();
  await provider.forceFlush();

  const span = exporter.getFinishedSpans().find(s => s.name === 'invoke_agent my-custom-agent');
  assert.ok(span, 'span name must embed the custom agent name');
  assert.equal(span.attributes[ATTR.AGENT_NAME], 'my-custom-agent');
});

test('startTurnSpan: default agent name still works', async () => {
  const { tracer, exporter, provider } = setupTracer();

  startTurnSpan(tracer, baseArgs(AGENT_NAME_CLAUDE_CODE)).end();
  await provider.forceFlush();

  const span = exporter.getFinishedSpans().find(s => s.name === 'invoke_agent claude-code');
  assert.ok(span);
  assert.equal(span.attributes[ATTR.AGENT_NAME], 'claude-code');
});
