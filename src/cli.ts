#!/usr/bin/env node

const VERSION = '0.1.0';

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

const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  console.log(VERSION);
  process.exit(0);
}

if (!arg || arg === '--help' || arg === '-h') {
  console.log(HELP);
  process.exit(0);
}

// Commands will be wired in PR 2
console.error(`Unknown command: ${arg}\nRun 'weave-claude-plugin --help' for usage.`);
process.exit(1);
