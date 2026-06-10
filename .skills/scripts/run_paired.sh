#!/usr/bin/env bash
# Paired shadow-capture: one claude session, baseline AND armed knobs at once.
#
# This is the "shadow mode" knob for the benchmark's baseline capture. A normal
# baseline capture (clawback NOT enabled / passthrough) measures what you'd pay
# without clawback — but it forfeits the optimizations for the whole window. In
# shadow mode you keep BOTH: one real `claude` session is fanned by the tee to
# two unmodified clawback instances —
#
#   claude ──▶ tee ──┬─▶ clawback PRIMARY (armed, default A5) ─▶ Anthropic  (streamed back to claude)
#                    └─▶ clawback SHADOW  (A0 passthrough)     ─▶ Anthropic  (consumed for usage, discarded)
#
# — so the SHADOW arm captures the no-clawback baseline while the PRIMARY arm
# applies (and serves claude) the armed knobs. Because both arms bill the SAME
# request bytes under the same turn, the analyzer pairs them turn-for-turn
# (analyze.js pairBillableByPairSeq / bootstrapPairedDiff) for a tight,
# turn-matched reclaim CI — not two free-running sessions that diverge.
#
# COST: shadow mode bills your Anthropic quota ~2x for the run (every turn goes
# to both arms). That is the price of an exact paired measurement. This script
# REFUSES to run without --ack-2x (the explicit opt-in switch), and forwards it
# to the tee so the tee won't re-prompt.
#
# What never crosses the wire: the tee adds no header/query/body field; it
# forwards claude's OAuth bearer verbatim to both instances. The instances are
# byte-for-byte unmodified clawback — this is a test OF clawback, not a fork.
#
# Options:
#   --primary-arm A1..A5     armed stack the PRIMARY applies (default A5)
#   --profile L0|L1|L2|L3|L4 inter-turn gap regime (default L0)
#   --gap-sec N              fixed inter-turn gap (overrides --profile range)
#   --max-sec N              cap the run by wall clock (e.g. 4500 = 75 min);
#                            --turns becomes an upper safety bound
#   --turns N                turns to drive (default 8; >=200 for headline)
#   --model ID               pin the model (forwarded to claude)
#   --effort LEVEL           pin claude's reasoning level (low|medium|high|xhigh|
#                            max). Resizes the thinking blocks that ride in each
#                            turn and get cached, so it shifts cache economics.
#                            Haiku has no effort control; xhigh is Opus 4.7/4.8.
#   --prompts PATH           pty prompt file (default benchmark/prompts/coding.txt)
#   --settle-sec N           pty quiescence threshold (default 8)
#   --max-turn-sec N         per-turn ceiling before the driver gives up waiting
#                            for quiescence and starts the gap (default 180).
#                            Raise for high-effort/slow models whose turns can
#                            run minutes, so the idle gap never starts mid-turn.
#   --confirm-sec N          pty submit-confirmation window (default driver's 6;
#                            bump for slower models, e.g. Opus)
#   --pty-keepalive-sec N    drive a PTY keep-alive ping every N seconds of
#                            inter-turn idle (refreshes claude's OAuth bearer +
#                            re-warms the exact cache key on the live session).
#                            Wired to the tee so the ping is routed primary-only
#                            (never billed/shadowed/paired). Off if unset.
#   --keepalive-token TOK    payload for the keep-alive ping (default 🔥); must
#                            match between driver and tee (this script keeps them
#                            in sync automatically)
#   --host HOST              bind host for the tee + both proxies (default 127.0.0.1)
#   --listen-port PORT       tee listen port; point claude here (default 8788)
#   --primary-port PORT      PRIMARY clawback port (default 8790)
#   --shadow-port PORT       SHADOW  clawback port (default 8791)
#   --out DIR                output dir (default runs/paired-<timestamp>)
#   --ack-2x                 acknowledge the ~2x token cost (REQUIRED to run)
#   --no-plot                skip chart rendering
#   --card                   also bake charts/share_card.{svg,png} (best-effort)
#   -h, --help               show this help

set -euo pipefail

# Owner-only perms: turn-logs / proxy logs can carry usage + auth detail.
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"

