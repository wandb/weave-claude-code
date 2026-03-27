// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { findClaudeCLI, appendToLog } from './utils.js';

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
  /** Plugin was already installed — no change made. */
  AlreadyInstalled = 'already_installed',
}

export interface PluginResult {
  marketplaceStatus: MarketplaceStatus;
  pluginStatus: PluginStatus;
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

export const CONFIG_DIR = path.join(os.homedir(), '.weave_claude_plugin');
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
export const VERSION = '0.1.1';

// Claude Code plugin marketplace coordinates. Pin installs to a release tag so
// new users never consume whatever happens to be on the default branch at
// install time.
export const MARKETPLACE_REPO = 'wandb/claude_code_weave_plugin';
export const MARKETPLACE_REF = `df2980951dcd409d9081771a90c4a9f897a7db3d`;
export const MARKETPLACE_SOURCE = `${MARKETPLACE_REPO}#${MARKETPLACE_REF}`;
export const MARKETPLACE_NAME = 'weave-claude-plugin';
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
 * Register the marketplace in Claude Code and install the plugin at user scope.
 *
 * Requires the `claude` CLI to be in PATH. Throws (and writes to logFile) on
 * any unrecoverable error. Idempotent — "already registered/installed" is not
 * treated as an error.
 */
export function registerPlugin(logFile: string): PluginResult {
  const claudePath = findClaudeCLI();
  if (!claudePath) {
    const msg = [
      "'claude' CLI not found in PATH.",
      'Install Claude Code before running this command:',
      '  https://claude.ai/download',
      'Then re-run: weave-claude-plugin install',
    ].join('\n');
    appendToLog(logFile, 'ERROR', msg);
    throw new Error(msg);
  }

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

  return {
    marketplaceStatus: mktAlready ? MarketplaceStatus.AlreadyRegistered : MarketplaceStatus.Registered,
    pluginStatus: pluginAlready ? PluginStatus.AlreadyInstalled : PluginStatus.Installed,
  };
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
    throw new Error(`Settings not found at ${SETTINGS_FILE}\nRun: weave-claude-plugin install`);
  }
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
}

export function saveSettings(settings: Settings): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  fs.chmodSync(SETTINGS_FILE, 0o600);
}
