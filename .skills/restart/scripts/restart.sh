#!/usr/bin/env bash
# Restart the detached clawback proxy (and reconnect its monitor).
#
# Stops the proxy previously started with `run_monitor.sh --detach` (if any),
# then starts a fresh one in the background. The run log is recreated in
# place, so a `tail -F` follower — `run_monitor.sh --attach`, or an agent's
# Monitor tool watching the same path — re-attaches on its own; there is no
# separate follower process to restart by hand.
#
# This is exactly `run_monitor.sh --stop` followed by `run_monitor.sh
# --detach`, so it honors the same options and the same `--` passthrough:
#
#   .skills/restart/scripts/restart.sh                              # restart with current config
#   .skills/restart/scripts/restart.sh -- --port 8090 --log-level debug
#   .skills/restart/scripts/restart.sh --log-file data/other.log    # non-default log/pidfile
#
# --log-file / --pid-file (when given) are forwarded to BOTH phases so the
# stop targets the same proxy the detach will replace. Anything after `--`
# is forwarded to the new proxy (the stop phase ignores it).
#
# --watch: restart once now, then keep restarting automatically whenever a
# source file under src/ or bin/ changes (e.g. when another `clawback claude`
# session edits the code). Runs in the foreground; Ctrl-C stops WATCHING but
# leaves the proxy running. Only src/ and bin/ are watched, so the proxy's
# own writes under data/ can never trigger a restart loop. Any other flags
# (and `-- …` passthrough) are forwarded to every restart:
#
#   .skills/restart/scripts/restart.sh --watch
#   .skills/restart/scripts/restart.sh --watch -- --port 8090 --log-level debug

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This skill lives at .skills/restart/scripts; three levels up is the project
# root (holds src/, bin/, …). It delegates to .skills/scripts/run_monitor.sh.
PROJECT_DIR="$(cd "$DIR/../../.." && pwd)"

# Pull --watch out of the argument list; everything else is forwarded
# verbatim to run_monitor.sh (and, in watch mode, to each restart).
WATCH=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch) WATCH=1 ;;
    *)       ARGS+=("$1") ;;
  esac
  shift
done

if [[ "$WATCH" -eq 1 ]]; then
  echo "restart: watch mode — restarting on changes under src/ and bin/ (Ctrl-C stops watching; proxy stays up)…"
  # The watcher owns ALL restarts (initial + on-change) so every proxy it
  # spawns lands in its own detached session — Ctrl-C here can't reach them.
  exec node "$DIR/watch.mjs" --initial \
    --dir "$PROJECT_DIR/src" --dir "$PROJECT_DIR/bin" \
    -- "$DIR/restart.sh" ${ARGS[@]+"${ARGS[@]}"}
fi

echo "restart: stopping current proxy (if any)…"
"$PROJECT_DIR/.skills/scripts/run_monitor.sh" --stop ${ARGS[@]+"${ARGS[@]}"}

echo "restart: starting a fresh proxy…"
exec "$PROJECT_DIR/.skills/scripts/run_monitor.sh" --detach ${ARGS[@]+"${ARGS[@]}"}
