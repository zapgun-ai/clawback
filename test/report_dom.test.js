import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, "../src/report_ui");

const HTML_RAW = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
const REPORT_JS_RAW = fs.readFileSync(path.join(UI_DIR, "report.js"), "utf8");
const SHARE_JS_RAW = fs.readFileSync(
	path.join(UI_DIR, "share_card.js"),
	"utf8",
);

// The server injects the admin-path prefix in place of __BASE__ before serving.
// Do the same here so <base> is a valid path and the client's relative fetches
// / <img src> resolve exactly as they would in the browser.
const BASE = "/_proxy/report";
const HTML_BASED = HTML_RAW.replaceAll("__BASE__", BASE);

// The share host origin the client POSTs to (share_card.js OG_ENDPOINT). Mirrored
// here so the route table and assertions can match it without importing the module
// (the module is inlined into the jsdom script, not imported on the Node side).
const OG = "https://og.clawback.md";

// jsdom does not execute <script type="module">. report.js is an ES module that
// imports the pure helpers from share_card.js; we splice the two together (after
// stripping export/import statements — same approach as ui_dom.test.js) and
// inject them as one classic inline script in dependency order.
const HTML_NO_MODULE = HTML_BASED.replace(
	/<script type="module" src="report\.js"><\/script>/,
	"",
);

function stripExports(source) {
	return source
		.replace(/^export\s+function\s/gm, "function ")
		.replace(/^export\s+const\s/gm, "const ")
		.replace(/^export\s+\{[^}]+\};?$/gm, "");
}

function stripImports(source) {
	return source.replace(/^import\s+[^;]+;\s*$/gms, "");
}

const INLINED_JS = `${stripExports(SHARE_JS_RAW)}\n${stripImports(REPORT_JS_RAW)}`;

function bootReport({
	fetchImpl,
	url = `http://localhost${BASE}/`,
	prep,
} = {}) {
	const virtualConsole = new VirtualConsole();
	virtualConsole.on("jsdomError", () => {
		// silence resource-loading errors from the absent stylesheets
	});
	const dom = new JSDOM(HTML_NO_MODULE, {
		runScripts: "dangerously",
		url,
		virtualConsole,
	});
	const fetchCalls = [];
	dom.window.fetch = async (u, init) => {
		fetchCalls.push({ url: String(u), init: init ?? null });
		return fetchImpl(u, init);
	};
	dom.fetchCalls = fetchCalls;

	// Hook to patch the window (install navigator.share / canvas stubs, etc.)
	// before the client script runs and feature-detects.
	prep?.(dom.window);

	const script = dom.window.document.createElement("script");
	script.textContent = INLINED_JS;
	dom.window.document.body.appendChild(script);
	return dom;
}

async function settle(_dom, ms = 40) {
	await new Promise((r) => setTimeout(r, ms));
	await new Promise((r) => setTimeout(r, ms));
}

function teardown(dom) {
	dom.window.close();
}

// Route a relative request string ("runs", "data?run=…", "csv/…") to a fixture.
// Handlers may be a value or a function({url, method}) → value. JSON handlers
// are wrapped as a Response-like; csv handlers must return a string.
function makeFetch(routes, { okText } = {}) {
	return async (url, init) => {
		const u = String(url);
		const method = init?.method?.toUpperCase() ?? "GET";
		for (const [pattern, handler] of Object.entries(routes)) {
			if (u.startsWith(pattern)) {
				const out =
					typeof handler === "function" ? handler({ url: u, method }) : handler;
				if (out?.__notOk) {
					return {
						ok: false,
						status: out.status ?? 500,
						text: async () => "",
						json: async () => ({}),
					};
				}
				if (typeof out === "string") {
					return {
						ok: true,
						status: 200,
						text: async () => out,
						json: async () => ({}),
					};
				}
				return {
					ok: true,
					status: 200,
					text: async () => okText ?? JSON.stringify(out),
					json: async () => out,
				};
			}
		}
		return {
			ok: false,
			status: 404,
			text: async () => "",
			json: async () => ({}),
		};
	};
}

// The one block the report now reads: billable-token reclaim, no pricing.
// Defaults model the validated L0-tier1 run (arms not turn-matched: 8 vs 11,
// so reclaimedTotal is projected; the per-turn rate is the robust headline).
function tokensFixture(overrides = {}) {
	return {
		billableDef:
			"input_tokens + cache_creation_input_tokens (full-rate input; excludes cache_read and output)",
		baseline: {
			arm: "passthrough",
			nTurns: 8,
			totalBillable: 131925,
			meanBillablePerTurn: 16490.625,
			totalCacheRead: 0,
		},
		treatment: {
			nTurns: 11,
			totalBillable: 5860,
			meanBillablePerTurn: 532.7272727272727,
			totalCacheRead: 42078,
		},
		reclaimedPerTurn: 15957.897727272728,
		reclaimedPerTurnCI: { mean: 15957.9, lo: 3145.4, hi: 32421.45 },
		reclaimedTotal: 175537,
		reclaimedTotalIsProjected: true,
		pctLessPerTurn: 96.76951435905387,
		...overrides,
	};
}

