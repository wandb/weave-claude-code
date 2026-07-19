// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as weave from 'weave';

import { MARKETPLACE_NAME, type Settings } from '../src/setup.ts';
import { GlobalDaemon } from '../src/daemon.ts';
import { resolveApiKey, resolveProject } from '../src/config.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

/**
 * Create a throwaway $HOME with a minimal `settings.json` for exercising
 * `config` subcommands. The seed deliberately omits `agent_name` so tests can
 * verify resolution on settings files written before that field existed.
 */
export function seedConfigHome(label: string): { home: string; settingsFile: string } {
  const home = fs.mkdtempSync(`/tmp/wcp-${label}-`);
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    log_file: path.join(dir, 'logs', 'daemon.log'),
    daemon_socket: path.join(dir, 'daemon.sock'),
    weave_project: null,
    wandb_api_key: null,
    debug: false,
    installed_at: '2026-01-01T00:00:00Z',
    version: '0.0.0-test',
  }));
  return { home, settingsFile };
}

/**
 * Run the CLI (via tsx) against a throwaway $HOME, capturing stdout and exit
 * code. Inherited credential/agent env vars are stripped so tests start from a
 * clean slate; `extraEnv` is applied last so a test can opt back into one.
 */
export function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home };
    delete env.WANDB_API_KEY;
    delete env.WEAVE_PROJECT;
    delete env.WEAVE_AGENT_NAME;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, code }));
  });
}

/**
 * Read the call log written by the fake `claude` CLI fixture
 * (`tests/fixtures/fake-claude-bin/claude`). One line per invocation, args
 * space-joined. Empty array when the daemon never ran.
 */
export function readFakeCalls(home: string): string[] {
  const p = path.join(home, '.claude', 'fake-claude-calls.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

/**
 * Seed `$HOME/.claude/plugins/known_marketplaces.json` with the given source
 * spec for the weave-claude-code marketplace. Mirrors what the real `claude`
 * CLI writes after `plugin marketplace add` (verified empirically). Tests use
 * this to put the registry in a known state before invoking code paths that
 * read it.
 */
export function writeKnownMarketplace(home: string, source: Record<string, unknown>): void {
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'known_marketplaces.json'),
    JSON.stringify({
      [MARKETPLACE_NAME]: {
        source,
        installLocation: path.join(dir, 'marketplaces', MARKETPLACE_NAME),
        lastUpdated: '2026-01-01T00:00:00Z',
      },
    }),
  );
}

// GenAI span harness: the daemon emits through the SDK's process-global state,
// so each test file inits `weave` once with an in-memory OTLP exporter (offline)
// and resets the exporter between tests.

let genaiExporter: InMemorySpanExporter | undefined;

/** Init `weave` with an in-memory exporter (once per test process); call
 *  `exporter.reset()` at the start of each test to isolate spans. */
export async function initWeaveInMemory(): Promise<InMemorySpanExporter> {
  if (!genaiExporter) {
    // weave.init() requires a key (WANDB_API_KEY/~/.netrc) even offline; resolve
    // fake creds the way the daemon does so the bridge stays hermetic on CI.
    const settings: Settings = {
      log_file: '', daemon_socket: '', weave_project: 'e/p', wandb_api_key: 'fake-key-for-test',
      agent_name: null, debug: false, installed_at: '', version: '0.0.0-test',
    };
    process.env.WANDB_API_KEY = resolveApiKey(settings).value ?? '';
    genaiExporter = new InMemorySpanExporter();
    await weave.init(resolveProject(settings).value ?? 'e/p', {
      genai: { spanProcessor: new SimpleSpanProcessor(genaiExporter) },
    });
  }
  return genaiExporter;
}

/** The daemon surface the genai tests drive: the (private) routeEvent entry
 *  point production feeds from the socket, plus drain for shutdown tests. */
export type DaemonDriver = {
  routeEvent(p: Record<string, unknown>): Promise<void>;
  drain(reason: string): Promise<void>;
};

/** GlobalDaemon with tracing marked enabled (SDK inited via `initWeaveInMemory`),
 *  skipping the real socket/`start()`; viewed through the DaemonDriver seam. */
