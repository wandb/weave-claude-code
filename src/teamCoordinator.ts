// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as path from 'path';
import type * as weave from 'weave';
import { deferAgentOutcome, denyCall, finishAgentCall } from './callLifecycle.js';
import type { CallOutcome, TracedAgent } from './callLifecycle.js';
import { emitChatSpans } from './chatSpans.js';
import { ATTR, assistantOutputMessages, parseTimestamp } from './genaiSpans.js';
import type { ParsedTurn } from './parser.js';
import type { TracedSession } from './tracedSession.js';
import { VERSION } from './setup.js';
import * as teamTranscripts from './teamTranscripts.js';
import type {
  TeamTranscriptEvidenceContext,
  TeamTranscriptProgress,
  TeamTranscriptSnapshot,
} from './teamTranscripts.js';

type Idle = {
  sequence: number; sessionId: string; teamName: string; memberName: string;
  transcriptPath?: string; transcriptSnapshots: TeamTranscriptSnapshot[];
  receiptFingerprint?: string; selectedPath?: string; fingerprint?: string;
  agentType?: string;
};
type Reservation = { idle: Idle; transcriptPath: string };
type PendingBase = {
  session: TracedSession; call: TracedAgent;
  memberName: string; teamName?: string; sequence: number;
  /** A Post hook recovered this dispatch without observing its earlier Pre. */
  recoveredWithoutPre: boolean;
  lifecyclePath?: string;
  reservation?: Reservation;
};
type Pending =
  | PendingBase & { kind: 'dispatch' }
  | PendingBase & { kind: 'lifecycle' };
type IdleHistory = { idle: Idle; completed: boolean };
type Match = [Pending, string] | 'missing' | 'ambiguous';
export type TeamCompletion = {
  mode: 'cross-session' | 'same-session';
  owner: TracedSession;
  teamName?: string;
  memberName: string;
};
type TeamPostUpdate = { handled: boolean; completions: TeamCompletion[] };
type TeamStopUpdate = { handled: boolean; completions: TeamCompletion[] };
type TeamIdleUpdate = {
  status: 'duplicate' | 'missing' | 'ambiguous' | 'buffered' | 'retry' | 'completed';
  completions: TeamCompletion[];
};

const SEP = '\0';
const MAX_CALLS = 256;
const MAX_IDLE_HISTORY = 512;
const MAX_PROGRESS_CURSORS = 1024;
const isDispatch = (
  pending: Pending,
): pending is Extract<Pending, { kind: 'dispatch' }> => pending.kind === 'dispatch';
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const idleKey = (idle: Pick<Idle, 'teamName' | 'memberName' | 'sessionId'>) =>
  JSON.stringify([idle.teamName, idle.memberName, idle.sessionId]);