function summaryFixture({ tokens } = {}) {
	return {
		generatedAt: "2026-05-29T17:23:30.643Z",
		seed: 42,
		bootstrap: 2000,
		clawbackVersions: ["0.1.0"],
		nTurns: 19,
		// tokens === null lets a test model the "no paired arms" empty headline.
		tokens: tokens === null ? undefined : tokensFixture(tokens),
	};
}

const CSV_TEXT =
	"ts,arm,knobProfile,input_tokens,cache_read_tokens\n" +
	"2026-05-29T17:17:01.884Z,passthrough,A0,16491,0\n" +
	"2026-05-29T17:20:18.818Z,treatment,A5,533,42078\n";

function dataPayload(runId, overrides = {}) {
	return {
		id: runId,
		summary: summaryFixture(),
		manifest: { pricingVersion: "2026-05-28" },
		reportMarkdown: "# report",
		charts: ["tokens_saved.svg"],
		csvBytes: CSV_TEXT.length,
		...overrides,
	};
}

function runsPayload() {
	return {
		runs: [
			{ id: "L0-tier1", generatedAt: "2026-05-29T17:23:30.643Z", nTurns: 19 },
			{ id: "smoke", generatedAt: "2026-05-28T17:41:00.000Z", nTurns: 300 },
		],
	};
}

// Default route table: lists two runs; data echoes the requested run id; csv
// returns the small fixture.
function defaultRoutes(extra = {}) {
	return {
		runs: runsPayload(),
		"data?run=": ({ url }) => {
			const m = url.match(/run=([^&]+)/);
			const id = m ? decodeURIComponent(m[1]) : "";
			return dataPayload(id);
		},
		"csv/": CSV_TEXT,
		...extra,
	};
}

const text = (doc, id) => doc.getElementById(id).textContent;

// The rendered run is identified by the CSV download href, which loadRun always
// sets to `csv/<id>` (regardless of csv presence — only its visibility toggles).
// The visible centerpiece is now the share-card <img>, whose data: URL src
// carries no run id, so the csv href is the stable per-run signal. null (href
// still "#") before any run has loaded.
function renderedRunId(doc) {
	const href = doc.getElementById("csvDownload").getAttribute("href");
	const m = href?.match(/^csv\/(.+)$/);
	return m ? decodeURIComponent(m[1]) : null;
}

// Decode the share-card <img>'s data: URL back to the SVG string it renders.
function cardSvg(doc) {
	const src = doc.getElementById("shareCardImg").getAttribute("src") ?? "";
	const comma = src.indexOf(",");
	return comma >= 0 ? decodeURIComponent(src.slice(comma + 1)) : "";
}

test("boots, lists runs newest-first, auto-selects the first, shows the report", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;

	const opts = Array.from(doc.getElementById("runSelect").options);
	expect(opts.map((o) => o.value)).toEqual(["L0-tier1", "smoke"]);
	// Option label folds in generatedAt + turn count.
	expect(opts[0].textContent).toMatch(
		/L0-tier1 · 2026-05-29 17:23:30 · 19 turns/,
	);

	expect(doc.getElementById("reportMain").classList.contains("hidden")).toBe(
		false,
	);
	expect(doc.getElementById("emptyState").classList.contains("hidden")).toBe(
		true,
	);
	// First run is the one rendered.
	expect(renderedRunId(doc)).toBe("L0-tier1");
	teardown(dom);
});

test("empty runs directory shows the empty state, hides the report", async () => {
	const dom = bootReport({
		fetchImpl: makeFetch({ ...defaultRoutes(), runs: { runs: [] } }),
	});
	await settle(dom);
	const doc = dom.window.document;
	expect(doc.getElementById("emptyState").classList.contains("hidden")).toBe(
		false,
	);
	expect(doc.getElementById("reportMain").classList.contains("hidden")).toBe(
		true,
	);
	teardown(dom);
});

test("the card bakes the win + the honest context into the image, and links to X", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;

	// The centerpiece is the share-card image carrying the headline percentage and
	// the punchy card label. (This default run lists no bare chart, so the card is
	// a solid field — the graph-splice path has its own test below.)
	const svg = cardSvg(doc);
	expect(svg).toContain("+97%"); // signed headline: a win leads with "+"
	expect(svg).toContain("professional tokenmaxxing"); // a win wears the brand line
	expect(svg).not.toContain("<image");
	expect(svg).toContain('fill="#0b0f14"');

	// The card is self-contextualizing: the model's signed reclaim gloss (from
	// deriveHeroModel) is baked INTO the image as a left-set, haloed near-white callout
	// in the top-left, so there's no separate on-page caption and a downloaded/shared
	// PNG is never a bare context-free figure. We assert the gloss reached the card via
	// its data: URL. report_share.test.js owns the layout detail.
	expect(svg).toMatch(
		/<text x="80"[^>]*text-anchor="start"[^>]*>\+175,537 tokens<\/text>/,
	);
	expect(svg).toContain("+175,537 tokens"); // run-wide reclaim total (gloss)

	// There is no separate caption element any more — the context lives only in the
	// card image, so the two can't drift.
	expect(doc.getElementById("heroGloss")).toBeNull();
	expect(doc.getElementById("heroSub")).toBeNull();
	expect(doc.querySelector(".report-context")).toBeNull();

	// The image itself is the share/save control (an action, not a link) and carries
	// no navigation href. Two accessible-name layers: the img alt is the brag (the
	// picture's own description), and the button's aria-label leads with the action
	// ("Share or save …") so focusing the control announces what it DOES — clicking
	// opens the consent chooser — not just the brag.
	const img = doc.getElementById("shareCardImg");
	expect(img.getAttribute("alt")).toBe("I just clawback'd 97% of my tokens!");
	const link = doc.getElementById("shareCardLink");
	expect(link.tagName).toBe("BUTTON");
	expect(link.getAttribute("href")).toBeNull();
	expect(link.getAttribute("aria-label")).toBe(
		"Share or save this result — I just clawback'd 97% of my tokens!",
	);
	teardown(dom);
});

