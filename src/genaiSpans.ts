// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Attribute-key constants and formatting helpers typed against the `weave` SDK.

import {
  Attributes,
  Baggage,
  Span,
  SpanKind,
  Tracer,
  Context,
  TimeInput,
  context as otelContext,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { MessagePart, Usage } from 'weave';
import { extractAssistantTextBlocks } from './parser.js';
import type { AssistantCallDetail } from './parser.js';
import { isTextBlock, isThinkingBlock, isRedactedThinkingBlock, isToolUseBlock } from './parser.js';
import type { UsageSummary } from './parser.js';

// Attribute keys: `gen_ai.*` from the OTel GenAI semconv
// (https://github.com/open-telemetry/semantic-conventions-genai); `weave.*`
// are Claude-Code-specific extensions the backend routes into its queryable
// custom-attribute maps (compaction keys get dedicated columns).

export const ATTR = {
  // GenAI semconv - classification
  OPERATION_NAME: 'gen_ai.operation.name',

  // GenAI semconv - agent
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',
  CONVERSATION_ID: 'gen_ai.conversation.id',

  // GenAI semconv - model
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',

  // GenAI semconv - usage
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',

  // GenAI semconv - messages
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',

  // GenAI semconv - errors
  ERROR_TYPE: 'error.type',

  // Weave extensions - claude_code per-turn metadata
  WEAVE_SESSION_ID: 'weave.claude_code.session.id',
  WEAVE_CWD: 'weave.claude_code.cwd',
  WEAVE_SOURCE: 'weave.claude_code.source',
  WEAVE_PLUGIN_VERSION: 'weave.claude_code.plugin.version',
  WEAVE_TURN_NUMBER: 'weave.claude_code.turn.number',
  WEAVE_TURN_TOOL_COUNT: 'weave.claude_code.turn.tool_count',
  WEAVE_ORPHAN_REASON: 'weave.claude_code.orphan_reason',
  WEAVE_DISPLAY_NAME: 'weave.claude_code.display_name',

  // Integration identity: unlike gen_ai.agent.name, not user-overridable and
  // never changes per subagent. Set on the conversation; propagated to every span.
  WEAVE_INTEGRATION_NAME: 'weave.integration.name',
  WEAVE_INTEGRATION_VERSION: 'weave.integration.version',

  // Back-pointer from a subagent's invoke_agent span to the tool_use_id of
  // the Agent call that spawned it (correlation without walking the tree).
  WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID: 'weave.claude_code.subagent.spawning_tool_call_id',

  // Weave Agents backend - compaction
  COMPACTION_SUMMARY: 'weave.compaction.summary',
  COMPACTION_ITEMS_BEFORE: 'weave.compaction.items_before',
  COMPACTION_ITEMS_AFTER: 'weave.compaction.items_after',

  // Permission span events
  EVT_PERMISSION_REQUEST: 'weave.permission_request',
  EVT_PERMISSION_RESOLVED: 'weave.permission_resolved',
  EVT_PERMISSION_APPROVED: 'weave.permission.approved',
  EVT_PERMISSION_SUGGESTIONS: 'weave.permission.suggestions',
  // Legacy keys used only by the hand-rolled builders below; deleted next PR.
  PROVIDER_NAME: 'gen_ai.provider.name',
  AGENT_DESCRIPTION: 'gen_ai.agent.description',
  AGENT_VERSION: 'gen_ai.agent.version',
  REQUEST_MODEL: 'gen_ai.request.model',
  USAGE_REASONING_TOKENS: 'gen_ai.usage.reasoning_tokens',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT: 'gen_ai.tool.call.result',
  OUTPUT_TYPE: 'gen_ai.output.type',
} as const;

/** Top-level `gen_ai.agent.name` fallback; users override via settings
 *  `agent_name` / `WEAVE_AGENT_NAME`. */
export const DEFAULT_AGENT_NAME = 'claude-code';

export const INTEGRATION_NAME = 'weave-claude-code';

/** Free-form integration metadata prefix: new fields (e.g.
 *  `claude_code_app_version`) need no new attribute constant. */
export const WEAVE_INTEGRATION_META_PREFIX = 'weave.integration.meta.';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Derive `gen_ai.provider.name` from a model id; undefined when the routing
 *  layer is ambiguous - better to omit than guess. */
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

/** `gen_ai.output.messages` JSON for plain assistant text(s), the shape used on
 *  turn and subagent `invoke_agent` spans (chat spans carry parts instead). */
export function assistantOutputMessages(texts: string[]): string {
  return jsonStr(texts.map((content) => ({ role: 'assistant', content })));
}

/** Parse an ISO timestamp; returns undefined for missing or unparseable input. */
export function parseTimestamp(ts: string | undefined): Date | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/** Per-session integration attributes; `meta` flattens to
 *  `weave.integration.meta.<key>` (falsy values skipped). */
export function buildIntegrationAttrs(args: {
  version: string;
  meta?: Record<string, string | undefined>;
}): Attributes {
  const attrs: Attributes = {
    [ATTR.WEAVE_INTEGRATION_NAME]: INTEGRATION_NAME,
    [ATTR.WEAVE_INTEGRATION_VERSION]: args.version,
  };
  if (args.meta) {
    for (const [key, value] of Object.entries(args.meta)) {
      if (value) attrs[`${WEAVE_INTEGRATION_META_PREFIX}${key}`] = value;
    }
  }
  return attrs;
}

/** Map assistant content blocks to ordered `MessagePart`s so the model's
 *  natural interleave survives into a chat span's `gen_ai.output.messages`. */
export function contentBlocksToParts(blocks: unknown[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) {
      if (block.text.trim()) parts.push({ type: 'text', content: block.text });
    } else if (isThinkingBlock(block)) {
      if (block.thinking.trim()) parts.push({ type: 'reasoning', content: block.thinking });
    } else if (isRedactedThinkingBlock(block)) {
      // Encrypted reasoning: a placeholder keeps its slot in transcript order.
      parts.push({ type: 'reasoning', content: '[redacted]' });
    } else if (isToolUseBlock(block)) {
      parts.push({
        type: 'tool_call',
        toolCallId: block.id,
        toolName: block.name,
        arguments: jsonStr(block.input),
      });
    }
  }
  return parts;
}