/** Resolve only a transcript tied to this Agent type and idle session. */
function transcriptFor(
  pending: Pending,
  idle: Idle,
  context: TeamTranscriptEvidenceContext,
): { path: string; strong: boolean } | 'ambiguous' | undefined {
  const exact = (candidate?: string) => teamTranscripts.matchTranscript(
    candidate,
    idle.sessionId,
    pending.call.declaredAgentType,
    context,
  );
  const hook = exact(idle.transcriptPath);
  if (hook === 'ambiguous') return 'ambiguous';
  const sameSession = pending.session.sessionId === idle.sessionId;
  const metadata = teamTranscripts.findMetadata(
    pending.session.transcript.resolvedPath,
    pending.call.declaredAgentType,
    idle.sessionId,
    context,
  );
  if (metadata === 'ambiguous') {
    return hook && !sameSession ? { path: hook, strong: false } : 'ambiguous';
  }
  // Cross-session hooks may carry the freshest teammate output. For a
  // same-session lifecycle, the hook path is the coordinator transcript, so
  // its lifecycle/metadata transcript remains authoritative.
  if (metadata.length === 1) {
    return { path: sameSession ? metadata[0] : hook ?? metadata[0], strong: true };
  }
  const lifecycle = exact(pending.lifecyclePath);
  if (lifecycle === 'ambiguous') return 'ambiguous';
  if (lifecycle) {
    return { path: sameSession ? lifecycle : hook ?? lifecycle, strong: true };
  }
  return hook ? { path: hook, strong: false } : undefined;
}
function emitTeammate(
  conversation: weave.Conversation, memberName: string, turns: ParsedTurn[],
): { model?: string; text?: string } {
  const responses = turns.flatMap(turn => turn.responses);
  const model = turns.filter(turn => turn.model).at(-1)?.model;
  const span = conversation.startTurn({
    agentName: memberName, agentVersion: VERSION, model,
    userMessage: turns[0]?.userText,
    startTime: parseTimestamp(turns[0]?.startTime ?? responses[0]?.startTime),
  });
  span.setAttributes({ [ATTR.WEAVE_DISPLAY_NAME]: `Teammate: ${memberName}` });
  try {
    emitChatSpans(span, responses, { agentName: memberName });
    const output = turns.flatMap(turn => turn.text);
    if (output.length) span.setAttributes({ [ATTR.OUTPUT_MESSAGES]: assistantOutputMessages(output) });
    if (model) span.record({ model });
    return { model, text: turns.at(-1)?.text.join('\n') || undefined };
  } finally {
    span.end({ endTime: parseTimestamp(responses.at(-1)?.endTime) ?? new Date() });
  }
}
/** The bounded join state missing from Claude's cross-session team hooks. */
export class TeamCoordinator {
  private calls: Pending[] = [];
  private idleHistory: IdleHistory[] = [];
  /** Retain logical teammate cursors for this daemon's lifetime. Once full,
   * existing cursors continue advancing while new identities fail closed. */
  private progress = new Map<string, TeamTranscriptProgress>();
  private progressOwners = new Map<string, string>();

  /** Capture every output path that current correlation evidence could select. */
  snapshotTranscripts(
    sessionId: unknown,
    transcriptPath: unknown,
    sessions: Iterable<TracedSession>,
    recentTranscripts: Iterable<string>,
  ): TeamTranscriptSnapshot[] {
    const pending = this.calls;
    function* transcriptRoots() {
      yield* recentTranscripts;
      for (const session of sessions) yield session.transcript.resolvedPath;
      for (const call of pending) yield call.session.transcript.resolvedPath;
    }
    return teamTranscripts.snapshotTranscripts({
      sessionId,
      transcriptPath,
      lifecyclePaths: this.calls.map(pending => pending.lifecyclePath),
      transcriptRoots: transcriptRoots(),
    });
  }

