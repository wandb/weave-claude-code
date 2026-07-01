// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// An execute_tool span carries no conversation id of its own; it inherits
// gen_ai.conversation.id from its root turn span at query time. If that root is
// lost to a hard crash (SIGKILL/OOM, no graceful cleanup), the exported tool span
// can't be stitched to a conversation. Every other span builder already propagates
// the id; this drives a real PreToolUse and asserts the tool span carries it too.

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
import { GlobalDaemon } from '../src/daemon.ts';
import { ATTR, OP } from '../src/genaiSpans.ts';

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

function makeDaemon(tracer: unknown) {
  const logFile = path.join(os.tmpdir(), `wcp-toolconv-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused-toolconv.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d as unknown as { routeEvent(p: Record<string, unknown>): Promise<void> };
}

test('execute_tool spans carry gen_ai.conversation.id so they stitch even without their root', async () => {
  const sid = 'sess-tool-conv';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-toolconv-itest-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }) + '\n');

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'go' });
    // The assistant response the tool_use belongs to must be in the transcript before
    // PreToolUse, so the daemon can parent the tool span under the right chat span.
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', id: 'msgA', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } }) + '\n');
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tool_1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'tool_1', tool_response: 'ok' });
    await provider.forceFlush();

    const tool = exporter.getFinishedSpans().find((s) => s.attributes[ATTR.OPERATION_NAME] === OP.EXECUTE_TOOL);
    assert.ok(tool, 'tool span exported');
    // conversationId === sessionId for a fresh (non-resumed) session.
    assert.equal(tool.attributes[ATTR.CONVERSATION_ID], sid, 'tool span carries the conversation id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
