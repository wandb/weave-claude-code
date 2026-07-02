#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import {
  CONFIG_DIR,
  SETTINGS_FILE,
  MARKETPLACE_NAME,
  VERSION,
  InstallSource,
  MarketplaceStatus,
  PluginStatus,
  RemovalStatus,
  createConfig,
  registerPlugin,
  unregisterPlugin,
  loadSettings,
  saveSettings,
  readRegisteredPluginSource,
  type Settings,
  type PluginSource,
} from './setup.js';
import { prompt, sendToSocket, requestFromSocket, probeUnixSocket, SocketState } from './utils.js';
import { runDaemon, resolveDaemonConfig, daemonConfigFingerprint } from './daemon.js';
import { DEFAULT_AGENT_NAME } from './genaiSpans.js';

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `
weave-claude-code v${VERSION}

Track Claude Code sessions in Weave for observability and debugging.

Usage:
  weave-claude-code <command> [options]

Commands:
  install            Set up the plugin (records runtime paths, creates config)
  config <action>    Manage configuration (show | get <key> | set <key> <value>)
  status             Check installation status (pass --json for machine-readable output)
  logs               Display daemon logs (--tail N, --follow)
  daemon             Start the background daemon (used by hook handler)
  restart            Restart the daemon to apply configuration changes
  uninstall          Remove the plugin and all associated files

Options:
  --version, -v      Print version
  --help, -h         Print this help message
  --non-interactive  Skip install prompts and rely on env/config values
  --source=<src>     Where 'install' pulls the marketplace from:
                       github (default) - clone wandb/weave-claude-code over git
                       local            - register the npm-installed tree on disk
                                          (requires 'npm install -g weave-claude-code';
                                          use in CI/sandboxes without git/SSH access)

Examples:
  weave-claude-code install
  weave-claude-code install --non-interactive
  weave-claude-code install --non-interactive --source=local
  weave-claude-code config set weave_project my-entity/my-project
  weave-claude-code status
  weave-claude-code logs --tail 100
`.trim();

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function cmdInstall(
  force: boolean,
  nonInteractive: boolean,
  source: InstallSource,
): Promise<void> {
  let configResult;
  if (fs.existsSync(SETTINGS_FILE) && !force) {
    let settings: Settings;
    try {
      settings = loadSettings();
    } catch (err) {
      console.error(`✗ Could not load existing settings: ${err}`);
      process.exit(1);
    }

    configResult = {
      settingsFile: SETTINGS_FILE,
      logFile: settings.log_file,
    };

    console.log('✓ Configuration already exists');
    console.log(`  Config: ${configResult.settingsFile}`);
    console.log(`  Logs:   ${configResult.logFile}`);
    console.log('  Re-validating marketplace and plugin installation...');
  } else {
    try {
      configResult = createConfig(CONFIG_DIR);
    } catch (err) {
      console.error(`✗ Installation failed: ${err}`);
      process.exit(1);
    }

    console.log('✓ Configuration created');
    console.log(`  Config: ${configResult.settingsFile}`);
    console.log(`  Logs:   ${configResult.logFile}`);
  }

  let pluginResult;
  try {
    pluginResult = registerPlugin(configResult.logFile, source);
  } catch (err) {
    console.error(`✗ ${err}`);
    process.exit(1);
  }

  if (pluginResult.marketplaceStatus === MarketplaceStatus.AlreadyRegistered) {
    console.log(`✓ Marketplace already registered (${pluginResult.refAfter ?? 'unknown ref'})`);
  } else if (pluginResult.refBefore && pluginResult.refBefore !== pluginResult.refAfter) {
    console.log(`✓ Marketplace refreshed (${pluginResult.refBefore} → ${pluginResult.refAfter})`);
  } else {
    console.log(`✓ Marketplace registered (${pluginResult.refAfter ?? 'unknown ref'})`);
  }

  if (pluginResult.pluginUpdated) {
    console.log(`✓ Plugin updated — restart Claude Code to apply`);
  } else if (pluginResult.pluginStatus === PluginStatus.AlreadyInstalled) {
    console.log(`✓ Plugin already installed`);
  } else {
    console.log(`✓ Plugin installed`);
  }

  // Interactive prompts for missing config
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    console.error(`✗ Could not load settings: ${err}`);
    process.exit(1);
  }

  const effectiveProject = resolveProject(settings).value;
  const effectiveApiKey = resolveApiKey(settings).value;

  if (nonInteractive) {
    console.log('\n- Non-interactive install: skipping setup prompts');

    const envProject = process.env['WEAVE_PROJECT'];
    const envApiKey = process.env['WANDB_API_KEY'];

    if (envProject) {
      if (!envProject.includes('/')) {
        console.error(`✗ Invalid WEAVE_PROJECT: '${effectiveProject}' — expected entity/project`);
        process.exit(1);
      }
      console.warn(`⚠ Using WEAVE_PROJECT from environment: ${envProject}`);
    } else if (!effectiveProject) {
      console.warn('- WEAVE_PROJECT not set. Run: weave-claude-code config set weave_project ENTITY/PROJECT');
    }

    if (envApiKey) {
      console.warn(`⚠ Using WANDB_API_KEY from environment: ${maskSecret(envApiKey)}`);
    } else if (!effectiveApiKey) {
      console.warn('- WANDB_API_KEY not set. Run: weave-claude-code config set wandb_api_key <your-api-key>');
    }
  } else if (process.stdin.isTTY) {
    if (!effectiveProject) {
      const answer = await prompt('\nWeave project (ENTITY/PROJECT): ');
      const value = answer.trim();
      if (value) {
        if (!value.includes('/')) {
          console.error(`✗ Invalid format: '${value}' — expected entity/project`);
          process.exit(1);
        }
        settings.weave_project = value;
        saveSettings(settings);
        console.log(`✓ Set weave_project = ${value}`);
      } else {
        console.log('- Skipped weave_project (set later: weave-claude-code config set weave_project ENTITY/PROJECT)');
      }
    }

    if (!effectiveApiKey) {
      console.log('\nGet your API key at: https://wandb.ai/authorize (update domain for other deployments)');
      const answer = await prompt('W&B API key: ');
      const value = answer.trim();
      if (value) {
        settings = loadSettings();
        settings.wandb_api_key = value;
        saveSettings(settings);
        console.log(`✓ Set wandb_api_key = ${maskSecret(value)}`);
      } else {
        console.log('- Skipped wandb_api_key (set later: weave-claude-code config set wandb_api_key <key>)');
      }
    }
  } else {
    if (!effectiveProject) {
      console.log('- weave_project not set. Run: weave-claude-code config set weave_project ENTITY/PROJECT');
    }
    if (!effectiveApiKey) {
      console.log('- wandb_api_key not set. Run: weave-claude-code config set wandb_api_key <your-api-key>');
    }
  }

  console.log('\n✓ Installation complete!');
  console.log('  Reload plugins in Claude Code: /reload-plugins');
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function maskSecret(value: string): string {
  return `${value.slice(0, 4)}…`;
}

