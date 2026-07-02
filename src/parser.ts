// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Per-API-call detail for a single assistant message in the transcript.
 * Each entry corresponds to one LLM invocation within a turn, used to emit
 * one `chat <model>` span per call at Stop time.
 */
export interface AssistantCallDetail {
  timestamp: string;            // ISO timestamp of the assistant message
  prevTimestamp?: string;       // ISO timestamp of preceding transcript line (proxy for "request started")
  model?: string;
  usage: UsageSummary;          // per-call usage
  reasoningTokens?: number;     // reasoning/thinking tokens, if any
  contentBlocks: unknown[];     // raw assistant content blocks (text, tool_use, thinking, ...)
  responseId?: string;          // provider message id
  finishReason?: string;        // stop_reason / finish_reason if present
}

export interface Turn {
  totalUsage(): UsageSummary;
  primaryModel(): string | undefined;
  textBlocks(): string[];
  assistantCalls(): AssistantCallDetail[];
}

export interface ParsedSession {
  turns: Turn[];
}

function rawToUsageSummary(raw: Record<string, number>): UsageSummary {
  return {
    input_tokens: raw['input_tokens'] ?? 0,
    output_tokens: raw['output_tokens'] ?? 0,
    cache_read_input_tokens: raw['cache_read_input_tokens'],
    cache_creation_input_tokens: raw['cache_creation_input_tokens'],
  };
}

function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

export function parseSessionFile(filePath: string): ParsedSession | null {
  return parseSessionReader(() => fs.readFileSync(filePath, 'utf8'));
}

export function parseSessionFd(fd: number): ParsedSession | null {
  return parseSessionReader(() => readUtf8FromFd(fd));
}

function parseSessionReader(read: () => string): ParsedSession | null {
  try {
    const lines = read()
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as unknown);

    return buildSession(lines);
  } catch {
    return null;
  }
}

function readUtf8FromFd(fd: number): string {
  const stat = fs.fstatSync(fd);
  const size = stat.size;
  if (size === 0) {
    return '';
  }

  const buffer = Buffer.allocUnsafe(size);
  let bytesRead = 0;

  while (bytesRead < size) {
    const n = fs.readSync(fd, buffer, bytesRead, size - bytesRead, bytesRead);
    if (n === 0) break;
    bytesRead += n;
  }

  return buffer.toString('utf8', 0, bytesRead);
}

interface AssistantLine {
  line: Record<string, unknown>;
  prevTimestamp?: string;
}

function buildSession(lines: unknown[]): ParsedSession {
  const turns: Turn[] = [];
  let currentAssistantLines: AssistantLine[] = [];
  let prevTimestamp: string | undefined;

  for (const line of lines) {
    const { message, type, role: rawRole, timestamp } = readTranscriptLine(line);
    const role = rawRole ?? type;

    if (role === 'assistant') {
      // `role === 'assistant'` implies the line is an object (it carried either
      // a `message.role` or a top-level `type`), so the {} fallback is unreachable.
      currentAssistantLines.push({ line: isObject(line) ? line : {}, prevTimestamp });
    } else if (role === 'user') {
      const rawContent = message?.['content'];

      // A user message with text content marks the end of the previous turn.
      const hasText = typeof rawContent === 'string'
        || (Array.isArray(rawContent) ? rawContent : []).some(isTextBlock);
      if (hasText && currentAssistantLines.length > 0) {
        turns.push(buildTurn(currentAssistantLines));
        currentAssistantLines = [];
      }
    }

    if (timestamp) prevTimestamp = timestamp;
  }

  if (currentAssistantLines.length > 0) {
    turns.push(buildTurn(currentAssistantLines));
  }

  return { turns };
}

