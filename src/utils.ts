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
    const client = net.createConnection(socketPath, () => {
      client.write(message);
      client.end();
    });
    client.on('close', resolve);
    client.on('error', reject);
    // Resolve after timeout — daemon may have already exited and closed the socket
    setTimeout(() => {
      client.destroy();
      resolve();
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
