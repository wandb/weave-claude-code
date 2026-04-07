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
