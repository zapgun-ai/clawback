#!/usr/bin/env bash
# Run a counterbalanced A/B knob block end to end, then analyze + plot.
#
# This is the orchestrator the README's validation section points at. It
# runs one arm at a time: start a clawback proxy with the arm's knob set, drive
# N turns of load through it, stop it; repeat for the next arm; then analyze the
# shared turn-log and render the charts.
#
# Cache hygiene WITHOUT a salt (production fidelity): production
# forwards no salt, so the harness must not either — a system-prepended salt
# forced whole-body re-serialization that zeroed within-arm cache warming (the
# confound we removed). Arms are isolated three production-faithful ways instead:
#   1. clawback-side: each arm gets its OWN --state file, so no arm RESUMES a
#      prior arm's persisted SESSION KEYs.
#   2. Anthropic-side, byte-MUTATING arms: a treatment arm that mutates
#      forwarded bytes (strip, 1h-TTL, mobile) already gets a distinct ANTHROPIC
#      KEY, so it can't read a prior arm's warm entries.
#   3. Anthropic-side, byte-IDENTICAL arms (keep-alive-only vs passthrough
#      forward the same real-turn bytes, so per-arm --state does NOT change the
#      content-addressed ANTHROPIC KEY): two PRODUCTION-FAITHFUL guards, neither
#      of which deletes a turn —
#        (a) the analyzer reports cold-starts in their own "first" gap bucket, so
#            a carry-over-warmed open is never pooled into the warm-loop buckets
#            it's compared within; and
#        (b) --cooldown-sec spaces serial arms past Anthropic's 5-min cache TTL
#            so each arm's opening turn is a GENUINE cold-start (counted, exactly
#            as a production user pays it after an idle), not a fake-warm read of
#            the prior arm's cache. Set ~330 for a byte-identical-arm headline.
#      The analyzer's --warmup discard (drop each arm's first N turns) stays an
#      OPT-IN DIAGNOSTIC for back-to-back runs done without cooldown — it is NOT
#      the default (default 0), because dropping opening turns also deletes
#      legitimate production cold-start cost. The standing posture COUNTS them.
#
# Two load drivers (same proxy, same hygiene):
#   --driver pty     real `claude` via the PTY channel (faithful arm, .skills/
#                    drive). Spends real Anthropic tokens. Pin --model.
#   --driver replay  HTTP fixture replay (clean arm, .skills/replay). Needs
#                    a CLAWBACK_OAUTH_TOKEN bearer (never an API key) and a
#                    fixture from .skills/capture.
#
# The default block is A0 (passthrough baseline) vs A5 (recommended stack).
# Each arm gets its own turn-log, labeled into the analyzer as knobProfile
# <arm>. The analyzer pools all passthrough turns into the per-bucket baseline
# and compares each treatment knobProfile against it — so a block MUST include
# A0 for a savings %, and MAY include several treatment arms at once (e.g.
# --arms "A0 A2 A5"), each measured against the shared A0 baseline.
#
# Arms:
#   A0  passthrough baseline (forces all knobs off)
#   A1  keep-alive only
#   A2  1h-TTL only (nested-cache-control rewrite on — the moat)
#   A3  1h-TTL + keep-alive
#   A4  strip-ephemeral only
#   A5  recommended stack (keep-alive + 1h-TTL + strip-ephemeral)
#
# Options:
#   --profile L0|L1|L2|L3|L4   inter-turn gap regime (default L0)
#   --gap-sec N                fixed inter-turn gap in seconds; overrides
#                              --profile's jittered range (both drivers).
#                              Use for a precise idle, e.g. the 15-min
#                              keep-alive warmth test.
#   --max-sec N                cap EACH arm by wall clock (e.g. 4500 = 75 min);
#                              the deadline governs and --turns becomes an upper
#                              safety bound. Drives a "run for N minutes" load
#                              (pty driver only). Per-arm, so serial doubles it.
#   --turns N                  turns per arm (default 8; >=200 for headline).
#                              With --max-sec, an upper safety bound only.
#   --arms "A0 A5"             space-separated arm list (default "A0 A5")
#   --driver pty|replay        load driver (default pty)
#   --model ID                 pin the model (both drivers); pty -> claude,
#                              replay -> overrides the fixture's body.model
#   --effort LEVEL             pin claude's reasoning level (low|medium|high|
#                              xhigh|max), pty driver only. Effort resizes the
#                              thinking blocks that ride in each turn (and get
#                              cached), so it shifts the cache economics. Jagged
#                              availability: Haiku has none; xhigh is Opus
#                              4.7/4.8 only. One effort per invocation — for a
#                              model x effort matrix, run one block per cell.
#   --fixture PATH             replay fixture (default benchmark/fixtures/ccode.json)
#   --prompts PATH             pty prompt file (default benchmark/prompts/coding.txt)
#   --settle-sec N             pty quiescence threshold (default 8)
#   --confirm-sec N            pty submit-confirmation window (default: driver's
#                              own, 6). Bump for slower models (e.g. Opus).
#   --host HOST                proxy bind host (default 127.0.0.1)
#   --port PORT                base proxy port (default 8787). Serial: every arm
#                              reuses it. Concurrent: arm k binds PORT+k.
#   --concurrent               run all arms AT ONCE (distinct port + pid-file
#                              per arm) to cut wall-clock. Default is serial.
#   --warmup N                 OPT-IN DIAGNOSTIC: drop the first N turns of each
#                              arm's timeline in the analyzer (default 0 — keep
#                              every turn). Dropping opening turns also deletes
#                              legitimate production cold-start cost, so this is
#                              NOT the default; prefer --cooldown-sec to isolate
#                              byte-identical arms while still COUNTING cold opens.
#                              Use only to sanity-check a back-to-back run done
#                              without cooldown.
#   --cooldown-sec N           sleep N seconds BETWEEN serial arms so a prior
#                              arm's warm Anthropic cache expires and the next
#                              arm's opening turn is a GENUINE cold-start, not a
#                              fake-warm carry-over read (default 0). Set ~330 for
#                              a byte-identical-arm headline run; ignored with
#                              --concurrent. This is the production-faithful way
#                              to isolate byte-identical serial arms.
#   --out DIR                  output dir (default runs/ab-<timestamp>)
#   --no-plot                  skip chart rendering
#   --card                     also bake charts/share_card.{svg,png} (best-effort)
#   -h, --help                 show this help
#
# COST: --driver pty spends real Anthropic tokens against your own limits
# (one full run per arm). Keep --turns small and pin --model for control.
#
# SERIAL vs --concurrent: serial is the default because concurrent arms share
# ONE Anthropic account quota — they can rate-limit each other and confound the
# per-arm $/turn comparison. Use serial for headline numbers;
# use --concurrent for harness smokes and when you accept the cross-talk to
# save time. Each arm is still SESSION-KEY-isolated by its own --state file
# either way; see the cache-hygiene note in the header for Anthropic-side
# carry-over.