test("the card splices the run's cumulative-token graph behind the text when a bare chart exists", async () => {
	// A faithful bare chart (plot.js tokens_saved.bg.svg): dark field + filled
	// wedge polygon + two cumulative-curve paths. Only the shapes should ride into
	// the card; the <svg> wrapper and full-card <rect> field must be dropped.
	const bgChart =
		'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">' +
		'<rect width="1200" height="630" fill="#0b0f14"/>' +
		'<polygon points="64,404 1002,184 1002,533" fill="#3fb950" opacity="0.3"/>' +
		'<path d="M64 404 L1136 56" fill="none" stroke="#d29922" stroke-width="5"/>' +
		'<path d="M64 533 L1002 184" fill="none" stroke="#3fb950" stroke-width="5"/>' +
		"</svg>";
	const routes = defaultRoutes({
		"data?run=": ({ url }) => {
			const id = decodeURIComponent(url.match(/run=([^&]+)/)[1]);
			return dataPayload(id, {
				charts: ["tokens_saved.svg", "tokens_saved.bg.svg"],
			});
		},
		"chart/": bgChart,
	});
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	const svg = cardSvg(doc);

	// The two curves + wedge are spliced in verbatim (native vectors — taint-safe,
	// unlike an <image href>), and painted UNDER the text: every shape precedes
	// the accent bar, the wordmark, and the headline in document order.
	expect(svg).toContain("<polygon");
	expect((svg.match(/<path\b/g) ?? []).length).toBe(2);
	const graphAt = svg.indexOf("<polygon");
	expect(graphAt).toBeGreaterThan(-1);
	expect(graphAt).toBeLessThan(svg.indexOf('height="14"')); // accent bar
	expect(graphAt).toBeLessThan(svg.indexOf(">clawback.md<")); // wordmark
	expect(graphAt).toBeLessThan(svg.indexOf("97%")); // headline
	// The card was fetched from the chart/ route for this run's bare chart.
	expect(
		dom.fetchCalls.some(
			(c) =>
				c.url.startsWith("chart/") && c.url.includes("tokens_saved.bg.svg"),
		),
	).toBe(true);
	teardown(dom);
});

test("the card reads 'about even' (neutral accent) when the gap is within a couple percent", async () => {
	const routes = defaultRoutes({
		"data?run=": ({ url }) => {
			const id = decodeURIComponent(url.match(/run=([^&]+)/)[1]);
			return dataPayload(id, {
				summary: summaryFixture({
					tokens: {
						reclaimedPerTurn: 90,
						pctLessPerTurn: 1.2,
						// Keep the fixture internally consistent: a near-zero pct pairs
						// with a small positive total (~11 turns × 90/turn).
						reclaimedTotal: 990,
					},
				}),
			});
		},
	});
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	// The headline reads "≈ 0%" (within the couple-percent dead band) in the
	// neutral accent — not the green win hue.
	const svg = cardSvg(doc);
	expect(svg).toContain("≈ 0%");
	expect(svg).toContain("#e6edf3"); // neutral (even) accent
	expect(svg).not.toContain("#3fb950"); // never the win green
	// The brag is the honest "held even" line — never a percentage win.
	expect(doc.getElementById("shareCardImg").getAttribute("alt")).toBe(
		"clawback.md held even with passthrough on a tight loop — no token regression.",
	);
	// The signed reclaim gloss is still baked into the card — here a small, honest
	// positive total, nothing to spin on a tight loop.
	expect(svg).toContain("+990 tokens");
	teardown(dom);
});

