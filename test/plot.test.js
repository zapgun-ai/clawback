import {
	tokensSavedChart,
	tokensSavedChartBare,
} from "../benchmark/bin/plot.js";

// plot.js is the marketing chart generator. It writes two SVGs from one run:
//   tokens_saved.svg     the labeled on-screen chart (legend, axes, ticks)
//   tokens_saved.bg.svg  the BARE share-card background — two lines + the
//                        filled wedge between them, nothing else
// These cover the pure SVG-string output. The chart no longer carries a reclaim
// callout (the report hero overlay owns that figure, so a chart copy only
// collides with it). Rasterizing the bare chart to a PNG background is
// browser-side (share_card) and is exercised in the report_dom wiring test.

function rows() {
	return [
		{
			ts: "2026-05-29T17:17:01Z",
			arm: "passthrough",
			input_tokens: "16000",
			cache_creation_tokens: "500",
		},
		{
			ts: "2026-05-29T17:20:18Z",
			arm: "passthrough",
			input_tokens: "16000",
			cache_creation_tokens: "500",
		},
		{
			ts: "2026-05-29T17:21:18Z",
			arm: "treatment",
			input_tokens: "400",
			cache_creation_tokens: "100",
		},
		{
			ts: "2026-05-29T17:22:18Z",
			arm: "treatment",
			input_tokens: "400",
			cache_creation_tokens: "100",
		},
	];
}

describe("tokensSavedChart (labeled, on-screen)", () => {
	test("keeps legend, axes, and title but carries NO reclaim callout", () => {
		const svg = tokensSavedChart({ rows: rows() });
		// The labeled furniture stays.
		expect(svg).toContain("passthrough (baseline)");
		expect(svg).toContain("cumulative billable input tokens");
		expect(svg).toContain("Token Efficiency");
		// The callout is gone — the hero overlay owns that figure now.
		expect(svg).not.toContain("tokens/turn reclaimed");
		expect(svg).not.toContain("less/turn");
	});

	test("uses the DESIGN green/amber state anchors and the sans/mono stacks", () => {
		const svg = tokensSavedChart({ rows: rows() });
		expect(svg).toContain("#1a5c3f"); // clawback = working (green)
		expect(svg).toContain("#8a4e0a"); // passthrough = baseline (amber)
		expect(svg).toContain("Helvetica"); // DESIGN sans (prose/labels)
		expect(svg).toContain("ui-monospace"); // DESIGN mono (numerics)
		// The pre-DESIGN brand teal / orange are gone.
		expect(svg).not.toContain("#0aa3a3");
		expect(svg).not.toContain("#d9772b");
	});

	test("fills the wedge green when clawback spends fewer billable tokens", () => {
		// rows(): treatment cumulative ends well below passthrough — a real saving,
		// so the honest fill is green and never red. The wedge is painted with a
		// shadowed light→dark gradient, so the polygon's fill is a url(#…) handle
		// and the green DESIGN anchor lives on the gradient's lit top stop.
		const svg = tokensSavedChart({ rows: rows() });
		expect(svg).toContain('fill="url(#'); // gradient-filled wedge
		expect(svg).toContain('stop-color="#1a5c3f"'); // green at the lit top edge
		expect(svg).not.toContain("#d11a2a"); // no regression red anywhere
	});

	test("fills the wedge red when clawback spends MORE billable tokens (honest regression)", () => {
		// Invert the fixture: passthrough is cheap, treatment (clawback) burns far
		// more billable input, so its cumulative line ends ABOVE passthrough. That is
		// clawback doing worse, and the wedge must be red — we don't hide a loss.
		const regressed = [
			{
				ts: "2026-05-29T17:17:01Z",
				arm: "passthrough",
				input_tokens: "400",
				cache_creation_tokens: "100",
			},
			{
				ts: "2026-05-29T17:20:18Z",
				arm: "passthrough",
				input_tokens: "400",
				cache_creation_tokens: "100",
			},
			{
				ts: "2026-05-29T17:21:18Z",
				arm: "treatment",
				input_tokens: "16000",
				cache_creation_tokens: "500",
			},
			{
				ts: "2026-05-29T17:22:18Z",
				arm: "treatment",
				input_tokens: "16000",
				cache_creation_tokens: "500",
			},
		];
		const svg = tokensSavedChart({ rows: regressed });
		expect(svg).toContain('fill="url(#'); // gradient-filled wedge
		expect(svg).toContain('stop-color="#d11a2a"'); // honest red at the lit top edge
	});

	test("splits the wedge at a crossing — red where clawback is worse, green where better", () => {
		// The curves cross: at turn 0 clawback's cumulative billable input sits
		// ABOVE passthrough (a regression, red), then turn 1 pulls it BELOW (a
		// saving, green). The honest fill must carry BOTH colours, split at the
		// crossing — not one flat verdict that hides half the story.
		const crossing = [
			{
				ts: "2026-05-29T17:17:01Z",
				arm: "passthrough",
				input_tokens: "1000",
				cache_creation_tokens: "0",
			},
			{
				ts: "2026-05-29T17:20:18Z",
				arm: "passthrough",
				input_tokens: "10000",
				cache_creation_tokens: "0",
			},
			{
				ts: "2026-05-29T17:21:18Z",
				arm: "treatment",
				input_tokens: "5000",
				cache_creation_tokens: "0",
			},
			{
				ts: "2026-05-29T17:22:18Z",
				arm: "treatment",
				input_tokens: "1000",
				cache_creation_tokens: "0",
			},
		];
		const svg = tokensSavedChart({ rows: crossing });
		expect(svg).toContain('stop-color="#d11a2a"'); // red region (clawback above)
		expect(svg).toContain('stop-color="#1a5c3f"'); // green region (clawback below)
	});
});

