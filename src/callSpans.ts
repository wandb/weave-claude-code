// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { Attributes } from '@opentelemetry/api';
import type { SubAgent, Tool } from 'weave';
import { VERSION } from './setup.js';
import {
  ATTR,
  assistantOutputMessages,
  jsonStr,
  toolDisplayName,
} from './genaiSpans.js';
import type { SpanParent } from './genaiSpans.js';

export type CallOutcome =
  | { kind: 'success'; value: unknown }
  | { kind: 'failure'; error: unknown };

type CallScope = {
  /** `undefined` is the single foreground legacy stream; a later legacy
   * prompt is a hard boundary because the protocol supplies no prompt id. */
  promptId?: string;
};

type ToolCall = CallScope & {
  kind: 'tool';
  span: Tool;
};

/** Agent completes only after both its tool result and a transcript snapshot. */
type AgentPhase =
  | { kind: 'running' }
  | { kind: 'awaiting-post' }
  | { kind: 'awaiting-stop'; outcome: CallOutcome };

export type AgentCall = CallScope & {
  kind: 'agent';
  span: SubAgent;
  toolUseId?: string;
  agentType: string;
  prompt: string;
  agentId?: string;
  phase: AgentPhase;
};

type OpenCall = ToolCall | AgentCall;

/** One call registry, indexed by the identities exposed by Claude's hooks. */
export type CallState = {
  byToolUseId: Map<string, OpenCall>;
  byAgentId: Map<string, AgentCall>;
  /** Prevent duplicate or delayed hooks from reopening calls while this
   * reconstructed session state remains live. */
  toolUseTombstones: Set<string>;
  agentTombstones: Set<string>;
};

export function newCallState(): CallState {
  return {
    byToolUseId: new Map(),
    byAgentId: new Map(),
    toolUseTombstones: new Set(),
    agentTombstones: new Set(),
  };
}

/** Normal agents appear in both indexes; return every live call once. */
export function openCalls(state: CallState): OpenCall[] {
  return [...new Set([...state.byToolUseId.values(), ...state.byAgentId.values()])];
}

type BeginCallArgs = CallScope & {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

/** Open the span represented by PreToolUse. Agent is the only special tool:
 * its invoke-agent span becomes the parent of later child hooks. */
export function beginCall(
  state: CallState,
  parent: SpanParent,
  args: BeginCallArgs,
): OpenCall | undefined {
  if (state.byToolUseId.has(args.toolUseId)
    || state.toolUseTombstones.has(args.toolUseId)) return undefined;

  const agentType = args.toolInput['subagent_type'];
  let call: OpenCall;
  if (args.toolName === 'Agent' && typeof agentType === 'string') {
    const prompt = typeof args.toolInput['prompt'] === 'string' ? args.toolInput['prompt'] : '';
    call = {
      kind: 'agent',
      span: startAgentSpan(parent, agentType, prompt),
      toolUseId: args.toolUseId,
      agentType,
      prompt,
      promptId: args.promptId,
      phase: { kind: 'running' },
    };
  } else {
    const span = parent.startTool({
      name: args.toolName,
      args: jsonStr(args.toolInput),
      toolCallId: args.toolUseId,
    });
    const attributes: Attributes = {
      [ATTR.WEAVE_DISPLAY_NAME]: toolDisplayName(args.toolName, args.toolInput),
    };
    if ('name' in parent && typeof parent.name === 'string') {
      attributes[ATTR.AGENT_NAME] = parent.name;
    }
    span.setAttributes(attributes);
    call = { kind: 'tool', span, promptId: args.promptId };
  }

  state.byToolUseId.set(args.toolUseId, call);
  return call;
}

function startAgentSpan(parent: SpanParent, agentType: string, prompt: string): SubAgent {
  const span = parent.startSubagent({ name: agentType, agentVersion: VERSION });
  if (prompt) {
    span.setAttributes({ [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: prompt }]) });
  }
  return span;
}

type RecoverAgentArgs = CallScope & {
  agentId: string;
  agentType: string;
  prompt: string;
  event: 'SubagentStart' | 'SubagentStop';
};

