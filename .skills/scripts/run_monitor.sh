#!/usr/bin/env bash
# Run the clawback proxy and monitor its log output.
#
# Starts the bare `clawback` proxy (honoring the usual config layering:
# DEFAULTS < global < ./CLAWBACK.md < these flags), captures its combined
# stdout+stderr to a log file, and follows that log with warn/error/4xx/5xx
# lines highlighted. Capturing both fds (rather than relying on --log-file)
# means pre-logger startup failures — EADDRINUSE, a missing TLS cert, an
# upstream self-loop — land in the same file instead of vanishing.
#
# Modes (pick one; default is foreground follow):
#   (default)   start the proxy, follow logs in the foreground.
#               Ctrl-C stops the proxy and the follower together.
#   --detach    start the proxy in the background, print its PID + log path,
#               and exit. The proxy keeps running. Stop it later with --stop.
#   --stop      stop a proxy previously started with --detach (via pidfile).
#   --status    report whether the --detach'd proxy is alive.
#   --attach    do NOT start a proxy; just follow an existing log file
#               (use when clawback is already running, e.g. via `clawback claude`).
#
# Options:
#   --log-file PATH   log destination (default: data/clawback.run.log)
#   --pid-file PATH   pidfile for detach/stop/status (default: data/clawback.run.pid)
#   --errors-only     while following, surface only warn/error/4xx/5xx/failure lines
#   --no-color        disable ANSI highlighting (also honored: NO_COLOR env)
#   -h, --help        show this help
#
# Anything after `--` is forwarded verbatim to `clawback`, e.g.:
#   .skills/scripts/run_monitor.sh -- --port 8090 --log-level debug

set -euo pipefail

# Owner-only perms on everything we create: the proxy log can contain
# captured auth headers / upstream error bodies, same posture as clawback's
# own 0600 logs.
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"

LOG_FILE="data/clawback.run.log"
PID_FILE="data/clawback.run.pid"
MODE="follow"          # follow | detach | stop | status | attach
ERRORS_ONLY=0
USE_COLOR=1
EXTRA_ARGS=()

# Lines worth flagging while monitoring: explicit warn/error levels, 4xx/5xx
# upstream or proxy responses, and the words that show up in failure paths.
ERR_PATTERN='\[error\]|\[warn\]|→ [45][0-9][0-9]|failed|self-loop|EADDRINUSE|ECONN|ETIMEDOUT|ENOTFOUND|unhandled|Unhandled|Error:'

# Print the leading comment block (minus the shebang) as help text.
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --detach)      MODE="detach" ;;
    --stop)        MODE="stop" ;;
    --status)      MODE="status" ;;
    --attach)      MODE="attach" ;;
    --errors-only) ERRORS_ONLY=1 ;;
    --no-color)    USE_COLOR=0 ;;
    --log-file)    LOG_FILE="${2:?--log-file needs a path}"; shift ;;
    --pid-file)    PID_FILE="${2:?--pid-file needs a path}"; shift ;;
    -h|--help)     usage; exit 0 ;;
    --)            shift; EXTRA_ARGS=("$@"); break ;;
    *) echo "run_monitor: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

[[ -n "${NO_COLOR:-}" ]] && USE_COLOR=0
[[ -t 1 ]] || USE_COLOR=0

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

# Colorize a log stream on stdout: errors red, warns yellow, 4xx/5xx magenta.
# A passthrough when color is disabled so --no-color / pipes stay clean.
colorize() {
  if [[ "$USE_COLOR" -eq 0 ]]; then cat; return; fi
  awk '
    /\[error\]|unhandled|Unhandled|Error:/ { printf "\033[31m%s\033[0m\n", $0; fflush(); next }
    /\[warn\]/                             { printf "\033[33m%s\033[0m\n", $0; fflush(); next }
    /→ [45][0-9][0-9]/                     { printf "\033[35m%s\033[0m\n", $0; fflush(); next }
    { print; fflush() }
  '
}

# Follow $LOG_FILE forever, optionally pre-filtered to error-ish lines.
# `tail -n +1 -F` re-opens the file if it is rotated/recreated.
follow() {
  if [[ "$ERRORS_ONLY" -eq 1 ]]; then
    tail -n +1 -F "$LOG_FILE" 2>/dev/null | grep -E --line-buffered "$ERR_PATTERN" | colorize
  else
    tail -n +1 -F "$LOG_FILE" 2>/dev/null | colorize
  fi
}