test("the card reads as a regression (amber accent) when clawback spent more per turn", async () => {
	const routes = defaultRoutes({
		"data?run=": ({ url }) => {
			const id = decodeURIComponent(url.match(/run=([^&]+)/)[1]);
			return dataPayload(id, {
				summary: summaryFixture({
					tokens: {
						reclaimedPerTurn: -2001,
						pctLessPerTurn: -12,
						// Net total is negative too (clawback spent MORE); keep the
						// fixture internally consistent so the gloss reads the loss.
						reclaimedTotal: -22011,
					},
				}),
			});
		},
	});
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	const svg = cardSvg(doc);
	// Headline is the SIGNED percentage (U+2212 minus — clawback spent more),
	// painted in the amber regression accent.
	expect(svg).toContain("−12%");
	expect(svg).toContain("#d29922"); // amber (neg) accent
	// The brag states the cost plainly — never a clawback'd % win.
	const alt = doc.getElementById("shareCardImg").getAttribute("alt");
	expect(alt).toMatch(/12% over passthrough/);
	expect(alt).not.toMatch(/clawback'd/);
	// The honest "spent more" gloss (the signed run-wide overspend total) is baked
	// into the card — the minus sign carries the loss, never spun as a win.
	expect(svg).toContain("−22,011 tokens");
	teardown(dom);
});

test("the card degrades gracefully when the run has no paired arms to compare", async () => {
	const routes = defaultRoutes({
		"data?run=": ({ url }) => {
			const id = decodeURIComponent(url.match(/run=([^&]+)/)[1]);
			return dataPayload(id, { summary: summaryFixture({ tokens: null }) });
		},
	});
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	// Headline falls back to the em dash; the brag is the neutral fallback line.
	expect(cardSvg(doc)).toContain("—");
	expect(doc.getElementById("shareCardImg").getAttribute("alt")).toBe(
		"Tuning my Claude Code token spend with clawback.md.",
	);
	// The honest "no paired arms" gloss is baked into the card (no separate
	// caption) — deriveHeroModel's fallback line, in place of a signed total.
	expect(cardSvg(doc)).toMatch(/no paired passthrough/);
	teardown(dom);
});

test("the card renders as a sandboxed <img> from a self-contained data: URL (no inline SVG, no remote src)", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	// Never inline SVG — the card is loaded as an <img>, so its bytes are never
	// parsed as markup in the document.
	const panel = doc.getElementById("chartCard");
	expect(panel.querySelector("svg")).toBeNull();
	// A self-contained data: URL (not a remote path) keeps the bytes inert and
	// the canvas untainted when the same card later rasterizes to PNG.
	const src = doc.getElementById("shareCardImg").getAttribute("src");
	expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
	expect(cardSvg(doc).startsWith("<svg")).toBe(true);
	teardown(dom);
});

test("clicking the card with no remembered tier opens the consent chooser and sends nothing", async () => {
	const objectUrls = [];
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => {
			installRasterStubs(win, { objectUrls });
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	const link = doc.getElementById("shareCardLink");
	// A button (an action), not an anchor — and it carries no X / navigation href.
	expect(link.tagName).toBe("BUTTON");
	expect(link.getAttribute("type")).toBe("button");
	expect(link.getAttribute("href")).toBeNull();
	// Default posture is SILENT: the first click (no remembered tier) opens the
	// chooser — it does NOT download or contact the share host. The user must opt in.
	const backdrop = doc.getElementById("shareDialogBackdrop");
	expect(backdrop.classList.contains("hidden")).toBe(true);
	link.click();
	await settle(dom);
	expect(backdrop.classList.contains("hidden")).toBe(false);
	// Nothing left the machine: no PNG minted, no host POST, no X intent.
	expect(objectUrls.length).toBe(0);
	expect(openCalls.length).toBe(0);
	expect(dom.fetchCalls.some((c) => c.url.startsWith(OG))).toBe(false);
	teardown(dom);
});

test("the CSV download link is wired and shown when the run carries a csv", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const dl = dom.window.document.getElementById("csvDownload");
	expect(dl.getAttribute("href")).toBe("csv/L0-tier1");
	expect(dl.getAttribute("download")).toBe("L0-tier1-report.csv");
	expect(dl.classList.contains("hidden")).toBe(false);
	teardown(dom);
});

test("the CSV download link is hidden when the run has no csv", async () => {
	const routes = defaultRoutes({
		"data?run=": ({ url }) => {
			const id = decodeURIComponent(url.match(/run=([^&]+)/)[1]);
			return dataPayload(id, { csvBytes: null });
		},
	});
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	expect(
		dom.window.document
			.getElementById("csvDownload")
			.classList.contains("hidden"),
	).toBe(true);
	teardown(dom);
});

test("an untrusted run id is encoded into the CSV href, never injected as markup (XSS guard)", async () => {
	const evil = '"><img src=x onerror="window.__xss=1">';
	const routes = defaultRoutes({
		"data?run=": ({ url }) => {
			const id = decodeURIComponent(url.match(/run=([^&]+)/)[1]);
			const p = dataPayload(id);
			p.id = evil; // server-echoed id is treated as untrusted
			return p;
		},
	});
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	// The evil id reaches the DOM only through the CSV download href, percent-
	// encoded — no attribute breakout, no onerror handler created.
	expect(doc.getElementById("csvDownload").getAttribute("href")).toBe(
		`csv/${encodeURIComponent(evil)}`,
	);
	// The run id never touches the card: its src is a data: URL of the composed
	// SVG, which carries figures only — not the id — so the panel parses no
	// injected markup and the evil id created no element of its own.
	const panel = doc.getElementById("chartCard");
	expect(panel.querySelector("svg")).toBeNull();
	expect(panel.querySelector("img[onerror]")).toBeNull();
	expect(cardSvg(doc)).not.toContain("onerror");
	expect(dom.window.__xss).toBeUndefined();
	teardown(dom);
});

test("a #run= deep link selects that run on load", async () => {
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		url: `http://localhost${BASE}/#run=smoke`,
	});
	await settle(dom);
	const doc = dom.window.document;
	expect(doc.getElementById("runSelect").value).toBe("smoke");
	expect(renderedRunId(doc)).toBe("smoke");
	expect(dom.fetchCalls.some((c) => c.url === "data?run=smoke")).toBe(true);
	teardown(dom);
});