PRIMARY_ARM="A5"
PROFILE="L0"
GAP_SEC=""
MAX_SEC=""
TURNS=8
MODEL=""
EFFORT=""
PROMPTS="benchmark/prompts/coding.txt"
SETTLE="8"
MAX_TURN_SEC=""
CONFIRM_SEC=""
PTY_KEEPALIVE_SEC=""
KEEPALIVE_TOKEN="🔥"
HOST="127.0.0.1"
LISTEN_PORT="8788"
PRIMARY_PORT="8790"
SHADOW_PORT="8791"
RUNID="$(date +%Y%m%d-%H%M%S)"
OUT=""
ACK_2X=0
NO_PLOT=0
CARD=0

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-arm) PRIMARY_ARM="${2:?--primary-arm needs a value}"; shift ;;
    --profile)     PROFILE="${2:?--profile needs a value}"; shift ;;
    --gap-sec)     GAP_SEC="${2:?--gap-sec needs a value}"; shift ;;
    --max-sec)     MAX_SEC="${2:?--max-sec needs a value}"; shift ;;
    --turns)       TURNS="${2:?--turns needs a value}"; shift ;;
    --model)       MODEL="${2:?--model needs a value}"; shift ;;
    --effort)      EFFORT="${2:?--effort needs a value}"; shift ;;
    --prompts)     PROMPTS="${2:?--prompts needs a path}"; shift ;;
    --settle-sec)  SETTLE="${2:?--settle-sec needs a value}"; shift ;;
    --max-turn-sec) MAX_TURN_SEC="${2:?--max-turn-sec needs a value}"; shift ;;
    --confirm-sec) CONFIRM_SEC="${2:?--confirm-sec needs a value}"; shift ;;
    --pty-keepalive-sec) PTY_KEEPALIVE_SEC="${2:?--pty-keepalive-sec needs a value}"; shift ;;
    --keepalive-token) KEEPALIVE_TOKEN="${2:?--keepalive-token needs a value}"; shift ;;
    --host)        HOST="${2:?--host needs a value}"; shift ;;
    --listen-port) LISTEN_PORT="${2:?--listen-port needs a value}"; shift ;;
    --primary-port) PRIMARY_PORT="${2:?--primary-port needs a value}"; shift ;;
    --shadow-port) SHADOW_PORT="${2:?--shadow-port needs a value}"; shift ;;
    --out)         OUT="${2:?--out needs a path}"; shift ;;
    --ack-2x)      ACK_2X=1 ;;
    --no-plot)     NO_PLOT=1 ;;
    --card)        CARD=1 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "run_paired: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# --max-sec: the wall-clock deadline governs; raise the --turns safety bound so
# a long timed run is never cut short (assume >=5s/turn — real claude turns are
# far slower). Mirrors ab_block.sh.
if [[ -n "$MAX_SEC" ]]; then
  bound=$(( (MAX_SEC + 4) / 5 ))
  [[ "$TURNS" -lt "$bound" ]] && TURNS="$bound"
fi

# The ~2x-cost guard. Shadow mode doubles spend by construction, so running this
# script is a deliberate act: refuse without --ack-2x and show the warning.
if [[ "$ACK_2X" -ne 1 ]]; then
  cat >&2 <<'WARN'
+====================================================================+
|  WARNING: paired shadow capture burns Anthropic tokens ~2x AS FAST |
|                                                                    |
|  Every turn of this run is sent to BOTH arms (primary + shadow),   |
|  so it bills against your quota TWICE for the duration -- the      |
|  price of an exact turn-matched A/B baseline.                      |
+====================================================================+
WARN
  echo "run_paired: refusing to start without --ack-2x (acknowledge the 2x cost)." >&2
  exit 2
fi

OUT="${OUT:-runs/paired-$RUNID}"
mkdir -p "$OUT" data

# Map an arm name to its proxy knob flags (mirrors ab_block.sh). A0 is the
# passthrough baseline; A1..A5 are the armed stacks. Set explicitly so the arm
# is the arm regardless of the operator's global config.
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
    *) echo "run_paired: unknown arm '$1' (expected A0..A5)" >&2; exit 2 ;;
  esac
}
[[ "$PRIMARY_ARM" == "A0" ]] && {
  echo "run_paired: --primary-arm A0 is meaningless (both arms passthrough); pick A1..A5." >&2; exit 2; }
