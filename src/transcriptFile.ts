// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

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

/**
 * Open `transcriptPath` read-only (no symlink following, regular file only)
 * and read the first line as JSON. Returns the parsed object or undefined on
 * any failure (missing file, unparseable line, empty file). Caller-safe for
 * ancestor transcripts in the fork chain: opens its own fd and closes it
 * before returning.
 */
export function readFirstTranscriptLine(transcriptPath: string): Record<string, unknown> | undefined {
  const resolved = path.resolve(transcriptPath);
  if (!isPathWithinBase(resolved, os.homedir())) return undefined;

  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, O_RDONLY_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return undefined;

    const want = Math.min(stat.size, 64 * 1024);
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = fs.readSync(fd, buf, read, want - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read === 0) return undefined;

    const text = buf.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    const line = nl === -1 ? text : text.slice(0, nl);
    if (!line.trim()) return undefined;

    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