test("changing the run picker loads the other run", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	expect(renderedRunId(doc)).toBe("L0-tier1");
	const sel = doc.getElementById("runSelect");
	sel.value = "smoke";
	sel.dispatchEvent(new dom.window.Event("change"));
	await settle(dom);
	expect(renderedRunId(doc)).toBe("smoke");
	teardown(dom);
});

test("refresh button re-reads the runs directory", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("refreshBtn").click();
	await settle(dom);
	expect(dom.fetchCalls.some((c) => c.url === "runs")).toBe(true);
	teardown(dom);
});

test("a failed data fetch surfaces the error (with the run id as text) in the empty state", async () => {
	const routes = defaultRoutes({ "data?run=": { __notOk: true, status: 500 } });
	const dom = bootReport({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	expect(doc.getElementById("emptyState").classList.contains("hidden")).toBe(
		false,
	);
	expect(doc.getElementById("reportMain").classList.contains("hidden")).toBe(
		true,
	);
	const msg = doc.getElementById("emptyState").querySelector("p");
	expect(msg.textContent).toMatch(/Failed to load run "L0-tier1"/);
	// Rendered as text — no markup smuggled through the error path.
	expect(msg.querySelector("*")).toBeNull();
	teardown(dom);
});

// ---- share / build-in-public wiring ----
//
// The download and native-share handlers rasterize the hero card through
// Image + <canvas> + object URLs — none of which jsdom implements. These stubs
// stand in for the browser so the handlers run end-to-end: the fake Image fires
// onload on the next tick once src is set, the canvas hands back a tiny PNG
// Blob, and createObjectURL yields a fake blob: URL we can observe.
function installRasterStubs(win, { objectUrls, renderedSvgs } = {}) {
	win.Image = class {
		set src(v) {
			this._src = v;
			// svgToPngBlob sets src to a data:image/svg+xml URL of the composed
			// card; decode it so a test can assert what was rasterized.
			if (renderedSvgs) {
				const comma = v.indexOf(",");
				renderedSvgs.push(
					comma >= 0 ? decodeURIComponent(v.slice(comma + 1)) : v,
				);
			}
			setTimeout(() => this.onload?.(), 0);
		}
		get src() {
			return this._src;
		}
	};
	const proto = win.HTMLCanvasElement.prototype;
	proto.getContext = () => ({ drawImage() {} });
	proto.toBlob = function toBlob(cb) {
		cb(
			new win.Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
		);
	};
	let n = 0;
	win.URL.createObjectURL = () => {
		const u = `blob:clawback/${++n}`;
		objectUrls?.push(u);
		return u;
	};
	win.URL.revokeObjectURL = () => {};
}

// Stub the Web Share API. `canShare` gates whether the PNG is attached; a
// custom `shareImpl` lets a test model the user dismissing the sheet.
function installShareStubs(
	win,
	{ shareCalls = [], canShare = true, shareImpl } = {},
) {
	Object.defineProperty(win.navigator, "canShare", {
		configurable: true,
		value: () => canShare,
	});
	Object.defineProperty(win.navigator, "share", {
		configurable: true,
		value:
			shareImpl ??
			((data) => {
				shareCalls.push(data);
				return Promise.resolve();
			}),
	});
}

function installOpenSpy(win, openCalls) {
	win.open = (...args) => {
		openCalls.push(args);
		return null;
	};
}

// Drive the open consent chooser: select a tier, optionally type a handle, then
// confirm by submitting the form (the Confirm button is type="submit"). jsdom
// doesn't auto-fire submit on a submit-button click, so we dispatch it directly.
function chooseTier(dom, tier, { handle } = {}) {
	const doc = dom.window.document;
	const radio = doc.querySelector(`input[name="shareTier"][value="${tier}"]`);
	radio.checked = true;
	radio.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	if (handle != null) doc.getElementById("shareHandleInput").value = handle;
	doc
		.getElementById("shareDialogForm")
		.dispatchEvent(
			new dom.window.Event("submit", { bubbles: true, cancelable: true }),
		);
}

// Read the single POST made to the share host (if any) and parse its JSON body.
function ogPost(dom) {
	const call = dom.fetchCalls.find((c) => c.url.startsWith(OG));
	if (!call) return null;
	return {
		url: call.url,
		method: call.init?.method,
		credentials: call.init?.credentials,
		mode: call.init?.mode,
		body: call.init?.body ? JSON.parse(call.init.body) : null,
	};
}

test("the share section offers download, native share, X, Bluesky, Telegram, WhatsApp, and CSV with accessible names", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	// Each control's accessible name is its visible text — no icon-only buttons.
	expect(doc.getElementById("shareNative").textContent).toBe("share image…");
	expect(doc.getElementById("shareX").textContent).toBe("post to X");
	expect(doc.getElementById("shareBsky").textContent).toBe("post to Bluesky");
	expect(doc.getElementById("shareTelegram").textContent).toBe(
		"post to Telegram",
	);
	expect(doc.getElementById("shareWhatsapp").textContent).toBe(
		"post to WhatsApp",
	);
	expect(doc.getElementById("shareSettings").textContent).toBe("sharing…");
	expect(doc.getElementById("downloadCard").textContent).toBe("download PNG");
	expect(doc.getElementById("csvDownload").textContent).toBe("download CSV");
	// Async outcomes are announced in a polite live region (WCAG 4.1.3).
	const status = doc.getElementById("shareStatus");
	expect(status.getAttribute("role")).toBe("status");
	expect(status.getAttribute("aria-live")).toBe("polite");
	teardown(dom);
});

test("the native-share button is hidden when the browser has no navigator.share", async () => {
	// Default jsdom exposes no navigator.share — the control is hidden, not dead.
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	expect(doc.getElementById("shareNative").classList.contains("hidden")).toBe(
		true,
	);
	// The always-available controls stay visible.
	expect(doc.getElementById("downloadCard").classList.contains("hidden")).toBe(
		false,
	);
	expect(doc.getElementById("shareX").classList.contains("hidden")).toBe(false);
	teardown(dom);
});

test("the native-share button stays visible when navigator.share is supported", async () => {
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installShareStubs(win, { shareCalls: [] }),
	});
	await settle(dom);
	expect(
		dom.window.document
			.getElementById("shareNative")
			.classList.contains("hidden"),
	).toBe(false);
	teardown(dom);
});

