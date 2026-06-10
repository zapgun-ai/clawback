import {
	CALLOUT_GLOSS,
	CARD_BG,
	CARD_H,
	CARD_W,
	COOL_SHADOW,
	LENS_CORE,
	OG_ENDPOINT,
	SHARE_TIERS,
	bragText,
	bskyIntentUrl,
	buildSharePayload,
	cardFilename,
	cardImageUrl,
	cardPageUrl,
	coronaCoolFor,
	deriveHeroModel,
	extractBgShapes,
	shareCardSvg,
	telegramIntentUrl,
	whatsappIntentUrl,
	xIntentUrl,
	xmlEscape,
} from "../src/report_ui/share_card.js";

// share_card.js is the report's build-in-public surface: it turns the on-screen
// headline figure into a 1200×630 PNG share card and the social copy / intent
// URLs behind the X / Bluesky buttons. These cover the pure pieces; svgToPngBlob
// (canvas) is browser-only and exercised in the report_dom wiring test instead.

describe("xmlEscape", () => {
	test("escapes the five markup-significant characters", () => {
		expect(xmlEscape(`<a href="x" &'>`)).toBe(
			"&lt;a href=&quot;x&quot; &amp;&apos;&gt;",
		);
	});

	test("leaves the figure glyphs we actually emit untouched", () => {
		// digits, percent, comma, U+2212 minus, U+2248 almost-equal, en dash.
		expect(xmlEscape("≈ 15,958 −2,001 97% — fewer")).toBe(
			"≈ 15,958 −2,001 97% — fewer",
		);
	});

	test("null / undefined render as empty, never the string 'null'", () => {
		expect(xmlEscape(null)).toBe("");
		expect(xmlEscape(undefined)).toBe("");
	});
});

// A faithful sample of plot.js's bare chart (tokens_saved.bg.svg): the dark
// field, the gradient <defs> the wedge references, the gradient-filled wedge
// polygon, and the two cumulative-curve paths. The gradient defs + polygon +
// paths should survive extraction; the <svg> wrapper and <rect> field must be
// dropped (the card supplies its own field, and a stray full-card rect would
// repaint over everything).
const BARE_CHART = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">',
	'<rect width="1200" height="630" fill="#0b0f14"/>',
	'<defs><linearGradient id="cbwg0" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fb950" stop-opacity="0.900"/><stop offset="1" stop-color="#1c5324" stop-opacity="0.630"/></linearGradient></defs>',
	'<polygon points="64,404.66 1002,184.46 1002,533" fill="url(#cbwg0)"/>',
	'<path d="M64.0 404.7 L1136.0 56.0" fill="none" stroke="#d29922" stroke-width="5" stroke-linejoin="round"/>',
	'<path d="M64.0 533.0 L1002.0 184.5" fill="none" stroke="#3fb950" stroke-width="5" stroke-linejoin="round"/>',
	"</svg>",
].join("");

describe("extractBgShapes", () => {
	test("keeps the gradient defs + plotted polygon/path geometry, drops the wrapper + field rect", () => {
		const shapes = extractBgShapes(BARE_CHART);
		expect(shapes).toContain("<polygon");
		// Both curves survive.
		expect((shapes.match(/<path\b/g) ?? []).length).toBe(2);
		// The wedge gradient survives so its url(#…) fill still resolves once
		// spliced onto the card — without the defs the wedge would paint nothing.
		expect(shapes).toContain("<linearGradient");
		expect(shapes).toContain('fill="url(#cbwg0)"');
		expect(shapes).toContain('stop-color="#3fb950"'); // DESIGN green at the lit top
		// The <svg> wrapper and the full-card <rect> field are gone — splicing a
		// 1200×630 rect back in would repaint over the curves and the card text.
		expect(shapes).not.toContain("<svg");
		expect(shapes).not.toContain("<rect");
	});

	test("rejects anything that isn't a self-closing polygon/path (no <image>, <script>)", () => {
		const hostile =
			'<image href="x.png"/><script>alert(1)</script><polygon points="0,0"/>';
		const shapes = extractBgShapes(hostile);
		// The one legitimate shape is kept; the canvas-tainting / script tags aren't.
		expect(shapes).toBe('<polygon points="0,0"/>');
		expect(shapes).not.toContain("<image");
		expect(shapes).not.toContain("<script");
	});

	test("rejects a <defs> block wholesale when it hides anything beyond gradient paint servers", () => {
		// A defs block that smuggles a canvas-tainting <image> alongside a gradient
		// must be dropped ENTIRELY — we never cherry-pick the safe gradient out of a
		// block that also carries something we don't trust.
		const hostile = [
			"<defs>",
			'<linearGradient id="cbwg0"><stop offset="0" stop-color="#3fb950"/></linearGradient>',
			'<image href="x.png"/>',
			"</defs>",
			'<polygon points="0,0" fill="url(#cbwg0)"/>',
		].join("");
		const shapes = extractBgShapes(hostile);
		// The bare polygon survives; the whole defs block (gradient included) is gone.
		expect(shapes).toBe('<polygon points="0,0" fill="url(#cbwg0)"/>');
		expect(shapes).not.toContain("<image");
		expect(shapes).not.toContain("<defs");
		expect(shapes).not.toContain("<linearGradient");
	});

	test("empty / garbage / nullish input yields an empty string (card falls back to solid)", () => {
		expect(extractBgShapes("")).toBe("");
		expect(extractBgShapes("no shapes here")).toBe("");
		expect(extractBgShapes(null)).toBe("");
		expect(extractBgShapes(undefined)).toBe("");
	});
});

