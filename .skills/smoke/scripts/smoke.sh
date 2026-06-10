#!/usr/bin/env bash
# End-to-end smoke test for clawback.
#
# Starts a mock Anthropic upstream on port 8899, starts the clawback proxy on
# port 8898, exercises path-mode and hash-mode session capture, then walks the
# /_proxy admin API. Uses a temp state file and cleans up on exit.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SMOKE_DIR="${CLAWBACK_SMOKE_DIR:-/tmp/clawback-smoke}"
UPSTREAM_PORT="${CLAWBACK_SMOKE_UPSTREAM_PORT:-8899}"
PROXY_PORT="${CLAWBACK_SMOKE_PROXY_PORT:-8898}"

rm -rf "$SMOKE_DIR"
mkdir -p "$SMOKE_DIR"

UPSTREAM_PID=""
PROXY_PID=""

cleanup() {
  local ec=$?
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
  [[ -n "$UPSTREAM_PID" ]] && kill "$UPSTREAM_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit "$ec"
}
trap cleanup EXIT INT TERM

echo "--- mock upstream on :$UPSTREAM_PORT ---"
node -e "
const http = require('node:http');
let lastBody = '';
const upstream = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_last_body') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(lastBody || '{}');
    return;
  }
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    lastBody = data;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-tokens-remaining': '50000',
      'anthropic-ratelimit-tokens-reset': '2026-04-18T12:00:00Z',
    });
    res.end(JSON.stringify({
      ok: true,
      saw: JSON.parse(data || '{}').model ?? null,
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
    }));
  });
});
upstream.listen($UPSTREAM_PORT, () => console.log('upstream on $UPSTREAM_PORT'));
" &
UPSTREAM_PID=$!
sleep 0.4

echo "--- clawback on :$PROXY_PORT ---"
node "$PROJECT_DIR/bin/clawback.js" \
  --host 127.0.0.1 --port "$PROXY_PORT" \
  --upstream "http://127.0.0.1:$UPSTREAM_PORT" \
  --state "$SMOKE_DIR/state.json" \
  --log-level info \
  --keep-alive-min-sec 3600 --keep-alive-max-sec 3600 &
PROXY_PID=$!
sleep 0.5

echo "--- path mode request ---"
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/my-agent/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-4-7","system":"be helpful","tools":[{"name":"read_file"}],"messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
echo

echo "--- verify cache_control injected on path-mode request ---"
LAST_BODY_PATH=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_last_body")
echo "$LAST_BODY_PATH"
if ! echo "$LAST_BODY_PATH" | grep -q '"cache_control":{"type":"ephemeral","ttl":"1h"}'; then
  echo "FAIL: expected cache_control injection on path-mode request"
  exit 1
fi

echo "--- hash mode request ---"
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d '{"model":"claude-haiku-4-5","system":"short","messages":[],"max_tokens":1}'
echo

echo "--- verify cache_control injected on hash-mode request ---"
LAST_BODY_HASH=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_last_body")
echo "$LAST_BODY_HASH"
if ! echo "$LAST_BODY_HASH" | grep -q '"cache_control":{"type":"ephemeral","ttl":"1h"}'; then
  echo "FAIL: expected cache_control injection on hash-mode request"
  exit 1
fi

