// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { Attributes } from '@opentelemetry/api';
import type { SubAgent, Tool } from 'weave';
import {
  ATTR,
  addPermissionRequestEvent,
  addPermissionResolvedEvent,
  assistantOutputMessages,
  jsonStr,
  toolDisplayName,
} from './genaiSpans.js';
import type { SpanParent } from './genaiSpans.js';
import { VERSION } from './setup.js';
import type { TurnTrace } from './tracedSession.js';
import { deepEqual } from './utils.js';

export type CallOutcome =
  | { kind: 'success'; value: unknown }
  | { kind: 'failure'; error: unknown };

export type CallParent = TurnTrace | TracedAgent;

type CallScope = {
  parent: CallParent;
  root: TurnTrace;
};

type PermissionContext = {
  name: string;
  input: Record<string, unknown>;
  permissionRequested: boolean;
};

type TracedTool = CallScope & PermissionContext & {
  kind: 'tool';
  span: Tool;
  toolUseId: string;
};

export type TracedAgent = CallScope & PermissionContext & {
  kind: 'agent';
  span: SubAgent;
  toolUseId?: string;
  /** Display name chosen from Agent input; `name` is only an instance alias. */
  agentType: string;
  /** Lifecycle identity, unknown when Agent input omitted `subagent_type`. */
  declaredAgentType?: string;
  prompt: string;
  agentId?: string;
  outcome?: CallOutcome;
  stopSeen: boolean;
  /** A protocol-specific terminal event can decide the result before nested
   * calls have drained. */
  completion?: AgentCompletion;
  children: Set<TracedCall>;
  /** Chat responses already emitted from this Agent's Stop snapshots. */
  seenResponses: Set<string>;
};

export type TracedCall = TracedTool | TracedAgent;

type AgentCompletion = (
  | { outcome: CallOutcome; failureType?: string }
  | { orphanReason: string }
) & { endTime?: Date };

/** Secondary indexes for the identities exposed by Claude's hooks. */
export type CallState = {
  byToolUseId: Map<string, TracedCall>;
  byAgentId: Map<string, TracedAgent>;
  /** Prevent duplicate or delayed hooks from reopening completed calls. */
  toolUseTombstones: Set<string>;
  agentTombstones: Set<string>;
  /** Dedupe state for Stop snapshots whose Agent call is still ambiguous. */
  uncorrelatedAgentResponses: Map<string, Set<string>>;
};

export function newCallState(): CallState {
  return {
    byToolUseId: new Map(),
    byAgentId: new Map(),
    toolUseTombstones: new Set(),
    agentTombstones: new Set(),
    uncorrelatedAgentResponses: new Map(),
  };
}

function attachCall(state: CallState, call: TracedCall): void {
  call.parent.children.add(call);
  if (call.toolUseId) state.byToolUseId.set(call.toolUseId, call);
  if (call.kind === 'agent' && call.agentId) state.byAgentId.set(call.agentId, call);
}

