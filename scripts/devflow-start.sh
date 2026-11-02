#!/usr/bin/env bash
# On-demand launcher: starts DevFlow (if not already running) and opens the dashboard.
# Runs the server in the FOREGROUND so the console window owns the process: close the window (or Ctrl+C)
# to stop it. The server never exits on idle unless `idleExitMinutes` is set in the config (default 0 = never).
# Creates no scheduled task, service, or WSL configuration.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

PORT="${DEVFLOW_PORT:-4317}"
URL="http://localhost:${PORT}"
ready() { curl -fsS --max-time 2 "${URL}/api/readyz" >/dev/null 2>&1; }

open_browser() {
  [ "${DEVFLOW_NO_BROWSER:-0}" = "1" ] && return 0
  if command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "${URL}" >/dev/null 2>&1 || true
  elif command -v wslview >/dev/null 2>&1; then wslview "${URL}" >/dev/null 2>&1 || true
  else echo "Open ${URL} in your browser."; fi
}

if ready; then
  echo "DevFlow is already running at ${URL}"
  open_browser
  exit 0
fi

# Find node even when launched from a non-interactive shell (nvm is not loaded there).
NODE="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE}" ]; then NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"; fi
[ -x "${NODE:-}" ] || { echo "node not found. Install Node 22+ or set NODE_BIN." >&2; exit 1; }

[ -f dist-server/server/index.js ] && [ -f dist/index.html ] || { echo "DevFlow is not built. Run: npm run build" >&2; exit 1; }

mkdir -p logs
LOG=logs/devflow.log
# Bounded log for the whole run (not just at launch): rotate to $LOG.1 whenever it passes 1 MiB (max ~2 MiB on disk).
rotate_if_big() { if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi; }
bounded_tee() {
  local n=0 line
  while IFS= read -r line; do
    printf '%s\n' "$line"; printf '%s\n' "$line" >> "$LOG"
    n=$((n + 1)); if [ $((n % 100)) -eq 0 ]; then rotate_if_big; fi
  done
}
rotate_if_big

echo "Starting DevFlow on ${URL} (close this window to stop). Log: $PWD/$LOG"
# Open the browser once the server answers (background helper; exits by itself).
( for _ in $(seq 1 40); do ready && { open_browser; exit 0; }; sleep 0.25; done ) &

# Foreground; output goes to the console and the bounded log. Signals are forwarded for a clean shutdown.
"${NODE}" dist-server/server/index.js > >(bounded_tee) 2>&1 &
NODE_PID=$!
trap 'kill -TERM "$NODE_PID" 2>/dev/null || true' INT TERM HUP
wait "$NODE_PID"; CODE=$?
# `wait` returns early (>128) when a trapped signal arrives; wait again so shutdown finishes before we exit.
wait "$NODE_PID" 2>/dev/null || true
exit "$CODE"
