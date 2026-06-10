import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, "../src/ui");

const HTML_RAW = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
const APP_JS_RAW = fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8");
const AGG_JS_RAW = fs.readFileSync(path.join(UI_DIR, "aggregation.js"), "utf8");

// jsdom does not execute <script type="module">. We splice aggregation.js
// and app.js into a single inline script (after stripping their `export`
// and `import` statements) and inject them in dependency order.
const HTML_NO_MODULE = HTML_RAW.replace(
	/<script type="module" src="\/_proxy\/ui\/app\.js"><\/script>/,
	"",
);

function stripExports(source) {
	// `export function`/`export const`/`export {…}` → equivalent without
	// the export keyword. Crude but adequate for the small surface we
	// own (aggregation.js).
	return source
		.replace(/^export\s+function\s/gm, "function ")
		.replace(/^export\s+const\s/gm, "const ")
		.replace(/^export\s+\{[^}]+\};?$/gm, "");
}

function stripImports(source) {
	// Remove any `import … from "…";` statement (single or multi-line).
	return source.replace(/^import\s+[^;]+;\s*$/gms, "");
}

const INLINED_JS = `${stripExports(AGG_JS_RAW)}\n${stripImports(APP_JS_RAW)}`;

function bootUi({ fetchImpl, seedLocalStorage } = {}) {
	const virtualConsole = new VirtualConsole();
	virtualConsole.on("jsdomError", () => {
		// silence resource-loading errors from the absent stylesheet
	});
	const dom = new JSDOM(HTML_NO_MODULE, {
		runScripts: "dangerously",
		url: "http://localhost/_proxy/ui/",
		virtualConsole,
	});
	if (seedLocalStorage) {
		dom.window.localStorage.setItem(
			"clawback.ui.v2",
			JSON.stringify(seedLocalStorage),
		);
	}
	const fetchCalls = [];
	dom.window.fetch = async (url, init) => {
		fetchCalls.push({ url: String(url), init: init ?? null });
		return fetchImpl(url, init);
	};
	dom.fetchCalls = fetchCalls;
	const intervalCalls = [];
	dom.window.setInterval = (_fn, ms) => {
		intervalCalls.push(ms);
		return 0;
	};
	dom.intervalCalls = intervalCalls;

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

function makeFetch(routes) {
	return async (url, init) => {
		const u = String(url);
		for (const [pattern, handler] of Object.entries(routes)) {
			if (u.startsWith(pattern)) {
				const body =
					typeof handler === "function"
						? handler({
								url: u,
								method: init?.method?.toUpperCase() ?? "GET",
								init,
							})
						: handler;
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify(body),
					json: async () => body,
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

function defaultRoutes() {
	return {
		"/_proxy/metrics": { samples: [], capacity: 2000, returned: 0 },
		"/_proxy/sessions": { count: 0, sessions: [] },
		"/_proxy/passthrough": {
			passthrough: false,
			injectExtendedCacheTtl: true,
			stripEphemeralFromSystem: true,
			keepAliveEnabled: true,
		},
		"/_proxy/keep-alive": { keepAliveEnabled: true, passthrough: false },
		"/_proxy/strip-ephemeral": {
			stripEphemeralFromSystem: true,
			passthrough: false,
		},
		"/_proxy/health": {
			status: "ok",
			config: {
				statuslineTpsThresholdLow: 30,
				statuslineTpsThresholdHigh: 80,
				statuslineTtftThresholdLowMs: 500,
				statuslineTtftThresholdHighMs: 2000,
			},
		},
	};
}

const METRIC_KEYS = [
	"context",
	"quota", // combined next + week
	"hit",
	"turn",
	"tps",
	"ttft",
];

// The charts use a now-anchored 15-minute display window, so chart
// fixtures must carry timestamps relative to the present, not fixed
// historical dates — otherwise every sample ages out of the window and
// the charts render empty. `tsAgo(60)` is "one minute ago".
const tsAgo = (secondsAgo) =>
	new Date(Date.now() - secondsAgo * 1000).toISOString();

function sampleA() {
	return {
		ts: tsAgo(120),
		source: "statusline",
		sessionKey: "alpha111",
		label: "alpha",
		context: 10,
		next: 20,
		week: 5,
		hit: 50,
		turn: 60,
		tps: 70,
		ttft: 800,
		mode: {
			passthrough: false,
			keepAliveEnabled: true,
			stripEphemeralFromSystem: true,
		},
	};
}

function sampleB() {
	return {
		ts: tsAgo(60),
		source: "upstream",
		sessionKey: "beta2222",
		label: "beta",
		context: 30,
		next: 21,
		week: 6,
		hit: 80,
		turn: 75,
		tps: 90,
		ttft: 600,
		mode: {
			passthrough: false,
			keepAliveEnabled: true,
			stripEphemeralFromSystem: true,
		},
	};
}

function twoSessionRoutes() {
	return {
		...defaultRoutes(),
		"/_proxy/metrics": {
			samples: [sampleA(), sampleB()],
			capacity: 2000,
			returned: 2,
		},
		"/_proxy/sessions": {
			count: 2,
			sessions: [
				{
					key: "alpha111",
					label: "alpha",
					labelSource: "operator",
					mode: "path",
				},
				{
					key: "beta2222",
					label: "beta",
					labelSource: "operator",
					mode: "path",
				},
			],
		},
	};
}

test("UI structure: control buttons, sessions bar, one chart card per metric", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);

	const doc = dom.window.document;

	// Mode toggles + clear button.
	for (const id of [
		"enabledToggle",
		"keepAliveToggle",
		"stripEphemeralToggle",
		"extendCacheTtlToggle",
		"mobileToggle",
		"keepAliveExtendedToggle",
		"autoContinueToggle",
		"clearHistoryBtn",
	]) {
		expect(doc.getElementById(id)).not.toBeNull();
	}

	// Sessions section.
	expect(doc.getElementById("sessionsBar")).not.toBeNull();
	expect(doc.getElementById("sessionsTable")).not.toBeNull();
	expect(doc.getElementById("sessionsTableBody")).not.toBeNull();
	expect(doc.getElementById("aggregateToggle")).not.toBeNull();
	expect(doc.getElementById("showAllBtn")).not.toBeNull();
	expect(doc.getElementById("showNoneBtn")).not.toBeNull();
	expect(doc.getElementById("purgeAllBtn")).not.toBeNull();
	expect(doc.getElementById("clearFocusBtn")).not.toBeNull();

	// Overview section.
	expect(doc.getElementById("overviewChart")).not.toBeNull();
	expect(doc.getElementById("overviewLegend")).not.toBeNull();

	// One chart card per metric.
	const grid = doc.getElementById("chartsGrid");
	expect(grid).not.toBeNull();
	for (const key of METRIC_KEYS) {
		const card = grid.querySelector(`.chart-card[data-metric="${key}"]`);
		expect(card).not.toBeNull();
	}
	expect(grid.querySelectorAll(".chart-card").length).toBe(METRIC_KEYS.length);

	// No remnants of the §33 single-chart layout.
	expect(doc.getElementById("chart")).toBeNull();
	expect(doc.getElementById("legend")).toBeNull();
	expect(doc.getElementById("readout")).toBeNull();
	teardown(dom);
});

test("empty state shown per chart when no samples have arrived", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	const empties = doc.querySelectorAll(".chart-card .empty");
	expect(empties.length).toBe(METRIC_KEYS.length);
	expect(empties[0].textContent).toMatch(/no samples yet/);
	teardown(dom);
});

test("button labels reflect fetched toggle state", async () => {
	const dom = bootUi({
		fetchImpl: makeFetch({
			...defaultRoutes(),
			"/_proxy/passthrough": {
				passthrough: true,
				injectExtendedCacheTtl: false,
				stripEphemeralFromSystem: false,
				keepAliveEnabled: false,
			},
			"/_proxy/keep-alive": { keepAliveEnabled: false, passthrough: true },
			"/_proxy/strip-ephemeral": {
				stripEphemeralFromSystem: false,
				passthrough: true,
			},
		}),
	});
	await settle(dom);
	const doc = dom.window.document;
	// Header enabled switch reflects the inverse of passthrough: when
	// passthrough is ON, the switch is in its "baseline" (off) state.
	const enabledSwitch = doc.getElementById("enabledToggle");
	expect(enabledSwitch.classList.contains("on")).toBe(false);
	expect(enabledSwitch.getAttribute("aria-pressed")).toBe("false");
	expect(enabledSwitch.textContent).toMatch(/baseline/);
	expect(doc.getElementById("keepAliveToggle").disabled).toBe(true);
	expect(doc.getElementById("stripEphemeralToggle").disabled).toBe(true);
	teardown(dom);
});

test("baseline banner shows data-mode='baseline' when passthrough is on", async () => {
	const dom = bootUi({
		fetchImpl: makeFetch({
			...defaultRoutes(),
			"/_proxy/passthrough": {
				passthrough: true,
				injectExtendedCacheTtl: false,
				stripEphemeralFromSystem: false,
				keepAliveEnabled: false,
			},
			"/_proxy/keep-alive": { keepAliveEnabled: false, passthrough: true },
			"/_proxy/strip-ephemeral": {
				stripEphemeralFromSystem: false,
				passthrough: true,
			},
		}),
	});
	await settle(dom);
	const banner = dom.window.document.getElementById("baselineBanner");
	expect(banner.dataset.mode).toBe("baseline");
	expect(banner.classList.contains("hidden")).toBe(false);
	teardown(dom);
});

test("baseline banner shows data-mode='treatment' when passthrough is off", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const banner = dom.window.document.getElementById("baselineBanner");
	expect(banner.dataset.mode).toBe("treatment");
	expect(banner.classList.contains("hidden")).toBe(false);
	// Both message spans live in the DOM; CSS picks which one to display.
	expect(banner.querySelector(".banner-text-baseline")).not.toBeNull();
	expect(banner.querySelector(".banner-text-treatment")).not.toBeNull();
	teardown(dom);
});

test("clicking the enabled switch POSTs the passthrough toggle action", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("enabledToggle").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) => c.url.startsWith("/_proxy/passthrough") && c.init?.method === "POST",
	);
	expect(postCall).toBeDefined();
	expect(JSON.parse(postCall.init.body)).toEqual({ action: "toggle" });
	teardown(dom);
});