/** Where the effective agent name came from. Parallels `WeaveProjectSource` /
 *  `ApiKeySource`; has no `NotSet` member because agent_name always resolves
 *  to the built-in default. */
enum AgentNameSource {
  EnvVar = 'WEAVE_AGENT_NAME env var',
  Settings = 'settings.json',
  Default = 'default',
}

/**
 * Resolve the effective top-level agent name and where it came from. Mirrors
 * the env-over-settings precedence used for `weave_project`, with the
 * hardcoded `DEFAULT_AGENT_NAME` as the final fallback. Shared by
 * `config show` and `config get` so both report the same value.
 */
function resolveAgentName(settings: Settings): { value: string; source: AgentNameSource } {
  const fromEnv = process.env['WEAVE_AGENT_NAME']?.trim();
  if (fromEnv) return { value: fromEnv, source: AgentNameSource.EnvVar };
  const fromSettings = settings.agent_name?.trim();
  if (fromSettings) return { value: fromSettings, source: AgentNameSource.Settings };
  return { value: DEFAULT_AGENT_NAME, source: AgentNameSource.Default };
}

/**
 * Resolve the effective Weave project and where it came from, applying the
 * env-over-settings precedence (`WEAVE_PROJECT` beats `settings.weave_project`).
 * Shared by install, config, status, and restart so they report one value.
 * `value` uses nullish coalescing and `source` uses truthiness, matching the
 * per-site expressions this replaces.
 */
