#!/usr/bin/env bash
# Drive a reproducible HTTP replay load against a running clawback proxy.
#
# Thin, guarded wrapper around `node benchmark/bin/replay.js`.
# It does the pre-flight the bare node call can't: confirms the proxy is
# actually listening and that a CLAWBACK_OAUTH_TOKEN bearer is set BEFORE
# spending tokens (NO Anthropic API key — replay forwards an OAuth bearer, the
# same credential `claude` sends), then forwards every argument verbatim to
# replay.js and prints the analyze next-step. The proxy lifecycle itself is
# .skills/scripts/run_monitor.sh's job, not this script's — start the arm there (with
# its own --turn-log), drive it here.
#
# Why a wrapper at all: a mistyped port or a missing bearer otherwise fails
# only after the first real request, and an arm with no turn-log silently
# produces no data. The pre-flight turns those into loud, pre-spend errors.
#
# Usage:
#   .skills/replay/scripts/replay_load.sh --profile L2 --turns 30           # forwarded to replay.js
#   .skills/replay/scripts/replay_load.sh --dry-run --profile L0 --turns 5  # no proxy/key needed
#   .skills/replay/scripts/replay_load.sh --port 8090 --profile L2 --turns 30 --session-id A5-blk1
#
# Every flag is passed straight through to benchmark/bin/replay.js; see that
# file's header for the full option list. This wrapper only INSPECTS
# --host/--port/--tls/--dry-run to run its pre-flight; it never rewrites them.

set -euo pipefail

# Owner-only perms: a forwarded --transcript can contain request/response
# bodies, same posture as clawback's own 0600 logs.
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

# Inspect (do not consume) args for the pre-flight. All args are still
# forwarded to replay.js untouched.
host="127.0.0.1"
port="8787"
scheme="http"
dry_run="0"
prev=""
for a in "$@"; do
	case "$prev" in
		--host) host="$a" ;;
		--port) port="$a" ;;
	esac
	case "$a" in
		--tls) scheme="https" ;;
		--dry-run) dry_run="1" ;;
		-h|--help) dry_run="1" ;;  # let replay.js print help without pre-flight
	esac
	prev="$a"
done

if [ "$dry_run" = "0" ]; then
	if [ -z "${CLAWBACK_OAUTH_TOKEN:-}" ]; then
		echo "replay_load: CLAWBACK_OAUTH_TOKEN is not set — a real run would send no auth (401)." >&2
		echo "             Set it to your Claude Max OAuth bearer (NEVER an API key), pass --dry-run," >&2
		echo "             or drive real traffic through the PTY arm (.skills/drive)." >&2
		exit 1
	fi
	# Liveness: any HTTP response (even 404) means the port is up. curl exit 7
	# = connection refused (proxy down). -k so a self-signed TLS cert doesn't
	# read as 'down'.
	base="$scheme://$host:$port/"
	if ! curl -sk -o /dev/null --max-time 3 "$base"; then
		echo "replay_load: no clawback proxy answering at $base" >&2
		echo "             start one first, e.g.:" >&2
		echo "               .skills/scripts/run_monitor.sh --detach -- --turn-log runs/turns.ndjson --port $port" >&2
		echo "             (use --passthrough on that command for the baseline arm)" >&2
		exit 1
	fi
fi

node benchmark/bin/replay.js "$@"
status=$?

if [ "$dry_run" = "0" ] && [ "$status" = "0" ]; then
	echo
	echo "replay_load: block done. When BOTH arms are collected, one step builds the"
	echo "             GUI-ready report (analyze + plot, incl. the share-card background):"
	echo "  .skills/finish/scripts/finish_run.sh runs/report-\$(date +%s) <baseline.ndjson> <treatment.ndjson>"
fi

exit "$status"
