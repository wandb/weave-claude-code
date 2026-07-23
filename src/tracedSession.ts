// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import type { Attributes } from '@opentelemetry/api';
import * as weave from 'weave';
import { emitChatSpans } from './chatSpans.js';
import {
  ATTR,
  assistantOutputMessages,
  buildIntegrationAttrs,
  parseTimestamp,
  setCompactionAttrs,
} from './genaiSpans.js';
import type { CompactionAttrs } from './genaiSpans.js';
import { finalizeOpenCalls, newCallState } from './callLifecycle.js';
import type { TracedCall } from './callLifecycle.js';
import {
  assistantResponses,
  extractAssistantTextBlocks,
  lastAssistantTextEndsWith,
  parseSessionFd,
} from './parser.js';
import type { AssistantResponse, ParsedSession } from './parser.js';
import { VERSION } from './setup.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';

type TraceLog = (level: 'DEBUG' | 'INFO' | 'ERROR', message: string) => void;

export type TurnTrace = {
  kind: 'turn';
  span: weave.Turn;
  promptId?: string;
  userText?: string;
  /** A Stop snapshot is quiescent but remains reopenable because hooks block. */
  phase: 'active' | 'stopped';
  /** Calls are owned by their parent span; hook ids are only lookup indexes. */
  children: Set<TracedCall>;
  /** Number of provider responses already present when this prompt began. */
  responseOffset: number;
  /** Frozen when a newer prompt starts, preventing cross-turn replay. */
  responseLimit?: number;
  /** Supports repeated/blockable Stop hooks without duplicate chat spans. */
  seenResponses: Set<string>;
};

type NewSessionOptions = {
  sessionId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel?: string;
  agentName: string;
  log: TraceLog;
};

type StartTurnOptions = {
  promptId?: string;
  userMessage?: string;
  recoverCurrentTurn?: boolean;
  responseOffsetFloor?: number;
  makeCurrent?: boolean;
};

export class TracedSession {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly transcript: TranscriptFile;
  readonly cwd: string;
  readonly source: string;
  readonly initialRequestModel?: string;

  /** File path → latest loaded contents, preserving first-load order. */
  private readonly systemInstructions = new Map<string, string>();
  private readonly turns = new Set<TurnTrace>();
  readonly calls = newCallState();
  private currentTurn?: TurnTrace;
  private pendingCompaction?: CompactionAttrs;

  private constructor(
    options: NewSessionOptions,
    conversationId: string,
    private readonly log: TraceLog,
  ) {
    this.sessionId = options.sessionId;
    this.conversationId = conversationId;
    this.transcript = options.transcript;
    this.cwd = options.cwd;
    this.source = options.source;
    this.initialRequestModel = options.initialRequestModel;

    const version = readFirstTranscriptLine(options.transcript.resolvedPath)?.version;
    const integrationAttrs = buildIntegrationAttrs({
      version: VERSION,
      meta: { claude_code_app_version: version },
    });
    this.conversation = weave.startConversation({
      conversationId,
      agentName: options.agentName,
      attributes: { ...integrationAttrs, [ATTR.WEAVE_PLUGIN_VERSION]: VERSION },
    });
  }

  private readonly conversation: weave.Conversation;

  static async create(options: NewSessionOptions): Promise<TracedSession> {
    const conversationId = await resolveConversationId(
      options.sessionId,
      options.transcript.resolvedPath,
      options.log,
    );
    return new TracedSession(options, conversationId, options.log);
  }

  get transcriptPath(): string {
    return this.transcript.resolvedPath;
  }

  setInstruction(filePath: string, content: string): void {
    this.systemInstructions.set(filePath, content);
  }