test("post to X opens the intent URL carrying the build-in-public brag verbatim", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installOpenSpy(win, openCalls),
	});
	await settle(dom);
	dom.window.document.getElementById("shareX").click();
	expect(openCalls.length).toBe(1);
	const [url, target, features] = openCalls[0];
	const u = new dom.window.URL(url);
	expect(u.origin + u.pathname).toBe("https://twitter.com/intent/tweet");
	// The default fixture is a 96.77% win → the brag names the rounded percentage.
	expect(u.searchParams.get("text")).toBe(
		"I just clawback'd 97% of my tokens!",
	);
	// Opened in a new tab without leaking the opener.
	expect(target).toBe("_blank");
	expect(features).toBe("noopener,noreferrer");
	teardown(dom);
});

test("post to Bluesky opens the compose intent carrying the same brag", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installOpenSpy(win, openCalls),
	});
	await settle(dom);
	dom.window.document.getElementById("shareBsky").click();
	expect(openCalls.length).toBe(1);
	const u = new dom.window.URL(openCalls[0][0]);
	expect(u.origin + u.pathname).toBe("https://bsky.app/intent/compose");
	expect(u.searchParams.get("text")).toBe(
		"I just clawback'd 97% of my tokens!",
	);
	teardown(dom);
});

test("post to Telegram opens the share intent carrying the same brag", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installOpenSpy(win, openCalls),
	});
	await settle(dom);
	dom.window.document.getElementById("shareTelegram").click();
	expect(openCalls.length).toBe(1);
	const u = new dom.window.URL(openCalls[0][0]);
	expect(u.origin + u.pathname).toBe("https://t.me/share/url");
	expect(u.searchParams.get("text")).toBe(
		"I just clawback'd 97% of my tokens!",
	);
	teardown(dom);
});

test("post to WhatsApp opens the share intent carrying the same brag", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installOpenSpy(win, openCalls),
	});
	await settle(dom);
	dom.window.document.getElementById("shareWhatsapp").click();
	expect(openCalls.length).toBe(1);
	const u = new dom.window.URL(openCalls[0][0]);
	expect(u.origin + u.pathname).toBe("https://wa.me/");
	expect(u.searchParams.get("text")).toBe(
		"I just clawback'd 97% of my tokens!",
	);
	teardown(dom);
});

test("download PNG rasterizes the card and announces the saved filename", async () => {
	const objectUrls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installRasterStubs(win, { objectUrls }),
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("downloadCard").click();
	await settle(dom);
	// A blob: URL was minted for the download, and the status names the file by %.
	expect(objectUrls.length).toBe(1);
	expect(text(doc, "shareStatus")).toBe("Saved clawback-97pct.png.");
	teardown(dom);
});

test("download PNG rasterizes the solid card — headline, baked context, no chart <image>", async () => {
	const renderedSvgs = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => installRasterStubs(win, { renderedSvgs }),
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("downloadCard").click();
	await settle(dom);
	// Exactly the solid card is rasterized: the dark field and the headline —
	// never a chart <image> behind it.
	expect(renderedSvgs.length).toBe(1);
	const card = renderedSvgs[0];
	expect(card).not.toContain("<image");
	expect(card).toContain('fill="#0b0f14"');
	expect(card).toContain("+97%"); // signed headline rides into the PNG bytes
	// The callout is baked into the very bytes that become the PNG — the left-set,
	// haloed near-white gloss and the signed reclaim total ride along, so the saved image
	// carries its own context with no separate caption needed.
	expect(card).toMatch(
		/<text x="80"[^>]*text-anchor="start"[^>]*>\+175,537 tokens<\/text>/,
	);
	expect(card).toContain("+175,537 tokens");
	expect(text(doc, "shareStatus")).toBe("Saved clawback-97pct.png.");
	teardown(dom);
});

