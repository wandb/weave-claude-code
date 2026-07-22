// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Active root work pins the daemon across its idle window. A blockable Stop
// keeps that root reopenable but makes it quiescent; later call-state slices
// extend the same predicate for tools and subagents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { startTestDaemon } from './helpers.ts';

function writeTranscript(home: string, sessionId: string): string {
  const dir = path.join(home, '.claude', 'projects', 'test', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do work' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', id: 'm1',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }],
      },
    }),
  ].join('\n') + '\n');
  return file;
}

test('daemon stays up past the inactivity timeout while a turn span is open', async () => {
  const d = await startTestDaemon({ env: { WEAVE_INACTIVITY_MS: '1000' } });
  try {
    const sessionId = 'inflight-001';
    const transcript = writeTranscript(d.home, sessionId);
    await d.send({ hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcript });
    await d.send({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, transcript_path: transcript, prompt: 'a long-running task' });

    // Turn span is open and no further events arrive. Past the 1s timeout
    // (checks fire every ~500ms) the daemon must log that it is holding open
    // for in-flight work, and must NOT decide to shut down.
    const stayedUp = await d.waitForLog(/work in flight — staying up/, 3000);
    assert.ok(stayedUp, `daemon should hold open while a turn is in flight; log was:\n${d.readLog()}`);
    assert.doesNotMatch(d.readLog(), /Inactivity timeout — shutting down/);
    assert.equal(d.hasExited(), false, 'daemon should still be running');
  } finally {
    await d.stop();
  }
});

test('daemon idles out once a stopped turn is quiescent', async () => {
  const d = await startTestDaemon({ env: { WEAVE_INACTIVITY_MS: '1000' } });
  try {
    const sessionId = 'inflight-002';
    const transcript = writeTranscript(d.home, sessionId);
    await d.send({ hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcript });
    await d.send({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, transcript_path: transcript, prompt: 'a quick task' });
    await d.send({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcript });

    // Stop is blockable and retains the root for a continuation, but without
    // active work it must not pin the daemon open indefinitely.
    const shuttingDown = await d.waitForLog(/Inactivity timeout — shutting down/, 3500);
    assert.ok(shuttingDown, `daemon should idle out after the turn becomes quiescent; log was:\n${d.readLog()}`);
  } finally {
    await d.stop();
  }
});
