// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import {
  Span,
  SpanKind,
  Tracer,
  Context,
  TimeInput,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import type { AssistantCallDetail, UsageSummary } from './parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Attribute keys
//
// Canonical `gen_ai.*` keys come from the OTel GenAI semantic conventions
// (https://opentelemetry.io/docs/specs/semconv/gen-ai/). `weave.*` keys are
// Claude-Code-specific extensions with no semconv equivalent.
// ─────────────────────────────────────────────────────────────────────────────

export const ATTR = {
  // GenAI semconv — classification
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',

  // GenAI semconv — agent
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',
  AGENT_DESCRIPTION: 'gen_ai.agent.description',
  AGENT_VERSION: 'gen_ai.agent.version',
  CONVERSATION_ID: 'gen_ai.conversation.id',

  // GenAI semconv — model
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',

  // GenAI semconv — usage
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_REASONING_TOKENS: 'gen_ai.usage.reasoning_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',

  // GenAI semconv — tool
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT: 'gen_ai.tool.call.result',

  // GenAI semconv — messages
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
  OUTPUT_TYPE: 'gen_ai.output.type',

  // GenAI semconv — errors
  ERROR_TYPE: 'error.type',

  // Weave extensions — session / claude_code
  WEAVE_SESSION_ID: 'weave.claude_code.session.id',
  WEAVE_CWD: 'weave.claude_code.cwd',
  WEAVE_SOURCE: 'weave.claude_code.source',
  WEAVE_PLUGIN_VERSION: 'weave.claude_code.plugin.version',
  WEAVE_TURN_NUMBER: 'weave.claude_code.turn.number',
  WEAVE_TURN_TOOL_COUNT: 'weave.claude_code.turn.tool_count',
  WEAVE_SESSION_END_REASON: 'weave.claude_code.session.end_reason',
  WEAVE_SESSION_TURN_COUNT: 'weave.claude_code.turn.count',
  WEAVE_SESSION_TOOL_COUNT: 'weave.claude_code.tool.count',
  WEAVE_SESSION_TOOL_COUNTS: 'weave.claude_code.tool.counts',
  WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID: 'weave.claude_code.subagent.spawning_tool_call_id',
  WEAVE_TOOL_USE_ID: 'weave.claude_code.tool.use_id',
  WEAVE_ORPHAN_REASON: 'weave.claude_code.orphan_reason',
  WEAVE_DISPLAY_NAME: 'weave.claude_code.display_name',

  // Event names
  EVT_PERMISSION_REQUEST: 'weave.permission_request',
  EVT_PERMISSION_RESOLVED: 'weave.permission_resolved',
  EVT_COMPACTION: 'weave.compaction',

  // Event attributes
  EVT_PERMISSION_APPROVED: 'weave.permission.approved',
  EVT_PERMISSION_SUGGESTIONS: 'weave.permission.suggestions',
  EVT_COMPACTION_SUMMARY: 'weave.compaction.summary',
  EVT_COMPACTION_ITEMS_BEFORE: 'weave.compaction.items_before',
  EVT_COMPACTION_ITEMS_AFTER: 'weave.compaction.items_after',
} as const;

export const AGENT_NAME_CLAUDE_CODE = 'claude-code';

export const OP = {
  INVOKE_AGENT: 'invoke_agent',
  CHAT: 'chat',
  EXECUTE_TOOL: 'execute_tool',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True if `s` is a 32-character hex OTel trace ID. */
export function isValidTraceId(s: string): boolean {
  return /^[0-9a-f]{32}$/i.test(s);
}

/** True if `s` is a 16-character hex OTel span ID. */
export function isValidSpanId(s: string): boolean {
  return /^[0-9a-f]{16}$/i.test(s);
}

/**
 * Derive `gen_ai.provider.name` from a model id. Returns undefined when the
 * routing layer is ambiguous — better to omit than guess.
 */
export function providerFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (/^(us\.)?anthropic\./i.test(model)) return 'aws.bedrock';
  if (/^claude-/i.test(model)) return 'anthropic';
  return undefined;
}

/** Stringify a value for an OTel attribute. Returns '' for null/undefined. */
export function jsonStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Context carrying `parent` as the active span for child-span creation. */
export function ctxWithParent(parent: Span): Context {
  return trace.setSpan(ROOT_CONTEXT, parent);
}

/**
 * Synthetic parent context — used when resuming a session to force the new
 * session span onto a previously-seen traceId. The synthetic spanId does not
 * resolve to a real span in the backend, but the traceId stitches the new
 * spans into the same trace as the prior process.
 */
export function ctxFromSpanContext(traceId: string, spanId: string, isRemote = true): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: 1, // sampled
    isRemote,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Span builders
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionSpanArgs {
  sessionId: string;
  cwd: string;
  source: string;
  pluginVersion: string;
}