  submitPrompt(
    promptId: string | undefined,
    prompt: string,
  ): { created: boolean; replacedOpenTurn: boolean } {
    if (promptId !== undefined && this.turnForPrompt(promptId)) {
      return { created: false, replacedOpenTurn: false };
    }

    const previous = this.currentTurn;
    let responseOffsetFloor: number | undefined;
    if (previous) {
      previous.responseLimit ??= assistantResponses(
        parseSessionFd(this.transcript.getFd()) ?? { turns: [] },
      ).length;
      responseOffsetFloor = previous.responseLimit;
      if (promptId === undefined || previous.children.size === 0) {
        this.finalizeTurn(previous, 'superseded_by_next_prompt');
      }
    }

    const turn = this.startTurn({
      promptId,
      userMessage: prompt,
      responseOffsetFloor,
    });
    if (this.pendingCompaction) {
      setCompactionAttrs(turn.span, this.pendingCompaction);
      this.pendingCompaction = undefined;
    }
    return { created: true, replacedOpenTurn: Boolean(previous) };
  }

  setCompaction(promptId: string | undefined, attrs: CompactionAttrs): boolean {
    const turn = this.turnForPrompt(promptId);
    if (!turn) {
      this.pendingCompaction = attrs;
      return false;
    }
    setCompactionAttrs(turn.span, attrs);
    return true;
  }

  async snapshotStop(
    promptId: string | undefined,
    lastAssistantMessage?: string,
  ): Promise<{ responseCount: number; model?: string }> {
    const turn = this.turnForPrompt(promptId) ?? this.ensureTurn(promptId);
    const parsed = await this.parseTranscriptWithRetry(lastAssistantMessage);
    const responses = parsed ? this.responsesForTurn(parsed, turn) : [];
    this.recordTurnOutput(turn, responses, { lastMessage: lastAssistantMessage });
    turn.phase = 'stopped';
    return {
      responseCount: responses.length,
      model: responses.filter(response => response.model).at(-1)?.model,
    };
  }

  finishAtSessionEnd(promptId: string | undefined): number {
    const parsed = this.parseTranscript();
    this.reconcileFinalTurn(promptId, parsed);
    return this.finishTurns('session_ended', parsed);
  }

  finishOpenTurns(orphanReason: string): number {
    return this.finishTurns(orphanReason, this.parseTranscript());
  }

  private finishTurns(
    orphanReason: string,
    parsed: ParsedSession | null,
  ): number {
    const turnCount = this.turns.size;
    for (const turn of [...this.turns]) {
      this.recordFinalTurnOutput(turn, orphanReason, parsed);
      this.closeTurn(turn, orphanReason);
    }
    return turnCount;
  }

  hasInFlightWork(): boolean {
    return [...this.turns].some(turn => turn.children.size > 0)
      || [...this.turns].some(turn => turn.phase === 'active');
  }

  close(): void {
    this.transcript.close();
  }

  turnForPrompt(promptId: string | undefined): TurnTrace | undefined {
    return promptId === undefined
      ? this.currentTurn
      : [...this.turns].find(turn => turn.promptId === promptId);
  }

  private transcriptCursor(
    options: StartTurnOptions,
  ): { responseOffset: number; startTime?: Date; userText?: string } {
    const parsed = parseSessionFd(this.transcript.getFd());
    if (!parsed) return { responseOffset: 0, userText: options.userMessage };

    const responses = assistantResponses(parsed);
    const current = parsed.turns.at(-1);
    const transcriptHasPrompt = options.userMessage !== undefined
      && current?.userText === options.userMessage;
    const includeCurrent = options.recoverCurrentTurn || transcriptHasPrompt;
    const responseOffset = includeCurrent
      ? responses.length - (current?.responses.length ?? 0)
      : responses.length;
    return {
      responseOffset: Math.max(responseOffset, options.responseOffsetFloor ?? 0),
      startTime: includeCurrent ? parseTimestamp(current?.startTime) : undefined,
      userText: options.userMessage ?? (includeCurrent ? current?.userText : undefined),
    };
  }

