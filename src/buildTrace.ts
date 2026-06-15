// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import { Span, SpanStatusCode, Tracer } from '@opentelemetry/api';
import { parseSessionFile } from './parser.js';
import type { ToolCallDetail } from './parser.js';
import { isCwdInScope } from './utils.js';
import {
  ATTR,
  DEFAULT_AGENT_NAME,
  emitChatSpansFromAssistantCalls,
  jsonStr,
  promptSnippet,
  startInvokeAgentSpan,
  startToolSpan,
  startTurnSpan,
  toolDisplayName,
} from './genaiSpans.js';

/**
 * Daemonless span builder. Walks a completed Claude Code transcript (and its
 * subagent transcripts on disk) in a single pass and emits the GenAI-convention
 * span tree the Weave Agents view understands — the same tree the persistent
 * daemon builds incrementally across hook events, reconstructed after the fact.
 *
 * Pure with respect to the OTel tracer: it only emits spans. The caller owns
 * the exporter/provider and must flush (`provider.shutdown()`) after this
 * returns. Returns the number of top-level turns emitted (0 if the transcript
 * is missing or unparseable).
 *
 * v1 intentionally drops two non-structural, hook-only enrichments: permission
 * events and compaction stats. Everything structural (turns, chat, tools,
 * results, subagents, tokens, models, finish reasons) is recovered from the
 * transcript.
 */
export interface BuildTraceOptions {
  /** Current process session id (debug breadcrumb on every turn span). */
  sessionId: string;
  /** Multi-turn stitching key; defaults to `sessionId`. */
  conversationId?: string;
  cwd: string;
  source: string;
  /** Top-level agent name shown in the Agents view; defaults to `claude-code`. */
  agentName?: string;
  pluginVersion: string;
  /** Opt-in repo allowlist. Empty/omitted ⇒ trace everything (global default).
   *  Non-empty ⇒ emit nothing unless `cwd` is at/under a listed root. */
  traceRoots?: string[];
}

interface SubagentEntry {
  agentType: string;
  /** Spawning Agent tool_use id, when the meta carries it. Present for plain
   *  `Agent`-tool subagents; ABSENT for agent-teams teammates (their meta has
   *  only `agentType`), which is why we also correlate by type + dispatch order. */
  toolUseId?: string;
  transcriptPath: string;
  mtime: number;
  consumed: boolean;
}

/**
 * List the subagent transcripts beside a transcript — one entry per
 * `subagents/agent-*.meta.json` — oldest first (dispatch order). The meta always
 * carries `agentType`; `toolUseId` only for plain `Agent`-tool subagents. Agent
 * teams re-spawn a teammate of the same type multiple times, so a type can have
 * several entries; FIFO ordering lets us correlate them to dispatches in order.
 */
function listSubagents(transcriptPath: string): SubagentEntry[] {
  const subdir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let files: string[];
  try {
    files = fs.readdirSync(subdir);
  } catch {
    return [];
  }
  const out: SubagentEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subdir, f), 'utf8')) as Record<string, unknown>;
      const base = f.replace(/\.meta\.json$/, '');
      const tpath = path.join(subdir, `${base}.jsonl`);
      if (!fs.existsSync(tpath)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(tpath).mtimeMs; } catch { /* keep 0 */ }
      out.push({
        agentType: typeof meta['agentType'] === 'string' ? (meta['agentType'] as string) : 'agent',
        toolUseId: typeof meta['toolUseId'] === 'string' ? (meta['toolUseId'] as string) : undefined,
        transcriptPath: tpath,
        mtime,
        consumed: false,
      });
    } catch {
      // Skip unreadable/corrupt meta files.
    }
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

/** Claim the entry whose meta toolUseId matches (exact), if any. */
function claimByToolUseId(pool: SubagentEntry[], id: string): SubagentEntry | undefined {
  const e = pool.find(x => !x.consumed && x.toolUseId === id);
  if (e) e.consumed = true;
  return e;
}

/** Claim the oldest unconsumed entry of a given agent type (FIFO). */
function claimByType(pool: SubagentEntry[], agentType: string): SubagentEntry | undefined {
  const e = pool.find(x => !x.consumed && x.agentType === agentType);
  if (e) e.consumed = true;
  return e;
}