test("share image hands the device a PNG file plus the brag text", async () => {
	const shareCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => {
			installRasterStubs(win, {});
			installShareStubs(win, { shareCalls, canShare: true });
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareNative").click();
	await settle(dom);
	expect(shareCalls.length).toBe(1);
	const data = shareCalls[0];
	expect(data.text).toBe("I just clawback'd 97% of my tokens!");
	expect(data.files.length).toBe(1);
	expect(data.files[0].name).toBe("clawback-97pct.png");
	expect(data.files[0].type).toBe("image/png");
	expect(text(doc, "shareStatus")).toBe("Shared.");
	teardown(dom);
});

test("share image posts text only when the device won't accept the file", async () => {
	const shareCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => {
			installRasterStubs(win, {});
			installShareStubs(win, { shareCalls, canShare: false });
		},
	});
	await settle(dom);
	dom.window.document.getElementById("shareNative").click();
	await settle(dom);
	expect(shareCalls.length).toBe(1);
	// canShare === false → no files key, but the brag still goes through.
	expect(shareCalls[0].files).toBeUndefined();
	expect(shareCalls[0].text).toBe("I just clawback'd 97% of my tokens!");
	teardown(dom);
});

test("dismissing the share sheet (AbortError) is not reported as a failure", async () => {
	const abort = new Error("user cancelled");
	abort.name = "AbortError";
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => {
			installRasterStubs(win, {});
			installShareStubs(win, { shareImpl: () => Promise.reject(abort) });
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareNative").click();
	await settle(dom);
	// The handler swallows AbortError: status rests at the pre-share message,
	// never an error.
	expect(text(doc, "shareStatus")).toBe("Preparing to share…");
	expect(text(doc, "shareStatus")).not.toMatch(/fail/i);
	teardown(dom);
});

// ---- consent chooser + publish to the share host ----
//
// Clicking the card is the deliberate opt-in gesture. The DEFAULT posture is
// silent: nothing is uploaded until the user picks a tier in the chooser. "local"
// only downloads; "minimal"/"full" POST tier-filtered data to og.clawback.md and
// open X carrying the returned image URL. The pick is remembered so a later click
// acts directly. The host is built elsewhere; if it's unreachable we fall back to
// a local save.

test("the 'sharing…' button opens the chooser to manage or withdraw consent", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	expect(doc.getElementById("shareSettings").textContent).toBe("sharing…");
	const backdrop = doc.getElementById("shareDialogBackdrop");
	expect(backdrop.classList.contains("hidden")).toBe(true);
	doc.getElementById("shareSettings").click();
	await settle(dom);
	expect(backdrop.classList.contains("hidden")).toBe(false);
	teardown(dom);
});

test("choosing 'Download only' saves the PNG and contacts no host", async () => {
	const objectUrls = [];
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes()),
		prep: (win) => {
			installRasterStubs(win, { objectUrls });
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	chooseTier(dom, "local");
	await settle(dom);
	// Local = download only: a blob URL is minted, no host POST, no X intent.
	expect(objectUrls.length).toBe(1);
	expect(text(doc, "shareStatus")).toBe("Saved clawback-97pct.png.");
	expect(ogPost(dom)).toBeNull();
	expect(openCalls.length).toBe(0);
	// The chooser closed after confirming.
	expect(
		doc.getElementById("shareDialogBackdrop").classList.contains("hidden"),
	).toBe(true);
	teardown(dom);
});

test("choosing 'Unlisted card' posts ONLY the card words and opens X with the hosted card page", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes({ [OG]: () => ({ id: "uuid-1" }) })),
		prep: (win) => {
			installRasterStubs(win, {});
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	chooseTier(dom, "minimal");
	await settle(dom);
	// Exactly one POST to the host, anonymous (credentials omitted), CORS mode.
	const post = ogPost(dom);
	expect(post).toBeTruthy();
	expect(post.method).toBe("POST");
	expect(post.credentials).toBe("omit");
	expect(post.mode).toBe("cors");
	// The minimal body carries ONLY the card-draw words — no stats/run/handle.
	expect(Object.keys(post.body).sort()).toEqual(["card", "tier", "v"]);
	expect(post.body.tier).toBe("minimal");
	expect(post.body.card.headline).toBe("+97%");
	expect(post.body.stats).toBeUndefined();
	expect(post.body.run).toBeUndefined();
	expect(post.body.attribution).toBeUndefined();
	// X opens carrying the brag + the hosted card-PAGE URL: og.clawback.md serves
	// that page with OpenGraph tags whose og:image surfaces the rendered PNG, so
	// the unfurl is a rich owned surface rather than a bare image hotlink.
	expect(openCalls.length).toBe(1);
	const u = new dom.window.URL(openCalls[0][0]);
	expect(u.origin + u.pathname).toBe("https://twitter.com/intent/tweet");
	expect(u.searchParams.get("text")).toBe(
		"I just clawback'd 97% of my tokens!",
	);
	expect(u.searchParams.get("url")).toBe("https://og.clawback.md/uuid-1");
	teardown(dom);
});

test("choosing 'Public card' with a handle posts stats, run provenance, and the handle", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes({ [OG]: () => ({ id: "uuid-9" }) })),
		prep: (win) => {
			installRasterStubs(win, {});
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	chooseTier(dom, "full", { handle: "@alex" });
	await settle(dom);
	const post = ogPost(dom);
	expect(post.body.tier).toBe("full");
	expect(post.body.stats.pct).toBeCloseTo(96.77, 1);
	expect(post.body.stats.reclaimedTotal).toBe(175537);
	// Provenance captured from the run summary, for leaderboard bucketing.
	expect(post.body.run.nTurns).toBe(19);
	expect(post.body.run.clawbackVersions).toEqual(["0.1.0"]);
	expect(post.body.attribution).toEqual({ handle: "@alex" });
	expect(openCalls.length).toBe(1);
	teardown(dom);
});

