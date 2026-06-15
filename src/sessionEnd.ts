// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { Tracer } from '@opentelemetry/api';
import { buildTrace } from './buildTrace.js';
import { createTracerProvider } from './tracerProvider.js';
import { DEFAULT_AGENT_NAME } from './genaiSpans.js';
import { VERSION } from './version.mjs';
import type { Settings } from './setup.js';

/** Subset of the SessionEnd hook payload the builder needs. */
interface SessionEndPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
}

/** Minimal provider shape so tests can inject an in-memory provider. */
export interface ProviderLike {
  getTracer(name: string, version?: string): Tracer;
  shutdown(): Promise<void>;
}

export interface SessionEndResult {
  status: 'ok' | 'skipped';
  reason?: string;
  turns: number;
}

/**
 * Resolve `trace_roots` from env (comma-separated `WEAVE_TRACE_ROOTS`) or the
 * settings file. Env wins. Empty ⇒ global (trace everything).
 */
export function resolveTraceRoots(settings: Settings, env: NodeJS.ProcessEnv): string[] {
  const fromEnv = env['WEAVE_TRACE_ROOTS'];
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.split(',').map(s => s.trim()).filter(Boolean);
  }
  const fromSettings = (settings as unknown as Record<string, unknown>)['trace_roots'];
  if (Array.isArray(fromSettings)) {
    return fromSettings.filter((r): r is string => typeof r === 'string' && !!r.trim());
  }
  return [];
}

/**
 * Daemonless SessionEnd handler: parse the hook payload, resolve Weave config
 * the same way the daemon does, build the full span tree from the (now
 * complete) transcript in one pass, and flush the exporter before returning.
 *
 * Never throws on missing config or bad input — returns a `skipped` result so
 * the hook can exit 0 and never disrupt Claude Code. `makeProvider` is
 * injectable for tests; production uses the real OTLP provider.
 */
export async function runSessionEnd(
  rawPayload: string,
  settings: Settings,
  env: NodeJS.ProcessEnv,
  makeProvider: (args: Parameters<typeof createTracerProvider>[0]) => ProviderLike = createTracerProvider,
): Promise<SessionEndResult> {
  let payload: SessionEndPayload;
  try {
    payload = JSON.parse(rawPayload) as SessionEndPayload;
  } catch {
    return { status: 'skipped', reason: 'unparseable payload', turns: 0 };
  }

  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!sessionId || !transcriptPath) {
    return { status: 'skipped', reason: 'missing session_id or transcript_path', turns: 0 };
  }

  const weaveProject = env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const apiKey = env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
  if (!weaveProject || !apiKey) {
    return { status: 'skipped', reason: 'weave_project or WANDB_API_KEY not set', turns: 0 };
  }

  const baseUrl = (env['WANDB_BASE_URL'] ?? 'https://trace.wandb.ai').replace(/\/+$/, '');
  const agentName =
    env['WEAVE_AGENT_NAME']?.trim() ||
    settings.agent_name?.trim() ||
    DEFAULT_AGENT_NAME;
  const debug = !!env['WEAVE_CLAUDE_DEBUG'] || settings.debug === true;
  const traceRoots = resolveTraceRoots(settings, env);

  const provider = makeProvider({ weaveProject, apiKey, baseUrl, agentName, debug });
  const tracer = provider.getTracer('weave-claude-code', VERSION);

  let turns = 0;
  try {
    turns = buildTrace(tracer, transcriptPath, {
      sessionId,
      // Resume/forked-session conversation stitching is deferred; a fresh
      // session's conversation id equals its session id.
      conversationId: sessionId,
      cwd: payload.cwd ?? '',
      source: payload.source ?? 'session-end',
      agentName,
      pluginVersion: VERSION,
      traceRoots,
    });
  } finally {
    // Flush pending batches before exit — the daemonless equivalent of the
    // daemon's shutdown-time provider.shutdown().
    await provider.shutdown();
  }

  return { status: 'ok', turns };
}
