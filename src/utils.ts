// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

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
