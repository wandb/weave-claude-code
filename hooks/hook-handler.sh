#!/bin/bash
# Receives a Claude Code lifecycle event on stdin (JSON) and forwards it to the
# Weave daemon via Unix socket. Starts the daemon first if it is not running.
#
# Assumptions:
#   - weave-claude-plugin is on PATH (installed globally via npm install -g)
#   - nc (netcat) is available (ships with macOS; brew install netcat on Linux)
#
# Errors are written to ~/.weave_claude_plugin/logs/hook-errors.log.
# The script always exits 0 so it never disrupts Claude Code.

set -uo pipefail

CONFIG_DIR="${HOME}/.weave_claude_plugin"
SETTINGS_FILE="${CONFIG_DIR}/settings.json"
ERROR_LOG="${CONFIG_DIR}/logs/hook-errors.log"
SOCKET_PATH="${CONFIG_DIR}/daemon.sock"

# Ensure the log directory exists so we can always write errors
mkdir -p "${CONFIG_DIR}/logs"

# ── dependency checks ─────────────────────────────────────────────────────────

if ! command -v weave-claude-plugin >/dev/null 2>&1; then
  echo "$(date -Iseconds) | ERROR | weave-claude-plugin not found in PATH. Run: npm install -g weave-claude-plugin" >> "${ERROR_LOG}"
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
Run:  weave-claude-plugin install
Then: weave-claude-plugin config set weave_project ENTITY/PROJECT
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

if [ ! -S "${SOCKET_PATH}" ]; then
  weave-claude-plugin daemon >> "${ERROR_LOG}" 2>&1 &

  # Wait up to 5 s (50 × 100 ms) for the socket to appear
  for i in $(seq 1 50); do
    [ -S "${SOCKET_PATH}" ] && break
    sleep 0.1
  done

  if [ ! -S "${SOCKET_PATH}" ]; then
    cat >> "${ERROR_LOG}" << EOF
$(date -Iseconds) | ERROR | Daemon did not start within 5 s.
  Diagnose: weave-claude-plugin status
  Logs:     weave-claude-plugin logs --tail 50
EOF
    exit 0
  fi
fi

# ── forward event to daemon ───────────────────────────────────────────────────

EVENT_PAYLOAD=$(cat)
printf '%s' "${EVENT_PAYLOAD}" | nc -U -w1 "${SOCKET_PATH}" 2>> "${ERROR_LOG}" || {
  echo "$(date -Iseconds) | ERROR | Failed to send event to daemon" >> "${ERROR_LOG}"
}

exit 0
