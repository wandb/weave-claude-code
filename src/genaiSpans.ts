// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import {
  Span,
  SpanKind,
  Tracer,
  Context,
  TimeInput,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { extractAssistantTextBlocks } from './parser.js';
import type { AssistantCallDetail, UsageSummary } from './parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Attribute keys
//
// Canonical `gen_ai.*` keys come from the OTel GenAI semantic conventions
// (https://opentelemetry.io/docs/specs/semconv/gen-ai/). `weave.*` keys are
// Claude-Code-specific extensions with no semconv equivalent. Compaction keys
// (`weave.compaction.*`) match the Weave Agents backend's semconv exactly —
// the backend extracts them into dedicated span columns.
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

  // Weave extensions — claude_code per-turn metadata
  WEAVE_SESSION_ID: 'weave.claude_code.session.id',
  WEAVE_CWD: 'weave.claude_code.cwd',
  WEAVE_SOURCE: 'weave.claude_code.source',
  WEAVE_PLUGIN_VERSION: 'weave.claude_code.plugin.version',
  WEAVE_TURN_NUMBER: 'weave.claude_code.turn.number',
  WEAVE_TURN_TOOL_COUNT: 'weave.claude_code.turn.tool_count',
  WEAVE_ORPHAN_REASON: 'weave.claude_code.orphan_reason',
  WEAVE_DISPLAY_NAME: 'weave.claude_code.display_name',

  // Weave Agents backend — compaction (set as span attributes on the turn span;
  // the backend extracts these into dedicated columns)
  COMPACTION_SUMMARY: 'weave.compaction.summary',
  COMPACTION_ITEMS_BEFORE: 'weave.compaction.items_before',
  COMPACTION_ITEMS_AFTER: 'weave.compaction.items_after',

  // Permission span events
  EVT_PERMISSION_REQUEST: 'weave.permission_request',
  EVT_PERMISSION_RESOLVED: 'weave.permission_resolved',
  EVT_PERMISSION_APPROVED: 'weave.permission.approved',
  EVT_PERMISSION_SUGGESTIONS: 'weave.permission.suggestions',
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

/**
 * Context carrying `parent` as the active span for child-span creation.
 * Builds on `context.active()` (not `ROOT_CONTEXT`) so baggage on the active
 * context propagates to children — relevant if we ever wire baggage for
 * cross-process trace continuity.
 */
export function ctxWithParent(parent: Span): Context {
  return trace.setSpan(otelContext.active(), parent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Span builders
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnSpanArgs {
  /** Current process's Claude Code session id — stamped on the span as a
   *  debug breadcrumb (`weave.claude_code.session.id`). Per resume, this
   *  changes; the conversation id does not. */
  sessionId: string;
  /** Stitching key for the multi-turn conversation. For resumed sessions,
   *  this is the root ancestor's session id (so turns from before and after
   *  resume share `gen_ai.conversation.id`). For fresh sessions, equals
   *  `sessionId`. */
  conversationId: string;
  turnNumber: number;
  prompt: string;
  cwd: string;
  source: string;
  pluginVersion: string;
  requestModel?: string;
  displayName?: string;
}

/**
 * Start a turn span. Each turn is the root of its own trace; the Weave Agents
 * backend stitches turns into a conversation via `gen_ai.conversation.id`.
 * Session-level metadata (cwd, source, plugin.version) is stamped on every
 * turn span so it's queryable without a separate session-level span.
 */
export function startTurnSpan(tracer: Tracer, args: TurnSpanArgs): Span {
  const attrs: Record<string, string | number> = {
    [ATTR.OPERATION_NAME]: OP.INVOKE_AGENT,
    [ATTR.AGENT_NAME]: AGENT_NAME_CLAUDE_CODE,
    [ATTR.AGENT_VERSION]: args.pluginVersion,
    [ATTR.CONVERSATION_ID]: args.conversationId,
    [ATTR.WEAVE_SESSION_ID]: args.sessionId,
    [ATTR.WEAVE_CWD]: args.cwd,
    [ATTR.WEAVE_SOURCE]: args.source,
    [ATTR.WEAVE_PLUGIN_VERSION]: args.pluginVersion,
    [ATTR.WEAVE_TURN_NUMBER]: args.turnNumber,
    [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: args.prompt }]),
  };
  if (args.requestModel) attrs[ATTR.REQUEST_MODEL] = args.requestModel;
  if (args.displayName) attrs[ATTR.WEAVE_DISPLAY_NAME] = args.displayName;

  // No parent context — turn spans are roots, one trace per turn.
  return tracer.startSpan(
    `${OP.INVOKE_AGENT} ${AGENT_NAME_CLAUDE_CODE}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
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
    [ATTR.TOOL_CALL_ARGUMENTS]: jsonStr(args.toolInput),
  };
  if (args.displayName) attrs[ATTR.WEAVE_DISPLAY_NAME] = args.displayName;

  return tracer.startSpan(
    `${OP.EXECUTE_TOOL} ${args.toolName}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
    ctxWithParent(parentSpan),
  );
}

export interface ChatSpanArgs {
  /** Stitching key — same value as the parent turn span's
   *  `gen_ai.conversation.id`. For subagent chats this is suffixed with
   *  `:${agent_id}` upstream so the subagent's calls form their own
   *  conversation under the spawning tool span. */
  conversationId: string;
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
    [ATTR.CONVERSATION_ID]: args.conversationId,
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
 * assistant message. `parentSpan` is the turn-level span (for the main agent)
 * or the spawning Agent tool span (for a subagent).
 */
export function emitChatSpansFromAssistantCalls(
  tracer: Tracer,
  parentSpan: Span,
  conversationId: string,
  calls: AssistantCallDetail[],
): void {
  for (const c of calls) {
    if (!c.model) continue;
    const startedAt = parseTimestamp(c.prevTimestamp) ?? parseTimestamp(c.timestamp) ?? new Date();
    const endedAt = parseTimestamp(c.timestamp) ?? new Date();
    emitChatSpan(tracer, parentSpan, {
      conversationId,
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
  return extractAssistantTextBlocks(blocks).join('\n');
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

export interface CompactionAttrs {
  summary?: string;
  itemsBefore?: number;
  itemsAfter?: number;
}

/**
 * Stamp `weave.compaction.*` attributes onto a turn span. The Weave Agents
 * backend extracts these into dedicated columns (`compaction_summary`,
 * `compaction_items_before`, `compaction_items_after`) and renders a
 * "context_compacted" card in the chat view.
 *
 * Compaction is a session-level event, but with no session span it attaches
 * to the turn span that's open when the compaction fires — or to the next
 * turn span, if compaction fires between turns.
 */
export function setCompactionAttrs(turnSpan: Span, attrs: CompactionAttrs): void {
  if (attrs.summary !== undefined) turnSpan.setAttribute(ATTR.COMPACTION_SUMMARY, attrs.summary);
  if (attrs.itemsBefore !== undefined) turnSpan.setAttribute(ATTR.COMPACTION_ITEMS_BEFORE, attrs.itemsBefore);
  if (attrs.itemsAfter !== undefined) turnSpan.setAttribute(ATTR.COMPACTION_ITEMS_AFTER, attrs.itemsAfter);
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