export function makeGenaiDaemon(agentName = 'claude-code'): DaemonDriver {
  const logFile = path.join(os.tmpdir(), `wcp-genai-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused.sock', logFile, {
    weaveProject: 'e/p', apiKey: 'k', baseUrl: 'https://x', agentName, debug: false,
  });
  (d as unknown as { tracingEnabled: boolean }).tracingEnabled = true;
  return d as unknown as DaemonDriver;
}

/** One JSONL transcript line for a user text message. `version` mirrors the
 *  CC CLI version field real transcripts carry on their head line. */
export function transcriptUserLine(text: string, opts: { version?: string; timestamp?: string } = {}): string {
  return JSON.stringify({
    type: 'user',
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

/** One JSONL transcript line for a single-text assistant response. */
export function transcriptAssistantLine(
  text: string,
  usage: Record<string, number>,
  opts: { id?: string; model?: string; timestamp?: string } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    message: {
      role: 'assistant',
      id: opts.id ?? 'm1',
      model: opts.model ?? 'claude-opus-4-8',
      usage,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  });
}

/** Flush any spans buffered in the SDK so the in-memory exporter has them. */
export function flushWeave(): Promise<void> {
  return weave.flushOTel();
}

/** Parent span id: weave's provider exposes `parentSpanId` (older providers used
 *  `parentSpanContext`), so read whichever is present. */
export function spanParentId(s: ReadableSpan): string | undefined {
  return (s as unknown as { parentSpanId?: string }).parentSpanId ?? s.parentSpanContext?.spanId;
}

/** Direct children of `parent`, ordered by span start time. */
export function childrenOf(spans: ReadableSpan[], parent: ReadableSpan): ReadableSpan[] {
  const parentId = parent.spanContext().spanId;
  return spans
    .filter(s => spanParentId(s) === parentId)
    .sort((a, b) => hrToNs(a.startTime) - hrToNs(b.startTime));
}

function hrToNs(t: [number, number]): number {
  return t[0] * 1e9 + t[1];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `pred` until it returns true or `timeoutMs` elapses. Resolves to the
 *  final value of `pred` (true if the condition was met, false on timeout). */
export async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await delay(25);
  }
  return pred();
}

export interface TestDaemon {
  home: string;
  socketPath: string;
  logPath: string;
  proc: ChildProcess;
  /** Open a connection, write one JSON payload, resolve when the socket closes. */
  send(payload: object): Promise<void>;
  readLog(): string;
  /** Resolve true once the log matches `re`, false on timeout. */
  waitForLog(re: RegExp, timeoutMs?: number): Promise<boolean>;
  /** Resolve true once the daemon process has exited, false on timeout. */
  waitForExit(timeoutMs?: number): Promise<boolean>;
  hasExited(): boolean;
  /** Kill the daemon (if alive) and remove its throwaway home. */
  stop(): Promise<void>;
}

/**
 * Start a daemon in a throwaway home and wait until its socket is accepting.
 * `opts.settings` is merged into the generated settings.json; `opts.env` into
 * the daemon's environment (e.g. WEAVE_INACTIVITY_MS).
 */
export async function startTestDaemon(
  opts: { settings?: Record<string, unknown>; env?: Record<string, string> } = {},
): Promise<TestDaemon> {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.weave-daemontest-'));
  const configDir = path.join(home, '.weave-claude-code');
  const socketPath = path.join(configDir, 'daemon.sock');
  const logPath = path.join(configDir, 'logs', 'daemon.log');
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      weave_project: 'test/test',
      wandb_api_key: 'fake-key-for-test',
      daemon_socket: socketPath,
      log_file: logPath,
      debug: true,
      ...opts.settings,
    }),
  );

  const proc = spawn(process.execPath, ['--import', 'tsx', CLI, 'daemon'], {
    env: { ...process.env, HOME: home, WANDB_BASE_URL: 'http://127.0.0.1:1', ...opts.env },
    stdio: 'ignore',
  });
  let exited = false;
  proc.once('exit', () => { exited = true; });

  const readLog = (): string => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
  const send = (payload: object): Promise<void> =>
    new Promise((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.on('error', reject);
      s.on('connect', () => s.end(JSON.stringify(payload)));
      s.on('close', () => resolve());
    });

  await waitUntil(() => fs.existsSync(socketPath), 5000);
  await delay(150); // let listen() settle before the first send

  return {
    home,
    socketPath,
    logPath,
    proc,
    send,
    readLog,
    waitForLog: (re, timeoutMs = 3000) => waitUntil(() => re.test(readLog()), timeoutMs),
    waitForExit: (timeoutMs = 3000) => waitUntil(() => exited, timeoutMs),
    hasExited: () => exited,
    stop: async () => {
      if (!exited) {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        await waitUntil(() => exited, 2000);
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