function resolveProject(settings: Settings): { value: string | null; source: WeaveProjectSource } {
  const value = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const source = process.env['WEAVE_PROJECT']
    ? WeaveProjectSource.EnvVar
    : settings.weave_project
      ? WeaveProjectSource.Settings
      : WeaveProjectSource.NotSet;
  return { value, source };
}

/**
 * Resolve the effective W&B API key and where it came from, applying the
 * env-over-settings precedence (`WANDB_API_KEY` beats `settings.wandb_api_key`).
 * Shared by install, config, status, and restart so they report one value.
 * `value` uses nullish coalescing and `source` uses truthiness, matching the
 * per-site expressions this replaces.
 */
function resolveApiKey(settings: Settings): { value: string | null; source: ApiKeySource } {
  const value = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
  const source = process.env['WANDB_API_KEY']
    ? ApiKeySource.EnvVar
    : settings.wandb_api_key
      ? ApiKeySource.Settings
      : ApiKeySource.NotSet;
  return { value, source };
}

/**
 * Render the comma-joined list of missing required config for the "incomplete"
 * status/restart messages. `apiKeyLabel` differs by call site (`wandb_api_key`
 * for the config-oriented message, `WANDB_API_KEY` for the env-oriented one).
 */
function missingConfig(project: string | null, apiKey: string | null, apiKeyLabel: string): string {
  return [!project && 'weave_project', !apiKey && apiKeyLabel].filter(Boolean).join(', ');
}

