#!/usr/bin/env bash
# Turn a benchmark turn-log (or an already-analyzed run dir) into a report that
# shows up in the report GUI right away — no second manual step.
#
# A "finished" run is a directory under the report root (config.reportDir,
# default ./runs) that the report server can serve in full: summary.json +
# report.csv (analyzer output) AND charts/tokens_saved.svg +
# charts/tokens_saved.bg.svg (plot output). The bare ".bg.svg" is the share
# card's background; without it the downloaded/posted PNG is a solid card with
# NO chart lines. plot.js only started emitting it recently, so runs plotted
# before then are missing it — hence the --all backfill below.
#
# This script is the single "generate the reports" entry point that
# run_paired.sh / ab_block.sh already inline at the end of a complete (both-arm)
# run; use it directly for a manual analyze, or to backfill old runs.
#
# Usage:
#   # Analyze fresh turn-logs into a run dir, then plot (both SVGs):
#   .skills/finish/scripts/finish_run.sh runs/my-run runs/A0.ndjson runs/A5.ndjson
#
#   # Re-plot a run that already has summary.json + report.csv (adds .bg.svg):
#   .skills/finish/scripts/finish_run.sh runs/my-run
#
#   # Backfill EVERY run under the root that's missing its charts (re-plot only):
#   .skills/finish/scripts/finish_run.sh --all
#   .skills/finish/scripts/finish_run.sh --all --root runs
#
#   # Also bake the social share card (charts/share_card.{svg,png}). Best-effort
#   # raster: headless Chrome -> sips, no-op (SVG only) if neither is present:
#   .skills/finish/scripts/finish_run.sh runs/my-run --card
#   .skills/finish/scripts/finish_run.sh --all --card          # backfill a PNG for every run
#
# Re-plot is a pure function of summary.json + report.csv, so backfilling is
# safe and idempotent: it never re-spends tokens or re-reads turn-logs, it only
# regenerates the SVGs from the analyzer output already on disk.

set -euo pipefail

# Reports can carry request/response detail upstream of here; keep the same
# owner-only posture as clawback's own 0600 logs for anything we write.
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

ROOT="runs"
ALL=0
CARD=0
RUN_DIR=""
declare -a TURNLOGS=()

# Parse: --all / --root <dir> are options; the first bare arg is the run dir,
# any further bare args are turn-log inputs forwarded to analyze.js.
while [[ $# -gt 0 ]]; do
	case "$1" in
		--all) ALL=1 ;;
		--card) CARD=1 ;;
		--root) ROOT="$2"; shift ;;
		-h|--help)
			sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		--*)
			echo "finish_run: unknown option: $1" >&2
			exit 2
			;;
		*)
			if [[ -z "$RUN_DIR" ]]; then RUN_DIR="$1"; else TURNLOGS+=("$1"); fi
			;;
	esac
	shift
done

# Re-plot one analyzer output dir. Requires summary.json + report.csv (the
# plot inputs); skips with a note otherwise so --all never aborts mid-backfill.
replot_one() {
	local dir="$1"
	if [[ ! -f "$dir/summary.json" || ! -f "$dir/report.csv" ]]; then
		echo "finish_run: skip $dir (no summary.json + report.csv to plot)" >&2
		return 1
	fi
	node benchmark/bin/plot.js --in "$dir" --out "$dir/charts"
	echo "finish_run: plotted $dir/charts/{tokens_saved.svg,tokens_saved.bg.svg}"
}

# Compose (and best-effort rasterize) the social share card for one analyzed
# run dir. Delegates to .skills/scripts/preview_card.sh so a baked card walks the same
# Chrome -> sips -> SVG-only ladder the viewer does; never aborts the pipeline
# (returns 0 even with no rasterizer or a compose failure — the report stands).
bake_card_one() {
	local dir="$1"
	if [[ ! -f "$dir/summary.json" ]]; then
		echo "finish_run: skip card for $dir (no summary.json)" >&2
		return 0
	fi
	if ! .skills/scripts/preview_card.sh "$dir" >/dev/null; then
		echo "finish_run: card compose failed for $dir (report still written)." >&2
		return 0
	fi
	if [[ -f "$dir/charts/share_card.png" ]]; then
		echo "finish_run: baked $dir/charts/share_card.png"
	else
		echo "finish_run: composed $dir/charts/share_card.svg (no rasterizer, PNG skipped)"
	fi
}

if [[ "$ALL" -eq 1 ]]; then
	if [[ ! -d "$ROOT" ]]; then
		echo "finish_run: report root '$ROOT' does not exist." >&2
		exit 1
	fi
	n=0
	for d in "$ROOT"/*/; do
		[[ -d "$d" ]] || continue
		dir="${d%/}"
		# Re-plot only runs missing the bare background; leave complete runs
		# untouched so a backfill is cheap and obviously idempotent.
		if [[ ! -f "$dir/charts/tokens_saved.bg.svg" ]]; then
			if replot_one "$dir"; then n=$((n + 1)); fi
		fi
		# Card backfill is independent of the re-plot skip: a run can be fully
		# plotted yet still lack its PNG. Skip only runs that already have one,
		# so --all --card stays cheap and idempotent like the re-plot above.
		if [[ "$CARD" -eq 1 && ! -f "$dir/charts/share_card.png" ]]; then
			bake_card_one "$dir"
		fi
	done
	echo "finish_run: backfilled $n run(s) under $ROOT."
	exit 0
fi

if [[ -z "$RUN_DIR" ]]; then
	echo "finish_run: need a run dir (or --all). See --help." >&2
	exit 2
fi

# Fresh analyze when turn-logs are supplied; otherwise assume the run dir is
# already analyzed and we're only (re-)plotting it.
if [[ "${#TURNLOGS[@]}" -gt 0 ]]; then
	echo "finish_run: analyzing ${#TURNLOGS[@]} turn-log(s) -> $RUN_DIR"
	node benchmark/bin/analyze.js --out "$RUN_DIR" "${TURNLOGS[@]}"
fi

replot_one "$RUN_DIR"
if [[ "$CARD" -eq 1 ]]; then bake_card_one "$RUN_DIR"; fi
echo "finish_run: $RUN_DIR is ready — open the report GUI and pick it from the run list."
