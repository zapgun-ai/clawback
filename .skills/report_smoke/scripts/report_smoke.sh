#!/usr/bin/env bash
# End-to-end smoke test for the /<admin-path>/report saved-run viewer.
#
# Boots the REAL `clawback` binary (plain HTTP, no TLS) pointed at the repo's
# actual runs/ directory, then curls every report route and asserts status +
# content. Unlike test/report.test.js (which drives createServer with synthetic
# run dirs), this exercises the shipped bin/clawback.js boot path against real
# analyzer output, so it catches wiring/serving regressions the unit tests
# can't (asset packaging, prefix injection, admin dispatch, the GET Host-gate
# exemption that makes the viewer publicly readable).
#
# It also re-boots once with a custom --admin-path to prove the "_proxy" string
# is mutable end-to-end (a core requirement of the report feature), and proves
# the sensitive run-dir siblings (proxy.*.log, turns.*.ndjson) are unreachable.
#
# No upstream and no API key are needed: report routes never proxy to Anthropic.
# Exit 0 iff every assertion passes; non-zero (with a FAIL summary) otherwise.
#
# Usage:
#   .skills/report_smoke/scripts/report_smoke.sh            # run against ./runs
#   CLAWBACK_REPORT_DIR=… .skills/report_smoke/scripts/report_smoke.sh   # override the runs dir

set -uo pipefail   # NOT -e: run all checks, then report every failure at once.

umask 077          # temp log/state may echo request lines; keep them owner-only.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

REPORT_DIR="${CLAWBACK_REPORT_DIR:-$PROJECT_DIR/runs}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawback-report-smoke.XXXXXX")"
LOG_FILE="$TMP_DIR/proxy.log"
STATE_FILE="$TMP_DIR/state.json"
HDR_FILE="$TMP_DIR/resp.hdr"
BODY_FILE="$TMP_DIR/resp.body"
mkdir -p "$TMP_DIR/xdg"   # empty global-config root → DEFAULTS-only proxy boot.

PASS=0
FAIL=0
PROXY_PID=""

note_pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
note_fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

cleanup() {
  local ec=$?
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$TMP_DIR"
  exit "$ec"
}
trap cleanup EXIT INT TERM

# Pick a free high port by binding :0 and reading back what the OS assigned.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(""+s.address().port);s.close()})'
}

# boot_proxy <port> [extra clawback args...] — start the proxy, wait until it
# logs "listening", or fail loudly with the captured log tail.
#
# Hermetic by construction: launched from an empty cwd with XDG_CONFIG_HOME
# pointed at an empty dir, so neither the operator's global config nor a local
# ./CLAWBACK.md bleeds in. Without this, the operator's dogfood config (which
# sets adminToken + host=0.0.0.0, and could set a custom adminPathPrefix) would
# silently change behavior — a set adminToken alone disables the Host gate that
# the public-read assertion contrasts against. DEFAULTS + these flags only.
boot_proxy() {
  local port="$1"; shift
  : > "$LOG_FILE"
  ( cd "$TMP_DIR" && exec env XDG_CONFIG_HOME="$TMP_DIR/xdg" \
      node "$PROJECT_DIR/bin/clawback.js" \
      --host 127.0.0.1 --port "$port" \
      --report-dir "$REPORT_DIR" \
      --state "$STATE_FILE" \
      --log-level info \
      "$@" ) >> "$LOG_FILE" 2>&1 &
  PROXY_PID=$!
  local i
  for ((i = 0; i < 100; i++)); do
    grep -q "clawback listening on" "$LOG_FILE" 2>/dev/null && return 0
    kill -0 "$PROXY_PID" 2>/dev/null || break
    sleep 0.1
  done
  echo "report_smoke: clawback failed to start — last log lines:" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  return 1
}

stop_proxy() {
  [[ -n "$PROXY_PID" ]] || return 0
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
  PROXY_PID=""
}

# http_get <url> [method] — sets HTTP_CODE; writes headers→$HDR_FILE, body→$BODY_FILE.
http_get() {
  HTTP_CODE=$(curl -s -X "${2:-GET}" -D "$HDR_FILE" -o "$BODY_FILE" -w '%{http_code}' "$1")
}

# expect_status <label> <url> <want-code>
expect_status() {
  http_get "$2"
  if [[ "$HTTP_CODE" == "$3" ]]; then note_pass "$1 → $3"
  else note_fail "$1 → got $HTTP_CODE, want $3"; fi
}

# expect_body_has / expect_body_lacks operate on the LAST http_get's body.
expect_body_has() {
  if grep -q -- "$2" "$BODY_FILE"; then note_pass "$1"
  else note_fail "$1 (marker not found: $2)"; fi
}
expect_body_lacks() {
  if grep -q -- "$2" "$BODY_FILE"; then note_fail "$1 (forbidden marker present: $2)"
  else note_pass "$1"; fi
}
expect_header_has() {
  if grep -iq -- "$2" "$HDR_FILE"; then note_pass "$1"
  else note_fail "$1 (header not found: $2)"; fi
}

[[ -d "$REPORT_DIR" ]] || { echo "report_smoke: runs dir not found: $REPORT_DIR" >&2; exit 2; }

echo "report_smoke: runs dir = $REPORT_DIR"
echo "report_smoke: discovered runs: $(ls -1 "$REPORT_DIR" 2>/dev/null | tr '\n' ' ')"

# ---------------------------------------------------------------------------
# Phase 1: default admin prefix (_proxy).
# ---------------------------------------------------------------------------
PORT="$(free_port)"
echo "--- phase 1: default prefix on 127.0.0.1:$PORT ---"
boot_proxy "$PORT" || exit 1
B="http://127.0.0.1:$PORT/_proxy/report"