set_arm_knobs "$PRIMARY_ARM"   # validate up front, before a token is spent
declare -a PRIMARY_KNOBS=("${KNOBS[@]}")

# Pre-flight (mirrors ab_block.sh): fail loudly BEFORE proxies start / tokens
# spend. This driver is always pty (real claude); it spends real tokens.
command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1 || {
  echo "run_paired: 'claude' not on PATH. Install the Claude Code CLI." >&2; exit 1; }
node -e 'import("node-pty").then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null || {
  echo "run_paired: node-pty not installed. Run: npm i node-pty" >&2; exit 1; }
[[ -s "$PROMPTS" ]] || { echo "run_paired: prompts file '$PROMPTS' missing." >&2; exit 1; }
echo "run_paired: pty driver spends REAL Anthropic tokens — TWICE (shadow + primary)." >&2
[[ -n "$MODEL" ]] && echo "run_paired: pinning model=$MODEL" >&2
[[ -n "$EFFORT" ]] && echo "run_paired: pinning effort=$EFFORT (ignored by models without effort control, e.g. Haiku)" >&2

# Pre-seed each instance's --state with ONE inert session so a fresh proxy does
# not auto-arm a baseline capture that forces the opening ~5 turns to
# passthrough (src/index.js). For the PRIMARY (armed) arm that would silently
# contaminate the exact turns we most want measured. The seed is engineered to
# survive boot untouched and spend no tokens (verbatim from ab_block.sh):
#   - mode:"path"     skips the strip-ephemeral migration rehash (survives A4/A5)
#   - authStale:true  keep-alive refuses to schedule it (no pings, no tokens)
#   - lastActivity NOW idleMs~=0 beats every idle-expiry rule, so the boot gc
#                      sweep can't reap it before `resumed` is counted
# The analyzer reads only the turn-log NDJSON, never this state file.
seed_state() {
  local path="$1" now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$path" <<JSON
{
  "version": 1,
  "sessions": {
    "paired-seed-inert": {
      "key": "paired-seed-inert",
      "mode": "path",
      "authStale": true,
      "createdAt": "$now",
      "lastActivity": "$now"
    }
  }
}
JSON
}

PRIMARY_PID_FILE="data/paired.primary.pid"
SHADOW_PID_FILE="data/paired.shadow.pid"
PRIMARY_LOG="$OUT/proxy.primary.log"
SHADOW_LOG="$OUT/proxy.shadow.log"
TEE_LOG="$OUT/tee.log"
TEE_PID=""

# Tear down the tee and BOTH proxies on any exit. Defensive: ignore errors so a
# half-started run still cleans up what it can.
cleanup() {
  [[ -n "$TEE_PID" ]] && kill "$TEE_PID" 2>/dev/null || true
  .skills/scripts/run_monitor.sh --stop --pid-file "$PRIMARY_PID_FILE" >/dev/null 2>&1 || true
  .skills/scripts/run_monitor.sh --stop --pid-file "$SHADOW_PID_FILE"  >/dev/null 2>&1 || true
}
trap cleanup EXIT

# No salt (production fidelity): production forwards none, and a system-prepended
# salt forced whole-body re-serialization that zeroed within-arm cache warming
# (the confound removed in #65). The two arms run SIMULTANEOUSLY behind the tee
# and their forwarded bytes already differ (PRIMARY strips/rewrites, SHADOW is
# byte-transparent passthrough), so they get distinct ANTHROPIC KEYs and cannot
# warm each other's cache. Each also gets its own --state file (SESSION-KEY
# isolation).

echo
echo "run_paired: === paired shadow capture: PRIMARY=$PRIMARY_ARM vs SHADOW=A0 (baseline) ==="
echo "run_paired:   primary knobs: ${PRIMARY_KNOBS[*]} (port $PRIMARY_PORT)"
echo "run_paired:   shadow  knobs: --passthrough (port $SHADOW_PORT)"
echo "run_paired:   tee: http://$HOST:$LISTEN_PORT  (point claude here)"

