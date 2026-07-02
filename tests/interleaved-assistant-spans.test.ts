// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Unit test for `contentBlocksToParts`: the formatting layer that turns a
// Claude assistant message's content blocks into ordered `MessagePart`s for a
// chat span's `gen_ai.output.messages`.
//
// Post-SDK-migration, an assistant response's interleave (text -> tool_use ->
// text) is no longer separate child spans; it is the ordered `parts` array on
// the single `chat` span. This test pins the block -> part mapping and order.
// The end-to-end interleave behavior (parts on the chat span, tools nested
// under it) is covered by interleave-handlers / interleave-split-lines.

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