set -euo pipefail

# Owner-only perms: the turn-log and proxy logs can carry usage detail.
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

PROFILE="L0"
GAP_SEC=""
MAX_SEC=""
TURNS=8
ARMS="A0 A5"
DRIVER="pty"
MODEL=""
EFFORT=""
FIXTURE="benchmark/fixtures/ccode.json"
PROMPTS="benchmark/prompts/coding.txt"
SETTLE="8"
CONFIRM_SEC=""
HOST="127.0.0.1"
PORT="8787"
CONCURRENT=0
WARMUP=0
COOLDOWN_SEC=0
RUNID="$(date +%Y%m%d-%H%M%S)"
OUT=""
NO_PLOT=0
CARD=0

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)    PROFILE="${2:?--profile needs a value}"; shift ;;
    --gap-sec)    GAP_SEC="${2:?--gap-sec needs a value}"; shift ;;
    --max-sec)    MAX_SEC="${2:?--max-sec needs a value}"; shift ;;
    --turns)      TURNS="${2:?--turns needs a value}"; shift ;;
    --arms)       ARMS="${2:?--arms needs a value}"; shift ;;
    --driver)     DRIVER="${2:?--driver needs pty|replay}"; shift ;;
    --model)      MODEL="${2:?--model needs a value}"; shift ;;
    --effort)     EFFORT="${2:?--effort needs a value}"; shift ;;
    --fixture)    FIXTURE="${2:?--fixture needs a path}"; shift ;;
    --prompts)    PROMPTS="${2:?--prompts needs a path}"; shift ;;
    --settle-sec) SETTLE="${2:?--settle-sec needs a value}"; shift ;;
    --confirm-sec) CONFIRM_SEC="${2:?--confirm-sec needs a value}"; shift ;;
    --host)       HOST="${2:?--host needs a value}"; shift ;;
    --port)       PORT="${2:?--port needs a value}"; shift ;;
    --concurrent) CONCURRENT=1 ;;
    --warmup)     WARMUP="${2:?--warmup needs a value}"; shift ;;
    --cooldown-sec) COOLDOWN_SEC="${2:?--cooldown-sec needs a value}"; shift ;;
    --out)        OUT="${2:?--out needs a path}"; shift ;;
    --no-plot)    NO_PLOT=1 ;;
    --card)       CARD=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "ab_block: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# --max-sec: the wall-clock deadline governs; --turns is only an upper safety
