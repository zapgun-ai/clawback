#!/usr/bin/env node
/**
 * clawback share-card preview (DEV TOOLING — not shipped in the npm tarball).
 *
 * Composes the social share card for a finished run so it can be eyeballed
 * without the browser: it reads the run's summary.json (-> deriveHeroModel) and
 * writes the composed card to charts/share_card.svg. It also splices in the
 * run's cumulative-token graph (charts/tokens_saved.bg.svg, best-effort) behind
 * the text — exactly what the report GUI now shows and rasterizes, so the
 * preview matches the shipped card including the graph.
 *
 * Why SVG, not PNG: the shipped PNG is rasterized BROWSER-side from this exact
 * SVG (share_card.js svgToPngBlob, via canvas). A Node rasterizer would pull a
 * native dependency the product deliberately avoids. The composed SVG is a
 * faithful proxy — the PNG is just the browser's raster of this same SVG.
 *
 * Usage:
 *   node benchmark/bin/preview_card.js --in runs/<run> [--out <dir>]
 */

import fs from "node:fs";
import path from "node:path";
import {
	deriveHeroModel,
	extractBgShapes,
	shareCardSvg,
} from "../../src/report_ui/share_card.js";

// The bare chart plot.js writes alongside the labeled one (just the curves +
// wedge on the card's dark field). Mirrors report.js BG_CHART so the preview
// composes the same card the browser does.
const BG_CHART = "tokens_saved.bg.svg";

const HELP = `clawback share-card preview (dev tooling)

  node benchmark/bin/preview_card.js --in runs/<run> [--out <dir>]

Reads <run>/summary.json, then writes the composed share card to
<out>/share_card.svg (default <run>/charts). Open the SVG to eyeball the card —
the shipped PNG is the browser's raster of this same composition.`;

function parseArgs(argv) {
	const out = { in: null, out: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--in") out.in = argv[++i];
		else if (argv[i] === "--out") out.out = argv[++i];
		else if (argv[i] === "-h" || argv[i] === "--help") out.help = true;
	}
	return out;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.in) {
		console.log(HELP);
		process.exit(args.help ? 0 : 2);
	}

	const runDir = path.resolve(args.in);
	const summaryPath = path.join(runDir, "summary.json");

	if (!fs.existsSync(summaryPath)) {
		console.error(
			`preview_card: no summary.json in ${runDir} — analyze the run first (.skills/finish).`,
		);
		process.exit(1);
	}

	const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
	const model = deriveHeroModel(summary);

	// Splice in the cumulative-token graph behind the text, best-effort — same as
	// the browser (report.js loadBgShapes). The bare chart lives in the run's
	// charts dir; if it's absent the card just falls back to its solid field.
	const bgPath = path.join(runDir, "charts", BG_CHART);
	if (fs.existsSync(bgPath)) {
		model.bgShapes = extractBgShapes(fs.readFileSync(bgPath, "utf8"));
	}

	const svg = shareCardSvg(model);
	const outDir = path.resolve(args.out ?? path.join(runDir, "charts"));
	fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, "share_card.svg");
	// Owner-only, matching clawback's 0600 log/report posture.
	fs.writeFileSync(outPath, svg, { mode: 0o600 });

	console.log(`preview_card: wrote ${outPath}`);
	console.log(
		"preview_card: open it to eyeball the card (the shipped PNG is the browser raster of this exact SVG).",
	);
}

main();