test("clicking keep-alive toggle POSTs to /_proxy/keep-alive", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("keepAliveToggle").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) => c.url.startsWith("/_proxy/keep-alive") && c.init?.method === "POST",
	);
	expect(postCall).toBeDefined();
	teardown(dom);
});

test("clicking strip-ephemeral toggle POSTs to /_proxy/strip-ephemeral", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("stripEphemeralToggle").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) =>
			c.url.startsWith("/_proxy/strip-ephemeral") && c.init?.method === "POST",
	);
	expect(postCall).toBeDefined();
	teardown(dom);
});

test("per-session delete button DELETEs /_proxy/sessions/<id> after confirm", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	// jsdom doesn't provide window.confirm; mock to always accept.
	dom.window.confirm = () => true;
	await settle(dom);
	dom.fetchCalls.length = 0;
	const deleteBtn = dom.window.document.querySelector(
		'#sessionsTableBody tr[data-session-key="alpha111"] .row-actions .danger',
	);
	expect(deleteBtn).not.toBeNull();
	deleteBtn.click();
	await settle(dom);
	const deleteCall = dom.fetchCalls.find(
		(c) => c.url === "/_proxy/sessions/alpha111" && c.init?.method === "DELETE",
	);
	expect(deleteCall).toBeDefined();
	teardown(dom);
});

