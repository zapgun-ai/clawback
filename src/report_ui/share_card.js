// Client-side share-card rendering for the benchmark report. No build step, no
// external deps, no network: the card is composed as a self-contained SVG
// string and rasterized to PNG via an offscreen <canvas>, so the operator can
// download it or hand it to the device share sheet. The pure pieces (escaping,
// social copy, intent URLs, the SVG string, the filename) are unit-tested
// directly; svgToPngBlob touches <canvas>/<img>, so it runs in the browser, not
// jsdom.
//
// Build-in-public framing: the headline IS the percentage of full-rate tokens
// reclaimed — the same figure the report hero leads with — so the shared image
// reads "I just clawback'd 15% of my tokens!" without any extra context.

// OpenGraph standard share-image size; X and Bluesky both render this 1.91:1.
export const CARD_W = 1200;
export const CARD_H = 630;

// The card background colour — a solid dark field. It's also the exact plot
// field of the bare chart (plot.js BARE_BG), so when the cumulative-token graph
// is spliced in behind the text the seam is invisible; absent a graph the card
// is just this flat field and the headline keeps full contrast at any downscale.
export const CARD_BG = "#0b0f14";

// The baked-in context gloss colour. The gloss is the honest one-liner — the
// signed run-wide reclaim total — bright and high-contrast so it reads even when
// the PNG is downscaled in a feed. It clears WCAG 4.5:1 (normal text) against
// CARD_BG (asserted in report_share.test.js) on the spotlight scrim's near-black
// bed; it carries the same sips-safe duplicate-text halo as the headline (a
// COOL_SHADOW stroke copy under this fill copy), which only adds a rim and never
// lowers the fill's contrast. It's DESIGN's warm on-surface near-white, not a
// cool grey (DESIGN: "Don't use pure gray; palette is warm-toned").
export const CALLOUT_GLOSS = "#fafafa";

// Cool atmosphere tones for the share card ONLY — never the data legend.
// DESIGN.md's palette is the warm green/amber/red triad with no cool tokens
// ("color carries meaning, never decoration; the palette is warm-toned"), so
// these never touch the shipped dashboard, the tone accent, or the number's
// fill — anything that signals win/loss stays warm. They live only here, on the
// one sanctioned-flashy marketing surface, and only in SHADOW and HAZE.
//
// COOL_SHADOW is a deep desaturated indigo used where the card goes dark — the
// vignette + bottom scrim falloff and the text halo rim. Warm-light/cool-shadow:
// a cool shadow makes the warm-green lensflare read hotter, so the number looks
// more like the light source. It's near-black (low luminance), so it reads as
// "cool-cast dark", not a purple line.
export const COOL_SHADOW = "#0c0a1c";

// A faint cyan corona for the lensflare + aurora — but ONLY on the win (pos)
// card. Cyan is analogous to the green accent there, so it harmonises as the
// cool outer edge of the same light. On the amber regression / neutral cards it
// is near-complementary to the accent and would clash with the tone read, so it
// is tone-gated to null (no corona, accent-hued haze instead).
export function coronaCoolFor(tone) {
	return tone === "pos" ? "#2dd4d8" : null;
}

// The lensflare's central core colour — formerly a white-hot dot. A deep cool
// purple keeps the flare's CENTRE dark rather than blazing white, so the card
// reads calmer and the atmosphere stays pushed back. Purple (not cyan) carries
// the cool centre, so cyan stays reserved for the faint win-only corona and the
// card never over-leans on a single cool hue. It's near COOL_SHADOW in
// luminance, so layered + blurred over the warm rings it cools and gently sinks
// the centre instead of adding a bright spot.
export const LENS_CORE = "#3a2566";

const XML_ESCAPES = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

