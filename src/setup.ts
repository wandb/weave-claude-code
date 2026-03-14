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

export const CONFIG_DIR = path.join(os.homedir(), '.weave_claude_plugin');
export const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
export const VERSION = '0.1.0';

// Claude Code plugin marketplace coordinates
export const MARKETPLACE_REPO = 'wandb/claude_code_weave_plugin';
export const MARKETPLACE_NAME = 'wandb-claude_code_weave_plugin';
export const PLUGIN_NAME = 'weave-claude';

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
    ['plugin', 'marketplace', 'add', MARKETPLACE_REPO],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const mktAlready = /already/i.test((mktResult.stderr ?? '') + (mktResult.stdout ?? ''));
  if (mktResult.status !== 0 && !mktAlready) {
    const output = ((mktResult.stderr ?? '') + (mktResult.stdout ?? '')).trim();
    const msg = `Failed to register marketplace '${MARKETPLACE_REPO}': ${output}`;
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
