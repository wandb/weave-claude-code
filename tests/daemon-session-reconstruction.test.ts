// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// The daemon shuts itself down after a short idle window and keeps all session
// state in memory, seeded only at SessionStart. A Claude Code session that
// outlives a daemon restart (e.g. the user steps away, the daemon idles
// out, then they resume the SAME session) sends its next UserPromptSubmit to a
// fresh daemon that never saw its SessionStart — producing "Unknown session"
// and silently dropping all tracing for the rest of that session.
//
// The fix: reconstruct the session from the `transcript_path` carried on the
// event, so the daemon is tolerant of its own restarts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { startTestDaemon } from './helpers.ts';

/** Write a transcript with `turns` completed user+assistant pairs and return
 *  its path. Lives under the daemon's $HOME so TranscriptFile's within-home
 *  check passes. */
function writeTranscript(home: string, sessionId: string, turns: number): string {
  const dir = path.join(home, '.claude', 'projects', 'test', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `prompt ${i}` }] } }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', id: `m${i}`,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: 'end_turn', content: [{ type: 'text', text: `answer ${i}` }],
      },
    }));
  }
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('UserPromptSubmit for an unknown session reconstructs it from transcript_path and opens a turn span', async () => {
  const d = await startTestDaemon();
  try {
    const sessionId = 'recon-sess-001';
    const transcript = writeTranscript(d.home, sessionId, 1);

    // No SessionStart — this session predates this daemon instance.
    await d.send({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: transcript,
      prompt: 'continue the work',
    });

    const traced = await d.waitForLog(/Created turn span/, 3000);
    assert.ok(traced, `expected a turn span for the reconstructed session; log was:\n${d.readLog()}`);

    const log = d.readLog();
    assert.match(log, /Session reconstructed after restart: recon-sess-001/);
    assert.doesNotMatch(log, /Unknown session/);
  } finally {
    await d.stop();
  }
});

test('reconstructed session continues turn numbering from the transcript', async () => {
  const d = await startTestDaemon();
  try {
    const sessionId = 'recon-sess-002';
    // Three completed turns already on disk → the resumed turn is turn 4.
    const transcript = writeTranscript(d.home, sessionId, 3);

    await d.send({
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: transcript,
      prompt: 'fourth prompt',
    });

    const ok = await d.waitForLog(/Created turn span \(turn 4\)/, 3000);
    assert.ok(ok, `expected the reconstructed turn to be numbered 4; log was:\n${d.readLog()}`);
  } finally {
    await d.stop();
  }
});
