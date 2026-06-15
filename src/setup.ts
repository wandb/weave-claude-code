// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { findClaudeCLI, appendToLog } from './utils.js';
import { VERSION } from './version.mjs';

export { VERSION };

export interface Settings {
  log_file: string;
  weave_project: string | null;
  wandb_api_key: string | null;
  /** Overrides the name shown in Weave's Agents view (the top-level agent).
   *  null falls back to `DEFAULT_AGENT_NAME` ('claude-code'). Settings
   *  written before this field existed read as undefined, which the daemon
   *  treats identically to null. */
  agent_name: string | null;
  debug: boolean;
  installed_at: string;
  version: string;
  daemon_socket: string;
  /** Tracing strategy. `daemon` (default) uses the persistent daemon.
   *  `session-end` is the daemonless path: a SessionEnd hook reconstructs the
   *  full span tree from the transcript in one pass and uploads — no daemon,
   *  no socket. Settings written before this field existed read as undefined,
   *  treated as `daemon`. */
  trace_mode?: 'daemon' | 'session-end';
}

export interface ConfigResult {
  settingsFile: string;
  logFile: string;
}

/**
 * Where `registerPlugin` should pull the marketplace from.
 *
 * `GitHub` (default) hands Claude Code a `repo#ref` source spec and lets it
 * clone over git. `Local` points Claude Code at the npm-installed plugin tree
 * on disk so it never touches the network; required in CI/sandbox
 * environments without git/SSH access to GitHub.
 */
export enum InstallSource {
  GitHub = 'github',
  Local = 'local',
}

export enum MarketplaceStatus {
  /** Marketplace was freshly added to Claude Code on this run. */
  Registered = 'registered',
  /** Marketplace was already present — no change made. */
  AlreadyRegistered = 'already_registered',
}

export enum PluginStatus {
  /** Plugin was freshly installed at user scope on this run. */
  Installed = 'installed',
  /**
   * `claude plugin install` was a no-op because the plugin was already
   * registered at user scope. Independent of `pluginUpdated` on the result:
   * even when this value is returned, the drift path may have followed up
   * with `claude plugin update` — check `pluginUpdated` for the upgrade signal.
   */
  AlreadyInstalled = 'already_installed',
}

export interface PluginResult {
  marketplaceStatus: MarketplaceStatus;
  pluginStatus: PluginStatus;
  /** True when the marketplace ref drifted and `claude plugin update` was invoked to upgrade the installed plugin. */
  pluginUpdated: boolean;
  /** The marketplace ref Claude Code had registered before this run (null if not previously registered). */
  refBefore: string | null;
  /** The marketplace ref Claude Code has registered after this run. */
  refAfter: string | null;
}

export enum RemovalStatus {
  Removed = 'removed',
  AlreadyAbsent = 'already_absent',
  Failed = 'failed',
}

export interface UninstallResult {
  marketplaceStatus: RemovalStatus;
  pluginStatus: RemovalStatus;
  marketplaceError?: string;
  pluginError?: string;
}

export const CONFIG_DIR = path.join(os.homedir(), '.weave-claude-code');
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// Claude Code plugin marketplace coordinates. Pin installs to a release tag so
// new users never consume whatever happens to be on the default branch at
// install time.
export const MARKETPLACE_REPO = 'wandb/weave-claude-code';
export const MARKETPLACE_REF = `v${VERSION}`;
export const MARKETPLACE_SOURCE = `${MARKETPLACE_REPO}#${MARKETPLACE_REF}`;
export const MARKETPLACE_NAME = 'weave-claude-code';
export const PLUGIN_NAME = 'weave';

// The npm package name shipped to the registry (matches package.json#name).
// Coincidentally equal to MARKETPLACE_NAME today but a distinct concept: the
// marketplace name lives in .claude-plugin/marketplace.json, the npm package
// name lives in package.json. Kept separate so renaming one does not silently
// break the other.
const NPM_PACKAGE_NAME = 'weave-claude-code';

/**
 * Create (or recreate) the config directory, log directory, and settings.json.
 *
 * Pure file I/O — no external calls. Safe to call from the daemon, skills,
 * or any context that needs the config to exist without triggering Claude Code
 * plugin registration.
 */
