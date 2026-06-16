// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as readline from 'readline';
import { spawnSync } from 'child_process';

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
 * Send a message and read the daemon's reply. Like `sendToSocket`, but the
 * daemon writes a response before closing (e.g. the `config-hash` query), so
 * this resolves with that response string. Rejects on connect error or timeout
 * so callers can treat "no reply" as "cannot determine".
 */
export function requestFromSocket(socketPath: string, message: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const client = net.createConnection(socketPath, () => {
      client.write(message);
      client.end(); // half-close: done sending; the daemon replies then closes
    });
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => { data += chunk; });
    client.on('close', () => settle(() => resolve(data)));
    client.on('error', (err) => settle(() => reject(err)));
    const timer = setTimeout(() => settle(() => { client.destroy(); reject(new Error('socket request timed out')); }), timeoutMs);
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