// XML-escape any value interpolated into the SVG string. The hero figures are
// app-derived (digits, %, commas, the U+2212 minus, "≈"), but we escape
// defensively so a future caller can't smuggle markup into the card.
export function xmlEscape(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

// Pull just the plotted geometry out of a bare chart SVG (the 1200×630
// `tokens_saved.bg.svg` plot.js writes): the filled wedge <polygon>s, the two
// cumulative-curve <path>s, and the gradient <defs> the wedges reference. We
// whitelist *only* those self-closing shape forms — never <image>, <script>,
// <foreignObject>, or anything else with a child — plus a <defs> block that
// holds nothing but <linearGradient>/<stop> paint servers. The wedge fills are
// `url(#…)`, so without their gradient defs the card's graph would lose its
// fill; gradients are inert (no script, no external href) and don't taint the
// canvas, so carrying them is safe. Anything else in the defs block (text,
// <image>, nested elements) fails the whitelist and the whole block is dropped.
// The chart's plot field is the same #0b0f14 as the card, so the shapes drop in
// full-bleed under the text with no scaling or repositioning. Returns "" for
// empty/garbage input, which makes the card fall back to a solid field.
export function extractBgShapes(svgText) {
	const s = String(svgText ?? "");
	const shapes = s.match(/<(?:polygon|path)\b[^>]*\/>/g) ?? [];
	const defs = [];
	for (const block of s.match(/<defs\b[^>]*>[\s\S]*?<\/defs>/g) ?? []) {
		const leftover = block
			.replace(/^<defs\b[^>]*>/, "")
			.replace(/<\/defs>$/, "")
			.replace(/<linearGradient\b[^>]*>/g, "")
			.replace(/<\/linearGradient>/g, "")
			.replace(/<stop\b[^>]*\/>/g, "")
			.trim();
		if (leftover === "") defs.push(block);
	}
	return defs.join("") + shapes.join("");
}

// The social copy. Sign-aware and honest by design (we never publish a
// context-free "X% cheaper"): a real win brags the %, a tight loop reports
// "held even" (no regression), a regression states the cost plainly.
export function bragText({ pct, reclaimedPerTurn } = {}) {
	if (typeof pct !== "number" || !Number.isFinite(pct)) {
		return "Tuning my Claude Code token spend with clawback.md.";
	}
	const p = Math.round(Math.abs(pct));
	if (Math.abs(pct) < 2) {
		return "clawback.md held even with passthrough on a tight loop — no token regression.";
	}
	if (reclaimedPerTurn > 0) {
		return `I just clawback'd ${p}% of my tokens!`;
	}
	return `Measuring my Claude Code token spend with clawback.md — ${p}% over passthrough on this tight loop, with no idle gaps to reclaim.`;
}

// X/Twitter web-intent share URL. Text + optional link; the platform composes a
// tweet the user still has to confirm. (An image can't ride a URL intent — that
// arrives via the OG unfurl, stubbed for now, or the downloaded PNG.)
export function xIntentUrl(text, url = "") {
	const u = new URL("https://twitter.com/intent/tweet");
	u.searchParams.set("text", text);
	if (url) u.searchParams.set("url", url);
	return u.toString();
}

// Bluesky compose-intent URL. Bluesky has no separate url param, so the link is
// appended to the text.
export function bskyIntentUrl(text, url = "") {
	const u = new URL("https://bsky.app/intent/compose");
	u.searchParams.set("text", url ? `${text} ${url}` : text);
	return u.toString();
}

// Telegram share-intent URL. Takes a separate url param (set only when a public
// link exists — stubbed for now) plus the caption text.
export function telegramIntentUrl(text, url = "") {
	const u = new URL("https://t.me/share/url");
	if (url) u.searchParams.set("url", url);
	u.searchParams.set("text", text);
	return u.toString();
}

// WhatsApp share-intent URL. wa.me carries a single text field, so the link (if
// any) is folded into it.
export function whatsappIntentUrl(text, url = "") {
	const u = new URL("https://wa.me/");
	u.searchParams.set("text", url ? `${text} ${url}` : text);
	return u.toString();
}

// ─── share-host (og.clawback.md) integration ───────────────────────────────
//
// The report can publish a card to a clawback-operated share host so a social
// post unfurls the image. The host itself is built + deployed ELSEWHERE; the
// pieces below are the CLIENT half and define the wire contract both sides honor.
//
// Flow: the client POSTs structured DATA (never pixels — see buildSharePayload),
// the host renders the PNG from that data with THIS module's shareCardSvg (so the
// hosted image is byte-identical to the local preview — one renderer, no drift),
// stores it, and returns an id. Sending data not pixels also means the host can
// never be turned into an open "host any image on the brand domain" endpoint: the
// card template is fixed server-side, the client only fills validated blanks.
//
//   POST <OG_ENDPOINT>            (CORS; credentials omitted — the post is anon)
//   → 200 { id, image?, page? }   image defaults to <base>/<id>.png

// Default share-host origin. A constant for now (the host doesn't exist yet);
// promote to a layered-config knob when og.clawback.md ships so an operator can
// repoint at a staging host.
export const OG_ENDPOINT = "https://og.clawback.md";

// The privacy tiers, lowest egress first. "local" never opens a socket (the
// default — the card stays on the machine); "minimal" sends only what the host
// needs to redraw THIS card (the same figures already visible on it); "full"
// adds the structured stats, the chart geometry, and an optional hand-typed
// handle that a future leaderboard would rank on.
export const SHARE_TIERS = ["local", "minimal", "full"];

function finiteOrNull(n) {
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function trimTrailingSlash(s) {
	return String(s ?? "").replace(/\/+$/, "");
}

// Build the JSON body POSTed to the share host — THE integration contract.
// Tier filtering happens HERE, client-side, before anything is serialized: we
// never put on the wire what the chosen tier omits, and never lean on the host
// to drop it. "local"/unknown → null (the caller must not POST). The `card`
// object is exactly shareCardSvg's argument shape, so the host redraws the
// identical image by feeding it straight back in.
//
//   minimal → { v:1, tier:"minimal", card:{ headline, kicker, subhead, tone, pageGloss } }
//   full    → minimal + card.bgShapes (chart), stats:{ pct, reclaimedPerTurn,
//             reclaimedTotal }, run:{ nTurns, nPings, clawbackVersions,
//             pricingHash } (provenance for leaderboard bucketing),
//             attribution:{ handle } (iff a handle was typed)
//
// Deliberately NEVER on any tier: prompts, code, file paths, the operator's
// email or git identity, IP, or any session/Anthropic key. "minimal" carries
// only the rounded figures already rendered onto the card the user chose to
// post — the pixels, nothing behind them.
export function buildSharePayload(model, { tier, handle, run } = {}) {
	if (!model || (tier !== "minimal" && tier !== "full")) return null;
	const card = {
		headline: model.headline ?? null,
		kicker: model.kicker ?? null,
		subhead: model.subhead ?? null,
		tone: model.tone ?? "even",
		pageGloss: model.pageGloss ?? null,
	};
	if (tier === "minimal") return { v: 1, tier, card };
	// full: the card-draw fields PLUS the leaderboard data.
	if (model.bgShapes) card.bgShapes = String(model.bgShapes);
	const payload = {
		v: 1,
		tier,
		card,
		stats: {
			pct: finiteOrNull(model.pct),
			reclaimedPerTurn: finiteOrNull(model.reclaimedPerTurn),
			reclaimedTotal: finiteOrNull(model.reclaimedTotal),
		},
	};
	if (run && typeof run === "object") {
		payload.run = {
			nTurns: finiteOrNull(run.nTurns),
			nPings: finiteOrNull(run.nPings),
			clawbackVersions: Array.isArray(run.clawbackVersions)
				? run.clawbackVersions.map((v) => String(v))
				: [],
			pricingHash: typeof run.pricingHash === "string" ? run.pricingHash : null,
		};
	}
	const h = typeof handle === "string" ? handle.trim() : "";
	if (h) payload.attribution = { handle: h.slice(0, 64) };
	return payload;
}

// Resolve the public image URL from the host's POST response. Prefer a
// server-returned absolute `image`; else construct <base>/<id>.png per the host's
// stated URL shape. "" when there's nothing usable (caller falls back to a local
// download).
export function cardImageUrl(resp, base = OG_ENDPOINT) {
	if (resp && typeof resp.image === "string" && resp.image) return resp.image;
	const id = resp && typeof resp.id === "string" ? resp.id : "";
	return id ? `${trimTrailingSlash(base)}/${encodeURIComponent(id)}.png` : "";
}

// The card's landing page (OG-unfurl host). We post the raw image URL today; this
// is what we'll post instead once og.clawback.md serves per-card pages with OG
// tags (richer unfurl + an owned funnel surface). Prefer a server-returned `page`.
export function cardPageUrl(resp, base = OG_ENDPOINT) {
	if (resp && typeof resp.page === "string" && resp.page) return resp.page;
	const id = resp && typeof resp.id === "string" ? resp.id : "";
	return id ? `${trimTrailingSlash(base)}/${encodeURIComponent(id)}` : "";
}

// A safe, descriptive download filename derived from the headline figure.
export function cardFilename({ pct, reclaimedPerTurn } = {}) {
	if (
		typeof pct === "number" &&
		Number.isFinite(pct) &&
		Math.abs(pct) >= 2 &&
		reclaimedPerTurn > 0
	) {
		return `clawback-${Math.round(Math.abs(pct))}pct.png`;
	}
	return "clawback-report.png";
}

// Thousands-separated integer (en-US). null/non-finite → "—".
export function fmtTokens(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	return Math.round(n).toLocaleString("en-US");
}

// Signed, for the hero figure: "+15,958" / "−2,001" (U+2212 minus).
export function fmtSigned(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	const r = Math.round(n);
	return (r >= 0 ? "+" : "−") + Math.abs(r).toLocaleString("en-US");
}

// The single source of truth for the report card — pure, no DOM. Reads
// summary.tokens (computed analyzer-side, no pricing) and derives every string
// the share card shows. report.js composes the card from headline/kicker/tone
// and bakes pageGloss into the top-left, so what you see is what you'd share.
// Direction always lives in the *text* — the signed headline
// ("+68%"/"−151%") and the signed gloss figure ("+"/"−") — never colour alone
// (WCAG 1.4.1). The kicker is brand voice ("professional claude tokenmaxxing") in every
// case and carries no direction. The per-turn rate is robust even when the arms
// aren't turn-matched.
export function deriveHeroModel(summary) {
	const t = summary?.tokens;

	if (!t || typeof t.reclaimedPerTurn !== "number") {
		// No paired arms: still hand back a model so the share card has something
		// honest to say (bragText falls back to a neutral line for pct == null).
		return {
			headline: "—",
			kicker: "professional claude tokenmaxxing",
			tone: "even",
			subhead: null,
			pct: null,
			reclaimedPerTurn: null,
			reclaimedTotal: null,
			pageGloss:
				"This run has no paired passthrough + clawback.md turns to compare.",
		};
	}

	const r = t.reclaimedPerTurn;
	const pct = typeof t.pctLessPerTurn === "number" ? t.pctLessPerTurn : null;

	// The splashy figure is the TOTAL full-rate tokens reclaimed across the whole
	// run — net of any burned (reclaimedTotal is baseline−treatment, so a tight
	// loop that costs comes through negative) — not the per-turn rate. A bigger,
	// more shareable number. Prefer the rigorous turn-matched paired total; fall
	// back to the pooled total (a per-turn × treatment-turns projection) when the
	// arms aren't turn-matched.
	const totalReclaimed =
		typeof t.reclaimedTotalPaired === "number"
			? t.reclaimedTotalPaired
			: typeof t.reclaimedTotal === "number"
				? t.reclaimedTotal
				: r;

	// "About even" when the gap is within a couple percent of baseline — a tight
	// loop where there's nothing to recover, not a win and not a regression.
	const nearZero = pct != null && Math.abs(pct) < 2;
	const tone = nearZero ? "even" : r > 0 ? "pos" : "neg";

	// The hero subhead names what a positive-% win MEANS — "efficiency", so the
	// headline reads "+97% efficiency" — shown only when the headline is itself a
	// positive percentage: tone "pos" AND a real pct (not the token-fallback
	// headline, and never the ≈0% dead band or a regression). Supporting prose, never
	// a second signal — the signed headline and gloss already carry direction, so
	// colour/copy is never the sole cue (WCAG 1.4.1).
	const subhead = tone === "pos" && pct != null ? "efficiency" : null;

	// The baked gloss is the signed run-wide reclaim total: "+175,537 tokens". The
	// sign carries direction honestly — a regression shows a minus (never spun as a
	// win) — so the headline %, the kicker, and this figure all agree without a
	// separate stats line.
	const pageGloss = `${fmtSigned(totalReclaimed)} tokens`;

	// The kicker is brand voice in every case — it speaks to the product, not the
	// run's result — so direction never rides on it. Both the signed headline and
	// the signed gloss carry the win/loss in text, so colour is never the sole
	// signal (WCAG 1.4.1).
	const kicker = "professional claude tokenmaxxing";

	let headline;
	if (pct == null) {
		// No percentage available (rare): fall back to the signed total token
		// figure as the headline so the card still says something concrete.
		headline = `${fmtSigned(totalReclaimed)} tokens`;
	} else if (nearZero) {
		// A tight loop with nothing to reclaim — neither win nor loss — so the
		// headline stays unsigned.
		headline = "≈ 0%";
	} else {
		// Sign the percentage so the headline itself states direction: "+68%" on a
		// win, "−151%" on a regression (U+2212, matching the gloss). |pct| is the
		// magnitude; the sign follows reclaimedPerTurn.
		headline = `${r > 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%`;
	}

	return {
		headline,
		kicker,
		tone,
		subhead,
		pct,
		reclaimedPerTurn: r,
		reclaimedTotal: totalReclaimed,
		pageGloss,
	};
}

// System font stack only — no webfont fetch, so the card renders identically
// offline and the canvas never taints from a cross-origin font.
const FONT_STACK =
	"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// DESIGN's mono stack for the wordmark, which "reads as a command". Same
// system-only posture (no fetch, no taint).
const MONO_STACK =
	"ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// The big number can be a short "97%" or a longer "+15,958 tokens/turn"
// fallback; scale the font so neither overflows the 1200px card.
function headlineFontSize(headline) {
	const n = String(headline ?? "").length;
	if (n <= 5) return 230;
	if (n <= 12) return 130;
	return 84;
}

// Greedy word-wrap for the baked callout: SVG <text> doesn't reflow, so we split
// the gloss/stats into lines that fit the callout box. maxChars is a soft width
// budget (the box is far wider than any line we emit); maxLines caps the height,
// ellipsising the last line if the content would overflow. Whitespace-only or
// empty input yields no lines (the callout is then skipped).
function wrapLines(s, maxChars, maxLines) {
	const words = String(s ?? "")
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return [];
	const lines = [];
	let cur = words[0];
	for (let i = 1; i < words.length; i++) {
		if (`${cur} ${words[i]}`.length <= maxChars) cur += ` ${words[i]}`;
		else {
			lines.push(cur);
			cur = words[i];
		}
	}
	lines.push(cur);
	if (lines.length > maxLines) {
		const kept = lines.slice(0, maxLines);
		kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s.,…]+$/, "")}…`;
		return kept;
	}
	return lines;
}

// The lit cast of each tone — a brighter top for the hero number's vertical
// gradient, so the big figure reads as lit from within rather than a flat fill.
// Each base is the asserted tone accent; the lit top is a brighter cast of it.
// Both clear AA-large on CARD_BG (the base is pinned in report_share.test.js; the
// lit top is strictly brighter, so it clears too).
function accentLitFor(tone) {
	return tone === "pos" ? "#56d364" : tone === "neg" ? "#e3b341" : "#f0f6fc";
}

// Compose the share card as a standalone SVG string. headline/kicker are the
// same strings the report hero shows; `tone` ∈ {pos,neg,even} picks the accent
// (green win / amber regression / neutral even), matching the dashboard palette.
//
// The card is staged like a product-launch hero, not a dashboard. Over the dark
// field we paint, in order: the chart graphic (if any) under a subordinate wedge
// bloom, then three light layers — a corner VIGNETTE for depth, a left→right
// SPOTLIGHT scrim that beds the text zone in dark while the chart blazes out of
// the clear right, and a BOTTOM scrim that grounds the signature — then the
// LENSFLARE (the number's own glow, the brightest light on the card), a downward
// ACCENT GLOW under a luminous accent bar, and finally the text. The scrim/glow
// layers are filterless gradient <rect>s; the blooms + lensflare are filtered
// SHAPES (sips renders blurred shapes faithfully — just never blurred text). Every
// other gradient is held subtler than the lensflare so the % owns the light.
//
// bgShapes (optional) is the plotted geometry of the cumulative-token chart,
// pre-extracted by extractBgShapes from plot.js's bare 1200×630 SVG: glowing
// curves + a luminous wedge, treated here as an abstract light-shape. The chart's
// plot field is CARD_BG, so it drops in full-bleed with no scaling. It's
// already-validated markup (whitelisted polygon/path), so it goes in verbatim.
// Absent bgShapes the card is a plain solid field (no path/polygon, no lensflare).
//
// The headline, the optional subhead, and the gloss carry a sips-SAFE halo: a
// DUPLICATE-TEXT pair (a stroke-only copy painted first, the fill copy on top),
// never a single stroked element. sips ignores paint-order WITHIN one element (so a lone stroke paints
// over its fill and hollows the glyphs) but obeys document order BETWEEN elements,
// so the fill copy always covers the interior and the stroke survives only as a
// rim. pageGloss (the honest signed reclaim figure) is baked in at the TOP-LEFT
// at the 80px inset (the headline % itself is dead-centred), so it reads at feed
// downscale and carries the card's own context (never a bare %).
export function shareCardSvg({
	headline,
	kicker,
	subhead,
	tone = "even",
	pageGloss,
	bgShapes,
} = {}) {
	const accent =
		tone === "pos" ? "#3fb950" : tone === "neg" ? "#d29922" : "#e6edf3";
	const accentLit = accentLitFor(tone);
	const coronaCool = coronaCoolFor(tone);
	const size = headlineFontSize(headline);
	// The hero % is dead-centred on the 1200×630 card: horizontally via
	// text-anchor="middle" at CARD_W/2, and vertically by dropping the baseline
	// ~0.36em below CARD_H/2 — digit cap-height is ≈0.72em and sits on the baseline,
	// so this lands the glyph block's own centre on the card's centre. text-anchor is
	// honoured by both the browser canvas and the paint-order-blind sips preview (the
	// wordmark already relies on text-anchor="end").
	const heroCenterX = CARD_W / 2;
	// Lift the hero cluster (the % and its subhead) ~5% of the card height ABOVE dead
	// centre. The bottom-right wordmark + kicker signature then has more room to
	// breathe without shrinking it (branding stays prominent). The subhead baseline and
	// the lensflare (lensY) both derive from heroBaseline, so the whole cluster — number,
	// subhead, and its glow — shifts up together.
	const heroLift = Math.round(CARD_H * 0.05);
	const heroBaseline = Math.round(CARD_H / 2 + size * 0.36) - heroLift;
	// The lensflare is anchored on the LEFT side of the card, decoupled from the
	// centred % — a left-weighted light source rather than a bed directly under the
	// number. It keeps to the card's vertical middle band (heroBaseline).
	const lensX = Math.round(CARD_W * 0.3);
	const lensY = heroBaseline;
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" font-family="${FONT_STACK}">`,
		// The premium light: spotlight + vignette + bottom scrim + accent glow, and
		// the hero number's lit vertical gradient. All sips-safe paint servers.
		"<defs>",
		// The atmospheric gradients are the BACKDROP — they now paint behind the graph
		// (which moved forward), set depth + a lit-room wash, and are held SUBTLER than
		// the lensflare so the % stays the brightest focal light. They're darkened
		// another step (a second pass) so the background recedes further and the bright
		// forward curves read as the clear front plane. The scrims fade to COOL_SHADOW
		// (a deep indigo), not pure black — a cool shadow against the warm light reads
		// hotter.
		`<linearGradient id="cbScrimLR" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${CARD_BG}" stop-opacity="0.93"/><stop offset="0.5" stop-color="${CARD_BG}" stop-opacity="0.82"/><stop offset="0.66" stop-color="${CARD_BG}" stop-opacity="0"/></linearGradient>`,
		`<radialGradient id="cbVignette" cx="0.42" cy="0.5" r="0.9"><stop offset="0.6" stop-color="${COOL_SHADOW}" stop-opacity="0"/><stop offset="1" stop-color="${COOL_SHADOW}" stop-opacity="0.58"/></radialGradient>`,
		`<linearGradient id="cbScrimB" x1="0" y1="0" x2="0" y2="1"><stop offset="0.58" stop-color="${COOL_SHADOW}" stop-opacity="0"/><stop offset="1" stop-color="${COOL_SHADOW}" stop-opacity="0.82"/></linearGradient>`,
		`<linearGradient id="cbTopGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.15"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>`,
		`<linearGradient id="cbHero" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accentLit}"/><stop offset="1" stop-color="${accent}"/></linearGradient>`,
		// Atmospheric haze bleeding from the top-right corner — turns the flat black
		// field into a lit room with colour depth. On the WIN card its lit edge is the
		// cyan corona (a cool analogue of green); on amber/even it stays accent-hued.
		// It dies to zero by the left third (centred top-right), and the spotlight
		// scrim paints over it anyway, so the number's contrast bed stays clean.
		`<radialGradient id="cbAurora" cx="0.82" cy="0.2" r="0.7"><stop offset="0" stop-color="${coronaCool ?? accentLit}" stop-opacity="0.07"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>`,
		// A real Gaussian bloom for the chart's win-plateau — a soft pool of accent
		// light the curves sit in. Filtered SHAPES (not text) survive the sips
		// preview AND the browser canvas without tainting it (no external href).
		`<filter id="cbBloom" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="52"/></filter>`,
		"</defs>",
		`<rect width="${CARD_W}" height="${CARD_H}" fill="${CARD_BG}"/>`,
	];
	// BACKDROP first, so the graph can sit FORWARD over it: the corner aurora wash
	// (lowest), then depth (vignette), a near-black bed for the text zones (the
	// left→right spotlight scrim, fading to clear by the right third), and a bottom
	// scrim to ground the signature. These are the darkened gradients the graph now
	// reads in front of. The aurora is chart-only; the scrims always paint (a plain
	// card still wants the depth).
	if (bgShapes) {
		parts.push(
			`<rect width="${CARD_W}" height="${CARD_H}" fill="url(#cbAurora)"/>`,
		);
	}
	parts.push(
		`<rect width="${CARD_W}" height="${CARD_H}" fill="url(#cbVignette)"/>`,
		`<rect width="${CARD_W}" height="${CARD_H}" fill="url(#cbScrimLR)"/>`,
		`<rect width="${CARD_W}" height="${CARD_H}" fill="url(#cbScrimB)"/>`,
	);
	// The GRAPH moves FORWARD — painted OVER the darkened backdrop so the data is the
	// front plane (only the lensflare + the text sit above it). Under the curves is a
	// soft accent bloom that keeps the wedge alive — a broad halo plus a gentle core,
	// kept to the RIGHT (~880px) and held SUBORDINATE to the lensflare (dimmer), so
	// the number still reads as the brightest thing and the flare belongs to the %;
	// this is just the wedge catching some of that light.
	if (bgShapes) {
		parts.push(
			`<circle cx="900" cy="320" r="340" fill="${accent}" opacity="0.10" filter="url(#cbBloom)"/>`,
			`<circle cx="845" cy="255" r="150" fill="${accentLit}" opacity="0.13" filter="url(#cbBloom)"/>`,
			String(bgShapes),
		);
	}
	// The LENSFLARE — a left-anchored pool of light (lensX, lensY), pulled off the
	// centred % so it reads as a light source on the LEFT rather than a bed under the
	// number. It's still the focal glow on the card, dimmed another step this pass and
	// given a deep-purple (LENS_CORE) centre instead of a white-hot one — calmer, and
	// every backdrop gradient stays under it. Painted OVER the spotlight scrim and the
	// forward graph but UNDER the headline text (the crisp glyphs paint on top), so its
	// left bloom lifts the wedge's rise without washing the %. The warm accent/accentLit
	// rings carry the tone; the cool purple sits at the core. On the WIN card a faint
	// cyan corona also rings it widest-and-first (the cool outer edge, analogous to the
	// green); tone-gated off for amber/even so cyan is never over-used. Gated on
	// bgShapes to match the wedge bloom (no chart ⇒ plain solid card).
	if (bgShapes) {
		if (coronaCool) {
			parts.push(
				`<circle cx="${lensX}" cy="${lensY - 2}" r="380" fill="${coronaCool}" opacity="0.08" filter="url(#cbBloom)"/>`,
			);
		}
		parts.push(
			`<circle cx="${lensX}" cy="${lensY - 4}" r="300" fill="${accent}" opacity="0.18" filter="url(#cbBloom)"/>`,
			`<circle cx="${lensX}" cy="${lensY + 8}" r="150" fill="${accentLit}" opacity="0.24" filter="url(#cbBloom)"/>`,
			`<circle cx="${lensX - 10}" cy="${lensY + 12}" r="70" fill="${LENS_CORE}" opacity="0.34" filter="url(#cbBloom)"/>`,
		);
	}
	// The wordmark + kicker are the brand signature, right-aligned in the
	// bottom-right corner on the bottom scrim; the big headline is the dead-centre
	// centerpiece. A downward accent glow makes the capping accent bar luminous.
	const signX = CARD_W - 80;
	// The headline halo, restored as a sips-SAFE duplicate-text pair: a stroke-only
	// copy painted FIRST, then the gradient-filled copy on top. A single stroked
	// <text> hollows in the paint-order-blind sips preview (its stroke paints over
	// its own fill), but two separate elements obey document order in EVERY raster —
	// the fill always covers the glyph interior, and the stroke survives only as a
	// rim. The rim is COOL_SHADOW (deep indigo): it carves the warm % out of its own
	// lensflare and reads as a cool shadow edge. Width scales with the font.
	const haloW = Math.max(4, Math.round(size * 0.05));
	parts.push(
		`<rect x="0" y="14" width="${CARD_W}" height="150" fill="url(#cbTopGlow)"/>`,
		`<rect x="0" y="0" width="${CARD_W}" height="14" fill="${accent}"/>`,
		`<text x="${heroCenterX}" y="${heroBaseline}" text-anchor="middle" fill="none" stroke="${COOL_SHADOW}" stroke-width="${haloW}" stroke-linejoin="round" font-size="${size}" font-weight="800" letter-spacing="-3">${xmlEscape(headline)}</text>`,
		`<text x="${heroCenterX}" y="${heroBaseline}" text-anchor="middle" fill="url(#cbHero)" font-size="${size}" font-weight="800" letter-spacing="-3">${xmlEscape(headline)}</text>`,
	);
	// Optional subhead, dead-centred directly under the hero % (baseline dropped a
	// proportion of the headline size, so it tracks the number on every card). It rides
	// the supporting near-white (CALLOUT_GLOSS), NEVER a second accent — the green %
	// owns the light (DESIGN: "one accent at a time"; #fafafa's contrast floor is
	// already locked in report_share.test.js). Sized as a peer of the gloss/wordmark
	// tier but proportional to the hero so it scales, and rimmed with the SAME sips-safe
	// duplicate-text halo as the headline (stroke copy first, fill on top) because it
	// overlaps the left lensflare glow. deriveHeroModel gates it to the positive-% win.
	if (subhead) {
		const subSize = Math.max(40, Math.round(size * 0.22));
		const subBaseline = heroBaseline + Math.round(size * 0.3);
		const subHaloW = Math.max(3, Math.round(subSize * 0.07));
		parts.push(
			`<text x="${heroCenterX}" y="${subBaseline}" text-anchor="middle" fill="none" stroke="${COOL_SHADOW}" stroke-width="${subHaloW}" stroke-linejoin="round" font-size="${subSize}" font-weight="600">${xmlEscape(subhead)}</text>`,
			`<text x="${heroCenterX}" y="${subBaseline}" text-anchor="middle" fill="${CALLOUT_GLOSS}" font-size="${subSize}" font-weight="600">${xmlEscape(subhead)}</text>`,
		);
	}
	parts.push(
		`<text x="${signX}" y="540" text-anchor="end" fill="#fafafa" font-family="${MONO_STACK}" font-size="52" font-weight="700" letter-spacing="1">clawback.md</text>`,
		`<text x="${signX}" y="578" text-anchor="end" fill="#848b94" font-size="28" font-weight="500">${xmlEscape(kicker)}</text>`,
	);

	// The baked context gloss: the wrapped one-liner sits in the TOP-LEFT, left-set
	// at the 80px inset — the glyph's own left edge is the margin. It stays top-left
	// as the context caption while the headline % is dead-centred on the card.
	// It carries the same duplicate-text halo as the headline (a COOL_SHADOW
	// stroke-only copy under the near-white fill copy), so it gains a rim without
	// hollowing in the paint-order-blind sips preview — document order keeps the
	// fill on top in every raster. No chip; it rides the spotlight scrim's dark bed.
	const glossLines = wrapLines(pageGloss, 40, 2);
	if (glossLines.length > 0) {
		const glossSize = 54;
		const lineH = 64;
		const padY = 28;
		const leftInset = 80;
		const boxY = 44;
		for (let i = 0; i < glossLines.length; i++) {
			const baseline = boxY + padY + glossSize - 8 + i * lineH;
			parts.push(
				`<text x="${leftInset}" y="${baseline}" text-anchor="start" fill="none" stroke="${COOL_SHADOW}" stroke-width="4" stroke-linejoin="round" font-size="${glossSize}" font-weight="700">${xmlEscape(glossLines[i])}</text>`,
				`<text x="${leftInset}" y="${baseline}" text-anchor="start" fill="${CALLOUT_GLOSS}" font-size="${glossSize}" font-weight="700">${xmlEscape(glossLines[i])}</text>`,
			);
		}
	}

	parts.push("</svg>");
	return parts.join("");
}

// Rasterize an SVG string to a PNG Blob via an offscreen canvas. Browser-only
// (needs Image + canvas + toBlob); resolves with the PNG Blob or rejects. The
// data: URL keeps the source self-contained so the canvas is never tainted.
export function svgToPngBlob(svg, { width = CARD_W, height = CARD_H } = {}) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext("2d");
				ctx.drawImage(img, 0, 0, width, height);
				canvas.toBlob(
					(blob) =>
						blob
							? resolve(blob)
							: reject(new Error("canvas.toBlob returned null")),
					"image/png",
				);
			} catch (err) {
				reject(err);
			}
		};
		img.onerror = () => reject(new Error("share card SVG failed to rasterize"));
		img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
}
