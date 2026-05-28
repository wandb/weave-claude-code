---
name: weave-install
description: This skill should be used when the user wants to "install the weave plugin", "set up weave", "install weave-claude-code", "configure weave for the first time", "get started with weave tracing", or needs to complete the initial setup of the Weave Claude Code plugin including dependency installation and project configuration.
---

# Weave Claude Code Plugin — Install

Complete the full installation and initial configuration of the Weave Claude Code plugin.

## Step 1 — Check for CLI

Run:
```bash
which weave-claude-code
```

If not found, install it:
```bash
npm install -g weave-claude-code
```

Then verify it is now available:
```bash
which weave-claude-code
```

If the install fails (e.g., permission error), retry with `sudo npm install -g weave-claude-code` after confirming with the user. Do not proceed to Step 2 until `which weave-claude-code` succeeds.

## Step 2 — Run Install

Run:
```bash
weave-claude-code install
```

This creates `~/.weave-claude-code/settings.json`, registers the plugin in Claude Code's marketplace, and installs hooks. If the command reports the installation already exists, continue to Step 3 to verify configuration.

If `--force` is needed to reinstall, run:
```bash
weave-claude-code install --force
```

## Step 3 — Configure Weave Project

Check if `weave_project` is already set:
```bash
weave-claude-code config get weave_project
```

If not set (output is `(not set)`), ask the user for their Weave entity and project name in the format `entity/project`, then set it:
```bash
weave-claude-code config set weave_project ENTITY/PROJECT
```

## Step 4 — Configure API Key

Check if `wandb_api_key` is configured or the `WANDB_API_KEY` environment variable is set. Run:
```bash
weave-claude-code config show
```

If `wandb_api_key` shows `(not set)` and no env var is active, ask the user for their W&B API key (available at https://wandb.ai/authorize) and set it:
```bash
weave-claude-code config set wandb_api_key API_KEY
```

## Step 5 — Verify

Run a final status check:
```bash
weave-claude-code status
```

Confirm all items show ✓. If anything shows ✗, diagnose and fix before finishing.

Report the result to the user. On success, tell them that Claude Code sessions will now be automatically traced to their Weave project starting from the next session.

## Updating an Existing Install

Use this path when the user already has `weave-claude-plugin` installed and wants a newer version.

### Step 1 — Compare installed vs. published

```bash
weave-claude-plugin --version
npm view weave-claude-plugin version
```

If the versions match, no update is needed — stop here. Otherwise continue.

### Step 2 — Upgrade the CLI and refresh registration

```bash
npm install -g weave-claude-plugin@latest
weave-claude-plugin install
```

The second command does the heavy lifting: the upgraded binary has a new `MARKETPLACE_REF` baked in, so `install` re-registers Claude Code's marketplace pin at the new git tag and — when it detects the installed plugin is now behind — runs `claude plugin update` to actually upgrade it. Watch the output for a `Marketplace refreshed (vOLD → vNEW)` line followed by `Plugin updated`. If `install` fails with a permission error on the npm step, confirm with the user before retrying with `sudo`.

No `--force` is needed. No manual `claude plugin marketplace remove` is needed.

### Step 3 — Restart Claude Code

The new plugin code only loads on the next Claude Code start. Tell the user to either run `/reload-plugins` in their active session or fully restart Claude Code. Until then, the running session keeps the previously-loaded version cached even though everything on disk has been upgraded.

### Step 4 — Verify

```bash
weave-claude-plugin status
```

Confirm the `✓ CLI:` line shows the new version.
