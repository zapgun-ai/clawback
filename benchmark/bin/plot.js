#!/usr/bin/env node
/**
 * clawback benchmark chart generator.
 *
 * Reads an analyzer --out directory (summary.json + report.csv) and writes two
 * standalone, dependency-free SVGs:
 *
 *   tokens_saved.svg     the labeled on-screen chart: two cumulative
 *                        billable-input lines (passthrough baseline vs
 *                        clawback) with the wedge between them shaded — green
 *                        when clawback saved tokens, red when it spent more.
 *                        Legend, axes, ticks, endpoint labels; no callout (the
 *                        report's hero overlay owns the headline figure).
 *   tokens_saved.bg.svg  the BARE 1200×630 share-card background: the same two
 *                        lines + shaded wedge, nothing else (no text/axes).
 *
 * One story on purpose: "how efficiently did your tokens go vs passthrough" —
 * the net full-rate input tokens clawback saved (or, honestly, spent extra).
 * Not a dashboard, not a dollar figure. Cost lives in the analyzer's report.md
 * appendix; it is never plotted here.
 *
 * Usage:
 *   node benchmark/bin/plot.js --in <analyzerOutDir> --out <chartsDir>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 760;
const H = 440;
const M = { top: 82, right: 24, bottom: 72, left: 88 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

// Palette + type from DESIGN.md. The chart canvas is white (a "light document"
// that also serves as the share-card background under a scrim), so DESIGN's
// state anchors read AA on it: green = clawback working, amber = baseline/
// passthrough. Prose uses the sans stack; anything numeric uses mono (tnum).
const COLOR_BASE = "#8a4e0a"; // passthrough (baseline/off) — DESIGN amber
const COLOR_TREAT = "#1a5c3f"; // clawback (working/on) — DESIGN green
const COLOR_SHADE = "#1a5c3f"; // reclaimed area (translucent green)
const COLOR_NEG = "#d11a2a"; // regression area (translucent red) — DESIGN error
const INK = "#0a0a0a"; // DESIGN light-theme text
const MUTED = "#3a3a3a"; // DESIGN light-theme muted
const RULE = "#a8a39a"; // DESIGN light-theme border (grid/axes)
const SANS = "Helvetica, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, monospace";

function parseArgs(argv) {
	const out = { in: null, out: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--in") out.in = argv[++i];
		else if (argv[i] === "--out") out.out = argv[++i];
		else if (argv[i] === "-h" || argv[i] === "--help") out.help = true;
	}
	return out;
}

function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function fmtTok(n) {
	if (n == null || !Number.isFinite(n)) return "n/a";
	const a = Math.abs(n);
	if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

// ---- tiny SVG builder -------------------------------------------------

function svgDoc(title, subtitle, body) {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">`,
		`<rect width="${W}" height="${H}" fill="#ffffff"/>`,
		`<text x="${W / 2}" y="28" text-anchor="middle" font-size="17" font-weight="600" fill="${INK}">${esc(title)}</text>`,
		subtitle
			? `<text x="${W / 2}" y="48" text-anchor="middle" font-size="12" fill="${MUTED}">${esc(subtitle)}</text>`
			: "",
		body,
		"</svg>",
		"",
	].join("\n");
}

function axes(xLabel, yLabel) {
	const x0 = M.left;
	const y0 = M.top + PLOT_H;
	return [
		`<line x1="${x0}" y1="${M.top}" x2="${x0}" y2="${y0}" stroke="${MUTED}" stroke-width="1"/>`,
		`<line x1="${x0}" y1="${y0}" x2="${M.left + PLOT_W}" y2="${y0}" stroke="${MUTED}" stroke-width="1"/>`,
		`<text x="${M.left + PLOT_W / 2}" y="${H - 10}" text-anchor="middle" font-size="12" fill="${MUTED}">${esc(xLabel)}</text>`,
		`<text transform="translate(20 ${M.top + PLOT_H / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${MUTED}">${esc(yLabel)}</text>`,
	].join("\n");
}

function yTicks(maxY, fmt) {
	const x0 = M.left;
	const y0 = M.top + PLOT_H;
	const parts = [];
	const N = 5;
	for (let i = 0; i <= N; i++) {
		const v = (maxY * i) / N;
		const y = y0 - (PLOT_H * i) / N;
		parts.push(
			`<line x1="${x0}" y1="${y}" x2="${M.left + PLOT_W}" y2="${y}" stroke="${RULE}" stroke-width="1" opacity="0.5"/>`,
		);
		parts.push(
			`<text x="${x0 - 8}" y="${y + 4}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${MUTED}">${esc(fmt(v))}</text>`,
		);
	}
	return parts.join("\n");
}

function xTicks(maxN) {
	const x0 = M.left;
	const y0 = M.top + PLOT_H;
	const parts = [];
	for (let i = 0; i <= 5; i++) {
		const xv = Math.round(((maxN - 1) * i) / 5);
		const x = x0 + (PLOT_W * i) / 5;
		parts.push(
			`<text x="${x}" y="${y0 + 16}" text-anchor="middle" font-family="${MONO}" font-size="10" fill="${MUTED}">${xv}</text>`,
		);
	}
	return parts.join("\n");
}

function legend(series) {
	const parts = [];
	let x = M.left;
	const y = M.top - 12;
	for (let i = 0; i < series.length; i++) {
		const { label, color } = series[i];
		parts.push(
			`<rect x="${x}" y="${y - 9}" width="12" height="12" fill="${color}"/>`,
		);
		parts.push(
			`<text x="${x + 16}" y="${y + 1}" font-size="11" fill="${MUTED}">${esc(label)}</text>`,
		);
		x += 26 + label.length * 6.6;
	}
	return parts.join("\n");
}

// ---- data loading -----------------------------------------------------

function loadSummary(dir) {
	return JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
}

function loadCsv(dir) {
	const text = fs.readFileSync(path.join(dir, "report.csv"), "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	if (lines.length === 0) return [];
	const header = lines[0].split(",");
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const cells = splitCsv(lines[i]);
		const r = {};
		for (let j = 0; j < header.length; j++) r[header[j]] = cells[j];
		rows.push(r);
	}
	return rows;
}

function splitCsv(line) {
	const out = [];
	let cur = "";
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (c === '"') q = false;
			else cur += c;
		} else if (c === '"') q = true;
		else if (c === ",") {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	out.push(cur);
	return out;
}

// ---- the one chart ----------------------------------------------------

function cumulativeBillable(rows) {
	let s = 0;
	return rows.map((r) => {
		s += (Number(r.input_tokens) || 0) + (Number(r.cache_creation_tokens) || 0);
		return s;
	});
}

// Split rows into the two arms — passthrough baseline vs everything else — and
// return their cumulative billable-input series, each sorted by timestamp.
function armCumulatives(rows) {
	const sortTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
	const base = rows.filter((r) => r.arm === "passthrough").sort(sortTs);
	const treat = rows
		.filter((r) => r.arm && r.arm !== "passthrough")
		.sort(sortTs);
	return {
		baseCum: cumulativeBillable(base),
		treatCum: cumulativeBillable(treat),
	};
}

// ---- wedge fill: per-region honest colour + shadowed gradient ---------

// Parse "#rrggbb" → [r,g,b] (tolerant of a missing leading #).
function hexRgb(h) {
	const s = String(h).replace(/^#/, "");
	return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
}

// Mix a hex colour `amt` (0..1) of the way toward `target` ("#000"/"#fff"),
// returning "#rrggbb". Used to darken a base accent into its shadowed bottom.
function mixHex(hex, target, amt) {
	const a = hexRgb(hex);
	const b = hexRgb(target);
	const c = a.map((v, i) => Math.round(v + (b[i] - v) * amt));
	return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// A vertical light→dark gradient for one wedge region: the base accent at the
// lit top edge, a darkened shade at the shadowed bottom, so the filled area
// reads as a shadowed body rather than a flat slab. objectBoundingBox units
// (the default) so it spans each polygon's own height. The top stop keeps the
// base hex verbatim, so the chart's DESIGN anchor colour is still present.
//
// `peak` controls how the alpha is applied:
//   null  — opaque two-stop ramp; the caller flattens the whole polygon with one
//           `opacity` (the labeled white-field chart, unchanged).
//   number — a luminous THREE-stop COLOUR ramp at high opacity, so the wedge
//           reads as a lit body of light rather than a flat slab. A white-tinted
//           highlight blazes at the lit top edge (peak), the base hue carries the
//           midtone, and a dark shadow grounds the bottom — kept opaque enough to
//           RENDER (peak·0.7), never faded toward transparent. The bare share-card
//           sits on the dark #0b0f14 field and the visible mass of the thin
//           diagonal wedge is its lower band; an *opacity* ramp toward transparent
//           there just dissolves into the near-black card, so the depth has to be
//           a *colour* ramp at high, roughly-constant opacity. The base hue stays
//           present at the midtone so the chart's DESIGN anchor is intact.
function wedgeGradient(id, color, peak) {
	if (peak == null) {
		const dark = mixHex(color, "#000000", 0.5);
		return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`;
	}
	const lit = mixHex(color, "#ffffff", 0.3);
	const dark = mixHex(color, "#000000", 0.55);
	return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lit}" stop-opacity="${peak.toFixed(3)}"/><stop offset="0.5" stop-color="${color}" stop-opacity="${(peak * 0.85).toFixed(3)}"/><stop offset="1" stop-color="${dark}" stop-opacity="${(peak * 0.7).toFixed(3)}"/></linearGradient>`;
}

// Split the wedge between the two cumulative curves into maximal same-sign
// regions: clawback (treatment) ABOVE passthrough means it spent MORE cumulative
// billable tokens — a regression, filled red — and BELOW means it saved, filled
// green. A pinch vertex is inserted at each crossing (where the curves meet) so
// neighbouring regions share that point. Pure (non-crossing) data collapses to a
// single region — the long-standing behaviour — so existing charts are
// unchanged. Returns [{ color, points }] in left-to-right order.
function wedgeRegions({ baseCum, treatCum, xAt, yAt, minN, shade, neg }) {
	const nodes = [];
	for (let i = 0; i < minN; i++) {
		nodes.push({ xi: i, base: baseCum[i], treat: treatCum[i] });
		if (i < minN - 1) {
			const g0 = treatCum[i] - baseCum[i];
			const g1 = treatCum[i + 1] - baseCum[i + 1];
			if ((g0 < 0 && g1 > 0) || (g0 > 0 && g1 < 0)) {
				const t = g0 / (g0 - g1); // in (0,1): the fractional crossing index
				const v = baseCum[i] + t * (baseCum[i + 1] - baseCum[i]); // base == treat
				nodes.push({ xi: i + t, base: v, treat: v });
			}
		}
	}
	const signOf = (n) => Math.sign(n.treat - n.base);
	const regions = [];
	let run = [];
	let runSign = 0;
	const flush = () => {
		if (run.length >= 2 && runSign !== 0) {
			const top = run.map(
				(n) => `${xAt(n.xi).toFixed(1)},${yAt(n.base).toFixed(1)}`,
			);
			const bot = run
				.slice()
				.reverse()
				.map((n) => `${xAt(n.xi).toFixed(1)},${yAt(n.treat).toFixed(1)}`);
			regions.push({
				color: runSign > 0 ? neg : shade,
				points: top.concat(bot).join(" "),
			});
		}
	};
	for (const n of nodes) {
		const s = signOf(n);
		if (runSign === 0) {
			runSign = s;
			run.push(n);
		} else if (s === runSign) {
			run.push(n);
		} else if (s === 0) {
			run.push(n); // crossing pinch: close this region here, reseed from it
			flush();
			run = [n];
			runSign = 0;
		} else {
			flush(); // opposite sign on an exact-zero integer node
			run = [n];
			runSign = s;
		}
	}
	flush();
	return regions;
}

// The reclaim silhouette shared by both charts: the translucent fill between the
// two cumulative curves over their matched prefix, plus the two lines on top.
// The caller supplies the scale fns, stroke width, fill opacity, an optional
// `palette` (defaults to the light-theme DESIGN anchors; the bare share-card
// variant passes its bright on-dark palette), and an optional `gradient` flag
// (fill each wedge region with a shadowed light→dark gradient instead of a flat
// colour). axes/labels/legend (if any) are the caller's business. Returns an
// array of SVG fragments in paint order: gradient <defs> (if any), then the
// region fills, then the two lines.
function reclaimShapes({
	baseCum,
	treatCum,
	xAt,
	yAt,
	strokeW,
	fillOpacity,
	palette,
	gradient,
	gradientPeak,
	glow,
}) {
	const base = palette?.base ?? COLOR_BASE;
	const treat = palette?.treat ?? COLOR_TREAT;
	const shade = palette?.shade ?? COLOR_SHADE;
	const neg = palette?.neg ?? COLOR_NEG;
	const defs = [];
	const fills = [];
	const minN = Math.min(baseCum.length, treatCum.length);
	if (minN >= 2) {
		const regions = wedgeRegions({
			baseCum,
			treatCum,
			xAt,
			yAt,
			minN,
			shade,
			neg,
		});
		for (let k = 0; k < regions.length; k++) {
			let fill = regions[k].color;
			let op = ` opacity="${fillOpacity}"`;
			if (gradient) {
				const id = `cbwg${k}`;
				defs.push(wedgeGradient(id, regions[k].color, gradientPeak ?? null));
				fill = `url(#${id})`;
				// When the alpha is baked into the gradient stops (gradientPeak set), a flat
				// polygon opacity on top would double-attenuate and re-crush the ramp — drop it.
				if (gradientPeak != null) op = "";
			}
			fills.push(
				`<polygon points="${regions[k].points}" fill="${fill}"${op}/>`,
			);
		}
	}
	const lineFor = (cum, color, dash) => {
		if (cum.length === 0) return [];
		const d = cum
			.map(
				(v, i) =>
					`${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`,
			)
			.join(" ");
		const dashAttr = dash
			? ` stroke-dasharray="${(strokeW * 3).toFixed(0)} ${(strokeW * 2).toFixed(0)}"`
			: "";
		const segs = [];
		// A soft luminous halo laid UNDER the crisp line: a wide, solid, low-opacity
		// pass of the same hue so the curve reads as a glowing thread of light rather
		// than a plotted data series. Always solid (never dashed) so a dashed baseline
		// still glows as one continuous ribbon. It's a plain <path>, so it survives
		// extractBgShapes into the shipped card.
		if (glow) {
			segs.push(
				`<path d="${d}" fill="none" stroke="${color}" stroke-width="${(strokeW * 2.8).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity="0.25"/>`,
			);
		}
		segs.push(
			`<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linejoin="round"${dashAttr}/>`,
		);
		return segs;
	};
	const out = [];
	if (defs.length) out.push(`<defs>${defs.join("")}</defs>`);
	out.push(...fills);
	// The passthrough baseline is dashed so it reads as the reference; the clawback
	// line stays solid as the subject of the comparison.
	out.push(...lineFor(baseCum, base, true));
	out.push(...lineFor(treatCum, treat));
	return out;
}

// The on-screen chart: the full labeled story (legend, axes, ticks, endpoint
// labels) on a white field. No reclaim callout — the report's hero overlay
// carries the percentage + per-turn rate, so a duplicate on the chart only
// collides with it. The bare variant below is what rides the share card.
function tokensSavedChart({ rows }) {
	const { baseCum, treatCum } = armCumulatives(rows);

	const x0 = M.left;
	const y0 = M.top + PLOT_H;
	const maxN = Math.max(baseCum.length, treatCum.length, 2);
	const maxY = Math.max(1, ...baseCum, ...treatCum);
	const xAt = (i) => x0 + (PLOT_W * i) / (maxN - 1);
	const yAt = (v) => y0 - (PLOT_H * v) / maxY;

	const body = [
		legend([
			{ label: "passthrough (baseline)", color: COLOR_BASE },
			{ label: "clawback", color: COLOR_TREAT },
		]),
		axes("turn", "cumulative billable input tokens"),
		yTicks(maxY, fmtTok),
		xTicks(maxN),
		...reclaimShapes({
			baseCum,
			treatCum,
			xAt,
			yAt,
			strokeW: 2.5,
			fillOpacity: 0.14,
			gradient: true,
		}),
	];

	// Endpoint labels.
	if (baseCum.length) {
		const i = baseCum.length - 1;
		body.push(
			`<text x="${xAt(i) - 4}" y="${yAt(baseCum[i]) - 6}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${COLOR_BASE}">${esc(fmtTok(baseCum[i]))}</text>`,
		);
	}
	if (treatCum.length) {
		const i = treatCum.length - 1;
		body.push(
			`<text x="${xAt(i) + 4}" y="${yAt(treatCum[i]) + 14}" font-family="${MONO}" font-size="10" fill="${COLOR_TREAT}">${esc(fmtTok(treatCum[i]))}</text>`,
		);
	}

	const subtitle =
		"shaded gap = net full-rate input tokens vs passthrough (green = saved, red = spent more)";
	return svgDoc("Token Efficiency", subtitle, body.join("\n"));
}

// The share-card background. Same 1.91:1 frame as the card (1200×630), composed
// full-bleed under the card's dark scrim — so it carries NO axes, legend,
// ticks, labels, or callout: just the two cumulative curves and the filled
// wedge between them (the reclaim silhouette). Thicker strokes and a stronger
// fill so the shape survives the scrim and the downscale. "Only draw the chart
// lines and fill the area between them" — everything else was noise.
//
// Unlike the labeled chart, this variant is DARK-themed: a #0b0f14 field with
// BRIGHT lines. That is forced by WCAG 1.4.11, not a style choice. The card
// paints this chart under a translucent #0b0f14 scrim; a flat scrim over a
// WHITE field compresses every line toward the scrim colour, capping even a
// pure-black line at ~2.58:1 — below the 3:1 floor for graphical objects. A
// dark field instead lets bright DESIGN-accent lines clear 3:1 under the scrim,
// while the headline keeps its contrast because the field is dark either way.
// See test/report_share.test.js for the composited-contrast pins.
const BARE_W = 1200;
const BARE_H = 630;
const BARE_PAD = { top: 56, right: 64, bottom: 56, left: 64 };
export const BARE_BG = "#0b0f14"; // = card bg/scrim → seamless dark field
export const BARE_PALETTE = {
	base: "#d29922", // passthrough — DESIGN bright amber accent
	treat: "#3fb950", // clawback — DESIGN bright green accent
	shade: "#3fb950", // reclaimed wedge (bright green)
	neg: "#ff7b72", // regression wedge (bright red)
};

function tokensSavedChartBare({ rows }) {
	const { baseCum, treatCum } = armCumulatives(rows);
	const plotW = BARE_W - BARE_PAD.left - BARE_PAD.right;
	const plotH = BARE_H - BARE_PAD.top - BARE_PAD.bottom;
	const x0 = BARE_PAD.left;
	const y0 = BARE_PAD.top + plotH;
	const maxN = Math.max(baseCum.length, treatCum.length, 2);
	const maxY = Math.max(1, ...baseCum, ...treatCum);
	const xAt = (i) => x0 + (plotW * i) / (maxN - 1);
	const yAt = (v) => y0 - (plotH * v) / maxY;
	const shapes = reclaimShapes({
		baseCum,
		treatCum,
		xAt,
		yAt,
		strokeW: 5,
		fillOpacity: 0.3,
		palette: BARE_PALETTE,
		gradient: true,
		gradientPeak: 0.9,
		glow: true,
	});
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${BARE_W}" height="${BARE_H}" viewBox="0 0 ${BARE_W} ${BARE_H}">`,
		`<rect width="${BARE_W}" height="${BARE_H}" fill="${BARE_BG}"/>`,
		shapes.join("\n"),
		"</svg>",
		"",
	].join("\n");
}

// ---- main -------------------------------------------------------------

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.in || !args.out) {
		process.stdout.write(
			"usage: node benchmark/bin/plot.js --in <analyzerOutDir> --out <chartsDir>\n",
		);
		process.exit(args.in && args.out ? 0 : 2);
	}
	loadSummary(args.in); // validate the run dir has a summary before plotting
	const rows = loadCsv(args.in);
	fs.mkdirSync(args.out, { recursive: true });

	// The labeled chart for the report page, and the bare ".bg.svg" variant the
	// share card composes as its full-bleed background.
	fs.writeFileSync(
		path.join(args.out, "tokens_saved.svg"),
		tokensSavedChart({ rows }),
	);
	fs.writeFileSync(
		path.join(args.out, "tokens_saved.bg.svg"),
		tokensSavedChartBare({ rows }),
	);

	process.stdout.write(`wrote 2 charts -> ${args.out}\n`);
}

// Run only when invoked as a script; stay import-safe so tests can exercise
// tokensSavedChart() without the file-reading side effects of main().
const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

export { tokensSavedChart, tokensSavedChartBare, fmtTok, esc };
