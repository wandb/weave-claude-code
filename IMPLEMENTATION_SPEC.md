# Implementation Spec: Capture Intermediate Assistant Responses

**Issue:** #40
**Branch:** `Wyler/capture-intermediate-responses`

## Problem

The plugin only captures the final assistant text block per turn. Intermediate text
responses (between tool calls) are lost. The `Stop` hook provides
`last_assistant_message` — a single string. The transcript JSONL file contains all
messages but the parser only extracts usage/model metadata, discarding text content.

Since the parser already reads and JSON-parses the entire transcript file, extracting
text content has zero additional I/O cost.

## Files to Modify

### 1. `src/parser.ts`

**Add a `textBlocks()` method to the `Turn` interface and implementation.**

Current `Turn` interface (line 14-17):
```typescript
export interface Turn {
  totalUsage(): UsageSummary;
  primaryModel(): string | undefined;
}
```

Change to:
```typescript
export interface Turn {
  totalUsage(): UsageSummary;
  primaryModel(): string | undefined;
  textBlocks(): string[];
}
```

**In `buildTurn()` (line 95-124), extract text content from assistant messages.**

The assistant messages are already collected in the `assistantMsgs` array. Each message
object has shape:
```json
{
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "the actual response text" },
      { "type": "tool_use", ... }
    ],
    "model": "...",
    "usage": { ... }
  }
}
```

Implementation for extracting text blocks:
```typescript
const texts: string[] = [];
for (const msg of assistantMsgs) {
  const m = msg as Record<string, unknown>;
  const message = m['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];

  if (typeof content === 'string' && content.trim()) {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
        texts.push(block['text']);
      }
    }
  }
}
```

Add `textBlocks: () => texts` to the returned Turn object.

### 2. `src/daemon.ts`

**In `handleStop()` (line 635-677), use the parsed text blocks for the turn output.**

Current output (line 671):
```typescript
output: { assistant_message: (payload['last_assistant_message'] as string | undefined) ?? '' },
```

Change to:
```typescript
const parsedTexts = currentTurn?.textBlocks() ?? [];
const lastMessage = (payload['last_assistant_message'] as string | undefined) ?? '';

// Use parsed transcript texts if available; fall back to hook payload
const assistantMessages = parsedTexts.length > 0 ? parsedTexts : (lastMessage ? [lastMessage] : []);
```

Then in the `saveCallEnd` output:
```typescript
output: {
  assistant_message: lastMessage,                // backwards compat: final response
  assistant_messages: assistantMessages,          // all text blocks in order
},
```

This preserves `assistant_message` for backwards compatibility while adding the full
`assistant_messages` array.

## What NOT to Change

- Do not change `hooks/hooks.json` — no new hook events needed.
- Do not change `parseSessionFile()` / `parseSessionFd()` / `parseSessionReader()` —
  the file reading logic stays the same.
- Do not change `buildSession()` — the turn boundary detection logic stays the same.
- Do not modify subagent, tool, or session call outputs — only the turn call output.

## Edge Cases

1. **Empty text blocks**: Filter out empty/whitespace-only strings (already handled
   by the `.trim()` check in the extraction logic).
2. **Transcript not yet flushed**: `parseSessionFileWithRetry` already retries 3 times.
   If it still fails, fall back to `last_assistant_message` from the hook payload.
3. **Single response turns** (no tool calls): `assistant_messages` will be a single-
   element array matching `assistant_message`. This is correct.
4. **Content as string vs array**: The transcript format may use either `"content": "text"`
   or `"content": [{"type": "text", "text": "..."}]`. Handle both forms.

## Verification

After implementing, verify against the current session's Weave traces:
- Turn 1 of this session should show multiple `assistant_messages` entries
  (the intermediate "Let me explore..." text plus the final "You don't have Node 24..." text)
- The `assistant_message` field should still contain only the final response
- Turns with no tool calls should have a single-element `assistant_messages` array

Use the W&B MCP server (`mcp__wandb__query_weave_traces_tool`) to query
`wandb-smle/wyler-cc-history` and verify the output structure of turn calls.
