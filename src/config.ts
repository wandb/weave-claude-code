// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Config resolution shared by the CLI and the daemon: the effective Weave
// project / API key / agent name (env over settings.json), plus the daemon's
// full config and its fingerprint. Lives here rather than in cli.ts or
// daemon.ts so both use one implementation without an import cycle (cli.ts
// imports the daemon entry point).

import { DEFAULT_AGENT_NAME } from './genaiSpans.js';
import { sha256Hex } from './utils.js';
import type { Settings } from './setup.js';

/** Where a resolved value came from, for user-facing "source" reporting. */
export enum WeaveProjectSource {
  EnvVar = 'WEAVE_PROJECT env var',
  Settings = 'settings.json',
  NotSet = 'not set',
}
export enum ApiKeySource {
  EnvVar = 'WANDB_API_KEY env var',
  Settings = 'settings.json',
  NotSet = 'not set',
}
/** No `NotSet`: agent_name always resolves to the built-in default. */
export enum AgentNameSource {
  EnvVar = 'WEAVE_AGENT_NAME env var',
  Settings = 'settings.json',
  Default = 'default',
}

/** Env-over-settings resolution shared by the project and API-key resolvers:
 *  a non-empty env value wins, then a non-empty settings value, else null.
 *  `sources` supplies the per-field labels for the matching branch. */
function resolveFromEnvOrSettings<S>(
  envValue: string | undefined,
  settingsValue: string | null | undefined,
  sources: { env: S; settings: S; notSet: S },
): { value: string | null; source: S } {
  if (envValue) return { value: envValue, source: sources.env };
  if (settingsValue) return { value: settingsValue, source: sources.settings };
  return { value: null, source: sources.notSet };
}

/** Resolve the effective Weave project (WEAVE_PROJECT env beats
 *  settings.weave_project) and where it came from. */
export function resolveProject(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): { value: string | null; source: WeaveProjectSource } {
  return resolveFromEnvOrSettings(env['WEAVE_PROJECT'], settings.weave_project, {
    env: WeaveProjectSource.EnvVar,
    settings: WeaveProjectSource.Settings,
    notSet: WeaveProjectSource.NotSet,
  });
}

/** Resolve the effective W&B API key (WANDB_API_KEY env beats
 *  settings.wandb_api_key) and where it came from. */
export function resolveApiKey(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): { value: string | null; source: ApiKeySource } {
  return resolveFromEnvOrSettings(env['WANDB_API_KEY'], settings.wandb_api_key, {
    env: ApiKeySource.EnvVar,
    settings: ApiKeySource.Settings,
    notSet: ApiKeySource.NotSet,
  });
}

/** Resolve the effective top-level agent name (WEAVE_AGENT_NAME env beats
 *  settings.agent_name), falling back to `DEFAULT_AGENT_NAME`. */
export function resolveAgentName(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): { value: string; source: AgentNameSource } {
  const fromEnv = env['WEAVE_AGENT_NAME']?.trim();
  if (fromEnv) return { value: fromEnv, source: AgentNameSource.EnvVar };
  const fromSettings = settings.agent_name?.trim();
  if (fromSettings) return { value: fromSettings, source: AgentNameSource.Settings };
  return { value: DEFAULT_AGENT_NAME, source: AgentNameSource.Default };
}

/** The config the daemon loads at startup and holds for its lifetime. */
export type DaemonConfig = {
  weaveProject: string | null;
  apiKey: string | null;
  baseUrl: string;
  agentName: string;
  debug: boolean;
};

/** Resolve the daemon config from settings + env, reusing the per-field
 *  resolvers so the env-over-settings precedence is defined once. */
export function resolveDaemonConfig(settings: Settings, env: NodeJS.ProcessEnv): DaemonConfig {
  return {
    weaveProject: resolveProject(settings, env).value,
    apiKey: resolveApiKey(settings, env).value,
    baseUrl: resolveTraceBaseUrl(env),
    agentName: resolveAgentName(settings, env).value,
    debug: !!env['WEAVE_CLAUDE_DEBUG'] || settings.debug === true,
  };
}

/** SaaS trace-ingest host: the default OTLP target, and what the routeless
 *  SaaS API host remaps to. */
const DEFAULT_TRACE_BASE_URL = 'https://trace.wandb.ai';

/** Resolve the Weave trace server base URL for OTLP export. `WF_TRACE_SERVER_URL`
 *  wins when set. Otherwise `WANDB_BASE_URL` is used, but SaaS `api.wandb.ai` is
 *  the wandb API host with no OTLP route, so it maps to `trace.wandb.ai`; a
 *  self-hosted `WANDB_BASE_URL` passes through unchanged. */
function resolveTraceBaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env['WF_TRACE_SERVER_URL']?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = (env['WANDB_BASE_URL'] ?? DEFAULT_TRACE_BASE_URL).replace(/\/+$/, '');
  return /^https?:\/\/api\.wandb\.ai$/i.test(base) ? DEFAULT_TRACE_BASE_URL : base;
}

/** Comma-joined list of missing required config, for the "incomplete"
 *  status/startup messages. `apiKeyLabel` differs by call site
 *  (`wandb_api_key` for config-oriented messages, `WANDB_API_KEY` for
 *  env-oriented ones). */
export function missingConfig(hasProject: boolean, hasApiKey: boolean, apiKeyLabel: string): string {
  return [!hasProject && 'weave_project', !hasApiKey && apiKeyLabel].filter(Boolean).join(', ');
}

/** Hex chars kept from the config hash. 16 (64 bits) is ample to detect a
 *  config change while staying compact for logs and the socket reply. */
const CONFIG_FINGERPRINT_LENGTH = 16;

/** Short, stable hash of a daemon config. The API key is hashed, not exposed,
 *  so the fingerprint is safe to send over the socket. */
export function daemonConfigFingerprint(c: DaemonConfig): string {
  return sha256Hex(JSON.stringify([c.weaveProject, c.apiKey, c.baseUrl, c.agentName, c.debug]))
    .slice(0, CONFIG_FINGERPRINT_LENGTH);
}