/** Recreate an Agent marker when a lifecycle hook is first after restart. */
export function recoverAgentCall(
  state: CallState,
  parent: SpanParent,
  args: RecoverAgentArgs,
): AgentCall {
  const span = startAgentSpan(parent, args.agentType, args.prompt);
  span.setAttributes({ [ATTR.WEAVE_DISPLAY_NAME]: `Agent: ${args.agentType}` });
  span.record({ agentId: args.agentId });
  const call: AgentCall = {
    kind: 'agent',
    span,
    agentType: args.agentType,
    prompt: args.prompt,
    promptId: args.promptId,
    agentId: args.agentId,
    phase: args.event === 'SubagentStop' ? { kind: 'awaiting-post' } : { kind: 'running' },
  };
  state.byAgentId.set(args.agentId, call);
  return call;
}

export function backfillAgentPrompt(call: AgentCall, prompt: string): void {
  if (call.prompt.trim() || !prompt.trim()) return;
  call.prompt = prompt;
  call.span.setAttributes({
    [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: prompt }]),
  });
}

/** Join an exact terminal Agent event to one lifecycle-only recovery. */
export function settleRecoveredAgent(
  state: CallState,
  args: CallScope & {
    toolUseId: string;
    agentType: string;
    prompt: string;
    ownerAgentId?: string;
  },
  outcome: CallOutcome,
): 'settled' | 'missing' | 'ambiguous' {
  const candidates = [...state.byAgentId.values()].filter(call =>
    call.toolUseId === undefined
    && call.agentType === args.agentType
    && call.promptId === args.promptId
    && call.agentId !== args.ownerAgentId);
  const exact = matchingPrompt(candidates, args.prompt);
  const matches = exact.length ? exact : candidates.filter(call => !call.prompt.trim());
  if (matches.length !== 1) {
    if (matches.length === 0) return 'missing';
    state.toolUseTombstones.add(args.toolUseId);
    return 'ambiguous';
  }

  const [call] = matches;
  backfillAgentPrompt(call, args.prompt);
  state.toolUseTombstones.add(args.toolUseId);
  if (call.phase.kind === 'running') {
    call.phase = { kind: 'awaiting-stop', outcome };
  } else if (call.phase.kind === 'awaiting-post') {
    finishAgentSpan(call.span, outcome);
    completeAgent(state, call);
  }
  return 'settled';
}

/** Apply the exact tool_use_id terminal event once. */
export function settleCall(
  state: CallState,
  toolUseId: string,
  outcome: CallOutcome,
): void {
  const call = state.byToolUseId.get(toolUseId);
  if (!call) return;

  if (call.kind === 'tool') {
    finishToolCall(call, outcome);
    completeCall(state, toolUseId, call);
    return;
  }
  if (call.phase.kind === 'running') {
    call.phase = { kind: 'awaiting-stop', outcome };
    return;
  }
  if (call.phase.kind === 'awaiting-stop') return;

  finishAgentSpan(call.span, outcome);
  completeCall(state, toolUseId, call);
}

function finishToolCall(call: ToolCall, outcome: CallOutcome): void {
  if (outcome.kind === 'success') {
    call.span.result = jsonStr(outcome.value);
    call.span.end();
    return;
  }
  const error = String(outcome.error);
  call.span.result = error;
  call.span.setAttributes({ [ATTR.ERROR_TYPE]: errorType(outcome.error) });
  call.span.end({ error: new Error(error) });
}