export function buildTrace(tracer: Tracer, transcriptPath: string, opts: BuildTraceOptions): number {
  // Scope gate: out-of-scope sessions emit nothing (single enforcement point,
  // mirroring the daemon's turn-span gate — no turn span ⇒ no child spans).
  if (!isCwdInScope(opts.cwd, opts.traceRoots ?? [])) return 0;

  const parsed = parseSessionFile(transcriptPath);
  if (!parsed) return 0;

  const conversationId = opts.conversationId ?? opts.sessionId;
  const agentName = opts.agentName || DEFAULT_AGENT_NAME;
  const pool = listSubagents(transcriptPath);
  // Most-recent invoke_agent span per agent type — where re-spawned teammates
  // (extra same-type transcripts) attach in the leftover pass.
  const lastInvokeByType = new Map<string, Span>();

  // invoke_agent spans are ended only after the leftover pass — re-spawned
  // teammates attach (and set attributes) on the existing span for their type,
  // so it must stay open until all leftovers are processed.
  const openInvokes: Span[] = [];

  let turnNumber = 0;
  let lastTurnSpan: Span | undefined;
  for (const turn of parsed.turns) {
    turnNumber += 1;
    const prompt = turn.prompt();
    const requestModel = turn.primaryModel();

    const turnSpan = startTurnSpan(tracer, {
      sessionId: opts.sessionId,
      conversationId,
      turnNumber,
      prompt,
      cwd: opts.cwd,
      source: opts.source,
      pluginVersion: opts.pluginVersion,
      agentName,
      requestModel,
      displayName: `Turn ${turnNumber}: ${promptSnippet(prompt)}`,
    });
    lastTurnSpan = turnSpan;

    emitChatSpansFromAssistantCalls(tracer, turnSpan, conversationId, turn.assistantCalls());

    let toolCount = 0;
    for (const tc of turn.toolCalls()) {
      toolCount += 1;
      emitToolCall(tracer, turnSpan, conversationId, tc, pool, lastInvokeByType, openInvokes, opts);
    }

    const finishReasons = turn
      .assistantCalls()
      .map(c => c.finishReason)
      .filter((r): r is string => !!r);
    if (finishReasons.length) turnSpan.setAttribute(ATTR.RESPONSE_FINISH_REASONS, finishReasons);
    if (requestModel) turnSpan.setAttribute(ATTR.RESPONSE_MODEL, requestModel);
    turnSpan.setAttribute(ATTR.WEAVE_TURN_TOOL_COUNT, toolCount);
    const outText = turn.textBlocks().join('\n');
    if (outText) {
      turnSpan.setAttribute(ATTR.OUTPUT_MESSAGES, jsonStr([{ role: 'assistant', content: outText }]));
    }
    turnSpan.end();
  }

  // Leftover pass: subagent transcripts not claimed by a spawning Agent call —
  // agent-teams re-spawns (extra same-type transcripts) and orphan teammates.
  emitLeftoverSubagents(tracer, conversationId, pool, lastInvokeByType, lastTurnSpan, openInvokes, opts);

  // All invoke_agent spans are now fully populated — close them.
  for (const s of openInvokes) s.end();

  return turnNumber;
}

/**
 * Emit subagent transcripts that no `Agent` tool_use claimed. Re-spawns attach
 * under the existing invoke_agent span for their type (so coordinator-level
 * child count stays equal to the number of Agent calls — matching the daemon).
 * A type never seen at the coordinator level gets a fresh invoke_agent under the
 * last turn span.
 */
function emitLeftoverSubagents(
  tracer: Tracer,
  conversationId: string,
  pool: SubagentEntry[],
  lastInvokeByType: Map<string, Span>,
  fallbackParent: Span | undefined,
  openInvokes: Span[],
  opts: BuildTraceOptions,
): void {
  for (const e of pool) {
    if (e.consumed) continue;
    e.consumed = true;
    const existing = lastInvokeByType.get(e.agentType);
    if (existing) {
      // existing is still open (ended only after this pass) — safe to append.
      emitAgentSubtree(tracer, existing, conversationId, e.transcriptPath, opts);
      continue;
    }
    if (!fallbackParent) continue;
    const invokeSpan = startInvokeAgentSpan(tracer, fallbackParent, {
      agentType: e.agentType,
      conversationId,
      pluginVersion: opts.pluginVersion,
    });
    emitAgentSubtree(tracer, invokeSpan, conversationId, e.transcriptPath, opts);
    lastInvokeByType.set(e.agentType, invokeSpan);
    openInvokes.push(invokeSpan); // ended by the caller after the full pass
  }
}

/**
 * Emit one tool call under `parentSpan`. An `Agent` tool call becomes a nested
 * `invoke_agent` span (with its subagent's full subtree recursed in if the
 * transcript is on disk); any other tool becomes an `execute_tool` span with
 * its result attached.
 */