type BeginCallArgs = {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

/** Open the span represented by PreToolUse. Agent is the only special tool:
 * its invoke-agent span becomes the parent of later child hooks. */
export function beginCall(
  state: CallState,
  parent: CallParent,
  args: BeginCallArgs,
): TracedCall | undefined {
  if (parent.kind === 'agent'
    && (parent.completion || (parent.stopSeen && parent.outcome))) return undefined;
  if (state.byToolUseId.has(args.toolUseId)
    || state.toolUseTombstones.has(args.toolUseId)) return undefined;

  const root = parent.kind === 'turn' ? parent : parent.root;
  let call: TracedCall;
  if (args.toolName === 'Agent') {
    const agentType = agentTypeFor(args.toolInput);
    const prompt = typeof args.toolInput['prompt'] === 'string' ? args.toolInput['prompt'] : '';
    const span = startAgentSpan(parent.span, agentType, prompt);
    span.setAttributes({ [ATTR.WEAVE_SUBAGENT_SPAWNING_TOOL_CALL_ID]: args.toolUseId });
    call = {
      kind: 'agent',
      span,
      toolUseId: args.toolUseId,
      name: args.toolName,
      input: args.toolInput,
      permissionRequested: false,
      agentType,
      declaredAgentType: declaredAgentTypeFor(args.toolInput),
      prompt,
      parent,
      root,
      stopSeen: false,
      children: new Set(),
      seenResponses: new Set(),
    };
  } else {
    const span = parent.span.startTool({
      name: args.toolName,
      args: jsonStr(args.toolInput),
      toolCallId: args.toolUseId,
    });
    const attributes: Attributes = {
      [ATTR.WEAVE_DISPLAY_NAME]: toolDisplayName(args.toolName, args.toolInput),
    };
    if (parent.kind === 'agent') attributes[ATTR.AGENT_NAME] = parent.agentType;
    span.setAttributes(attributes);
    call = {
      kind: 'tool',
      span,
      toolUseId: args.toolUseId,
      name: args.toolName,
      input: args.toolInput,
      permissionRequested: false,
      parent,
      root,
    };
  }

  attachCall(state, call);
  return call;
}

function declaredAgentTypeFor(input: Record<string, unknown>): string | undefined {
  const value = input['subagent_type'];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function agentTypeFor(input: Record<string, unknown>): string {
  const name = input['name'];
  return declaredAgentTypeFor(input)
    ?? (typeof name === 'string' && name.trim() ? name.trim() : 'Agent');
}

function startAgentSpan(parent: SpanParent, agentName: string, prompt: string): SubAgent {
  const span = parent.startSubagent({ name: agentName, agentVersion: VERSION });
  if (prompt) {
    span.setAttributes({ [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: prompt }]) });
  }
  return span;
}

type RecoverAgentArgs = {
  agentId: string;
  agentType: string;
  prompt: string;
  event: 'SubagentStart' | 'SubagentStop';
};

/** Recreate an Agent marker when a lifecycle hook is first after restart. */
export function recoverAgentCall(
  state: CallState,
  parent: CallParent,
  args: RecoverAgentArgs,
): TracedAgent {
  const root = parent.kind === 'turn' ? parent : parent.root;
  const span = startAgentSpan(parent.span, args.agentType, args.prompt);
  span.setAttributes({ [ATTR.WEAVE_DISPLAY_NAME]: `Agent: ${args.agentType}` });
  span.record({ agentId: args.agentId });
  const call: TracedAgent = {
    kind: 'agent',
    span,
    name: 'Agent',
    input: { subagent_type: args.agentType, prompt: args.prompt },
    permissionRequested: false,
    agentType: args.agentType,
    declaredAgentType: args.agentType,
    prompt: args.prompt,
    parent,
    root,
    agentId: args.agentId,
    stopSeen: args.event === 'SubagentStop',
    children: new Set(),
    seenResponses: new Set(),
  };
  attachCall(state, call);
  return call;
}

export function backfillAgentPrompt(call: TracedAgent, prompt: string): void {
  if (call.prompt.trim() || !prompt.trim()) return;
  call.prompt = prompt;
  call.input = { ...call.input, prompt };
  call.span.setAttributes({
    [ATTR.INPUT_MESSAGES]: jsonStr([{ role: 'user', content: prompt }]),
  });
}

/** Prefer lifecycle-owned response dedupe, retaining a fallback only while
 * correlation is ambiguous. */
export function responseKeysForAgent(
  state: CallState,
  agentId: string,
  call?: TracedAgent,
): Set<string> {
  const uncorrelated = state.uncorrelatedAgentResponses.get(agentId);
  if (!call) {
    const seen = uncorrelated ?? new Set<string>();
    state.uncorrelatedAgentResponses.set(agentId, seen);
    return seen;
  }
  if (uncorrelated) {
    for (const key of uncorrelated) call.seenResponses.add(key);
    state.uncorrelatedAgentResponses.delete(agentId);
  }
  return call.seenResponses;
}

type PermissionRequest = {
  promptId?: string;
  parent?: CallParent;
  toolName: string;
  toolInput: unknown;
  suggestions?: unknown;
};

export type PermissionAttribution = 'recorded' | 'missing' | 'ambiguous';

