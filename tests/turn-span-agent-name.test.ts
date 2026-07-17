// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// The top-level agent name is user-customizable (settings `agent_name` /
// `WEAVE_AGENT_NAME`). The daemon resolves the effective value and passes it to
// `weave.startTurn`, which the SDK stamps on the `gen_ai.agent.name` attribute
// that drives Weave's Agents-view grouping. (The SDK always names the span
// `invoke_agent`; the agent name lives in the attribute, not the span name.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATTR, DEFAULT_AGENT_NAME } from '../src/genaiSpans.ts';
import { flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

function writeTranscript(sessionId: string, text: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-agentname-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  return { file, dir };
}

test('turn span: agentName drives gen_ai.agent.name', async () => {
  const exporter = await initWeaveInMemory();

  // A custom name and the default both flow through identically.
  for (const name of ['my-custom-agent', DEFAULT_AGENT_NAME]) {
    exporter.reset();
    const sid = `sess-${name}`;
    const { file, dir } = writeTranscript(sid, 'hello');
    const d = makeGenaiDaemon(name);
    try {
      await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/tmp' });
      await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hello' });
      // The turn span only exports on end; SessionEnd finalizes an open turn.
      await d.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
      await flushWeave();

      const turnSpans = exporter.getFinishedSpans().filter(s => s.name === 'invoke_agent');
      assert.equal(turnSpans.length, 1, 'exactly one turn span');
      assert.equal(turnSpans[0].attributes[ATTR.AGENT_NAME], name, `gen_ai.agent.name must be "${name}"`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
