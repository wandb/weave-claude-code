// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { Tool, Turn } from 'weave';
import { ATTR, jsonStr, toolDisplayName } from './genaiSpans.js';

export type CallOutcome =
  | { kind: 'success'; value: unknown }
  | { kind: 'failure'; error: unknown };

type ToolCall = {
  span: Tool;
  /** `undefined` is the single foreground legacy stream; a later legacy
   * prompt is a hard boundary because the protocol supplies no prompt id. */
  promptId?: string;
};

export type CallState = {
  byToolUseId: Map<string, ToolCall>;
  /** Prevent duplicate or delayed hooks from reopening calls while this
   * reconstructed session state remains live. */
  toolUseTombstones: Set<string>;
};

export function newCallState(): CallState {
  return {
    byToolUseId: new Map(),
    toolUseTombstones: new Set(),
  };
}

export function openCalls(state: CallState): ToolCall[] {
  return [...state.byToolUseId.values()];
}

type BeginCallArgs = {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  promptId?: string;
};

/** Open the ordinary tool span represented by PreToolUse. Agent calls and
 * subagent-owned tools are deliberately deferred to the subagent protocol. */
export function beginCall(
  state: CallState,
  parent: Turn,
  args: BeginCallArgs,
): ToolCall | undefined {
  if (args.toolName === 'Agent'
    || state.byToolUseId.has(args.toolUseId)
    || state.toolUseTombstones.has(args.toolUseId)) return undefined;

  const span = parent.startTool({
    name: args.toolName,
    args: jsonStr(args.toolInput),
    toolCallId: args.toolUseId,
  });
  span.setAttributes({
    [ATTR.WEAVE_DISPLAY_NAME]: toolDisplayName(args.toolName, args.toolInput),
  });
  const call = { span, promptId: args.promptId };
  state.byToolUseId.set(args.toolUseId, call);
  return call;
}

/** Apply the exact tool_use_id terminal event once. */
export function settleCall(
  state: CallState,
  toolUseId: string,
  outcome: CallOutcome,
): void {
  const call = state.byToolUseId.get(toolUseId);
  if (!call) return;

  if (outcome.kind === 'success') {
    call.span.result = jsonStr(outcome.value);
    call.span.end();
  } else {
    const error = String(outcome.error);
    call.span.result = error;
    call.span.setAttributes({ [ATTR.ERROR_TYPE]: errorType(outcome.error) });
    call.span.end({ error: new Error(error) });
  }
  completeCall(state, toolUseId);
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

function completeCall(state: CallState, toolUseId: string): void {
  state.byToolUseId.delete(toolUseId);
  state.toolUseTombstones.add(toolUseId);
}

/** Close unfinished tools before their owning turns. */
export function finalizeOpenCalls(state: CallState, reason: string): string[] {
  const closed: string[] = [];
  for (const [toolUseId, call] of [...state.byToolUseId.entries()].reverse()) {
    call.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: reason });
    call.span.end({ error: new Error(`call did not complete (${reason})`) });
    completeCall(state, toolUseId);
    closed.push(toolUseId);
  }
  return closed;
}
