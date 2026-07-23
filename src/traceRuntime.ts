// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import type {
  BaseHookInput,
  HookInput,
  InstructionsLoadedHookInput,
  PermissionDeniedHookInput,
  PermissionRequestHookInput,
  PreToolUseHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  UserPromptSubmitHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import * as weave from 'weave';
import { emitChatSpans } from './chatSpans.js';
import {
  backfillAgentPrompt,
  beginCall,
  bindAgent,
  denyCall,
  matchAgent,
  recordAgentStop,
  recordCallOutcome,
  recordPermissionRequest,
  recoverAgentCall,
  responseKeysForAgent,
} from './callLifecycle.js';
import type {
  AgentMatch,
  CallOutcome,
  CallParent,
  TracedAgent,
  TracedCall,
} from './callLifecycle.js';
import type { CompactionAttrs } from './genaiSpans.js';
import { ATTR, assistantOutputMessages, snippet } from './genaiSpans.js';
import type { SpanParent } from './genaiSpans.js';
import { parseSessionFd } from './parser.js';
import { TracedSession } from './tracedSession.js';
import {
  TranscriptFile,
  readSubagentPrompt,
  subagentTranscriptPath,
} from './transcriptFile.js';

type TraceLog = (level: 'DEBUG' | 'INFO' | 'ERROR', message: string) => void;

type HookInputFor<Event extends HookInput['hook_event_name']> = Extract<
  HookInput,
  { hook_event_name: Event }
>;
type PostToolResultHookInput = HookInputFor<'PostToolUse' | 'PostToolUseFailure'>;
type RecoverCallHookInput = HookInputFor<
  'PermissionDenied' | 'PostToolUse' | 'PostToolUseFailure'
>;

function mergeSubagentOutput(transcriptText?: string, lastMessage?: string): string | undefined {
  const transcript = transcriptText?.trim();
  const latest = lastMessage?.trim();
  if (!transcript) return latest || undefined;
  if (!latest) return transcript;

  const contains = (text: string, message: string) =>
    text === message
    || text.startsWith(`${message}\n`)
    || text.endsWith(`\n${message}`)
    || text.includes(`\n${message}\n`);
  if (contains(transcript, latest)) return transcript;
  if (contains(latest, transcript)) return latest;
  return `${transcript}\n${latest}`;
}

function parseHookInput(payload: unknown): HookInput | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const input = payload as Record<string, unknown>;
  return typeof input['hook_event_name'] === 'string'
    && typeof input['session_id'] === 'string'
    ? input as HookInput
    : undefined;
}

export class TraceRuntime {
  private readonly sessions = new Map<string, TracedSession>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  /** InstructionsLoaded can arrive before SessionStart. */
  private readonly pendingInstructions = new Map<string, Map<string, string>>();

  constructor(
    private readonly agentName: string,
    private readonly log: TraceLog,
  ) {}

