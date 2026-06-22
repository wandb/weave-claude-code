---
name: weave-config
description: This skill should be used when the user wants to "configure weave", "set weave project", "change weave project", "set wandb api key", "update weave settings", "show weave config", "change weave configuration", "restart the weave daemon", "apply weave config changes", "restart weave to pick up changes", or needs to read or update any Weave Claude Code plugin settings.
---

# Weave Claude Code Plugin — Config

Read and update configuration for the Weave Claude Code plugin.

## Determine Intent

If the user invoked this skill with arguments (e.g., `/weave:weave-config set weave_project entity/project`), execute the corresponding command directly. Otherwise, show the current configuration first and then ask what they want to change.

## Show Current Config

Run:
```bash
weave-claude-code config show
```

This displays all settings and their sources (settings file vs environment variable).

## Set a Value

To update a setting:
```bash
weave-claude-code config set KEY VALUE
```

Writable keys:

| Key | Format | Example |
|-----|--------|---------|
| `weave_project` | `entity/project` | `my-org/my-project` |
| `wandb_api_key` | string | `abc123...` |
| `agent_name` | string | `my-team-bot` |
| `debug` | `true` / `false` | `true` |
| `daemon_socket` | file path | `~/.weave-claude-code/daemon.sock` |

**Validation notes:**
- `weave_project` must contain a `/` (entity/project format). Find your entity name at https://wandb.ai.
- `wandb_api_key` is available at https://wandb.ai/authorize.
- `agent_name` is the name shown for the top-level agent in Weave's Agents view. It must not be empty; surrounding whitespace is trimmed. Defaults to `claude-code` when unset.
- Environment variables `WEAVE_PROJECT`, `WANDB_API_KEY`, and `WEAVE_AGENT_NAME` take precedence over settings file values when set.

## Get a Single Value

To read one setting:
```bash
weave-claude-code config get KEY
```

## After Changes

After setting `weave_project`, `wandb_api_key`, or `agent_name`, run `weave-claude-code config show` to confirm the new value.

The daemon reads these once at startup and persists across Claude Code sessions, so a change is **not** picked up by a daemon that is already running. Apply it with:

```bash
weave-claude-code restart
```

This stops the running daemon and starts a fresh one. (If none is running, the next Claude Code session starts one with the updated config.)
