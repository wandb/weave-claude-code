# Weave Claude Code Plugin

Track Claude Code sessions in [Weave](https://wandb.ai/) for observability and debugging. Every session, turn, tool call, and subagent is automatically logged as a structured trace — no code changes required.

## Quick Start

**1. Install the CLI**

```bash
npm install -g weave-claude-plugin
```

**2. Run the installer**

```bash
weave-claude-plugin install
```

This will:
- Create `~/.weave_claude_plugin/settings.json`
- Register the plugin in Claude Code
- Prompt for your Weave project (`entity/project`) and W&B API key if not already set

Marketplace installs are pinned to a specific release tag rather than the
repository default branch. New releases are cut via two GitHub Actions:

1. **Version Bump** — dispatched with a version like `0.1.2`. Bumps the
   pinned version across the repo, pins the marketplace to the resulting
   commit SHA, and creates and pushes the matching `v0.1.2` tag.
2. **Publish Package** — dispatched with the tag (e.g. `v0.1.2`). Verifies
   the tag is consistent and not already published, then builds and
   publishes to npm.

Your W&B API key is available at https://wandb.ai/authorize.

For CI, bootstrap scripts, or other automated systems, you can skip prompts:

```bash
WEAVE_PROJECT=my-entity/my-project \
WANDB_API_KEY=<your-api-key> \
weave-claude-plugin install --non-interactive
```

In non-interactive mode, the installer still creates config, registers the Claude marketplace, and installs the plugin. It does not prompt for missing values. Instead, it:
- Uses `WEAVE_PROJECT` and `WANDB_API_KEY` from the environment when present
- Warns and continues if either value is missing
- Leaves environment-provided values in the environment rather than writing them into `settings.json`

**3. Launch Claude Code from any folder**

```bash
claude
```

Sessions are traced automatically from this point. Open your Weave project to see them.

---

## Data Disclosure

This plugin sends Claude Code session data to W&B Weave.

That data can include sensitive content, including:
- user prompts
- Claude responses
- tool inputs
- tool outputs
- file paths and file contents read by Claude Code tools
- shell commands and shell output
- fetched URLs and fetched page content

If Claude Code accesses secrets, credentials, proprietary source code, personal
data, or other confidential material during a session, that information may be
logged to W&B Weave as part of the trace.

PII scrubbing and sensitive-data redaction are **not yet implemented** in the
current version. If you cannot send this data to W&B Weave under your security
or compliance requirements, do not install or enable this plugin yet.

---

## Configuration

```bash
# Show all current settings
weave-claude-plugin config show

# Set your Weave project
weave-claude-plugin config set weave_project my-entity/my-project

# Set your W&B API key
weave-claude-plugin config set wandb_api_key <your-api-key>
```

You can also set these via environment variables — they take precedence over the settings file:

```bash
export WEAVE_PROJECT=my-entity/my-project
export WANDB_API_KEY=<your-api-key>
```

This is especially useful with `weave-claude-plugin install --non-interactive`, where the installer checks these variables instead of prompting.

---

## Sending Traces to a Dedicated or Private W&B Instance

If you use W&B Dedicated Cloud or a self-hosted instance, set `WANDB_BASE_URL` to point the plugin at your deployment before launching Claude Code:

```bash
export WANDB_BASE_URL=https://your-instance.wandb.io
```

**Important:** The plugin runs a background daemon that creates the Weave client at startup. If `WANDB_BASE_URL` is set after the daemon is already running, it will have no effect — the daemon must be restarted with the variable present in its environment.

**Workaround if the daemon is already running:**

1. Shut down the daemon:
   ```bash
   printf '{"command":"shutdown"}' | nc -U -w1 ~/.weave_claude_plugin/daemon.sock
   ```
2. Point the plugin at your instance using either approach:

   **Option A — environment variable** (takes effect for the current shell session):
   ```bash
   export WANDB_BASE_URL=https://your-instance.wandb.io
   ```

   **Option B — `wandb login`** (persists across sessions via `~/.config/wandb/settings`):
   ```bash
   wandb login --host https://your-instance.wandb.io
   ```
   This writes the host URL to `$HOME/.config/wandb/settings`, which the Weave client reads automatically — no env var required on future launches.

3. Relaunch Claude Code — the daemon will start fresh and pick up the correct URL:
   ```bash
   claude
   ```

---

## Check Status

```bash
weave-claude-plugin status
```

Each line shows `✓` (OK), `✗` (action needed), or `-` (not yet active but not an error).

If sessions are not appearing in Weave, check the daemon log for errors:

```bash
weave-claude-plugin logs
```

Or tail it in real time:

```bash
weave-claude-plugin logs --follow
```

The log file is also directly at `~/.weave_claude_plugin/logs/daemon.log`.

---

## Skills

Once the plugin is installed, three skills are available directly inside any Claude Code session:

To avoid collisions with Claude Code's built-in skills, the config and status skills use unique hyphenated names. Their user-facing commands are `/weave:weave-config` and `/weave:weave-status`.

### `/weave:weave-install`

Walks through the full installation and configuration flow interactively. Use this on a fresh machine or to diagnose a broken setup. Claude will check for the CLI, run the installer, prompt for missing config values, and verify everything is working.

```
/weave:weave-install
```

### `/weave:weave-status`

Checks the current plugin status and explains any issues. Equivalent to running `weave-claude-plugin status` but Claude interprets the output and tells you exactly what to fix.

```
/weave:weave-status
```

### `/weave:weave-config`

Read or update plugin configuration without leaving Claude Code.

```
# Show current config
/weave:weave-config

# Set a value directly
/weave:weave-config set weave_project my-entity/my-project
/weave:weave-config set wandb_api_key <your-api-key>
```

---

## What Gets Traced

Each Claude Code session produces a trace in Weave with the following hierarchy:

```
claude_code.session
  └─ claude_code.turn          (one per user message)
       ├─ claude_code.tool.*   (each tool call: Read, Bash, Grep, etc.)
       │    └─ claude_code.permission_request  (if user approval was needed)
       └─ claude_code.subagent (if Claude spawned a subagent)
            └─ claude_code.tool.*
```

Each trace includes token usage, model name, tool inputs/outputs, timing, and
the textual content associated with prompts and responses.

Important: tool inputs and outputs may contain sensitive information. In
practice this can include file contents, command output, URLs, fetched content,
and other data handled by Claude Code during a session. That information is sent
to W&B Weave. PII scrubbing/redaction is planned for a future release, but is
not available today.

---

## Uninstall

```bash
weave-claude-plugin uninstall
```

Pass `--keep-logs` to preserve the log directory.