  async process(payload: unknown): Promise<void> {
    const input = parseHookInput(payload);
    if (!input) {
      this.log('ERROR', 'Invalid hook payload');
      return;
    }

    const sessionId = input.session_id;
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.route(input));
    this.sessionQueues.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.sessionQueues.get(sessionId) === next) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  private async route(input: HookInput): Promise<void> {
    const sessionId = input.session_id;
    this.log(
      'INFO',
      `${input.hook_event_name} session=${sessionId}${input.agent_id ? ` agent=${input.agent_id}` : ''}`,
    );
    try {
      await weave.runIsolated(() => this.dispatchEvent(input));
    } catch (err) {
      this.log('ERROR', `Error handling ${input.hook_event_name}: ${err}`);
    }
  }

  private async dispatchEvent(input: HookInput): Promise<void> {
    const sessionId = input.session_id;
    switch (input.hook_event_name) {
      case 'SessionStart':
        await this.handleSessionStart(sessionId, input);
        return;
      case 'InstructionsLoaded':
        this.handleInstructionsLoaded(sessionId, input);
        return;
      case 'UserPromptSubmit':
        await this.handleUserPromptSubmit(sessionId, input);
        return;
      case 'PreToolUse':
        await this.handlePreToolUse(sessionId, input);
        return;
      case 'PermissionRequest':
        await this.handlePermissionRequest(sessionId, input);
        return;
      case 'PermissionDenied':
        await this.handlePermissionDenied(sessionId, input);
        return;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        await this.handlePostToolResult(sessionId, input);
        return;
      case 'SubagentStart':
        await this.handleSubagentStart(sessionId, input);
        return;
      case 'SubagentStop':
        await this.handleSubagentStop(sessionId, input);
        return;
      case 'PreCompact':
        this.handlePreCompact(sessionId, input);
        return;
      case 'Stop':
        await this.handleStop(sessionId, input);
        return;
      case 'SessionEnd':
        await this.handleSessionEnd(sessionId, input);
        return;
      default:
        return;
    }
  }

  private async createSession(
    sessionId: string,
    transcript: TranscriptFile,
    options: { source: string; cwd: string; initialRequestModel?: string },
  ): Promise<TracedSession> {
    const session = await TracedSession.create({
      sessionId,
      transcript,
      cwd: options.cwd,
      source: options.source,
      initialRequestModel: options.initialRequestModel,
      agentName: this.agentName,
      log: this.log,
    });
    this.sessions.set(sessionId, session);
    this.drainPendingInstructions(session);
    return session;
  }

  private async handleSessionStart(
    sessionId: string,
    input: SessionStartHookInput,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(input.transcript_path);
    } catch (err) {
      this.log('ERROR', `Invalid transcript_path for session ${sessionId}: ${err}`);
      return;
    }

    const session = await this.createSession(sessionId, transcript, {
      source: input.source,
      cwd: input.cwd,
      initialRequestModel: input.model,
    });
    const resumed = session.conversationId !== sessionId;
    this.log(
      'INFO',
      `Session created: ${sessionId}${resumed ? ` (resumed; conversation=${session.conversationId})` : ''}`,
    );
    this.log(
      'DEBUG',
      `SessionStart details: session=${sessionId} conversation=${session.conversationId} source=${session.source} model=${session.initialRequestModel ?? 'unknown'} cwd=${session.cwd || '(empty)'} transcript_path=${session.transcriptPath} transcript_file=${path.basename(session.transcriptPath)} active_sessions=${this.sessions.size}`,
    );
  }

  private async getOrReconstructSession(
    sessionId: string,
    input: HookInput,
  ): Promise<TracedSession | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    if (!input.transcript_path) return undefined;

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(input.transcript_path);
    } catch (err) {
      this.log('ERROR', `Cannot reconstruct session ${sessionId}: invalid transcript_path: ${err}`);
      return undefined;
    }

    const raw = input as Record<string, unknown>;
    const session = await this.createSession(sessionId, transcript, {
      source: raw['source'] as string | undefined ?? 'reconstructed',
      cwd: input.cwd,
      initialRequestModel: raw['model'] as string | undefined,
    });
    this.log(
      'INFO',
      `Session reconstructed after restart: ${sessionId} (conversation=${session.conversationId})`,
    );
    return session;
  }

  private handleInstructionsLoaded(
    sessionId: string,
    input: InstructionsLoadedHookInput,
  ): void {
    let content: string;
    try {
      content = fs.readFileSync(input.file_path, 'utf8');
    } catch (err) {
      this.log('DEBUG', `InstructionsLoaded: unreadable ${input.file_path}: ${err}`);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.setInstruction(input.file_path, content);
    } else {
      const pending = this.pendingInstructions.get(sessionId) ?? new Map();
      pending.set(input.file_path, content);
      this.pendingInstructions.set(sessionId, pending);
    }
    this.log(
      'DEBUG',
      `InstructionsLoaded: session=${sessionId} reason=${input.load_reason} file=${path.basename(input.file_path)} bytes=${content.length}${session ? '' : ' (buffered)'}`,
    );
  }

  private drainPendingInstructions(session: TracedSession): void {
    const pending = this.pendingInstructions.get(session.sessionId);
    this.pendingInstructions.delete(session.sessionId);
    if (!pending) return;
    for (const [filePath, content] of pending) {
      session.setInstruction(filePath, content);
    }
    this.log(
      'DEBUG',
      `Drained ${pending.size} buffered instruction file(s) into session ${session.sessionId}`,
    );
  }

  private async handleUserPromptSubmit(
    sessionId: string,
    input: UserPromptSubmitHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) {
      this.log('ERROR', `Unknown session (no transcript_path to reconstruct): ${sessionId}`);
      return;
    }

    const result = session.submitPrompt(input.prompt_id, input.prompt);
    if (!result.created) return;
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} current_turn=${result.replacedOpenTurn ? 'open' : 'none'} prompt=${snippet(input.prompt, 120)}`,
    );
    this.log('INFO', 'Created turn span');
  }

  private handlePreCompact(sessionId: string, input: PreCompactHookInput): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Claude Code sends compaction fields that are absent from the SDK type.
    const raw = input as Record<string, unknown>;
    const attrs: CompactionAttrs = {
      summary: (raw['summary'] ?? raw['compaction_summary']) as string | undefined,
      itemsBefore: raw['items_before'] as number | undefined,
      itemsAfter: raw['items_after'] as number | undefined,
    };
    if (session.setCompaction(input.prompt_id, attrs)) {
      this.log('INFO', `PreCompact attached to active turn (session ${sessionId})`);
    } else {
      this.log('INFO', `PreCompact buffered; will attach to next turn (session ${sessionId})`);
    }
  }

  private async handlePreToolUse(
    sessionId: string,
    input: PreToolUseHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;

    const parent = await this.resolveCallParent(session, input);
    if (!parent) {
      this.log(
        'ERROR',
        `PreToolUse: unknown parent session=${sessionId} tool=${input.tool_name} agent=${input.agent_id ?? 'root'}`,
      );
      return;
    }
    const call = beginCall(session.calls, parent, {
      toolUseId: input.tool_use_id,
      toolName: input.tool_name,
      toolInput: input.tool_input as Record<string, unknown>,
    });
    if (call && !input.agent_id) call.root.phase = 'active';
  }

  /** Resolve a call's owning span. After restart, nested hooks can arrive
   * before SubagentStart; recover only from the stable id, type, and prompt. */
  private async resolveCallParent(
    session: TracedSession,
    input: Pick<BaseHookInput, 'agent_id' | 'agent_type' | 'prompt_id'>,
  ): Promise<CallParent | undefined> {
    if (!input.agent_id) return session.ensureTurn(input.prompt_id);
    const active = session.calls.byAgentId.get(input.agent_id);
    if (active) return active;
    if (!input.agent_type || session.calls.agentTombstones.has(input.agent_id)) {
      return undefined;
    }

    const transcriptPath = subagentTranscriptPath(
      session.transcriptPath,
      input.agent_id,
    );
    const prompt = await readSubagentPrompt(transcriptPath);
    if (!prompt) {
      this.log(
        'ERROR',
        `Nested hook: cannot recover owner agentId=${input.agent_id} type=${input.agent_type} without its dispatch prompt`,
      );
      return undefined;
    }
    return this.recoverAgent(
      session,
      input.agent_id,
      input.agent_type,
      input.prompt_id,
      prompt,
      'SubagentStart',
    );
  }

  /** Recreate a call from its exact tool_use_id after a restart. */
  private async recoverCall(
    session: TracedSession,
    input: RecoverCallHookInput,
  ): Promise<TracedCall | undefined> {
    const existing = session.calls.byToolUseId.get(input.tool_use_id);
    if (existing || session.calls.toolUseTombstones.has(input.tool_use_id)) {
      return existing;
    }
    const parent = await this.resolveCallParent(session, input);
    if (!parent) return undefined;
    return beginCall(session.calls, parent, {
      toolUseId: input.tool_use_id,
      toolName: input.tool_name,
      toolInput: input.tool_input as Record<string, unknown>,
    });
  }

  private async handlePostToolResult(
    sessionId: string,
    input: PostToolResultHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || session.calls.toolUseTombstones.has(input.tool_use_id)) return;

    const outcome: CallOutcome = input.hook_event_name === 'PostToolUse'
      ? { kind: 'success', value: input.tool_response }
      : { kind: 'failure', error: input.error };
    await this.recoverCall(session, input);
    recordCallOutcome(session.calls, input.tool_use_id, outcome);
    session.finishSupersededTurns();
  }

  private async handlePermissionRequest(
    sessionId: string,
    input: PermissionRequestHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;
    const parent = input.agent_id
      ? session.calls.byAgentId.get(input.agent_id)
      : session.turnForPrompt(input.prompt_id);
    const attribution = recordPermissionRequest(session.calls, {
      parent,
      toolName: input.tool_name,
      toolInput: input.tool_input,
      suggestions: input.permission_suggestions,
      promptId: input.prompt_id,
    });
    if (attribution !== 'recorded') {
      this.log(
        'DEBUG',
        `PermissionRequest ${attribution}: session=${sessionId} tool=${input.tool_name}`,
      );
    }
  }

  private async handlePermissionDenied(
    sessionId: string,
    input: PermissionDeniedHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || session.calls.toolUseTombstones.has(input.tool_use_id)) return;
    await this.recoverCall(session, input);
    denyCall(session.calls, input.tool_use_id, input.reason);
    session.finishSupersededTurns();
  }

  private async handleSubagentStart(
    sessionId: string,
    input: SubagentStartHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session
      || session.calls.agentTombstones.has(input.agent_id)
      || session.calls.byAgentId.has(input.agent_id)) return;

    const transcriptPath = subagentTranscriptPath(session.transcriptPath, input.agent_id);
    const prompt = await readSubagentPrompt(transcriptPath);
    const match = matchAgent(session.calls, input.agent_type, prompt, input.prompt_id);
    if (match.kind === 'ambiguous') {
      this.log(
        'ERROR',
        `SubagentStart: ambiguous dispatch agentId=${input.agent_id} type=${input.agent_type}`,
      );
      return;
    }

    if (match.kind === 'found') {
      bindAgent(session.calls, match, input.agent_id, input.agent_type);
    } else {
      this.recoverAgent(
        session,
        input.agent_id,
        input.agent_type,
        input.prompt_id,
        prompt ?? '',
        'SubagentStart',
      );
    }
    this.log('INFO', `Subagent started: agentId=${input.agent_id} type=${input.agent_type}`);
  }

  private recoverAgent(
    session: TracedSession,
    agentId: string,
    agentType: string,
    promptId: string | undefined,
    prompt: string,
    event: 'SubagentStart' | 'SubagentStop',
  ): TracedAgent {
    const recovered = recoverAgentCall(session.calls, session.ensureTurn(promptId), {
      agentId,
      agentType,
      prompt,
      event,
    });
    this.log('INFO', `${event}: recovered agentId=${agentId} type=${agentType}`);
    return recovered;
  }

  private emitSubagentTranscript(
    parent: SpanParent,
    transcriptPath: string,
    agentType: string,
    seen?: Set<string>,
  ): { model?: string; text?: string } {
    let transcript: TranscriptFile | undefined;
    try {
      transcript = new TranscriptFile(transcriptPath);
      const turn = parseSessionFd(transcript.getFd())?.turns.at(-1);
      if (!turn) return {};
      emitChatSpans(parent, turn.responses, { agentName: agentType, seen });
      return { model: turn.model, text: turn.text.join('\n') || undefined };
    } catch (error) {
      this.log('DEBUG', `SubagentStop: could not parse transcript: ${error}`);
      return {};
    } finally {
      transcript?.close();
    }
  }

  private async handleSubagentStop(
    sessionId: string,
    input: SubagentStopHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session || session.calls.agentTombstones.has(input.agent_id)) return;

    const transcriptPath = input.agent_transcript_path
      ?? subagentTranscriptPath(session.transcriptPath, input.agent_id);
    const active = session.calls.byAgentId.get(input.agent_id);
    let prompt = active?.prompt;
    if (!prompt) {
      prompt = await readSubagentPrompt(transcriptPath);
      if (active && prompt) backfillAgentPrompt(active, prompt);
    }
    const match: AgentMatch = active
      ? { kind: 'found', call: active }
      : matchAgent(session.calls, input.agent_type, prompt, input.prompt_id);

    if (match.kind === 'found' && !match.call.agentId) {
      bindAgent(session.calls, match, input.agent_id, input.agent_type);
      this.log(
        'INFO',
        `SubagentStop: late-matched agentId=${input.agent_id} type=${input.agent_type}`,
      );
    }

    const turn = session.turnForPrompt(input.prompt_id);
    const recovered = match.kind === 'missing'
      ? this.recoverAgent(
        session,
        input.agent_id,
        input.agent_type,
        input.prompt_id,
        prompt ?? '',
        'SubagentStop',
      )
      : undefined;
    const lifecycle = match.kind === 'found' ? match.call : recovered;
    const parent = match.kind === 'found'
      ? match.call.span
      : recovered?.span ?? turn?.span;
    if (!parent) {
      this.log(
        'ERROR',
        `SubagentStop: no parent agentId=${input.agent_id} type=${input.agent_type}`,
      );
      return;
    }

    const seen = responseKeysForAgent(session.calls, input.agent_id, lifecycle);
    const transcript = this.emitSubagentTranscript(
      parent,
      transcriptPath,
      input.agent_type,
      seen,
    );
    const text = mergeSubagentOutput(transcript.text, input.last_assistant_message);

    if (match.kind === 'found') {
      if (transcript.model) {
        match.call.span.setAttributes({ [ATTR.RESPONSE_MODEL]: transcript.model });
      }
      if (!match.call.toolUseId && text) {
        match.call.span.setAttributes({
          [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([text]),
        });
      }
      recordAgentStop(session.calls, match);
    } else if (recovered) {
      if (transcript.model) {
        recovered.span.setAttributes({ [ATTR.RESPONSE_MODEL]: transcript.model });
      }
      if (text) {
        recovered.span.setAttributes({
          [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages([text]),
        });
      }
    }

    this.log(
      'DEBUG',
      `Subagent stopped: agentId=${input.agent_id} type=${input.agent_type} model=${transcript.model ?? 'unknown'} match=${match.kind}`,
    );
    session.finishSupersededTurns();
  }

  private async handleStop(sessionId: string, input: StopHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;

    const snapshot = await session.snapshotStop(
      input.prompt_id,
      input.last_assistant_message,
    );
    this.log(
      'DEBUG',
      `Stop: session=${sessionId} transcript_path=${session.transcriptPath} responses=${snapshot.responseCount} model=${snapshot.model ?? 'unknown'} last_assistant_message_present=${Boolean(input.last_assistant_message)}`,
    );
    this.log('INFO', 'Recorded turn stop snapshot');
  }

  private async handleSessionEnd(
    sessionId: string,
    input: SessionEndHookInput,
  ): Promise<void> {
    this.pendingInstructions.delete(sessionId);
    const session = this.sessions.get(sessionId)
      ?? await this.getOrReconstructSession(sessionId, input);
    if (!session) return;

    const turnCount = session.finishAtSessionEnd(input.prompt_id);
    this.log(
      'DEBUG',
      `SessionEnd: session=${sessionId} reason=${input.reason} transcript_path=${session.transcriptPath} turns=${turnCount}`,
    );
    this.sessions.delete(sessionId);
    session.close();
    this.log('INFO', `Finished session ${sessionId}`);
  }

  hasInFlightWork(): boolean {
    for (const session of this.sessions.values()) {
      if (session.hasInFlightWork()) return true;
    }
    return false;
  }

  /** Admission must be stopped before taking this snapshot. */
  async waitForPendingEvents(): Promise<void> {
    await Promise.all([...this.sessionQueues.values()]);
  }

  finalizeForShutdown(): void {
    for (const session of this.sessions.values()) {
      try {
        session.finishOpenTurns('daemon_shutdown');
      } catch (err) {
        this.log('ERROR', `Error finalizing session ${session.sessionId} at shutdown: ${err}`);
      }
    }
  }

  closeTranscripts(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
  }
}
