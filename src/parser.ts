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
      .map(line => decodeTranscriptLine(JSON.parse(line) as unknown))
      .filter((line): line is TranscriptLine => line !== undefined);
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

type JsonRecord = Record<string, unknown>;

type TranscriptLine = {
  raw: JsonRecord;
  message?: JsonRecord;
  role?: string;
  timestamp?: string;
};

type AssistantLine = {
  previousTimestamp?: string;
  timestamp?: string;
  id?: string;
  model?: string;
  usage: UsageSummary;
  reasoningTokens?: number;
  content: unknown[];
  finishReason?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decodeTranscriptLine(value: unknown): TranscriptLine | undefined {
  if (!isRecord(value)) return undefined;
  const message = isRecord(value['message']) ? value['message'] : undefined;
  return {
    raw: value,
    message,
    role: readString(message?.['role']) ?? readString(value['type']),
    timestamp: readString(value['timestamp']),
  };
}

function buildSession(lines: TranscriptLine[]): ParsedSession {
  const turns: ParsedTurn[] = [];
  let assistantLines: AssistantLine[] = [];
  let turnStarted = false;
  let turnStartTime: string | undefined;
  let turnUserText: string | undefined;
  let previousTimestamp: string | undefined;

  for (const line of lines) {
    const assistant = decodeAssistantLine(line, previousTimestamp);
    if (assistant) {
      assistantLines.push(assistant);
    } else if (line.role === 'user') {
      const content = line.message?.['content'];
      // Typed prompts are bare strings. Array-form user content is injected
      // context (tool results, skills, reminders), so it stays in this turn.
      if (typeof content === 'string' && content) {
        if (turnStarted || assistantLines.length > 0) {
          turns.push(buildTurn(assistantLines, turnStartTime, turnUserText));
        }
        assistantLines = [];
        turnStarted = true;
        turnStartTime = line.timestamp;
        turnUserText = content;
      }
    }

    if (line.timestamp) previousTimestamp = line.timestamp;
  }

  if (turnStarted || assistantLines.length > 0) {
    turns.push(buildTurn(assistantLines, turnStartTime, turnUserText));
  }
  return { turns };
}

function readUsage(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
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

function normalizeContent(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [{ type: 'text', text: value }]
      : [];
}

function decodeAssistantLine(
  line: TranscriptLine,
  previousTimestamp?: string,
): AssistantLine | undefined {
  if (line.role !== 'assistant') return undefined;

  const { raw, message } = line;
  const rawUsage = readUsage(message?.['usage'] ?? raw['usage']);
  return {
    previousTimestamp,
    timestamp: line.timestamp,
    id: readString(message?.['id'] ?? raw['id']),
    model: readString(message?.['model'] ?? raw['model']),
    usage: toUsage(rawUsage),
    reasoningTokens: rawUsage['reasoning_tokens'],
    content: normalizeContent(message?.['content']),
    finishReason: readString(message?.['stop_reason'] ?? message?.['finish_reason']),
  };
}

function buildTurn(
  lines: AssistantLine[],
  startTime?: string,
  userText?: string,
): ParsedTurn {
  const responses: AssistantResponse[] = [];

  for (const line of lines) {
    const previous = responses.at(-1);
    if (line.id && previous?.id === line.id) {
      previous.content.push(...line.content);
      previous.endTime = line.timestamp;
      previous.usage = line.usage;
      previous.reasoningTokens = line.reasoningTokens ?? previous.reasoningTokens;
      previous.model = line.model ?? previous.model;
      previous.finishReason = line.finishReason ?? previous.finishReason;
      continue;
    }

    responses.push({
      startTime: line.previousTimestamp,
      endTime: line.timestamp,
      model: line.model,
      usage: line.usage,
      reasoningTokens: line.reasoningTokens,
      content: line.content,
      id: line.id,
      finishReason: line.finishReason,
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
  return isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string';
}

export function isThinkingBlock(block: unknown): block is ThinkingBlock {
  return isRecord(block) && block['type'] === 'thinking' && typeof block['thinking'] === 'string';
}

export function isRedactedThinkingBlock(block: unknown): block is RedactedThinkingBlock {
  return isRecord(block) && block['type'] === 'redacted_thinking';
}

export function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return isRecord(block)
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