async function cmdConfig(args: string[]): Promise<void> {
  const action = args[0];

  if (!action || action === 'show') {
    let settings: Settings;
    try {
      settings = loadSettings();
    } catch (err) {
      console.error(`✗ ${err}`);
      process.exit(1);
    }

    const { value: effectiveProject, source: projectSource } = resolveProject(settings);
    const { value: effectiveApiKey, source: apiKeySource } = resolveApiKey(settings);
    const apiKeyDisplay = effectiveApiKey ? `${maskSecret(effectiveApiKey)} [${apiKeySource}]` : `(not set)`;

    console.log('Current configuration:');
    console.log(`  log_file:      ${settings.log_file}`);
    console.log(`  daemon_socket: ${settings.daemon_socket}`);
    console.log(`  weave_project: ${effectiveProject ?? '(not set)'} [${projectSource}]`);
    console.log(`  wandb_api_key: ${apiKeyDisplay}`);
    const agentName = resolveAgentName(settings);
    console.log(`  agent_name:    ${agentName.value} [${agentName.source}]`);
    console.log(`  debug:         ${!!process.env['WEAVE_CLAUDE_DEBUG'] || settings.debug} ${process.env['WEAVE_CLAUDE_DEBUG'] ? '[WEAVE_CLAUDE_DEBUG env var]' : ''}`);
    console.log(`  installed_at:  ${settings.installed_at}`);
    console.log(`  version:       ${settings.version}`);
    return;
  }

  if (action === 'get') {
    const key = args[1];
    if (!key) {
      console.error('Usage: weave-claude-code config get <key>');
      process.exit(1);
    }
    let settings: Settings;
    try {
      settings = loadSettings();
    } catch (err) {
      console.error(`✗ ${err}`);
      process.exit(1);
    }
    // agent_name resolves via env/default and may be absent from settings
    // files written before the field existed, so handle it before the generic
    // `undefined` → unknown-key check below.
    if (key === 'agent_name') {
      console.log(resolveAgentName(settings).value);
      return;
    }
    const value = (settings as unknown as Record<string, unknown>)[key];
    if (value === undefined) {
      console.error(`Unknown key: ${key}`);
      process.exit(1);
    }
    if (key === 'weave_project') {
      console.log(resolveProject(settings).value ?? '(not set)');
    } else if (key === 'wandb_api_key') {
      console.log(resolveApiKey(settings).value ?? '(not set)');
    } else {
      console.log(value ?? '(not set)');
    }
    return;
  }

  if (action === 'set') {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.error('Usage: weave-claude-code config set <key> <value>');
      process.exit(1);
    }

    const writableKeys: readonly (keyof Settings)[] = ['weave_project', 'wandb_api_key', 'agent_name', 'daemon_socket', 'debug'];
    if (!writableKeys.includes(key as keyof Settings)) {
      console.error(`Cannot set '${key}'. Writable keys: ${writableKeys.join(', ')}`);
      process.exit(1);
    }
    const writableKey = key as keyof Settings;

    if (key === 'weave_project' && !value.includes('/')) {
      console.error(`Invalid format for weave_project: '${value}'\nExpected: entity/project (e.g. my-entity/my-project)`);
      process.exit(1);
    }

    if (key === 'debug' && value !== 'true' && value !== 'false') {
      console.error(`Invalid value for debug: '${value}'\nExpected: true or false`);
      process.exit(1);
    }

    let settings: Settings;
    try {
      settings = loadSettings();
    } catch (err) {
      console.error(`✗ ${err}`);
      process.exit(1);
    }

    // `debug` is the only boolean Settings field; every other writable key is a
    // string. Split the assignment so each branch's value type matches the
    // narrowed property type (no whole-object cast needed).
    let coerced: string | boolean;
    if (writableKey === 'debug') {
      coerced = value === 'true';
      settings.debug = coerced;
    } else {
      coerced = value;
      settings[writableKey] = value;
    }
    saveSettings(settings);
    const displayValue = writableKey === 'wandb_api_key' && typeof coerced === 'string'
      ? maskSecret(coerced)
      : coerced;
    console.log(`✓ Set ${key} = ${displayValue}`);
    return;
  }

  console.error(`Unknown config action: ${action}\nUsage: weave-claude-code config show | get <key> | set <key> <value>`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/** Where a configured value (project, API key) came from at gather time. */
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

/** Whether settings.json could be read at gather time. */
export enum ConfigState {
  Ok = 'ok',
  Missing = 'missing',
  Unreadable = 'unreadable',
}

/**
 * Public JSON schema returned by `status --json`. Consumers (harness
 * integrations, CI scripts) depend on these field names — treat it as a
 * stable contract. The raw API key is never included, only a boolean.
 */
interface StatusReport {
  version: string;
  settings_file: string;
  cli_path: string | null;
  weave_project: string | null;
  weave_project_source: WeaveProjectSource;
  api_key_configured: boolean;
  /** Agent name shown in Weave; always set (falls back to the default). */
  agent_name: string;
  /**
   * Where Claude Code is loading this plugin from. `null` means the
   * marketplace isn't registered yet (run `weave-claude-code install`).
   * See `PluginSource` for the github vs directory shape.
   */
  plugin_source: PluginSource | null;
  daemon_socket: { path: string | null; state: SocketState | null };
  log_file: { path: string | null; size_bytes: number | null };
  /** True when a daemon is alive but loaded an older config than settings.json
   *  now resolves to, so a restart is needed to pick up the change. */
  config_drift: boolean;
  ready_to_trace: boolean;
  view_traces_url: string | null;
}

/**
 * Everything `gatherStatus` produces. Bundles the public JSON `report` with
 * pretty-print-only fields (masked key, key source, config error message) so
 * the print paths never re-read settings, env vars, or the socket themselves.
 */
interface StatusSnapshot {
  report: StatusReport;
  config_state: ConfigState;
  config_error: string | null;
  api_key_masked: string | null;
  api_key_source: ApiKeySource;
}

async function gatherStatus(): Promise<StatusSnapshot> {
  const report: StatusReport = {
    version: VERSION,
    settings_file: SETTINGS_FILE,
    cli_path: null,
    weave_project: null,
    weave_project_source: WeaveProjectSource.NotSet,
    api_key_configured: false,
    agent_name: DEFAULT_AGENT_NAME,
    plugin_source: readRegisteredPluginSource(MARKETPLACE_NAME),
    daemon_socket: { path: null, state: null },
    log_file: { path: null, size_bytes: null },
    config_drift: false,
    ready_to_trace: false,
    view_traces_url: null,
  };
  const snap: StatusSnapshot = {
    report,
    config_state: ConfigState.Ok,
    config_error: null,
    api_key_masked: null,
    api_key_source: ApiKeySource.NotSet,
  };

  const whichResult = spawnSync('which', ['weave-claude-code'], { encoding: 'utf8' });
  if (whichResult.status === 0 && whichResult.stdout.trim()) {
    report.cli_path = whichResult.stdout.trim();
  }

  if (!fs.existsSync(SETTINGS_FILE)) {
    snap.config_state = ConfigState.Missing;
    return snap;
  }

  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    snap.config_state = ConfigState.Unreadable;
    snap.config_error = String(err);
    return snap;
  }

  const { value: effectiveProject, source: projectSource } = resolveProject(settings);
  if (effectiveProject) {
    report.weave_project = effectiveProject;
    report.weave_project_source = projectSource;
  }

  const { value: effectiveApiKey, source: apiKeySource } = resolveApiKey(settings);
  if (effectiveApiKey) {
    report.api_key_configured = true;
    snap.api_key_masked = maskSecret(effectiveApiKey);
    snap.api_key_source = apiKeySource;
  }

  report.agent_name = resolveAgentName(settings).value;

  // Probe daemon socket — distinguishes alive (listening) from stale (file
  // exists but no listener, eg. daemon crashed). Reporting "(exists)" purely
  // from the inode hides crashes and makes "Ready to trace" lie.
  report.daemon_socket.path = settings.daemon_socket;
  report.daemon_socket.state = await probeUnixSocket(settings.daemon_socket);

  // Ask the live daemon for the fingerprint of the config it loaded. If it
  // differs from what settings.json now resolves to, the running daemon is
  // stale and a restart is needed. Any error (old daemon, no reply) means we
  // can't tell, so leave config_drift false.
  if (report.daemon_socket.state === SocketState.Alive) {
    try {
      const reply = await requestFromSocket(settings.daemon_socket, JSON.stringify({ command: 'config-hash' }));
      const running = (JSON.parse(reply) as Record<string, unknown>)['config_hash'];
      const current = daemonConfigFingerprint(resolveDaemonConfig(settings, process.env));
      report.config_drift = typeof running === 'string' && running !== current;
    } catch {
      // Daemon did not reply with a fingerprint; cannot determine drift.
    }
  }

  report.log_file.path = settings.log_file;
  if (fs.existsSync(settings.log_file)) {
    report.log_file.size_bytes = fs.statSync(settings.log_file).size;
  }

  if (effectiveProject && effectiveApiKey && report.daemon_socket.state !== SocketState.Stale) {
    report.ready_to_trace = true;
    report.view_traces_url = `https://wandb.ai/${effectiveProject}/weave/agents`;
  }

  return snap;
}