/** PermissionRequest has no tool_use_id, so record it only for one exact call. */
export function recordPermissionRequest(
  state: CallState,
  request: PermissionRequest,
): PermissionAttribution {
  const candidates = [...state.byToolUseId.values()].filter(call =>
    !call.permissionRequested
    && call.name === request.toolName
    && call.root.promptId === request.promptId
    && call.parent === request.parent);
  const exact = candidates.filter(call => deepEqual(call.input, request.toolInput));
  // PreToolUse hooks may update the input before PermissionRequest. Fall back
  // to scope only when it still identifies exactly one call.
  const matches = exact.length ? exact : candidates;
  if (matches.length !== 1) return matches.length === 0 ? 'missing' : 'ambiguous';

  const [call] = matches;
  call.permissionRequested = true;
  addPermissionRequestEvent(call.span, {
    suggestions: request.suggestions,
    timestamp: new Date(),
  });
  return 'recorded';
}

function resolvePermission(call: TracedCall, approved: boolean): void {
  if (approved && !call.permissionRequested) return;
  addPermissionResolvedEvent(call.span, { approved, timestamp: new Date() });
  call.permissionRequested = false;
}

/** PermissionDenied is a standalone auto-mode classifier decision. Manual
 * dialogs do not emit this hook, so no preceding request event is required. */
export function denyCall(state: CallState, toolUseId: string, reason: string): void {
  const call = state.byToolUseId.get(toolUseId);
  if (!call) return;

  resolvePermission(call, false);
  if (call.kind === 'tool') {
    call.span.result = reason;
    call.span.setAttributes({ [ATTR.ERROR_TYPE]: 'permission_denied' });
    call.span.end({ error: new Error(reason) });
    completeCall(state, call);
  } else {
    finishAgentCall(state, call, {
      outcome: { kind: 'failure', error: reason },
      failureType: 'permission_denied',
    });
  }
}

/** Apply the exact tool_use_id terminal event once. */
export function recordCallOutcome(
  state: CallState,
  toolUseId: string,
  outcome: CallOutcome,
): void {
  const call = state.byToolUseId.get(toolUseId);
  if (!call) return;

  if (call.kind === 'tool') {
    finishToolCall(call, outcome);
    completeCall(state, call);
    return;
  }
  resolvePermission(call, true);
  call.outcome ??= outcome;
  finishAgentIfReady(state, call);
}

/** Record an Agent result whose protocol has a later terminal event. */
export function deferAgentOutcome(call: TracedAgent, outcome: CallOutcome): void {
  resolvePermission(call, true);
  call.outcome ??= outcome;
}

/** Complete an Agent from a protocol-specific terminal event. */
export function finishAgentCall(
  state: CallState,
  call: TracedAgent,
  completion: { outcome: CallOutcome; failureType?: string } | { orphanReason: string },
  endTime?: Date,
): void {
  if ('outcome' in completion) resolvePermission(call, true);
  call.completion ??= { ...completion, ...(endTime ? { endTime } : {}) };
  finishAgentIfReady(state, call);
}

function finishToolCall(call: TracedTool, outcome: CallOutcome): void {
  resolvePermission(call, true);
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

function finishAgentSpan(
  call: TracedAgent,
  outcome: CallOutcome,
  failureType?: string,
  endTime?: Date,
): void {
  const output = outcome.kind === 'success' ? outcome.value : outcome.error;
  if (output !== undefined && output !== null && output !== '') {
    const text = typeof output === 'string' ? output : jsonStr(output);
    call.span.setAttributes({ [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([text]) });
  }
  if (outcome.kind === 'success') {
    call.span.end(endTime ? { endTime } : undefined);
    return;
  }
  call.span.setAttributes({ [ATTR.ERROR_TYPE]: failureType ?? errorType(outcome.error) });
  call.span.end({
    error: new Error(typeof outcome.error === 'string' ? outcome.error : 'subagent failed'),
    ...(endTime ? { endTime } : {}),
  });
}

function endAgent(call: TracedAgent, completion: AgentCompletion): void {
  if ('outcome' in completion) {
    finishAgentSpan(
      call,
      completion.outcome,
      completion.failureType,
      completion.endTime,
    );
    return;
  }
  call.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: completion.orphanReason });
  call.span.end({
    error: new Error(`call did not complete (${completion.orphanReason})`),
    ...(completion.endTime ? { endTime: completion.endTime } : {}),
  });
}

function errorType(error: unknown): string {
  if (typeof error === 'string') {
    return error.trim().match(/^[A-Z][A-Za-z_]*Error/)?.[0] ?? 'tool_error';
  }
  if (error && typeof error === 'object' && 'type' in error) {
    const type = (error as Record<string, unknown>)['type'];
    if (typeof type === 'string' && type) return type;
  }
  return 'tool_error';
}

