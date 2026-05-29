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
  debug: boolean;
  installed_at: string;
  version: string;
  daemon_socket: string;
}

export interface ConfigResult {
  settingsFile: string;
  logFile: string;
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

  const settings: Settings = {
    log_file: logFile,
    weave_project: null,
    wandb_api_key: null,
    debug: false,
    installed_at: new Date().toISOString(),
    version: VERSION,
    daemon_socket: path.join(configDir, 'daemon.sock'),
  };

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  fs.chmodSync(settingsFile, 0o600);

  return { settingsFile, logFile };
}

/**
 * Read the ref Claude Code has registered for the given marketplace, or null
 * if the marketplace isn't registered. Used to detect drift when re-running
 * `install` after a CLI upgrade: a new binary's MARKETPLACE_REF may differ from
 * what Claude Code last cached, in which case the installed plugin is stale
 * and needs a follow-up `claude plugin update`.
 */
export function readRegisteredMarketplaceRef(marketplaceName: string): string | null {
  const knownPath = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  if (!fs.existsSync(knownPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(knownPath, 'utf8')) as Record<string, { source?: { ref?: string } }>;
    return data[marketplaceName]?.source?.ref ?? null;
  } catch {
    return null;
  }
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
export function registerPlugin(logFile: string): PluginResult {
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

  const refBefore = readRegisteredMarketplaceRef(MARKETPLACE_NAME);

  // Register marketplace
  const mktResult = spawnSync(
    claudePath,
    ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const mktAlready = /already/i.test((mktResult.stderr ?? '') + (mktResult.stdout ?? ''));
  if (mktResult.status !== 0 && !mktAlready) {
    const output = ((mktResult.stderr ?? '') + (mktResult.stdout ?? '')).trim();
    const msg = `Failed to register marketplace '${MARKETPLACE_SOURCE}': ${output}`;
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }

  const refAfter = readRegisteredMarketplaceRef(MARKETPLACE_NAME);
  const refDrifted = refBefore !== null && refBefore !== refAfter;

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