echo "--- admin: list sessions ---"
SESSIONS=$(curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/sessions")
echo "$SESSIONS"
if ! echo "$SESSIONS" | grep -q '"ttlMode": "1h"'; then
  echo "FAIL: expected ttlMode=1h in session listing"
  exit 1
fi
if ! echo "$SESSIONS" | grep -q '"cacheReadTokens": 200'; then
  echo "FAIL: expected cacheReadTokens=200 in session telemetry"
  echo "$SESSIONS"
  exit 1
fi
if ! echo "$SESSIONS" | grep -q '"cacheCreationTokens": 100'; then
  echo "FAIL: expected cacheCreationTokens=100 in session telemetry"
  echo "$SESSIONS"
  exit 1
fi

echo "--- admin: health ---"
curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/health"
echo

echo "--- respect-client-cache_control request ---"
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/client-set/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d '{"model":"claude-opus-4-7","system":"x","tools":[{"name":"t"}],"cache_control":{"type":"ephemeral","ttl":"5m"},"messages":[],"max_tokens":1}' > /dev/null
LAST_BODY_CLIENT=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_last_body")
if echo "$LAST_BODY_CLIENT" | grep -q '"ttl":"1h"'; then
  echo "FAIL: proxy overwrote client-set cache_control"
  echo "$LAST_BODY_CLIENT"
  exit 1
fi
if ! echo "$LAST_BODY_CLIENT" | grep -q '"ttl":"5m"'; then
  echo "FAIL: client-set cache_control not forwarded"
  echo "$LAST_BODY_CLIENT"
  exit 1
fi
echo "client-set cache_control preserved"

echo "--- admin: delete my-agent ---"
curl -s -X DELETE "http://127.0.0.1:$PROXY_PORT/_proxy/sessions/my-agent"
echo

echo "--- admin: list after delete ---"
curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/sessions"
echo

# Gracefully stop the proxy so its state file is flushed to disk before we read it.
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

echo "--- state file ($SMOKE_DIR/state.json) ---"
cat "$SMOKE_DIR/state.json"
echo

# ---------------------------------------------------------------------------
# Phase 2: passthrough mode + turn-log + UI endpoints.
# ---------------------------------------------------------------------------

TURN_LOG="$SMOKE_DIR/turns.ndjson"
rm -f "$TURN_LOG"
rm -f "$SMOKE_DIR/state.json"

echo "--- clawback --passthrough --turn-log on :$PROXY_PORT ---"
node "$PROJECT_DIR/bin/clawback.js" \
  --host 127.0.0.1 --port "$PROXY_PORT" \
  --upstream "http://127.0.0.1:$UPSTREAM_PORT" \
  --state "$SMOKE_DIR/state.json" \
  --turn-log "$TURN_LOG" \
  --log-level info \
  --passthrough \
  --keep-alive-min-sec 3600 --keep-alive-max-sec 3600 &
PROXY_PID=$!
sleep 0.5

echo "--- passthrough request: body must be unchanged ---"
PASSTHROUGH_BODY='{"model":"claude-sonnet-4-6","system":"b","tools":[{"name":"t"}],"messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/pt-agent/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d "$PASSTHROUGH_BODY" > /dev/null
LAST_BODY_PT=$(curl -s "http://127.0.0.1:$UPSTREAM_PORT/_last_body")
if echo "$LAST_BODY_PT" | grep -q '"cache_control"'; then
  echo "FAIL: passthrough mode injected cache_control"
  echo "$LAST_BODY_PT"
  exit 1
fi
if [[ "$LAST_BODY_PT" != "$PASSTHROUGH_BODY" ]]; then
  echo "FAIL: passthrough body bytes differ"
  echo "sent:     $PASSTHROUGH_BODY"
  echo "received: $LAST_BODY_PT"
  exit 1
fi
echo "passthrough body forwarded byte-for-byte"

echo "--- UI endpoints reachable ---"
UI_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/_proxy/ui/")
if [[ "$UI_STATUS" != "200" ]]; then
  echo "FAIL: /_proxy/ui/ returned $UI_STATUS"
  exit 1
fi
PRICING_JSON=$(curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/pricing")
if ! echo "$PRICING_JSON" | grep -q '"claude-sonnet-4-6"'; then
  echo "FAIL: /_proxy/pricing missing expected model"
  echo "$PRICING_JSON"
  exit 1
fi
TURNS_JSON=$(curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/turns")
if ! echo "$TURNS_JSON" | grep -qE '"arm": ?"passthrough"'; then
  echo "FAIL: /_proxy/turns did not return passthrough record"
  echo "$TURNS_JSON"
  exit 1
fi
echo "UI + pricing + turns endpoints OK"

# Shut down to flush the turn-log stream.
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""
sleep 0.2

echo "--- turn-log shape ---"
if [[ ! -s "$TURN_LOG" ]]; then
  echo "FAIL: turn-log is empty or missing"
  exit 1
fi
FIRST_LINE=$(head -n1 "$TURN_LOG")
for field in ts sessionKey mode arm httpStatus wallMs usdEstimate clawbackVersion; do
  if ! echo "$FIRST_LINE" | grep -q "\"$field\""; then
    echo "FAIL: turn-log record missing field: $field"
    echo "$FIRST_LINE"
    exit 1
  fi
done
if ! echo "$FIRST_LINE" | grep -q '"arm":"passthrough"'; then
  echo "FAIL: turn-log record did not mark arm=passthrough"
  echo "$FIRST_LINE"
  exit 1
fi
echo "turn-log record shape OK"

# ---------------------------------------------------------------------------
# Phase 4: session fingerprinting + /_proxy/fragments.
# ---------------------------------------------------------------------------

TURN_LOG_FRAG="$SMOKE_DIR/turns-frag.ndjson"
rm -f "$TURN_LOG_FRAG"
rm -f "$SMOKE_DIR/state.json"

echo "--- clawback (treatment) with fingerprinting on :$PROXY_PORT ---"
node "$PROJECT_DIR/bin/clawback.js" \
  --host 127.0.0.1 --port "$PROXY_PORT" \
  --upstream "http://127.0.0.1:$UPSTREAM_PORT" \
  --state "$SMOKE_DIR/state.json" \
  --turn-log "$TURN_LOG_FRAG" \
  --log-level info \
  --keep-alive-min-sec 3600 --keep-alive-max-sec 3600 &
PROXY_PID=$!
sleep 0.5

echo "--- date-only twin requests (different sessionKeys, same toolsKey) ---"
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d '{"model":"claude-opus-4-7","system":"You are helpful. Today'"'"'s date is 2026-04-23.","tools":[{"name":"Bash"},{"name":"Edit"}],"messages":[{"role":"user","content":"yesterday"}],"max_tokens":1}' > /dev/null
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d '{"model":"claude-opus-4-7","system":"You are helpful. Today'"'"'s date is 2026-04-24.","tools":[{"name":"Bash"},{"name":"Edit"}],"messages":[{"role":"user","content":"today"}],"max_tokens":1}' > /dev/null

echo "--- session record carries toolsKey + systemStableKey ---"
SESSIONS_FRAG=$(curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/sessions")
if ! echo "$SESSIONS_FRAG" | grep -q '"toolsKey"'; then
  echo "FAIL: session record missing toolsKey"
  echo "$SESSIONS_FRAG"
  exit 1
fi
if ! echo "$SESSIONS_FRAG" | grep -q '"systemStableKey"'; then
  echo "FAIL: session record missing systemStableKey"
  echo "$SESSIONS_FRAG"
  exit 1
fi
echo "session record fingerprints OK"

echo "--- /_proxy/fragments returns expected shape ---"
FRAGMENTS=$(curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/fragments")
if ! echo "$FRAGMENTS" | grep -q '"groups"'; then
  echo "FAIL: /_proxy/fragments missing 'groups'"
  echo "$FRAGMENTS"
  exit 1
fi
if ! echo "$FRAGMENTS" | grep -q '"hypothesis": "date-only"'; then
  echo "FAIL: expected hypothesis=date-only for the twin sessions"
  echo "$FRAGMENTS"
  exit 1
fi
if ! echo "$FRAGMENTS" | grep -q '"turnLogConfigured": true'; then
  echo "FAIL: expected turnLogConfigured=true"
  echo "$FRAGMENTS"
  exit 1
fi
if ! echo "$FRAGMENTS" | grep -q '"explanation"'; then
  echo "FAIL: /_proxy/fragments missing explanation"
  echo "$FRAGMENTS"
  exit 1
fi
echo "/_proxy/fragments shape OK"

# Shut down to flush the turn-log stream.
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""
sleep 0.2

echo "--- turn-log records carry fingerprints ---"
if [[ ! -s "$TURN_LOG_FRAG" ]]; then
  echo "FAIL: fragmentation turn-log empty or missing"
  exit 1
fi
FRAG_FIRST=$(head -n1 "$TURN_LOG_FRAG")
if ! echo "$FRAG_FIRST" | grep -q '"toolsKey"'; then
  echo "FAIL: turn-log record missing toolsKey"
  echo "$FRAG_FIRST"
  exit 1
fi
if ! echo "$FRAG_FIRST" | grep -q '"systemStableKey"'; then
  echo "FAIL: turn-log record missing systemStableKey"
  echo "$FRAG_FIRST"
  exit 1
fi
echo "turn-log fingerprints OK"

if ! echo "$FRAG_FIRST" | grep -q '"trafficKind"'; then
  echo "FAIL: turn-log record missing trafficKind (PLAN §21)"
  echo "$FRAG_FIRST"
  exit 1
fi
if ! echo "$FRAG_FIRST" | grep -q '"trafficConfidence"'; then
  echo "FAIL: turn-log record missing trafficConfidence (PLAN §21)"
  echo "$FRAG_FIRST"
  exit 1
fi
echo "turn-log traffic-classifier fields OK"

# ---------------------------------------------------------------------------
# Phase 5: /_proxy/traffic admin endpoint (PLAN §21).
# ---------------------------------------------------------------------------

TURN_LOG_TRAFFIC="$SMOKE_DIR/turns-traffic.ndjson"
rm -f "$TURN_LOG_TRAFFIC"
rm -f "$SMOKE_DIR/state.json"

echo "--- clawback for traffic-classifier check on :$PROXY_PORT ---"
node "$PROJECT_DIR/bin/clawback.js" \
  --host 127.0.0.1 --port "$PROXY_PORT" \
  --upstream "http://127.0.0.1:$UPSTREAM_PORT" \
  --state "$SMOKE_DIR/state.json" \
  --turn-log "$TURN_LOG_TRAFFIC" \
  --log-level info \
  --keep-alive-min-sec 3600 --keep-alive-max-sec 3600 &
PROXY_PID=$!
sleep 0.5

echo "--- mix of /v1/messages and /v1/messages/count_tokens ---"
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/tk-agent/v1/messages" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d '{"model":"claude-opus-4-7","system":"s","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' > /dev/null
curl -s -X POST "http://127.0.0.1:$PROXY_PORT/tk-agent/v1/messages/count_tokens" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-test' \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"hi"}]}' > /dev/null

echo "--- /_proxy/traffic returns expected shape ---"
TRAFFIC=$(curl -s "http://127.0.0.1:$PROXY_PORT/_proxy/traffic")
echo "$TRAFFIC"
if ! echo "$TRAFFIC" | grep -q '"buckets"'; then
  echo "FAIL: /_proxy/traffic missing 'buckets'"
  exit 1
fi
if ! echo "$TRAFFIC" | grep -q '"kind": "normal"'; then
  echo "FAIL: /_proxy/traffic missing kind=normal bucket"
  exit 1
fi
if ! echo "$TRAFFIC" | grep -q '"kind": "count-tokens"'; then
  echo "FAIL: /_proxy/traffic missing kind=count-tokens bucket"
  exit 1
fi
if ! echo "$TRAFFIC" | grep -q '"turnLogConfigured": true'; then
  echo "FAIL: /_proxy/traffic missing turnLogConfigured=true"
  exit 1
fi
echo "/_proxy/traffic shape OK"

# Shut down to flush.
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

echo "--- smoke test OK ---"
