// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// After the Weave SDK migration, this module is just constants and
// formatting helpers. All span construction lives in daemon.ts via
// `weave.startSession/.startTurn/.startTool/.startLLM/.startSubagent`.

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

  // Back-pointer from a subagent `invoke_agent` span to the parent agent's
  // `Agent` tool call that spawned it. Set on the inner `invoke_agent` span
  // so queries can correlate the subagent invocation with the spawning
  // tool_use_id without walking the span tree.
  WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID: 'weave.claude_code.subagent.spawning_tool_call_id',

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