test("the _aggregate bucket ('default') is not rendered as a session row", async () => {
	// A statusline sample with no sessionKey routes to the _aggregate bucket
	// (legacy/unattributed). That bucket is a metrics rollup, not a real store
	// session — it has no eviction time and isn't independently deletable — so
	// it must NOT surface as a row in the sessions table.
	const routes = {
		...defaultRoutes(),
		"/_proxy/metrics": {
			samples: [
				{
					ts: "2026-05-17T12:00:00Z",
					source: "statusline",
					hit: 50,
					context: 10,
					next: 20,
					week: 5,
				},
			],
			capacity: 2000,
			returned: 1,
		},
	};
	const dom = bootUi({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const aggRow = dom.window.document.querySelector(
		'#sessionsTableBody tr[data-session-key="_aggregate"]',
	);
	expect(aggRow).toBeNull();
	// With no real sessions present, the table shows its empty state rather
	// than a phantom "default" row.
	const empty = dom.window.document.querySelector(".sessions-table-empty");
	expect(empty).not.toBeNull();
	teardown(dom);
});

test("purge-all DELETEs /_proxy/sessions after confirm", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	dom.window.confirm = () => true;
	await settle(dom);
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("purgeAllBtn").click();
	await settle(dom);
	const deleteCall = dom.fetchCalls.find(
		(c) => c.url === "/_proxy/sessions" && c.init?.method === "DELETE",
	);
	expect(deleteCall).toBeDefined();
	teardown(dom);
});

test("purge cancelled at confirm sends no DELETE", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	dom.window.confirm = () => false;
	await settle(dom);
	dom.fetchCalls.length = 0;
	dom.window.document
		.querySelector(
			'#sessionsTableBody tr[data-session-key="alpha111"] .row-actions .danger',
		)
		.click();
	await settle(dom);
	const deleteCall = dom.fetchCalls.find((c) => c.init?.method === "DELETE");
	expect(deleteCall).toBeUndefined();
	teardown(dom);
});

test("clicking clear-history POSTs {action: 'clear'} to /_proxy/metrics", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	// jsdom's confirm() returns false by default — accept so the POST fires.
	dom.window.confirm = () => true;
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("clearHistoryBtn").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) => c.url.startsWith("/_proxy/metrics") && c.init?.method === "POST",
	);
	expect(postCall).toBeDefined();
	expect(JSON.parse(postCall.init.body)).toEqual({ action: "clear" });
	teardown(dom);
});

// ---- shadow baseline-capture toggle ------------------------------------

// GET returns the idle status (with a configurable defaultShadow); POST
// echoes the requested shadow back as an armed capture so the toast +
// state pick it up. Mirrors the real /_proxy/capture-baseline contract.
function captureRoutes({ defaultShadow = false } = {}) {
	return {
		...defaultRoutes(),
		"/_proxy/capture-baseline": ({ method, init }) => {
			if (method === "POST") {
				const reqShadow = Boolean(JSON.parse(init?.body ?? "{}").shadow);
				return {
					active: true,
					turnsRemaining: 5,
					targetTurns: 5,
					startedAt: new Date().toISOString(),
					shadow: reqShadow,
					defaultShadow,
				};
			}
			return {
				active: false,
				turnsRemaining: 0,
				targetTurns: 0,
				startedAt: null,
				shadow: false,
				defaultShadow,
			};
		},
	};
}

test("shadow toggle unchecked: capture POSTs {shadow:false} and warn note stays hidden", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(captureRoutes()) });
	await settle(dom);
	const warn = dom.window.document.getElementById("captureShadowWarn");
	expect(warn.hidden).toBe(true);
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("captureBaselineBtn").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) =>
			c.url.startsWith("/_proxy/capture-baseline") && c.init?.method === "POST",
	);
	expect(postCall).toBeDefined();
	expect(JSON.parse(postCall.init.body)).toEqual({ shadow: false });
	teardown(dom);
});

