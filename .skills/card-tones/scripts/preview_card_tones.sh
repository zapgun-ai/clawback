#!/usr/bin/env bash
# DESIGN render-only proof — NOT a benchmark result.
#
# Renders the share card in BOTH tones so the atmosphere retune (deep-purple
# LENS_CORE centre + win-only cyan corona + darkened gradients) can be eyeballed
# in one pass:
#
#   1. neg  — a REAL run's amber regression card (the purple core, no corona).
#   2. pos  — a SYNTHETIC win card built only to exercise the renderer's pos
#             branch (purple core + faint cyan corona together). Its number is a
#             fabricated render fixture, never a published result — it reuses an
#             existing run's bare chart purely so the graph/lensflare compose.
#
# Both land as PNGs under the --out dir via .skills/scripts/preview_card.sh (sips). The
# pos run is staged in a temp dir and removed on exit.
#
# Usage:
#   .skills/card-tones/scripts/preview_card_tones.sh <neg-run-dir> <out-dir>
# e.g.
#   .skills/card-tones/scripts/preview_card_tones.sh runs/L0-headline-haiku /tmp/cardcheck

set -euo pipefail
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$PROJECT_DIR"

if [[ $# -lt 2 || "$1" == "-h" || "$1" == "--help" ]]; then
	sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
	exit 0
fi

NEG_RUN="$1"
OUT_DIR="$2"
mkdir -p "$OUT_DIR"

# 1) Real amber/neg card (purple core, tone-gated corona OFF).
.skills/scripts/preview_card.sh "$NEG_RUN" --out "$OUT_DIR"
mv "$OUT_DIR/share_card.png" "$OUT_DIR/share_card.neg.png"
mv "$OUT_DIR/share_card.svg" "$OUT_DIR/share_card.neg.svg"

# 2) Synthetic pos card — render fixture ONLY, to see the win-only cyan corona
#    next to the purple core. Stage a temp run that borrows the neg run's bare
#    chart and carries a positive-token summary so deriveHeroModel picks tone=pos.
TMP_RUN="$(mktemp -d)"
trap 'rm -rf "$TMP_RUN"' EXIT
mkdir -p "$TMP_RUN/charts"
cp "$NEG_RUN/charts/tokens_saved.bg.svg" "$TMP_RUN/charts/tokens_saved.bg.svg"
cat >"$TMP_RUN/summary.json" <<'JSON'
{
  "tokens": {
    "reclaimedPerTurn": 1196,
    "pctLessPerTurn": 68,
    "reclaimedTotal": 175537
  }
}
JSON
.skills/scripts/preview_card.sh "$TMP_RUN" --out "$OUT_DIR"
mv "$OUT_DIR/share_card.png" "$OUT_DIR/share_card.pos.png"
mv "$OUT_DIR/share_card.svg" "$OUT_DIR/share_card.pos.svg"

echo "preview_card_tones: wrote $OUT_DIR/share_card.{neg,pos}.png"