function finishAgentSpan(span: SubAgent, outcome: CallOutcome): void {
  const output = outcome.kind === 'success' ? outcome.value : outcome.error;
  if (output !== undefined && output !== null && output !== '') {
    const text = typeof output === 'string' ? output : jsonStr(output);
    span.setAttributes({ [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([text]) });
  }
  if (outcome.kind === 'success') {
    span.end();
    return;
  }
  span.setAttributes({ [ATTR.ERROR_TYPE]: errorType(outcome.error) });
  span.end({
    error: new Error(typeof outcome.error === 'string' ? outcome.error : 'subagent failed'),
  });
}

function errorType(error: unknown): string {
  if (typeof error === 'string') {
    const match = error.trim().match(/^[A-Z][A-Za-z_]*Error/);
    return match?.[0] ?? 'tool_error';
  }
  if (error && typeof error === 'object' && 'type' in error) {
    const type = (error as Record<string, unknown>)['type'];
    if (typeof type === 'string' && type) return type;
  }
  return 'tool_error';
}

export type AgentMatch =
  | { kind: 'found'; call: AgentCall }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

function matchingPrompt(candidates: AgentCall[], prompt: string | undefined): AgentCall[] {
  if (prompt === undefined) return candidates;
  const observed = prompt.trim();
  return candidates.filter(call => call.prompt.trim() === observed);
}

export function matchAgent(
  state: CallState,
  agentType: string,
  prompt: string | undefined,
  promptId?: string,
): AgentMatch {
  const candidates = [...state.byToolUseId.values()].filter((call): call is AgentCall =>
    call.kind === 'agent'
    && !call.agentId
    && call.agentType === agentType
    && call.promptId === promptId);
  const matches = matchingPrompt(candidates, prompt);
  if (matches.length === 1) return { kind: 'found', call: matches[0] };
  if (matches.length > 1 || (matches.length === 0 && candidates.length > 1)) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'missing' };
}

export function bindAgent(
  state: CallState,
  match: Extract<AgentMatch, { kind: 'found' }>,
  agentId: string,
): void {
  if (state.byAgentId.has(agentId) || match.call.agentId) return;
  match.call.agentId = agentId;
  match.call.span.record({ agentId });
  state.byAgentId.set(agentId, match.call);
}

/** Record a blockable Stop snapshot, completing only when Post already arrived. */
export function recordAgentStop(
  state: CallState,
  match: Extract<AgentMatch, { kind: 'found' }>,
): void {
  if (match.call.phase.kind === 'running') {
    match.call.phase = { kind: 'awaiting-post' };
    return;
  }
  if (match.call.phase.kind === 'awaiting-post') return;

  finishAgentSpan(match.call.span, match.call.phase.outcome);
  if (match.call.toolUseId) completeCall(state, match.call.toolUseId, match.call);
  else completeAgent(state, match.call);
}

function completeCall(state: CallState, toolUseId: string, call: OpenCall): void {
  state.byToolUseId.delete(toolUseId);
  state.toolUseTombstones.add(toolUseId);
  if (call.kind === 'agent') completeAgent(state, call);
}

function completeAgent(state: CallState, call: AgentCall): void {
  if (!call.agentId) return;
  if (state.byAgentId.get(call.agentId) === call) state.byAgentId.delete(call.agentId);
  state.agentTombstones.add(call.agentId);
}

/** Close unfinished children before their owning turns. */
export function finalizeOpenCalls(state: CallState, reason: string): string[] {
  const closed: string[] = [];
  for (const [toolUseId, call] of [...state.byToolUseId.entries()].reverse()) {
    if (call.kind === 'agent' && call.phase.kind === 'awaiting-stop') {
      finishAgentSpan(call.span, call.phase.outcome);
    } else {
      call.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: reason });
      call.span.end({ error: new Error(`call did not complete (${reason})`) });
    }
    completeCall(state, toolUseId, call);
    closed.push(toolUseId);
  }
  const recovered = [...state.byAgentId.entries()]
    .filter(([, call]) => call.toolUseId === undefined)
    .reverse();
  for (const [agentId, call] of recovered) {
    if (call.phase.kind === 'awaiting-stop') {
      finishAgentSpan(call.span, call.phase.outcome);
    } else if (call.phase.kind === 'awaiting-post') {
      call.span.end();
    } else {
      call.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: reason });
      call.span.end({ error: new Error(`call did not complete (${reason})`) });
    }
    completeAgent(state, call);
    closed.push(`agent:${agentId}`);
  }
  return closed;
}
