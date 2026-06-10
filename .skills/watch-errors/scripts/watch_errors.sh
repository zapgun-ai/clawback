#!/usr/bin/env bash
# watch_errors.sh — quiet operator watch: stream ONLY legitimate errors from a
# detached clawback proxy's run log, and announce the instant the proxy dies.
#
# Why this exists alongside operator_watch.sh:
#   operator_watch.sh surfaces EVERY [warn] and EVERY 4xx/5xx. In practice the
#   live proxy emits a constant benign flood that is NOT actionable and must not
#   wake an agent — each wake replays the whole conversation context, so a benign
#   line every few minutes is pure token burn. The benign classes, all observed
#   live:
#     - keep-alive ping failures: 401 (auth-stale — the captured OAuth bearer
#       rotated; the scheduler PAUSES until the next real request refreshes it),
#       404 (a session pinned to a now-retired model loops on not_found),
#       429/529 (transient). Keep-alive is cache-warming ONLY; its failures never
#       block real work, so they are never actionable.
#     - real-request 429 (rate limit) and 529 (overloaded): Claude Code
#       auto-retries these with backoff and the operator has no lever, so they
#       are not actionable.
#     - [info] attach probes: "HEAD /<id> -> 404 [no-route]" is normal
#       probe-then-decide session negotiation.
#
# This watcher wakes ONLY on genuinely actionable failures:
#     - any [error]/[fatal] line, unhandled/uncaught exceptions, Error: stack
#       traces, bind/connection failures (EADDRINUSE / ECONN*), self-loop;
#     - server-side 5xx that are NOT the transient 529 (500/502/503/504...);
#     - non-keep-alive request failures (a real POST that 4xx/5xx'd for a reason
#       other than the benign/transient set above);
#     - a synthetic "[error] PROXY DOWN" the moment the proxy pid stops — the
#       most important error of all (the dev server is gone) — after which it
#       exits non-zero so the watch ends deliberately rather than hanging silent.
#
# Hard errors win: an [error]-level line ALWAYS wakes, even if it also mentions a
# benign token (e.g. "[error] keep-alive scheduler crashed: uncaught ...").
#
# Deliberate non-goal: a SUSTAINED transient outage (hundreds of 529s in a row =
# a real Anthropic outage) will NOT wake you — the filter is per-line and
# stateless, so a transient code is dropped no matter how often it repeats. That
# is the right trade to kill the noise; add rate-based escalation if you ever
# need outage alerts.
#
# Usage:
#   .skills/watch-errors/scripts/watch_errors.sh                 # watch (defaults below)
#   .skills/watch-errors/scripts/watch_errors.sh LOG PID         # explicit log + pidfile
#   .skills/watch-errors/scripts/watch_errors.sh selftest        # run the filter corpus; exit!=0 on regression
# Defaults match run_monitor.sh:
#   LOG = data/clawback.run.log   PID = data/clawback.run.pid
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

# The line classifier, as one awk program — the single source of truth shared by
# live watching AND the selftest. Prints a line iff it should wake the operator.
#   tier A (hard)  — always wake.
#   tier B (soft)  — status-code / failure lines: wake UNLESS benign.
AWK_FILTER=$(cat <<'AWK'
/\[error\]|\[fatal\]|PROXY DOWN|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|unhandled|Unhandled|uncaught|Uncaught|panic|FATAL|self-loop|Error:/ { print; fflush(); next }
/→ [45][0-9][0-9]|failed/ {
  if ($0 ~ /keep-alive|auth-stale|→ 429|→ 529|\[no-route\]|\[info\]/) next
  print; fflush(); next
}
AWK
)

filter_stream() { awk "$AWK_FILTER"; }

