// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DIR } from './setup.js';

/**
 * Per-turn trace registry: the local breadcrumb trail for "what's the
 * trace_id for the turn I just had?"
 *
 * After the May-14 `drop session span, flatten subagents` refactor, each
 * turn is its own root trace, but the daemon doesn't surface its trace_id
 * anywhere a user can see by default (the DEBUG log line stamps it, but
 * DEBUG is off). When a user reports "this turn didn't show up correctly
 * in Weave" we'd need a trace_id to investigate — without one, the only
 * recourse is full-corpus query filtering.
 *
 * This module appends one entry per Stop hook (each Claude Code turn) to
 * a JSON file in CONFIG_DIR. The file is bounded by entry count (oldest
 * dropped first) so it never grows unboundedly. CLI commands surface the
 * tail and let users filter by session.
 */

export const REGISTRY_FILE = path.join(CONFIG_DIR, 'trace-registry.json');

/** Hard cap on stored entries. Older entries are FIFO-evicted on write. */
const MAX_ENTRIES = 1000;

/** Bump when the on-disk shape changes incompatibly. */
const SCHEMA_VERSION = 3;

export interface TurnEntry {
  /** Claude Code session id (changes per resume; many turns share one). */
  sessionId: string;
  /** Monotonic turn counter within the session (1-based). */
  turnNumber: number;
  /** OTel trace id (hex). Each turn is its own root trace. */
  traceId: string;
  /** Cross-resume stitching key — `gen_ai.conversation.id` on every span. */
  conversationId: string;
  /** ISO timestamps from the daemon's perspective (turn span start/end). */
  startedAt: string;
  endedAt: string;
  /** Counts captured from the session state at Stop time. */
  toolCount: number;
  subagentCount: number;
  /** Working directory the session was started in — handy as a label. */
  cwd?: string;
}

interface RegistryFile {
  version: number;
  entries: TurnEntry[];
}

function readFile(): RegistryFile {
  try {
    const text = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(text) as Partial<RegistryFile>;
    if (parsed && typeof parsed === 'object' && parsed.version === SCHEMA_VERSION && Array.isArray(parsed.entries)) {
      return parsed as RegistryFile;
    }
  } catch {
    // Missing, unreadable, or older schema — start fresh. We treat the
    // registry as best-effort breadcrumbs, not durable state, so silently
    // resetting is acceptable.
  }
  return { version: SCHEMA_VERSION, entries: [] };
}

function writeFile(state: RegistryFile): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Atomic-ish: write to tmp then rename. Rename is atomic within the
    // same filesystem on POSIX, so a concurrent reader sees either the old
    // file or the new one — never a half-written file.
    const tmp = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch {
    // Failing to persist a breadcrumb is non-fatal; the daemon already
    // logs its own trace_id at DEBUG and the turn span itself is exported.
  }
}

/**
 * Append a turn entry. Best-effort: silent on I/O errors.
 *
 * Bounded by `MAX_ENTRIES` — oldest entries drop FIFO so the file stays
 * small. Called synchronously from `handleStop` (which is already async
 * and not on a latency-critical path), so we don't bother with batching.
 */
export function recordTurn(entry: TurnEntry): void {
  const state = readFile();
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
  writeFile(state);
}

/** Return the last `limit` entries (newest last). */
export function recentTurns(limit: number): TurnEntry[] {
  const { entries } = readFile();
  if (limit <= 0) return [];
  return entries.slice(-limit);
}

/** Return every entry for a given session id, oldest first. */
export function turnsForSession(sessionId: string): TurnEntry[] {
  const { entries } = readFile();
  return entries.filter((e) => e.sessionId === sessionId);
}

/** Return the most recent entry whose trace_id starts with `prefix`. */
export function findByTracePrefix(prefix: string): TurnEntry | undefined {
  if (!prefix) return undefined;
  const { entries } = readFile();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.traceId.startsWith(prefix)) return entry;
  }
  return undefined;
}
