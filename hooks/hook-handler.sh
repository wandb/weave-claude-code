#!/bin/bash

# SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
# SPDX-License-Identifier: MIT
# SPDX-PackageName: weave-claude-code

# Receives a Claude Code lifecycle event on stdin (JSON) and forwards it to the
# Weave daemon via Unix socket. Starts the daemon first if it is not running.
#
# Assumptions:
#   - weave-claude-code is on PATH (installed globally via npm install -g)
#   - nc (netcat) is available (ships with macOS; brew install netcat on Linux)
#
# Errors are written to ~/.weave-claude-code/logs/hook-errors.log.
# The script always exits 0 so it never disrupts Claude Code.

set -uo pipefail

CONFIG_DIR="${HOME}/.weave-claude-code"
SETTINGS_FILE="${CONFIG_DIR}/settings.json"
ERROR_LOG="${CONFIG_DIR}/logs/hook-errors.log"
SOCKET_PATH="${CONFIG_DIR}/daemon.sock"

# Ensure the log directory exists so we can always write errors
mkdir -p "${CONFIG_DIR}/logs"

# ── dependency checks ─────────────────────────────────────────────────────────

if ! command -v weave-claude-code >/dev/null 2>&1; then
  echo "$(date -Iseconds) | ERROR | weave-claude-code not found in PATH. Run: npm install -g weave-claude-code" >> "${ERROR_LOG}"
  exit 0
fi

if ! command -v nc >/dev/null 2>&1; then
  echo "$(date -Iseconds) | ERROR | nc (netcat) not found. Install with: brew install netcat" >> "${ERROR_LOG}"
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
# that state, but nc -U / connect() will then fail and silently drop every
# event. Probe the socket instead.

is_daemon_alive() {
  # `</dev/null nc -U -w1 sock` opens a UNIX-domain connection, writes nothing,
  # and exits 0 iff connect() succeeded. The daemon's empty-payload short-
  # circuit (src/daemon.ts handleConnection: `if (!raw) return`) means an empty
  # connection is dropped silently — no log spam.
  #
  # We do NOT use `nc -z -U`: on macOS BSD nc (Darwin 25.x), `-z` for UNIX
  # sockets returns 1 even against a live listener.
  </dev/null nc -U -w1 "${SOCKET_PATH}" >/dev/null 2>&1
}

if ! is_daemon_alive; then
  weave-claude-code daemon >> "${ERROR_LOG}" 2>&1 &

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

EVENT_PAYLOAD=$(cat)

# If parent Weave context is available, merge it into the payload using
if [ -n "${WEAVE_PARENT_CALL_ID:-}" ] || [ -n "${WEAVE_TRACE_ID:-}" ]; then
  EVENT_PAYLOAD=$(printf '%s' "${EVENT_PAYLOAD}" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const o=JSON.parse(d);
      if(process.env.WEAVE_PARENT_CALL_ID)o.weave_parent_call_id=process.env.WEAVE_PARENT_CALL_ID;
      if(process.env.WEAVE_TRACE_ID)o.weave_trace_id=process.env.WEAVE_TRACE_ID;
      process.stdout.write(JSON.stringify(o));
    });
  ")
fi

printf '%s' "${EVENT_PAYLOAD}" | nc -U -w1 "${SOCKET_PATH}" 2>> "${ERROR_LOG}" || {
  echo "$(date -Iseconds) | ERROR | Failed to send event to daemon" >> "${ERROR_LOG}"
}

exit 0
