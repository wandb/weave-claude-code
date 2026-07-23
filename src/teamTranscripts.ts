// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import { extractAssistantTextBlocks, parseSessionFd, type ParsedTurn } from './parser.js';
import {
  readFirstTranscriptLine,
  readTranscriptPrefix,
  subagentsDirectory,
  TRANSCRIPT_SCAN_LIMIT_BYTES,
  TranscriptFile,
  type ReadBudget,
} from './transcriptFile.js';
import { sha256Hex } from './utils.js';

const SEP = '\0';

// Receipt-time discovery runs before the hook is acknowledged. Exceeding any
// scan budget discards the evidence so correlation fails closed.
const MAX_TRANSCRIPT_ROOTS = 1024;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_TRANSCRIPT_CANDIDATES = 64;
const MAX_CORRELATION_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_TEAM_TRANSCRIPT_BYTES = TRANSCRIPT_SCAN_LIMIT_BYTES;

export type TeamTranscriptSnapshot = {
  path: string; device: number; inode: number; created: number; size: number;
  modified: number; completeLine: boolean;
};

export type TeamTranscriptProgress = {
  device: number; inode: number; created: number;
  bytes: number; responses: number; content: number;
  lastResponseId?: string; contentPrefixHash: string;
};

export type TeamTranscriptEvidenceContext = {
  metadata: Map<string, string[] | 'ambiguous'>;
  firstLines: Map<string, Record<string, unknown> | null>;
  firstLineBudget: ReadBudget;
  entries: number; candidates: number; metadataBytes: number;
};

export const newEvidenceContext = (): TeamTranscriptEvidenceContext => ({
  metadata: new Map(),
  firstLines: new Map(),
  firstLineBudget: { remaining: MAX_CORRELATION_BYTES },
  entries: 0,
  candidates: 0,
  metadataBytes: 0,
});

/** Capture the append-only transcript boundary represented by an idle hook. */
export function snapshot(transcriptPath: unknown): TeamTranscriptSnapshot | undefined {
  if (typeof transcriptPath !== 'string') return undefined;
  let transcript: TranscriptFile | undefined;
  try {
    transcript = new TranscriptFile(transcriptPath);
    const fd = transcript.getFd();
    const stat = fs.fstatSync(fd);
    if (stat.size > MAX_TEAM_TRANSCRIPT_BYTES) return undefined;
    let completeLine = stat.size === 0;
    if (stat.size) {
      const last = Buffer.allocUnsafe(1);
      completeLine = fs.readSync(fd, last, 0, 1, stat.size - 1) === 1 && last[0] === 0x0a;
    }
    return {
      path: transcript.resolvedPath, device: stat.dev, inode: stat.ino,
      created: stat.birthtimeMs, size: stat.size, modified: stat.mtimeMs, completeLine,
    };
  } catch { return undefined; } finally { transcript?.close(); }
}

export function snapshotFingerprint(snapshot?: TeamTranscriptSnapshot): string | undefined {
  return snapshot && [
    snapshot.path, snapshot.device, snapshot.inode, snapshot.created,
    snapshot.size, snapshot.modified,
  ].join(SEP);
}

export function receiptFingerprint(snapshots: TeamTranscriptSnapshot[]): string | undefined {
  if (!snapshots.length) return undefined;
  return sha256Hex(snapshots.map(value => snapshotFingerprint(value) as string)
    .sort()
    .join(`${SEP}${SEP}`));
}

export function snapshotFor(
  transcriptPath: string | undefined,
  snapshots: TeamTranscriptSnapshot[],
): TeamTranscriptSnapshot | undefined {
  if (!transcriptPath) return undefined;
  const resolved = path.resolve(transcriptPath);
  return snapshots.find(snapshot => snapshot.path === resolved);
}

type SnapshotDiscoveryInput = {
  sessionId: unknown;
  transcriptPath: unknown;
  lifecyclePaths: Iterable<string | undefined>;
  transcriptRoots: Iterable<string>;
};