/** Anthropic usage → `weave.Usage`. OTel inputTokens is the TOTAL prompt, so sum
 *  Anthropic's three disjoint fields (uncached + cache_read + cache_creation).
 *  https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md */
export function buildUsage(usage: UsageSummary, reasoningTokens?: number): Usage {
  const out: Usage = {
    inputTokens:
      usage.input_tokens
      + (usage.cache_read_input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
  if (usage.cache_read_input_tokens !== undefined) {
    out.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    out.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (reasoningTokens !== undefined && reasoningTokens > 0) {
    out.reasoningTokens = reasoningTokens;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Span events
// ─────────────────────────────────────────────────────────────────────────────

export interface PermissionRequestEventArgs {
  suggestions?: unknown;
  timestamp: Date;
}

/** Added at PermissionRequest time. */
export function addPermissionRequestEvent(toolSpan: Span, args: PermissionRequestEventArgs): void {
  const attrs: Attributes = {};
  if (args.suggestions !== undefined) {
    attrs[ATTR.EVT_PERMISSION_SUGGESTIONS] = jsonStr(args.suggestions);
  }
  toolSpan.addEvent(ATTR.EVT_PERMISSION_REQUEST, attrs, args.timestamp);
}

export interface PermissionResolvedEventArgs {
  approved: boolean;
  timestamp: Date;
}

/** Added at PostToolUse[Failure] with the request outcome. */
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

/** Set `weave.compaction.*` on a turn (backend renders a context_compacted card).
 *  Session-level, but with no session span it rides the open (or next) turn. */
export function setCompactionAttrs(turnSpan: Span, attrs: CompactionAttrs): void {
  if (attrs.summary !== undefined) turnSpan.setAttribute(ATTR.COMPACTION_SUMMARY, attrs.summary);
  if (attrs.itemsBefore !== undefined) turnSpan.setAttribute(ATTR.COMPACTION_ITEMS_BEFORE, attrs.itemsBefore);
  if (attrs.itemsAfter !== undefined) turnSpan.setAttribute(ATTR.COMPACTION_ITEMS_AFTER, attrs.itemsAfter);
}

// ─────────────────────────────────────────────────────────────────────────────
// Display-name helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Single-line preview of a value: whitespace collapsed, truncated with `…`. */
export function snippet(value: unknown, maxLen = 60): string {
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
      const first = Object.values(input).find((v): v is string => typeof v === 'string');
      return first ? `${toolName}: ${snippet(first)}` : toolName;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY: baggage plumbing and hand-rolled span builders, still used by
// daemon.ts; deleted once the SDK swap (next PRs in this stack) lands.
// ─────────────────────────────────────────────────────────────────────────────

/** Common prefix for all integration-identity attributes. The span processor
 *  copies baggage entries under this prefix onto each span. */
export const WEAVE_INTEGRATION_PREFIX = 'weave.integration.';

/**
 * Build the per-session integration Baggage. `name` is the fixed integration
 * id; `version` is the plugin version; `meta` is free-form per-session context
 * flattened to `weave.integration.meta.<key>` (falsy values skipped). The
 * daemon activates this baggage for each session event so
 * `IntegrationBaggageSpanProcessor` stamps it onto every span the event emits.
 */
export function createIntegrationBaggage(args: {
  version: string;
  meta?: Record<string, string | undefined>;
}): Baggage {
  const entries: Record<string, { value: string }> = {
    [ATTR.WEAVE_INTEGRATION_NAME]: { value: INTEGRATION_NAME },
    [ATTR.WEAVE_INTEGRATION_VERSION]: { value: args.version },
  };
  if (args.meta) {
    for (const [key, value] of Object.entries(args.meta)) {
      if (value) entries[`${WEAVE_INTEGRATION_META_PREFIX}${key}`] = { value };
    }
  }
  return propagation.createBaggage(entries);
}

/**
 * Copies `weave.integration.*` baggage entries off the active context onto each
 * span at start. This is how integration identity reaches every span (turn
 * root and all children) from a single per-session baggage attribution, instead
 * of stamping each builder. Runs at `onStart` because attributes set after a
 * span ends are dropped; the copy is a one-time snapshot (baggage is static per
 * session). Baggage itself is never exported, only the copied attributes.
 */
export class IntegrationBaggageSpanProcessor implements SpanProcessor {
  onStart(span: SdkSpan, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext);
    if (!baggage) return;
    for (const [key, entry] of baggage.getAllEntries()) {
      if (key.startsWith(WEAVE_INTEGRATION_PREFIX)) {
        span.setAttribute(key, entry.value);
      }
    }
  }
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// Values for `gen_ai.operation.name`. `invoke_agent`, `chat`, and
// `execute_tool` are well-known values from the OTel GenAI semantic conventions
// (https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md#gen-ai-operation-name);
// the spec mandates the well-known value whenever one applies. `assistant_text`
// and `thinking` have no well-known equivalent, so they're spec-permitted custom
// values — the model's natural-language output and its private reasoning, each
// emitted as a `chat` child so they interleave with sibling `execute_tool` spans.
export const OP = {
  INVOKE_AGENT: 'invoke_agent',
  CHAT: 'chat',
  EXECUTE_TOOL: 'execute_tool',
  ASSISTANT_TEXT: 'assistant_text',
  THINKING: 'thinking',
} as const;

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

type TurnSpanArgs = {
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
  /** Top-level agent name; becomes the second word of the span name and is
   *  stamped as `gen_ai.agent.name`. Defaults to `DEFAULT_AGENT_NAME`;
   *  the daemon resolves any user override before calling. */
  agentName: string;
  requestModel?: string;
  displayName?: string;
  /** Loaded instruction-file contents (global/project CLAUDE.md, .claude/rules,
   *  @-imports) in load order, stamped as `gen_ai.system_instructions` (one text
   *  part per file) when non-empty. */
  systemInstructions?: string[];
};

/**
 * Start a turn span. Each turn is the root of its own trace; the Weave Agents
 * backend stitches turns into a conversation via `gen_ai.conversation.id`.
 * Session-level metadata (cwd, source, plugin.version) is stamped on every
 * turn span so it's queryable without a separate session-level span.
 */
export function startTurnSpan(tracer: Tracer, args: TurnSpanArgs): Span {
  const attrs: Attributes = {
    [ATTR.OPERATION_NAME]: OP.INVOKE_AGENT,
    [ATTR.AGENT_NAME]: args.agentName,
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
  if (args.systemInstructions?.length) {
    attrs[ATTR.SYSTEM_INSTRUCTIONS] = jsonStr(
      args.systemInstructions.map((content) => ({ type: 'text', content })),
    );
  }

  // `weave.integration.*` is not set here — it rides the active session baggage
  // and is stamped on this span (and all children) by
  // IntegrationBaggageSpanProcessor at onStart.
  //
  // No parent span in context — turn spans are roots, one trace per turn. (The
  // active context carries integration baggage but no span, so this stays a
  // root.)
  return tracer.startSpan(
    `${OP.INVOKE_AGENT} ${args.agentName}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
  );
}

type InvokeAgentSpanArgs = {
  /** Agent type label — becomes the second word of the span name and is
   *  stamped as `gen_ai.agent.name`. For Claude Code subagents this is the
   *  `subagent_type` from the spawning `Agent` tool call (e.g. "Explore",
   *  "general-purpose"). */
  agentType: string;
  /** Stitching key inherited from the parent turn span. */
  conversationId: string;
  /** Plugin version, stamped as `gen_ai.agent.version` for parity with the
   *  outer turn span. */
  pluginVersion: string;
  /** Initial input passed to the agent — typically the firing prompt from
   *  the parent agent's `Agent` tool call. Stamped as
   *  `gen_ai.input.messages`. */
  inputMessages?: unknown;
  /** tool_use_id of the parent's `Agent` tool call. Stamped as a
   *  back-pointer attribute so queries can correlate the subagent
   *  invocation with the spawning tool call. */
  spawningToolCallId?: string;
  displayName?: string;
};

/**
 * Start a nested `invoke_agent` span — used for subagents Claude Code
 * dispatches via the `Agent` tool. Child of the parent turn (or, for nested
 * subagent calls, of the spawning subagent's invoke_agent span). Subagent
 * `chat` spans and any tool calls the subagent runs parent under this span,
 * which the Weave Agents chat view renders as an `agent_start` lifecycle
 * marker followed by the subagent's own assistant text.
 */
export function startInvokeAgentSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: InvokeAgentSpanArgs,
): Span {
  const attrs: Attributes = {
    [ATTR.OPERATION_NAME]: OP.INVOKE_AGENT,
    [ATTR.AGENT_NAME]: args.agentType,
    [ATTR.AGENT_VERSION]: args.pluginVersion,
    [ATTR.CONVERSATION_ID]: args.conversationId,
  };
  if (args.inputMessages !== undefined) {
    attrs[ATTR.INPUT_MESSAGES] = jsonStr(args.inputMessages);
  }
  if (args.spawningToolCallId) {
    attrs[ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID] = args.spawningToolCallId;
  }
  if (args.displayName) attrs[ATTR.WEAVE_DISPLAY_NAME] = args.displayName;

  return tracer.startSpan(
    `${OP.INVOKE_AGENT} ${args.agentType}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
    ctxWithParent(parentSpan),
  );
}

type ToolSpanArgs = {
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  /** Stitching key — same as the enclosing turn's `gen_ai.conversation.id`. */
  conversationId: string;
  displayName?: string;
};

export function startToolSpan(tracer: Tracer, parentSpan: Span, args: ToolSpanArgs): Span {
  const attrs: Attributes = {
    [ATTR.OPERATION_NAME]: OP.EXECUTE_TOOL,
    [ATTR.TOOL_NAME]: args.toolName,
    [ATTR.TOOL_CALL_ID]: args.toolUseId,
    [ATTR.TOOL_CALL_ARGUMENTS]: jsonStr(args.toolInput),
    [ATTR.CONVERSATION_ID]: args.conversationId,
  };
  if (args.displayName) attrs[ATTR.WEAVE_DISPLAY_NAME] = args.displayName;

  return tracer.startSpan(
    `${OP.EXECUTE_TOOL} ${args.toolName}`,
    { kind: SpanKind.INTERNAL, attributes: attrs },
    ctxWithParent(parentSpan),
  );
}

type ChatSpanArgs = {
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
};

/**
 * Emit a chat span as a child of `parentSpan`. The span is started AND ended
 * inside this helper. Used by code paths that construct the chat span from
 * transcript data after the fact (SubagentStop, TeammateIdle). For the main
 * agent path — where the chat span parents the assistant_text / thinking /
 * execute_tool spans that occur during the API call — use `startChatSpan` /
 * `finalizeChatSpan` instead.
 */
export function emitChatSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: ChatSpanArgs,
): void {
  const span = startChatSpan(tracer, parentSpan, {
    conversationId: args.conversationId,
    model: args.model,
    startedAt: args.startedAt,
  });
  finalizeChatSpan(span, {
    usage: args.usage,
    reasoningTokens: args.reasoningTokens,
    responseId: args.responseId,
    finishReasons: args.finishReasons,
    inputMessages: args.inputMessages,
    outputMessages: args.outputMessages,
    endedAt: args.endedAt,
  });
}

type StartChatSpanArgs = {
  conversationId: string;
  model?: string;
  startedAt: TimeInput;
};

/**
 * Start a chat span (open). Caller is responsible for emitting any child
 * spans and calling `finalizeChatSpan` with the usage data and end time.
 *
 * `model` is optional at open time — Anthropic returns it in the response, so
 * it may not be known until the assistant message is parsed. When omitted,
 * the span name uses a placeholder; `finalizeChatSpan` overwrites the name
 * with the actual model once it's known.
 */
export function startChatSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: StartChatSpanArgs,
): Span {
  const attrs: Attributes = {
    [ATTR.OPERATION_NAME]: OP.CHAT,
    [ATTR.CONVERSATION_ID]: args.conversationId,
    [ATTR.OUTPUT_TYPE]: 'text',
  };
  if (args.model) {
    attrs[ATTR.REQUEST_MODEL] = args.model;
    const provider = providerFromModel(args.model);
    if (provider) attrs[ATTR.PROVIDER_NAME] = provider;
  }
  const name = args.model ? `${OP.CHAT} ${args.model}` : OP.CHAT;
  return tracer.startSpan(
    name,
    { kind: SpanKind.CLIENT, attributes: attrs, startTime: args.startedAt },
    ctxWithParent(parentSpan),
  );
}

type FinalizeChatSpanArgs = {
  usage: UsageSummary;
  reasoningTokens?: number;
  responseId?: string;
  finishReasons?: string[];
  inputMessages?: unknown;
  outputMessages?: unknown;
  /** If set and the span was opened without a model, attaches the model
   *  attribute and updates the span name. */
  model?: string;
  endedAt?: TimeInput;
};

/** Stamp usage / response attrs on an open chat span and end it. */
export function finalizeChatSpan(span: Span, args: FinalizeChatSpanArgs): void {
  // OTel `input_tokens` is the total prompt; Anthropic splits it into three
  // disjoint fields (uncached + cache_read + cache_creation), so sum them.
  // https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md
  const totalInputTokens =
    args.usage.input_tokens
    + (args.usage.cache_read_input_tokens ?? 0)
    + (args.usage.cache_creation_input_tokens ?? 0);

  span.setAttribute(ATTR.USAGE_INPUT_TOKENS, totalInputTokens);
  span.setAttribute(ATTR.USAGE_OUTPUT_TOKENS, args.usage.output_tokens);
  if (args.usage.cache_read_input_tokens !== undefined) {
    span.setAttribute(ATTR.USAGE_CACHE_READ_INPUT_TOKENS, args.usage.cache_read_input_tokens);
  }
  if (args.usage.cache_creation_input_tokens !== undefined) {
    span.setAttribute(ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS, args.usage.cache_creation_input_tokens);
  }
  if (args.reasoningTokens !== undefined && args.reasoningTokens > 0) {
    span.setAttribute(ATTR.USAGE_REASONING_TOKENS, args.reasoningTokens);
  }
  if (args.responseId) {
    span.setAttribute(ATTR.RESPONSE_ID, args.responseId);
  }
  if (args.finishReasons?.length) {
    span.setAttribute(ATTR.RESPONSE_FINISH_REASONS, args.finishReasons);
  }
  if (args.inputMessages !== undefined) {
    span.setAttribute(ATTR.INPUT_MESSAGES, jsonStr(args.inputMessages));
  }
  if (args.outputMessages !== undefined) {
    span.setAttribute(ATTR.OUTPUT_MESSAGES, jsonStr(args.outputMessages));
  }
  if (args.model) {
    span.setAttribute(ATTR.REQUEST_MODEL, args.model);
    const provider = providerFromModel(args.model);
    if (provider) span.setAttribute(ATTR.PROVIDER_NAME, provider);
    span.updateName(`${OP.CHAT} ${args.model}`);
  }
  span.end(args.endedAt);
}

type AssistantTextSpanArgs = {
  conversationId: string;
  text: string;
  startedAt?: TimeInput;
  endedAt?: TimeInput;
};

/**
 * Emit a span representing one text content block from an assistant message.
 * Renders in the trace tree between sibling `execute_tool` spans so the
 * model's natural interleave (say something → call tool → say something →
 * call tool) is visible. Carries the text on `gen_ai.output.messages` so
 * Weave's UI shows the content; no token attributes — tokens live on the
 * parent chat span.
 */
export function emitAssistantTextSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: AssistantTextSpanArgs,
): void {
  const attrs: Attributes = {
    [ATTR.OPERATION_NAME]: OP.ASSISTANT_TEXT,
    [ATTR.CONVERSATION_ID]: args.conversationId,
    [ATTR.OUTPUT_MESSAGES]: jsonStr([
      { role: 'assistant', parts: [{ type: 'text', content: args.text }] },
    ]),
  };
  const span = tracer.startSpan(
    OP.ASSISTANT_TEXT,
    { kind: SpanKind.INTERNAL, attributes: attrs, startTime: args.startedAt },
    ctxWithParent(parentSpan),
  );
  span.end(args.endedAt ?? args.startedAt);
}

type ThinkingSpanArgs = {
  conversationId: string;
  text: string;
  startedAt?: TimeInput;
  endedAt?: TimeInput;
};

/**
 * Emit a span representing one thinking content block. Like
 * `emitAssistantTextSpan` but for `{type: 'thinking'}` blocks — Claude's
 * private reasoning surfaced in its content stream. Kept distinct so callers
 * can hide thinking spans in the UI without hiding ordinary assistant text.
 */
export function emitThinkingSpan(
  tracer: Tracer,
  parentSpan: Span,
  args: ThinkingSpanArgs,
): void {
  const attrs: Attributes = {
    [ATTR.OPERATION_NAME]: OP.THINKING,
    [ATTR.CONVERSATION_ID]: args.conversationId,
    [ATTR.OUTPUT_MESSAGES]: jsonStr([
      { role: 'assistant', parts: [{ type: 'thinking', content: args.text }] },
    ]),
  };
  const span = tracer.startSpan(
    OP.THINKING,
    { kind: SpanKind.INTERNAL, attributes: attrs, startTime: args.startedAt },
    ctxWithParent(parentSpan),
  );
  span.end(args.endedAt ?? args.startedAt);
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


function assistantBlocksToText(blocks: unknown[]): string {
  return extractAssistantTextBlocks(blocks).join('\n');
}

export function promptSnippet(prompt: string, maxLen = 60): string {
  return snippet(prompt, maxLen);
}
