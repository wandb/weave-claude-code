// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type * as weave from 'weave';
import { emitChatSpans } from './chatSpans.js';
import {
  deferAgentOutcome,
  denyCall,
  finishAgentCall,
} from './callLifecycle.js';
import type { CallOutcome, TracedAgent } from './callLifecycle.js';
import { ATTR, assistantOutputMessages, parseTimestamp } from './genaiSpans.js';
import type { ParsedTurn } from './parser.js';
import { VERSION } from './setup.js';
import { readTeammateTurns } from './teamTranscripts.js';
import type { TracedSession } from './tracedSession.js';

type PendingTeam = {
  session: TracedSession;
  call: TracedAgent;
  teamName: string;
  memberName: string;
  sequence: number;
};

export type TeamCompletion = {
  owner: TracedSession;
  teamName: string;
  memberName: string;
};

export type TeamUpdate = {
  handled: boolean;
  completions: TeamCompletion[];
};

export type TeamIdleUpdate = {
  status: 'missing' | 'ambiguous' | 'completed';
  completions: TeamCompletion[];
};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function emitTeammate(
  conversation: weave.Conversation,
  memberName: string,
  turns: ParsedTurn[],
): { model?: string; text?: string } {
  const responses = turns.flatMap(turn => turn.responses);
  const model = turns.filter(turn => turn.model).at(-1)?.model;
  const span = conversation.startTurn({
    agentName: memberName,
    agentVersion: VERSION,
    model,
    userMessage: turns[0]?.userText,
    startTime: parseTimestamp(turns[0]?.startTime ?? responses[0]?.startTime),
  });
  span.setAttributes({ [ATTR.WEAVE_DISPLAY_NAME]: `Teammate: ${memberName}` });
  try {
    emitChatSpans(span, responses, { agentName: memberName });
    const output = turns.flatMap(turn => turn.text);
    if (output.length) {
      span.setAttributes({ [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages(output) });
    }
    if (model) span.record({ model });
    return { model, text: turns.at(-1)?.text.join('\n') || undefined };
  } finally {
    span.end({ endTime: parseTimestamp(responses.at(-1)?.endTime) ?? new Date() });
  }
}

/** Correlates explicit Agent Team dispatches with their cross-session idle
 * event. Recovery and weak-evidence matching are deliberately separate. */
export class TeamCoordinator {
  private readonly pending = new Set<PendingTeam>();

  registerDispatch(
    session: TracedSession,
    call: TracedAgent,
    sequence: number,
  ): void {
    if (!call.toolUseId || this.has(call)) return;
    const teamName = text(call.input['team_name']);
    if (!teamName) return;
    this.pending.add({
      session,
      call,
      teamName,
      memberName: text(call.input['name']) ?? call.agentType,
      sequence,
    });
  }

  has(call: TracedAgent): boolean {
    return [...this.pending].some(candidate => candidate.call === call);
  }

  postOutcome(call: TracedAgent, outcome: CallOutcome): TeamUpdate {
    const pending = this.find(call);
    if (!pending) return { handled: false, completions: [] };
    if (outcome.kind === 'success') {
      deferAgentOutcome(call, outcome);
      return { handled: true, completions: [] };
    }

    finishAgentCall(pending.session.calls, call, { outcome });
    this.pending.delete(pending);
    return { handled: true, completions: [this.completed(pending)] };
  }

  async recordIdle(input: {
    sequence: number;
    teamName: string;
    memberName: string;
    transcriptPath?: string;
  }): Promise<TeamIdleUpdate> {
    const candidates = [...this.pending].filter(candidate =>
      candidate.sequence < input.sequence
      && candidate.teamName === input.teamName
      && candidate.memberName === input.memberName
      && candidate.call.outcome?.kind === 'success');
    if (candidates.length !== 1) {
      return {
        status: candidates.length ? 'ambiguous' : 'missing',
        completions: [],
      };
    }

    const [pending] = candidates;
    const turns = input.transcriptPath
      ? readTeammateTurns(input.transcriptPath)
      : [];
    if (!turns.length) return { status: 'missing', completions: [] };

    const emitted = emitTeammate(
      pending.session.conversation,
      pending.memberName,
      turns,
    );
    if (emitted.model) {
      pending.call.span.setAttributes({ [ATTR.RESPONSE_MODEL]: emitted.model });
    }
    const original = pending.call.outcome;
    finishAgentCall(pending.session.calls, pending.call, {
      outcome: {
        kind: 'success',
        value: emitted.text ?? (original?.kind === 'success' ? original.value : undefined),
      },
    });
    this.pending.delete(pending);
    return { status: 'completed', completions: [this.completed(pending)] };
  }

  deny(call: TracedAgent, reason: string): TeamCompletion[] | undefined {
    const pending = this.find(call);
    if (!pending || !call.toolUseId) return undefined;
    denyCall(pending.session.calls, call.toolUseId, reason);
    this.pending.delete(pending);
    return [this.completed(pending)];
  }

  orphanSession(sessionId: string, reason: string, endTime: Date): void {
    for (const pending of [...this.pending]) {
      if (pending.session.sessionId !== sessionId) continue;
      finishAgentCall(
        pending.session.calls,
        pending.call,
        { orphanReason: reason },
        endTime,
      );
      this.pending.delete(pending);
    }
  }

  private find(call: TracedAgent): PendingTeam | undefined {
    return [...this.pending].find(candidate => candidate.call === call);
  }

  private completed(pending: PendingTeam): TeamCompletion {
    return {
      owner: pending.session,
      teamName: pending.teamName,
      memberName: pending.memberName,
    };
  }
}