function printPrettyStatus(snap: StatusSnapshot): void {
  const { report, config_state, config_error, api_key_masked, api_key_source } = snap;

  console.log('Weave Claude Code Plugin Status');
  console.log('================================');

  if (config_state === ConfigState.Missing) {
    console.log(`✗ Configuration: not found at ${report.settings_file}`);
    console.log('\nRun: weave-claude-code install');
    return;
  }
  if (config_state === ConfigState.Unreadable) {
    console.log(`✗ Configuration: failed to read (${config_error})`);
    return;
  }
  console.log(`✓ Configuration: ${report.settings_file}`);

  if (report.cli_path) {
    console.log(`✓ CLI: ${report.cli_path} (v${report.version})`);
  } else {
    console.log('✗ CLI: weave-claude-code not found in PATH');
    console.log('  Run: npm install -g weave-claude-code');
  }

  if (report.weave_project) {
    console.log(`✓ Weave project: ${report.weave_project} (from ${report.weave_project_source})`);
  } else {
    console.log('✗ Weave project: not configured');
    console.log('  Run: weave-claude-code config set weave_project ENTITY/PROJECT');
  }

  if (report.api_key_configured) {
    console.log(`✓ W&B API key: ${api_key_masked} (from ${api_key_source})`);
  } else {
    console.log('✗ W&B API key: not configured');
    console.log('  Run: weave-claude-code config set wandb_api_key <your-api-key>');
  }

  console.log(`✓ Agent name: ${report.agent_name}`);
  if (report.config_drift) {
    console.log('⚠ Daemon is running an older config. Run: weave-claude-code restart');
  }

  if (report.plugin_source === null) {
    console.log('✗ Source: not registered');
    console.log('  Run: weave-claude-code install');
  } else if (report.plugin_source.type === 'github') {
    const refLabel = report.plugin_source.ref ? ` @ ${report.plugin_source.ref}` : '';
    console.log(`✓ Source: github ${report.plugin_source.repo}${refLabel}`);
  } else {
    const versionLabel = report.plugin_source.version ? ` @ v${report.plugin_source.version}` : '';
    console.log(`✓ Source: directory ${report.plugin_source.path}${versionLabel}`);
  }

  const { path: socketPath, state: socketState } = report.daemon_socket;
  if (socketState === SocketState.Alive) {
    console.log(`✓ Daemon socket: ${socketPath} (alive)`);
  } else if (socketState === SocketState.Stale) {
    console.log(`✗ Daemon socket: ${socketPath} (stale — file exists but no listener)`);
    console.log(`  Auto-recovers on next Claude Code session — no action needed.`);
  } else {
    console.log(`- Daemon socket: ${socketPath} (not running)`);
  }

  if (report.log_file.size_bytes !== null) {
    const kb = (report.log_file.size_bytes / 1024).toFixed(1);
    console.log(`✓ Log file: ${report.log_file.path} (${kb} KB)`);
  } else {
    console.log(`- Log file: ${report.log_file.path} (not created yet)`);
  }

  console.log('');
  if (report.ready_to_trace) {
    console.log('Status: Ready to trace');
    console.log(`View traces: ${report.view_traces_url}`);
  } else if (socketState === SocketState.Stale) {
    console.log('Status: Daemon socket is stale — will auto-recover on next Claude Code hook');
  } else {
    const missing = missingConfig(
      report.weave_project,
      report.api_key_configured ? 'set' : null,
      'wandb_api_key',
    );
    console.log(`Status: Configuration incomplete — set ${missing} to start tracing`);
  }
}

