// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

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

function buildSession(lines: unknown[]): ParsedSession {
  const turns: Turn[] = [];
  let currentAssistantLines: AssistantLine[] = [];
  let prevTimestamp: string | undefined;

  for (const line of lines) {
    const l = line as Record<string, unknown>;
    const msg = l['message'] as Record<string, unknown> | undefined;
    const type = l['type'] as string | undefined;
    const role = (msg?.['role'] as string | undefined) ?? type;
    const timestamp = typeof l['timestamp'] === 'string' ? (l['timestamp'] as string) : undefined;

    if (role === 'assistant') {
      currentAssistantLines.push({ line: l, prevTimestamp });
    } else if (role === 'user') {
      const rawContent = msg?.['content'];
      const content = Array.isArray(rawContent) ? rawContent as Array<Record<string, unknown>> : [];

      // A user message with text content marks the end of the previous turn.
      const hasText = typeof rawContent === 'string' || content.some(b => b['type'] === 'text');
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
    const m = line;
    const message = m['message'] as Record<string, unknown> | undefined;
    const u = (message?.['usage'] ?? m['usage'] ?? {}) as Record<string, number>;
    const usage = rawToUsageSummary(u);
    const reasoningTokens = typeof u['reasoning_tokens'] === 'number' ? u['reasoning_tokens'] : undefined;
    const model = (message?.['model'] ?? m['model']) as string | undefined;
    const rawContent = message?.['content'];
    const contentBlocks: unknown[] = Array.isArray(rawContent)
      ? (rawContent as unknown[])
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : [];
    const responseId = (message?.['id'] ?? m['id']) as string | undefined;
    const stopReason = (message?.['stop_reason'] ?? message?.['finish_reason']) as string | undefined;
    const timestamp = typeof m['timestamp'] === 'string' ? (m['timestamp'] as string) : '';

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
    (acc, c) => addUsage(acc, c.usage),
    { input_tokens: 0, output_tokens: 0 },
  );

  const model = calls.map(c => c.model).filter(Boolean).pop();

  const texts: string[] = [];
  for (const c of calls) {
    for (const block of c.contentBlocks) {
      if (typeof block === 'string' && block.trim()) {
        texts.push(block);
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string' && (b['text'] as string).trim()) {
        texts.push(b['text'] as string);
      }
    }
  }

  return {
    totalUsage: () => totalUsageValue,
    primaryModel: () => model,
    textBlocks: () => texts,
    assistantCalls: () => calls,
  };
}