  private startTurn(options: StartTurnOptions = {}): TurnTrace {
    const cursor = this.transcriptCursor(options);
    const span = this.conversation.startTurn({
      agentVersion: VERSION,
      model: this.initialRequestModel,
      userMessage: cursor.userText,
      systemInstructions: [...this.systemInstructions.values()],
      startTime: cursor.startTime,
    });
    span.setAttributes({
      [ATTR.WEAVE_CWD]: this.cwd,
      [ATTR.WEAVE_SOURCE]: this.source,
    });
    const turn: TurnTrace = {
      kind: 'turn',
      span,
      promptId: options.promptId,
      userText: cursor.userText,
      phase: 'active',
      children: new Set(),
      responseOffset: cursor.responseOffset,
      seenResponses: new Set(),
    };
    this.turns.add(turn);
    if (options.makeCurrent !== false) this.currentTurn = turn;
    return turn;
  }

  ensureTurn(promptId: string | undefined): TurnTrace {
    return this.turnForPrompt(promptId) ?? this.startTurn({
      promptId,
      // An exact prompt_id must not claim the last transcript turn. A legacy
      // hook has no competing identity, so it can safely recover that turn.
      recoverCurrentTurn: promptId === undefined,
      makeCurrent: !this.currentTurn || this.currentTurn.promptId === promptId,
    });
  }

  private reconcileFinalTurn(
    promptId: string | undefined,
    parsed: ParsedSession | null,
  ): void {
    const finalTranscriptTurn = parsed?.turns.at(-1);
    if (!parsed || !finalTranscriptTurn) return;

    let turn = promptId === undefined
      ? [...this.turns].find(candidate =>
        candidate.userText !== undefined
        && candidate.userText === finalTranscriptTurn.userText)
        ?? (this.currentTurn?.promptId === undefined ? this.currentTurn : undefined)
      : this.turnForPrompt(promptId);
    const legacyTurn = this.currentTurn;
    if (!turn && promptId !== undefined && legacyTurn && legacyTurn.promptId === undefined) {
      turn = legacyTurn;
      turn.promptId = promptId;
    }
    const stoppedUnknownPrompt = promptId === undefined
      && this.currentTurn?.promptId !== undefined
      && this.currentTurn.phase === 'stopped';
    if (!turn && !stoppedUnknownPrompt) {
      turn = this.startTurn({
        promptId,
        userMessage: finalTranscriptTurn.userText,
        recoverCurrentTurn: true,
      });
    }
    if (!turn || turn.responseLimit !== undefined) return;

    const finalResponseOffset = assistantResponses(parsed).length
      - finalTranscriptTurn.responses.length;
    if (turn.userText === undefined) {
      // An exact prompt_id binds a root reconstructed from an earlier terminal
      // hook to the matching final transcript turn.
      turn.responseOffset = finalResponseOffset;
      turn.userText = finalTranscriptTurn.userText;
      if (turn.userText !== undefined) {
        turn.span.record({
          messages: [{ role: 'user', parts: [{ type: 'text', content: turn.userText }] }],
        });
      }
    } else {
      turn.responseOffset = Math.max(turn.responseOffset, finalResponseOffset);
    }
  }

  private responsesForTurn(
    parsed: ParsedSession,
    turn: TurnTrace,
  ): AssistantResponse[] {
    return assistantResponses(parsed).slice(turn.responseOffset, turn.responseLimit);
  }

  private recordTurnOutput(
    turn: TurnTrace,
    responses: AssistantResponse[],
    options: { lastMessage?: string; orphanReason?: string } = {},
  ): void {
    emitChatSpans(turn.span, responses, { seen: turn.seenResponses });

    const text = responses.flatMap(response => extractAssistantTextBlocks(response.content));
    if (!text.length && options.lastMessage) text.push(options.lastMessage);
    const attributes: Attributes = {};
    if (text.length) attributes[ATTR.OUTPUT_MESSAGES] = assistantOutputMessages(text);
    const finishReasons = responses
      .map(response => response.finishReason)
      .filter((reason): reason is string => Boolean(reason));
    if (finishReasons.length) attributes[ATTR.RESPONSE_FINISH_REASONS] = finishReasons;
    if (options.orphanReason) attributes[ATTR.WEAVE_ORPHAN_REASON] = options.orphanReason;
    if (Object.keys(attributes).length) turn.span.setAttributes(attributes);

    const model = responses.filter(response => response.model).at(-1)?.model;
    if (model) turn.span.record({ model });
  }

