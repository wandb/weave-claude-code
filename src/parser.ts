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

/**
 * A single tool invocation within a turn: the assistant's `tool_use` block
 * paired with the `tool_result` that came back (in a later user message, keyed
 * by `tool_use_id`). `toolResult` is undefined when no result is present in the
 * transcript yet (e.g. an interrupted session).
 */
export interface ToolCallDetail {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  toolResult?: unknown;
  isError: boolean;
}

export interface Turn {
  totalUsage(): UsageSummary;
  primaryModel(): string | undefined;
  textBlocks(): string[];
  assistantCalls(): AssistantCallDetail[];
  /** tool_use blocks in this turn, each paired with its tool_result. */
  toolCalls(): ToolCallDetail[];
  /** Text of the user message that triggered this turn (empty if unknown). */
  prompt(): string;
}

export interface ParsedSession {
  turns: Turn[];
}

export function rawToUsageSummary(raw: Record<string, number>): UsageSummary {
  return {
    input_tokens: raw['input_tokens'] ?? 0,
    output_tokens: raw['output_tokens'] ?? 0,
    cache_read_input_tokens: raw['cache_read_input_tokens'],
    cache_creation_input_tokens: raw['cache_creation_input_tokens'],
  };
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
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

/** Result payload for a single tool_use, keyed by tool_use_id session-wide. */
interface ToolResultEntry {
  result: unknown;
  isError: boolean;
}

function buildSession(lines: unknown[]): ParsedSession {
  const turns: Turn[] = [];
  let currentAssistantLines: AssistantLine[] = [];
  let prevTimestamp: string | undefined;

  // tool_use_ids are globally unique within a session, so a single shared map
  // is sufficient. buildTurn's toolCalls() reads this lazily, so results that
  // arrive after the turn was constructed are still paired correctly.
  const toolResults = new Map<string, ToolResultEntry>();
  // Prompt text of the user message that triggered the in-progress turn.
  let currentPrompt = '';

  for (const line of lines) {
    const entry = line as Record<string, unknown>;
    const message = entry['message'] as Record<string, unknown> | undefined;
    const type = entry['type'] as string | undefined;
    const role = (message?.['role'] as string | undefined) ?? type;
    const timestamp = entry['timestamp'] as string | undefined;

    if (role === 'assistant') {
      currentAssistantLines.push({ line: entry, prevTimestamp });
    } else if (role === 'user') {
      const rawContent = message?.['content'];
      const content = Array.isArray(rawContent) ? rawContent as Array<Record<string, unknown>> : [];

      // Collect tool_result blocks before the turn-end check (a user message
      // can carry results without text and must not be missed).
      for (const block of content) {
        if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
          toolResults.set(block['tool_use_id'] as string, {
            result: block['content'],
            isError: block['is_error'] === true,
          });
        }
      }

      // A user message with text content marks the end of the previous turn
      // and is the prompt for the next one.
      const hasText = typeof rawContent === 'string' || content.some(block => block['type'] === 'text');
      if (hasText) {
        if (currentAssistantLines.length > 0) {
          turns.push(buildTurn(currentAssistantLines, toolResults, currentPrompt));
          currentAssistantLines = [];
        }
        currentPrompt = extractUserText(rawContent, content);
      }
    }

    if (timestamp) prevTimestamp = timestamp;
  }

  if (currentAssistantLines.length > 0) {
    turns.push(buildTurn(currentAssistantLines, toolResults, currentPrompt));
  }

  return { turns };
}

function extractUserText(rawContent: unknown, content: Array<Record<string, unknown>>): string {
  if (typeof rawContent === 'string') return rawContent;
  const parts: string[] = [];
  for (const block of content) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'] as string);
    }
  }
  return parts.join('\n');
}

function buildTurn(assistantLines: AssistantLine[], toolResults: Map<string, ToolResultEntry>, prompt: string): Turn {
  const calls: AssistantCallDetail[] = assistantLines.map(({ line, prevTimestamp }) => {
    const message = line['message'] as Record<string, unknown> | undefined;
    const rawUsage = (message?.['usage'] ?? line['usage'] ?? {}) as Record<string, number>;
    const usage = rawToUsageSummary(rawUsage);
    const reasoningTokens = typeof rawUsage['reasoning_tokens'] === 'number' ? rawUsage['reasoning_tokens'] : undefined;
    const model = (message?.['model'] ?? line['model']) as string | undefined;
    const rawContent = message?.['content'];
    // `content` is either an array of blocks (the common assistant shape), a
    // bare string (legacy single-text format), or missing. Fall back to [] for
    // the missing / unknown case so downstream code sees a well-typed empty
    // list instead of `undefined`.
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

  const model = calls.map(call => call.model).filter(Boolean).pop();

  const texts = calls.flatMap(call => extractAssistantTextBlocks(call.contentBlocks));

  const toolCalls = (): ToolCallDetail[] => {
    const out: ToolCallDetail[] = [];
    for (const call of calls) {
      for (const block of call.contentBlocks) {
        if (!block || typeof block !== 'object') continue;
        const obj = block as Record<string, unknown>;
        if (obj['type'] !== 'tool_use' || typeof obj['id'] !== 'string') continue;
        // Skip malformed blocks with no tool name — avoids emitting an
        // `execute_tool ` span with a trailing-space name.
        if (typeof obj['name'] !== 'string' || !(obj['name'] as string)) continue;
        const result = toolResults.get(obj['id'] as string);
        out.push({
          toolName: obj['name'] as string,
          toolUseId: obj['id'] as string,
          toolInput: (obj['input'] as Record<string, unknown>) ?? {},
          toolResult: result?.result,
          isError: result?.isError ?? false,
        });
      }
    }
    return out;
  };

  return {
    totalUsage: () => totalUsageValue,
    primaryModel: () => model,
    textBlocks: () => texts,
    assistantCalls: () => calls,
    toolCalls,
    prompt: () => prompt,
  };
}

/**
 * Pull human-readable text out of assistant `content` blocks. Accepts the raw
 * union (string entries, `{type: 'text', text}` objects, etc.) and returns
 * only non-empty text. `thinking` and other block types are skipped.
 */
export function extractAssistantTextBlocks(blocks: unknown[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      if (block.trim()) out.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const obj = block as Record<string, unknown>;
    if (obj['type'] === 'text' && typeof obj['text'] === 'string' && (obj['text'] as string).trim()) {
      out.push(obj['text'] as string);
    }
  }
  return out;
}
