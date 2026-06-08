// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression anchor: span shape must stay byte-identical across the
// Weave SDK migration (modulo service.name resource attr and auth
// header, both intentionally changed in this PR). This test exercises
// the genaiSpans helpers directly against an InMemorySpanExporter and
// asserts on the emitted attributes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  startTurnSpan,
  startToolSpan,
  emitChatSpan,
  ATTR,
} from '../src/genaiSpans.ts';

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

test('migration baseline: turn + tool + chat shape', async () => {
  const { tracer, exporter, provider } = setupTracer();
  const turn = startTurnSpan(tracer, {
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    turnNumber: 1,
    prompt: 'hello',
    cwd: '/tmp',
    source: 'fresh',
    pluginVersion: '0.0.0-test',
  });
  const tool = startToolSpan(tracer, turn, {
    toolName: 'Bash',
    toolUseId: 'tu-1',
    toolInput: { command: 'ls' },
    displayName: 'Bash: ls',
  });
  tool.setAttribute(ATTR.TOOL_CALL_RESULT, '"ok"');
  tool.end();
  emitChatSpan(tracer, turn, {
    conversationId: 'conv-1',
    model: 'claude-opus-4-7',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: new Date('2026-01-01T00:00:01Z'),
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  turn.end();
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  const byOp = Object.fromEntries(
    spans.map(s => [s.attributes[ATTR.OPERATION_NAME] as string, s])
  );
  assert.equal(byOp['invoke_agent']?.attributes[ATTR.AGENT_NAME], 'claude-code');
  assert.equal(byOp['execute_tool']?.attributes[ATTR.TOOL_NAME], 'Bash');
  assert.equal(byOp['chat']?.attributes[ATTR.REQUEST_MODEL], 'claude-opus-4-7');
  assert.equal(
    byOp['chat']?.attributes[ATTR.USAGE_INPUT_TOKENS],
    100,
  );
});