describe("tokensSavedChartBare (share-card background)", () => {
	test("is a 1200×630 DARK card with only the two bright lines + filled wedge", () => {
		const svg = tokensSavedChartBare({ rows: rows() });
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain('width="1200"');
		expect(svg).toContain('height="630"');
		// Dark field, not white: it is composed under the card's dark scrim, so a
		// flat scrim over a white field would crush the lines (WCAG 1.4.11) — see
		// test/report_share.test.js. Bright DESIGN accents read on the dark field.
		expect(svg).toContain('fill="#0b0f14"'); // dark field
		expect(svg).not.toContain('fill="#ffffff"'); // never the old white field
		// Both curves, drawn thick so they survive the scrim + downscale.
		expect(svg).toContain("#3fb950"); // clawback line (bright green)
		expect(svg).toContain("#d29922"); // passthrough line (bright amber)
		expect(svg).toContain('stroke-width="5"');
		// The filled wedge between them — a gradient COLOUR ramp (bright green top →
		// dark green bottom) at high, roughly-constant opacity, NOT a single flat
		// polygon opacity and NOT an opacity ramp toward transparent. On the dark
		// field the visible mass of the wedge is its lower band; fading that toward
		// transparent dissolved it into the near-black card (the ramp vanished), so
		// the bottom stop stays opaque enough to render and the colour does the depth.
		expect(svg).toContain("<polygon");
		expect(svg).toContain('fill="url(#'); // gradient handle, not a flat colour
		expect(svg).toContain('stop-opacity="0.900"'); // lit bright-green top
		expect(svg).toContain('stop-opacity="0.630"'); // dark-green bottom, still present
		// No flat per-polygon opacity — it would double-attenuate and re-crush the ramp.
		expect(svg).not.toMatch(/<polygon[^>]*\sopacity=/);
	});

	test("carries no text at all — no axes, legend, ticks, title, or callout", () => {
		const svg = tokensSavedChartBare({ rows: rows() });
		// A single strong assertion: the bare card background has zero <text>.
		expect(svg).not.toContain("<text");
		expect(svg).not.toContain("tokens/turn reclaimed");
		expect(svg).not.toContain("passthrough (baseline)");
	});

	test("dashes the passthrough baseline only, leaving the clawback line solid", () => {
		const svg = tokensSavedChartBare({ rows: rows() });
		// Exactly one dashed stroke — the passthrough baseline reads as the
		// reference; the clawback line stays solid as the subject.
		expect((svg.match(/stroke-dasharray=/g) ?? []).length).toBe(1);
		// And it's the amber baseline path that carries the dash.
		expect(svg).toMatch(/stroke="#d29922"[^>]*stroke-dasharray=/);
		// The green clawback line is not dashed.
		expect(svg).not.toMatch(/stroke="#3fb950"[^>]*stroke-dasharray=/);
	});

	test("lays a wide, low-opacity, same-hue glow UNDER each crisp line (luminous thread)", () => {
		// Each curve is drawn twice: a wide (2.8×), low-opacity, SOLID pass of the
		// same hue laid first as a soft halo, then the crisp line on top — so the
		// curve reads as a glowing thread of light, not a flat stroke. The glow is a
		// plain <path> (NOT an SVG <filter>), which matters: extractBgShapes carries
		// polygons/paths onto the share card but strips chart-side <filter> defs, so
		// only a filterless glow survives the splice. strokeW is 5 for the bare card,
		// so the halo pass is 5 × 2.8 = 14.0 wide at 0.25 opacity.
		const svg = tokensSavedChartBare({ rows: rows() });
		expect(svg).toMatch(
			/stroke="#3fb950"[^>]*stroke-width="14\.0"[^>]*opacity="0\.25"/,
		); // green clawback glow
		expect(svg).toMatch(
			/stroke="#d29922"[^>]*stroke-width="14\.0"[^>]*opacity="0\.25"/,
		); // amber baseline glow
		// The glow passes are SOLID — the single dash (asserted above) is the crisp
		// baseline, so the halo stays a continuous ribbon under the dashes.
		expect(svg).not.toMatch(/stroke-width="14\.0"[^>]*stroke-dasharray=/);
	});
});