export function startSessionSpan(
  tracer: Tracer,
  parentCtx: Context | undefined,
  args: SessionSpanArgs,
): Span {
  return tracer.startSpan(
    `${OP.INVOKE_AGENT} ${AGENT_NAME_CLAUDE_CODE}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR.OPERATION_NAME]: OP.INVOKE_AGENT,
        [ATTR.AGENT_NAME]: AGENT_NAME_CLAUDE_CODE,
        [ATTR.AGENT_VERSION]: args.pluginVersion,
        [ATTR.CONVERSATION_ID]: args.sessionId,
        [ATTR.WEAVE_SESSION_ID]: args.sessionId,
        [ATTR.WEAVE_CWD]: args.cwd,
        [ATTR.WEAVE_SOURCE]: args.source,
        [ATTR.WEAVE_PLUGIN_VERSION]: args.pluginVersion,
      },
    },
    parentCtx,
  );
}

export interface TurnSpanArgs {
  sessionId: string;
  turnNumber: number;
  prompt: string;
  pluginVersion: string;
  displayName?: string;
}

export function startTurnSpan(tracer: Tracer, parentSpan: Span, args: TurnSpanArgs): Span {
  const attrs: Record<string, string | number> = {
    [ATTR.OPERATION_NAME]: OP.INVOKE_AGENT,
    [ATTR.AGENT_NAME]: AGENT_NAME_CLAUDE_CODE,
    [ATTR.AGENT_VERSION]: args.pluginVersion,
    [ATTR.CONVERSATION_ID]: args.sessionId,
    [ATTR.WEAVE_TURN_NUMBER]: args.turnNumber,
    [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: args.prompt }]),
  };
  if (args.displayName) attrs[ATTR.WEAVE_DISPLAY_NAME] = args.displayName;

  return tracer.startSpan(
    `${OP.INVOKE_AGENT} ${AGENT_NAME_CLAUDE_CODE}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
    ctxWithParent(parentSpan),
  );
}

export interface ToolSpanArgs {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  displayName?: string;
}

export function startToolSpan(tracer: Tracer, parentSpan: Span, args: ToolSpanArgs): Span {
  const attrs: Record<string, string> = {
    [ATTR.OPERATION_NAME]: OP.EXECUTE_TOOL,
    [ATTR.TOOL_NAME]: args.toolName,
    [ATTR.TOOL_CALL_ID]: args.toolUseId,
    [ATTR.WEAVE_TOOL_USE_ID]: args.toolUseId,
    [ATTR.TOOL_CALL_ARGUMENTS]: jsonStr(args.toolInput),
  };
  if (args.displayName) attrs[ATTR.WEAVE_DISPLAY_NAME] = args.displayName;

  return tracer.startSpan(
    `${OP.EXECUTE_TOOL} ${args.toolName}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
    ctxWithParent(parentSpan),
  );
}

export interface SubagentSpanArgs {
  sessionId: string;
  subagentType: string;
  agentId: string;
  spawningToolCallId: string;
  pluginVersion: string;
}

export function startSubagentSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: SubagentSpanArgs,
): Span {
  return tracer.startSpan(
    `${OP.INVOKE_AGENT} ${args.subagentType}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR.OPERATION_NAME]: OP.INVOKE_AGENT,
        [ATTR.AGENT_NAME]: args.subagentType,
        [ATTR.AGENT_ID]: args.agentId,
        [ATTR.AGENT_VERSION]: args.pluginVersion,
        [ATTR.CONVERSATION_ID]: `${args.sessionId}:${args.agentId}`,
        [ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]: args.spawningToolCallId,
      },
    },
    ctxWithParent(parentSpan),
  );
}

export interface ChatSpanArgs {
  sessionId: string;
  model: string;
  startedAt: TimeInput;
  endedAt: TimeInput;
  usage: UsageSummary;
  reasoningTokens?: number;
  responseId?: string;
  finishReasons?: string[];
  inputMessages?: unknown;
  outputMessages?: unknown;
}

/**
 * Emit a chat span as a child of `parentSpan`. The span is started AND ended
 * inside this helper because chat spans are constructed from transcript data
 * after the fact — we never have an "open chat span" to track between calls.
 */
export function emitChatSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: ChatSpanArgs,
): void {
  const attrs: Record<string, string | number | boolean | string[]> = {
    [ATTR.OPERATION_NAME]: OP.CHAT,
    [ATTR.REQUEST_MODEL]: args.model,
    [ATTR.CONVERSATION_ID]: args.sessionId,
    [ATTR.USAGE_INPUT_TOKENS]: args.usage.input_tokens,
    [ATTR.USAGE_OUTPUT_TOKENS]: args.usage.output_tokens,
    [ATTR.OUTPUT_TYPE]: 'text',
  };
  const provider = providerFromModel(args.model);
  if (provider) attrs[ATTR.PROVIDER_NAME] = provider;
  if (args.usage.cache_read_input_tokens !== undefined) {
    attrs[ATTR.USAGE_CACHE_READ_INPUT_TOKENS] = args.usage.cache_read_input_tokens;
  }
  if (args.usage.cache_creation_input_tokens !== undefined) {
    attrs[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS] = args.usage.cache_creation_input_tokens;
  }
  if (args.reasoningTokens !== undefined && args.reasoningTokens > 0) {
    attrs[ATTR.USAGE_REASONING_TOKENS] = args.reasoningTokens;
  }
  if (args.responseId) {
    attrs[ATTR.RESPONSE_ID] = args.responseId;
  }
  if (args.finishReasons?.length) {
    attrs[ATTR.RESPONSE_FINISH_REASONS] = args.finishReasons;
  }
  if (args.inputMessages !== undefined) {
    attrs[ATTR.INPUT_MESSAGES] = jsonStr(args.inputMessages);
  }
  if (args.outputMessages !== undefined) {
    attrs[ATTR.OUTPUT_MESSAGES] = jsonStr(args.outputMessages);
  }

  const span = tracer.startSpan(
    `${OP.CHAT} ${args.model}`,
    { kind: SpanKind.CLIENT, attributes: attrs, startTime: args.startedAt },
    ctxWithParent(parentSpan),
  );
  span.end(args.endedAt);
}