function buildTurn(assistantLines: AssistantLine[]): Turn {
  const calls: AssistantCallDetail[] = assistantLines.map(({ line, prevTimestamp }) => {
    const { message } = readTranscriptLine(line);
    const rawUsage = (message?.['usage'] ?? line['usage'] ?? {}) as Record<string, number>;
    const usage = rawToUsageSummary(rawUsage);
    const reasoningTokens = typeof rawUsage['reasoning_tokens'] === 'number' ? rawUsage['reasoning_tokens'] : undefined;
    const model = (message?.['model'] ?? line['model']) as string | undefined;
    const rawContent = message?.['content'];
    // A bare-string `content` is the legacy single-text format; synthesize a
    // text block so downstream sees a uniform block list (missing/other → []).
    const contentBlocks: unknown[] = Array.isArray(rawContent)
      ? (rawContent as unknown[])
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : [];
    const responseId = (message?.['id'] ?? line['id']) as string | undefined;
    const stopReason = (message?.['stop_reason'] ?? message?.['finish_reason']) as string | undefined;
    const timestamp = (line['timestamp'] as string | undefined) ?? '';

    return {
      timestamp,
      prevTimestamp,
      model,
      usage,
      reasoningTokens,
      contentBlocks,
      responseId,
      finishReason: stopReason,
    };
  });

  const totalUsageValue = calls.reduce<UsageSummary>(
    (acc, call) => addUsage(acc, call.usage),
    { input_tokens: 0, output_tokens: 0 },
  );

  const model = calls.filter(call => call.model).at(-1)?.model;

  const texts = calls.flatMap(call => extractAssistantTextBlocks(call.contentBlocks));

  return {
    totalUsage: () => totalUsageValue,
    primaryModel: () => model,
    textBlocks: () => texts,
    assistantCalls: () => calls,
  };
}

// The assistant content-block shapes we act on (Anthropic Messages API).
// Blocks reach us as `unknown` from the transcript; the guards below narrow the
// ones we care about. Any other block type falls through every guard and is
// ignored.
type TextBlock = { type: 'text'; text: string };
type ThinkingBlock = { type: 'thinking'; thinking: string };
type RedactedThinkingBlock = { type: 'redacted_thinking'; data?: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input?: unknown };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Structural shape of a single JSONL transcript line we care about. */
type TranscriptLine = {
  message?: Record<string, unknown>;
  type?: string;
  role?: string;
  timestamp?: string;
};

/**
 * Decode one raw JSONL transcript line into the fields the parser reads,
 * narrowing each with a runtime check instead of an `as` cast. `role` is the
 * raw `message.role` (callers fall back to `type` for lines that carry only a
 * top-level `type`). Fields absent or of the wrong type come back undefined.
 */
function readTranscriptLine(line: unknown): TranscriptLine {
  if (!isObject(line)) return {};
  const message = isObject(line['message']) ? line['message'] : undefined;
  return {
    message,
    type: typeof line['type'] === 'string' ? line['type'] : undefined,
    role: typeof message?.['role'] === 'string' ? message['role'] : undefined,
    timestamp: typeof line['timestamp'] === 'string' ? line['timestamp'] : undefined,
  };
}

export function isTextBlock(block: unknown): block is TextBlock {
  return isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string';
}

export function isThinkingBlock(block: unknown): block is ThinkingBlock {
  return isObject(block) && block['type'] === 'thinking' && typeof block['thinking'] === 'string';
}

export function isRedactedThinkingBlock(block: unknown): block is RedactedThinkingBlock {
  return isObject(block) && block['type'] === 'redacted_thinking';
}

export function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return isObject(block) && block['type'] === 'tool_use'
    && typeof block['id'] === 'string' && typeof block['name'] === 'string';
}

/**
 * Pull human-readable text out of assistant `content` blocks. Accepts the raw
 * union (string entries, `{type: 'text', text}` objects, etc.) and returns
 * only non-empty text. `thinking` and other block types are skipped.
 */
export function extractAssistantTextBlocks(blocks: unknown[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string' && block.trim()) {
      out.push(block);
    } else if (isTextBlock(block) && block.text.trim()) {
      out.push(block.text);
    }
  }
  return out;
}