test("checking shadow toggle reveals the 2× warn note and relabels the button", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(captureRoutes()) });
	await settle(dom);
	const toggle = dom.window.document.getElementById("captureShadowToggle");
	const warn = dom.window.document.getElementById("captureShadowWarn");
	const btn = dom.window.document.getElementById("captureBaselineBtn");
	toggle.checked = true;
	toggle.dispatchEvent(new dom.window.Event("change"));
	// The note carries the meaning in text (WCAG 1.4.1 — not color alone).
	expect(warn.hidden).toBe(false);
	expect(warn.textContent).toMatch(/twice/i);
	expect(btn.textContent).toContain("×2");
	teardown(dom);
});

test("shadow toggle checked: capture POSTs {shadow:true} and toast names the 2× cost", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(captureRoutes()) });
	await settle(dom);
	const toggle = dom.window.document.getElementById("captureShadowToggle");
	toggle.checked = true;
	toggle.dispatchEvent(new dom.window.Event("change"));
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("captureBaselineBtn").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) =>
			c.url.startsWith("/_proxy/capture-baseline") && c.init?.method === "POST",
	);
	expect(postCall).toBeDefined();
	expect(JSON.parse(postCall.init.body)).toEqual({ shadow: true });
	teardown(dom);
});

test("defaultShadow:true seeds the toggle checked on first poll", async () => {
	const dom = bootUi({
		fetchImpl: makeFetch(captureRoutes({ defaultShadow: true })),
	});
	await settle(dom);
	const toggle = dom.window.document.getElementById("captureShadowToggle");
	const warn = dom.window.document.getElementById("captureShadowWarn");
	expect(toggle.checked).toBe(true);
	expect(warn.hidden).toBe(false);
	teardown(dom);
});

test("suggestion cards stay hidden until the metrics ring has at least one sample", async () => {
	// `/_proxy/suggestions` can fire rules on fresh boot (e.g.
	// extended-cadence-with-1h is a pure config check). Without traffic
	// to verify the suggestion's premise, surfacing the card is just
	// noise — gate rendering on samples.length > 0. `try-baseline` is
	// used here because it isn't mapped to any chart, so it renders in
	// the global suggestions card (easier to assert on than the linked
	// variant).
	const firedSuggestion = {
		id: "try-baseline",
		knob: "passthrough",
		severity: "info",
		message: "run a quick baseline",
		applyEndpoint: "passthrough",
		applyBody: { action: "on" },
	};

	// Empty samples → suggestion card hidden, no linked-suggestion DOM.
	const emptyRoutes = {
		...defaultRoutes(),
		"/_proxy/suggestions": { suggestions: [firedSuggestion] },
	};
	const dom = bootUi({ fetchImpl: makeFetch(emptyRoutes) });
	await settle(dom);
	const doc = dom.window.document;
	expect(
		doc.getElementById("suggestionsCard").classList.contains("hidden"),
	).toBe(true);
	expect(doc.querySelectorAll(".linked-suggestion").length).toBe(0);
	teardown(dom);

	// One sample → same suggestion renders in the global card.
	const withSample = {
		...emptyRoutes,
		"/_proxy/metrics": { samples: [sampleA()], capacity: 2000, returned: 1 },
		"/_proxy/sessions": {
			count: 1,
			sessions: [
				{ key: "alpha111", label: "alpha", labelSource: "auto", mode: "path" },
			],
		},
	};
	const dom2 = bootUi({ fetchImpl: makeFetch(withSample) });
	await settle(dom2);
	const doc2 = dom2.window.document;
	expect(
		doc2.getElementById("suggestionsCard").classList.contains("hidden"),
	).toBe(false);
	expect(
		doc2.querySelectorAll("#suggestionsList .suggestion").length,
	).toBeGreaterThan(0);
	teardown(dom2);
});

test("clear-history cancelled at confirm sends no POST", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	dom.window.confirm = () => false;
	dom.fetchCalls.length = 0;
	dom.window.document.getElementById("clearHistoryBtn").click();
	await settle(dom);
	const postCall = dom.fetchCalls.find(
		(c) => c.url.startsWith("/_proxy/metrics") && c.init?.method === "POST",
	);
	expect(postCall).toBeUndefined();
	teardown(dom);
});

test("sessions table renders one row per session from /_proxy/sessions", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	const rows = doc.querySelectorAll("#sessionsTableBody tr");
	expect(rows.length).toBe(2);
	const keys = Array.from(rows).map((r) => r.dataset.sessionKey);
	expect(keys.sort()).toEqual(["alpha111", "beta2222"]);
	teardown(dom);
});

test("each chart renders per-session paths plus the aggregate line", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	// Pick a metric with an aggregator: `hit` (weighted-mean).
	const hitCard = doc.querySelector('.chart-card[data-metric="hit"]');
	const sessionPaths = hitCard.querySelectorAll("path.series-session");
	const aggPaths = hitCard.querySelectorAll("path.series-aggregate");
	expect(sessionPaths.length).toBe(2);
	expect(aggPaths.length).toBe(1);
	// And a metric without aggregator: `turn` — only sessions.
	const turnCard = doc.querySelector('.chart-card[data-metric="turn"]');
	expect(turnCard.querySelectorAll("path.series-session").length).toBe(2);
	expect(turnCard.querySelectorAll("path.series-aggregate").length).toBe(0);
	teardown(dom);
});

