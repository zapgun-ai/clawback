#!/usr/bin/env bash
# Operator watch: stream the actionable lines from an already-detached
# clawback proxy's run log AND announce the instant the proxy process dies.
#
# Why this exists alongside run_monitor.sh:
#   `run_monitor.sh --attach` only tails the log. BSD/macOS tail has no
#   --pid, so if the proxy crashes the log simply goes quiet and an attached
#   follower (or an agent's Monitor tool) sees silence — which is
#   indistinguishable from "healthy but idle". Only run_monitor.sh's
#   foreground `follow` mode has a liveness watcher, and that mode starts its
#   OWN proxy (it would collide on the port with one already detached).
#
# This script is the missing piece: point it at the log + pidfile of a proxy
# started with `run_monitor.sh --detach`, and it emits ONE line per
# actionable event on stdout — error/warn/4xx/5xx/crash-signature log lines,
# plus a loud "PROXY DOWN" line the moment the pid stops responding. Designed
# so stdout == an event stream (e.g. for an agent's Monitor tool): it stays
# quiet during healthy idle, speaks up on anything worth acting on, and exits
# non-zero when the proxy dies so the watch ends deliberately rather than
# hanging silent.
#
# Usage:
#   .skills/operate/scripts/operator_watch.sh [LOG_FILE] [PID_FILE]
# Defaults match run_monitor.sh:
#   LOG_FILE = data/clawback.run.log
#   PID_FILE = data/clawback.run.pid
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

LOG_FILE="${1:-data/clawback.run.log}"
PID_FILE="${2:-data/clawback.run.pid}"
POLL_SEC="${OPERATOR_WATCH_POLL_SEC:-5}"

# Lines worth surfacing: explicit warn/error levels, 4xx/5xx upstream/proxy
# responses, the words that show up on failure paths, and two INFO signals an
# operator actively cares about — a (re)bind ("clawback listening") and a
# runtime-mode flip ("runtime mode toggled", e.g. baseline->armed after the
# fresh-proxy capture window).
ERR_PATTERN='\[error\]|\[warn\]|→ [45][0-9][0-9]|failed|self-loop|EADDRINUSE|ECONN|ETIMEDOUT|ENOTFOUND|unhandled|Unhandled|Error:|runtime mode toggled|clawback listening'

[[ -f "$LOG_FILE" ]] || { echo "operator_watch: no log at $LOG_FILE" >&2; exit 2; }

# Stream only NEW actionable lines (-n 0 = start at end; -F = re-open on the
# truncate-and-recreate that run_monitor.sh --detach does on restart).
tail -n 0 -F "$LOG_FILE" 2>/dev/null | grep -E --line-buffered "$ERR_PATTERN" &
TAIL_PID=$!
trap 'kill "$TAIL_PID" 2>/dev/null' EXIT

# Liveness: poll the proxy pid; announce + exit the moment it is gone.
while :; do
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    printf '%s [error] PROXY DOWN — pid %s no longer alive (log: %s)\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${pid:-<none>}" "$LOG_FILE"
    exit 1
  fi
  sleep "$POLL_SEC"
done
