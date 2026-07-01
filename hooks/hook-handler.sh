#!/bin/bash

# SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
# SPDX-License-Identifier: MIT
# SPDX-PackageName: weave-claude-code

# Receives a Claude Code lifecycle event on stdin (JSON) and forwards it to the
# Weave daemon via Unix socket. Starts the daemon first if it is not running.
#
# Assumptions:
#   - weave-claude-code is on PATH (installed globally via npm install -g),
#     which implies node is on PATH too.
#
# Errors are written to ~/.weave-claude-code/logs/hook-errors.log.
# The script always exits 0 so it never disrupts Claude Code.

set -uo pipefail

CONFIG_DIR="${HOME}/.weave-claude-code"
SETTINGS_FILE="${CONFIG_DIR}/settings.json"
ERROR_LOG="${CONFIG_DIR}/logs/hook-errors.log"
SOCKET_PATH="${CONFIG_DIR}/daemon.sock"

# Resolve the directory this script lives in so we can find hook-socket.mjs
# (shipped alongside in the same hooks/ directory). The .mjs replaces the
# previous `nc -U -w1` calls (see hook-socket.mjs for details).
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SOCKET="${HOOK_DIR}/hook-socket.mjs"

# Ensure the log directory exists so we can always write errors
mkdir -p "${CONFIG_DIR}/logs"

# ── dependency checks ─────────────────────────────────────────────────────────

if ! command -v weave-claude-code >/dev/null 2>&1; then
  echo "$(date -Iseconds) | ERROR | weave-claude-code not found in PATH. Run: npm install -g weave-claude-code" >> "${ERROR_LOG}"
  exit 0
fi

# ── settings check ────────────────────────────────────────────────────────────

if [ ! -f "${SETTINGS_FILE}" ]; then
  cat >> "${ERROR_LOG}" << 'EOF'
========================================
ERROR | Plugin not configured.
Run:  weave-claude-code install
Then: weave-claude-code config set weave_project ENTITY/PROJECT
========================================
EOF
  exit 0
fi

# ── Weave configuration check ─────────────────────────────────────────────────
# Skip silently if weave_project or WANDB_API_KEY is not set — the daemon would
# refuse to start anyway, and we avoid a 5 s socket-wait timeout per event.

WEAVE_PROJECT_VALUE=$(grep -o '"weave_project" *: *"[^"]*"' "${SETTINGS_FILE}" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"')
if [ -z "${WEAVE_PROJECT_VALUE}" ] && [ -z "${WEAVE_PROJECT:-}" ]; then
  exit 0
fi

WANDB_API_KEY_VALUE=$(grep -o '"wandb_api_key" *: *"[^"]*"' "${SETTINGS_FILE}" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"')
if [ -z "${WANDB_API_KEY_VALUE}" ] && [ -z "${WANDB_API_KEY:-}" ]; then
  exit 0
fi

# ── start daemon if needed ────────────────────────────────────────────────────
#
# The socket file alone is NOT proof that the daemon is alive. When the daemon
# dies ungracefully (terminal SIGHUP, OOM, kill -9), its UNIX socket inode
# remains on disk with no listener. `[ -S "$SOCKET_PATH" ]` returns true in
# that state, but connect() will then fail and silently drop every event.
# Probe via hook-socket.mjs which does a real connect() attempt.

is_daemon_alive() {
  node "${HOOK_SOCKET}" probe "${SOCKET_PATH}" >/dev/null 2>&1
}

if ! is_daemon_alive; then
  # Detach the daemon from the spawning session. The daemon is started lazily by
  # whichever session's hook fires first; if that terminal later closes (the
  # engineer closes the tab) mid-run, the resulting SIGHUP would kill the daemon
  # and wipe its in-memory cross-session team map — breaking agent-teams nesting
  # for every still-running specialist. `nohup` makes the daemon ignore SIGHUP;
  # `disown` detaches it from this shell's job table. (macOS has no `setsid`, so
  # nohup+disown is the portable detach.) The daemon still self-reaps via its
  # inactivity timeout, so it won't linger forever.
  nohup weave-claude-code daemon >> "${ERROR_LOG}" 2>&1 &
  disown 2>/dev/null || true

  # Wait up to 5 s (50 × 100 ms) for the daemon to accept connections.
  # The daemon unlinks any stale socket file before binding — see
  # GlobalDaemon.start in src/daemon.ts — so we don't need to clean up here.
  for i in $(seq 1 50); do
    is_daemon_alive && break
    sleep 0.1
  done

  if ! is_daemon_alive; then
    cat >> "${ERROR_LOG}" << EOF
$(date -Iseconds) | ERROR | Daemon did not start within 5 s.
  Diagnose: weave-claude-code status
  Logs:     weave-claude-code logs --tail 50
EOF
    exit 0
  fi
fi

# ── forward event to daemon ───────────────────────────────────────────────────
#
# hook-socket.mjs send reads stdin, optionally merges WEAVE_PARENT_CALL_ID and
# WEAVE_TRACE_ID env vars into the payload, then writes to the socket. It exits
# 1 on connect failure; we log that to ERROR_LOG but always exit 0 so a hook
# failure never disrupts Claude Code.

node "${HOOK_SOCKET}" send "${SOCKET_PATH}" 2>> "${ERROR_LOG}" || {
  echo "$(date -Iseconds) | ERROR | Failed to send event to daemon" >> "${ERROR_LOG}"
}

exit 0
