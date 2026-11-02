#!/usr/bin/env bash
# Stops a running DevFlow (SIGTERM => graceful shutdown). pgrep only nominates candidates; a process is signalled
# only if argv[0] is a `node` binary, argv[1] is exactly `dist-server/server/index.js`, and its cwd is this project.
cd "$(dirname "$(readlink -f "$0")")/.."
ROOT="$PWD"
found=0
for pid in $(pgrep -f "server/index.js" || true); do
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$ROOT" ] || continue
  mapfile -d '' argv < "/proc/$pid/cmdline" 2>/dev/null || continue
  [ "$(basename "${argv[0]:-}")" = "node" ] && [ "${argv[1]:-}" = "dist-server/server/index.js" ] && [ "${#argv[@]}" = 2 ] || continue
  kill -TERM "$pid" && echo "Stopped DevFlow (pid $pid)" && found=1
done
[ "$found" = 1 ] || echo "DevFlow is not running."