export function createConfig(configDir: string): ConfigResult {
  fs.mkdirSync(configDir, { recursive: true });

  const settingsFile = path.join(configDir, 'settings.json');
  const logDir = path.join(configDir, 'logs');
  const logFile = path.join(logDir, 'daemon.log');

  fs.mkdirSync(logDir, { recursive: true });

  // Re-running `install` must NOT wipe an existing config: read what's there
  // and preserve every user-controllable field (weave_project, wandb_api_key,
  // agent_name, debug, trace_mode, custom paths, installed_at). Only the version
  // is refreshed. A fresh install (no file, or unreadable) gets the defaults.
  let existing: Partial<Settings> = {};
  if (fs.existsSync(settingsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Partial<Settings>;
    } catch {
      existing = {};
    }
  }

  const settings: Settings = {
    log_file: existing.log_file ?? logFile,
    weave_project: existing.weave_project ?? null,
    wandb_api_key: existing.wandb_api_key ?? null,
    agent_name: existing.agent_name ?? null,
    debug: existing.debug ?? false,
    installed_at: existing.installed_at ?? new Date().toISOString(),
    version: VERSION,
    daemon_socket: existing.daemon_socket ?? path.join(configDir, 'daemon.sock'),
    trace_mode: existing.trace_mode ?? 'daemon',
  };

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  fs.chmodSync(settingsFile, 0o600);

  return { settingsFile, logFile };
}

/**
 * Locate the npm-installed weave-claude-code package tree, or null if the
 * package isn't installed globally. Used by `InstallSource.Local` to register
 * the marketplace from disk instead of cloning from GitHub.
 *
 * The npm tarball ships `.claude-plugin/marketplace.json`
 * (see `package.json#files`), so its presence is the marker for a usable
 * local source.
 */
export function findLocalPluginPath(): string | null {
  const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const candidate = path.join(result.stdout.trim(), NPM_PACKAGE_NAME);
  if (!fs.existsSync(path.join(candidate, '.claude-plugin', 'marketplace.json'))) {
    return null;
  }
  return candidate;
}

/**
 * Discriminated union describing how Claude Code registered a marketplace.
 * Mirrors the two `source.source` values the real `claude` CLI writes into
 * `~/.claude/plugins/known_marketplaces.json` (verified empirically):
 *   - `github`: cloned from a GitHub repo, optionally pinned to a ref
 *   - `directory`: registered from a local path (the `--source=local` path).
 *     `version` is read from `<path>/package.json#version` for npm-installed
 *     trees; `null` when the path has no parseable package.json (e.g. a
 *     hand-rolled directory marketplace).
 */
export type PluginSource =
  | { type: 'github'; repo: string; ref: string | null }
  | { type: 'directory'; path: string; version: string | null };

/**
 * Read and parse a JSON file. Returns null if the file is missing or
 * unparseable. Caller is responsible for shape validation on the returned
 * value (typed as `unknown`).
 */
function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read `<dir>/package.json#version`. Returns null if the file is missing,
 * unparseable, or lacks a string `version`. Used to surface the npm-installed
 * version for directory-source registrations.
 */