describe("bragText", () => {
	test("a real win brags the percentage", () => {
		expect(bragText({ pct: 96.77, reclaimedPerTurn: 15958 })).toBe(
			"I just clawback'd 97% of my tokens!",
		);
	});

	test("a tight loop within the dead band reports 'held even' (no over-claim)", () => {
		const t = bragText({ pct: 1.2, reclaimedPerTurn: 90 });
		expect(t).toMatch(/held even/);
		expect(t).toMatch(/no token regression/);
		// Never claims a percentage win on a near-zero result.
		expect(t).not.toMatch(/clawback'd/);
	});

	test("a regression states the cost plainly rather than spinning it", () => {
		const t = bragText({ pct: -12, reclaimedPerTurn: -2001 });
		expect(t).toMatch(/12% over passthrough/);
		expect(t).toMatch(/no idle gaps/);
		expect(t).not.toMatch(/clawback'd/);
	});

	test("no percentage available → a neutral, honest fallback", () => {
		expect(bragText({ pct: null, reclaimedPerTurn: null })).toBe(
			"Tuning my Claude Code token spend with clawback.md.",
		);
		expect(bragText()).toBe(
			"Tuning my Claude Code token spend with clawback.md.",
		);
	});
});

describe("intent URLs", () => {
	const brag = "I just clawback'd 97% of my tokens!";

	test("xIntentUrl carries the text verbatim through the share endpoint", () => {
		const u = new URL(xIntentUrl(brag));
		expect(u.origin + u.pathname).toBe("https://twitter.com/intent/tweet");
		expect(u.searchParams.get("text")).toBe(brag);
		expect(u.searchParams.has("url")).toBe(false);
	});

	test("xIntentUrl adds the url param only when a link is supplied", () => {
		const u = new URL(xIntentUrl(brag, "https://example.test/r"));
		expect(u.searchParams.get("url")).toBe("https://example.test/r");
	});

	test("bskyIntentUrl carries the text and folds the link into it", () => {
		const bare = new URL(bskyIntentUrl(brag));
		expect(bare.origin + bare.pathname).toBe("https://bsky.app/intent/compose");
		expect(bare.searchParams.get("text")).toBe(brag);

		const withUrl = new URL(bskyIntentUrl(brag, "https://example.test/r"));
		expect(withUrl.searchParams.get("text")).toBe(
			`${brag} https://example.test/r`,
		);
	});

	test("telegramIntentUrl carries the text and adds url only when supplied", () => {
		const bare = new URL(telegramIntentUrl(brag));
		expect(bare.origin + bare.pathname).toBe("https://t.me/share/url");
		expect(bare.searchParams.get("text")).toBe(brag);
		expect(bare.searchParams.has("url")).toBe(false);

		const withUrl = new URL(telegramIntentUrl(brag, "https://example.test/r"));
		expect(withUrl.searchParams.get("url")).toBe("https://example.test/r");
		expect(withUrl.searchParams.get("text")).toBe(brag);
	});

	test("whatsappIntentUrl carries the text and folds the link into it", () => {
		const bare = new URL(whatsappIntentUrl(brag));
		expect(bare.origin + bare.pathname).toBe("https://wa.me/");
		expect(bare.searchParams.get("text")).toBe(brag);

		const withUrl = new URL(whatsappIntentUrl(brag, "https://example.test/r"));
		expect(withUrl.searchParams.get("text")).toBe(
			`${brag} https://example.test/r`,
		);
	});
});

describe("cardFilename", () => {
	test("a win names the file by the percentage", () => {
		expect(cardFilename({ pct: 96.77, reclaimedPerTurn: 15958 })).toBe(
			"clawback-97pct.png",
		);
	});

	test("near-zero, regression, and no-data fall back to a generic name", () => {
		expect(cardFilename({ pct: 1.2, reclaimedPerTurn: 90 })).toBe(
			"clawback-report.png",
		);
		expect(cardFilename({ pct: -12, reclaimedPerTurn: -2001 })).toBe(
			"clawback-report.png",
		);
		expect(cardFilename({ pct: null, reclaimedPerTurn: null })).toBe(
			"clawback-report.png",
		);
		expect(cardFilename()).toBe("clawback-report.png");
	});
});

describe("shareCardSvg", () => {
	test("is a standalone OG-sized SVG carrying the headline and kicker on a solid card", () => {
		const svg = shareCardSvg({
			headline: "97%",
			kicker: "less billable input per turn vs passthrough",
			tone: "pos",
		});
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain(`width="${CARD_W}"`);
		expect(svg).toContain(`height="${CARD_H}"`);
		expect(CARD_W).toBe(1200);
		expect(CARD_H).toBe(630);
		expect(svg).toContain("97%");
		expect(svg).toContain("less billable input per turn vs passthrough");
		// Solid dark field, no chart behind it: no <image>, the card colour fills.
		expect(svg).not.toContain("<image");
		expect(svg).toContain(`fill="${CARD_BG}"`);
		expect(CARD_BG).toBe("#0b0f14");
	});

	test("renders the kicker verbatim as the card's label", () => {
		const svg = shareCardSvg({
			headline: "97%",
			kicker: "less billable input vs passthrough",
			tone: "pos",
		});
		expect(svg).toContain("less billable input vs passthrough");
	});

	test("the baked gloss is left-set at the 80px top-left inset", () => {
		const svg = shareCardSvg({
			headline: "97%",
			tone: "pos",
			pageGloss: "+175,537 tokens",
		});
		// The callout and the wordmark+kicker signature swapped corners: the gloss sits
		// TOP-LEFT, start-anchored, its left edge at the 80px inset (no panel padding
		// nudging it inward — the user's alignment ask). The headline % is dead-centred
		// and the wordmark+kicker sit bottom-right (end-anchored).
		expect(svg).toMatch(
			/<text x="80"[^>]*text-anchor="start"[^>]*>\+175,537 tokens<\/text>/,
		);
	});

	test("tone selects the accent colour (green win / amber regression / neutral)", () => {
		expect(shareCardSvg({ headline: "97%", tone: "pos" })).toContain("#3fb950");
		expect(shareCardSvg({ headline: "12%", tone: "neg" })).toContain("#d29922");
		expect(shareCardSvg({ headline: "≈ 0%", tone: "even" })).toContain(
			"#e6edf3",
		);
	});

	test("the hero headline is dead-centred and carries a sips-safe duplicate-text halo (stroke copy UNDER the gradient fill)", () => {
		// The halo, restored the sips-SAFE way. A single stroked <text> hollows in the
		// paint-order-blind sips preview the operator eyeballs (the stroke paints over
		// its own fill). So instead we emit TWO elements: a stroke-only copy painted
		// FIRST, then the gradient-filled copy. sips obeys document order BETWEEN
		// elements, so the fill always covers the glyph interior and the stroke
		// survives only as a COOL_SHADOW rim. Lock both halves AND their order. Both
		// copies are dead-centred: text-anchor="middle" at the card's horizontal
		// centre (x=600 on the 1200-wide card).
		const svg = shareCardSvg({ headline: "97%", tone: "pos" });
		// The stroke-only halo copy: centred, fill="none" + the COOL_SHADOW stroke.
		const halo = new RegExp(
			`<text x="600"[^>]*text-anchor="middle"[^>]*fill="none"[^>]*stroke="${COOL_SHADOW}"[^>]*>97%</text>`,
		);
		// The fill copy: centred, the lit hero gradient and NO stroke of its own.
		const fill =
			/<text x="600"[^>]*text-anchor="middle"[^>]*fill="url\(#cbHero\)"(?:(?!stroke=)[^>])*>97%<\/text>/;
		expect(svg).toMatch(halo);
		expect(svg).toMatch(fill);
		// Order is load-bearing: halo must precede fill, or sips hollows the glyphs.
		expect(svg.search(halo)).toBeLessThan(svg.search(fill));
	});

	test("renders the optional subhead under the hero %, dead-centred, with the sips-safe halo (stroke under fill)", () => {
		const svg = shareCardSvg({
			headline: "+97%",
			tone: "pos",
			subhead: "efficiency",
		});
		// Centred at the card's horizontal middle (x=600), stacked under the headline.
		// Same sips-safe duplicate-text pair as the headline/gloss: a stroke-only
		// COOL_SHADOW copy FIRST, then the fill copy on top. The fill is CALLOUT_GLOSS
		// (the supporting near-white tier) with NO stroke of its own — never a second
		// accent, so the green % stays the sole lit signal. Lock both halves AND order.
		const halo = new RegExp(
			`<text x="600"[^>]*text-anchor="middle"[^>]*fill="none"[^>]*stroke="${COOL_SHADOW}"[^>]*>efficiency</text>`,
		);
		const fill = new RegExp(
			`<text x="600"[^>]*text-anchor="middle"[^>]*fill="${CALLOUT_GLOSS}"(?:(?!stroke=)[^>])*>efficiency</text>`,
		);
		expect(svg).toMatch(halo);
		expect(svg).toMatch(fill);
		expect(svg.search(halo)).toBeLessThan(svg.search(fill));
	});

	test("omits the subhead entirely when none is supplied (regardless of tone)", () => {
		// deriveHeroModel hands a subhead only for a positive-% win; the card must
		// compose cleanly without one on every other card (neg / even / no-arms / the
		// token-fallback win), never leaking a stray supporting line.
		for (const tone of ["pos", "neg", "even"]) {
			expect(shareCardSvg({ headline: "−12%", tone })).not.toContain(
				"efficiency",
			);
		}
	});

	test("interpolated text is XML-escaped — a hostile value can't break out", () => {
		const svg = shareCardSvg({
			headline: '"><script>alert(1)</script>',
			kicker: "k",
		});
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("&lt;script&gt;");
	});

	test("bakes the signed gloss left-set at the 80px top-left inset, no framed chip", () => {
		const svg = shareCardSvg({
			headline: "151%",
			kicker: "more billable input vs passthrough",
			tone: "neg",
			pageGloss: "−22,011 tokens",
		});
		// The gloss number's left edge sits at the 80px inset (the user's ask): a
		// left-set <text x="80">, not a padded panel that would push the glyphs inward.
		// (The headline % is dead-centred; the gloss stays top-left as the caption.)
		expect(svg).toMatch(
			/<text x="80"[^>]*text-anchor="start"[^>]*>−22,011 tokens<\/text>/,
		);
		// No framed chip: the opaque rounded panel is gone (it inset the number and
		// boxed the top-left).
		expect(svg).not.toMatch(/<rect[^>]*rx="14"/);
		// The gloss carries the SAME sips-safe duplicate-text halo as the headline: a
		// COOL_SHADOW stroke-only copy painted first, the near-white fill copy on top.
		// A single stroked <text> would hollow the small glyphs in the paint-order-blind
		// sips preview; two ordered elements keep the fill on top in every raster.
		const glossHalo = new RegExp(
			`<text x="80"[^>]*fill="none"[^>]*stroke="${COOL_SHADOW}"[^>]*>−22,011 tokens</text>`,
		);
		const glossFill =
			/<text x="80"[^>]*fill="#fafafa"(?:(?!stroke=)[^>])*>−22,011 tokens<\/text>/;
		expect(svg).toMatch(glossHalo);
		expect(svg).toMatch(glossFill);
		expect(svg.search(glossHalo)).toBeLessThan(svg.search(glossFill));
		// The honest signed gloss rides in the bright callout near-white, so a
		// shared PNG carries its own direction (the minus sign) and never reads as a
		// bare context-free "%".
		expect(svg).toContain(`fill="${CALLOUT_GLOSS}"`);
		expect(svg).toContain("−22,011 tokens");
	});

	test("wraps a long gloss to two lines and ellipsises the overflow", () => {
		const longGloss =
			"This is an intentionally very long gloss sentence that certainly cannot fit on one line and in fact overruns even two full lines of the callout box width here.";
		const svg = shareCardSvg({
			headline: "97%",
			tone: "pos",
			pageGloss: longGloss,
		});
		// Count start-anchored gloss <text> only: the mono wordmark now shares
		// CALLOUT_GLOSS (#fafafa) but is end-set (bottom-right signature), so colour
		// alone over-counts. The gloss is the only start-anchored #fafafa run.
		const glossLines =
			svg.match(
				new RegExp(`text-anchor="start" fill="${CALLOUT_GLOSS}"`, "g"),
			) ?? [];
		// Never more than two gloss lines, and the truncated tail is marked.
		expect(glossLines.length).toBeGreaterThan(0);
		expect(glossLines.length).toBeLessThanOrEqual(2);
		expect(svg).toContain("…");
	});

	test("omits the callout when no gloss is supplied (the card still composes)", () => {
		const svg = shareCardSvg({ headline: "97%", tone: "pos" });
		expect(svg).not.toMatch(/<rect[^>]*rx="14"/);
		// The wordmark+kicker signature is always present (end-anchored, bottom-right);
		// only the callout gloss is start-anchored, so its absence is the honest signal
		// that no callout was composed.
		expect(svg).not.toMatch(/text-anchor="start"/);
		expect(svg).toContain("97%");
	});

	test("a hostile gloss value is XML-escaped inside the callout", () => {
		const svg = shareCardSvg({
			headline: "97%",
			tone: "pos",
			pageGloss: "<script>alert(1)</script>",
		});
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("&lt;script&gt;");
	});

	test("splices the cumulative-token graph behind the text when bgShapes is supplied", () => {
		const bgShapes = extractBgShapes(BARE_CHART);
		const svg = shareCardSvg({
			headline: "97%",
			kicker: "less billable input vs passthrough",
			tone: "pos",
			pageGloss: "+175,537 tokens",
			bgShapes,
		});
		// The graph geometry rides verbatim (native vectors — escaping it would
		// turn the markup into literal text and it'd never render).
		expect(svg).toContain("<polygon");
		expect((svg.match(/<path\b/g) ?? []).length).toBe(2);
		// "under the text": every curve sits BEFORE the accent bar, the wordmark,
		// and the headline in document order, so the text paints on top of the
		// graph rather than behind it.
		const graphAt = svg.indexOf("<polygon");
		expect(graphAt).toBeGreaterThan(-1);
		expect(graphAt).toBeLessThan(svg.indexOf('height="14"')); // accent bar
		expect(graphAt).toBeLessThan(svg.indexOf(">clawback.md<")); // wordmark
		expect(graphAt).toBeLessThan(svg.indexOf("97%")); // headline
	});

	test("paints the graph FORWARD of the darkened backdrop gradients (graph moves toward the viewer)", () => {
		// The redesign pulls the chart visually forward. The backdrop gradients —
		// the aurora wash, the radial vignette, the left→right spotlight scrim, and
		// the bottom scrim — all paint FIRST and were darkened so they recede; the
		// graph curves/wedge then paint OVER them, so the chart reads as the
		// foreground subject. Lock that z-order: every backdrop fill handle precedes
		// the <polygon>. (The companion test above pins the other half — the graph
		// still sits BEHIND the text — so together they bracket it: backdrop < graph
		// < text.)
		const bgShapes = extractBgShapes(BARE_CHART);
		const svg = shareCardSvg({
			headline: "97%",
			tone: "pos",
			pageGloss: "+175,537 tokens",
			bgShapes,
		});
		const graphAt = svg.indexOf("<polygon");
		expect(graphAt).toBeGreaterThan(-1);
		expect(svg.indexOf("url(#cbAurora)")).toBeLessThan(graphAt);
		expect(svg.indexOf("url(#cbVignette)")).toBeLessThan(graphAt);
		expect(svg.indexOf("url(#cbScrimLR)")).toBeLessThan(graphAt);
		expect(svg.indexOf("url(#cbScrimB)")).toBeLessThan(graphAt);
	});

	test("the lensflare core is the deep cool purple, never a white-hot dot", () => {
		// The flare's centre used to be a white-hot (#ffffff) core, which made the
		// card "loud" and pulled the background forward. It's now LENS_CORE — a deep
		// cool purple — so the centre stays dark and the atmosphere reads pushed back.
		// Lock both halves: the purple core is painted, and NO pure white survives
		// anywhere on the card (the only near-white left is the #fafafa wordmark/gloss
		// fill, which is not #ffffff). Purple carries the cool centre so cyan stays
		// reserved for the win-only corona — the card never over-leans on one cool hue.
		const bgShapes = extractBgShapes(BARE_CHART);
		const svg = shareCardSvg({
			headline: "97%",
			tone: "pos",
			pageGloss: "+175,537 tokens",
			bgShapes,
		});
		expect(svg).toContain(`fill="${LENS_CORE}"`);
		expect(svg).not.toContain('fill="#ffffff"');
	});

	test("the cyan corona is win-only; the purple core is tone-independent", () => {
		// coronaCoolFor gates the faint cyan corona to the win card alone (cyan is a
		// cool analogue of the green accent there; on amber/even it would clash). The
		// purple LENS_CORE, by contrast, is the flare's centre on EVERY card — it's
		// atmosphere, not a tone signal — so it must appear regardless of tone.
		const bgShapes = extractBgShapes(BARE_CHART);
		const pos = shareCardSvg({ headline: "+97%", tone: "pos", bgShapes });
		const neg = shareCardSvg({ headline: "−151%", tone: "neg", bgShapes });
		const cyan = coronaCoolFor("pos");
		expect(pos).toContain(`fill="${cyan}"`); // win: corona present
		expect(neg).not.toContain(`fill="${cyan}"`); // regression: no corona
		expect(pos).toContain(`fill="${LENS_CORE}"`); // purple core on both
		expect(neg).toContain(`fill="${LENS_CORE}"`);
	});

	test("omits the graph (solid field) when no bgShapes is supplied", () => {
		const svg = shareCardSvg({ headline: "97%", tone: "pos" });
		expect(svg).not.toContain("<polygon");
		expect(svg).not.toContain("<path");
	});
});

// The subhead is the single source of the "efficiency" line: deriveHeroModel
// decides whether the card gets one, and the user's rule is precise — it shows ONLY
// when the headline is a positive percentage (a real win). A regression, the ≈0%
// dead band, the signed-token fallback (no percentage), and a run with no paired
// arms all get null, so the supporting line never contradicts the figure above it.
describe("deriveHeroModel subhead (positive-% win only)", () => {
	const subheadFor = (tokens) => deriveHeroModel({ tokens }).subhead;

	test("a positive-% win names the gain: 'efficiency'", () => {
		expect(subheadFor({ reclaimedPerTurn: 15958, pctLessPerTurn: 96.77 })).toBe(
			"efficiency",
		);
	});

	test("a regression has no subhead (the percentage is negative)", () => {
		expect(
			subheadFor({ reclaimedPerTurn: -2001, pctLessPerTurn: -12 }),
		).toBeNull();
	});

	test("the ≈0% dead band has no subhead (held even, not a win)", () => {
		expect(
			subheadFor({ reclaimedPerTurn: 90, pctLessPerTurn: 1.2 }),
		).toBeNull();
	});

	test("a win with no percentage available has no subhead (no positive % to name)", () => {
		// pct == null → the headline is the signed-token fallback, not a "+NN%". There
		// is no positive percentage to subhead even though the per-turn rate is a win.
		expect(
			subheadFor({ reclaimedPerTurn: 15958, pctLessPerTurn: null }),
		).toBeNull();
	});

	test("a run with no paired arms has no subhead", () => {
		expect(deriveHeroModel({ tokens: null }).subhead).toBeNull();
		expect(deriveHeroModel(undefined).subhead).toBeNull();
	});
});

// WCAG 2.0 AA contrast for the card's text, tested as a palette guard: each
// glyph colour is checked against the bare #0b0f14 field. The left→right
// spotlight scrim (cbScrimLR, 0.93 opacity at the left edge easing to 0.82 at
// centre) plus the radial vignette bed the TOP-LEFT gloss and the furniture in
// near-black — darker than the bare field — so for those glyphs the field test
// is a conservative floor; the real bed only deepens the contrast. The CENTRED
// headline is the exception: it now sits over the forward graph (bright curves),
// so its separation is carried by the duplicate-text COOL_SHADOW halo plus the
// lensflare bed, not the scrim — the field-ratio check below still stands as a
// palette floor for its fill stops. Every glyph — the tone accents, the dim
// kicker label, the near-white mono wordmark, the bright gloss — is large text
// (≥84px headline, 28–54px furniture, all ≥18pt) and so clears at least the 3:1
// large-text ratio against the field; the gloss is held to the stricter 4.5:1
// normal-text bar so it stays crisp at feed downscale. This guards against a
// future palette tweak quietly dropping a label below readable.
describe("share card text contrast (WCAG, large text ≥3:1 on the solid field)", () => {
	const srgbToLin = (c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const rgb = (h) =>
		[1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
	const lum = ([r, g, b]) =>
		0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
	const ratio = (a, b) => {
		const hi = Math.max(a, b);
		const lo = Math.min(a, b);
		return (hi + 0.05) / (lo + 0.05);
	};
	const vsCard = (fg) => ratio(lum(rgb(fg)), lum(rgb(CARD_BG)));

	test("the three tone accents (headline) clear 3:1 on the card field", () => {
		for (const accent of ["#3fb950", "#d29922", "#e6edf3"]) {
			expect(vsCard(accent)).toBeGreaterThanOrEqual(3);
		}
	});

	test("the kicker label clears 3:1 and the mono wordmark clears 4.5:1 on the card field", () => {
		expect(vsCard("#848b94")).toBeGreaterThanOrEqual(3); // kicker label (brightened 15% toward white)
		expect(vsCard("#fafafa")).toBeGreaterThanOrEqual(4.5); // near-white wordmark
	});

	test("the baked callout gloss clears 4.5:1 (normal text) on the card field", () => {
		// Though the gloss is set large (54px), we hold it to the stricter 4.5:1
		// normal-text ratio so it stays legible after the feed downscales the PNG.
		expect(vsCard(CALLOUT_GLOSS)).toBeGreaterThanOrEqual(4.5);
	});
});

// ─── share-host integration contract (og.clawback.md) ───────────────────────
//
// buildSharePayload is the egress gate: tier filtering happens HERE, client-side,
// BEFORE anything is serialized, so the wire body is the single source of truth
// for what can ever leave the machine. These lock the contract both halves
// (client + the separately-built host) honor — especially the NEVER list, which
// is the privacy promise the UI makes when the user opts in.
describe("buildSharePayload (tier filtering — the egress contract)", () => {
	const model = {
		headline: "+97%",
		kicker: "professional tokenmaxxing",
		subhead: "efficiency",
		tone: "pos",
		pageGloss: "+175,537 tokens",
		pct: 96.77,
		reclaimedPerTurn: 15958,
		reclaimedTotal: 175537,
		bgShapes: "<polygon points='0,0'/>",
	};
	const run = {
		nTurns: 19,
		nPings: 3,
		clawbackVersions: ["0.1.0"],
		pricingHash: "abc",
	};

	test("local / unknown / missing tier → null (the caller must not POST)", () => {
		expect(buildSharePayload(model, { tier: "local" })).toBeNull();
		expect(buildSharePayload(model, { tier: "nope" })).toBeNull();
		expect(buildSharePayload(model, {})).toBeNull();
		// No model → nothing to send.
		expect(buildSharePayload(null, { tier: "full" })).toBeNull();
	});

	test("minimal carries ONLY the card-draw words — no stats, run, handle, or chart", () => {
		const p = buildSharePayload(model, { tier: "minimal", handle: "@x", run });
		expect(Object.keys(p).sort()).toEqual(["card", "tier", "v"]);
		expect(p.v).toBe(1);
		expect(p.tier).toBe("minimal");
		expect(p.card).toEqual({
			headline: "+97%",
			kicker: "professional tokenmaxxing",
			subhead: "efficiency",
			tone: "pos",
			pageGloss: "+175,537 tokens",
		});
		// The chart geometry and everything behind the figures is withheld.
		expect(p.card.bgShapes).toBeUndefined();
		expect(p.stats).toBeUndefined();
		expect(p.run).toBeUndefined();
		expect(p.attribution).toBeUndefined();
	});

	test("full adds the chart, stats, run provenance, and a (trimmed) handle", () => {
		const p = buildSharePayload(model, {
			tier: "full",
			handle: "  @alex  ",
			run,
		});
		expect(p.tier).toBe("full");
		expect(p.card.bgShapes).toBe("<polygon points='0,0'/>");
		expect(p.stats).toEqual({
			pct: 96.77,
			reclaimedPerTurn: 15958,
			reclaimedTotal: 175537,
		});
		expect(p.run).toEqual({
			nTurns: 19,
			nPings: 3,
			clawbackVersions: ["0.1.0"],
			pricingHash: "abc",
		});
		expect(p.attribution).toEqual({ handle: "@alex" });
	});

	test("full without a handle omits attribution (no empty handle on the wire)", () => {
		expect(
			buildSharePayload(model, { tier: "full", handle: "   ", run })
				.attribution,
		).toBeUndefined();
		expect(
			buildSharePayload(model, { tier: "full", run }).attribution,
		).toBeUndefined();
	});

	test("full clamps a long handle to 64 chars", () => {
		const p = buildSharePayload(model, {
			tier: "full",
			handle: `@${"z".repeat(200)}`,
		});
		expect(p.attribution.handle.length).toBe(64);
	});

	test("full without a run object omits run (run is optional provenance)", () => {
		expect(buildSharePayload(model, { tier: "full" }).run).toBeUndefined();
	});

	test("non-finite stats serialize as null, never NaN/Infinity (valid JSON)", () => {
		const p = buildSharePayload(
			{
				...model,
				pct: Number.NaN,
				reclaimedPerTurn: Number.POSITIVE_INFINITY,
				reclaimedTotal: null,
			},
			{ tier: "full" },
		);
		expect(p.stats).toEqual({
			pct: null,
			reclaimedPerTurn: null,
			reclaimedTotal: null,
		});
		// And it round-trips through JSON without becoming the string "null"-ish junk.
		expect(JSON.parse(JSON.stringify(p)).stats.pct).toBeNull();
	});

	test("clawbackVersions is coerced to an array of strings (never trusts the shape)", () => {
		const p = buildSharePayload(model, {
			tier: "full",
			run: { ...run, clawbackVersions: [1, 2] },
		});
		expect(p.run.clawbackVersions).toEqual(["1", "2"]);
		const p2 = buildSharePayload(model, {
			tier: "full",
			run: { ...run, clawbackVersions: "0.1.0" },
		});
		expect(p2.run.clawbackVersions).toEqual([]); // non-array → empty, never a stray string
	});

	test("NEVER serializes prompts / code / paths / email / keys — only whitelisted keys appear", () => {
		// A model salted with everything the privacy promise forbids. buildSharePayload
		// copies only named fields, so none of these can ride along even on the most
		// permissive tier.
		const hostile = {
			...model,
			prompt: "SECRET_PROMPT_TEXT",
			code: "rm -rf /tmp/x",
			filePath: "/home/me/project/secret.js",
			email: "alex@example.com",
			gitUser: "alex@mini",
			apiKey: "sk-ant-LEAK",
			sessionKey: "deadbeefcafe",
			ip: "10.0.0.9",
		};
		const p = buildSharePayload(hostile, { tier: "full", handle: "@x", run });
		const json = JSON.stringify(p);
		for (const leak of [
			"SECRET_PROMPT_TEXT",
			"rm -rf",
			"/home/me",
			"secret.js",
			"alex@example.com",
			"alex@mini",
			"sk-ant-LEAK",
			"deadbeefcafe",
			"10.0.0.9",
			"prompt",
			"filePath",
			"apiKey",
			"sessionKey",
			"gitUser",
		]) {
			expect(json).not.toContain(leak);
		}
		// The top-level and card key sets are exactly the contract's — nothing extra.
		expect(Object.keys(p).sort()).toEqual([
			"attribution",
			"card",
			"run",
			"stats",
			"tier",
			"v",
		]);
		expect(Object.keys(p.card).sort()).toEqual([
			"bgShapes",
			"headline",
			"kicker",
			"pageGloss",
			"subhead",
			"tone",
		]);
	});
});

describe("cardImageUrl / cardPageUrl (resolving the host response)", () => {
	test("cardImageUrl prefers a server-absolute image URL", () => {
		expect(cardImageUrl({ id: "u1", image: "https://cdn.test/x.png" })).toBe(
			"https://cdn.test/x.png",
		);
	});

	test("cardImageUrl builds <base>/<id>.png from the id, percent-encoding it", () => {
		expect(cardImageUrl({ id: "u1" })).toBe("https://og.clawback.md/u1.png");
		expect(cardImageUrl({ id: "a b/c" })).toBe(
			`https://og.clawback.md/${encodeURIComponent("a b/c")}.png`,
		);
	});

	test("cardImageUrl honours a custom base and trims its trailing slash", () => {
		expect(cardImageUrl({ id: "u1" }, "https://staging.test/")).toBe(
			"https://staging.test/u1.png",
		);
	});

	test("cardImageUrl → '' when nothing usable (caller falls back to a local save)", () => {
		expect(cardImageUrl(null)).toBe("");
		expect(cardImageUrl({})).toBe("");
		expect(cardImageUrl({ id: 123 })).toBe(""); // non-string id ignored
	});

	test("cardPageUrl prefers a server page URL, else builds <base>/<id>", () => {
		expect(cardPageUrl({ id: "u1", page: "https://og.clawback.md/p/u1" })).toBe(
			"https://og.clawback.md/p/u1",
		);
		expect(cardPageUrl({ id: "u1" })).toBe("https://og.clawback.md/u1");
		expect(cardPageUrl({})).toBe("");
	});

	test("OG_ENDPOINT is the default host; SHARE_TIERS lists the tiers low→high egress", () => {
		expect(OG_ENDPOINT).toBe("https://og.clawback.md");
		expect(SHARE_TIERS).toEqual(["local", "minimal", "full"]);
	});
});