# bound. Raise that bound (if the caller left it low) so a long timed run is
# never cut short by the default turn count. Assume >=5s/turn — real claude
# turns are far slower (network + model latency alone exceeds that) — so
# ceil(MAX_SEC/5) is a ceiling the deadline will always hit first. Only the pty
# driver honors --max-sec; replay has no deadline, so warn it's ignored there.
if [[ -n "$MAX_SEC" ]]; then
  if [[ "$DRIVER" == "pty" ]]; then
    bound=$(( (MAX_SEC + 4) / 5 ))
    [[ "$TURNS" -lt "$bound" ]] && TURNS="$bound"
  else
    echo "ab_block: --max-sec is pty-only; ignored for --driver $DRIVER (uses --turns)." >&2
    MAX_SEC=""
  fi
fi

OUT="${OUT:-runs/ab-$RUNID}"
mkdir -p "$OUT" data
PID_FILE="data/ab.run.pid"
# One turn-log per arm so the analyzer can label each by knobProfile (--label
# arm=path). The passthrough arm pools into the baseline; each treatment arm
# is compared against it per gap bucket (analyze.js savings logic).
declare -a LABELS=()

# Map an arm name to its proxy knob flags. Set explicitly (not relying on
# DEFAULTS) so the arm is the arm regardless of the operator's global config.
declare -a KNOBS
set_arm_knobs() {
  case "$1" in
    A0) KNOBS=(--passthrough) ;;
    A1) KNOBS=(--keep-alive true --inject-extended-cache-ttl false
              --strip-ephemeral-from-system false) ;;
    A2) KNOBS=(--inject-extended-cache-ttl true --rewrite-nested-cache-control true
              --keep-alive false --strip-ephemeral-from-system false) ;;
    A3) KNOBS=(--inject-extended-cache-ttl true --rewrite-nested-cache-control true
              --keep-alive true --strip-ephemeral-from-system false) ;;
    A4) KNOBS=(--strip-ephemeral-from-system true --inject-extended-cache-ttl false
              --keep-alive false) ;;
    A5) KNOBS=(--inject-extended-cache-ttl true --rewrite-nested-cache-control true
              --strip-ephemeral-from-system true --keep-alive true) ;;
    *) echo "ab_block: unknown arm '$1' (expected A0..A5)" >&2; exit 2 ;;
  esac
}

# Validate arms up front so a typo fails before we spend a token.
for arm in $ARMS; do set_arm_knobs "$arm"; done

# Per-driver pre-flight: fail loudly BEFORE the proxy starts / tokens spend.
if [[ "$DRIVER" == "pty" ]]; then
  command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1 || {
    echo "ab_block: 'claude' not on PATH (pty driver). Install the Claude Code CLI." >&2; exit 1; }
  node -e 'import("node-pty").then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null || {
    echo "ab_block: node-pty not installed (pty driver). Run: npm i node-pty" >&2; exit 1; }
  echo "ab_block: pty driver spends REAL Anthropic tokens (one run per arm)." >&2
  [[ -n "$MODEL" ]] && echo "ab_block: pinning model=$MODEL" >&2
  [[ -n "$EFFORT" ]] && echo "ab_block: pinning effort=$EFFORT (ignored by models without effort control, e.g. Haiku)" >&2
elif [[ "$DRIVER" == "replay" ]]; then
  [[ -n "$EFFORT" ]] && echo "ab_block: --effort is pty-only; ignored for --driver replay (fixture body is fixed)." >&2
  [[ -n "${CLAWBACK_OAUTH_TOKEN:-}" ]] || {
    echo "ab_block: CLAWBACK_OAUTH_TOKEN unset (replay forwards it as an OAuth bearer, never an API key)." >&2; exit 1; }
  [[ -s "$FIXTURE" ]] || {
    echo "ab_block: fixture '$FIXTURE' missing. Capture one with .skills/capture." >&2; exit 1; }
  node benchmark/bin/verify_fixture.js "$FIXTURE"
else
  echo "ab_block: --driver must be 'pty' or 'replay' (got '$DRIVER')" >&2; exit 2
fi

