// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// After the Weave SDK migration this module holds constants, formatting
// helpers, and thin span-shaping helpers typed against the `weave` SDK. All
// span construction/lifecycle lives in daemon.ts via
// `weave.startConversation/.startTurn/.startLLM/.startTool/.startSubagent`.

import type { Attributes } from '@opentelemetry/api';
import type { MessagePart, Tool, Turn, Usage } from 'weave';
import { isTextBlock, isThinkingBlock, isRedactedThinkingBlock, isToolUseBlock } from './parser.js';
import type { UsageSummary } from './parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Attribute keys
//
// Canonical `gen_ai.*` keys come from the OTel GenAI semantic conventions
// (https://github.com/open-telemetry/semantic-conventions-genai). `weave.*` keys are
// Claude-Code-specific extensions with no semconv equivalent. Compaction keys
// (`weave.compaction.*`) match the Weave Agents backend's semconv exactly -
// the backend extracts them into dedicated span columns.
// ─────────────────────────────────────────────────────────────────────────────

export const ATTR = {
  // GenAI semconv - classification
  OPERATION_NAME: 'gen_ai.operation.name',

  // GenAI semconv - agent
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',
  AGENT_VERSION: 'gen_ai.agent.version',
  CONVERSATION_ID: 'gen_ai.conversation.id',

  // GenAI semconv - model
  REQUEST_MODEL: 'gen_ai.request.model',
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
  OUTPUT_TYPE: 'gen_ai.output.type',

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

  // Integration identity - attributes the trace to the emitting integration
  // (this plugin) so the Weave Agents backend can group/filter by integration
  // alongside peers (weave-openclaw, the playground's `weave.source`). Distinct
  // from `gen_ai.agent.name`, which is user-overridable and changes per
  // subagent. These are non-semconv `weave.*` keys, so the backend routes them
  // into its queryable custom-attribute maps. Installed on the session's
  // conversation so the SDK copies them onto every span; `meta.*` keys (built
  // with WEAVE_INTEGRATION_META_PREFIX) carry free-form per-session context.
  WEAVE_INTEGRATION_NAME: 'weave.integration.name',
  WEAVE_INTEGRATION_VERSION: 'weave.integration.version',

  // Back-pointer from a subagent `invoke_agent` span to the parent agent's
  // `Agent` tool call that spawned it. Set on the inner `invoke_agent` span
  // so queries can correlate the subagent invocation with the spawning
  // tool_use_id without walking the span tree.
  WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID: 'weave.claude_code.subagent.spawning_tool_call_id',

  // Weave Agents backend - compaction (set as span attributes on the turn span;
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

/**
 * Default name for the top-level agent: the value shown in Weave's Agents
 * view and stamped as `gen_ai.agent.name` on every turn span. Users can
 * override it (settings `agent_name` / `WEAVE_AGENT_NAME`); this is the
 * fallback when neither is set.
 */
export const DEFAULT_AGENT_NAME = 'claude-code';

/**
 * Stable identifier for this integration, stamped as `weave.integration.name`
 * on every turn span. Unlike the agent name (`gen_ai.agent.name`), it is not
 * user-overridable and does not change for subagents, so it's a reliable
 * dimension for "which integration produced this trace" in the Weave Agents
 * backend.
 */
const INTEGRATION_NAME = 'weave-claude-code';

/**
 * Prefix for free-form integration metadata. Each entry of a session's
 * `integrationMeta` is stamped as `weave.integration.meta.<key>`, so new
 * fields (e.g. `claude_code_app_version`) need no new attribute constant.
 */
const WEAVE_INTEGRATION_META_PREFIX = 'weave.integration.meta.';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive `gen_ai.provider.name` from a model id. Returns undefined when the
 * routing layer is ambiguous - better to omit than guess.
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

/** Parse an ISO timestamp; returns undefined for missing or unparseable input. */
export function parseTimestamp(ts: string | undefined): Date | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/**
 * Build the per-session integration attributes. `version` is the plugin
 * version; `meta` is free-form per-session context flattened to
 * `weave.integration.meta.<key>` (falsy values skipped). Installed on the
 * session's conversation so the SDK stamps them onto every span the session
 * emits (turn root and all children).
 */
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

/**
 * Map Claude assistant content blocks to ordered `MessagePart`s for a chat
 * span's `gen_ai.output.messages`. Preserves transcript order so the model's
 * natural interleave (text -> tool_use -> text) is visible in the Weave UI.
 * text -> text part; thinking / redacted_thinking -> reasoning part; tool_use
 * -> tool_call part. Empty text/thinking blocks are skipped.
 */
export function contentBlocksToParts(blocks: unknown[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) {
      if (block.text.trim()) parts.push({ type: 'text', content: block.text });
    } else if (isThinkingBlock(block)) {
      if (block.thinking.trim()) parts.push({ type: 'reasoning', content: block.thinking });
    } else if (isRedactedThinkingBlock(block)) {
      // Reasoning withheld by safety filtering: the `data` blob is encrypted,
      // so surface a placeholder so the part stays in transcript order.
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

/**
 * Build a `weave.Usage` from Anthropic's per-call usage. OTel `inputTokens` is
 * the total prompt; Anthropic splits it into three disjoint fields (uncached +
 * cache_read + cache_creation), so sum them.
 * https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md
 * Cache and reasoning fields are set only when present so a call without them
 * doesn't emit zero-valued attributes.
 */
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

/** Added at PermissionRequest time. Records that the request happened. */
export function addPermissionRequestEvent(tool: Tool, args: PermissionRequestEventArgs): void {
  const attrs: Attributes = {};
  if (args.suggestions !== undefined) {
    attrs[ATTR.EVT_PERMISSION_SUGGESTIONS] = jsonStr(args.suggestions);
  }
  tool.addEvent(ATTR.EVT_PERMISSION_REQUEST, attrs, args.timestamp);
}

export interface PermissionResolvedEventArgs {
  approved: boolean;
  timestamp: Date;
}

/** Added at PostToolUse[Failure]. Records the request outcome. */
export function addPermissionResolvedEvent(tool: Tool, args: PermissionResolvedEventArgs): void {
  tool.addEvent(
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
 * to the turn span that's open when the compaction fires - or to the next
 * turn span, if compaction fires between turns.
 */
export function setCompactionAttrs(turn: Turn, attrs: CompactionAttrs): void {
  const out: Attributes = {};
  if (attrs.summary !== undefined) out[ATTR.COMPACTION_SUMMARY] = attrs.summary;
  if (attrs.itemsBefore !== undefined) out[ATTR.COMPACTION_ITEMS_BEFORE] = attrs.itemsBefore;
  if (attrs.itemsAfter !== undefined) out[ATTR.COMPACTION_ITEMS_AFTER] = attrs.itemsAfter;
  if (Object.keys(out).length) turn.setAttributes(out);
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
      const first = Object.values(input).find((v): v is string => typeof v === 'string');
      return first ? `${toolName}: ${snippet(first)}` : toolName;
    }
  }
}

export function promptSnippet(prompt: string, maxLen = 60): string {
  return snippet(prompt, maxLen);
}