test("re-render reuses chart-card and hover nodes instead of tearing them down (no jank)", async () => {
	// Regression: renderChartsGrid used to do `grid.innerHTML = ""` and
	// rebuild every card on each poll tick (4×/s at refreshMs 250). That
	// collapsed the grid to zero height and re-expanded it every tick —
	// the page reflowed, scroll jumped, charts resize-jittered, and hover
	// overlays were destroyed despite a comment claiming they persist.
	// The invariant that proves the jank is gone: the card and hover DOM
	// nodes are the SAME element references across re-renders.
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	const grid = doc.getElementById("chartsGrid");

	const cardBefore = grid.querySelector('.chart-card[data-metric="tps"]');
	const hoverBefore = cardBefore.querySelector(".chart-hover");
	const holderBefore = cardBefore.querySelector(".mini-chart");
	expect(cardBefore).not.toBeNull();
	expect(hoverBefore).not.toBeNull();

	// Force a second full render cycle (same path a poll tick takes).
	doc.getElementById("showAllBtn").click();
	await settle(dom);

	const cardAfter = grid.querySelector('.chart-card[data-metric="tps"]');
	// Same node, still attached — not a freshly-built replacement.
	expect(cardAfter).toBe(cardBefore);
	expect(cardBefore.isConnected).toBe(true);
	expect(cardAfter.querySelector(".chart-hover")).toBe(hoverBefore);
	expect(cardAfter.querySelector(".mini-chart")).toBe(holderBefore);
	// Still exactly one card per metric (no duplicates from re-rendering).
	expect(grid.querySelectorAll(".chart-card").length).toBe(METRIC_KEYS.length);
	// And the chart still painted into the reused holder.
	expect(holderBefore.querySelector("svg")).not.toBeNull();
	teardown(dom);
});

test("chart x-axis is anchored to now(): a recent sample sits near the right edge, not at the left", async () => {
	// "Anchor to now()" — the right edge of every chart is the present
	// moment, so a sample from a minute ago sits just inside the right
	// edge and recedes leftward as time passes (the window visibly empties
	// out when traffic stops). With the old data-extent x-domain a lone
	// sample landed at the LEFT edge (tsMin === tsMax === its own ts), so
	// this is the regression that proves the axis is now-anchored.
	const routes = {
		...defaultRoutes(),
		"/_proxy/metrics": {
			samples: [{ ...sampleA(), ts: tsAgo(60) }],
			capacity: 2000,
			returned: 1,
		},
		"/_proxy/sessions": {
			count: 1,
			sessions: [
				{
					key: "alpha111",
					label: "alpha",
					labelSource: "operator",
					mode: "path",
				},
			],
		},
	};
	const dom = bootUi({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	const card = doc.querySelector('.chart-card[data-metric="hit"]');
	const path = card.querySelector("path.series-session");
	expect(path).not.toBeNull();
	// First (and only) point's x coordinate from the path's "M x y …".
	const m = path.getAttribute("d").match(/M\s+([\d.]+)\s+[\d.]+/);
	expect(m).not.toBeNull();
	const xCoord = Number(m[1]);
	// jsdom has no layout, so clientWidth is 0 → the chart falls back to
	// a 360px-wide SVG (left pad 44, right edge 348). A sample 60s ago in
	// a 15-min window lands at ~327 (well into the right portion). The
	// old data-extent code put a lone point at the left pad (44).
	expect(xCoord).toBeGreaterThan(196); // right half, not the left edge
	expect(xCoord).toBeLessThan(348); // strictly inside the right edge (now > sample)
	teardown(dom);
});

test("chart line is forward-filled to now() so it reaches the right edge (reads as anchored)", async () => {
	// Msg-5 bug: with the now-anchored x-domain the latest sample sits LEFT
	// of the right edge and the line stops there, so as `now` advances each
	// tick a blank strip grows on the right — the line appears to drift away
	// from the anchor rather than be pinned to it. Worse, a lone sample is a
	// bare `M` moveto with no segment at all ("the lines aren't painting").
	// The fix forward-fills the last value flat to the right edge (now), the
	// standard live-tail idiom, so every line is visibly pinned to now.
	const routes = {
		...defaultRoutes(),
		"/_proxy/metrics": {
			samples: [{ ...sampleA(), ts: tsAgo(120) }],
			capacity: 2000,
			returned: 1,
		},
		"/_proxy/sessions": {
			count: 1,
			sessions: [
				{
					key: "alpha111",
					label: "alpha",
					labelSource: "operator",
					mode: "path",
				},
			],
		},
	};
	const dom = bootUi({ fetchImpl: makeFetch(routes) });
	await settle(dom);
	const doc = dom.window.document;
	const card = doc.querySelector('.chart-card[data-metric="hit"]');
	const path = card.querySelector("path.series-session");
	expect(path).not.toBeNull();
	// Every x coordinate out of the "M x y L x y …" path data.
	const xs = [
		...path.getAttribute("d").matchAll(/[ML]\s+([\d.]+)\s+[\d.]+/g),
	].map((m) => Number(m[1]));
	// A single sample must now paint a segment (≥2 points), not a lone point.
	expect(xs.length).toBeGreaterThanOrEqual(2);
	// jsdom: pad.l(44) + innerW(304) = 348 is the right edge (= now). The
	// forward-filled tail lands exactly there, so the line reaches now.
	expect(Math.max(...xs)).toBeCloseTo(348, 0);
	teardown(dom);
});

test("clicking a session's focus button restricts every chart to that session", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;

	// Before: both sessions visible on the hit card.
	const hitCard = () => doc.querySelector('.chart-card[data-metric="hit"]');
	expect(hitCard().querySelectorAll("path.series-session").length).toBe(2);

	// Focus "alpha111".
	const focusBtn = doc.querySelector(
		'#sessionsTableBody tr[data-session-key="alpha111"] .focus-btn',
	);
	focusBtn.click();
	await settle(dom);

	// Only alpha's line remains.
	expect(hitCard().querySelectorAll("path.series-session").length).toBe(1);
	// The focused row picks up a `.focused` class.
	expect(
		doc
			.querySelector('#sessionsTableBody tr[data-session-key="alpha111"]')
			.classList.contains("focused"),
	).toBe(true);
	// The clear-focus button is now visible.
	expect(doc.getElementById("clearFocusBtn").classList.contains("hidden")).toBe(
		false,
	);

	// Clearing focus restores both lines.
	doc.getElementById("clearFocusBtn").click();
	await settle(dom);
	expect(hitCard().querySelectorAll("path.series-session").length).toBe(2);
	teardown(dom);
});

test("aggregate toggle hides aggregate lines on every chart", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	// Pre-click: aggregator metrics have an aggregate path.
	expect(doc.querySelectorAll("path.series-aggregate").length).toBeGreaterThan(
		0,
	);

	doc.getElementById("aggregateToggle").click();
	await settle(dom);

	expect(doc.querySelectorAll("path.series-aggregate").length).toBe(0);
	teardown(dom);
});

