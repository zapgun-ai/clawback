#!/usr/bin/env bash
# Compose a run's social share card and (best-effort) rasterize it to PNG so it
# can be eyeballed without the report GUI.
#
# Two steps:
#   1. node benchmark/bin/preview_card.js --in <run>  -> charts/share_card.svg
#      (the solid dark card + hero text, composed exactly as the GUI does — see
#       that file's header for why it's SVG, not PNG).
#   2. If a rasterizer is available, render share_card.svg -> share_card.png so
#      the card is viewable in any image viewer. Order of preference:
#        - headless Google Chrome (true 1200x630, when it doesn't segfault)
#        - macOS `sips` (built in; renders a faithful 1200x630 — every text
#          element including the right-anchored tagline lands in-frame)
#      We deliberately do NOT use `qlmanage` Quick Look: it upscales the SVG and
#      pads to a 1200x1200 square, pushing the right-anchored tagline off-canvas,
#      so its preview silently clips content and misleads. `sips` supersedes it
#      on every macOS, so there's no coverage lost by dropping it.
#      The SVG is always written; the PNG is a convenience and is skipped with a
#      note if neither renderer is present (open the SVG in a browser instead).
#
# Why eyeball it at all: a render is the only way to confirm the headline and
# tagline sit where they should and read against the dark field before the card
# goes out. This is the loop for checking that.
#
# Usage:
#   .skills/scripts/preview_card.sh runs/<run> [--out <dir>]

set -euo pipefail
umask 077

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
	# Print the header block: lines 2 through the first blank line. Robust to the
	# comment growing/shrinking so help never bleeds into the code below.
	sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
	exit 0
fi

RUN_DIR="$1"
shift
OUT_DIR="$RUN_DIR/charts"
# Pass-through --out so the SVG and PNG land together.
prev=""
for a in "$@"; do
	[[ "$prev" == "--out" ]] && OUT_DIR="$a"
	prev="$a"
done

node benchmark/bin/preview_card.js --in "$RUN_DIR" "$@"

SVG="$OUT_DIR/share_card.svg"
PNG="$OUT_DIR/share_card.png"
if [[ ! -f "$SVG" ]]; then
	echo "preview_card: expected $SVG but it was not written" >&2
	exit 1
fi

# Run Chrome inside a stderr-redirected subshell so a headless crash (it
# segfaults on some macOS setups) doesn't leak a "Segmentation fault" line from
# the parent shell's job control — we just fall through to sips.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
chrome_shot() {
	(
		"$CHROME" --headless --no-sandbox --hide-scrollbars \
			--window-size=1200,630 --screenshot="$PNG" \
			"file://$PROJECT_DIR/$SVG" >/dev/null 2>&1
		# Explicit exit keeps this a real subshell: without a second statement
		# bash exec-replaces the subshell with Chrome, and the crash then surfaces
		# from the *parent* shell past this 2>/dev/null. Re-raising it as a normal
		# exit code lets the parent reap a plain non-zero, no job-control line.
		exit $?
	) 2>/dev/null
}
if [[ -x "$CHROME" ]] && chrome_shot && [[ -s "$PNG" ]]; then
	echo "preview_card: rasterized -> $PNG (1200x630, via headless Chrome)"
elif command -v sips >/dev/null 2>&1 && \
	sips -s format png "$SVG" --out "$PNG" >/dev/null 2>&1 && \
	[[ -s "$PNG" ]]; then
	echo "preview_card: rasterized -> $PNG (1200x630, via sips)"
else
	echo "preview_card: no working rasterizer — open $SVG in a browser to view the card."
fi
