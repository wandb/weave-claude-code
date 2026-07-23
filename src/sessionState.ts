// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as weave from 'weave';
import { VERSION } from './setup.js';
import { TranscriptFile, readFirstTranscriptLine } from './transcriptFile.js';
import { ATTR, buildIntegrationAttrs } from './genaiSpans.js';
import type { CompactionAttrs } from './genaiSpans.js';

export type TurnTrace = {
  span: weave.Turn;
  promptId?: string;
  userText?: string;
  /** A Stop snapshot is quiescent but remains reopenable because hooks block. */
  phase: 'active' | 'stopped';
  /** Number of provider responses already present when this prompt began. */
  responseOffset: number;
  /** Frozen when a newer prompt starts, preventing cross-turn replay. */
  responseLimit?: number;
  /** Supports repeated/blockable Stop hooks without duplicate chat spans. */
  seenResponses: Set<string>;
};

export type SessionState = {
  sessionId: string;
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel?: string;
  conversation: weave.Conversation;

  /** Canonical live turns plus foreground/prompt lookup indexes. */
  turns: Set<TurnTrace>;
  currentTurn?: TurnTrace;
  turnsByPromptId: Map<string, TurnTrace>;

  /** Compaction attrs buffered while no turn span is open. */
  pendingCompaction?: CompactionAttrs;

  /** File path → latest loaded contents, preserving first-load order. */
  systemInstructions: Map<string, string>;
};

export function turnForPrompt(
  session: SessionState,
  promptId: string | undefined,
): TurnTrace | undefined {
  return promptId === undefined
    ? session.currentTurn
    : session.turnsByPromptId.get(promptId);
}

type NewSessionStateOptions = {
  sessionId: string;
  conversationId: string;
  transcript: TranscriptFile;
  cwd: string;
  source: string;
  initialRequestModel: string | undefined;
  agentName: string;
};

export function newSessionState(options: NewSessionStateOptions): SessionState {
  const version = readFirstTranscriptLine(options.transcript.resolvedPath)?.version;
  const integrationAttrs = buildIntegrationAttrs({
    version: VERSION,
    meta: { claude_code_app_version: version },
  });
  const conversation = weave.startConversation({
    conversationId: options.conversationId,
    agentName: options.agentName,
    attributes: { ...integrationAttrs, [ATTR.WEAVE_PLUGIN_VERSION]: VERSION },
  });

  return {
    sessionId: options.sessionId,
    conversationId: options.conversationId,
    transcript: options.transcript,
    cwd: options.cwd,
    source: options.source,
    initialRequestModel: options.initialRequestModel,
    conversation,
    turns: new Set(),
    turnsByPromptId: new Map(),
    systemInstructions: new Map(),
  };
}