# Wait until the proxy logs that it is listening, or until the process dies.
# Returns 0 on "listening", 1 if the process exited (startup failure).
wait_ready() {
  local pid="$1" i
  for ((i = 0; i < 100; i++)); do
    grep -q "clawback listening on" "$LOG_FILE" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.1
  done
  return 0
}

read_pid() { [[ -f "$PID_FILE" ]] && cat "$PID_FILE" 2>/dev/null || true; }

case "$MODE" in
  stop)
    pid="$(read_pid)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      echo "run_monitor: no running proxy found (pidfile: $PID_FILE)"
      rm -f "$PID_FILE"
      exit 0
    fi
    echo "run_monitor: stopping clawback (pid $pid)…"
    kill "$pid" 2>/dev/null || true
    for ((i = 0; i < 50; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && { echo "run_monitor: still alive, sending SIGKILL"; kill -9 "$pid" 2>/dev/null || true; }
    rm -f "$PID_FILE"
    echo "run_monitor: stopped."
    exit 0
    ;;

  status)
    pid="$(read_pid)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "run_monitor: clawback is RUNNING (pid $pid, log $LOG_FILE)"
      exit 0
    fi
    echo "run_monitor: clawback is NOT running (pidfile: $PID_FILE)"
    exit 1
    ;;

  attach)
    [[ -f "$LOG_FILE" ]] || { echo "run_monitor: no log at $LOG_FILE to attach to" >&2; exit 1; }
    echo "run_monitor: attaching to $LOG_FILE (Ctrl-C to detach; proxy keeps running)"
    follow
    exit 0
    ;;

  detach)
    existing="$(read_pid)"
    if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
      echo "run_monitor: a proxy is already running (pid $existing). Use --stop first." >&2
      exit 1
    fi
    : > "$LOG_FILE"; chmod 600 "$LOG_FILE"
    nohup node "$PROJECT_DIR/bin/clawback.js" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} >> "$LOG_FILE" 2>&1 &
    pid=$!
    echo "$pid" > "$PID_FILE"
    if wait_ready "$pid"; then
      echo "run_monitor: clawback started (pid $pid)"
      echo "  log:    $LOG_FILE"
      echo "  follow: .skills/scripts/run_monitor.sh --attach --log-file $LOG_FILE"
      echo "  stop:   .skills/scripts/run_monitor.sh --stop"
      exit 0
    fi
    echo "run_monitor: clawback FAILED to start — last lines:" >&2
    tail -n 15 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
    ;;

  follow)
    : > "$LOG_FILE"; chmod 600 "$LOG_FILE"
    node "$PROJECT_DIR/bin/clawback.js" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} >> "$LOG_FILE" 2>&1 &
    PROXY_PID=$!
    echo "$PROXY_PID" > "$PID_FILE"

    FOLLOW_PID=""
    WATCH_PID=""
    cleanup() {
      local ec=$?
      [[ -n "$FOLLOW_PID" ]] && kill "$FOLLOW_PID" 2>/dev/null || true
      [[ -n "$WATCH_PID" ]] && kill "$WATCH_PID" 2>/dev/null || true
      [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null || true
      wait 2>/dev/null || true
      rm -f "$PID_FILE"
      exit "$ec"
    }
    trap cleanup EXIT INT TERM

    if ! wait_ready "$PROXY_PID"; then
      echo "run_monitor: clawback FAILED to start — last lines:" >&2
      tail -n 15 "$LOG_FILE" >&2 || true
      exit 1
    fi
    echo "run_monitor: clawback running (pid $PROXY_PID); following $LOG_FILE — Ctrl-C to stop."
    [[ "$ERRORS_ONLY" -eq 1 ]] && echo "run_monitor: errors-only filter active."

    # Liveness watcher: BSD/macOS tail lacks --pid, so if the proxy dies on
    # its own we append a synthetic error line. The follow pipeline then
    # surfaces it (red) instead of going silently quiet.
    ( while kill -0 "$PROXY_PID" 2>/dev/null; do sleep 1; done
      printf '%s [error] clawback process %s exited — proxy is no longer running\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$PROXY_PID" >> "$LOG_FILE" ) &
    WATCH_PID=$!

    follow &
    FOLLOW_PID=$!
    wait "$FOLLOW_PID"
    ;;
esac