  private recordFinalTurnOutput(
    turn: TurnTrace,
    orphanReason: string,
    parsed: ParsedSession | null,
  ): void {
    const responses = parsed ? this.responsesForTurn(parsed, turn) : [];
    this.recordTurnOutput(turn, responses, {
      orphanReason: turn.phase === 'active' ? orphanReason : undefined,
    });
  }

  private finalizeTurn(turn: TurnTrace, orphanReason: string): void {
    this.recordFinalTurnOutput(turn, orphanReason, this.parseTranscript());
    this.closeTurn(turn, orphanReason);
  }

  private closeTurn(turn: TurnTrace, orphanReason: string): void {
    for (const toolUseId of finalizeOpenCalls(this.calls, [turn], orphanReason)) {
      this.log('DEBUG', `Closed pending call: ${toolUseId}`);
    }
    turn.span.end();
    this.turns.delete(turn);
    if (this.currentTurn === turn) this.currentTurn = undefined;
  }

  finishSupersededTurns(): void {
    for (const turn of [...this.turns]) {
      if (turn.responseLimit !== undefined && turn.children.size === 0) {
        this.finalizeTurn(turn, 'superseded_by_next_prompt');
      }
    }
  }

  private parseTranscript(): ParsedSession | null {
    try {
      return parseSessionFd(this.transcript.getFd());
    } catch (error) {
      this.log('DEBUG', `Could not recover chat spans while closing turn: ${error}`);
      return null;
    }
  }

  /** Retry parsing while the transcript writer catches up to Stop. */
  private async parseTranscriptWithRetry(
    finalAssistantMessage?: string,
    attempts = 5,
    delayMs = 200,
  ): Promise<ParsedSession | null> {
    let fd: number;
    try {
      fd = this.transcript.getFd();
    } catch (err) {
      this.log('ERROR', `Cannot open transcript for parsing: ${err}`);
      return null;
    }
    const expected = (finalAssistantMessage ?? '').trimEnd();
    let result: ParsedSession | null = null;
    for (let i = 0; i < attempts; i++) {
      result = parseSessionFd(fd);
      if (result?.turns.length && (!expected || lastAssistantTextEndsWith(result, expected))) {
        return result;
      }
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return result;
  }
}

async function resolveConversationId(
  sessionId: string,
  transcriptPath: string,
  log: TraceLog,
): Promise<string> {
  const MAX_CHAIN_DEPTH = 32;
  const MAX_HEAD_READ_ATTEMPTS = 4;
  const HEAD_READ_RETRY_MS = 100;

  const transcriptDir = path.dirname(transcriptPath);
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  let currentPath = transcriptPath;

  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    let parent: string | undefined;
    const attempts = depth === 0 ? MAX_HEAD_READ_ATTEMPTS : 1;
    for (let i = 0; i < attempts; i++) {
      const head = readFirstTranscriptLine(currentPath);
      if (head?.forkedFrom?.sessionId) {
        parent = head.forkedFrom.sessionId;
        break;
      }
      if (head !== undefined) break;
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, HEAD_READ_RETRY_MS));
    }
    if (!parent || seen.has(parent)) break;
    seen.add(parent);

    const parentPath = path.join(transcriptDir, `${parent}.jsonl`);
    current = parent;
    if (!fs.existsSync(parentPath)) {
      log(
        'DEBUG',
        `resolveConversationId: parent transcript not on disk: ${parentPath} — stopping chain walk at ${parent}`,
      );
      break;
    }
    currentPath = parentPath;
  }

  return current;
}
