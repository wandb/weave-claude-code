// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Integration identity rides OTel Baggage onto EVERY span, not just the turn
// root. The daemon stashes per-session baggage at SessionStart and activates it
// for each event (in routeEvent); IntegrationBaggageSpanProcessor copies the
// `weave.integration.*` entries onto every span at onStart. So a chat or
// execute_tool span deep in a turn is filterable by integration just like the
// root. Assertions use the literal wire keys — those strings are the contract
// the Weave backend reads into its queryable custom-attribute maps.
//
// This drives the real routeEvent entry point (not the handlers directly) so
// the baggage context.with wrapping is exercised, and registers an
// AsyncLocalStorage context manager the way production's provider.register()
// does, so context.active() propagates across the handlers' awaits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { GlobalDaemon } from '../src/daemon.ts';
import { IntegrationBaggageSpanProcessor } from '../src/genaiSpans.ts';
import { VERSION } from '../src/setup.ts';

// Production installs this via NodeTracerProvider.register(); the test injects a
// BasicTracerProvider, so set it up here or context.with won't propagate.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new IntegrationBaggageSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 };

function userText(ts: string, text: string, version: string) {
  return { type: 'user', version, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function aLine(id: string, ts: string, block: Record<string, unknown>, stop?: string) {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      content: [block],
      usage: USAGE,
      ...(stop ? { stop_reason: stop } : {}),
    },
  };
}

function makeDaemon(tracer: unknown) {
  const logFile = path.join(os.tmpdir(), `wcp-integ-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused-integ.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d as unknown as { routeEvent(p: Record<string, unknown>): Promise<void> };
}

test('integration baggage stamps weave.integration.* on every span (turn, chat, tool, text)', async () => {
  const sid = 'sess-bag';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-integ-'));
  const file = path.join(dir, `${sid}.jsonl`);
  // First transcript line carries the CC CLI version (real CC transcripts do).
  fs.appendFileSync(file, JSON.stringify(userText('2026-01-01T00:00:00.000Z', 'do it', '1.2.3')) + '\n');

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });

    // Assistant response msgA: text then tool_use (shared id), flushed before PreToolUse.
    fs.appendFileSync(file, JSON.stringify(aLine('msgA', '2026-01-01T00:00:02.000Z', { type: 'text', text: 'editing' })) + '\n');
    fs.appendFileSync(file, JSON.stringify(aLine('msgA', '2026-01-01T00:00:03.000Z', { type: 'tool_use', id: 'tool_1', name: 'Edit', input: {} }, 'tool_use')) + '\n');
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Edit', tool_input: { file_path: '/foo.ts' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const ops = new Set(spans.map((s) => s.attributes['gen_ai.operation.name']));
    assert.ok(ops.has('invoke_agent'), 'turn span present');
    assert.ok(ops.has('chat'), 'chat span present');
    assert.ok(ops.has('execute_tool'), 'tool span present');

    // The baggage context.with wrapping must not disturb the trace tree: the
    // turn is still the root (no parent) and every span lives in its trace.
    const turn = spans.find((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent');
    assert.ok(turn, 'turn span present');
    assert.equal(turn.parentSpanContext, undefined, 'turn span is a trace root');
    for (const s of spans) {
      assert.equal(s.spanContext().traceId, turn.spanContext().traceId, `${s.name} shares the turn trace`);
    }

    // Every span, regardless of depth, must carry the integration identity.
    for (const s of spans) {
      assert.equal(s.attributes['weave.integration.name'], 'weave-claude-code', `${s.name}: integration name`);
      assert.equal(s.attributes['weave.integration.version'], VERSION, `${s.name}: integration version`);
      assert.equal(s.attributes['weave.integration.meta.claude_code_app_version'], '1.2.3', `${s.name}: cc app version`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
