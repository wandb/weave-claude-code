// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// A subagent can itself spawn a subagent (the Agent tool is available inside a
// general-purpose subagent). The grandchild's invoke_agent span must nest under
// its spawning subagent, not orphan onto the turn. Regression test: the daemon
// used to create the invoke_agent tracker only for Agent calls from the MAIN
// agent, so a subagent-initiated dispatch was untracked and the grandchild
// orphaned ("no tracker matches ...; creating orphan").

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

/** A subagent transcript's line 1: the firing user prompt, byte-identical to the
 *  spawning Agent tool's `tool_input.prompt` (how SubagentStart correlates). */
function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    version: '1.2.3',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n';
}

function makeDaemon(tracer: unknown) {
  const logFile = path.join(os.tmpdir(), `wcp-nest-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused-nest.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d as unknown as { routeEvent(p: Record<string, unknown>): Promise<void> };
}

test('a subagent spawned by a subagent nests under its parent, not orphaned onto the turn', async () => {
  const sid = 'sess-nest';
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-nest-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.appendFileSync(file, userLine('do it'));

  // Subagent transcripts live at <project_dir>/<session_id>/subagents/agent-<id>.jsonl
  // (see computeSubagentTranscriptPath).
  const subDir = path.join(dir, sid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const childPrompt = 'child subagent prompt';
  const grandchildPrompt = 'grandchild subagent prompt';

  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });

    // Main agent dispatches child subagent A1.
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'agent_1', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: childPrompt } });
    fs.writeFileSync(path.join(subDir, 'agent-A1.jsonl'), userLine(childPrompt));
    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: 'A1', agent_type: 'general-purpose' });

    // Child subagent A1 dispatches its OWN subagent A2 (PreToolUse carries A1's agent_id).
    await d.routeEvent({ hook_event_name: 'PreToolUse', session_id: sid, agent_id: 'A1', tool_use_id: 'agent_2', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: grandchildPrompt } });
    fs.writeFileSync(path.join(subDir, 'agent-A2.jsonl'), userLine(grandchildPrompt));
    await d.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: 'A2', agent_type: 'general-purpose' });

    // Tear down inner-to-outer, closing each invoke_agent span at its Agent PostToolUse.
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'A2' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, agent_id: 'A1', tool_use_id: 'agent_2', tool_response: 'ok' });
    await d.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'A1' });
    await d.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent_1', tool_response: 'ok' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const byAgentId = (id: string) => spans.find((s) => s.attributes['gen_ai.agent.id'] === id);
    const a1 = byAgentId('A1');
    const a2 = byAgentId('A2');
    assert.ok(a1, 'child subagent A1 invoke_agent span present');
    assert.ok(a2, 'grandchild subagent A2 invoke_agent span present');

    // The grandchild must nest under its spawning subagent, not orphan onto the turn.
    assert.equal(
      a2.parentSpanContext?.spanId,
      a1.spanContext().spanId,
      'A2 (grandchild) parents under A1 (its spawning subagent)',
    );
    assert.equal(
      a2.attributes['weave.claude_code.orphan_reason'],
      undefined,
      'A2 is not emitted as an orphan',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