test("the handle field appears only for the public tier", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	const row = doc.getElementById("shareHandleRow");
	const pick = (tier) => {
		const r = doc.querySelector(`input[name="shareTier"][value="${tier}"]`);
		r.checked = true;
		r.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	};
	// Opens on the safe default (local) → handle hidden.
	expect(row.classList.contains("hidden")).toBe(true);
	pick("minimal");
	expect(row.classList.contains("hidden")).toBe(true);
	pick("full");
	expect(row.classList.contains("hidden")).toBe(false);
	pick("minimal");
	expect(row.classList.contains("hidden")).toBe(true);
	teardown(dom);
});

test("a remembered tier skips the chooser and acts straight away", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes({ [OG]: () => ({ id: "uuid-2" }) })),
		prep: (win) => {
			installRasterStubs(win, {});
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	// Seed a prior consent decision (as a previous confirm would have).
	dom.window.localStorage.setItem("clawback.share.tier", "minimal");
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	// The chooser never opened; the POST went straight out.
	expect(
		doc.getElementById("shareDialogBackdrop").classList.contains("hidden"),
	).toBe(true);
	expect(ogPost(dom).body.tier).toBe("minimal");
	expect(openCalls.length).toBe(1);
	teardown(dom);
});

test("when the share host is unreachable, the card falls back to a local download (and says why)", async () => {
	const objectUrls = [];
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(
			defaultRoutes({ [OG]: { __notOk: true, status: 502 } }),
		),
		prep: (win) => {
			installRasterStubs(win, { objectUrls });
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	chooseTier(dom, "minimal");
	await settle(dom);
	// The POST was attempted, failed, and we saved the PNG instead — the status
	// keeps the reason (it isn't silently overwritten by the plain "Saved" line).
	expect(ogPost(dom).method).toBe("POST");
	expect(objectUrls.length).toBe(1);
	expect(openCalls.length).toBe(0); // no X intent on the failure path
	const status = text(doc, "shareStatus");
	expect(status).toContain("Couldn't reach the share host");
	expect(status).toContain("Saved clawback-97pct.png.");
	teardown(dom);
});

test("the consent chooser is a labelled modal: Escape closes it and returns focus to the card", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	const dialog = doc.getElementById("shareDialog");
	// Modal semantics for assistive tech (WCAG 4.1.2).
	expect(dialog.getAttribute("role")).toBe("dialog");
	expect(dialog.getAttribute("aria-modal")).toBe("true");
	expect(dialog.getAttribute("aria-labelledby")).toBe("shareDialogTitle");
	expect(doc.getElementById("shareDialogTitle")).toBeTruthy();
	expect(dialog.getAttribute("aria-describedby")).toBe("shareDialogDesc");
	// Open via the card; focus moves INTO the dialog.
	const card = doc.getElementById("shareCardLink");
	card.focus();
	card.click();
	await settle(dom);
	expect(
		doc.getElementById("shareDialogBackdrop").classList.contains("hidden"),
	).toBe(false);
	expect(dialog.contains(doc.activeElement)).toBe(true);
	// Escape closes and returns focus to the opener (WCAG 2.4.3).
	dialog.dispatchEvent(
		new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
	);
	await settle(dom);
	expect(
		doc.getElementById("shareDialogBackdrop").classList.contains("hidden"),
	).toBe(true);
	expect(doc.activeElement).toBe(card);
	teardown(dom);
});

test("clicking the backdrop cancels the chooser without sending anything", async () => {
	const openCalls = [];
	const dom = bootReport({
		fetchImpl: makeFetch(defaultRoutes({ [OG]: () => ({ id: "x" }) })),
		prep: (win) => {
			installRasterStubs(win, {});
			installOpenSpy(win, openCalls);
		},
	});
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	const backdrop = doc.getElementById("shareDialogBackdrop");
	expect(backdrop.classList.contains("hidden")).toBe(false);
	// A click on the backdrop itself (target === backdrop) cancels, like Escape.
	backdrop.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await settle(dom);
	expect(backdrop.classList.contains("hidden")).toBe(true);
	// Cancelling sends nothing.
	expect(ogPost(dom)).toBeNull();
	expect(openCalls.length).toBe(0);
	teardown(dom);
});

test("Tab is trapped within the chooser (focus cycles, never escapes to the page)", async () => {
	const dom = bootReport({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	doc.getElementById("shareCardLink").click();
	await settle(dom);
	const dialog = doc.getElementById("shareDialog");
	// Same focusable set the trap computes: skip anything in a .hidden subtree.
	const focusables = Array.from(
		dialog.querySelectorAll(
			'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
		),
	).filter((el) => !el.closest(".hidden"));
	const first = focusables[0];
	const last = focusables[focusables.length - 1];
	expect(first).toBeTruthy();
	expect(last).not.toBe(first);
	// Tab off the last control wraps to the first.
	last.focus();
	dialog.dispatchEvent(
		new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
	);
	expect(doc.activeElement).toBe(first);
	// Shift+Tab off the first wraps to the last.
	first.focus();
	dialog.dispatchEvent(
		new dom.window.KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
		}),
	);
	expect(doc.activeElement).toBe(last);
	teardown(dom);
});
