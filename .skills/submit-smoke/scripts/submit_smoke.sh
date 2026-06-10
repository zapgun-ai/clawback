#!/usr/bin/env bash
# Validate the PTY turn-submission mechanism end to end — cheaply, before any
# timed/headline run spends real tokens on the wrong thing.
#
# WHAT THIS PROVES (and why it exists)
# ------------------------------------
# The driver used to submit a turn with `pty.write(`${prompt}\r`)` — prompt
# text and the Enter CR in ONE write. Claude Code boots bracketed-paste +
# the enhanced keyboard protocol, so that bulk write gets coalesced through
# the paste path and the trailing \r lands as a NEWLINE inside the input box
# instead of submitting. Empirically ~6 of 8 turns silently never ran. The
# fix (benchmark/lib/turn_submit.js) types the text, pauses, then sends Enter
# as its OWN keystroke and CONFIRMS the turn landed against the proxy's
# --turn-log before moving on, escalating \r -> \n -> \r\n only if confirmation
# never arrives.
#
# This script runs that mechanism on a tiny passthrough Haiku block and checks
# the two signals that matter:
#   1. the driver's own "confirmed N/M turn(s)" tally, and
#   2. the count of REAL (non-ping) records the proxy actually logged.
# PASS = every turn confirmed AND at least that many real turn-log records.
# It also reports WHICH Enter encoding won — pure \r means CR-as-its-own-
# keystroke submits once separated from the text; a fallback winning is itself
# a finding worth knowing before the big run.
#
# It is deliberately leaner than .skills/ab/scripts/ab_block.sh: ONE passthrough arm, no
# state seed, no analyze/plot. The only question here is "does Enter land?" —
# isolate it.
#
# Options:
#   --turns N         turns to drive (default 3)
#   --model ID        claude model (default claude-haiku-4-5-20251001 — cheap)
#   --gap-sec N       idle between turns in seconds (default 10)
#   --confirm-sec N   per-Enter confirmation window (default 6; bump for Opus)
#   --settle-sec N    PTY quiescence = turn done (default 8)
#   --prompts PATH    one prompt per line (default benchmark/prompts/coding.txt)
#   --host HOST       proxy bind host (default 127.0.0.1)
#   --port PORT       proxy port (default 8799 — avoids a dev proxy on 8787)
#   --out DIR         output dir (default runs/submit-smoke-<timestamp>)
#   -h, --help        show this help
#
# COST: spends real Anthropic tokens for N turns via the real `claude` binary.
# Keep --turns tiny and the model on Haiku; this is plumbing, not a headline.

set -euo pipefail

# Owner-only perms: the turn-log, proxy log, and state file can carry usage
# detail and the captured system prompt — same 0600 posture as clawback.
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

TURNS=3
MODEL="claude-haiku-4-5-20251001"
GAP_SEC=10
CONFIRM_SEC=6
SETTLE=8
PROMPTS="benchmark/prompts/coding.txt"
HOST="127.0.0.1"
PORT=8799
RUNID="$(date +%Y%m%d-%H%M%S)"
OUT=""

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --turns)       TURNS="${2:?--turns needs a value}"; shift ;;
    --model)       MODEL="${2:?--model needs a value}"; shift ;;
    --gap-sec)     GAP_SEC="${2:?--gap-sec needs a value}"; shift ;;
    --confirm-sec) CONFIRM_SEC="${2:?--confirm-sec needs a value}"; shift ;;
    --settle-sec)  SETTLE="${2:?--settle-sec needs a value}"; shift ;;
    --prompts)     PROMPTS="${2:?--prompts needs a path}"; shift ;;
    --host)        HOST="${2:?--host needs a value}"; shift ;;
    --port)        PORT="${2:?--port needs a value}"; shift ;;
    --out)         OUT="${2:?--out needs a path}"; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "submit_smoke: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

OUT="${OUT:-runs/submit-smoke-$RUNID}"
mkdir -p "$OUT"
TURNLOG="$OUT/turns.ndjson"
PROXY_LOG="$OUT/proxy.log"
PID_FILE="$OUT/proxy.pid"
DRIVE_LOG="$OUT/drive.log"
STATE="$OUT/state.json"
: > "$TURNLOG"

# Pre-flight: fail loudly BEFORE the proxy starts / tokens spend.
command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1 || {
  echo "submit_smoke: 'claude' not on PATH. Install the Claude Code CLI." >&2; exit 1; }
