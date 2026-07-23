// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import * as weave from 'weave';
import {
  daemonConfigFingerprint,
  missingConfig,
  resolveDaemonConfig,
} from './config.js';
import type { DaemonConfig } from './config.js';
import { loadSettings, VERSION } from './setup.js';
import { TraceRuntime } from './traceRuntime.js';
import { appendToLog } from './utils.js';

/** Inbound control message sent directly to the socket (not a hook event). */
type ControlMessage = {
  command: 'shutdown' | 'config-hash';
};

function isControlMessage(payload: unknown): payload is ControlMessage {
  if (typeof payload !== 'object' || payload === null) return false;
  const command = (payload as Record<string, unknown>).command;
  return command === 'shutdown' || command === 'config-hash';
}

/** Resolve the running daemon's entry script for config-drift reporting. */
function daemonEntryPath(): string {
  const entry = process.argv[1] ?? '';
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
}

const INACTIVITY_TIMEOUT_MS = 120 * 60 * 1_000;
const INFLIGHT_HOLD_MAX_MS = 60 * 60 * 1_000;
const CONNECTION_TIMEOUT_MS = 5_000;
const MAX_SOCKET_PAYLOAD_BYTES = 4 * 1024 * 1024;

export class GlobalDaemon {
  private server?: net.Server;
  /** Socket inode bound by this process; a successor may reuse the path while
   * this daemon drains. */
  private ownedSocketInode?: number;
  private running = false;
  private lastActivity = Date.now();
  private readonly inactivityMs =
    Number(process.env.WEAVE_INACTIVITY_MS) || INACTIVITY_TIMEOUT_MS;
  private tracingEnabled = false;
  private readonly traceRuntime: TraceRuntime;

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly config: DaemonConfig,
  ) {
    this.traceRuntime = new TraceRuntime(
      config.agentName,
      (level, message) => this.log(level, message),
    );
  }

  async start(): Promise<void> {
    // Install cleanup before any await can expose a partially started daemon.
    this.running = true;
    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGINT', () => void this.shutdown('SIGINT'));
    process.on('SIGHUP', () => void this.shutdown('SIGHUP'));
    process.on('exit', () => this.releaseOwnedSocket());

    if (this.config.weaveProject && this.config.apiKey) {
      try {
        await this.initWeave();
        this.log(
          'INFO',
          `OTel tracer initialized — project=${this.config.weaveProject}, endpoint=${this.config.baseUrl}/agents/otel/v1/traces`,
        );
        this.log(
          'INFO',
          `View traces: https://wandb.ai/${this.config.weaveProject}/weave/agents`,
        );
      } catch (err) {
        this.log(
          'ERROR',
          `Failed to initialize OTel tracer: ${err} — continuing without tracing`,
        );
        this.tracingEnabled = false;
      }
    } else {
      this.log('INFO', 'No weave_project / API key configured — tracing disabled');
    }

    await this.bindSocketWithHerdProtection();
    this.log('INFO', `Daemon started — socket: ${this.socketPath}`);

    const checkEveryMs = Math.min(
      60_000,
      Math.max(500, Math.floor(this.inactivityMs / 4)),
    );
    setInterval(() => this.checkInactivity(), checkEveryMs).unref();
  }

  private socketHasLiveListener(): Promise<boolean> {
    if (!fs.existsSync(this.socketPath)) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const probe = net.createConnection(this.socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        probe.destroy();
        resolve(false);
      });
    });
  }

  private listenOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const previousUmask = process.umask(0o077);
      const server = net.createServer(
        { allowHalfOpen: true },
        socket => this.handleConnection(socket),
      );
      const onError = (err: Error) => {
        process.umask(previousUmask);
        reject(err);
      };
      server.once('error', onError);
      this.server = server;
      server.listen(this.socketPath, () => {
        process.umask(previousUmask);
        server.removeListener('error', onError);
        this.captureSocketOwnership();
        resolve();
      });
    });
  }

  private async bindSocketWithHerdProtection(): Promise<void> {
    const MAX_RECLAIM_ATTEMPTS = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.listenOnce();
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EEXIST') throw err;
        if (await this.socketHasLiveListener()) {
          this.log(
            'INFO',
            'Another daemon already owns the socket — exiting to avoid a herd',
          );
          process.exit(0);
        }
        if (attempt >= MAX_RECLAIM_ATTEMPTS) throw err;
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          // Another process already cleaned it; retry the bind.
        }
      }
    }
  }

  /** Capture an early bind only while this process's server is still live. */
  private captureSocketOwnership(): void {
    if (this.ownedSocketInode !== undefined || !this.server?.listening) return;
    try {
      this.ownedSocketInode = fs.statSync(this.socketPath).ino;
    } catch {
      // The socket was already removed.
    }
  }

  /** Remove only the socket inode this daemon created. */
  private releaseOwnedSocket(): void {
    this.captureSocketOwnership();
    const owned = this.ownedSocketInode;
    this.ownedSocketInode = undefined;
    if (owned === undefined) return;
    try {
      if (fs.statSync(this.socketPath).ino === owned) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // The socket was already removed.
    }
  }

  private async initWeave(): Promise<void> {
    if (!this.config.weaveProject) {
      throw new Error('weaveProject required to init tracer');
    }
    if (!this.config.apiKey) {
      throw new Error('apiKey required to init tracer');
    }

    const [entity, project] = this.config.weaveProject.split('/', 2);
    if (!entity || !project) {
      throw new Error(
        `Invalid weave_project format: '${this.config.weaveProject}' (expected entity/project)`,
      );
    }

    process.env['WF_TRACE_SERVER_URL'] = this.config.baseUrl;
    process.env['WANDB_API_KEY'] = this.config.apiKey;

    const otelDiag = (message: string, ...args: unknown[]) =>
      this.log(
        'ERROR',
        `otel: ${message}${args.length ? ` ${args.map(String).join(' ')}` : ''}`,
      );
    diag.setLogger(
      {
        verbose: otelDiag,
        debug: otelDiag,
        info: otelDiag,
        warn: otelDiag,
        error: otelDiag,
      },
      DiagLogLevel.WARN,
    );

    await weave.init(this.config.weaveProject);
    this.tracingEnabled = true;
  }

  private handleConnection(socket: net.Socket): void {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejectedForSize = false;

    const timer = setTimeout(() => {
      this.log('ERROR', 'Connection timed out — closing');
      socket.destroy();
    }, CONNECTION_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SOCKET_PAYLOAD_BYTES) {
        rejectedForSize = true;
        clearTimeout(timer);
        this.log(
          'ERROR',
          `Socket payload exceeded ${MAX_SOCKET_PAYLOAD_BYTES} bytes — closing connection`,
        );
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      if (rejectedForSize) {
        socket.destroy();
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        socket.end();
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        this.log('ERROR', `Malformed JSON from hook: ${raw.slice(0, 200)}`);
        socket.end();
        return;
      }

      this.lastActivity = Date.now();
      if (isControlMessage(payload)) {
        if (payload.command === 'config-hash') {
          socket.end(JSON.stringify({
            config_hash: daemonConfigFingerprint(this.config),
            pid: process.pid,
            version: VERSION,
            path: daemonEntryPath(),
          }));
        } else {
          socket.end();
          void this.shutdown('control message');
        }
        return;
      }

      socket.end();
      void this.routeEvent(payload);
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      this.log('ERROR', `Socket error: ${err.message}`);
    });
  }

  private routeEvent(payload: unknown): Promise<void> {
    return this.tracingEnabled
      ? this.traceRuntime.process(payload)
      : Promise.resolve();
  }

  private checkInactivity(): void {
    const idle = Date.now() - this.lastActivity;
    if (idle <= this.inactivityMs) return;
    if (idle < INFLIGHT_HOLD_MAX_MS && this.hasInFlightWork()) {
      this.log('DEBUG', 'Inactivity timeout reached but work in flight — staying up');
      return;
    }
    this.log('INFO', 'Inactivity timeout — shutting down');
    void this.shutdown('inactivity');
  }

  private hasInFlightWork(): boolean {
    return this.traceRuntime.hasInFlightWork();
  }

  private async shutdown(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.drain(reason);
    process.exit(0);
  }

  private async drain(reason: string): Promise<void> {
    this.log('INFO', `Shutdown: ${reason}`);
    // The path can become visible just before listen's callback records it.
    this.captureSocketOwnership();
    let serverClosed: Promise<void> | undefined;
    if (this.server?.listening) {
      // Node stops listening and unlinks a Unix socket when close() is called;
      // the callback only waits for already accepted connections.
      serverClosed = new Promise<void>(resolve =>
        this.server!.close(() => resolve()));
      // A successor may now bind this path, so never inspect it again.
      this.ownedSocketInode = undefined;
    } else {
      this.releaseOwnedSocket();
    }
    await serverClosed;
    await this.traceRuntime.waitForPendingEvents();
    this.traceRuntime.finalizeForShutdown();
    if (this.tracingEnabled) {
      try {
        await weave.flushOTel();
      } catch (err) {
        this.log('ERROR', `Error flushing Weave SDK: ${err}`);
      }
    }
    this.traceRuntime.closeTranscripts();
  }

  private log(level: 'DEBUG' | 'INFO' | 'ERROR', message: string): void {
    if (level === 'DEBUG' && !this.config.debug) return;
    appendToLog(this.logFile, level, message);
  }
}

export async function runDaemon(): Promise<void> {
  const settings = loadSettings();
  const { daemon_socket: socketPath, log_file: logFile } = settings;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const config = resolveDaemonConfig(settings, process.env);
  if (!config.weaveProject || !config.apiKey) {
    const missing = missingConfig(
      Boolean(config.weaveProject),
      Boolean(config.apiKey),
      'WANDB_API_KEY',
    );
    appendToLog(
      logFile,
      'INFO',
      `Daemon not started — missing configuration: ${missing}`,
    );
    process.exit(0);
  }

  const daemon = new GlobalDaemon(socketPath, logFile, config);
  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