# Stop every proxy this run may have started — the serial pid-file AND any
# per-arm pid-files from --concurrent. Defensive glob: skip the literal pattern
# when nothing matches.
cleanup() {
  local pf
  for pf in "$PID_FILE" data/ab.*.pid; do
    [[ -e "$pf" ]] || continue
    .skills/scripts/run_monitor.sh --stop --pid-file "$pf" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Pre-seed an arm's --state with ONE inert session so the store is non-empty
# at boot. Why this matters: a fresh proxy with an empty store auto-arms a
# baseline capture (src/index.js:151 `if (!resumed)`) that forces the first
# ~5 real /v1/messages turns to PASSTHROUGH before flipping the arm's knobs
# on. On a treatment arm that silently contaminates the opening turns — the
# exact ones we most want measured. A non-empty store makes `resumed > 0`, so
# capture never arms and the arm runs its configured knobs from turn 1.
#
# The seed is engineered to be completely inert and to survive boot untouched:
#   - mode:"path"      → the §9 strip-ephemeral migration skips it without
#                        rehashing (src/migrate.js:33), so it survives even on
#                        arms with strip-ephemeral on (A4/A5).
#   - authStale:true   → keep-alive refuses to schedule it (src/keepalive.js:101),
#                        so it fires no pings, no upstream calls, spends no
#                        tokens, and writes no treatment-ping records.
#   - lastActivity NOW → idleMs≈0 beats every _shouldExpire idle rule
#                        (src/keepalive.js:306), so the boot gc sweep that runs
#                        inside scheduler.start() can't reap it before
#                        `resumed` is counted.
# The analyzer reads only the turn-log NDJSON, never this state file, so the
# seed never appears in any arm's results.
seed_state() {
  local path="$1"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$path" <<JSON
{
  "version": 1,
  "sessions": {
    "ab-seed-inert": {
      "key": "ab-seed-inert",
      "mode": "path",
      "authStale": true,
      "createdAt": "$now",
      "lastActivity": "$now"
    }
  }
}
JSON
}

run_arm() {
  local arm="$1"
  local port="$2"
  local pidfile="$3"
  set_arm_knobs "$arm"
  local armlog="$OUT/proxy.$arm.log"
  local turnlog="$OUT/turns.$arm.ndjson"
  : > "$turnlog"
  echo
  echo "ab_block: === arm $arm (port=$port) ${KNOBS[*]} ==="
  # 0. pre-seed the store so the fresh-proxy baseline-capture never arms and
  #    the arm runs its configured knobs from turn 1 (see seed_state above).
  seed_state "$OUT/state.$arm.json"
  # 1. start the arm's proxy (fresh per-arm log so wait_ready can't match a
  #    stale 'listening' line from the previous arm). Each arm gets its OWN
  #    --state file so the proxy never RESUMES the prior arm's persisted
  #    SESSION KEYs (the clawback-side carry-over path). Anthropic-side
  #    carry-over is handled per the header's cache-hygiene note, NOT by mutating forwarded bytes.
  .skills/scripts/run_monitor.sh --detach --log-file "$armlog" --pid-file "$pidfile" -- \
    --host "$HOST" --port "$port" --turn-log "$turnlog" \
    --state "$OUT/state.$arm.json" "${KNOBS[@]}"
  # 2. drive N turns through it. --gap-sec (when set) overrides the profile's
  #    jittered range in both drivers, for a precise idle.
  local gapargs=()
  [[ -n "$GAP_SEC" ]] && gapargs=(--gap-sec "$GAP_SEC")
  # --model pins the model for BOTH drivers: pty forwards it to claude, replay
  # overwrites the fixture's body.model. Without this, a replay arm silently
  # runs whatever model the fixture was captured with.
  local margs=()
  [[ -n "$MODEL" ]] && margs=(--model "$MODEL")
  # --effort is pty-only (replay's fixture body is fixed); thread it to claude.
  local effargs=()
  [[ -n "$EFFORT" ]] && effargs=(--effort "$EFFORT")
  if [[ "$DRIVER" == "pty" ]]; then
    # --turn-log lets the driver CONFIRM each submit against the SAME file the
    # proxy writes (a new non-ping record == the turn landed), so a swallowed
    # Enter is retried instead of silently under-driving the arm.
    local cfargs=()
    [[ -n "$CONFIRM_SEC" ]] && cfargs=(--confirm-sec "$CONFIRM_SEC")
    local maxargs=()
    [[ -n "$MAX_SEC" ]] && maxargs=(--max-sec "$MAX_SEC")
    node benchmark/bin/drive_pty.js --profile "$PROFILE" --turns "$TURNS" \
      --host "$HOST" --port "$port" --prompts "$PROMPTS" --settle-sec "$SETTLE" \
      --turn-log "$turnlog" --cwd "$PROJECT_DIR" \
      ${cfargs[@]+"${cfargs[@]}"} ${gapargs[@]+"${gapargs[@]}"} ${maxargs[@]+"${maxargs[@]}"} ${margs[@]+"${margs[@]}"} ${effargs[@]+"${effargs[@]}"}
  else
    node benchmark/bin/replay.js --profile "$PROFILE" --turns "$TURNS" \
      --host "$HOST" --port "$port" --fixture "$FIXTURE" \
      --session-id "${arm}-${RUNID}" ${gapargs[@]+"${gapargs[@]}"} ${margs[@]+"${margs[@]}"}
  fi
  # 3. stop the arm's proxy and let the port free before the next arm binds.
  .skills/scripts/run_monitor.sh --stop --pid-file "$pidfile" >/dev/null 2>&1 || true
  sleep 1
}

# Label map for the analyzer is fixed by the arm list (each arm -> its own
# turn-log), independent of run order, so build it once up front. This keeps
# the concurrent path from racing on a shared LABELS array.
for arm in $ARMS; do LABELS+=(--label "$arm=$OUT/turns.$arm.ndjson"); done

if [[ "$CONCURRENT" -eq 1 ]]; then
  # All arms at once: distinct port (PORT+k) and pid-file per arm. Warn about
  # the shared-quota cross-talk so a headline run isn't done this way by accident.
  narms=0; for arm in $ARMS; do narms=$((narms + 1)); done
  echo "ab_block: --concurrent: launching $narms arm(s) in parallel (shared Anthropic quota — arms may rate-limit each other; not for headline numbers)." >&2
  declare -a RUN_PIDS=()
  k=0
  for arm in $ARMS; do
    run_arm "$arm" "$((PORT + k))" "data/ab.$arm.pid" &
    RUN_PIDS+=("$!")
    k=$((k + 1))
  done
  # Wait for every arm; remember if any failed but let the others finish.
  run_fail=0
  for p in "${RUN_PIDS[@]}"; do wait "$p" || run_fail=1; done
  [[ "$run_fail" -eq 0 ]] || echo "ab_block: at least one arm exited non-zero — check $OUT/proxy.*.log" >&2
else
  # Serial: run each arm in turn, optionally spacing them by --cooldown-sec so a
  # prior arm's warm Anthropic cache expires before the next byte-identical arm
  # starts (cache-hygiene note, leg 3). No cooldown after the LAST arm — there is
  # no following arm to isolate it from.
  nremaining=0; for arm in $ARMS; do nremaining=$((nremaining + 1)); done
  for arm in $ARMS; do
    run_arm "$arm" "$PORT" "$PID_FILE"
    nremaining=$((nremaining - 1))
    if [[ "$COOLDOWN_SEC" -gt 0 && "$nremaining" -gt 0 ]]; then
      echo "ab_block: cooldown ${COOLDOWN_SEC}s before next arm (cache-TTL spacing)…" >&2
      sleep "$COOLDOWN_SEC"
    fi
  done
fi

# At least one arm must have produced turns, else there is nothing to analyze.
collected=0
for arm in $ARMS; do [[ -s "$OUT/turns.$arm.ndjson" ]] && collected=1; done
if [[ "$collected" -eq 0 ]]; then
  echo "ab_block: all per-arm turn-logs are empty — no /v1/messages turns were seen." >&2
  echo "          Check $OUT/proxy.*.log; ensure the driver actually drove turns." >&2
  exit 1
fi

echo
echo "ab_block: analyzing -> $OUT (--warmup $WARMUP)"
node benchmark/bin/analyze.js --out "$OUT" --warmup "$WARMUP" "${LABELS[@]}"
if [[ "$NO_PLOT" -eq 0 ]]; then
  node benchmark/bin/plot.js --in "$OUT" --out "$OUT/charts" || \
    echo "ab_block: plot step failed (report still written)." >&2
fi
# Opt-in social card. Best-effort: preview_card.sh walks Chrome -> sips -> SVG
# only, so a missing rasterizer leaves the SVG and skips the PNG, never fails.
if [[ "$CARD" -eq 1 ]]; then
  if ! .skills/scripts/preview_card.sh "$OUT" >/dev/null; then
    echo "ab_block: card compose failed (report still written)." >&2
  elif [[ -f "$OUT/charts/share_card.png" ]]; then
    echo "ab_block: baked $OUT/charts/share_card.png"
  else
    echo "ab_block: composed $OUT/charts/share_card.svg (no rasterizer, PNG skipped)."
  fi
fi

echo
echo "ab_block: wrote $OUT/{report.md,report.csv,summary.json,manifest.json,charts/}"
echo "ab_block: read the headline with: sed -n '1,40p' $OUT/report.md"
