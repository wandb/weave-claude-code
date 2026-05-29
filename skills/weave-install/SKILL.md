---
name: weave-install
description: This skill should be used when the user wants to "install the weave plugin", "set up weave", "install weave-claude-code", "configure weave for the first time", "get started with weave tracing", or needs to complete the initial setup of the Weave Claude Code plugin including dependency installation and project configuration.
---

# Weave Claude Code Plugin — Install

Complete the full installation and initial configuration of the Weave Claude Code plugin.

## Step 0 — Detect prior install state

Before installing or upgrading, find out what's already on the system. Run these four checks in parallel:

```bash
which weave-claude-code
which weave-claude-plugin
test -d ~/.weave_claude_plugin && echo legacy_dir_present || echo legacy_dir_absent
jq -e '.["weave-claude-plugin"]' ~/.claude/plugins/known_marketplaces.json 2>/dev/null && echo legacy_marketplace_present || echo legacy_marketplace_absent
```

Decide based on the results:

- **Nothing found** (no binary on PATH, no legacy dir, no legacy marketplace) → **Fresh install**. Continue with Step 1.
- **`weave-claude-code` found, all legacy checks absent** → **Already installed or being upgraded**. Continue with Step 2 — re-running `install` is the path for both "refresh after npm upgrade" (drift detection fires automatically) and "no-op idempotent re-validate." Skip Step 1.
- **Any legacy artifact present** (`weave-claude-plugin` binary, `~/.weave_claude_plugin/`, or `weave-claude-plugin` in `known_marketplaces.json`) → **Cross-rename migration required**. Jump to "Migrating from `weave-claude-plugin`" below — it covers npm install + `install` itself — then come back to Step 3.

## Step 1 — Install the CLI (fresh install only)

```bash
npm install -g weave-claude-code
```

If it fails with a permission error (EACCES on a system Node install), confirm with the user before retrying with `sudo npm install -g weave-claude-code`.

Verify:
```bash
which weave-claude-code
```

Do not proceed until this prints a path.

## Step 2 — Run install

```bash
weave-claude-code install
```

This creates `~/.weave-claude-code/settings.json`, registers the marketplace in Claude Code, and installs the `weave` plugin at user scope.

The output will include one of:
- `✓ Marketplace registered (vX.Y.Z)` — first time on this machine.
- `✓ Marketplace already registered (vX.Y.Z)` — fully idempotent re-run.
- `✓ Marketplace refreshed (vOLD → vNEW)` followed by `✓ Plugin updated — restart Claude Code to apply` — the binary was upgraded since last run; drift detection refreshed the pin and upgraded the loaded plugin.

If `--force` is needed (e.g., rebuilding a corrupted settings.json), run `weave-claude-code install --force`.

## Step 3 — Configure Weave Project

Check if `weave_project` is already set:
```bash
weave-claude-code config get weave_project
```

If it returns `(not set)`, ask the user for `entity/project` and set it:
```bash
weave-claude-code config set weave_project ENTITY/PROJECT
```

## Step 4 — Configure API Key

Check current state:
```bash
weave-claude-code config show
```

If `wandb_api_key` shows `(not set)` and no `WANDB_API_KEY` env var is active, ask the user for their key (https://wandb.ai/authorize) and set it:
```bash
weave-claude-code config set wandb_api_key API_KEY
```

## Step 5 — Verify

```bash
weave-claude-code status
```

All items should show `✓`. If anything shows `✗`, diagnose and fix before reporting success.

On success, tell the user Claude Code sessions will now be traced to their Weave project starting from the next session. If a `Plugin updated` or `Marketplace refreshed` line appeared in Step 2, remind them to run `/reload-plugins` (or restart Claude Code) so the running session picks up the new code.

---

## Migrating from `weave-claude-plugin`

The package was renamed in #63 (v0.2.3). Users on v0.2.0–v0.2.2 installed the old `weave-claude-plugin` package and need a one-time migration. **Do this BEFORE running `weave-claude-code install`** — otherwise you end up with two `weave` plugins (`weave@weave-claude-plugin` and `weave@weave-claude-code`) firing hooks in parallel.

### Step 1 — Capture the user's existing settings

The legacy `~/.weave_claude_plugin/settings.json` likely contains the user's configured `weave_project` and `wandb_api_key`. Capture them into shell variables so they survive the cleanup and can be re-applied to the new install.

Use this exact pattern so the API key never appears in your tool output:

```bash
LEGACY_WEAVE_PROJECT="$(jq -r 'if .weave_project == null then "" else .weave_project end' ~/.weave_claude_plugin/settings.json 2>/dev/null || echo "")"
LEGACY_WANDB_API_KEY="$(jq -r 'if .wandb_api_key == null then "" else .wandb_api_key end' ~/.weave_claude_plugin/settings.json 2>/dev/null || echo "")"
echo "captured weave_project=${LEGACY_WEAVE_PROJECT:-<empty>}, wandb_api_key length=${#LEGACY_WANDB_API_KEY}"
```

Only the length of the API key is echoed — never the value itself.

If `~/.weave_claude_plugin/settings.json` doesn't exist, both variables stay empty and the rest of this section still applies.

### Step 2 — Remove the legacy marketplace from Claude Code

```bash
claude plugin marketplace remove weave-claude-plugin
```

This is the **load-bearing step**. Claude Code couples plugins to their marketplace: removing the `weave-claude-plugin` marketplace also uninstalls the `weave@weave-claude-plugin` plugin. If the marketplace was already absent (the binary was installed via npm but `install` was never run), the CLI will print `No configured marketplace named "weave-claude-plugin"` — that's fine, continue.

### Step 3 — Install the new package

```bash
npm install -g weave-claude-code@latest
which weave-claude-code
```

Retry with `sudo` if the install fails with EACCES — but only after confirming with the user.

### Step 4 — Run the new install

Do not use `--non-interactive` here unless the user explicitly asked for it; the install command is harmless to re-run, and TTY output is more informative.

```bash
weave-claude-code install
```

If the prompts for `weave_project` / `wandb_api_key` come up, skip them with blank input — Step 5 below re-applies the captured values without needing user retyping.

### Step 5 — Re-apply the captured settings

Only set values that were actually captured (skip blanks):

```bash
[ -n "$LEGACY_WEAVE_PROJECT" ] && weave-claude-code config set weave_project "$LEGACY_WEAVE_PROJECT"
[ -n "$LEGACY_WANDB_API_KEY" ] && weave-claude-code config set wandb_api_key "$LEGACY_WANDB_API_KEY"
```

The shell substitution keeps the API key out of your tool transcript; `config set` itself only echoes the first four characters.

### Step 6 — Remove the legacy config dir

```bash
rm -rf ~/.weave_claude_plugin
```

Don't do this before Step 1 — the settings live in there.

### Step 7 — Uninstall the legacy npm package

```bash
npm uninstall -g weave-claude-plugin
```

If this fails with EACCES, confirm with the user before retrying with `sudo`. If the user declines, that's fine — leaving the old binary on PATH is harmless once the marketplace and config dir are gone (the hooks no longer reference it). Note in your final report that they should remove it themselves when convenient.

### Step 8 — Resume the main install flow

The migration is complete. Jump back to the main install flow above at **Step 3 (Configure Weave Project)** to validate that the carried-forward settings landed correctly, then proceed through the main flow's Steps 4 and 5.

In the main flow's Step 5 final report, mention that the user is now on `weave-claude-code` (rename from `weave-claude-plugin`) and remind them to run `/reload-plugins` or restart Claude Code so the new plugin code is loaded.