  static isDispatchInput(input: Record<string, unknown>): boolean {
    return text(input['name']) !== undefined || text(input['team_name']) !== undefined;
  }
  registerDispatch(
    session: TracedSession,
    call: TracedAgent,
    sequence: number,
    recoveredWithoutPre = false,
  ) {
    if (!call.toolUseId || !TeamCoordinator.isDispatchInput(call.input)) return undefined;
    let pending = this.find(call);
    if (!pending) {
      if (this.calls.length >= MAX_CALLS) return undefined;
      pending = {
        kind: 'dispatch', session, call, sequence, recoveredWithoutPre,
        memberName: text(call.input['name']) ?? call.agentType,
        teamName: text(call.input['team_name']),
      };
      this.calls.push(pending);
    }
    const depth = this.calls.filter(call => isDispatch(call)
      && call.memberName === pending.memberName && call.teamName === pending.teamName).length;
    return { teamName: pending.teamName, memberName: pending.memberName, depth };
  }
  private find(call: TracedAgent) { return this.calls.find(pending => pending.call === call); }
  has(call: TracedAgent): boolean { return this.find(call) !== undefined; }
  async postOutcome(call: TracedAgent, outcome: CallOutcome): Promise<TeamPostUpdate> {
    const pending = this.find(call);
    if (!pending || !isDispatch(pending)) return { handled: false, completions: [] };

    if (outcome.kind === 'failure') {
      if (pending.teamName === undefined) {
        this.remove(pending);
        return { handled: false, completions: (await this.reconcile()).completions };
      }
      finishAgentCall(pending.session.calls, call, { outcome });
      const completion = this.completed(pending);
      return {
        handled: true,
        completions: [completion, ...(await this.reconcile()).completions],
      };
    }

    deferAgentOutcome(call, outcome);
    const confirmed = pending.teamName !== undefined;
    const completions = (await this.reconcile()).completions;
    return {
      // A candidate completed from verified transcript progress is already
      // tombstoned; otherwise ordinary Agent Stop/Post remains authoritative.
      handled: confirmed || !this.find(call),
      completions,
    };
  }
  classifyLifecycle(
    session: TracedSession,
    memberName: string,
    transcriptPath: string,
  ): 'dispatch' | 'idle' | 'ambiguous' | undefined {
    if (!teamTranscripts.isAgentSetting(transcriptPath)) return undefined;
    // An enclosing teammate session can start ordinary child Agents. Require
    // team evidence in this lifecycle's own transcript before suppressing or
    // deferring anything.
    const team = teamTranscripts.teamName(transcriptPath);
    if (!team) return undefined;
    const correlationContext = teamTranscripts.newEvidenceContext();
    const candidates = this.calls.filter(pending => isDispatch(pending)
      && (!pending.teamName || pending.teamName === team));
    const evidence = candidates.map(pending => ({
      pending,
      paths: teamTranscripts.findMetadata(
        pending.session.transcript.resolvedPath,
        pending.call.declaredAgentType,
        session.sessionId,
        correlationContext,
      ),
    }));
    if (evidence.some(candidate => candidate.paths === 'ambiguous')) return 'ambiguous';
    const inferred = evidence.flatMap(candidate =>
      candidate.paths !== 'ambiguous' && candidate.paths.length === 1
        ? [candidate.pending]
        : []);
    if (inferred.length) {
      return new Set(inferred.map(pending => pending.call.root)).size === 1
        && new Set(inferred.map(pending => pending.call.parent)).size === 1
        ? 'dispatch' : 'ambiguous';
    }
    if (this.idleHistory.some(entry => entry.completed
      && entry.idle.teamName === team
      && entry.idle.sessionId === session.sessionId
      && entry.idle.agentType === memberName)) return 'dispatch';
    return 'idle';
  }
  registerIdle(
    session: TracedSession,
    call: TracedAgent,
    memberName: string,
    transcriptPath: string,
    sequence: number,
  ): void {
    if (this.has(call) || this.calls.length >= MAX_CALLS) return;
    deferAgentOutcome(call, { kind: 'success', value: undefined });
    this.calls.push({
      kind: 'lifecycle', session, call, memberName, sequence,
      recoveredWithoutPre: false,
      teamName: teamTranscripts.teamName(transcriptPath),
      lifecyclePath: transcriptPath,
    });
  }
  async stop(call: TracedAgent, transcriptPath: string): Promise<TeamStopUpdate> {
    const pending = this.find(call);
    if (!pending) return { handled: false, completions: [] };
    const teamName = teamTranscripts.teamName(transcriptPath);
    if (pending.teamName === undefined && !teamName) {
      this.remove(pending);
      return { handled: false, completions: (await this.reconcile()).completions };
    }
    pending.lifecyclePath = transcriptPath;
    pending.teamName ??= teamName;
    return { handled: true, completions: (await this.reconcile()).completions };
  }
  async recordIdle(input: {
    sequence: number; sessionId: string; teamName: string;
    memberName: string; idleTranscriptPath?: string;
    transcriptSnapshots?: TeamTranscriptSnapshot[];
  }): Promise<TeamIdleUpdate> {
    const transcriptSnapshots = input.transcriptSnapshots ?? [];
    const idle: Idle = {
      sequence: input.sequence, sessionId: input.sessionId,
      teamName: input.teamName, memberName: input.memberName,
      transcriptPath: input.idleTranscriptPath,
      transcriptSnapshots,
      receiptFingerprint: teamTranscripts.receiptFingerprint(transcriptSnapshots),
    };
    const key = idleKey(idle);
    const buffered = idle.receiptFingerprint
      ? this.idleHistory.find(entry =>
        !entry.completed && idleKey(entry.idle) === key
        && entry.idle.receiptFingerprint === idle.receiptFingerprint)
      : undefined;
    const occurrence = buffered?.idle ?? idle;
    if (!buffered) this.rememberIdle({ idle: occurrence, completed: false });

    const reconciled = await this.reconcile();
    if (reconciled.completions.length) {
      return { status: 'completed', completions: reconciled.completions };
    }
    if (reconciled.duplicates.has(occurrence)) return { status: 'duplicate', completions: [] };
    if (reconciled.retried.has(occurrence)) return { status: 'retry', completions: [] };
    if (this.calls.some(pending => pending.reservation?.idle === occurrence)) {
      return { status: 'buffered', completions: [] };
    }
    const match = this.match(occurrence);
    return {
      status: typeof match === 'string' ? match : 'buffered',
      completions: [],
    };
  }