# PTY keep-alive wiring: when enabled, the SAME token is handed to the tee (so it
# routes the ping primary-only) and to the driver (so it types the ping during
# idle). Keeping them in sync here means the operator can't desync them.
#
# Armed-pairing gate (--require-arm / --tee-arm) ships alongside keep-alive: the
# driver arms pairing around each real prompt and disarms it for the gap, so
# every idle-window request — the 🔥 ping AND any CC side-channel it provokes
# (auto-title-gen fires ~0.66s after a notable turn) — routes primary-only and
# can't re-warm the cold shadow. Without this, the token-match alone misses
# CC-decorated side-channels and silently invalidates a >60min cold-gap run.
teekaargs=(); drvkaargs=()
if [[ -n "$PTY_KEEPALIVE_SEC" ]]; then
  teekaargs=(--keepalive-token "$KEEPALIVE_TOKEN" --require-arm)
  drvkaargs=(--pty-keepalive-sec "$PTY_KEEPALIVE_SEC" --keepalive-token "$KEEPALIVE_TOKEN" --tee-arm)
  echo "run_paired:   pty keep-alive: '$KEEPALIVE_TOKEN' every ${PTY_KEEPALIVE_SEC}s (primary-only via tee)"
  echo "run_paired:   armed-pairing gate: driver arms around real prompts, disarms for the gap (primary-only idle)"
fi

seed_state "$OUT/state.primary.json"
seed_state "$OUT/state.shadow.json"

# Both proxies are pinned to HTTP with `--tls off`: the tee forwards over plain
# http.request, so an ambient `tls: true` in ./CLAWBACK.md or the global config
# would otherwise bring them up HTTPS and 308-redirect the tee into a failing
# self-signed handshake (claude: "Self-signed certificate detected", 0 turns).
#
# 1. start the SHADOW (A0 passthrough) clawback. Its turn-log is a cross-check;
#    the tee's A0.ndjson is the authoritative paired record.
.skills/scripts/run_monitor.sh --detach --log-file "$SHADOW_LOG" --pid-file "$SHADOW_PID_FILE" -- \
  --host "$HOST" --tls off --port "$SHADOW_PORT" --turn-log "$OUT/instance.A0.ndjson" \
  --state "$OUT/state.shadow.json" --passthrough

# 2. start the PRIMARY (armed) clawback.
.skills/scripts/run_monitor.sh --detach --log-file "$PRIMARY_LOG" --pid-file "$PRIMARY_PID_FILE" -- \
  --host "$HOST" --tls off --port "$PRIMARY_PORT" --turn-log "$OUT/instance.$PRIMARY_ARM.ndjson" \
  --state "$OUT/state.primary.json" "${PRIMARY_KNOBS[@]}"

# 3. start the tee in front of both. --ack-2x is forwarded (we already warned +
#    the operator opted in at this script's gate), so the tee won't re-prompt.
#    Output basenames A5.ndjson / A0.ndjson so analyze.js labels them by basename.
: > "$TEE_LOG"
node benchmark/bin/tee.js --ack-2x --host "$HOST" --listen-port "$LISTEN_PORT" \
  --primary-port "$PRIMARY_PORT" --shadow-port "$SHADOW_PORT" \
  --out-primary "$OUT/$PRIMARY_ARM.ndjson" --out-shadow "$OUT/A0.ndjson" \
  ${teekaargs[@]+"${teekaargs[@]}"} \
  >> "$TEE_LOG" 2>&1 &
TEE_PID=$!

# Wait for the tee to be listening (or die) before driving claude at it.
for ((i = 0; i < 100; i++)); do
  grep -q "\[tee\] listening" "$TEE_LOG" 2>/dev/null && break
  kill -0 "$TEE_PID" 2>/dev/null || { echo "run_paired: tee FAILED to start:" >&2; tail -n 15 "$TEE_LOG" >&2; exit 1; }
  sleep 0.1
done