function readPackageVersion(dir: string): string | null {
  const pkg = readJsonFile(path.join(dir, 'package.json')) as { version?: unknown } | null;
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/**
 * Read and normalize the source spec Claude Code has registered for the given
 * marketplace, or null if the marketplace isn't registered or the on-disk
 * shape is unrecognized. Unknown shapes are treated as null rather than
 * throwing so a future Claude Code schema change degrades to "Source: not
 * registered" rather than crashing status.
 */
/**
 * Shape of a github-source entry inside known_marketplaces.json. `ref` is
 * optional because pre-v0.2 marketplace registrations didn't pin to a tag.
 */
type RawGithubSource = { source: 'github'; repo: string; ref?: string };
type RawDirectorySource = { source: 'directory'; path: string };

function isRawGithubSource(s: Record<string, unknown>): s is RawGithubSource {
  return s['source'] === 'github'
    && typeof s['repo'] === 'string'
    && (s['ref'] === undefined || typeof s['ref'] === 'string');
}

function isRawDirectorySource(s: Record<string, unknown>): s is RawDirectorySource {
  return s['source'] === 'directory' && typeof s['path'] === 'string';
}

export function readRegisteredPluginSource(marketplaceName: string): PluginSource | null {
  const knownPath = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  const raw = readJsonFile(knownPath);
  if (raw === null) return null;
  const entry = (raw as Record<string, { source?: Record<string, unknown> }>)[marketplaceName];
  const source = entry?.source;
  if (!source || typeof source !== 'object') return null;
  if (isRawGithubSource(source)) {
    return { type: 'github', repo: source.repo, ref: source.ref ?? null };
  }
  if (isRawDirectorySource(source)) {
    return { type: 'directory', path: source.path, version: readPackageVersion(source.path) };
  }
  return null;
}

/**
 * Convenience wrapper for the github-ref drift detector in `registerPlugin`.
 * Returns null for directory sources (no version-tag concept applies).
 */
export function readRegisteredMarketplaceRef(marketplaceName: string): string | null {
  const source = readRegisteredPluginSource(marketplaceName);
  return source?.type === 'github' ? source.ref : null;
}

/**
 * Register the marketplace in Claude Code and install the plugin at user scope.
 *
 * Requires the `claude` CLI to be in PATH. Throws (and writes to logFile) on
 * any unrecoverable error. "Already registered/installed" is not treated as
 * an error.
 *
 * Convergent rather than strictly idempotent: a repeat call with the same
 * binary version is a no-op, but a repeat call with an upgraded binary (whose
 * `MARKETPLACE_REF` differs from what Claude Code has cached) will follow up
 * with `claude plugin update` to bring the installed plugin in line with the
 * refreshed marketplace. Final state is always "marketplace at current
 * MARKETPLACE_REF, plugin at the version that marketplace advertises."
 */
/**
 * Pick the marketplace argument `claude plugin marketplace add` should receive.
 * Throws (with a message that names the fix) if `--source=local` was requested
 * but the npm-installed tree isn't on disk.
 */
function resolveMarketplaceArg(source: InstallSource, logFile: string): string {
  if (source !== InstallSource.Local) return MARKETPLACE_SOURCE;
  const localPath = findLocalPluginPath();
  if (!localPath) {
    const msg = [
      '--source=local requires weave-claude-code to be installed globally via npm,',
      "but `npm root -g` did not yield a weave-claude-code/.claude-plugin/marketplace.json.",
      'Run: npm install -g weave-claude-code',
    ].join('\n');
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }
  return localPath;
}

export function registerPlugin(
  logFile: string,
  source: InstallSource = InstallSource.GitHub,
): PluginResult {
  const claudePath = findClaudeCLI();
  if (!claudePath) {
    const msg = [
      "'claude' CLI not found in PATH.",
      'Install Claude Code before running this command:',
      '  https://claude.ai/download',
      'Then re-run: weave-claude-code install',
    ].join('\n');
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }

  const marketplaceArg = resolveMarketplaceArg(source, logFile);

  const refBefore = readRegisteredMarketplaceRef(MARKETPLACE_NAME);

  // Register marketplace
  const mktResult = spawnSync(
    claudePath,
    ['plugin', 'marketplace', 'add', marketplaceArg],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const mktAlready = /already/i.test((mktResult.stderr ?? '') + (mktResult.stdout ?? ''));
  if (mktResult.status !== 0 && !mktAlready) {
    const output = ((mktResult.stderr ?? '') + (mktResult.stdout ?? '')).trim();
    const msg = `Failed to register marketplace '${marketplaceArg}': ${output}`;
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }

  const refAfter = readRegisteredMarketplaceRef(MARKETPLACE_NAME);
  // Drift detection compares marketplace refs (version tags). Local sources
  // have no version tag (npm is the version-of-record), so skip the check and
  // let the user re-run `npm install -g weave-claude-code` to upgrade.
  const refDrifted = source !== InstallSource.Local && refBefore !== null && refBefore !== refAfter;

  // Install plugin at user scope
  const pluginResult = spawnSync(
    claudePath,
    ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const pluginAlready = /already/i.test((pluginResult.stderr ?? '') + (pluginResult.stdout ?? ''));
  if (pluginResult.status !== 0 && !pluginAlready) {
    const output = ((pluginResult.stderr ?? '') + (pluginResult.stdout ?? '')).trim();
    const msg = `Failed to install plugin '${PLUGIN_NAME}': ${output}`;
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }

  const { updated: pluginUpdated } = maybeUpdateOutdatedPlugin(claudePath, logFile, refDrifted, pluginAlready);

  return {
    marketplaceStatus: mktAlready ? MarketplaceStatus.AlreadyRegistered : MarketplaceStatus.Registered,
    pluginStatus: pluginAlready ? PluginStatus.AlreadyInstalled : PluginStatus.Installed,
    pluginUpdated,
    refBefore,
    refAfter,
  };
}

/**
 * Follow `claude plugin install` with `claude plugin update` when the
 * marketplace ref drifted but the plugin was already there at the old ref —
 * `install` short-circuits as "already installed" without re-pulling from the
 * refreshed marketplace. Fresh installs (refBefore === null) don't need this:
 * `install` installs from the freshly-registered marketplace. `claude plugin
 * marketplace remove` removes the plugin too, so refBefore === null with
 * pluginAlready === true isn't reachable through normal CLI use.
 */
function maybeUpdateOutdatedPlugin(
  claudePath: string,
  logFile: string,
  refDrifted: boolean,
  pluginAlready: boolean,
): { updated: boolean } {
  if (!(refDrifted && pluginAlready)) return { updated: false };

  const updateResult = spawnSync(
    claudePath,
    ['plugin', 'update', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (updateResult.status !== 0) {
    const output = ((updateResult.stderr ?? '') + (updateResult.stdout ?? '')).trim();
    const msg = `Failed to update plugin '${PLUGIN_NAME}': ${output}`;
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }
  return { updated: true };
}

/**
 * Uninstall the plugin from Claude Code and remove its marketplace.
 *
 * Requires the `claude` CLI to be in PATH. Idempotent — already-removed
 * plugins or marketplaces are treated as success.
 */
export function unregisterPlugin(): UninstallResult {
  const claudePath = findClaudeCLI();
  if (!claudePath) {
    const msg = "'claude' CLI not found in PATH. Skipping Claude plugin and marketplace removal.";
    return {
      pluginStatus: RemovalStatus.Failed,
      marketplaceStatus: RemovalStatus.Failed,
      pluginError: msg,
      marketplaceError: msg,
    };
  }

  let pluginStatus: RemovalStatus = RemovalStatus.Removed;
  let pluginError: string | undefined;

  const pluginResult = spawnSync(
    claudePath,
    ['plugin', 'uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const pluginAlreadyAbsent = /not installed|not found|unknown plugin|no installed plugin/i
    .test((pluginResult.stderr ?? '') + (pluginResult.stdout ?? ''));
  if (pluginResult.status !== 0) {
    if (pluginAlreadyAbsent) {
      pluginStatus = RemovalStatus.AlreadyAbsent;
    } else {
      const output = ((pluginResult.stderr ?? '') + (pluginResult.stdout ?? '')).trim();
      pluginStatus = RemovalStatus.Failed;
      pluginError = `Failed to uninstall plugin '${PLUGIN_NAME}': ${output}`;
    }
  } else if (pluginAlreadyAbsent) {
    pluginStatus = RemovalStatus.AlreadyAbsent;
  }

  let marketplaceStatus: RemovalStatus = RemovalStatus.Removed;
  let marketplaceError: string | undefined;

  const mktResult = spawnSync(
    claudePath,
    ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const marketplaceAlreadyAbsent = /not found|unknown marketplace|no configured marketplace/i
    .test((mktResult.stderr ?? '') + (mktResult.stdout ?? ''));
  if (mktResult.status !== 0) {
    if (marketplaceAlreadyAbsent) {
      marketplaceStatus = RemovalStatus.AlreadyAbsent;
    } else {
      const output = ((mktResult.stderr ?? '') + (mktResult.stdout ?? '')).trim();
      marketplaceStatus = RemovalStatus.Failed;
      marketplaceError = `Failed to remove marketplace '${MARKETPLACE_NAME}': ${output}`;
    }
  } else if (marketplaceAlreadyAbsent) {
    marketplaceStatus = RemovalStatus.AlreadyAbsent;
  }

  return {
    pluginStatus,
    marketplaceStatus,
    pluginError,
    marketplaceError,
  };
}

export function loadSettings(): Settings {
  if (!fs.existsSync(SETTINGS_FILE)) {
    throw new Error(`Settings not found at ${SETTINGS_FILE}\nRun: weave-claude-code install`);
  }
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  fs.chmodSync(SETTINGS_FILE, 0o600);
}
