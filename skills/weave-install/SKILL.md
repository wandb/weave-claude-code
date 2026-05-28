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

Use this path when the user already has `weave-claude-plugin` installed and wants a newer version. The npm CLI binary and the Claude Code marketplace registration are two separate things — updating only one can leave Claude Code calling an old binary while its plugin UI reports "latest." Refresh both.

### Step 1 — Compare installed vs. published

```bash
weave-claude-plugin --version
npm view weave-claude-plugin version
```

If the versions match, no update is needed — stop here. Otherwise continue.

### Step 2 — Upgrade the CLI

```bash
npm install -g weave-claude-plugin@latest
```

If this fails with a permission error, confirm with the user before retrying with `sudo`. Then verify:
```bash
weave-claude-plugin --version
```

### Step 3 — Refresh the marketplace registration

```bash
weave-claude-plugin install --force
```

`--force` is required: without it, `install` sees the existing config and skips re-registering the marketplace SHA, so Claude Code keeps pointing at the old plugin manifest.

### Step 4 — Reload plugins in Claude Code

Tell the user to run `/reload-plugins` in their active Claude Code session (or restart Claude Code). Until plugins reload, the running session keeps the previously-loaded version cached even though the on-disk binary has been upgraded.

### Step 5 — Verify

```bash
weave-claude-plugin status
```

Confirm the `✓ CLI:` line shows the new version.
