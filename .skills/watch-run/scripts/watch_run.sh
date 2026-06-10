#!/usr/bin/env bash
# watch_run.sh <out-dir> [listen-port primary-port shadow-port]
# Emit-on-event watcher for a long paired/ab run, designed to be fed to the
# Monitor tool (each stdout line = one notification). Coverage-first: it speaks
# up on liveness, on errors, on a stall/crash (silence is NOT success), and on
# completion — never just on the happy path.
#
#   ALIVE     — first turns observed (the run came up)
#   ERROR(+n) — n new error-signature lines appeared in a proxy/tee log
#   STALL     — no new turns for the stall window, proxies still listening
#   DEAD      — no new turns AND no proxy listening (crashed) -> exit 1
#   COMPLETE  — report.md present (analyzer finished) -> exit 0
#   WATCH-END — hard wall-clock backstop tripped -> exit 2
set -u

# --- error signatures + detection (single source of truth; unit-tested via the
# hidden `--errcount <file>` entry point — see test/watch_run.test.js) ---
# Match HTTP error statuses ONLY via the "→ NNN" arrow form, never a bare number:
# a bare `429` matched timestamp milliseconds (…25.429Z) and token counts, which
# fired a false ERROR on a healthy keep-alive ping. The trailing ([^0-9]|$) stops
# a 4-digit count like "→ 4096" from matching the 3-digit status "→ 409". The
# arrow form covers 4xx/5xx incl. Anthropic's 529; `overload`/`rate-limit` cover
# the textual cases.
ERRRE='overload|rate.?limit|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Traceback|force-exit|\[error\]|→ [45][0-9][0-9]([^0-9]|$)|[Uu]nhandled|FATAL|panic'
# Benign lines that match ERRRE but are NOT failures: the driver's HEAD / health
# probe returns 404 [no-route] before it targets the real endpoint.
IGNORE='no-route'

# errcount <file> — count real error lines (the EXACT pipeline the watch loop
# uses). grep|grep -v|wc avoids grep -c's print-0-and-exit-1 double-count, which
# crashed the loop with `0\n0: syntax error in expression`; wc always prints one
# clean integer. Missing file => 0. This is the unit under regression test.
errcount() {
  [ -f "$1" ] || { echo 0; return; }
  grep -E "$ERRRE" "$1" 2>/dev/null | grep -vE "$IGNORE" | wc -l | tr -d ' '
}

# Hidden entry point for tests/inspection: print one file's error count and exit.
if [ "${1:-}" = "--errcount" ]; then errcount "${2:?--errcount needs a file}"; exit 0; fi

OUT="${1:?usage: watch_run.sh <out-dir> [listen primary shadow]}"
LP="${2:-8788}"; PP="${3:-8790}"; SP="${4:-8791}"
# Both overridable via env (soft default + knob): raise STALL_SEC for L2+ where
# gaps legitimately exceed 12 min (e.g. STALL_SEC=2400 for L2's up-to-30-min
# gaps, ~6000 for L3). A too-low STALL_SEC only WARNS (STALL); it never forces a
# false DEAD — that still requires no proxy listening — so raising it just
# silences spurious stall warnings on long-gap profiles.
STALL_SEC="${STALL_SEC:-720}"          # 12 min: L0/L1 default (max gap ~5 min + slack)
HARD_MAX_SEC="${HARD_MAX_SEC:-5700}"   # ~95 min backstop (run capped at 75 min by --max-sec)

cnt() { [ -f "$1" ] && wc -l < "$1" 2>/dev/null | tr -d ' ' || echo 0; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

start=$(date +%s); last_change=$start
# Stall is tracked on the SHADOW (A0) line count: A0 is passthrough with
# keep-alive OFF, so every line is a REAL turn. The PRIMARY (A5) log also grows
# from keep-alive pings during idle gaps, which would mask a stalled
# conversation — so it must NOT drive stall detection.
alive=0; prev_err=0; prev_real=-1; stalled=0
while :; do
  now=$(date +%s)
  a0=$(cnt "$OUT/instance.A0.ndjson"); a5=$(cnt "$OUT/instance.A5.ndjson")
  total=$((a0 + a5))

  # new error lines since last poll (errcount = the regression-tested pipeline)
  errs=0
  for f in "$OUT"/proxy.primary.log "$OUT"/proxy.shadow.log "$OUT"/tee.log; do
    n=$(errcount "$f")
    errs=$((errs + ${n:-0}))
  done
  if [ "$errs" -gt "$prev_err" ]; then
    line=$(grep -E -h "$ERRRE" "$OUT"/proxy.*.log "$OUT"/tee.log 2>/dev/null | grep -vE "$IGNORE" | tail -n1)
    echo "ERROR(+$((errs - prev_err))) a0=$a0 a5=$a5 :: ${line:0:150}"
    prev_err=$errs
  fi

  if [ "$alive" -eq 0 ] && [ "$total" -gt 0 ]; then echo "ALIVE a0=$a0 a5=$a5"; alive=1; fi
  if [ "$a0" -gt "$prev_real" ]; then last_change=$now; prev_real=$a0; stalled=0; fi

  if [ -f "$OUT/report.md" ]; then echo "COMPLETE a0=$a0 a5=$a5 (+$(((now-start)/60))m)"; exit 0; fi

  if [ "$alive" -eq 1 ] && [ $((now - last_change)) -ge "$STALL_SEC" ]; then
    if listening "$LP" || listening "$PP" || listening "$SP"; then
      if [ "$stalled" -eq 0 ]; then echo "STALL no new turns ${STALL_SEC}s, proxies up a0=$a0 a5=$a5"; stalled=1; fi
    else
      echo "DEAD no new turns ${STALL_SEC}s and no proxy listening a0=$a0 a5=$a5"; exit 1
    fi
  fi

  if [ $((now - start)) -ge "$HARD_MAX_SEC" ]; then echo "WATCH-END backstop a0=$a0 a5=$a5"; exit 2; fi
  sleep 30
done
