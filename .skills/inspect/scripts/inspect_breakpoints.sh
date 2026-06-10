#!/usr/bin/env bash
# Statically inspect prompt-cache breakpoints in a captured body or state file.
#
# Answers, with ZERO token spend and no API calls: "where are the
# cache_control breakpoints, and which ephemeral tokens (cch / date / <env>)
# sit inside which cached prefixes?" — i.e. what a single mutation cold-starts.
# Anthropic caches the CUMULATIVE prefix (tools -> system -> messages) up to
# each breakpoint by exact match, so an ephemeral token at cache-order position
# P invalidates every breakpoint at position >= P when it rotates. That one
# fact characterizes the whole structure; no 2^N probe is needed.
#
# Usage:
#   .skills/inspect/scripts/inspect_breakpoints.sh [PATH] [--json]
#     PATH   a raw /v1/messages JSON body, a benchmark fixture, or a clawback
#            --state file. If omitted, the most recently modified
#            runs/*/state*.json is inspected.
#     --json emit the machine-readable model instead of the text report.
#
# This is read-only and safe to run against a live benchmark: it touches only
# files already on disk, never the running proxy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

path=""
passthru=()
for arg in "$@"; do
  case "$arg" in
    --json) passthru+=("$arg") ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    --*) passthru+=("$arg") ;;
    *) path="$arg" ;;
  esac
done

if [[ -z "$path" ]]; then
  # Newest state file across all runs; -f guards the "no matches" glob.
  path="$(ls -t runs/*/state*.json 2>/dev/null | head -1 || true)"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "inspect_breakpoints: no PATH given and no runs/*/state*.json found." >&2
    echo "  pass a captured body or state file explicitly, e.g.:" >&2
    echo "    .skills/inspect/scripts/inspect_breakpoints.sh benchmark/fixtures/ccode.json" >&2
    exit 2
  fi
  echo "inspect_breakpoints: no PATH given; inspecting newest state -> $path" >&2
fi

exec node benchmark/bin/inspect_breakpoints.js "$path" ${passthru[@]+"${passthru[@]}"}