export type AgentMatch =
  | { kind: 'found'; call: TracedAgent }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

export function matchAgent(
  state: CallState,
  agentType: string,
  prompt: string | undefined,
  promptId?: string,
): AgentMatch {
  const candidates = [...state.byToolUseId.values()].filter((call): call is TracedAgent =>
    call.kind === 'agent'
    && !call.agentId
    && call.root.promptId === promptId
    && (call.declaredAgentType === undefined || call.declaredAgentType === agentType));
  const matches = prompt === undefined
    ? candidates
    : candidates.filter(call => call.prompt.trim() === prompt.trim());
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
  agentType: string,
): void {
  if (state.byAgentId.has(agentId) || match.call.agentId) return;
  match.call.declaredAgentType ??= agentType;
  match.call.agentId = agentId;
  match.call.span.record({ agentId });
  state.byAgentId.set(agentId, match.call);
}

/** Record a blockable Stop snapshot, completing only when Post already arrived. */
export function recordAgentStop(
  state: CallState,
  match: Extract<AgentMatch, { kind: 'found' }>,
): void {
  match.call.stopSeen = true;
  finishAgentIfReady(state, match.call);
}

function finishAgentIfReady(state: CallState, call: TracedAgent): void {
  if (call.children.size) return;
  const completion = call.completion
    ?? (call.stopSeen && call.outcome ? { outcome: call.outcome } : undefined);
  if (!completion) return;
  endAgent(call, completion);
  completeCall(state, call);
}

function completeCall(
  state: CallState,
  call: TracedCall,
  finishParent = true,
): void {
  call.parent.children.delete(call);
  if (call.toolUseId) {
    state.byToolUseId.delete(call.toolUseId);
    state.toolUseTombstones.add(call.toolUseId);
  }
  if (call.kind === 'agent' && call.agentId) {
    state.byAgentId.delete(call.agentId);
    state.agentTombstones.add(call.agentId);
  }
  if (finishParent && call.parent.kind === 'agent') {
    finishAgentIfReady(state, call.parent);
  }
}

/** Close children before parents. Preserve real Agent results and completed
 * recovered snapshots; only genuinely unfinished calls are marked orphaned. */
export function finalizeOpenCalls(
  state: CallState,
  roots: Iterable<TurnTrace>,
  reason: string,
  endTime?: Date,
  defer: (call: TracedCall) => boolean = () => false,
): string[] {
  const closed: string[] = [];
  const finalCompletion = (call: TracedAgent, at?: Date): AgentCompletion => {
    if (call.completion) {
      return at && !call.completion.endTime
        ? { ...call.completion, endTime: at }
        : call.completion;
    }
    if (call.outcome) {
      return { outcome: call.outcome, ...(at ? { endTime: at } : {}) };
    }
    if (!call.toolUseId && call.stopSeen) {
      return {
        outcome: { kind: 'success', value: undefined },
        ...(at ? { endTime: at } : {}),
      };
    }
    return { orphanReason: reason, ...(at ? { endTime: at } : {}) };
  };
  const awaitChildren = (completion: AgentCompletion): AgentCompletion =>
    'outcome' in completion
      ? {
        outcome: completion.outcome,
        ...(completion.failureType ? { failureType: completion.failureType } : {}),
      }
      : { orphanReason: completion.orphanReason };
  const closeChildren = (parent: CallParent) => {
    for (const call of [...parent.children].reverse()) {
      if (call.kind === 'agent') closeChildren(call);
      if (defer(call)) continue;
      if (call.kind === 'agent' && call.children.size) {
        call.completion = awaitChildren(finalCompletion(call));
        continue;
      }
      if (call.kind === 'agent') {
        endAgent(call, finalCompletion(call, endTime));
      } else {
        call.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: reason });
        call.span.end({
          error: new Error(`call did not complete (${reason})`),
          ...(endTime ? { endTime } : {}),
        });
      }
      completeCall(state, call, false);
      closed.push(call.toolUseId ?? `agent:${call.kind === 'agent' ? call.agentId : 'unknown'}`);
    }
  };
  for (const root of [...roots].reverse()) closeChildren(root);
  return closed;
}
