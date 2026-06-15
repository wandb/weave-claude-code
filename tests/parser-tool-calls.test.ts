// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Parser must expose per-turn tool calls, each tool_use paired with its
// tool_result (the result arrives in a later user message, keyed by
// tool_use_id). The daemonless builder needs this to emit execute_tool spans
// with results in one pass over the transcript.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSessionFile } from '../src/parser.ts';

function writeTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcp-parse-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
}

test('toolCalls(): pairs tool_use with its tool_result and is_error', () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'toolu_AAA', name: 'Read', input: { file_path: '/x' } },
          { type: 'tool_use', id: 'toolu_BBB', name: 'Bash', input: { command: 'false' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:02Z',
      message: {
        role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_AAA', content: 'file contents' },
          { type: 'tool_result', tool_use_id: 'toolu_BBB', content: 'boom', is_error: true },
        ],
      },
    },
    { type: 'user', message: { role: 'user', content: 'next' }, timestamp: '2026-01-01T00:00:03Z' },
  ]);

  const parsed = parseSessionFile(file);
  assert.ok(parsed);
  assert.equal(parsed!.turns.length, 1);
  const calls = parsed!.turns[0].toolCalls();
  assert.equal(calls.length, 2);

  const read = calls.find(c => c.toolUseId === 'toolu_AAA')!;
  assert.equal(read.toolName, 'Read');
  assert.deepEqual(read.toolInput, { file_path: '/x' });
  assert.equal(read.toolResult, 'file contents');
  assert.equal(read.isError, false);

  const bash = calls.find(c => c.toolUseId === 'toolu_BBB')!;
  assert.equal(bash.toolName, 'Bash');
  assert.equal(bash.toolResult, 'boom');
  assert.equal(bash.isError, true);
});

test('toolCalls(): tool_use with no result yet has undefined result', () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' },
    {
      type: 'assistant', timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', model: 'm', usage: {},
        content: [{ type: 'tool_use', id: 'toolu_C', name: 'Glob', input: { pattern: '*' } }],
      },
    },
  ]);
  const parsed = parseSessionFile(file);
  const calls = parsed!.turns[0].toolCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolResult, undefined);
  assert.equal(calls[0].isError, false);
});
