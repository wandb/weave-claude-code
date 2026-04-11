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

export interface Turn {
  totalUsage(): UsageSummary;
  primaryModel(): string | undefined;
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

function buildSession(lines: unknown[]): ParsedSession {
  const turns: Turn[] = [];
  let currentAssistantMsgs: unknown[] = [];

  for (const line of lines) {
    const l = line as Record<string, unknown>;
    const msg = l['message'] as Record<string, unknown> | undefined;
    const type = l['type'] as string | undefined;
    const role = (msg?.['role'] as string | undefined) ?? type;

    if (role === 'assistant') {
      currentAssistantMsgs.push(line);
    } else if (role === 'user') {
      const rawContent = msg?.['content'];
      const content = Array.isArray(rawContent) ? rawContent as Array<Record<string, unknown>> : [];

      // A user message with text content marks the end of the previous turn.
      const hasText = typeof rawContent === 'string' || content.some(b => b['type'] === 'text');
      if (hasText && currentAssistantMsgs.length > 0) {
        turns.push(buildTurn(currentAssistantMsgs));
        currentAssistantMsgs = [];
      }
    }
  }

  if (currentAssistantMsgs.length > 0) {
    turns.push(buildTurn(currentAssistantMsgs));
  }

  return { turns };
}

function buildTurn(assistantMsgs: unknown[]): Turn {
  const usage = assistantMsgs.reduce<UsageSummary>(
    (acc, msg) => {
      const m = msg as Record<string, unknown>;
      const message = m['message'] as Record<string, unknown> | undefined;
      const u = (message?.['usage'] ?? m['usage'] ?? {}) as Record<string, number>;
      return addUsage(acc, rawToUsageSummary(u));
    },
    { input_tokens: 0, output_tokens: 0 }
  );

  const model = assistantMsgs
    .map(m => {
      const msg = m as Record<string, unknown>;
      const message = msg['message'] as Record<string, unknown> | undefined;
      return (message?.['model'] ?? msg['model']) as string | undefined;
    })
    .filter(Boolean)
    .pop();

  return {
    totalUsage: () => usage,
    primaryModel: () => model,
  };
}