node -e 'import("node-pty").then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null || {
  echo "submit_smoke: node-pty not installed. Run: npm i node-pty" >&2; exit 1; }
[[ -s "$PROMPTS" ]] || { echo "submit_smoke: prompts file '$PROMPTS' missing/empty." >&2; exit 1; }

echo "submit_smoke: passthrough Haiku submit-mechanism smoke"
echo "  turns=$TURNS model=$MODEL gap=${GAP_SEC}s confirm=${CONFIRM_SEC}s port=$PORT"
echo "  out=$OUT"
echo "submit_smoke: spends real Anthropic tokens for $TURNS turn(s)." >&2

# Stop the proxy on any exit so a failed smoke never leaks a live proxy.
cleanup() { .skills/scripts/run_monitor.sh --stop --pid-file "$PID_FILE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. Start a PASSTHROUGH proxy on its own port + its own state file (so it
#    never resumes a dev proxy's persisted sessions). Passthrough forces all
#    knobs off, so every turn-log record is a REAL turn (no keep-alive pings)
#    — the non-ping count is therefore an exact turn counter here.
.skills/scripts/run_monitor.sh --detach --log-file "$PROXY_LOG" --pid-file "$PID_FILE" -- \
  --host "$HOST" --port "$PORT" --turn-log "$TURNLOG" --state "$STATE" --passthrough

# 2. Drive the turns through the real claude binary, confirming each submit
#    against the SAME turn-log the proxy writes. tee so we can both watch it
#    live and parse the tally afterward.
set +e
node benchmark/bin/drive_pty.js --turns "$TURNS" \
  --host "$HOST" --port "$PORT" --prompts "$PROMPTS" \
  --gap-sec "$GAP_SEC" --model "$MODEL" --settle-sec "$SETTLE" \
  --confirm-sec "$CONFIRM_SEC" --turn-log "$TURNLOG" --cwd "$PROJECT_DIR" \
  2>&1 | tee "$DRIVE_LOG"
drive_rc="${PIPESTATUS[0]}"
set -e

# 3. Stop the proxy now so its final records are flushed before we count.
.skills/scripts/run_monitor.sh --stop --pid-file "$PID_FILE" >/dev/null 2>&1 || true

# 4. Verdict. Two independent signals must agree:
#    (a) the driver confirmed every turn it tried, and
#    (b) the proxy logged at least that many REAL (non-ping) turns.
real_records="$(node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  let real = 0;
  for (const l of lines) {
    try { const r = JSON.parse(l); if (!String(r.arm ?? "").includes("ping")) real++; }
    catch {}
  }
  process.stdout.write(String(real));
' "$TURNLOG" 2>/dev/null || echo 0)"

confirmed_line="$(grep -oE 'confirmed [0-9]+/[0-9]+ turn' "$DRIVE_LOG" | tail -1 || true)"
confirmed_n="$(printf '%s' "$confirmed_line" | grep -oE '[0-9]+' | head -1 || echo 0)"
: "${confirmed_n:=0}"

echo
echo "submit_smoke: ===== verdict ====="
echo "  driver said:        ${confirmed_line:-<none>}"
echo "  real turn-log recs: $real_records (non-ping /v1/messages records)"
echo "  Enter encodings that won (per turn):"
grep -oE 'submitted via "[^"]*"' "$DRIVE_LOG" | sort | uniq -c | sed 's/^/    /' || echo "    <none — no turn confirmed>"
if grep -q 'UNCONFIRMED' "$DRIVE_LOG"; then
  echo "  WARNING: at least one turn went UNCONFIRMED:"
  grep 'UNCONFIRMED' "$DRIVE_LOG" | sed 's/^/    /'
fi

echo
if [[ "$drive_rc" -eq 0 && "$confirmed_n" -ge "$TURNS" && "$real_records" -ge "$TURNS" ]]; then
  echo "submit_smoke: PASS — all $TURNS turn(s) submitted and confirmed by the proxy."
  echo "  full driver log: $DRIVE_LOG"
  exit 0
fi
echo "submit_smoke: FAIL — submission mechanism did not cleanly land all turns." >&2
echo "  drive_rc=$drive_rc confirmed=$confirmed_n/$TURNS real_records=$real_records" >&2
echo "  inspect: $DRIVE_LOG  and  $PROXY_LOG" >&2
exit 1
