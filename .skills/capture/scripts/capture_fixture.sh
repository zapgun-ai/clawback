#!/usr/bin/env bash
# Capture a REAL Claude Code /v1/messages body as a replay fixture.
#
# The HTTP replay arm is only faithful when it replays a body
# that reproduces Claude Code's exact cache_control breakpoint structure. A
# hand-authored fixture makes the 1h-TTL knob look like a no-op. This script
# captures the genuine article end to end:
#
#   1. start a standalone clawback proxy with --capture-body <tmp> (detached)
#   2. drive ONE real claude turn through it (benchmark/bin/drive_pty.js)
#   3. stop the proxy
#   4. verify the dump carries cache_control breakpoints
#   5. promote the temp dump to the fixture path (mode 0600)
#
# COST: step 2 runs the real `claude` binary and spends real Anthropic tokens
# against your own limits. Exactly one turn; pin a cheap model with --model.
#
# Requirements: the `claude` CLI on PATH, node-pty installed (clawback's
# optional dep), and claude already authenticated.
#
# Options:
#   --out PATH      fixture destination (default: benchmark/fixtures/ccode.json)
#   --host HOST     proxy bind host (default: 127.0.0.1)
#   --port PORT     proxy port (default: 8787)
#   --model ID      pin claude's model, e.g. claude-haiku-4-5-20251001 (cheap)
#   --prompt TEXT   the single prompt to type (default: a read-only listing)
#   --keep-tmp      keep the temp dump even if verification fails (debugging)
#   -h, --help      show this help
#
# Anything after `--` is forwarded verbatim to drive_pty.js.

set -euo pipefail

# Owner-only perms: the captured body holds the operator's system prompt +
# tool definitions (never the API key — that rides in headers we don't dump).
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

OUT="benchmark/fixtures/ccode.json"
HOST="127.0.0.1"
PORT="8787"
MODEL=""
PROMPT="List the files in the current directory using your tools, then stop."
KEEP_TMP=0
LOG_FILE="data/capture.run.log"
PID_FILE="data/capture.run.pid"
EXTRA_ARGS=()

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)      OUT="${2:?--out needs a path}"; shift ;;
    --host)     HOST="${2:?--host needs a value}"; shift ;;
    --port)     PORT="${2:?--port needs a value}"; shift ;;
    --model)    MODEL="${2:?--model needs a value}"; shift ;;
    --prompt)   PROMPT="${2:?--prompt needs text}"; shift ;;
    --keep-tmp) KEEP_TMP=1 ;;
    -h|--help)  usage; exit 0 ;;
    --)         shift; EXTRA_ARGS=("$@"); break ;;
    *) echo "capture_fixture: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || {
  echo "capture_fixture: '$CLAUDE_BIN' not found on PATH. Install the Claude Code CLI first." >&2
  exit 1
}
node -e 'import("node-pty").then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null || {
  echo "capture_fixture: node-pty is not installed. Run: npm i node-pty" >&2
  exit 1
}

echo "capture_fixture: this drives ONE real claude turn through clawback and" >&2
echo "                 spends real Anthropic tokens against your own limits." >&2
[[ -n "$MODEL" ]] && echo "capture_fixture: pinning model=$MODEL" >&2

mkdir -p data
TMP_OUT="$(mktemp "${TMPDIR:-/tmp}/clawback-fixture.XXXXXX")"
PROMPT_FILE="$(mktemp "${TMPDIR:-/tmp}/clawback-capture-prompt.XXXXXX")"
printf '%s\n' "$PROMPT" > "$PROMPT_FILE"

cleanup() {
  .skills/scripts/run_monitor.sh --stop --pid-file "$PID_FILE" >/dev/null 2>&1 || true
  rm -f "$PROMPT_FILE"
  if [[ "$KEEP_TMP" -eq 0 ]]; then rm -f "$TMP_OUT"; fi
}
trap cleanup EXIT

# 1. Start the proxy with --capture-body. Defaults knobs are fine: capture
#    grabs the PRISTINE body before any mutation, so the arm doesn't matter.
.skills/scripts/run_monitor.sh --detach \
  --log-file "$LOG_FILE" --pid-file "$PID_FILE" -- \
  --host "$HOST" --port "$PORT" --capture-body "$TMP_OUT"

# 2. Drive exactly one real turn. drive_pty points claude at the proxy.
DRIVE_ARGS=(--profile L0 --turns 1 --host "$HOST" --port "$PORT"
  --prompts "$PROMPT_FILE" --cwd "$PROJECT_DIR")
[[ -n "$MODEL" ]] && DRIVE_ARGS+=(--model "$MODEL")
node benchmark/bin/drive_pty.js "${DRIVE_ARGS[@]}" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

# 3. Stop the proxy (also handled by the trap, but do it now so the file is
#    flushed and the port is free before we verify/promote).
.skills/scripts/run_monitor.sh --stop --pid-file "$PID_FILE" >/dev/null 2>&1 || true

# 4. Verify the dump exists and reproduces Claude Code's cache_control layout.
if [[ ! -s "$TMP_OUT" ]]; then
  echo "capture_fixture: nothing was captured (no system+tools /v1/messages turn seen)." >&2
  echo "                 Check $LOG_FILE; ensure claude actually sent a turn." >&2
  exit 1
fi
node benchmark/bin/verify_fixture.js "$TMP_OUT"

# 5. Promote temp -> fixture.
mkdir -p "$(dirname "$OUT")"
mv "$TMP_OUT" "$OUT"
chmod 600 "$OUT"
KEEP_TMP=1  # already moved; nothing for cleanup to delete
echo "capture_fixture: wrote $OUT"
echo "capture_fixture: replay it with .skills/replay (.skills/replay/scripts/replay_load.sh --fixture $OUT ...)"