function emitToolCall(
  tracer: Tracer,
  parentSpan: Span,
  conversationId: string,
  tc: ToolCallDetail,
  pool: SubagentEntry[],
  lastInvokeByType: Map<string, Span>,
  openInvokes: Span[],
  opts: BuildTraceOptions,
): void {
  if (tc.toolName === 'Agent') {
    // Correlate to a transcript. Order: exact toolUseId match (plain Agent
    // subagents) → team-member `name` → `subagent_type`. Agent-teams teammates
    // have no toolUseId in their meta; their meta `agentType` is the team-member
    // NAME from the Agent call's `name` field, which differs from `subagent_type`
    // (e.g. name="s1", subagent_type="storage-specialist").
    const subType = typeof tc.toolInput['subagent_type'] === 'string'
      ? (tc.toolInput['subagent_type'] as string) : 'agent';
    const memberName = typeof tc.toolInput['name'] === 'string'
      ? (tc.toolInput['name'] as string) : undefined;
    const entry = claimByToolUseId(pool, tc.toolUseId)
      ?? (memberName ? claimByType(pool, memberName) : undefined)
      ?? claimByType(pool, subType);
    // Label the span with the matched teammate's identity when we found one, so
    // re-spawns key off the same type and nest together.
    const agentType = entry?.agentType ?? memberName ?? subType;
    const promptText = tc.toolInput['prompt'];
    const invokeSpan = startInvokeAgentSpan(tracer, parentSpan, {
      agentType,
      conversationId,
      pluginVersion: opts.pluginVersion,
      inputMessages: promptText ? [{ role: 'user', content: promptText }] : undefined,
      spawningToolCallId: tc.toolUseId,
      displayName: toolDisplayName('Agent', tc.toolInput),
    });
    lastInvokeByType.set(agentType, invokeSpan);
    if (entry) {
      emitAgentSubtree(tracer, invokeSpan, conversationId, entry.transcriptPath, opts);
    }
    // Ended by the caller after the leftover pass — re-spawns may still attach.
    openInvokes.push(invokeSpan);
    return;
  }

  const toolSpan = startToolSpan(tracer, parentSpan, {
    toolName: tc.toolName,
    toolUseId: tc.toolUseId,
    toolInput: tc.toolInput,
    displayName: toolDisplayName(tc.toolName, tc.toolInput),
  });
  if (tc.toolResult !== undefined) {
    toolSpan.setAttribute(ATTR.TOOL_CALL_RESULT, jsonStr(tc.toolResult));
  }
  if (tc.isError) {
    toolSpan.setAttribute(ATTR.ERROR_TYPE, 'tool_error');
    toolSpan.setStatus({ code: SpanStatusCode.ERROR });
  }
  toolSpan.end();
}

/**
 * Recurse a subagent transcript under its `invoke_agent` span: emit chat spans
 * for ALL turns (subagents/teammates do real work across multiple turns — the
 * daemon's last-turn-only path dropped earlier-turn tool calls) and the
 * subagent's own tool calls, recursing into nested subagents found beside the
 * subagent transcript. Sets the response model from the subagent's primary
 * model. The caller ends the invoke_agent span.
 */
function emitAgentSubtree(
  tracer: Tracer,
  invokeSpan: Span,
  conversationId: string,
  agentTranscriptPath: string,
  opts: BuildTraceOptions,
): void {
  const parsed = parseSessionFile(agentTranscriptPath);
  if (!parsed) return;
  // A subagent can itself spawn subagents — correlate them with the same
  // pool + leftover strategy, recursively (arbitrary nesting depth). Nested
  // invoke_agent spans are ended only after this subtree's own leftover pass.
  const nested = listSubagents(agentTranscriptPath);
  const nestedLastInvoke = new Map<string, Span>();
  const nestedOpen: Span[] = [];

  let model: string | undefined;
  for (const turn of parsed.turns) {
    emitChatSpansFromAssistantCalls(tracer, invokeSpan, conversationId, turn.assistantCalls());
    for (const tc of turn.toolCalls()) {
      emitToolCall(tracer, invokeSpan, conversationId, tc, nested, nestedLastInvoke, nestedOpen, opts);
    }
    model = turn.primaryModel() ?? model;
  }
  emitLeftoverSubagents(tracer, conversationId, nested, nestedLastInvoke, invokeSpan, nestedOpen, opts);
  for (const s of nestedOpen) s.end();
  if (model) invokeSpan.setAttribute(ATTR.RESPONSE_MODEL, model);
}
