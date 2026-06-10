#!/usr/bin/env bash
# Shut down the clawback proxy stack.
#
# By default this stops ONLY the detached proxy started via
# `run_monitor.sh --detach` (graceful SIGTERM, then SIGKILL after ~5s) and
# removes its pidfile — identical to `run_monitor.sh --stop`. A foreground
# `tail -F` follower (the monitor) then sees the proxy go quiet and the
# synthetic "process exited" line; stop it with Ctrl-C. An agent's Monitor
# tool just stops seeing new lines.
#
# It deliberately does NOT touch interactive `clawback claude` sessions by
# default. Those are your live Claude Code sessions; under clawback's
# probe-then-decide model they ATTACHED to this proxy rather than spawning
# their own, so killing the proxy already cuts their upstream — but the
# session processes (and any in-flight edit) are yours to end deliberately.
#
# Pass --sessions for a full teardown: it ALSO sends SIGTERM to every
# `clawback claude` wrapper process, listing each (pid + full command) before
# signaling so nothing is killed silently. The spawned `claude` child is left
# alone; end it yourself if it lingers.
#
#   .skills/shutdown/scripts/shutdown.sh              # stop the proxy + let the monitor go quiet
#   .skills/shutdown/scripts/shutdown.sh --sessions   # also SIGTERM clawback claude sessions
#
# --log-file / --pid-file are forwarded to `run_monitor.sh --stop` so a
# non-default proxy can be targeted.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This skill lives at .skills/shutdown/scripts; three levels up is the project
# root. It delegates to the shared .skills/scripts/run_monitor.sh.
PROJECT_DIR="$(cd "$DIR/../../.." && pwd)"

KILL_SESSIONS=0
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sessions) KILL_SESSIONS=1 ;;
    *)          PASS_ARGS+=("$1") ;;
  esac
  shift
done

echo "shutdown: stopping detached proxy…"
"$PROJECT_DIR/.skills/scripts/run_monitor.sh" --stop ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}

if [[ "$KILL_SESSIONS" -eq 1 ]]; then
  # Match the `clawback claude` wrapper processes only. The bare proxy is
  # `node …/bin/clawback.js` (no "claude"); this script and run_monitor.sh
  # don't contain the phrase either, so the pattern is specific to the
  # wrappers. pgrep excludes itself.
  pids="$(pgrep -f 'clawback claude' 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    echo "shutdown: no 'clawback claude' sessions found."
  else
    echo "shutdown: sending SIGTERM to clawback claude session(s):"
    for pid in $pids; do
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      printf '  %s  %s\n' "$pid" "$cmd"
      kill "$pid" 2>/dev/null || true
    done
  fi
fi

echo "shutdown: done."
