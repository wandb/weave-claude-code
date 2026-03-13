import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { loadSettings } from './setup.js';
import { appendToLog } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Inbound control message sent directly to the socket (not a hook event). */
interface ControlMessage {
  command: 'shutdown';
}

/** Raw hook-event payload forwarded by hook-handler.sh. */
type HookPayload = Record<string, unknown>;

function isControlMessage(payload: unknown): payload is ControlMessage {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as ControlMessage).command === 'shutdown'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GlobalDaemon
// ─────────────────────────────────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes
const CONNECTION_TIMEOUT_MS = 5_000;            // 5 seconds per connection

export class GlobalDaemon {
  private server?: net.Server;
  private running = false;
  private lastActivity = Date.now();

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
  ) {}

  async start(): Promise<void> {
    // Remove any stale socket left by a previous crash
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    // Restrict socket to owner-only access
    const prevUmask = process.umask(0o077);
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, resolve);
      this.server!.once('error', reject);
    });
    process.umask(prevUmask);

    this.running = true;
    this.log('INFO', `Daemon started — socket: ${this.socketPath}`);

    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT',  () => this.shutdown('SIGINT'));

    setInterval(() => this.checkInactivity(), 60_000).unref();
  }

  // ── connection handling ───────────────────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    const chunks: Buffer[] = [];

    const timer = setTimeout(() => {
      this.log('ERROR', 'Connection timed out — closing');
      socket.destroy();
    }, CONNECTION_TIMEOUT_MS);

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.on('end', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return;

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        this.log('ERROR', `Malformed JSON from hook: ${raw.slice(0, 200)}`);
        return;
      }

      this.lastActivity = Date.now();

      if (isControlMessage(payload)) {
        this.shutdown('control message');
        return;
      }

      this.logEvent(payload as HookPayload);
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      this.log('ERROR', `Socket error: ${err.message}`);
    });
  }

  // ── event logging ─────────────────────────────────────────────────────────

  /**
   * Log every incoming hook event as a single JSON line.
   * PR 5+ will replace this with real Weave call tracking.
   */
  private logEvent(payload: HookPayload): void {
    const eventName = (payload['hook_event_name'] as string | undefined) ?? 'unknown';
    const sessionId = (payload['session_id'] as string | undefined) ?? '-';
    this.log('EVENT', `${eventName} session=${sessionId} ${JSON.stringify(payload)}`);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private checkInactivity(): void {
    if (Date.now() - this.lastActivity > INACTIVITY_TIMEOUT_MS) {
      this.log('INFO', 'Inactivity timeout — shutting down');
      this.shutdown('inactivity');
    }
  }

  private shutdown(reason: string): void {
    if (!this.running) return;
    this.running = false;
    this.log('INFO', `Shutdown: ${reason}`);
    this.server?.close();
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    process.exit(0);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private log(level: 'INFO' | 'ERROR' | 'EVENT', msg: string): void {
    appendToLog(this.logFile, level === 'EVENT' ? 'INFO' : level, msg);
  }

  /** Validate that a transcript path is within the user's home directory. */
  static validateTranscriptPath(transcriptPath: string): boolean {
    try {
      return path.resolve(transcriptPath).startsWith(os.homedir() + path.sep);
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point (invoked by `weave-claude-plugin daemon`)
// ─────────────────────────────────────────────────────────────────────────────

export async function runDaemon(args: string[]): Promise<void> {
  const settings = loadSettings();

  const socketIdx = args.indexOf('--socket');
  const socketPath = socketIdx !== -1
    ? args[socketIdx + 1]!
    : settings.daemon_socket;
  const logFile = settings.log_file;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const daemon = new GlobalDaemon(socketPath, logFile);

  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
