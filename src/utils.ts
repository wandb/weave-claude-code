// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';

/**
 * Decide whether a session whose working directory is `cwd` should be traced,
 * given a `traceRoots` allowlist of absolute repo paths.
 *
 * - Empty `traceRoots` ⇒ global: every session is in scope. This is the
 *   default and keeps existing (machine-wide) behavior unchanged.
 * - Non-empty ⇒ in scope only if `cwd` is at or under one of the roots.
 * - Fail closed: with roots set but an empty/missing `cwd`, returns false —
 *   we can't prove the session belongs to a traced repo, so we don't trace it.
 *
 * Matching is by resolved-path boundary, so `/repo` matches `/repo` and
 * `/repo/sub` but NOT `/repo-sibling`.
 */
export function isCwdInScope(cwd: string, traceRoots: string[]): boolean {
  if (traceRoots.length === 0) return true;
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  return traceRoots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function sendToSocket(socketPath: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const client = net.createConnection(socketPath, () => {
      client.write(message);
      client.end();
    });
    client.on('close', () => settle(resolve));
    client.on('error', (err) => settle(() => reject(err)));

    const timer = setTimeout(() => {
      settle(() => {
        client.destroy();
        resolve();
      });
    }, 2000);
  });
}

/**
 * Locate the `claude` CLI binary via `which`. Returns the absolute path or null if not found.
 */
export function findClaudeCLI(): string | null {
  const result = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return null;
}

/** Structural equality for plain JSON values (no circular references). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Append a timestamped log line to logFile. Best-effort — never throws.
 */
export function appendToLog(logFile: string, level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string): void {
  const line = `${new Date().toISOString()} | ${level} | ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {
    // If we can't write to the log we've already printed to console — swallow
  }
}

/** Return true when targetPath is equal to basePath or nested beneath it. */
export function isPathWithinBase(targetPath: string, basePath: string): boolean {
  return targetPath === basePath || targetPath.startsWith(basePath + path.sep);
}

/**
 * Possible states of a Unix-domain socket inode. String-valued so JSON
 * consumers and assertions see the literal value (`'alive'`, `'stale'`,
 * `'absent'`), not a numeric ordinal.
 */
export enum SocketState {
  /** connect() succeeded; something is listening. */
  Alive = 'alive',
  /** Inode exists but connect() failed (ECONNREFUSED, ENOTSOCK, hang, etc.);
   *  a daemon died without cleaning up its socket. */
  Stale = 'stale',
  /** No inode at the path. */
  Absent = 'absent',
}

/**
 * Probe a Unix-domain socket and distinguish the three states a daemon socket
 * file can be in. The `[ -S path ]` / `fs.existsSync(path)` test alone cannot
 * tell `Alive` from `Stale`: the socket inode persists across an ungraceful
 * exit. Only an actual connect attempt distinguishes them.
 */
export function probeUnixSocket(
  socketPath: string,
  timeoutMs = 250,
): Promise<SocketState> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(SocketState.Absent);
      return;
    }
    const client = net.createConnection(socketPath);
    let settled = false;
    const settle = (v: SocketState.Alive | SocketState.Stale): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => settle(SocketState.Stale), timeoutMs);
    client.once('connect', () => settle(SocketState.Alive));
    client.once('error', () => settle(SocketState.Stale));
  });
}