test("show-none / show-all buttons flip every session visibility", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;

	doc.getElementById("showNoneBtn").click();
	await settle(dom);
	const hitCard = () => doc.querySelector('.chart-card[data-metric="hit"]');
	expect(hitCard().querySelectorAll("path.series-session").length).toBe(0);
	expect(
		doc.querySelectorAll("#sessionsTableBody tr.hidden-session").length,
	).toBe(2);

	doc.getElementById("showAllBtn").click();
	await settle(dom);
	expect(hitCard().querySelectorAll("path.series-session").length).toBe(2);
	expect(
		doc.querySelectorAll("#sessionsTableBody tr.hidden-session").length,
	).toBe(0);
	teardown(dom);
});

test("focus selection persists to localStorage and rehydrates on next load", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	dom.window.document
		.querySelector(
			'#sessionsTableBody tr[data-session-key="alpha111"] .focus-btn',
		)
		.click();
	await settle(dom);

	const stored = JSON.parse(dom.window.localStorage.getItem("clawback.ui.v2"));
	expect(stored.focusedSession).toBe("alpha111");
	teardown(dom);

	// Boot again with focus seeded — alpha should be the only line.
	const dom2 = bootUi({
		fetchImpl: makeFetch(twoSessionRoutes()),
		seedLocalStorage: {
			aggregate: true,
			sessions: {},
			focusedSession: "alpha111",
		},
	});
	await settle(dom2);
	const hitCard2 = dom2.window.document.querySelector(
		'.chart-card[data-metric="hit"]',
	);
	expect(hitCard2.querySelectorAll("path.series-session").length).toBe(1);
	expect(
		dom2.window.document
			.querySelector('#sessionsTableBody tr[data-session-key="alpha111"]')
			.classList.contains("focused"),
	).toBe(true);
	teardown(dom2);
});

test("mode-change vertical markers are drawn when mode snapshot differs between samples", async () => {
	const sA = sampleA();
	const sB = {
		...sampleA(),
		ts: tsAgo(90),
		mode: {
			passthrough: true,
			keepAliveEnabled: false,
			stripEphemeralFromSystem: false,
		},
	};
	const dom = bootUi({
		fetchImpl: makeFetch({
			...defaultRoutes(),
			"/_proxy/metrics": {
				samples: [sA, sB],
				capacity: 2000,
				returned: 2,
			},
			"/_proxy/sessions": {
				count: 1,
				sessions: [
					{
						key: "alpha111",
						label: "alpha",
						labelSource: "auto",
						mode: "path",
					},
				],
			},
		}),
	});
	await settle(dom);
	// Each chart card receives the same three markers (one per
	// transition). The hit card is a good representative.
	const hitCard = dom.window.document.querySelector(
		'.chart-card[data-metric="hit"]',
	);
	expect(hitCard.querySelectorAll("svg line.mode-line").length).toBe(3);
	teardown(dom);
});

test("refresh select re-schedules polling on change", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	// Default is 0.25s (operator-tuned 2026-05-29).
	expect(dom.intervalCalls).toEqual([250]);
	const select = dom.window.document.getElementById("refreshSelect");
	select.value = "2000";
	select.dispatchEvent(new dom.window.Event("change"));
	expect(dom.intervalCalls).toEqual([250, 2000]);
	select.value = "0";
	select.dispatchEvent(new dom.window.Event("change"));
	expect(dom.intervalCalls).toEqual([250, 2000]);
	teardown(dom);
});