echo "[static + base injection]"
expect_status "GET /_proxy/report/ (index)" "$B/" 200
expect_body_has "index.html injects the real base href" 'href="/_proxy/report/"'
expect_body_lacks "index.html has no unsubstituted __BASE__" '__BASE__'
expect_body_has "index serves the token-story hero" 'id="heroNumber"'
expect_status "GET /_proxy/report/report.js" "$B/report.js" 200
expect_header_has "report.js served as javascript" 'content-type: application/javascript'
expect_status "GET /_proxy/report/report.css" "$B/report.css" 200
expect_header_has "report.css served as css" 'content-type: text/css'

echo "[dynamic routes against real runs]"
expect_status "GET /_proxy/report/runs" "$B/runs" 200
expect_body_has "runs listing includes L0-tier1" '"id": "L0-tier1"'
expect_body_has "runs listing includes smoke" '"id": "smoke"'

expect_status "GET /_proxy/report/data?run=L0-tier1" "$B/data?run=L0-tier1" 200
expect_body_has "data payload carries summary" '"summary"'
expect_body_has "data payload lists charts" '"charts"'
expect_body_has "data payload reports csvBytes" '"csvBytes"'
# The one story: the summary leads with the billable-token reclaim block, and
# the single chart is tokens_saved.svg (no cost/$/CI tables, no usd_by_gap).
expect_body_has "summary carries the token-reclaim headline block" '"tokens"'
expect_body_has "summary reports reclaimed-per-turn" '"reclaimedPerTurn"'
expect_body_has "the one chart is tokens_saved.svg" 'tokens_saved.svg'

expect_status "GET /_proxy/report/chart/L0-tier1/tokens_saved.svg" \
  "$B/chart/L0-tier1/tokens_saved.svg" 200
expect_header_has "chart served as svg" 'content-type: image/svg+xml'
expect_body_has "chart body is an SVG document" '<svg'

expect_status "GET /_proxy/report/csv/L0-tier1" "$B/csv/L0-tier1" 200
expect_header_has "csv served as a download" 'content-disposition: attachment'

echo "[security: sensitive siblings unreachable]"
# L0-tier1 really holds proxy.A0.log + turns.A0.ndjson next to the served files.
# The allowlist is the control: no route serves those files. The data payload
# legitimately *names* the analyzed ndjson in its manifest provenance (path +
# record counts) — that's reproducibility metadata, not content — so we assert
# at the route level (no URL fetches the files) rather than grepping the body.
expect_status "raw turns.ndjson not served as a static asset" "$B/turns.A0.ndjson" 404
expect_status "raw proxy log not served as a static asset" "$B/proxy.A0.log" 404
expect_status "raw turns.ndjson not served under a run-id path" \
  "$B/L0-tier1/turns.A0.ndjson" 404
expect_status "non-svg under chart/ rejected" "$B/chart/L0-tier1/proxy.A0.log" 404
expect_status "ndjson under chart/ rejected" "$B/chart/L0-tier1/turns.A0.ndjson" 404
expect_status "traversal ?run=.. rejected" "$B/data?run=.." 400
expect_status "encoded traversal ?run=..%2f..%2fetc%2fpasswd rejected" \
  "$B/data?run=..%2f..%2fetc%2fpasswd" 400

echo "[publicly readable: report GET exempt from the Host gate]"
# A GET with a bogus Host trips the DNS-rebinding 421 on a guarded endpoint,
# but the report viewer is deliberately exempt so it stays publicly readable.
MISDIRECTED=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' \
  "http://127.0.0.1:$PORT/_proxy/metrics")
if [[ "$MISDIRECTED" == "421" ]]; then note_pass "guarded endpoint 421s on bad Host"
else note_fail "expected /_proxy/metrics → 421 on bad Host, got $MISDIRECTED"; fi
REPORT_PUB=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$B/")
if [[ "$REPORT_PUB" == "200" ]]; then note_pass "report GET exempt from Host gate (200)"
else note_fail "expected report GET → 200 on bad Host, got $REPORT_PUB"; fi

echo "[dashboard cross-link]"
expect_status "GET /_proxy/ui/" "http://127.0.0.1:$PORT/_proxy/ui/" 200
expect_body_has "dashboard exposes the report link" 'id="reportLink"'

stop_proxy

# ---------------------------------------------------------------------------
# Phase 2: custom admin prefix proves "_proxy" is mutable end-to-end.
# ---------------------------------------------------------------------------
PORT2="$(free_port)"
echo "--- phase 2: custom prefix (--admin-path ctrl) on 127.0.0.1:$PORT2 ---"
boot_proxy "$PORT2" --admin-path ctrl || exit 1
C="http://127.0.0.1:$PORT2/ctrl/report"

expect_status "GET /ctrl/report/ (custom prefix)" "$C/" 200
expect_body_has "custom-prefix base href injected" 'href="/ctrl/report/"'
expect_body_lacks "custom-prefix page does not leak _proxy" '/_proxy/report/'
expect_status "GET /ctrl/report/runs" "$C/runs" 200
expect_body_has "custom-prefix runs listing works" '"id": "L0-tier1"'
expect_status "old /_proxy prefix is gone under custom prefix" \
  "http://127.0.0.1:$PORT2/_proxy/report/" 404

stop_proxy

# ---------------------------------------------------------------------------
echo "---"
echo "report_smoke: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && echo "--- report smoke OK ---" || echo "--- report smoke FAILED ---" >&2
exit "$FAIL"
