#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import {
  CONFIG_DIR,
  SETTINGS_FILE,
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  VERSION,
  MarketplaceStatus,
  PluginStatus,
  createConfig,
  registerPlugin,
  loadSettings,
  saveSettings,
  type Settings,
} from './setup.js';
import { prompt, sendToSocket } from './utils.js';
import { runDaemon } from './daemon.js';

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `
weave-claude-plugin v${VERSION}

Track Claude Code sessions in Weave for observability and debugging.

Usage:
  weave-claude-plugin <command> [options]

Commands:
  install            Set up the plugin (records runtime paths, creates config)
  config <action>    Manage configuration (show | get <key> | set <key> <value>)
  status             Check installation status
  logs               Display daemon logs (--tail N, --follow)
  daemon             Start the background daemon (used by hook handler)
  uninstall          Remove the plugin and all associated files

Options:
  --version, -v      Print version
  --help, -h         Print this help message

Examples:
  weave-claude-plugin install
  weave-claude-plugin config set weave_project my-entity/my-project
  weave-claude-plugin status
  weave-claude-plugin logs --tail 100
`.trim();

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function cmdInstall(force: boolean): Promise<void> {
  if (fs.existsSync(SETTINGS_FILE) && !force) {
    console.log('✓ Installation already exists');
    console.log(`  Config: ${SETTINGS_FILE}`);
    console.log('\nRun with --force to reinstall.');
    return;
  }

  let configResult;
  try {
    configResult = createConfig(CONFIG_DIR);
  } catch (err) {
    console.error(`✗ Installation failed: ${err}`);
    process.exit(1);
  }

  console.log('✓ Configuration created');
  console.log(`  Config: ${configResult.settingsFile}`);
  console.log(`  Logs:   ${configResult.logFile}`);

  let pluginResult;
  try {
    pluginResult = registerPlugin(configResult.logFile);
  } catch (err) {
    console.error(`✗ ${err}`);
    process.exit(1);
  }

  console.log(`✓ Marketplace ${pluginResult.marketplaceStatus === MarketplaceStatus.AlreadyRegistered ? 'already registered' : 'registered'}`);
  console.log(`✓ Plugin ${pluginResult.pluginStatus === PluginStatus.AlreadyInstalled ? 'already installed' : 'installed'}`);
  console.log('\n✓ Installation complete!');
  console.log('\nNext steps:');
  console.log('  1. Set Weave project: weave-claude-plugin config set weave_project ENTITY/PROJECT');
  console.log('  2. Reload plugins in Claude Code: /reload-plugins');
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

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

    const effectiveProject = settings.weave_project ?? process.env['WEAVE_PROJECT'] ?? null;
    const projectSource = settings.weave_project
      ? 'settings.json'
      : process.env['WEAVE_PROJECT']
        ? 'WEAVE_PROJECT env var'
        : 'not set';

    console.log('Current configuration:');
    console.log(`  log_file:      ${settings.log_file}`);
    console.log(`  daemon_socket: ${settings.daemon_socket}`);
    console.log(`  weave_project: ${effectiveProject ?? '(not set)'} [${projectSource}]`);
    console.log(`  installed_at:  ${settings.installed_at}`);
    console.log(`  version:       ${settings.version}`);
    return;
  }

  if (action === 'get') {
    const key = args[1];
    if (!key) {
      console.error('Usage: weave-claude-plugin config get <key>');
      process.exit(1);
    }
    let settings: Settings;
    try {
      settings = loadSettings();
    } catch (err) {
      console.error(`✗ ${err}`);
      process.exit(1);
    }
    const value = (settings as unknown as Record<string, unknown>)[key];
    if (value === undefined) {
      console.error(`Unknown key: ${key}`);
      process.exit(1);
    }
    // For weave_project, resolve effective value (settings > env)
    if (key === 'weave_project') {
      const effective = settings.weave_project ?? process.env['WEAVE_PROJECT'] ?? null;
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
      console.error('Usage: weave-claude-plugin config set <key> <value>');
      process.exit(1);
    }

    const writableKeys = ['weave_project', 'daemon_socket'];
    if (!writableKeys.includes(key)) {
      console.error(`Cannot set '${key}'. Writable keys: ${writableKeys.join(', ')}`);
      process.exit(1);
    }

    if (key === 'weave_project' && !value.includes('/')) {
      console.error(`Invalid format for weave_project: '${value}'\nExpected: entity/project (e.g. my-entity/my-project)`);
      process.exit(1);
    }

    let settings: Settings;
    try {
      settings = loadSettings();
    } catch (err) {
      console.error(`✗ ${err}`);
      process.exit(1);
    }

    (settings as unknown as Record<string, unknown>)[key] = value;
    saveSettings(settings);
    console.log(`✓ Set ${key} = ${value}`);
    return;
  }

  console.error(`Unknown config action: ${action}\nUsage: weave-claude-plugin config show | get <key> | set <key> <value>`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  console.log('Weave Claude Code Plugin Status');
  console.log('================================');

  // Check settings file
  if (!fs.existsSync(SETTINGS_FILE)) {
    console.log(`✗ Configuration: not found at ${SETTINGS_FILE}`);
    console.log('\nRun: weave-claude-plugin install');
    process.exit(1);
  }

  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    console.log(`✗ Configuration: failed to read (${err})`);
    process.exit(1);
  }

  console.log(`✓ Configuration: ${SETTINGS_FILE}`);

  // Check weave-claude-plugin is on PATH
  const whichResult = spawnSync('which', ['weave-claude-plugin'], { encoding: 'utf8' });
  if (whichResult.status === 0 && whichResult.stdout.trim()) {
    console.log(`✓ CLI: ${whichResult.stdout.trim()}`);
  } else {
    console.log('✗ CLI: weave-claude-plugin not found in PATH');
    console.log('  Run: npm install -g weave-claude-plugin');
  }

  // Check weave_project
  const effectiveProject = settings.weave_project ?? process.env['WEAVE_PROJECT'] ?? null;
  if (effectiveProject) {
    const source = settings.weave_project ? 'settings.json' : 'WEAVE_PROJECT env var';
    console.log(`✓ Weave project: ${effectiveProject} (from ${source})`);
  } else {
    console.log('✗ Weave project: not configured');
    console.log('  Run: weave-claude-plugin config set weave_project ENTITY/PROJECT');
  }

  // Check daemon socket
  const socketPath = settings.daemon_socket;
  if (fs.existsSync(socketPath)) {
    console.log(`✓ Daemon socket: ${socketPath} (exists)`);
  } else {
    console.log(`- Daemon socket: ${socketPath} (not running)`);
  }

  // Check log file
  const logFile = settings.log_file;
  if (fs.existsSync(logFile)) {
    const stat = fs.statSync(logFile);
    const kb = (stat.size / 1024).toFixed(1);
    console.log(`✓ Log file: ${logFile} (${kb} KB)`);
  } else {
    console.log(`- Log file: ${logFile} (not created yet)`);
  }

  console.log('');
  if (effectiveProject) {
    console.log('Status: Ready to trace');
  } else {
    console.log('Status: Configuration incomplete — set weave_project to start tracing');
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

  if (fs.existsSync(SETTINGS_FILE)) {
    let settings: Settings | null = null;
    try {
      settings = loadSettings();
    } catch {
      // Settings may be corrupt — continue with cleanup
    }

    const socketPath = settings?.daemon_socket ?? path.join(CONFIG_DIR, 'daemon.sock');

    if (fs.existsSync(socketPath)) {
      try {
        await sendToSocket(socketPath, JSON.stringify({ command: 'shutdown' }));
        console.log('✓ Stopped daemon');
      } catch {
        console.warn('⚠ Could not stop daemon (may already be stopped)');
      }
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // May have been removed by daemon itself
      }
    }

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

  console.log(`\n✓ Uninstall complete!`);
  console.log(`\nNote: The Claude Code plugin is still installed.`);
  console.log(`To remove it, run in Claude Code:`);
  console.log(`  /plugin uninstall ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
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
    await cmdInstall(args.includes('--force'));
    return;
  }

  if (cmd === 'config') {
    await cmdConfig(args.slice(1));
    return;
  }

  if (cmd === 'status') {
    await cmdStatus();
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
    await runDaemon(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${cmd}\nRun 'weave-claude-plugin --help' for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