test("status text reflects sample and session count", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	expect(dom.window.document.getElementById("statusText").textContent).toMatch(
		/2 samples · 2 sessions/,
	);
	teardown(dom);
});

// --- a11y contracts ------------------------------------------------------

test("toggle buttons expose aria-pressed reflecting fetched state", async () => {
	const dom = bootUi({
		fetchImpl: makeFetch({
			...defaultRoutes(),
			"/_proxy/passthrough": {
				passthrough: true,
				injectExtendedCacheTtl: false,
				stripEphemeralFromSystem: false,
				keepAliveEnabled: false,
			},
			"/_proxy/keep-alive": { keepAliveEnabled: false, passthrough: true },
			"/_proxy/strip-ephemeral": {
				stripEphemeralFromSystem: false,
				passthrough: true,
			},
		}),
	});
	await settle(dom);
	const doc = dom.window.document;
	// Enabled switch carries the inverse semantic: passthrough=ON →
	// aria-pressed="false" (clawback is in baseline mode).
	expect(doc.getElementById("enabledToggle").getAttribute("aria-pressed")).toBe(
		"false",
	);
	expect(
		doc.getElementById("keepAliveToggle").getAttribute("aria-pressed"),
	).toBe("false");
	teardown(dom);
});

test("enabled switch aria-pressed flips after a click (inverse of passthrough)", async () => {
	const state = { passthrough: false };
	const fetchImpl = async (url, init) => {
		const u = String(url);
		if (u.startsWith("/_proxy/passthrough")) {
			if (init?.method === "POST") {
				state.passthrough = !state.passthrough;
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ passthrough: state.passthrough }),
				json: async () => ({ passthrough: state.passthrough }),
			};
		}
		return makeFetch(defaultRoutes())(url, init);
	};
	const dom = bootUi({ fetchImpl });
	await settle(dom);
	const btn = dom.window.document.getElementById("enabledToggle");
	// passthrough=false → enabled=true
	expect(btn.getAttribute("aria-pressed")).toBe("true");
	btn.click();
	await settle(dom);
	// passthrough=true → enabled=false (baseline)
	expect(btn.getAttribute("aria-pressed")).toBe("false");
	teardown(dom);
});

test("disabled-by-passthrough toggles point aria-describedby at the reason node", async () => {
	const dom = bootUi({
		fetchImpl: makeFetch({
			...defaultRoutes(),
			"/_proxy/passthrough": {
				passthrough: true,
				injectExtendedCacheTtl: false,
				stripEphemeralFromSystem: false,
				keepAliveEnabled: false,
			},
			"/_proxy/keep-alive": { keepAliveEnabled: false, passthrough: true },
		}),
	});
	await settle(dom);
	const doc = dom.window.document;
	const ka = doc.getElementById("keepAliveToggle");
	const describedBy = ka.getAttribute("aria-describedby") ?? "";
	expect(describedBy.split(/\s+/)).toEqual(
		expect.arrayContaining(["keepAliveHint", "passthroughDisabledReason"]),
	);
	// And the reason node itself exists in the document.
	expect(doc.getElementById("passthroughDisabledReason")).not.toBeNull();
	teardown(dom);
});

test("skip link points to the charts grid and is the first focusable element", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const link = dom.window.document.querySelector(".skip-link");
	expect(link).not.toBeNull();
	expect(link.getAttribute("href")).toBe("#chartsGrid");
	teardown(dom);
});

test("section headings exist as h2 with accessible labels on each card", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	for (const id of [
		"suggestionsTitle",
		"chartsTitle",
		"settingsTitle",
		"sessionsTitle",
	]) {
		const h = doc.getElementById(id);
		expect(h).not.toBeNull();
		expect(h.tagName).toBe("H2");
	}
	teardown(dom);
});

test("each toggle's aria-describedby points at an existing hint paragraph", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	// `enabledToggle` lives in the header and has a `title` only — the
	// per-toggle hint pattern applies to the in-settings mode toggles.
	const ids = [
		"keepAliveToggle",
		"extendCacheTtlToggle",
		"stripEphemeralToggle",
		"mobileToggle",
		"keepAliveExtendedToggle",
		"autoContinueToggle",
	];
	for (const id of ids) {
		const btn = doc.getElementById(id);
		const described = (btn.getAttribute("aria-describedby") ?? "").split(/\s+/);
		expect(described.length).toBeGreaterThan(0);
		// The first id is always the hint id; verify the node exists.
		const hintNode = doc.getElementById(described[0]);
		expect(hintNode).not.toBeNull();
		expect(hintNode.textContent.trim().length).toBeGreaterThan(0);
	}
	teardown(dom);
});

test("stale indicator hidden by default, shown when refresh is set to off", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	const ind = doc.getElementById("staleIndicator");
	expect(ind).not.toBeNull();
	expect(ind.classList.contains("hidden")).toBe(true);

	const select = doc.getElementById("refreshSelect");
	select.value = "0";
	select.dispatchEvent(new dom.window.Event("change"));
	expect(ind.classList.contains("hidden")).toBe(false);
	teardown(dom);
});

