// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

type AnthropicMessage = SDKAssistantMessage['message'];
type AnthropicUsage = AnthropicMessage['usage'];
type OptionalUsageKey = 'cache_read_input_tokens' | 'cache_creation_input_tokens';

/** The normalized subset of Anthropic usage serialized by Claude Code. */
export type UsageSummary = Pick<AnthropicUsage, 'input_tokens' | 'output_tokens'>
  & Partial<{ [Key in OptionalUsageKey]: NonNullable<AnthropicUsage[Key]> }>;

/** One provider response. Claude Code may serialize its content across several
 * adjacent assistant records; the parser folds records sharing a response id. */
export interface AssistantResponse {
  startTime?: string;
  endTime?: string;
  model?: string;
  usage: UsageSummary;
  reasoningTokens?: number;
  content: unknown[];
  id?: string;
  finishReason?: string;
}

export interface ParsedTurn {
  startTime?: string;
  userText?: string;
  model?: string;
  text: string[];
  responses: AssistantResponse[];
}

export interface ParsedSession {
  turns: ParsedTurn[];
}

export function parseSessionFd(fd: number): ParsedSession | null {
  return parseSessionReader(() => readUtf8FromFd(fd));
}

function parseSessionReader(read: () => string): ParsedSession | null {
  try {
    const lines = read()
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as unknown);
    return buildSession(lines);
  } catch {
    return null;
  }
}

function readUtf8FromFd(fd: number): string {
  const size = fs.fstatSync(fd).size;
  if (size === 0) return '';

  const buffer = Buffer.allocUnsafe(size);
  let bytesRead = 0;
  while (bytesRead < size) {
    const count = fs.readSync(fd, buffer, bytesRead, size - bytesRead, bytesRead);
    if (count === 0) break;
    bytesRead += count;
  }
  return buffer.toString('utf8', 0, bytesRead);
}

type TranscriptLine = {
  message?: Record<string, unknown>;
  type?: string;
  role?: string;
  timestamp?: string;
};

type AssistantLine = {
  line: Record<string, unknown>;
  previousTimestamp?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTranscriptLine(value: unknown): TranscriptLine {
  if (!isObject(value)) return {};
  const message = isObject(value['message']) ? value['message'] : undefined;
  return {
    message,
    type: typeof value['type'] === 'string' ? value['type'] : undefined,
    role: typeof message?.['role'] === 'string' ? message['role'] : undefined,
    timestamp: typeof value['timestamp'] === 'string' ? value['timestamp'] : undefined,
  };
}

function buildSession(lines: unknown[]): ParsedSession {
  const turns: ParsedTurn[] = [];
  let assistantLines: AssistantLine[] = [];
  let turnStarted = false;
  let turnStartTime: string | undefined;
  let turnUserText: string | undefined;
  let previousTimestamp: string | undefined;

  for (const value of lines) {
    const decoded = readTranscriptLine(value);
    const role = decoded.role ?? decoded.type;

    if (role === 'assistant' && isObject(value)) {
      assistantLines.push({ line: value, previousTimestamp });
    } else if (role === 'user') {
      const content = decoded.message?.['content'];
      // Typed prompts are bare strings. Array-form user content is injected
      // context (tool results, skills, reminders), so it stays in this turn.
      if (typeof content === 'string' && content) {
        if (turnStarted || assistantLines.length > 0) {
          turns.push(buildTurn(assistantLines, turnStartTime, turnUserText));
        }
        assistantLines = [];
        turnStarted = true;
        turnStartTime = decoded.timestamp;
        turnUserText = content;
      }
    }

    if (decoded.timestamp) previousTimestamp = decoded.timestamp;
  }

  if (turnStarted || assistantLines.length > 0) {
    turns.push(buildTurn(assistantLines, turnStartTime, turnUserText));
  }
  return { turns };
}

function readUsage(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}

function toUsage(raw: Record<string, number>): UsageSummary {
  return {
    input_tokens: raw['input_tokens'] ?? 0,
    output_tokens: raw['output_tokens'] ?? 0,
    cache_read_input_tokens: raw['cache_read_input_tokens'],
    cache_creation_input_tokens: raw['cache_creation_input_tokens'],
  };
}

function buildTurn(
  lines: AssistantLine[],
  startTime?: string,
  userText?: string,
): ParsedTurn {
  const responses: AssistantResponse[] = [];

  for (const { line, previousTimestamp } of lines) {
    const { message, timestamp } = readTranscriptLine(line);
    const rawUsage = readUsage(message?.['usage'] ?? line['usage']);
    const rawContent = message?.['content'];
    const content = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : [];
    const idValue = message?.['id'] ?? line['id'];
    const modelValue = message?.['model'] ?? line['model'];
    const finishValue = message?.['stop_reason'] ?? message?.['finish_reason'];
    const id = typeof idValue === 'string' ? idValue : undefined;
    const model = typeof modelValue === 'string' ? modelValue : undefined;
    const finishReason = typeof finishValue === 'string' ? finishValue : undefined;
    const reasoningTokens = rawUsage['reasoning_tokens'];

    const previous = responses.at(-1);
    if (id && previous?.id === id) {
      previous.content.push(...content);
      previous.endTime = timestamp;
      previous.usage = toUsage(rawUsage);
      previous.reasoningTokens = reasoningTokens ?? previous.reasoningTokens;
      previous.model = model ?? previous.model;
      previous.finishReason = finishReason ?? previous.finishReason;
      continue;
    }

    responses.push({
      startTime: previousTimestamp,
      endTime: timestamp,
      model,
      usage: toUsage(rawUsage),
      reasoningTokens,
      content,
      id,
      finishReason,
    });
  }

  return {
    startTime: startTime ?? responses.at(0)?.startTime,
    userText,
    model: responses.filter(response => response.model).at(-1)?.model,
    text: responses.flatMap(response => extractAssistantTextBlocks(response.content)),
    responses,
  };
}

/** Flatten responses in transcript order. Useful when a live span remembers the
 * response offset at which its prompt began. */
export function assistantResponses(session: ParsedSession): AssistantResponse[] {
  return session.turns.flatMap(turn => turn.responses);
}

export function lastAssistantTextEndsWith(session: ParsedSession, suffix: string): boolean {
  const response = assistantResponses(session).at(-1);
  return response !== undefined
    && extractAssistantTextBlocks(response.content).join('\n').trimEnd().endsWith(suffix);
}

type AnthropicContentBlock = AnthropicMessage['content'][number];
type AnthropicContentBlockFor<Type extends AnthropicContentBlock['type']> = Extract<
  AnthropicContentBlock,
  { type: Type }
>;
type TextBlock = Pick<AnthropicContentBlockFor<'text'>, 'type' | 'text'>;
type ThinkingBlock = Pick<
  AnthropicContentBlockFor<'thinking'>,
  'type' | 'thinking'
>;
type RedactedThinkingBlock = Pick<
  AnthropicContentBlockFor<'redacted_thinking'>,
  'type'
>;
type AnthropicToolUseBlock = AnthropicContentBlockFor<'tool_use'>;
type ToolUseBlock = Pick<AnthropicToolUseBlock, 'type' | 'id' | 'name'>
  & Partial<Pick<AnthropicToolUseBlock, 'input'>>;

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
  return isObject(block)
    && block['type'] === 'tool_use'
    && typeof block['id'] === 'string'
    && typeof block['name'] === 'string';
}

export function extractAssistantTextBlocks(blocks: unknown[]): string[] {
  const text: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string' && block.trim()) text.push(block);
    else if (isTextBlock(block) && block.text.trim()) text.push(block.text);
  }
  return text;
}