  /** Match every buffered idle made unambiguous by the current transition.
   * A transcript retry rolls back its reservation for a later event. */
  private async reconcile(): Promise<{
    completions: TeamCompletion[];
    retried: Set<Idle>;
    duplicates: Set<Idle>;
  }> {
    const completions: TeamCompletion[] = [];
    const attempted = new Set<Idle>();
    const retried = new Set<Idle>();
    const duplicates = new Set<Idle>();
    const correlationContext = teamTranscripts.newEvidenceContext();
    for (;;) {
      let pending = this.calls.find(candidate => candidate.reservation
        && candidate.call.outcome && !attempted.has(candidate.reservation.idle));
      if (!pending) {
        for (const entry of this.idleHistory) {
          if (entry.completed || attempted.has(entry.idle)
            || this.calls.some(candidate => candidate.reservation?.idle === entry.idle)) continue;
          const match = this.match(entry.idle, correlationContext);
          if (typeof match === 'string') continue;
          const [matched, transcriptPath] = match;
          const snapshot = teamTranscripts.snapshotFor(
            transcriptPath,
            entry.idle.transcriptSnapshots,
          );
          const fingerprint = teamTranscripts.snapshotFingerprint(snapshot);
          const selectedPath = snapshot?.path ?? path.resolve(transcriptPath);
          if (fingerprint && this.idleHistory.some(previous => previous.completed
            && idleKey(previous.idle) === idleKey(entry.idle)
            && previous.idle.selectedPath === selectedPath
            && previous.idle.fingerprint === fingerprint)) {
            attempted.add(entry.idle);
            duplicates.add(entry.idle);
            this.idleHistory = this.idleHistory.filter(previous => previous !== entry);
            continue;
          }
          entry.idle.selectedPath = selectedPath;
          entry.idle.fingerprint = fingerprint;
          pending = matched;
          pending.reservation = { idle: entry.idle, transcriptPath };
          break;
        }
      }
      const reservation = pending?.reservation;
      if (!pending || !reservation) break;
      const idle = reservation.idle;
      attempted.add(idle);
      const outcome = pending.call.outcome;
      if (!outcome) continue;
      const completion = await this.finish(pending, reservation, outcome);
      if (completion) completions.push(completion);
      else retried.add(idle);
    }
    return { completions, retried, duplicates };
  }
  private match(
    idle: Idle,
    correlationContext = teamTranscripts.newEvidenceContext(),
  ): Match {
    let candidates = this.calls.filter(pending => !pending.reservation
      && pending.memberName === idle.memberName
      && (!pending.teamName || pending.teamName === idle.teamName)
      && (isDispatch(pending)
        ? pending.recoveredWithoutPre || pending.sequence < idle.sequence
        : pending.session.sessionId === idle.sessionId && pending.sequence < idle.sequence));
    const exactTeam = candidates.filter(pending => pending.teamName === idle.teamName);
    if (exactTeam.length) candidates = exactTeam;
    const resolved: Array<[Pending, { path: string; strong: boolean }]> = [];
    for (const pending of candidates) {
      const transcript = transcriptFor(pending, idle, correlationContext);
      if (transcript === 'ambiguous') return 'ambiguous';
      if (transcript) resolved.push([pending, transcript]);
    }
    if (!resolved.length) return 'missing';
    const strong = resolved.filter(([, transcript]) => transcript.strong);
    const pool = strong.length ? strong : resolved;
    if (pool.some(([pending]) => !isDispatch(pending))) {
      if (pool.length !== 1) return 'ambiguous';
    } else if (new Set(pool.map(([pending]) => pending.call.root)).size !== 1
      || new Set(pool.map(([pending]) => pending.call.parent)).size !== 1) {
      return 'ambiguous';
    }
    pool.sort(([a], [b]) => {
      if (a.recoveredWithoutPre !== b.recoveredWithoutPre) {
        return a.recoveredWithoutPre ? -1 : 1;
      }
      return a.sequence - b.sequence;
    });
    return [pool[0][0], pool[0][1].path];
  }
  private async finish(
    pending: Pending,
    reservation: Reservation,
    outcome: CallOutcome,
  ): Promise<TeamCompletion | undefined> {
    const { idle, transcriptPath } = reservation;
    const snapshot = teamTranscripts.snapshotFor(
      transcriptPath,
      idle.transcriptSnapshots,
    );
    if (!snapshot) {
      pending.reservation = undefined;
      return undefined;
    }
    const cursorKey = idleKey(idle);
    const identityKey = [
      snapshot.device,
      snapshot.inode,
      snapshot.created,
    ].join(SEP);
    const identityOwner = this.progressOwners.get(identityKey);
    if (identityOwner && identityOwner !== cursorKey) {
      pending.reservation = undefined;
      return undefined;
    }
    const prior = this.progress.get(cursorKey);
    if (!prior && this.progress.size >= MAX_PROGRESS_CURSORS) {
      pending.reservation = undefined;
      return undefined;
    }
    const parsed = await teamTranscripts.readNewTurns(
      transcriptPath,
      prior,
      snapshot,
    );
    if (!parsed) {
      pending.reservation = undefined;
      return undefined;
    }
    const emitted = emitTeammate(pending.session.conversation, pending.memberName, parsed[0]);
    this.progress.set(cursorKey, parsed[1]);
    this.progressOwners.set(identityKey, cursorKey);
    if (emitted.model) pending.call.span.setAttributes({ [ATTR.RESPONSE_MODEL]: emitted.model });
    const value = outcome.kind === 'success' ? outcome.value : undefined;
    finishAgentCall(pending.session.calls, pending.call, {
      outcome: { kind: 'success', value: emitted.text ?? value },
    });
    this.idleHistory = this.idleHistory.filter(entry => entry.idle !== idle);
    if (idle.fingerprint) {
      idle.agentType = teamTranscripts.agentSetting(transcriptPath)
        ?? pending.call.declaredAgentType;
      this.rememberIdle({ idle, completed: true });
    }
    return this.completed(pending);
  }
  async deny(call: TracedAgent, reason: string): Promise<TeamCompletion[] | undefined> {
    const pending = this.find(call);
    if (!pending || !isDispatch(pending) || !call.toolUseId) return undefined;
    denyCall(pending.session.calls, call.toolUseId, reason);
    this.remove(pending);
    return (await this.reconcile()).completions;
  }
  private completed(pending: Pending): TeamCompletion {
    this.remove(pending);
    return {
      mode: isDispatch(pending) ? 'cross-session' : 'same-session',
      owner: pending.session,
      teamName: pending.teamName,
      memberName: pending.memberName,
    };
  }
  private remove(pending: Pending): void {
    this.calls = this.calls.filter(candidate => candidate !== pending);
  }
  private rememberIdle(entry: IdleHistory): void {
    this.idleHistory = this.idleHistory.filter(previous => {
      if (!entry.completed) return previous.idle !== entry.idle;
      return !previous.completed
        || idleKey(previous.idle) !== idleKey(entry.idle)
        || previous.idle.selectedPath !== entry.idle.selectedPath
        || previous.idle.fingerprint !== entry.idle.fingerprint;
    });
    this.idleHistory.push(entry);
    if (this.idleHistory.length > MAX_IDLE_HISTORY) this.idleHistory.shift();
  }
  orphanSession(sessionId: string, reason: string, endTime: Date): void {
    for (const pending of [...this.calls]) {
      if (pending.session.sessionId !== sessionId) continue;
      finishAgentCall(pending.session.calls, pending.call, { orphanReason: reason }, endTime);
      this.remove(pending);
    }
  }
}