test("mode-change markers carry a <title> describing the flip", async () => {
	const sA = sampleA();
	const sB = {
		...sampleA(),
		ts: tsAgo(90),
		mode: {
			passthrough: true,
			keepAliveEnabled: false,
			stripEphemeralFromSystem: false,
		},
	};
	const dom = bootUi({
		fetchImpl: makeFetch({
			...defaultRoutes(),
			"/_proxy/metrics": {
				samples: [sA, sB],
				capacity: 2000,
				returned: 2,
			},
			"/_proxy/sessions": {
				count: 1,
				sessions: [
					{
						key: "alpha111",
						label: "alpha",
						labelSource: "auto",
						mode: "path",
					},
				],
			},
		}),
	});
	await settle(dom);
	const hitCard = dom.window.document.querySelector(
		'.chart-card[data-metric="hit"]',
	);
	const titles = hitCard.querySelectorAll("svg line.mode-line title");
	expect(titles.length).toBe(3);
	// Each title carries a knob label + direction + timestamp.
	for (const t of titles) {
		expect(t.textContent).toMatch(/(passthrough|keep-alive|strip-ephemeral)/);
		expect(t.textContent).toMatch(/→ (on|off)/);
	}
	teardown(dom);
});

test("focus button toggles .active + .focused; label stays 'focus'; aria-pressed reflects state", async () => {
	const dom = bootUi({ fetchImpl: makeFetch(twoSessionRoutes()) });
	await settle(dom);
	const doc = dom.window.document;
	const row = () =>
		doc.querySelector('#sessionsTableBody tr[data-session-key="alpha111"]');
	const focusBtn = () => row().querySelector(".focus-btn");

	expect(row().classList.contains("focused")).toBe(false);
	expect(focusBtn().classList.contains("active")).toBe(false);
	expect(focusBtn().getAttribute("aria-pressed")).toBe("false");
	// Visible label stays "focus" — layout doesn't twitch on toggle
	// (operator-requested 2026-05-17).
	expect(focusBtn().textContent).toBe("focus");

	focusBtn().click();
	await settle(dom);
	expect(row().classList.contains("focused")).toBe(true);
	expect(focusBtn().classList.contains("active")).toBe(true);
	expect(focusBtn().getAttribute("aria-pressed")).toBe("true");
	expect(focusBtn().textContent).toBe("focus");
	// aria-label carries the state for screen readers.
	expect(focusBtn().getAttribute("aria-label")).toMatch(/is focused/);

	focusBtn().click();
	await settle(dom);
	expect(row().classList.contains("focused")).toBe(false);
	expect(focusBtn().getAttribute("aria-pressed")).toBe("false");
	expect(focusBtn().textContent).toBe("focus");
	expect(focusBtn().getAttribute("aria-label")).toMatch(/^Focus on /);
	teardown(dom);
});

describe("baselineDeltaChip sign rendering (regression: double-plus, reported 2026-06-02)", () => {
	// Operator-reported 2026-06-02: chart readouts showed a DOUBLED plus,
	// e.g. "14% ++8% vs baseline", "2184ms ++111ms vs baseline",
	// "quota 3% ++0% vs baseline". The delta sign was concatenated twice in
	// the html template (once in the outer literal, once in the nested
	// ternary's false branch). The same tangled expression also dropped the
	// sign entirely on NEGATIVE deltas (rendering bare magnitude and leaning
	// on color alone — a WCAG 1.4.1 "use of color" problem). These tests pin
	// exactly one correct sign per direction.
	//
	// baselineDeltaChip is a top-level function in app.js; the harness
	// inlines app.js as a classic script, so it lands on window.
	let dom;
	let chip;
	beforeEach(async () => {
		dom = bootUi({ fetchImpl: makeFetch(defaultRoutes()) });
		await settle(dom);
		chip = dom.window.baselineDeltaChip;
	});
	afterEach(() => teardown(dom));

	const PCT_UP = { scale: "pct", direction: "higher-better" };
	const PCT_DOWN = { scale: "pct", direction: "lower-better" };
	const TTFT_DOWN = { scale: "ttft", direction: "lower-better" };

	test("is reachable as a window global", () => {
		expect(typeof chip).toBe("function");
	});

	test("positive pct delta shows a single plus, never '++'", () => {
		const { html } = chip(PCT_UP, 14, 6); // delta +8%
		expect(html).toContain("+8% vs baseline");
		expect(html).not.toContain("++");
	});

	test("positive ms delta shows a single plus, never '++'", () => {
		const { html } = chip(TTFT_DOWN, 2184, 2073); // delta +111ms
		expect(html).toContain("+111ms vs baseline");
		expect(html).not.toContain("++");
	});

	test("a small positive delta that rounds to 0% still shows a single plus (the '++0%' case)", () => {
		const { html } = chip(PCT_DOWN, 6.3, 6); // +0.3% → rounds to "+0%"
		expect(html).toContain("+0% vs baseline");
		expect(html).not.toContain("++");
	});

	test("negative delta shows a minus sign (not bare magnitude, not '+-')", () => {
		const { html } = chip(PCT_UP, 6, 14); // delta -8%
		expect(html).toContain("-8% vs baseline");
		expect(html).not.toContain("+-");
		expect(html).not.toContain("++");
	});

	test("zero delta shows no sign", () => {
		const { html } = chip(PCT_UP, 6, 6); // delta 0
		expect(html).toContain("0% vs baseline");
		expect(html).not.toContain("+0%");
		expect(html).not.toContain("-0%");
	});
});
