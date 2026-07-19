// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Pins `contentBlocksToParts`'s block-to-part mapping and order; end-to-end
// interleave coverage lives in interleave-handlers / interleave-split-lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentBlocksToParts } from '../src/genaiSpans.ts';

test('contentBlocksToParts: interleaved text and tool_use map to ordered parts', () => {
  const parts = contentBlocksToParts([
    { type: 'text', text: 'Now let me add the method' },
    { type: 'tool_use', id: 'toolu_01', name: 'Edit', input: { file_path: '/foo.ts' } },
    { type: 'text', text: 'Now let me add the test' },
    { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: { file_path: '/foo.test.ts' } },
    { type: 'text', text: 'All done' },
  ]);

  assert.deepEqual(parts, [
    { type: 'text', content: 'Now let me add the method' },
    { type: 'tool_call', toolCallId: 'toolu_01', toolName: 'Edit', arguments: '{"file_path":"/foo.ts"}' },
    { type: 'text', content: 'Now let me add the test' },
    { type: 'tool_call', toolCallId: 'toolu_02', toolName: 'Edit', arguments: '{"file_path":"/foo.test.ts"}' },
    { type: 'text', content: 'All done' },
  ]);
});

test('contentBlocksToParts: thinking maps to a reasoning part; redacted_thinking to a placeholder', () => {
  const parts = contentBlocksToParts([
    { type: 'thinking', thinking: 'Let me reason about this...' },
    { type: 'redacted_thinking', data: 'ENCRYPTED' },
    { type: 'text', text: 'answer' },
  ]);

  assert.deepEqual(parts, [
    { type: 'reasoning', content: 'Let me reason about this...' },
    { type: 'reasoning', content: '[redacted]' },
    { type: 'text', content: 'answer' },
  ]);
});

test('contentBlocksToParts: empty text and empty thinking are skipped', () => {
  const parts = contentBlocksToParts([
    { type: 'text', text: '   ' },
    { type: 'thinking', thinking: '' },
    { type: 'text', text: 'kept' },
  ]);
  assert.deepEqual(parts, [{ type: 'text', content: 'kept' }]);
});
