// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TraceRegistryEntry {
  sessionId: string;
  /** OTel-format trace ID — 32 hex characters (16 bytes). */
  traceId: string;
  /** OTel-format span ID of the session-level invoke_agent span — 16 hex characters (8 bytes). */
  sessionSpanId?: string;
  transcriptPath: string;
  createdAt: string;
  lastSeenAt: string;
  lastSource: string;
}

const TRACE_REGISTRY_FILE = path.join(os.homedir(), '.weave_claude_plugin', 'trace-registry.json');
const TRACE_REGISTRY_MAX_ENTRIES = 5_000;
const TRACE_REGISTRY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000; // 180 days

// Bumped from 1 → 2 when migrating to OTel-format IDs. Older entries from v1
// stored UUIDv7s under sessionCallId; those are not valid OTel span IDs, so
// any v1 file is ignored on load.
const TRACE_REGISTRY_VERSION = 2;

const HEX_TRACE_ID = /^[0-9a-f]{32}$/i;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/i;

/**
 * Small local cache of Claude session -> OTel trace mappings.
 *
 * Keeps trace continuity across daemon restarts: on resume, we force the
 * new session span's traceId to match the prior process's traceId so that
 * the agents observability backend stitches the resumed turns into the
 * same trace.
 */
export class TraceRegistry {
  private entries = new Map<string, TraceRegistryEntry>();

  /** Load the on-disk registry into memory, prune stale entries, and return the retained count. */
  load(): number {
    try {
      if (!fs.existsSync(TRACE_REGISTRY_FILE)) return 0;
      const raw = JSON.parse(fs.readFileSync(TRACE_REGISTRY_FILE, 'utf8')) as {
        version?: number;
        entries?: TraceRegistryEntry[];
      };
      this.entries.clear();
      if ((raw.version ?? 1) !== TRACE_REGISTRY_VERSION) {
        // Stale schema (older plugin version that stored UUIDv7s) — ignore.
        return 0;
      }
      for (const entry of raw.entries ?? []) {
        if (
          entry.sessionId &&
          entry.traceId &&
          HEX_TRACE_ID.test(entry.traceId) &&
          entry.transcriptPath &&
          (!entry.sessionSpanId || HEX_SPAN_ID.test(entry.sessionSpanId))
        ) {
          this.entries.set(entry.sessionId, entry);
        }
      }
      this.prune();
      return this.entries.size;
    } catch {
      this.entries.clear();
      return 0;
    }
  }

  /** Look up a previously retained trace mapping by Claude's session ID. */
  getBySessionId(sessionId: string): TraceRegistryEntry | undefined {
    return this.entries.get(sessionId);
  }

  /** Look up a previously retained trace mapping by transcript path as a fallback key. */
  getByTranscriptPath(transcriptPath: string): TraceRegistryEntry | undefined {
    return Array.from(this.entries.values()).find((entry) => entry.transcriptPath === transcriptPath);
  }

  /** Create or refresh a session-to-trace mapping and persist the registry to disk. */
  upsert(
    sessionId: string,
    traceId: string,
    transcriptPath: string,
    source: string,
    sessionSpanId?: string,
  ): void {
    const now = new Date().toISOString();
    const existing = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      sessionId,
      traceId,
      sessionSpanId: sessionSpanId ?? existing?.sessionSpanId,
      transcriptPath,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      lastSource: source,
    });
    this.save();
  }

  /** Persist the current registry contents after applying pruning rules. */
  private save(): void {
    this.prune();
    fs.mkdirSync(path.dirname(TRACE_REGISTRY_FILE), { recursive: true });
    const entries = Array.from(this.entries.values()).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    fs.writeFileSync(
      TRACE_REGISTRY_FILE,
      JSON.stringify({ version: TRACE_REGISTRY_VERSION, entries }, null, 2),
    );
    fs.chmodSync(TRACE_REGISTRY_FILE, 0o600);
  }

  /** Drop old entries and cap the registry size so the file stays bounded over time. */
  private prune(): void {
    const cutoff = Date.now() - TRACE_REGISTRY_MAX_AGE_MS;
    for (const [sessionId, entry] of this.entries) {
      if (Date.parse(entry.lastSeenAt) < cutoff) {
        this.entries.delete(sessionId);
      }
    }

    if (this.entries.size <= TRACE_REGISTRY_MAX_ENTRIES) return;

    // Further prune entries that are over TRACE_REGISTRY_MAX_ENTRIES
    const entries = Array.from(this.entries.values()).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    const excess = entries.length - TRACE_REGISTRY_MAX_ENTRIES;
    for (const entry of entries.slice(0, excess)) {
      this.entries.delete(entry.sessionId);
    }
  }
}