/** Capture every output path that current correlation evidence could select. */
export function snapshotTranscripts(
  input: SnapshotDiscoveryInput,
): TeamTranscriptSnapshot[] {
  const direct = snapshot(input.transcriptPath);
  const directOnly = () => direct ? [direct] : [];
  const paths = new Set<string>();
  const examined = new Set<string>();
  const firstLineBudget = { remaining: MAX_CORRELATION_BYTES };
  if (direct) examined.add(direct.path);

  const addIfOwned = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (examined.has(resolved)) return true;
    if (examined.size >= MAX_TRANSCRIPT_CANDIDATES) return false;
    examined.add(resolved);
    const first = readFirstTranscriptLine(
      resolved,
      TRANSCRIPT_SCAN_LIMIT_BYTES,
      firstLineBudget,
    );
    if (!first && firstLineBudget.remaining === 0) return false;
    if (first?.['sessionId'] === input.sessionId) paths.add(resolved);
    return true;
  };

  if (typeof input.sessionId === 'string') {
    for (const lifecyclePath of input.lifecyclePaths) {
      if (lifecyclePath && !addIfOwned(lifecyclePath)) return directOnly();
    }
    const owners = new Set<string>();
    let roots = 0;
    for (const owner of input.transcriptRoots) {
      if (++roots > MAX_TRANSCRIPT_ROOTS) return directOnly();
      owners.add(owner);
    }
    let entries = 0;
    for (const owner of owners) {
      let directory: fs.Dir | undefined;
      try {
        directory = fs.opendirSync(subagentsDirectory(owner));
        for (;;) {
          const entry = directory.readSync();
          if (!entry) break;
          if (++entries > MAX_DIRECTORY_ENTRIES) return directOnly();
          if (entry.name.endsWith('.jsonl')
            && !addIfOwned(path.join(directory.path, entry.name))) return directOnly();
        }
      } catch { /* colocated transcripts are optional */ } finally {
        try { directory?.closeSync(); } catch { /* already closed */ }
      }
    }
  }

  if (paths.size + (direct ? 1 : 0) > MAX_TRANSCRIPT_CANDIDATES) return directOnly();
  return [...directOnly(), ...[...paths].flatMap(candidate => {
    const value = snapshot(candidate);
    return value ? [value] : [];
  })];
}

function firstLineFor(
  transcriptPath: string,
  context: TeamTranscriptEvidenceContext,
): Record<string, unknown> | 'ambiguous' | undefined {
  const resolved = path.resolve(transcriptPath);
  const cached = context.firstLines.get(resolved);
  if (cached !== undefined) return cached ?? undefined;
  if (context.firstLineBudget.remaining === 0) return 'ambiguous';
  const first = readFirstTranscriptLine(
    resolved,
    TRANSCRIPT_SCAN_LIMIT_BYTES,
    context.firstLineBudget,
  );
  if (!first && context.firstLineBudget.remaining === 0) return 'ambiguous';
  context.firstLines.set(resolved, first ?? null);
  return first;
}

export function matchTranscript(
  transcriptPath: string | undefined,
  sessionId: string,
  declaredAgentType: string | undefined,
  context: TeamTranscriptEvidenceContext,
): string | 'ambiguous' | undefined {
  if (!transcriptPath) return undefined;
  const first = firstLineFor(transcriptPath, context);
  if (first === 'ambiguous') return 'ambiguous';
  const setting = first?.['agentSetting'];
  return first?.['sessionId'] === sessionId
    && (!declaredAgentType
      || typeof setting !== 'string'
      || setting === declaredAgentType)
    ? transcriptPath
    : undefined;
}

export function findMetadata(
  rootTranscriptPath: string,
  declaredAgentType: string | undefined,
  sessionId: string,
  context: TeamTranscriptEvidenceContext,
): string[] | 'ambiguous' {
  const key = [rootTranscriptPath, declaredAgentType ?? '', sessionId].join(SEP);
  const cached = context.metadata.get(key);
  if (cached !== undefined) return cached;
  const ambiguous = () => {
    context.metadata.set(key, 'ambiguous');
    return 'ambiguous' as const;
  };
  const metadata: string[] = [];
  let directory: fs.Dir | undefined;
  try {
    directory = fs.opendirSync(subagentsDirectory(rootTranscriptPath));
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (++context.entries > MAX_DIRECTORY_ENTRIES) return ambiguous();
      if (!entry.name.endsWith('.meta.json')) continue;
      const metaPath = path.join(directory.path, entry.name);
      let fd: number | undefined;
      try {
        fd = fs.openSync(metaPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) continue;
        context.metadataBytes += stat.size;
        if (context.metadataBytes > MAX_METADATA_BYTES) return ambiguous();
        const buffer = Buffer.allocUnsafe(stat.size);
        let read = 0;
        while (read < stat.size) {
          const count = fs.readSync(fd, buffer, read, stat.size - read, read);
          if (!count) break;
          read += count;
        }
        if (read !== stat.size) continue;
        const meta = JSON.parse(buffer.toString('utf8', 0, read)) as Record<string, unknown>;
        if (declaredAgentType && meta['agentType'] !== declaredAgentType) continue;
        if (++context.candidates > MAX_TRANSCRIPT_CANDIDATES) return ambiguous();
        const candidate = metaPath.replace(/\.meta\.json$/, '.jsonl');
        const first = firstLineFor(candidate, context);
        if (first === 'ambiguous') return ambiguous();
        if (first?.['sessionId'] === sessionId) metadata.push(candidate);
        if (metadata.length > 1) return ambiguous();
      } catch { /* ignore incomplete metadata */ } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  } catch { /* metadata is optional */ } finally {
    try { directory?.closeSync(); } catch { /* already closed */ }
  }
  context.metadata.set(key, metadata);
  return metadata;
}

export function isAgentSetting(transcriptPath: string): boolean {
  return readFirstTranscriptLine(transcriptPath)?.['type'] === 'agent-setting';
}