selftest() {
  # Corpus of REAL log shapes seen live (benign) plus representative legitimate
  # errors. Benign lines must be dropped; legit lines must wake.
  local benign legit fail=0 line
  benign=$(cat <<'EOF'
2026-06-05T14:16:46.610Z [info] HEAD /788e7b93 → 404 0ms [no-route]
2026-06-05T14:16:48.415Z [warn] POST /788e7b93/v1/messages?beta=true → 429 229ms [session=788e7b93(path)]
2026-06-05T12:46:01.968Z [warn] keep-alive e828086f → 401 ping 31 elapsed=4m err="authentication_error: Invalid authentication credentials"
2026-06-05T12:46:01.969Z [warn] auth-stale for e828086f (HTTP 401); pausing keep-alive until next real request refreshes authHeaders
2026-06-05T15:12:12.088Z [warn] keep-alive e828086f → 529 ping 51 elapsed=3m err="overloaded_error: Overloaded" retry_after=0s
2026-06-05T20:53:51.301Z [warn] keep-alive e828086f → 404 ping 182 elapsed=4m err="not_found_error: model: claude-opus-4-7[1m]"
2026-06-05T15:50:42.155Z [warn] POST /bef4a0f8/v1/messages?beta=true → 529 5351ms [session=bef4a0f8(path)] retry_after=0s
2026-06-05T20:53:35.300Z [warn] POST /xyz01234/v1/messages?beta=true → 404 7ms [no-route]
EOF
)
  legit=$(cat <<'EOF'
2026-06-05T03:51:09.000Z [error] PROXY DOWN — pid 8562 no longer alive (log: data/clawback.run.log)
2026-06-05T10:00:00.000Z [warn] POST /abc12345/v1/messages?beta=true → 500 1200ms [session=abc12345(path)]
2026-06-05T10:00:00.000Z [warn] POST /abc12345/v1/messages?beta=true → 503 900ms [session=abc12345(path)]
2026-06-05T10:00:00.000Z [error] EADDRINUSE: address already in use 0.0.0.0:8080
2026-06-05T10:00:00.000Z [error] uncaught exception: TypeError: Cannot read properties of undefined (reading 'foo')
2026-06-05T10:00:00.000Z [error] keep-alive scheduler crashed: uncaught TypeError in _tick
2026-06-05T20:53:35.567Z [warn] POST /e828086f/v1/messages?beta=true → 404 191ms [session=e828086f(path)]
EOF
)
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if printf '%s\n' "$line" | filter_stream | grep -q .; then
      printf 'SELFTEST FAIL (benign woke): %s\n' "$line" >&2; fail=1
    fi
  done <<<"$benign"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! printf '%s\n' "$line" | filter_stream | grep -q .; then
      printf 'SELFTEST FAIL (legit dropped): %s\n' "$line" >&2; fail=1
    fi
  done <<<"$legit"
  [[ "$fail" -eq 0 ]] && echo "watch_errors selftest: OK (8 benign dropped, 7 legit woke)"
  return "$fail"
}

case "${1:-}" in
  selftest) selftest; exit $? ;;
  -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
esac

LOG_FILE="${1:-data/clawback.run.log}"
PID_FILE="${2:-data/clawback.run.pid}"
POLL_SEC="${WATCH_ERRORS_POLL_SEC:-5}"

[[ -f "$LOG_FILE" ]] || { echo "watch_errors: no log at $LOG_FILE" >&2; exit 2; }

# Stream only NEW lines (-n 0 = start at end; -F = re-open across the
# truncate-and-recreate that run_monitor.sh --detach does on restart).
tail -n 0 -F "$LOG_FILE" 2>/dev/null | filter_stream &
TAIL_PID=$!
trap 'kill "$TAIL_PID" 2>/dev/null' EXIT

# Liveness: poll the proxy pid; announce + exit the moment it is gone. A bare
# tail cannot do this (BSD/macOS tail has no --pid), so a crash would otherwise
# read as healthy-idle silence.
while :; do
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    printf '%s [error] PROXY DOWN — pid %s no longer alive (log: %s)\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${pid:-<none>}" "$LOG_FILE"
    exit 1
  fi
  sleep "$POLL_SEC"
done
