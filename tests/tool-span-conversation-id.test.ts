// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// execute_tool spans inherit conversation/agent identity from their root turn
// span at query time, but carried none of it themselves. If the root is lost
// (a hard SIGKILL/OOM the daemon cannot clean up gracefully), the exported tool
// spans become unattributable — no conversation to stitch them to. Every other
// span builder already stamps gen_ai.conversation.id; the tool span is the gap.
// This drives a real PreToolUse and asserts the emitted tool span carries it.

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

interface Harness {
  handleSessionStart(s: string, p: Record<string, unknown>): Promise<void>;
  handleUserPromptSubmit(s: string, p: Record<string, unknown>): Promise<void>;
  handlePreToolUse(s: string, a: string | undefined, p: Record<string, unknown>): Promise<void>;
  handlePostToolUse(s: string, p: Record<string, unknown>): Promise<void>;
  tracer: unknown;
}

test('execute_tool spans carry gen_ai.conversation.id so they stitch even without their root', async () => {
  const sid = 'sess-tool-conv';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-toolconv-itest-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }) + '\n');
  const append = (o: unknown) => fs.appendFileSync(file, JSON.stringify(o) + '\n');

  const { tracer, exporter, provider } = setupTracer();
  const logFile = path.join(os.tmpdir(), `wcp-toolconv-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused-toolconv.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  const h = d as unknown as Harness;

  try {
    await h.handleSessionStart(sid, { transcript_path: file, source: 'startup', cwd: '/x' });
    await h.handleUserPromptSubmit(sid, { prompt: 'go' });
    append({ type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', id: 'msgA', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } });
    await h.handlePreToolUse(sid, undefined, { tool_use_id: 'tool_1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await h.handlePostToolUse(sid, { tool_use_id: 'tool_1', tool_response: 'ok' });
    await provider.forceFlush();

    const tool = exporter.getFinishedSpans().find(s => s.attributes[ATTR.OPERATION_NAME] === OP.EXECUTE_TOOL);
    assert.ok(tool, 'tool span exported');
    // conversationId === sessionId for a fresh (non-resumed) session.
    assert.equal(tool!.attributes[ATTR.CONVERSATION_ID], sid, 'tool span carries the conversation id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