/** Return the exact lifecycle type recorded by Claude for this transcript. */
export function agentSetting(transcriptPath: string): string | undefined {
  const first = readFirstTranscriptLine(transcriptPath);
  const setting = first?.['agentSetting'];
  return first?.['type'] === 'agent-setting' && typeof setting === 'string' && setting
    ? setting
    : undefined;
}

/** Agent-team transcripts carry their team on a later user record rather than
 * necessarily on the initial agent-setting record. */
export function teamName(transcriptPath: string): string | undefined {
  const prefix = readTranscriptPrefix(transcriptPath);
  if (!prefix) return undefined;
  for (const raw of prefix.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const teamName = (JSON.parse(raw) as Record<string, unknown>)['teamName'];
      if (typeof teamName === 'string' && teamName) return teamName;
    } catch {
      // A partial/malformed record does not invalidate the bounded scan.
    }
  }
  return undefined;
}

/** A partial JSONL record may finish after receipt, but later records belong
 * to later hooks. Return only through that partial record's first newline. */
function snapshotReadLimit(
  fd: number,
  snapshot: TeamTranscriptSnapshot,
): number | 'invalid' | undefined {
  const stat = fs.fstatSync(fd);
  if (stat.dev !== snapshot.device || stat.ino !== snapshot.inode
    || stat.birthtimeMs !== snapshot.created || stat.size < snapshot.size
    || snapshot.size > MAX_TEAM_TRANSCRIPT_BYTES) {
    return 'invalid';
  }
  if (snapshot.completeLine) return snapshot.size;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = snapshot.size;
  const scanLimit = Math.min(stat.size, MAX_TEAM_TRANSCRIPT_BYTES);
  while (offset < scanLimit) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, scanLimit - offset), offset);
    if (!count) break;
    const newline = chunk.indexOf(0x0a, 0);
    if (newline >= 0 && newline < count) return offset + newline + 1;
    offset += count;
  }
  return stat.size > MAX_TEAM_TRANSCRIPT_BYTES ? 'invalid' : undefined;
}

/** Retry partial snapshots and advance only after new provider content. The
 * cursor includes the final response's content offset because Claude can append
 * another assistant record to the same normalized response and parsed turn. */
export async function readNewTurns(
  transcriptPath: string, progress?: TeamTranscriptProgress, snapshot?: TeamTranscriptSnapshot,
): Promise<[ParsedTurn[], TeamTranscriptProgress] | undefined> {
  let transcript: TranscriptFile | undefined;
  try {
    transcript = new TranscriptFile(transcriptPath);
    const fd = transcript.getFd();
    for (let attempt = 0; attempt < 5; attempt++) {
      const stat = fs.fstatSync(fd);
      const boundary = snapshot?.path === transcript.resolvedPath
        ? snapshotReadLimit(fd, snapshot)
        : stat.size <= MAX_TEAM_TRANSCRIPT_BYTES ? stat.size : 'invalid';
      if (boundary === 'invalid') return undefined;
      const turns = boundary === undefined
        ? []
        : parseSessionFd(fd, boundary)?.turns.filter(turn => turn.responses.length) ?? [];
      const all = turns.flatMap(turn => turn.responses);
      const sameFile = progress?.device === stat.dev && progress.inode === stat.ino
        && progress.created === stat.birthtimeMs;
      if (progress && (!sameFile || (boundary !== undefined && boundary < progress.bytes))) {
        return undefined;
      }
      const priorLast = sameFile && progress.responses ? all[progress.responses - 1] : undefined;
      if (sameFile && (progress.responses > all.length
        || !priorLast
        || priorLast.id !== progress.lastResponseId
        || progress.content > priorLast.content.length
        || sha256Hex(JSON.stringify(priorLast.content.slice(0, progress.content)))
          !== progress.contentPrefixHash)) return undefined;
      const cursor = sameFile ? progress : undefined;
      let responseIndex = 0;
      const fresh = turns.flatMap(turn => {
        const turnStart = responseIndex;
        const responses = turn.responses.flatMap(response => {
          const index = responseIndex++;
          if (cursor && index < cursor.responses - 1) return [];
          if (cursor && index === cursor.responses - 1) {
            const content = response.content.slice(cursor.content);
            return content.length ? [{ ...response, content }] : [];
          }
          return [response];
        });
        if (!responses.length) return [];
        return [{
          ...turn,
          userText: !cursor || turnStart >= cursor.responses ? turn.userText : undefined,
          responses,
          text: responses.flatMap(response => extractAssistantTextBlocks(response.content)),
          model: responses.filter(response => response.model).at(-1)?.model ?? turn.model,
        }];
      });
      if (fresh.length) {
        const last = all.at(-1);
        return [fresh, {
          device: stat.dev, inode: stat.ino, created: stat.birthtimeMs, bytes: boundary as number,
          responses: all.length, content: last?.content.length ?? 0,
          lastResponseId: last?.id,
          contentPrefixHash: sha256Hex(JSON.stringify(last?.content ?? [])),
        }];
      }
      if (boundary !== undefined) return undefined;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch { /* a later idle can retry */ } finally { transcript?.close(); }
  return undefined;
}
