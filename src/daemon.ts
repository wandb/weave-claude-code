import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { init, WeaveClient } from 'weave';
import { uuidv7 } from 'uuidv7';
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

interface SessionState {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  traceId: string;

  // Weave call IDs
  sessionCallId?: string;
  currentTurnCallId?: string;

  // Tracking
  turnNumber: number;
  totalToolCalls: number;
  toolCounts: Record<string, number>;
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
  private sessions = new Map<string, SessionState>();
  private weaveClient: WeaveClient | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly logFile: string,
    private readonly weaveProject: string | null,
  ) {}

  async start(): Promise<void> {
    // Initialize Weave client if a project is configured
    if (this.weaveProject) {
      try {
        this.weaveClient = await init(this.weaveProject);
        this.log('INFO', `Weave initialized for project: ${this.weaveProject}`);
      } catch (err) {
        this.log('ERROR', `Failed to initialize Weave: ${err} — continuing without Weave`);
        this.weaveClient = null;
      }
    } else {
      this.log('INFO', 'No weave_project configured — Weave tracking disabled');
    }

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

    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGINT',  () => void this.shutdown('SIGINT'));

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
        void this.shutdown('control message');
        return;
      }

      void this.routeEvent(payload as HookPayload);
    });

    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      this.log('ERROR', `Socket error: ${err.message}`);
    });
  }

  // ── event routing ─────────────────────────────────────────────────────────

  private async routeEvent(payload: HookPayload): Promise<void> {
    const eventName = payload['hook_event_name'] as string | undefined;
    const sessionId = payload['session_id'] as string | undefined;

    if (!sessionId) {
      this.log('ERROR', 'Missing session_id in payload');
      return;
    }

    this.log('INFO', `${eventName ?? 'unknown'} session=${sessionId}`);

    try {
      switch (eventName) {
        case 'SessionStart':
          await this.handleSessionStart(sessionId, payload);
          break;
        case 'UserPromptSubmit':
          await this.handleUserPromptSubmit(sessionId, payload);
          break;
        case 'Stop':
          await this.handleStop(sessionId, payload);
          break;
        case 'SessionEnd':
          await this.handleSessionEnd(sessionId, payload);
          break;
        default:
          // Unhandled events are logged above; no further action needed in PR 5.
          break;
      }
    } catch (err) {
      this.log('ERROR', `Error handling ${eventName ?? 'unknown'}: ${err}`);
    }
  }

  // ── event handlers ────────────────────────────────────────────────────────

  private async handleSessionStart(sessionId: string, payload: HookPayload): Promise<void> {
    if (this.sessions.has(sessionId)) return; // idempotent

    const transcriptPath = payload['transcript_path'] as string | undefined;
    if (!transcriptPath || !GlobalDaemon.validateTranscriptPath(transcriptPath)) {
      this.log('ERROR', `Invalid or missing transcript_path for session ${sessionId}`);
      return;
    }

    this.sessions.set(sessionId, {
      sessionId,
      transcriptPath,
      cwd: (payload['cwd'] as string | undefined) ?? '',
      traceId: uuidv7(),
      turnNumber: 0,
      totalToolCalls: 0,
      toolCounts: {},
    });

    this.log('INFO', `Session created: ${sessionId}`);
  }

  private async handleUserPromptSubmit(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.log('ERROR', `Unknown session: ${sessionId}`);
      return;
    }

    const prompt = (payload['prompt'] as string | undefined) ?? '';

    // Create the top-level session call on the first turn
    if (!session.sessionCallId && this.weaveClient) {
      const callId = uuidv7();
      session.sessionCallId = callId;
      this.weaveClient.saveCallStart({
        project_id: this.weaveClient.projectId,
        id: callId,
        op_name: 'claude_code.session',
        trace_id: session.traceId,
        parent_id: null,
        started_at: new Date().toISOString(),
        display_name: 'Claude Session',
        inputs: { prompt },
        attributes: {
          session_id: session.sessionId,
          cwd: session.cwd,
        },
      });
      this.log('INFO', `Created session call: ${callId}`);
    }

    // Create a turn call for every prompt
    session.turnNumber += 1;
    const turnCallId = uuidv7();
    session.currentTurnCallId = turnCallId;

    if (this.weaveClient) {
      this.weaveClient.saveCallStart({
        project_id: this.weaveClient.projectId,
        id: turnCallId,
        op_name: 'claude_code.turn',
        trace_id: session.traceId,
        parent_id: session.sessionCallId ?? null,
        started_at: new Date().toISOString(),
        display_name: `Turn ${session.turnNumber}`,
        inputs: { prompt },
        attributes: {},
      });
      this.log('INFO', `Created turn call: ${turnCallId} (turn ${session.turnNumber})`);
    }
  }

  private async handleStop(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.currentTurnCallId || !this.weaveClient) return;

    const assistantMessage = (payload['last_assistant_message'] as string | undefined) ?? '';

    this.weaveClient.saveCallEnd({
      project_id: this.weaveClient.projectId,
      id: session.currentTurnCallId,
      ended_at: new Date().toISOString(),
      output: { assistant_message: assistantMessage },
      summary: {},
    });

    this.log('INFO', `Finished turn ${session.turnNumber}`);
  }

  private async handleSessionEnd(sessionId: string, payload: HookPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.sessionCallId && this.weaveClient) {
      this.weaveClient.saveCallEnd({
        project_id: this.weaveClient.projectId,
        id: session.sessionCallId,
        ended_at: new Date().toISOString(),
        output: { reason: (payload['reason'] as string | undefined) ?? '' },
        summary: {
          turn_count: session.turnNumber,
          tool_count: session.totalToolCalls,
          tool_counts: session.toolCounts,
        },
      });
      this.log('INFO', `Finished session ${sessionId}`);
    }

    this.sessions.delete(sessionId);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  private checkInactivity(): void {
    if (Date.now() - this.lastActivity > INACTIVITY_TIMEOUT_MS) {
      this.log('INFO', 'Inactivity timeout — shutting down');
      void this.shutdown('inactivity');
    }
  }

  private async shutdown(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log('INFO', `Shutdown: ${reason}`);
    this.server?.close();
    if (this.weaveClient) {
      try {
        await this.weaveClient.waitForBatchProcessing();
      } catch (err) {
        this.log('ERROR', `Error flushing Weave batch: ${err}`);
      }
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    process.exit(0);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private log(level: 'INFO' | 'ERROR', msg: string): void {
    appendToLog(this.logFile, level, msg);
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

export async function runDaemon(): Promise<void> {
  const settings = loadSettings();
  const { daemon_socket: socketPath, log_file: logFile } = settings;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const weaveProject = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const apiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;

  if (!weaveProject || !apiKey) {
    const missing = [!weaveProject && 'weave_project', !apiKey && 'WANDB_API_KEY'].filter(Boolean).join(', ');
    appendToLog(logFile, 'INFO', `Daemon not started — missing configuration: ${missing}`);
    process.exit(0);
  }

  // Ensure the Weave SDK sees the API key regardless of whether it came from
  // settings.json or was already in the environment.
  process.env['WANDB_API_KEY'] = apiKey;

  const daemon = new GlobalDaemon(socketPath, logFile, weaveProject);

  try {
    await daemon.start();
  } catch (err) {
    appendToLog(logFile, 'ERROR', `Daemon failed to start: ${err}`);
    process.exit(1);
  }
}