async function cmdStatus(opts: { json: boolean } = { json: false }): Promise<void> {
  const snap = await gatherStatus();

  if (opts.json) {
    console.log(JSON.stringify(snap.report, null, 2));
  } else {
    printPrettyStatus(snap);
  }

  if (snap.config_state !== ConfigState.Ok || snap.report.daemon_socket.state === SocketState.Stale) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

async function cmdLogs(tail: number, follow: boolean): Promise<void> {
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    console.error(`✗ ${err}`);
    process.exit(1);
  }

  const logFile = settings.log_file;

  if (!fs.existsSync(logFile)) {
    console.log(`No logs found at ${logFile}`);
    console.log('The daemon has not run yet, or no events have been logged.');
    return;
  }

  if (follow) {
    const child = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`Failed to follow log: ${err.message}`);
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } else {
    const result = spawnSync('tail', [`-n${tail}`, logFile], { stdio: 'inherit', encoding: 'utf8' });
    if (result.error) {
      console.error(`Failed to read log: ${result.error.message}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function cmdUninstall(keepLogs: boolean): Promise<void> {
  const answer = await prompt('Remove Weave Claude Code plugin? [y/N] ');
  if (answer.toLowerCase() !== 'y') {
    console.log('Uninstall cancelled.');
    return;
  }

  let settings: Settings | null = null;

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = loadSettings();
    } catch {
      // Settings may be corrupt — continue with cleanup
    }
  }

  const socketPath = settings?.daemon_socket ?? path.join(CONFIG_DIR, 'daemon.sock');
  if (fs.existsSync(socketPath)) {
    try {
      await sendToSocket(socketPath, JSON.stringify({ command: 'shutdown' }));
      console.log('✓ Stopped daemon');
    } catch {
      console.warn('⚠ Could not stop daemon (may already be stopped)');
    }
  }

  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
      console.log('✓ Removed daemon socket');
    } catch {
      console.warn('⚠ Could not remove daemon socket');
    }
  }

  const pluginResult = unregisterPlugin();
  if (pluginResult.pluginStatus === RemovalStatus.Failed) {
    console.warn(`⚠ ${pluginResult.pluginError}`);
  } else {
    console.log(`✓ Claude plugin ${pluginResult.pluginStatus === RemovalStatus.AlreadyAbsent ? 'already removed' : 'removed'}`);
  }

  if (pluginResult.marketplaceStatus === RemovalStatus.Failed) {
    console.warn(`⚠ ${pluginResult.marketplaceError}`);
  } else {
    console.log(`✓ Claude marketplace ${pluginResult.marketplaceStatus === RemovalStatus.AlreadyAbsent ? 'already removed' : 'removed'}`);
  }

  if (fs.existsSync(SETTINGS_FILE)) {
    fs.unlinkSync(SETTINGS_FILE);
    console.log('✓ Removed configuration');
  } else {
    console.log('- No configuration found (already uninstalled?)');
  }

  if (!keepLogs) {
    const logsDir = path.join(CONFIG_DIR, 'logs');
    fs.rmSync(logsDir, { recursive: true, force: true });
    console.log('✓ Removed logs');
  } else {
    console.log(`- Kept logs at ${path.join(CONFIG_DIR, 'logs')}`);
  }

  // Remove config dir if now empty
  try {
    fs.rmdirSync(CONFIG_DIR);
    console.log('✓ Removed config directory');
  } catch {
    // Non-empty (e.g., logs kept) — leave it
  }

  console.log('\n✓ Uninstall complete!');
}

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

/** How long `restart` waits for the daemon to stop, then to come back up. */
const RESTART_WAIT_MS = 5000;
/** How often to re-probe the socket while waiting during `restart`. */
const RESTART_POLL_INTERVAL_MS = 50;

/** Poll the socket until `want` holds; false on timeout. */
async function waitForSocketState(
  socketPath: string,
  want: (s: SocketState) => boolean,
  timeoutMs = RESTART_WAIT_MS,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (want(await probeUnixSocket(socketPath))) return true;
    await new Promise((r) => setTimeout(r, RESTART_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Restart the daemon so config changes take effect: it reads settings once at
 * startup (see runDaemon), so changes need a fresh process.
 */
async function cmdRestart(): Promise<void> {
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const socketPath = settings.daemon_socket;

  // Stop the running daemon, if any.
  if ((await probeUnixSocket(socketPath)) === SocketState.Alive) {
    try {
      await sendToSocket(socketPath, JSON.stringify({ command: 'shutdown' }));
    } catch {
      // Connection may drop as it exits; the probe below confirms.
    }
    if (!(await waitForSocketState(socketPath, (s) => s !== SocketState.Alive))) {
      console.error('⚠ Existing daemon did not stop within 5s. Aborting restart.');
      console.error('  Diagnose: weave-claude-code status');
      process.exit(1);
    }
    console.log('✓ Stopped running daemon');
  } else {
    console.log('- No running daemon to stop');
  }

  // Don't spawn a daemon that would just exit for lack of config (mirrors runDaemon).
  const project = resolveProject(settings).value;
  const apiKey = resolveApiKey(settings).value;
  if (!project || !apiKey) {
    const missing = missingConfig(project, apiKey, 'WANDB_API_KEY');
    console.error(`⚠ Not starting daemon, missing configuration: ${missing}`);
    console.error('  Set it with: weave-claude-code config set weave_project ENTITY/PROJECT');
    process.exit(1);
  }

  // Detached, reusing this process's runtime (execArgv) so it works as the
  // installed JS bin and under tsx in tests.
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1]!, 'daemon'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  if (!(await waitForSocketState(socketPath, (s) => s === SocketState.Alive))) {
    console.error('⚠ Daemon did not start within 5s.');
    console.error('  Diagnose: weave-claude-code status');
    console.error('  Logs:     weave-claude-code logs --tail 50');
    process.exit(1);
  }

  console.log('✓ Daemon restarted');
  console.log(`  Tracing as: ${resolveAgentName(settings).value}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    process.exit(0);
  }

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (cmd === 'install') {
    const source = args.includes('--source=local') ? InstallSource.Local : InstallSource.GitHub;
    await cmdInstall(args.includes('--force'), args.includes('--non-interactive'), source);
    return;
  }

  if (cmd === 'config') {
    await cmdConfig(args.slice(1));
    return;
  }

  if (cmd === 'status') {
    await cmdStatus({ json: args.includes('--json') });
    return;
  }

  if (cmd === 'logs') {
    let tail = 50;
    let follow = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--tail' && args[i + 1]) {
        tail = parseInt(args[i + 1]!, 10);
        i++;
      } else if (args[i] === '--follow' || args[i] === '-f') {
        follow = true;
      }
    }
    await cmdLogs(tail, follow);
    return;
  }

  if (cmd === 'uninstall') {
    await cmdUninstall(args.includes('--keep-logs'));
    return;
  }

  if (cmd === 'daemon') {
    await runDaemon();
    return;
  }

  if (cmd === 'restart') {
    await cmdRestart();
    return;
  }

  console.error(`Unknown command: ${cmd}\nRun 'weave-claude-code --help' for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