/**
 * Walk a parsed list of per-message details and emit one chat span per
 * assistant message. `parent` is the turn-level (or subagent-level) span.
 */
export function emitChatSpansFromAssistantCalls(
  tracer: Tracer,
  parentSpan: Span,
  sessionId: string,
  calls: AssistantCallDetail[],
): void {
  for (const c of calls) {
    if (!c.model) continue;
    const startedAt = parseTimestamp(c.prevTimestamp) ?? parseTimestamp(c.timestamp) ?? new Date();
    const endedAt = parseTimestamp(c.timestamp) ?? new Date();
    emitChatSpan(tracer, parentSpan, {
      sessionId,
      model: c.model,
      startedAt,
      endedAt,
      usage: c.usage,
      reasoningTokens: c.reasoningTokens,
      responseId: c.responseId,
      finishReasons: c.finishReason ? [c.finishReason] : undefined,
      outputMessages: c.contentBlocks.length
        ? [{ role: 'assistant', content: assistantBlocksToText(c.contentBlocks), parts: c.contentBlocks }]
        : undefined,
    });
  }
}

function parseTimestamp(ts: string | undefined): Date | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function assistantBlocksToText(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = b['type'];
    if (type === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text'] as string);
    } else if (type === 'thinking' && typeof b['thinking'] === 'string') {
      // Don't fold thinking into visible text — left for future reasoning_content
      continue;
    }
  }
  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Span events
// ─────────────────────────────────────────────────────────────────────────────

export interface PermissionRequestEventArgs {
  suggestions?: unknown;
  timestamp: Date;
}

/** Added at PermissionRequest time. Records that the request happened. */
export function addPermissionRequestEvent(toolSpan: Span, args: PermissionRequestEventArgs): void {
  const attrs: Record<string, string> = {};
  if (args.suggestions !== undefined) {
    attrs[ATTR.EVT_PERMISSION_SUGGESTIONS] = jsonStr(args.suggestions);
  }
  toolSpan.addEvent(ATTR.EVT_PERMISSION_REQUEST, attrs, args.timestamp);
}

export interface PermissionResolvedEventArgs {
  approved: boolean;
  timestamp: Date;
}

/** Added at PostToolUse[Failure]. Records the request outcome. */
export function addPermissionResolvedEvent(toolSpan: Span, args: PermissionResolvedEventArgs): void {
  toolSpan.addEvent(
    ATTR.EVT_PERMISSION_RESOLVED,
    { [ATTR.EVT_PERMISSION_APPROVED]: args.approved },
    args.timestamp,
  );
}

export interface CompactionEventArgs {
  summary?: string;
  itemsBefore?: number;
  itemsAfter?: number;
  timestamp?: Date;
}

export function addCompactionEvent(sessionSpan: Span, args: CompactionEventArgs): void {
  const attrs: Record<string, string | number> = {};
  if (args.summary !== undefined) attrs[ATTR.EVT_COMPACTION_SUMMARY] = args.summary;
  if (args.itemsBefore !== undefined) attrs[ATTR.EVT_COMPACTION_ITEMS_BEFORE] = args.itemsBefore;
  if (args.itemsAfter !== undefined) attrs[ATTR.EVT_COMPACTION_ITEMS_AFTER] = args.itemsAfter;
  sessionSpan.addEvent(ATTR.EVT_COMPACTION, attrs, args.timestamp ?? new Date());
}

// ─────────────────────────────────────────────────────────────────────────────
// Display-name helpers
// ─────────────────────────────────────────────────────────────────────────────

function snippet(value: unknown, maxLen = 60): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}

export function toolDisplayName(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${toolName}: ${snippet(input['file_path'])}`;
    case 'Glob':
      return `Glob: ${snippet(input['pattern'])}`;
    case 'Grep':
      return `Grep: ${snippet(input['pattern'])}`;
    case 'Bash':
      return `Bash: ${snippet(input['command'])}`;
    case 'Agent':
      return `Agent: ${snippet(input['description'] ?? input['subagent_type'])}`;
    case 'WebFetch':
      return `WebFetch: ${snippet(input['url'])}`;
    case 'WebSearch':
      return `WebSearch: ${snippet(input['query'])}`;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return first ? `${toolName}: ${snippet(first)}` : toolName;
    }
  }
}

export function promptSnippet(prompt: string, maxLen = 60): string {
  return snippet(prompt, maxLen);
}
