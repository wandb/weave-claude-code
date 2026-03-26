// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TraceRegistryEntry {
  sessionId: string;
  traceId: string;
  sessionCallId?: string;
  transcriptPath: string;
  createdAt: string;
  lastSeenAt: string;
  lastSource: string;
}

const TRACE_REGISTRY_FILE = path.join(os.homedir(), '.weave_claude_plugin', 'trace-registry.json');
const TRACE_REGISTRY_MAX_ENTRIES = 5_000;
const TRACE_REGISTRY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000; // 180 days

/**
 * Small local cache of Claude session -> Weave trace mappings.
 * Keeps continuation fast and available even when Weave reads are unavailable.
 */
export class TraceRegistry {
  private entries = new Map<string, TraceRegistryEntry>();

  /** Load the on-disk registry into memory, prune stale entries, and return the retained count. */
  load(): number {
    try {
      if (!fs.existsSync(TRACE_REGISTRY_FILE)) return 0;
      const raw = JSON.parse(fs.readFileSync(TRACE_REGISTRY_FILE, 'utf8')) as { entries?: TraceRegistryEntry[] };
      this.entries.clear();
      for (const entry of raw.entries ?? []) {
        if (entry.sessionId && entry.traceId && entry.transcriptPath) {
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
    sessionCallId?: string,
  ): void {
    const now = new Date().toISOString();
    const existing = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      sessionId,
      traceId,
      sessionCallId: sessionCallId ?? existing?.sessionCallId,
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
    fs.writeFileSync(TRACE_REGISTRY_FILE, JSON.stringify({ version: 1, entries }, null, 2));
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
    
    // Futher prune entries that are over TRACE_REGISTRY_MAX_ENTRIES
    const entries = Array.from(this.entries.values()).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    const excess = entries.length - TRACE_REGISTRY_MAX_ENTRIES;
    for (const entry of entries.slice(0, excess)) {
      this.entries.delete(entry.sessionId);
    }
  }
}
