#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync, spawn } from 'child_process';
import {
  CONFIG_DIR,
  SETTINGS_FILE,
  MARKETPLACE_NAME,
  PLUGIN_NAME,
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

  const effectiveProject = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const effectiveApiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;

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

    const effectiveProject = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
    const projectSource: WeaveProjectSource = process.env['WEAVE_PROJECT']
      ? WeaveProjectSource.EnvVar
      : settings.weave_project
        ? WeaveProjectSource.Settings
        : WeaveProjectSource.NotSet;

    const effectiveApiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
    const apiKeySource: ApiKeySource = process.env['WANDB_API_KEY']
      ? ApiKeySource.EnvVar
      : settings.wandb_api_key
        ? ApiKeySource.Settings
        : ApiKeySource.NotSet;
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
      const effective = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
      console.log(effective ?? '(not set)');
    } else if (key === 'wandb_api_key') {
      const effective = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
      console.log(effective ?? '(not set)');
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

    const writableKeys = ['weave_project', 'wandb_api_key', 'agent_name', 'daemon_socket', 'debug'];
    if (!writableKeys.includes(key)) {
      console.error(`Cannot set '${key}'. Writable keys: ${writableKeys.join(', ')}`);
      process.exit(1);
    }

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

    const coerced = key === 'debug' ? value === 'true' : value;
    (settings as unknown as Record<string, unknown>)[key] = coerced;
    saveSettings(settings);
    const displayValue = key === 'wandb_api_key' && typeof coerced === 'string'
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
  /** Identity the live daemon reported for itself: its pid, version, and the
   *  resolved entry script it's executing. All null when no daemon is alive or
   *  it predates identity reporting. Lets you confirm which build is actually
   *  running (e.g. a linked local dev build vs the published install). */
  daemon: { pid: number | null; version: string | null; path: string | null };
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
    daemon: { pid: null, version: null, path: null },
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

  // Env vars take precedence over settings.json for both project and key.
  const effectiveProject = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  if (effectiveProject) {
    report.weave_project = effectiveProject;
    report.weave_project_source = process.env['WEAVE_PROJECT'] ? WeaveProjectSource.EnvVar : WeaveProjectSource.Settings;
  }

  const effectiveApiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
  if (effectiveApiKey) {
    report.api_key_configured = true;
    snap.api_key_masked = maskSecret(effectiveApiKey);
    snap.api_key_source = process.env['WANDB_API_KEY'] ? ApiKeySource.EnvVar : ApiKeySource.Settings;
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
      const parsed = JSON.parse(reply) as Record<string, unknown>;
      const running = parsed['config_hash'];
      const current = daemonConfigFingerprint(resolveDaemonConfig(settings, process.env));
      report.config_drift = typeof running === 'string' && running !== current;
      // Runtime identity the daemon reports about itself (absent on older daemons).
      if (typeof parsed['pid'] === 'number') report.daemon.pid = parsed['pid'];
      if (typeof parsed['version'] === 'string') report.daemon.version = parsed['version'];
      if (typeof parsed['path'] === 'string') report.daemon.path = parsed['path'];
    } catch {
      // Daemon did not reply; cannot determine drift or identity.
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

const STATUS_LABEL_WIDTH = 8;

/** Replace the home-dir prefix with `~` so long absolute paths stay readable. */
function abbrevHome(p: string): string {
  const home = os.homedir();
  return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Human-readable byte size: KB under 1 MiB, MB above. */
function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** One indented "glyph label   value" row under a section header, label padded
 *  so values line up. An optional `hint` (a fix command) prints on the next
 *  line, arrow-prefixed. */
function statusRow(glyph: string, label: string, value: string, hint?: string): void {
  console.log(`  ${glyph} ${label.padEnd(STATUS_LABEL_WIDTH)} ${value}`);
  if (hint) console.log(`    ${' '.repeat(STATUS_LABEL_WIDTH)} → ${hint}`);
}

function printPrettyStatus(snap: StatusSnapshot): void {
  const { report, config_state, config_error, api_key_masked, api_key_source } = snap;

  // Not-yet-configured states are terminal: there are no sections to show.
  if (config_state === ConfigState.Missing) {
    console.log('Weave Claude Code — not configured');
    console.log(`  No config at ${abbrevHome(report.settings_file)}`);
    console.log('  → weave-claude-code install');
    return;
  }
  if (config_state === ConfigState.Unreadable) {
    console.log('Weave Claude Code — config unreadable');
    console.log(`  Failed to read ${abbrevHome(report.settings_file)} (${config_error})`);
    return;
  }

  const socketState = report.daemon_socket.state;

  // Headline: lead with the overall state and the single most useful follow-up.
  if (report.ready_to_trace) {
    console.log('Weave Claude Code — ready to trace');
    console.log(`  ${report.view_traces_url}`);
  } else if (socketState === SocketState.Stale) {
    console.log('Weave Claude Code — daemon socket stale (auto-recovers next session)');
  } else {
    const missing = [
      !report.weave_project && 'weave_project',
      !report.api_key_configured && 'wandb_api_key',
    ].filter(Boolean).join(', ');
    console.log('Weave Claude Code — configuration incomplete');
    if (missing) console.log(`  Set ${missing} to start tracing`);
  }

  // Config
  console.log(`\nConfig    ${abbrevHome(report.settings_file)}`);
  if (report.weave_project) {
    statusRow('✓', 'Project', `${report.weave_project}  (${report.weave_project_source})`);
  } else {
    statusRow('✗', 'Project', 'not set', 'weave-claude-code config set weave_project ENTITY/PROJECT');
  }
  if (report.api_key_configured) {
    statusRow('✓', 'API key', `${api_key_masked}  (${api_key_source})`);
  } else {
    statusRow('✗', 'API key', 'not set', 'weave-claude-code config set wandb_api_key <your-api-key>');
  }
  statusRow('✓', 'Agent', report.agent_name);

  // Plugin
  console.log('\nPlugin');
  if (report.cli_path) {
    statusRow('✓', 'CLI', `v${report.version}   ${abbrevHome(report.cli_path)}`);
  } else {
    statusRow('✗', 'CLI', 'not found in PATH', 'npm install -g weave-claude-code');
  }
  if (report.plugin_source === null) {
    statusRow('✗', 'Source', 'not registered', 'weave-claude-code install');
  } else if (report.plugin_source.type === 'github') {
    const refLabel = report.plugin_source.ref ? ` @ ${report.plugin_source.ref}` : '';
    statusRow('✓', 'Source', `github ${report.plugin_source.repo}${refLabel}`);
  } else {
    const versionLabel = report.plugin_source.version ? ` @ v${report.plugin_source.version}` : '';
    statusRow('✓', 'Source', `directory ${abbrevHome(report.plugin_source.path)}${versionLabel}`);
  }

  // Daemon — section header carries the overall daemon state.
  const daemonState =
    socketState === SocketState.Alive ? '● alive'
    : socketState === SocketState.Stale ? '⚠ stale (file exists, no listener)'
    : '○ not running';
  console.log(`\nDaemon    ${daemonState}`);
  if (socketState === SocketState.Alive) {
    if (report.daemon.pid !== null) {
      const v = report.daemon.version ? `v${report.daemon.version}` : 'version unknown';
      statusRow('✓', 'Process', `pid ${report.daemon.pid} (${v})`);
    }
    if (report.daemon.path) {
      statusRow('✓', 'From', abbrevHome(report.daemon.path));
    }
    if (report.config_drift) {
      statusRow('⚠', 'Config', 'daemon on an older config', 'weave-claude-code restart');
    }
  }
  if (report.log_file.size_bytes !== null) {
    statusRow('✓', 'Log', `${abbrevHome(report.log_file.path ?? '')} (${humanSize(report.log_file.size_bytes)})`);
  } else {
    statusRow('-', 'Log', `${abbrevHome(report.log_file.path ?? '')} (not created yet)`);
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
  const project = process.env['WEAVE_PROJECT'] ?? settings.weave_project ?? null;
  const apiKey = process.env['WANDB_API_KEY'] ?? settings.wandb_api_key ?? null;
  if (!project || !apiKey) {
    const missing = [!project && 'weave_project', !apiKey && 'WANDB_API_KEY'].filter(Boolean).join(', ');
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
