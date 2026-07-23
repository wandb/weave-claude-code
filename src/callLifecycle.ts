// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { Tool } from 'weave';
import { ATTR, jsonStr, toolDisplayName } from './genaiSpans.js';
import type { TurnTrace } from './tracedSession.js';

export type ToolOutcome =
  | { kind: 'success'; value: unknown }
  | { kind: 'failure'; error: unknown };

export type ToolDescriptor = {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
};

export type TracedTool = {
  span: Tool;
  parent: TurnTrace;
  toolUseId: string;
};

/** Owns the exact hook identities for ordinary tools in one session. */
export class ToolLifecycle {
  private readonly openById = new Map<string, TracedTool>();
  private readonly tombstones = new Set<string>();

  start(parent: TurnTrace, tool: ToolDescriptor): TracedTool | undefined {
    if (this.openById.has(tool.toolUseId) || this.tombstones.has(tool.toolUseId)) {
      return undefined;
    }

    const span = parent.span.startTool({
      name: tool.name,
      args: jsonStr(tool.input),
      toolCallId: tool.toolUseId,
    });
    span.setAttributes({
      [ATTR.WEAVE_DISPLAY_NAME]: toolDisplayName(tool.name, tool.input),
    });

    const traced = { span, parent, toolUseId: tool.toolUseId };
    parent.children.add(traced);
    this.openById.set(tool.toolUseId, traced);
    return traced;
  }

  /** A terminal hook may be the first hook observed after a daemon restart. */
  finishOrRecover(
    parent: () => TurnTrace,
    tool: ToolDescriptor,
    outcome: ToolOutcome,
  ): boolean {
    if (this.tombstones.has(tool.toolUseId)) return false;
    const traced = this.openById.get(tool.toolUseId) ?? this.start(parent(), tool);
    if (!traced) return false;

    if (outcome.kind === 'success') {
      traced.span.result = jsonStr(outcome.value);
      traced.span.end();
    } else {
      const error = String(outcome.error);
      traced.span.result = error;
      traced.span.setAttributes({ [ATTR.ERROR_TYPE]: errorType(outcome.error) });
      traced.span.end({ error: new Error(error) });
    }
    this.complete(tool.toolUseId, traced);
    return true;
  }

  /** End every unfinished child before its owning turn. */
  finalizeChildren(parent: TurnTrace, reason: string): string[] {
    const closed: string[] = [];
    for (const traced of [...parent.children].reverse()) {
      traced.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: reason });
      traced.span.end({ error: new Error(`call did not complete (${reason})`) });
      this.complete(traced.toolUseId, traced);
      closed.push(traced.toolUseId);
    }
    return closed;
  }

  hasOpenTools(): boolean {
    return this.openById.size > 0;
  }

  private complete(toolUseId: string, traced: TracedTool): void {
    traced.parent.children.delete(traced);
    this.openById.delete(toolUseId);
    this.tombstones.add(toolUseId);
  }
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