# 4. drive ONE claude session at the TEE (not at a proxy). The driver confirms
#    each submit against the PRIMARY instance's own turn-log so a swallowed
#    Enter is retried rather than silently under-driving the run.
gapargs=(); [[ -n "$GAP_SEC" ]] && gapargs=(--gap-sec "$GAP_SEC")
maxargs=(); [[ -n "$MAX_SEC" ]] && maxargs=(--max-sec "$MAX_SEC")
margs=();   [[ -n "$MODEL" ]] && margs=(--model "$MODEL")
effargs=(); [[ -n "$EFFORT" ]] && effargs=(--effort "$EFFORT")
cfargs=();  [[ -n "$CONFIRM_SEC" ]] && cfargs=(--confirm-sec "$CONFIRM_SEC")
mtsargs=(); [[ -n "$MAX_TURN_SEC" ]] && mtsargs=(--max-turn-sec "$MAX_TURN_SEC")
node benchmark/bin/drive_pty.js --profile "$PROFILE" --turns "$TURNS" \
  --host "$HOST" --port "$LISTEN_PORT" --prompts "$PROMPTS" --settle-sec "$SETTLE" \
  --turn-log "$OUT/instance.$PRIMARY_ARM.ndjson" --cwd "$PROJECT_DIR" \
  ${cfargs[@]+"${cfargs[@]}"} ${mtsargs[@]+"${mtsargs[@]}"} ${gapargs[@]+"${gapargs[@]}"} ${maxargs[@]+"${maxargs[@]}"} ${margs[@]+"${margs[@]}"} ${effargs[@]+"${effargs[@]}"} ${drvkaargs[@]+"${drvkaargs[@]}"}

# 5. stop the tee first (flushes its writers on SIGTERM), then the proxies.
kill "$TEE_PID" 2>/dev/null || true
for ((i = 0; i < 50; i++)); do kill -0 "$TEE_PID" 2>/dev/null || break; sleep 0.1; done
TEE_PID=""
.skills/scripts/run_monitor.sh --stop --pid-file "$PRIMARY_PID_FILE" >/dev/null 2>&1 || true
.skills/scripts/run_monitor.sh --stop --pid-file "$SHADOW_PID_FILE"  >/dev/null 2>&1 || true

# The tee writes a record only for turns that produced usage. If neither file
# has lines, nothing flowed — surface it instead of analyzing an empty run.
if [[ ! -s "$OUT/A0.ndjson" && ! -s "$OUT/$PRIMARY_ARM.ndjson" ]]; then
  echo "run_paired: both tee outputs are empty — no billable turns paired." >&2
  echo "            Check $TEE_LOG and $OUT/proxy.*.log; ensure the driver drove turns." >&2
  exit 1
fi

echo
echo "run_paired: analyzing (paired) -> $OUT"
# Bare inputs labeled by basename: A0 (shadow baseline) + the primary arm. The
# analyzer pairs them by the tee's pairSeq for the turn-matched reclaim CI.
node benchmark/bin/analyze.js --out "$OUT" "$OUT/A0.ndjson" "$OUT/$PRIMARY_ARM.ndjson"
if [[ "$NO_PLOT" -eq 0 ]]; then
  node benchmark/bin/plot.js --in "$OUT" --out "$OUT/charts" || \
    echo "run_paired: plot step failed (report still written)." >&2
fi
# Opt-in social card. Best-effort: preview_card.sh walks Chrome -> sips -> SVG
# only, so a missing rasterizer leaves the SVG and skips the PNG, never fails.
if [[ "$CARD" -eq 1 ]]; then
  if ! .skills/scripts/preview_card.sh "$OUT" >/dev/null; then
    echo "run_paired: card compose failed (report still written)." >&2
  elif [[ -f "$OUT/charts/share_card.png" ]]; then
    echo "run_paired: baked $OUT/charts/share_card.png"
  else
    echo "run_paired: composed $OUT/charts/share_card.svg (no rasterizer, PNG skipped)."
  fi
fi

echo
echo "run_paired: wrote $OUT/{report.md,report.csv,summary.json,manifest.json,charts/}"
echo "run_paired: the turn-matched reclaim headline is at the top of:"
echo "            sed -n '1,40p' $OUT/report.md"
