// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPathWithinBase } from './utils.js';

const O_RDONLY_NOFOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

/**
 * Represents a Claude Code transcript file.
 *
 * Construction validates that the path is within the user's home directory
 * (no file I/O — safe to construct before the file exists).
 *
 * `getFd()` opens the file descriptor lazily on first call and caches it.
 * Do not call it unless you actually need to read the file.
 * Throws if the file cannot be opened.
 *
 * ## Why the fd is opened once and cached
 *
 * An fd is a kernel-level reference to the underlying inode, not to the
 * directory entry (path). Once opened, reads through that fd are unaffected
 * by anything that happens to the path afterward — the file can be renamed,
 * unlinked, or replaced and we continue reading the original content.
 *
 * This closes a TOCTOU (time-of-check/time-of-use) window: if we re-opened
 * by path on every read, an attacker who can write to the transcript directory
 * could swap the file for a symlink to an arbitrary target between our
 * path-validation check and the open call. `O_RDONLY | O_NOFOLLOW` prevents
 * symlink following at open time; caching the fd means we never re-open and
 * therefore never re-expose that window.
 */
export class TranscriptFile {
  readonly resolvedPath: string;
  private _fd: number | null = null;

  constructor(rawPath: string) {
    const resolved = path.resolve(rawPath);
    if (!isPathWithinBase(resolved, os.homedir())) {
      throw new Error(`transcript_path outside home dir: ${rawPath}`);
    }
    this.resolvedPath = resolved;
  }

  getFd(): number {
    if (this._fd !== null) return this._fd;
    const fd = fs.openSync(this.resolvedPath, O_RDONLY_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fs.closeSync(fd);
      throw new Error(`not a regular file: ${this.resolvedPath}`);
    }
    this._fd = fd;
    return fd;
  }

  close(): void {
    if (this._fd === null) return;
    try { fs.closeSync(this._fd); } finally { this._fd = null; }
  }
}

/** Read a bounded, validated transcript prefix without leaving an fd open. */
function readTranscriptPrefix(transcriptPath: string): string | undefined {
  let transcript: TranscriptFile | undefined;
  try {
    transcript = new TranscriptFile(transcriptPath);
    const fd = transcript.getFd();
    const want = Math.min(fs.fstatSync(fd).size, 64 * 1024);
    if (want === 0) return undefined;
    const buffer = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const count = fs.readSync(fd, buffer, read, want - read, read);
      if (count === 0) break;
      read += count;
    }
    return read ? buffer.toString('utf8', 0, read) : undefined;
  } catch {
    return undefined;
  } finally {
    transcript?.close();
  }
}

/** Read the first transcript line as JSON without leaving an fd open. */
export function readFirstTranscriptLine(transcriptPath: string): Record<string, unknown> | undefined {
  const line = readTranscriptPrefix(transcriptPath)?.split('\n', 1)[0];
  if (!line?.trim()) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function subagentTranscriptPath(parentTranscriptPath: string, agentId: string): string {
  const projectDir = path.dirname(parentTranscriptPath);
  const sessionId = path.basename(parentTranscriptPath, '.jsonl');
  return path.join(projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Read the dispatch prompt used to join an id-less lifecycle hook to Agent. */
export async function readSubagentPrompt(transcriptPath: string): Promise<string | undefined> {
  for (const delay of [0, 50, 100, 150]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const prompt = readTypedUserPrompt(transcriptPath);
    if (prompt) return prompt;
  }
  return undefined;
}

/** Injected context uses array content; the dispatch prompt is the first
 * bare-string user message in the bounded prefix. */
function readTypedUserPrompt(transcriptPath: string): string | undefined {
  const prefix = readTranscriptPrefix(transcriptPath);
  if (!prefix) return undefined;
  for (const raw of prefix.split('\n')) {
    if (!raw.trim()) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (line['type'] !== 'user') continue;
    const message = line['message'];
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string' && content) return content;
  }
  return undefined;
}
