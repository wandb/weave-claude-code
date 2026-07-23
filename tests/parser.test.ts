// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assistantResponses,
  lastAssistantTextEndsWith,
  parseSessionFd,
} from '../src/parser.ts';
import type { ParsedSession } from '../src/parser.ts';

function parseLines(lines: unknown[]): ParsedSession {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-parser-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  const fd = fs.openSync(file, 'r');
  try {
    const parsed = parseSessionFd(fd);
    assert.ok(parsed);
    return parsed;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rejects a transcript that shrinks below its captured boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-parser-boundary-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'captured' },
  })}\n`);
  const capturedBytes = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    fs.truncateSync(file, capturedBytes - 1);
    assert.equal(parseSessionFd(fd, capturedBytes), null);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function assistant(
  id: string | undefined,
  timestamp: string,
  content: unknown,
  options: {
    model?: string;
    usage?: Record<string, unknown>;
    finishReason?: string;
  } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      ...(id ? { id } : {}),
      model: options.model ?? 'claude-opus-4-8',
      usage: options.usage ?? { input_tokens: 1, output_tokens: 1 },
      content,
      ...(options.finishReason ? { stop_reason: options.finishReason } : {}),
    },
  };
}

test('normalizes responses and splits turns only at typed prompts', () => {
  const session = parseLines([
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'do it' },
    },
    assistant(
      'msg-a',
      '2026-01-01T00:00:01.000Z',
      [{ type: 'thinking', thinking: 'first block' }],
      { model: 'first-model', usage: { input_tokens: 1, output_tokens: 2 } },
    ),
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:01.500Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>keep going</system-reminder>' }],
      },
    },
    assistant(
      'msg-a',
      '2026-01-01T00:00:02.000Z',
      [{ type: 'text', text: 'second block' }],
      {
        model: 'final-model',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          reasoning_tokens: 7,
        },
        finishReason: 'end_turn',
      },
    ),
    assistant(
      'msg-b',
      '2026-01-01T00:00:03.000Z',
      [{ type: 'text', text: 'still the same turn' }],
    ),
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'user', content: 'second prompt' },
    },
    assistant('msg-c', '2026-01-01T00:00:05.000Z', 'second answer'),
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:06.000Z',
      message: { role: 'user', content: 'prompt without an answer yet' },
    },
  ]);

  assert.equal(session.turns.length, 3);
  assert.deepEqual(session.turns[0], {
    startTime: '2026-01-01T00:00:00.000Z',
    userText: 'do it',
    model: 'claude-opus-4-8',
    text: ['second block', 'still the same turn'],
    responses: [
      {
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T00:00:02.000Z',
        model: 'final-model',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
        reasoningTokens: 7,
        content: [
          { type: 'thinking', thinking: 'first block' },
          { type: 'text', text: 'second block' },
        ],
        id: 'msg-a',
        finishReason: 'end_turn',
      },
      {
        startTime: '2026-01-01T00:00:02.000Z',
        endTime: '2026-01-01T00:00:03.000Z',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: undefined,
          cache_creation_input_tokens: undefined,
        },
        reasoningTokens: undefined,
        content: [{ type: 'text', text: 'still the same turn' }],
        id: 'msg-b',
        finishReason: undefined,
      },
    ],
  });
  assert.equal(session.turns[1].userText, 'second prompt');
  assert.deepEqual(session.turns[1].text, ['second answer']);
  assert.deepEqual(session.turns[2], {
    startTime: '2026-01-01T00:00:06.000Z',
    userText: 'prompt without an answer yet',
    model: undefined,
    text: [],
    responses: [],
  });
  assert.equal(assistantResponses(session).length, 3);
  assert.equal(lastAssistantTextEndsWith(session, 'second answer'), true);
});

test('folds only consecutive assistant lines with the same response id', () => {
  const session = parseLines([
    { type: 'user', message: { role: 'user', content: 'go' } },
    assistant('shared', '2026-01-01T00:00:01.000Z', [{ type: 'text', text: 'one' }]),
    assistant('other', '2026-01-01T00:00:02.000Z', [{ type: 'text', text: 'two' }]),
    assistant('shared', '2026-01-01T00:00:03.000Z', [{ type: 'text', text: 'three' }]),
    assistant(undefined, '2026-01-01T00:00:04.000Z', [{ type: 'text', text: 'four' }]),
    assistant(undefined, '2026-01-01T00:00:05.000Z', [{ type: 'text', text: 'five' }]),
  ]);

  assert.deepEqual(
    session.turns[0].responses.map(response => response.id),
    ['shared', 'other', 'shared', undefined, undefined],
  );
});

test('narrows transcript records while preserving top-level assistant fallbacks', () => {
  const session = parseLines([
    null,
    [],
    'ignored',
    7,
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'go' },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: [],
      id: 'top-level-id',
      model: 'top-level-model',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        reasoning_tokens: 2,
        ignored: 'not-a-number',
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        id: 42,
        model: false,
        usage: { input_tokens: 'invalid', output_tokens: 5 },
        content: 42,
        stop_reason: 42,
      },
    },
  ]);

  assert.equal(session.turns.length, 1);
  assert.deepEqual(session.turns[0].responses, [
    {
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.000Z',
      model: 'top-level-model',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: undefined,
        cache_creation_input_tokens: undefined,
      },
      reasoningTokens: 2,
      content: [],
      id: 'top-level-id',
      finishReason: undefined,
    },
    {
      startTime: '2026-01-01T00:00:01.000Z',
      endTime: '2026-01-01T00:00:02.000Z',
      model: undefined,
      usage: {
        input_tokens: 0,
        output_tokens: 5,
        cache_read_input_tokens: undefined,
        cache_creation_input_tokens: undefined,
      },
      reasoningTokens: undefined,
      content: [],
      id: undefined,
      finishReason: undefined,
    },
  ]);
});
