---
name: weave-status
description: This skill should be used when the user wants to "check weave status", "verify the weave plugin is running", "see if weave is set up correctly", "check weave configuration", "is weave working", "weave is running an older config", "the daemon is on an old config", or needs to diagnose why Claude Code sessions are not appearing in Weave.
---

# Weave Claude Code Plugin — Status

Check the current installation and configuration status of the Weave Claude Code plugin.

## Run Status

Run:
```bash
weave-claude-code status
```

## Interpret Results

Each status line indicates one of four states:
- `✓` — component is present and correctly configured
- `✗` — component is missing or misconfigured (action required)
- `⚠` — component is working but has drifted from current settings (action recommended)
- `-` — component is absent but not an error (e.g., daemon not yet started)

**Common issues and fixes:**

| Symptom | Fix |
|---------|-----|
| `✗ Configuration: not found` | Run `/weave:weave-install` to complete installation |
| `✗ CLI: not found in PATH` | Run `npm install -g weave-claude-code` in a terminal |
| `✗ Weave project: not configured` | Run `/weave:weave-config set weave_project ENTITY/PROJECT` |
| `⚠ Daemon is running an older config` | A setting changed since the daemon started, so the live daemon is using stale config. Run `weave-claude-code restart` to apply the new settings. |
| `- Daemon socket: not running` | Normal if no Claude Code session is active; daemon starts automatically on next hook event |
| `- Log file: not created yet` | Normal before first session; no action needed |

## Report

Summarize the status to the user. If all required items are ✓, confirm the plugin is ready and sessions will be traced automatically. If any ✗ items exist, provide the specific fix steps. If a `⚠` warning appears, surface it explicitly and run the recommended fix command.
