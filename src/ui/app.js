/**
 * clawback web UI — per-metric statusline time-series with per-session
 * overlays.
 *
 * PLAN §39 (Phase 2). One chart per statusline element instead of the
 * §33 single shared-axis chart. Each chart shows:
 *   - an aggregate line in the metric's primary color (where the
 *     metric has a defined aggregation semantic — mean for tps/ttft,
 *     weighted-mean for hit, max for context). turn/day/
 *     week are per-session-only (no aggregate line).
 *   - per-session overlay lines, one per session observed in the
 *     metrics ring, colored from a 10-color palette and styled with
 *     one of four dash patterns. Color+pattern hashed off the
 *     sessionKey so the assignment is stable across reloads.
 *
 * Session filter buttons toggle visibility across every chart at once.
 * Visibility selections persist to localStorage.
 *
 * Polls /_proxy/metrics + /_proxy/sessions + the three toggle endpoints
 * + /_proxy/health (threshold hints used for y-axis floors).
 */

import {
	AGGREGATE_BUCKET,
	computeAggregateSeries,
	perSessionSeries,
	sessionStyle,
} from "/_proxy/ui/aggregation.js";

// Per-metric chart definitions. `direction` encodes which way is
// "better" relative to a baseline (higher / lower), used by the
// baseline +/- delta indicator. `field` defaults to `key`; multi-
// series charts (`series` array) override per line.
const METRICS = [
	{
		key: "context",
		label: "context",
		color: "#2a7f5c",
		unit: "%",
		scale: "pct",
		aggregate: "max",
		direction: "lower-better",
	},
	{
		// PLAN: combined 5-hour / 7-day quota chart. Both windows share a
		// 0-100 y-axis, drawn as separate colored lines + each with its
		// own baseline reference.
		key: "quota",
		label: "quota",
		unit: "%",
		scale: "pct",
		aggregate: null,
		direction: "lower-better",
		series: [
			// 5-hour rolling quota window. Label unified on `quota` to match
			// the TUI statusline (admin.js renders the five_hour field as
			// `quota`). The data field key stays `next` (the server's
			// statusline payload key); only the human-facing label changed.
			{ field: "next", label: "quota", color: "#4a8fc0" },
			{ field: "week", label: "week", color: "#7a5fb0" },
		],
	},
	{
		key: "hit",
		label: "cache",
		color: "#b5671a",
		unit: "%",
		scale: "pct",
		aggregate: "weighted-mean",
		direction: "higher-better",
	},
	{
		key: "turn",
		label: "turn",
		color: "#c04a5a",
		unit: "%",
		scale: "pct",
		aggregate: null,
		direction: "higher-better",
	},
	{
		key: "tps",
		label: "tps",
		color: "#3a9faf",
		unit: " t/s",
		scale: "tps",
		aggregate: "mean",
		direction: "higher-better",
	},
	{
		key: "ttft",
		label: "ttft",
		// Magenta-pink, deliberately far from cache's rust orange (#b5671a,
		// hue 30°). The two used to sit at hue 30°/33° — visually identical.
		// Hue 314° opens ~50° to quota.week purple and ~39° to turn rose-red.
		color: "#b54a9d",
		unit: "ms",
		scale: "ttft",
		aggregate: "mean",
		direction: "lower-better",
	},
];

const STORAGE_KEY = "clawback.ui.v2";
const SUGGESTIONS_DISMISSED_KEY = "clawback.ui.suggestions.dismissed";

// Suggestion-id → metric-key. When a suggestion's id appears here, the
// card is rendered *inside* the matching chart card (with a left
// border tying the two together). Unmapped suggestions stay in the
// global #suggestionsCard above the charts. The mapping is hand-
// curated against suggestions.js — a metric is the chart the operator
// would look at to verify the suggestion paid off.
//
// Diagnostic/informational rules (baseline-no-traffic,
// auto-continue-during-baseline, upstream-failure-isolate,
// engine-silent) are intentionally left out: they have no single
// chart that proves the action worked.
const SUGGESTION_TO_METRIC = {
	// Cache-hit centric: nearly every cache-stack rule's payoff shows
	// up first on the hit-rate chart.
	"keepalive-off-multiturn": "hit",
	"keepalive-single-turn-waste": "hit",
	"ttl-1h-long-sessions": "hit",
	"ttl-1h-short-sessions-waste": "hit",
	"extended-cadence-with-1h": "hit",
	"extended-misconfig-no-ttl": "hit",
	"strip-ephemeral-low-hit": "hit",
	"strip-ephemeral-still-low": "hit",
	"regression-vs-baseline": "hit",
	"stack-cold-suggest-all": "hit",
	"stack-partial-completion": "hit",
	"stack-not-helping": "hit",
	"post-baseline-enable-s": "hit",
	"post-baseline-skip-s": "hit",
	"auto-continue-without-keepalive": "hit",
	"cooldown-longer-than-5m-cache": "hit",
	// Quota-centric: rules driven by rate-limit pressure or quota
	// starvation. The 5h/7d chart is where the wall shows up.
	"keepalive-quota-starvation": "quota",
	"auto-continue-hit-wall": "quota",
	"auto-continue-no-pty": "quota",
	// Latency-centric: mobile mode trade-offs surface on TTFT.
	"mobile-slow-ttft": "ttft",
	"mobile-on-fast-net": "ttft",
	// Context-window pressure: both /compact suggestions belong on the
	// context chart, where the operator sees the % climbing.
	"context-near-limit-compact": "context",
	"context-stop-before-cap": "context",
	// TPS-centric: mobile mode's non-streaming side effect manifests on
	// the tps chart, so the off-suggestion lives there.
	"mobile-low-tps-non-streaming": "tps",
};

// Hotkey → toggle endpoint + inflight key. Matches the data-hotkey
// attributes on each toggle in index.html. Renders the same as a
// click — the same toggleEndpoint() handler runs.
const HOTKEY_BINDINGS = {
	1: ["passthrough", "passthrough"],
	2: ["keep-alive", "keep-alive"],
	3: ["extend-cache-ttl", "extend-cache-ttl"],
	4: ["strip-ephemeral", "strip-ephemeral"],
	5: ["keep-alive-extended", "keep-alive-extended"],
	6: ["mobile", "mobile"],
	7: ["auto-continue", "auto-continue"],
};

const TOGGLE_LABELS = {
	passthrough: "passthrough",
	keepAliveEnabled: "keep-alive",
	injectExtendedCacheTtl: "1h cache ttl",
	stripEphemeralFromSystem: "strip-ephemeral",
	mobile: "mobile",
	keepAliveModeExtended: "extended cadence",
	autoContinue: "auto-continue",
};

/**
 * Per-knob styling for the mode-change vertical markers. Each knob
 * gets a distinct color AND a distinct dash pattern so a colorblind
 * operator can tell them apart on the time-series charts. `modeField`
 * names the boolean on the metrics sample's `mode` snapshot.
 */
const MODE_LINE_STYLE = {
	passthrough: {
		color: "#b23a48",
		dash: "8 2",
		label: "passthrough",
		modeField: "passthrough",
	},
	"keep-alive": {
		color: "#3a6fb0",
		dash: "3 3",
		label: "keep-alive",
		modeField: "keepAliveEnabled",
	},
	"strip-ephemeral": {
		color: "#3a8f5c",
		dash: "1 3",
		label: "strip-ephemeral",
		modeField: "stripEphemeralFromSystem",
	},
	"extend-cache-ttl": {
		color: "#b5671a",
		dash: "5 2 1 2",
		label: "1h cache ttl",
		modeField: "injectExtendedCacheTtl",
	},
	mobile: {
		color: "#7a5fb0",
		dash: "12 4",
		label: "mobile",
		modeField: "mobile",
	},
	"keep-alive-extended": {
		color: "#2a7f5c",
		dash: "2 5",
		label: "extended cadence",
		modeField: "keepAliveModeExtended",
	},
	"auto-continue": {
		color: "#c04a5a",
		dash: "10 3 1 3",
		label: "auto-continue",
		modeField: "autoContinue",
	},
};

function describeFlip(cls, prev, next) {
	const field = MODE_LINE_STYLE[cls]?.modeField;
	if (!field) return "flipped";
	const before = Boolean(prev?.[field]);
	const after = Boolean(next?.[field]);
	if (after && !before) return "→ on";
	if (!after && before) return "→ off";
	return "changed";
}

function formatLocalTime(ts) {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	return d.toLocaleTimeString();
}

const state = {
	samples: [],
	sessions: [], // [{ key, label, ... }] from /_proxy/sessions
	thresholds: {
		tpsLow: 30,
		tpsHigh: 80,
		ttftLow: 500,
		ttftHigh: 2000,
	},
	mode: {
		passthrough: false,
		keepAliveEnabled: true,
		injectExtendedCacheTtl: true,
		stripEphemeralFromSystem: true,
		mobile: false,
		keepAliveModeExtended: false,
		autoContinue: false,
	},
	suggestions: [],
	dismissedSuggestions: new Set(),
	visibility: {
		aggregate: true,
		sessions: {},
	},
	// When focusedSession is non-null, the charts and overview restrict
	// to only that session's data — overrides the visibility map. Set
	// via the "focus" button on each sessions-table row.
	focusedSession: null,
	// Default 0.25s — the dropdown also offers 0.5s and 1s/2s/5s/15s/1m/off.
	refreshMs: 250,
	timer: null,
	inFlight: new Set(),
	// PTY presence: drives the "continue working" button visibility.
	// Tracked from /_proxy/claude/input (active boolean, label string).
	inputActive: false,
	inputLabel: null,
	// Baseline-capture state: drives the "capture baseline" button
	// label + disabled state. Populated by polling /_proxy/capture-baseline.
	baselineCapture: {
		active: false,
		turnsRemaining: 0,
		targetTurns: 0,
		startedAt: null,
		// Whether the *active* capture is a 2x-quota shadow run.
		shadow: false,
		// What a freshly-started capture would be, per server config —
		// drives the toggle's initial checked state on load.
		defaultShadow: false,
	},
	// Last-applied mode snapshot — used to detect transitions for the
	// toggle-flip toast.
	lastModeSnapshot: null,
	helpOverlayOpen: false,
};

function loadVisibility() {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			if (typeof parsed.aggregate === "boolean") {
				state.visibility.aggregate = parsed.aggregate;
			}
			if (parsed.sessions && typeof parsed.sessions === "object") {
				state.visibility.sessions = { ...parsed.sessions };
			}
			if (typeof parsed.focusedSession === "string") {
				state.focusedSession = parsed.focusedSession;
			}
		}
	} catch {
		// localStorage absent or unparseable; defaults already set.
	}
}

function saveVisibility() {
	try {
		globalThis.localStorage?.setItem(
			STORAGE_KEY,
			JSON.stringify({
				aggregate: state.visibility.aggregate,
				sessions: state.visibility.sessions,
				focusedSession: state.focusedSession,
			}),
		);
	} catch {
		// Quota or disabled; non-fatal.
	}
}

function loadDismissedSuggestions() {
	try {
		const raw = globalThis.localStorage?.getItem(SUGGESTIONS_DISMISSED_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			state.dismissedSuggestions = new Set(parsed);
		}
	} catch {
		/* default empty */
	}
}

function saveDismissedSuggestions() {
	try {
		globalThis.localStorage?.setItem(
			SUGGESTIONS_DISMISSED_KEY,
			JSON.stringify(Array.from(state.dismissedSuggestions)),
		);
	} catch {
		/* non-fatal */
	}
}

function isSessionVisible(sessionKey) {
	// Focus mode wins: when one session is focused, every other session
	// is hidden regardless of the per-session visibility map. Use the
	// _aggregate bucket only when it's the focused key.
	if (state.focusedSession != null) {
		return sessionKey === state.focusedSession;
	}
	const v = state.visibility.sessions[sessionKey];
	return v === undefined ? true : Boolean(v);
}

function focusSession(sessionKey) {
	state.focusedSession = sessionKey;
	saveVisibility();
	renderAll();
}

function clearFocus() {
	state.focusedSession = null;
	saveVisibility();
	renderAll();
}

// Admin-token plumbing. The clawback proxy gates mutating endpoints
// behind `Authorization: Bearer <token>` whenever `config.adminToken`
// is set AND the request is non-loopback (see `admin.js`). The
// quickstart binds to 0.0.0.0 by default, so a phone hitting the
// dashboard over LAN trips that gate. We bootstrap the token from
// three sources, in priority order:
//
//   1. `#token=…` URL fragment — written by the quickstart's
//      auto-open URL (see `bin/clawback.js`). Stashed to localStorage
//      and stripped from the address bar so it doesn't linger in
//      shared screenshots or browser history exports.
//   2. localStorage — survives reloads once the fragment-stash ran.
//   3. operator prompt — fallback when a write 401s and we have
//      nothing else to send.
//
// The token is read on every fetch (not cached) so a manually-entered
// token takes effect without a page reload.
const TOKEN_STORAGE_KEY = "clawback.adminToken";

function consumeTokenFragment() {
	const hash = globalThis.location?.hash ?? "";
	if (!hash.startsWith("#")) return;
	const params = new URLSearchParams(hash.slice(1));
	const tok = params.get("token");
	if (!tok) return;
	try {
		localStorage.setItem(TOKEN_STORAGE_KEY, tok);
	} catch {
		/* private-mode / quota errors — token still usable in-memory */
	}
	// Strip the fragment so the token doesn't linger in the address
	// bar. history.replaceState avoids a navigation event that would
	// re-run the script.
	try {
		const url = new URL(globalThis.location.href);
		url.hash = "";
		globalThis.history?.replaceState?.(null, "", url.toString());
	} catch {
		/* older browsers — leave the hash, no functional impact */
	}
}

function getAdminToken() {
	try {
		return localStorage.getItem(TOKEN_STORAGE_KEY);
	} catch {
		return null;
	}
}

function setAdminToken(tok) {
	try {
		if (tok) localStorage.setItem(TOKEN_STORAGE_KEY, tok);
		else localStorage.removeItem(TOKEN_STORAGE_KEY);
	} catch {
		/* best-effort */
	}
}

// Merge Authorization: Bearer into an existing init object without
// stomping any caller-supplied headers. Returns a new object so the
// caller's init isn't mutated in place (the fetch callsites build
// these inline, but it's cheap insurance).
function withAuth(init) {
	const tok = getAdminToken();
	if (!tok) return init ?? {};
	const merged = { ...(init ?? {}) };
	const headers = new Headers(merged.headers ?? {});
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${tok}`);
	}
	merged.headers = headers;
	return merged;
}

// Single retry path for 401s: prompt the operator for a token, save
// it, and re-issue. Used by every mutating fetch in this file. Reads
// don't go through here — the proxy lets GETs pass unauthenticated by
// design, so a 401 on a GET means something else is broken.
async function authedFetch(url, init) {
	let r = await fetch(url, withAuth(init));
	if (r.status === 401) {
		const message =
			"CLAWBACK.md adminToken required (dashboard isn't on loopback). " +
			"Find it in the adminToken field of your CLAWBACK.md — " +
			"typically ./CLAWBACK.md (where you ran clawback init) or " +
			"~/.config/clawback/CLAWBACK.md. Also accepted: the " +
			"CLAWBACK_ADMIN_TOKEN env var the proxy was started with. " +
			"Paste here to authorize this browser; saved locally.";
		const prompted = globalThis.prompt ? globalThis.prompt(message, "") : null;
		if (prompted?.trim()) {
			setAdminToken(prompted.trim());
			r = await fetch(url, withAuth(init));
		}
	}
	return r;
}

consumeTokenFragment();

async function fetchJson(url, init) {
	const r = await authedFetch(url, init);
	if (!r.ok) {
		const text = await r.text().catch(() => "");
		const err = new Error(`${url} → ${r.status} ${text}`);
		err.status = r.status;
		throw err;
	}
	return r.json();
}

async function poll() {
	try {
		// Don't broadcast a "loading…" status — at the 1s refresh
		// cadence it just causes layout jitter as the message text
		// width changes each tick. The data quietly pops in.
		const [
			metricsRes,
			sessionsRes,
			passthroughRes,
			keepAliveRes,
			extendCacheTtlRes,
			stripEphRes,
			mobileRes,
			keepAliveExtendedRes,
			autoContinueRes,
			suggestionsRes,
			healthRes,
			inputRes,
			captureBaselineRes,
		] = await Promise.all([
			fetchJson("/_proxy/metrics?limit=2000").catch(() => ({ samples: [] })),
			fetchJson("/_proxy/sessions").catch(() => ({ sessions: [] })),
			fetchJson("/_proxy/passthrough").catch(() => null),
			fetchJson("/_proxy/keep-alive").catch(() => null),
			fetchJson("/_proxy/extend-cache-ttl").catch(() => null),
			fetchJson("/_proxy/strip-ephemeral").catch(() => null),
			fetchJson("/_proxy/mobile").catch(() => null),
			fetchJson("/_proxy/keep-alive-extended").catch(() => null),
			fetchJson("/_proxy/auto-continue").catch(() => null),
			fetchJson("/_proxy/suggestions").catch(() => null),
			fetchJson("/_proxy/health").catch(() => null),
			fetchJson("/_proxy/claude/input").catch(() => null),
			fetchJson("/_proxy/capture-baseline").catch(() => null),
		]);
		state.samples = metricsRes.samples ?? [];
		state.sessions = sessionsRes.sessions ?? [];
		if (inputRes && typeof inputRes === "object") {
			state.inputActive = Boolean(inputRes.active);
			state.inputLabel =
				typeof inputRes.label === "string" ? inputRes.label : null;
		} else {
			state.inputActive = false;
			state.inputLabel = null;
		}
		if (captureBaselineRes && typeof captureBaselineRes === "object") {
			state.baselineCapture = {
				active: Boolean(captureBaselineRes.active),
				turnsRemaining: captureBaselineRes.turnsRemaining | 0,
				targetTurns: captureBaselineRes.targetTurns | 0,
				startedAt: captureBaselineRes.startedAt ?? null,
				shadow: Boolean(captureBaselineRes.shadow),
				defaultShadow: Boolean(captureBaselineRes.defaultShadow),
			};
		}
		if (passthroughRes)
			state.mode.passthrough = Boolean(passthroughRes.passthrough);
		if (keepAliveRes)
			state.mode.keepAliveEnabled = Boolean(keepAliveRes.keepAliveEnabled);
		if (extendCacheTtlRes)
			state.mode.injectExtendedCacheTtl = Boolean(
				extendCacheTtlRes.injectExtendedCacheTtl,
			);
		if (stripEphRes)
			state.mode.stripEphemeralFromSystem = Boolean(
				stripEphRes.stripEphemeralFromSystem,
			);
		if (mobileRes) {
			state.mode.mobile = Boolean(mobileRes.mobile);
		}
		if (keepAliveExtendedRes)
			state.mode.keepAliveModeExtended = Boolean(
				keepAliveExtendedRes.keepAliveModeExtended,
			);
		if (autoContinueRes)
			state.mode.autoContinue = Boolean(autoContinueRes.autoContinue);
		state.suggestions = Array.isArray(suggestionsRes?.suggestions)
			? suggestionsRes.suggestions
			: [];
		// Surface toggle transitions as toasts. Skip the very first
		// snapshot — we'd otherwise toast every knob on initial load.
		if (state.lastModeSnapshot) {
			emitModeChangeToasts(state.lastModeSnapshot, state.mode);
		}
		state.lastModeSnapshot = { ...state.mode };
		if (healthRes?.config) {
			const c = healthRes.config;
			if (typeof c.statuslineTpsThresholdLow === "number")
				state.thresholds.tpsLow = c.statuslineTpsThresholdLow;
			if (typeof c.statuslineTpsThresholdHigh === "number")
				state.thresholds.tpsHigh = c.statuslineTpsThresholdHigh;
			if (typeof c.statuslineTtftThresholdLowMs === "number")
				state.thresholds.ttftLow = c.statuslineTtftThresholdLowMs;
			if (typeof c.statuslineTtftThresholdHighMs === "number")
				state.thresholds.ttftHigh = c.statuslineTtftThresholdHighMs;
		}
		renderAll();
		setStatus(
			"ok",
			`${state.samples.length} sample${state.samples.length === 1 ? "" : "s"} · ${observedSessionCount()} session${observedSessionCount() === 1 ? "" : "s"}`,
		);
	} catch (e) {
		setStatus("warn", `error: ${e.message}`);
	}
}

function observedSessionCount() {
	const keys = new Set();
	for (const s of state.samples) keys.add(s.sessionKey);
	keys.delete(undefined);
	return keys.size;
}

function setStatus(cls, text) {
	const dot = document.getElementById("statusDot");
	const label = document.getElementById("statusText");
	if (dot)
		dot.className = `dot ${cls === "ok" ? "ok" : cls === "warn" ? "warn" : ""}`;
	if (label) label.textContent = text;
}

function renderAll() {
	renderModeSummary();
	renderBaselineBanner();
	renderCaptureBaselineButton();

	renderButtons();
	renderSuggestions();
	renderOverviewChart();
	renderChartsGrid();
	renderSessionsTable();
	renderFocusIndicator();
}

function renderFocusIndicator() {
	const indicator = document.getElementById("sessionsFocusIndicator");
	const btn = document.getElementById("clearFocusBtn");
	const focused = state.focusedSession != null;
	if (indicator) {
		indicator.classList.toggle("hidden", !focused);
		if (focused) {
			const row = state.sessions.find((s) => s.key === state.focusedSession);
			const label = row?.label ?? state.focusedSession;
			indicator.textContent = `focused: ${label}`;
		}
	}
	if (btn) btn.classList.toggle("hidden", !focused);
}

/**
 * "N/8 on" header chip — flips to a BASELINE pill when passthrough is
 * active. Reads from state.mode, which the poll loop keeps in sync
 * with the eight toggle endpoints.
 */
function renderModeSummary() {
	const el = document.getElementById("modeSummary");
	if (!el) return;
	const keys = [
		"passthrough",
		"keepAliveEnabled",
		"injectExtendedCacheTtl",
		"stripEphemeralFromSystem",
		"mobile",
		"keepAliveModeExtended",
		"autoContinue",
	];
	if (state.mode.passthrough) {
		el.textContent = "BASELINE";
		el.classList.add("baseline");
		el.title =
			"Passthrough is on. Every intervention is forced off — clawback.md is acting as a transparent observer.";
		return;
	}
	const on = keys.filter((k) => state.mode[k] === true).length;
	el.textContent = `${on}/${keys.length} on`;
	el.classList.remove("baseline");
	el.title = `${on} of ${keys.length} clawback.md knobs are active.`;
}

// Treatment-mode entry timestamp + pending fade timer. After 5s in
// treatment mode, the CLAWBACK ENABLED banner fades out — once the
// operator has seen the "you're optimizing" signal it's just vertical
// noise. Baseline mode (operator chose to measure) reinstates it
// immediately so the orange "passthrough on" state is never silent.
let baselineBannerTreatmentEnteredAt = null;
let baselineBannerFadeTimer = null;

function renderBaselineBanner() {
	const el = document.getElementById("baselineBanner");
	if (!el) return;
	const isTreatment = !state.mode.passthrough;
	el.dataset.mode = isTreatment ? "treatment" : "baseline";
	if (isTreatment) {
		if (baselineBannerTreatmentEnteredAt == null) {
			baselineBannerTreatmentEnteredAt = Date.now();
			el.classList.remove("faded");
			if (baselineBannerFadeTimer != null) {
				clearTimeout(baselineBannerFadeTimer);
			}
			baselineBannerFadeTimer = setTimeout(() => {
				if (!state.mode.passthrough) {
					el.classList.add("faded");
				}
				baselineBannerFadeTimer = null;
			}, 5000);
		}
	} else {
		baselineBannerTreatmentEnteredAt = null;
		el.classList.remove("faded");
		if (baselineBannerFadeTimer != null) {
			clearTimeout(baselineBannerFadeTimer);
			baselineBannerFadeTimer = null;
		}
	}
}

// One-shot guard so we seed the shadow toggle from the server's
// configured default exactly once (the first poll that carries it),
// then leave it under the operator's control while idle.
let shadowToggleSeeded = false;

function renderCaptureBaselineButton() {
	const btn = document.getElementById("captureBaselineBtn");
	if (!btn) return;
	const cap = state.baselineCapture ?? {};
	const inFlight = state.inFlight.has("capture-baseline");
	const toggle = document.getElementById("captureShadowToggle");
	const warn = document.getElementById("captureShadowWarn");

	if (
		toggle &&
		!shadowToggleSeeded &&
		(cap.active || cap.startedAt != null || cap.defaultShadow)
	) {
		// Seed once from config default; an active capture wins over it.
		toggle.checked = cap.active
			? Boolean(cap.shadow)
			: Boolean(cap.defaultShadow);
		shadowToggleSeeded = true;
	}

	if (cap.active) {
		// Mid-capture: show progress, disable so a second click can't
		// double-arm the counter. The numbers update on every poll
		// once the server decrements its turnsRemaining.
		const done = Math.max(0, (cap.targetTurns | 0) - (cap.turnsRemaining | 0));
		const shadowTag = cap.shadow ? " (shadow 2×)" : "";
		btn.textContent = `capturing ${done}/${cap.targetTurns | 0}${shadowTag}`;
		btn.disabled = true;
		btn.classList.add("active");
		btn.title = cap.shadow
			? `Shadow baseline capture in progress — clawback.md stays armed while a no-clawback twin runs in parallel (about 2× token cost). ${cap.turnsRemaining} turn(s) remaining.`
			: `Baseline capture in progress — ${cap.turnsRemaining} turn(s) remaining before clawback.md re-enables itself.`;
		// The toggle can't change mid-capture; pin it to the live run.
		if (toggle) {
			toggle.checked = Boolean(cap.shadow);
			toggle.disabled = true;
		}
	} else {
		const shadowOn = Boolean(toggle?.checked);
		btn.textContent = shadowOn ? "capture baseline ×2" : "capture baseline";
		btn.disabled = inFlight;
		btn.classList.remove("active");
		btn.title = inFlight
			? "Starting baseline capture…"
			: shadowOn
				? "Capture a no-clawback baseline WITHOUT turning clawback.md off: every turn is sent to Anthropic twice (about 2× token cost) so the live path stays armed while the baseline is recorded."
				: "Disable clawback.md's interventions for a few turns to record a fresh baseline, then re-enable them automatically.";
		if (toggle) toggle.disabled = inFlight;
	}

	// Warn note tracks whatever run the toggle currently represents
	// (the active capture's mode, or the operator's pending choice).
	if (warn) warn.hidden = !toggle?.checked;
}

/**
 * Emit a toast for each toggle that flipped between the two mode
 * snapshots. Suppresses spam by only firing when the value genuinely
 * changed. Color follows a power-switch convention: ON = green
 * (info), OFF = red (warn), regardless of which knob — so a cascade
 * triggered by flipping to baseline reads as "baseline enabled
 * (green), optimizations disabled (red)" without per-toggle carve-outs.
 */
function emitModeChangeToasts(prev, next) {
	for (const key of Object.keys(TOGGLE_LABELS)) {
		if (prev[key] === next[key]) continue;
		const label = TOGGLE_LABELS[key];
		const state = next[key] ? "ON" : "off";
		const severity = next[key] ? "info" : "warn";
		showToast(`${label}: ${state}`, severity);
	}
}

// Match the .suggestion / .linked-suggestion transition durations in
// style.css. Honoring prefers-reduced-motion skips the waits entirely
// so keyboard users with reduced motion don't sit through dead time.
const SUGGESTION_FADE_MS = 220;
const SUGGESTION_FLASH_MS = 300;

/**
 * Pulse every visible card for `id` with a green (apply) or red
 * (dismiss) acknowledgment flash, then chain into the existing leaving-
 * fade. The flash is a 300ms background colour-shift driven by
 * `.applying` / `.dismissing` classes in style.css; once it completes
 * we add `.leaving` and let the fade play out before the caller
 * commits its state mutation. Cards live in both the global
 * suggestions list and (optionally) inside a linked chart card; the
 * shared [data-suggestion-id] attribute hits both. Cards that don't
 * exist (already off-DOM, never rendered) resolve immediately. Honors
 * prefers-reduced-motion by skipping both phases.
 */
function flashAndFadeSuggestionCards(id, kind) {
	if (typeof document === "undefined") return Promise.resolve();
	const cards = document.querySelectorAll(
		`[data-suggestion-id="${cssAttrEscape(id)}"]`,
	);
	if (cards.length === 0) return Promise.resolve();
	const flashClass = kind === "dismiss" ? "dismissing" : "applying";
	const reduceMotion = window.matchMedia?.(
		"(prefers-reduced-motion: reduce)",
	)?.matches;
	if (reduceMotion) {
		for (const c of cards) c.classList.add("leaving");
		return Promise.resolve();
	}
	for (const c of cards) c.classList.add(flashClass);
	return new Promise((resolve) => {
		setTimeout(() => {
			// `.leaving` overrides the flash background via the opacity-
			// based fade; the flash class is left on so the colour
			// persists through the fade rather than snapping back to
			// the neutral background mid-animation.
			for (const c of cards) c.classList.add("leaving");
			setTimeout(resolve, SUGGESTION_FADE_MS);
		}, SUGGESTION_FLASH_MS);
	});
}

// CSS.escape isn't universal; suggestion ids are kebab-case ascii from
// suggestions.js so a narrow whitelist passes through unchanged and the
// fallback double-quotes anything weirder.
function cssAttrEscape(s) {
	if (typeof s !== "string") return "";
	if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
	return s.replace(/(["\\])/g, "\\$1");
}

/**
 * Append a transient toast to #toasts. Auto-dismiss after ~3.5s with a
 * short fade-out (CSS handles the animation). Stack vertically; up to
 * a soft cap so a runaway loop can't overflow the screen.
 */
function showToast(message, severity = "info") {
	const container = document.getElementById("toasts");
	if (!container) return;
	while (container.childElementCount >= 6) {
		container.firstElementChild?.remove();
	}
	const el = document.createElement("div");
	el.className = `toast ${severity === "warn" ? "warn" : ""}`;
	el.textContent = message;
	container.appendChild(el);
	const dismiss = () => {
		el.classList.add("leaving");
		setTimeout(() => el.remove(), 300);
	};
	setTimeout(dismiss, 3500);
	el.addEventListener("click", dismiss);
}

function showHelpOverlay() {
	const overlay = document.getElementById("helpOverlay");
	if (!overlay) return;
	overlay.classList.remove("hidden");
	state.helpOverlayOpen = true;
	const close = document.getElementById("helpCloseBtn");
	close?.focus();
}

function hideHelpOverlay() {
	const overlay = document.getElementById("helpOverlay");
	if (!overlay) return;
	overlay.classList.add("hidden");
	state.helpOverlayOpen = false;
}

/**
 * Render one toggle button. Keeps the accessible state on
 * `aria-pressed`; visible text + icon are layered on a fixed
 * structure so the button's text node count and width are stable
 * across state flips (only the strings change).
 *
 * `disabledByPassthrough: true` adds the shared passthrough-disabled
 * reason to `aria-describedby` whenever the passthrough toggle is on,
 * so screen-reader users hear *why* the control is unavailable.
 */
function setToggle(btn, opts) {
	if (!btn) return;
	const {
		active,
		text,
		inFlightKey,
		hintId,
		disabledByPassthrough = false,
	} = opts;
	const textSpan = btn.querySelector(".mode-toggle-text");
	const iconSpan = btn.querySelector(".mode-toggle-icon");
	if (textSpan) textSpan.textContent = text;
	if (iconSpan) iconSpan.textContent = active ? "●" : "○";
	btn.classList.toggle("active", active);
	btn.setAttribute("aria-pressed", active ? "true" : "false");
	const blockedByPassthrough = disabledByPassthrough && state.mode.passthrough;
	btn.disabled = blockedByPassthrough || state.inFlight.has(inFlightKey);
	const describedBy = [];
	if (hintId) describedBy.push(hintId);
	if (blockedByPassthrough) describedBy.push("passthroughDisabledReason");
	if (describedBy.length > 0) {
		btn.setAttribute("aria-describedby", describedBy.join(" "));
	} else {
		btn.removeAttribute("aria-describedby");
	}
}

function renderEnabledSwitch() {
	// Semantic inversion: clawback is "enabled" when passthrough is OFF
	// (i.e. we're actively intervening). passthrough=ON means we're in
	// the baseline arm — clawback disabled. The label flips to mirror
	// state so the toggle reads as its current condition rather than
	// just the feature name.
	const enabled = !state.mode.passthrough;
	const inFlight = state.inFlight.has("passthrough");
	const title = enabled
		? "clawback.md is optimizing. Click to switch to baseline (no optimizations)."
		: "Baseline mode — clawback.md is observing only. Click to re-enable optimizations.";
	const label = enabled ? "enabled" : "disabled (collecting baseline)";
	for (const id of ["enabledToggle", "baselineBannerToggle"]) {
		const btn = document.getElementById(id);
		if (!btn) continue;
		btn.classList.toggle("on", enabled);
		btn.setAttribute("aria-pressed", enabled ? "true" : "false");
		btn.disabled = inFlight;
		const labelSpan = btn.querySelector(".enabled-switch-label");
		if (labelSpan) labelSpan.textContent = label;
		btn.title = title;
	}
}

function renderButtons() {
	renderEnabledSwitch();
	setToggle(document.getElementById("keepAliveToggle"), {
		active: state.mode.keepAliveEnabled,
		text: `keep-alive: ${state.mode.keepAliveEnabled ? "ON" : "off"}`,
		inFlightKey: "keep-alive",
		hintId: "keepAliveHint",
		disabledByPassthrough: true,
	});
	setToggle(document.getElementById("extendCacheTtlToggle"), {
		active: state.mode.injectExtendedCacheTtl,
		text: `1h cache ttl: ${state.mode.injectExtendedCacheTtl ? "ON" : "off"}`,
		inFlightKey: "extend-cache-ttl",
		hintId: "extendCacheTtlHint",
		disabledByPassthrough: true,
	});
	setToggle(document.getElementById("stripEphemeralToggle"), {
		active: state.mode.stripEphemeralFromSystem,
		text: `strip-ephemeral: ${
			state.mode.stripEphemeralFromSystem ? "ON" : "off"
		}`,
		inFlightKey: "strip-ephemeral",
		hintId: "stripEphemeralHint",
		disabledByPassthrough: true,
	});
	setToggle(document.getElementById("mobileToggle"), {
		active: state.mode.mobile,
		text: `mobile: ${state.mode.mobile ? "ON" : "off"}`,
		inFlightKey: "mobile",
		hintId: "mobileHint",
		disabledByPassthrough: false,
	});
	setToggle(document.getElementById("keepAliveExtendedToggle"), {
		active: state.mode.keepAliveModeExtended,
		text: `extended cadence: ${
			state.mode.keepAliveModeExtended ? "ON" : "off"
		}`,
		inFlightKey: "keep-alive-extended",
		hintId: "keepAliveExtendedHint",
		disabledByPassthrough: true,
	});
	setToggle(document.getElementById("autoContinueToggle"), {
		active: state.mode.autoContinue,
		text: `auto-continue: ${state.mode.autoContinue ? "ON" : "off"}`,
		inFlightKey: "auto-continue",
		hintId: "autoContinueHint",
		// Force-pinned off while passthrough is on (matches the hard
		// bundle in src/config.js and applyPassthrough): a fire mid-
		// baseline would corrupt the measurement window.
		disabledByPassthrough: true,
	});
	const ch = document.getElementById("clearHistoryBtn");
	if (ch) {
		ch.disabled = state.inFlight.has("clear");
	}
	const pa = document.getElementById("purgeAllBtn");
	if (pa) {
		pa.disabled = state.inFlight.has("purge-all");
	}
	const pe = document.getElementById("purgeEvictedBtn");
	if (pe) {
		pe.disabled = state.inFlight.has("purge-evicted");
	}
	const ag = document.getElementById("aggregateToggle");
	if (ag) {
		ag.classList.toggle("hidden", !state.visibility.aggregate);
		ag.setAttribute(
			"aria-pressed",
			state.visibility.aggregate ? "true" : "false",
		);
		ag.title = state.visibility.aggregate
			? "Hide the aggregate line on every chart."
			: "Show the aggregate line on every chart.";
	}
}

// Suggestion ids that may surface even when zero samples have been
// observed. Most rules depend on metric premises that don't exist
// until traffic flows; these don't — capture-baseline-due is purely
// a history check.
// Rules allowed to surface when the metrics ring is empty. Most rules
// hide in that state because their triggers depend on aggregated
// metrics, but a few are explicitly about a no-traffic / fresh-proxy
// state and must render anyway:
//   - capture-baseline-due: prompts the operator to run a baseline; no
//     samples needed to know one is overdue.
//   - baseline-no-traffic: fires *because* traffic stopped during a
//     baseline capture — the empty ring is the signal, not a reason to
//     hide.
//   - upstream-failure-isolate: 5xx-isolation suggestion can fire when
//     upstream is failing hard enough that samples aren't flowing.
const SUGGESTIONS_OK_WITHOUT_SAMPLES = new Set([
	"capture-baseline-due",
	"baseline-no-traffic",
	"upstream-failure-isolate",
]);

/**
 * Visible suggestion entries — dismissed rules filtered out, and
 * most rules suppressed entirely when the metrics ring is empty.
 * Exceptions (`SUGGESTIONS_OK_WITHOUT_SAMPLES`) are allowed through
 * because their trigger doesn't depend on samples.
 */
function visibleSuggestions() {
	const list = state.suggestions.filter(
		(s) => !state.dismissedSuggestions.has(s.id),
	);
	if (state.samples.length > 0) return list;
	return list.filter((s) => SUGGESTIONS_OK_WITHOUT_SAMPLES.has(s.id));
}

/** Suggestions linked to a specific chart metric (id → metric mapping). */
function linkedSuggestionsFor(metricKey) {
	return visibleSuggestions().filter(
		(s) => SUGGESTION_TO_METRIC[s.id] === metricKey,
	);
}

/**
 * Count firing-but-dismissed suggestions. We only count rules that
 * are currently firing — if a rule's trigger has gone false, hiding
 * its dismissed entry from the count keeps "reset dismissed" honest
 * (the reset would have nothing to re-show for that id).
 */
function firingButDismissedCount() {
	if (state.samples.length === 0) return 0;
	return state.suggestions.filter((s) => state.dismissedSuggestions.has(s.id))
		.length;
}

/**
 * Top suggestions card. Hosts every fired suggestion (the same cards
 * also render inline inside the relevant chart card — both surfaces
 * read from the same dismissedSuggestions set so applying or
 * dismissing in one place removes the card from both immediately).
 *
 * When zero suggestions are currently visible but at least one is
 * still firing-and-dismissed, the card stays visible in "reset-only"
 * mode — just the reset button plus a one-line count — so the
 * operator can always un-dismiss. When there's truly nothing to do
 * (no firing rules, nothing dismissed), the card hides entirely.
 */
function renderSuggestions() {
	const card = document.getElementById("suggestionsCard");
	const list = document.getElementById("suggestionsList");
	if (!card || !list) return;

	const visible = visibleSuggestions();

	list.innerHTML = "";

	// Operator-flagged 2026-05-17: hide the panel any time there are
	// no visible suggestions. The "reset dismissed" affordance moves
	// to the help overlay so it stays reachable without keeping the
	// suggestions card alive in an empty state.
	if (visible.length === 0) {
		card.classList.add("hidden");
		return;
	}
	card.classList.remove("hidden");

	for (const sug of visible) {
		list.appendChild(buildSuggestionCard(sug, "suggestion"));
	}

	// accept-all / dismiss-all only make sense when something is visible.
	const acceptAllBtn = document.getElementById("suggestionsAcceptAllBtn");
	const dismissAllBtn = document.getElementById("suggestionsDismissAllBtn");
	if (acceptAllBtn) {
		acceptAllBtn.disabled = state.inFlight.has("apply-all-suggestions");
	}
	if (dismissAllBtn) dismissAllBtn.disabled = false;
}

/**
 * Build a suggestion DOM node. Variant controls the wrapper class and
 * sizing — "suggestion" is the full-width version in the global
 * suggestions card; "linked-suggestion" is the compact version
 * embedded inside a chart card.
 */
function buildSuggestionCard(sug, variant) {
	const item = document.createElement("div");
	if (variant === "linked-suggestion") {
		item.className = `linked-suggestion ${sug.severity === "warn" ? "warn" : ""}`;
	} else {
		item.className = `suggestion suggestion-${sug.severity ?? "info"}`;
	}
	item.dataset.suggestionId = sug.id;

	const msg = document.createElement("p");
	msg.className =
		variant === "linked-suggestion"
			? "linked-suggestion-message"
			: "suggestion-message";
	// Prefix with a small severity badge so warn-suggestions read louder
	// than info ones — addresses the "severity not visually distinct"
	// gap from the UX review.
	const badge = document.createElement("span");
	badge.className = `suggestion-severity ${sug.severity === "warn" ? "warn" : "info"}`;
	badge.textContent = sug.severity === "warn" ? "!" : "i";
	badge.setAttribute(
		"aria-label",
		sug.severity === "warn" ? "warning" : "info",
	);
	msg.appendChild(badge);
	msg.appendChild(document.createTextNode(sug.message));
	item.appendChild(msg);

	const actions = document.createElement("div");
	actions.className =
		variant === "linked-suggestion"
			? "linked-suggestion-actions"
			: "suggestion-actions";
	// Advisory rules (applyEndpoint omitted) render as warn + dismiss
	// only. There's no server-side action to take; clicking Apply would
	// be misleading. Acknowledged by clicking Dismiss instead.
	if (sug.applyEndpoint) {
		const applyBtn = document.createElement("button");
		applyBtn.type = "button";
		applyBtn.className = "filter-btn primary";
		applyBtn.textContent = "Apply";
		applyBtn.disabled = state.inFlight.has(`suggestion-${sug.id}`);
		applyBtn.addEventListener("click", () => applySuggestion(sug));
		actions.appendChild(applyBtn);
	}
	const dismissBtn = document.createElement("button");
	dismissBtn.type = "button";
	dismissBtn.className = "filter-btn ghost";
	dismissBtn.textContent = sug.applyEndpoint ? "Dismiss" : "Acknowledge";
	dismissBtn.addEventListener("click", () => dismissSuggestion(sug.id));
	actions.appendChild(dismissBtn);
	item.appendChild(actions);

	return item;
}

async function applySuggestion(sug) {
	const key = `suggestion-${sug.id}`;
	if (state.inFlight.has(key)) return;
	state.inFlight.add(key);
	renderSuggestions();
	try {
		const r = await authedFetch(`/_proxy/${sug.applyEndpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(sug.applyBody ?? { action: "on" }),
		});
		if (!r.ok) {
			const text = await r.text().catch(() => "");
			throw new Error(`HTTP ${r.status} ${text}`);
		}
		await r.json().catch(() => null);
		// Green-flash + fade the existing cards out before any re-render
		// replaces the DOM. Without this, the next renderSuggestions()
		// snap-removes them. After the animation we commit dismiss +
		// poll + final render.
		await flashAndFadeSuggestionCards(sug.id, "apply");
		state.dismissedSuggestions.add(sug.id);
		saveDismissedSuggestions();
		await poll();
		showToast(`applied: ${sug.id}`);
		setStatus("ok", `applied: ${sug.id}`);
	} catch (e) {
		setStatus("warn", `${sug.id} apply failed: ${e.message}`);
	} finally {
		state.inFlight.delete(key);
		renderSuggestions();
	}
}

async function dismissSuggestion(id) {
	// Red-flash + fade the cards out *before* mutating state, so the
	// next render (triggered by renderAll) doesn't snap them out from
	// underneath the animation. Suggestion lives in both the global
	// suggestions card AND any linked chart card;
	// flashAndFadeSuggestionCards picks up both via the shared
	// [data-suggestion-id] attribute.
	await flashAndFadeSuggestionCards(id, "dismiss");
	state.dismissedSuggestions.add(id);
	saveDismissedSuggestions();
	renderAll();
	showToast(`dismissed: ${id}`);
}

function resetDismissedSuggestions() {
	state.dismissedSuggestions.clear();
	saveDismissedSuggestions();
	renderAll();
}

/**
 * Dismiss every currently-visible suggestion in one pass. Used by the
 * "dismiss all" header button — the per-card dismiss still works for
 * individual cases.
 */
async function dismissAllSuggestions() {
	const visible = visibleSuggestions();
	if (visible.length === 0) return;
	// Red-flash every visible card together, then commit + render. Bulk
	// dismiss uses the same flash+fade pattern as the per-card path so
	// the two routes look identical.
	await Promise.all(
		visible.map((s) => flashAndFadeSuggestionCards(s.id, "dismiss")),
	);
	for (const sug of visible) state.dismissedSuggestions.add(sug.id);
	saveDismissedSuggestions();
	renderAll();
	showToast(
		`dismissed ${visible.length} suggestion${visible.length === 1 ? "" : "s"}`,
	);
}

/**
 * Apply every currently-visible suggestion sequentially. Sequential
 * (rather than parallel) so a suggestion that mutates server state
 * one knob doesn't race against another that mutates a related one.
 * Each successful apply also flips the corresponding card to
 * dismissed so it disappears from both rendering surfaces.
 */
async function applyAllSuggestions() {
	const visible = visibleSuggestions();
	if (visible.length === 0) return;
	if (state.inFlight.has("apply-all-suggestions")) return;
	state.inFlight.add("apply-all-suggestions");
	renderAll();
	let failures = 0;
	const succeeded = [];
	try {
		for (const sug of visible) {
			// Skip advisory rules — apply-all is for actionable
			// suggestions, not for silently acknowledging warnings.
			// The operator's choice to dismiss an advisory is explicit.
			if (!sug.applyEndpoint) continue;
			try {
				const r = await authedFetch(`/_proxy/${sug.applyEndpoint}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(sug.applyBody ?? { action: "on" }),
				});
				if (!r.ok) {
					failures += 1;
					continue;
				}
				await r.json().catch(() => null);
				succeeded.push(sug.id);
			} catch {
				failures += 1;
			}
		}
		// Green-flash + fade every card whose apply succeeded before
		// committing dismissed-state — same pattern as the per-card
		// apply path, batched here so the operator sees one synchronized
		// flash across the list rather than waiting on a serial loop.
		if (succeeded.length > 0) {
			await Promise.all(
				succeeded.map((id) => flashAndFadeSuggestionCards(id, "apply")),
			);
			for (const id of succeeded) state.dismissedSuggestions.add(id);
			saveDismissedSuggestions();
		}
		await poll();
		if (failures > 0) {
			showToast(
				`applied ${visible.length - failures}/${visible.length} suggestions; ${failures} failed`,
				"warn",
			);
		} else {
			showToast(
				`applied ${visible.length} suggestion${visible.length === 1 ? "" : "s"}`,
				"info",
			);
		}
	} finally {
		state.inFlight.delete("apply-all-suggestions");
		renderAll();
	}
}

/**
 * Build the (deduped, ordered) list of sessions to render in the
 * filter bar. Merge sources: the /_proxy/sessions response (rich
 * metadata) + any sessionKey observed in the samples (catches
 * sessions that aren't surfaced through the sessions endpoint yet —
 * e.g. very-new ones whose stub hasn't been created). The aggregate
 * bucket gets a synthetic "default" entry so legacy-routed samples
 * still surface in the UI.
 */
function buildSessionList() {
	const byKey = new Map();
	for (const s of state.sessions) {
		byKey.set(s.key, {
			key: s.key,
			label: s.label ?? s.key,
			source: "sessions-endpoint",
		});
	}
	for (const sample of state.samples) {
		const key = sample.sessionKey ?? AGGREGATE_BUCKET;
		if (byKey.has(key)) continue;
		byKey.set(key, {
			key,
			label: key === AGGREGATE_BUCKET ? "default" : (sample.label ?? key),
			source: "samples-only",
		});
	}
	const rows = Array.from(byKey.values());
	rows.sort((a, b) => {
		// Aggregate bucket sinks to the bottom; everything else
		// alphabetical by label.
		if (a.key === AGGREGATE_BUCKET) return 1;
		if (b.key === AGGREGATE_BUCKET) return -1;
		return a.label.localeCompare(b.label);
	});
	return rows;
}

const SESSION_TABLE_METRIC_FIELDS = [
	"context",
	"next",
	"week",
	"hit",
	"turn",
	"tps",
	"ttft",
];

/**
 * Compute per-session means for each statusline metric across the
 * visible sample window. Also tracks the most-recent sample timestamp
 * per session for the idle column. Returns a Map keyed by sessionKey.
 */
function computeSessionRowStats() {
	const stats = new Map();
	for (const sample of state.samples) {
		const key = sample.sessionKey ?? AGGREGATE_BUCKET;
		let entry = stats.get(key);
		if (!entry) {
			entry = { sums: {}, counts: {}, lastTs: sample.ts };
			for (const f of SESSION_TABLE_METRIC_FIELDS) {
				entry.sums[f] = 0;
				entry.counts[f] = 0;
			}
			stats.set(key, entry);
		}
		if (sample.ts > entry.lastTs) entry.lastTs = sample.ts;
		for (const f of SESSION_TABLE_METRIC_FIELDS) {
			const v = sample[f];
			if (typeof v === "number" && Number.isFinite(v)) {
				entry.sums[f] += v;
				entry.counts[f] += 1;
			}
		}
	}
	const out = new Map();
	for (const [key, entry] of stats) {
		const means = {};
		for (const f of SESSION_TABLE_METRIC_FIELDS) {
			means[f] = entry.counts[f] > 0 ? entry.sums[f] / entry.counts[f] : null;
		}
		out.set(key, { means, lastTs: entry.lastTs });
	}
	return out;
}

/**
 * Cache-eviction countdown for the sessions table. Mirrors the TUI's
 * formatEvictField: counts down from session.ttlMode (5m / 1h) since
 * the most-recent cache-refreshing touch (last real /v1/messages OR
 * last keep-alive ping, whichever is fresher).
 *
 * Returns `{ text, state }` where state is one of "green" | "yellow"
 * | "red" | "evicted" | "unknown" — the caller applies state as a
 * CSS class so .evicted can pulse-flash via the stylesheet.
 */
function formatEvictCell(session, now = Date.now()) {
	if (!session || typeof session !== "object") {
		return { text: "—", state: "unknown" };
	}
	const lastActivityMs = session.lastActivity
		? Date.parse(session.lastActivity)
		: 0;
	const lastPingMs = session.lastKeepAliveAt
		? Date.parse(session.lastKeepAliveAt)
		: 0;
	const lastTouch = Math.max(
		Number.isFinite(lastActivityMs) ? lastActivityMs : 0,
		Number.isFinite(lastPingMs) ? lastPingMs : 0,
	);
	if (lastTouch <= 0) return { text: "—", state: "unknown" };

	const ttlMs = session.ttlMode === "1h" ? 60 * 60 * 1000 : 5 * 60 * 1000;
	const remainingMs = ttlMs - (now - lastTouch);
	if (remainingMs <= 0) {
		return { text: "evicted", state: "evicted" };
	}
	const totalSec = Math.ceil(remainingMs / 1000);
	const mm = Math.floor(totalSec / 60);
	const ss = totalSec % 60;
	const text = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
	const ratio = remainingMs / ttlMs;
	const state = ratio >= 0.75 ? "green" : ratio >= 0.25 ? "yellow" : "red";
	return { text, state };
}

function formatMetricCell(metricKey, value) {
	if (value == null || !Number.isFinite(value)) return "—";
	switch (metricKey) {
		case "tps":
			return Math.round(value).toString();
		case "ttft":
			return `${Math.round(value)}ms`;
		default:
			return `${Math.round(value)}%`;
	}
}

/**
 * Sessions table: one row per known session. On desktop it shows the
 * label, every statusline metric's mean across the visible window,
 * an idle stamp, and the show/hide/focus/delete actions. On phone
 * widths the metric columns are hidden via `.metric-col` so only the
 * label and actions render (CSS in `@media (max-width: 599px)`).
 */
function renderSessionsTable() {
	const tbody = document.getElementById("sessionsTableBody");
	if (!tbody) return;
	tbody.innerHTML = "";
	// The _aggregate bucket (synthetic "default" label) is a metrics rollup of
	// statusline samples that carried no sessionKey — not a real store session.
	// It has no eviction time and isn't independently deletable, so it does not
	// belong in the per-session table. It still feeds the charts' per-session
	// lines via buildSessionList() at the chart call site.
	const rows = buildSessionList().filter((r) => r.key !== AGGREGATE_BUCKET);
	const stats = computeSessionRowStats();

	if (rows.length === 0) {
		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.className = "sessions-table-empty";
		td.colSpan = 10;
		td.textContent = "no sessions yet — launch with `clawback claude`";
		tr.appendChild(td);
		tbody.appendChild(tr);
		return;
	}

	for (const row of rows) {
		const tr = document.createElement("tr");
		tr.dataset.sessionKey = row.key;
		const focused = state.focusedSession === row.key;
		const visible = isSessionVisible(row.key);
		if (focused) tr.classList.add("focused");
		if (!visible) tr.classList.add("hidden-session");

		// session label cell with color swatch + an inline evict flag
		// (so phone users — where the dedicated evict column is hidden
		// — still see when a session's cache has lapsed).
		const tdLabel = document.createElement("td");
		const labelWrap = document.createElement("span");
		labelWrap.className = "session-label";
		const swatch = document.createElement("span");
		swatch.className = "session-swatch";
		swatch.setAttribute("aria-hidden", "true");
		const style = sessionStyle(row.key);
		swatch.style.background = style.color;
		if (style.dash !== "none") {
			swatch.style.background = `repeating-linear-gradient(90deg, ${style.color} 0 6px, transparent 6px 10px)`;
		}
		labelWrap.appendChild(swatch);
		// Long labels overflow into other table cells; the CSS clips
		// with ellipsis at 28ch. Full label is still discoverable via
		// the cell's title attribute below.
		labelWrap.appendChild(document.createTextNode(row.label));
		const sessionMeta = state.sessions.find((s) => s.key === row.key);
		const evictPreview = formatEvictCell(sessionMeta);
		if (evictPreview.state === "evicted") {
			const flag = document.createElement("span");
			flag.className = "evict-flag";
			flag.textContent = "evicted";
			flag.title =
				"Anthropic's prompt cache for this session has lapsed; the next turn will pay full cache-creation cost.";
			labelWrap.appendChild(flag);
		}
		tdLabel.appendChild(labelWrap);
		tdLabel.title = `sessionKey: ${row.key} · label: ${row.label}`;
		tr.appendChild(tdLabel);

		const entry = stats.get(row.key);
		const means = entry?.means ?? {};
		for (const f of SESSION_TABLE_METRIC_FIELDS) {
			const td = document.createElement("td");
			td.className = "metric-col";
			td.textContent = formatMetricCell(f, means[f]);
			tr.appendChild(td);
		}

		// Reuse the eviction state we computed above for the inline
		// flag (state.sessions carries ttlMode/lastActivity/lastKeepAliveAt
		// from publicSession; we don't need to look it up again).
		const tdEvict = document.createElement("td");
		tdEvict.className = "metric-col evict-cell";
		tdEvict.textContent = evictPreview.text;
		tdEvict.dataset.evictState = evictPreview.state;
		tr.appendChild(tdEvict);

		const tdActions = document.createElement("td");
		const actions = document.createElement("span");
		actions.className = "row-actions";

		// show/hide toggles per-row chart visibility. Focus mode wins
		// while it's on (other rows read as hidden), so clicking "show"
		// on a non-focused row clears focus and surfaces both rows
		// together — see the click handler.
		const showBtn = document.createElement("button");
		showBtn.type = "button";
		showBtn.className = `filter-btn ghost show-btn ${visible ? "" : "show-btn-hidden"}`;
		showBtn.textContent = visible ? "hide" : "show";
		showBtn.title = visible
			? `Hide ${row.label}'s data on the charts.`
			: `Show ${row.label}'s data on the charts.`;
		showBtn.addEventListener("click", () => {
			if (state.focusedSession != null) {
				// Operator-confirmed 2026-05-17: clicking show/hide on
				// any row while focused exits focus mode. A "show" on a
				// non-focused row also explicitly marks the previously-
				// focused session visible, so both rows end up plotted
				// (the natural reading of the click). A "hide" on the
				// focused row clears focus and hides this row; other
				// sessions return to their default-visible state.
				const previouslyFocused = state.focusedSession;
				state.focusedSession = null;
				if (visible) {
					// We're on the focused row clicking "hide".
					state.visibility.sessions[row.key] = false;
				} else {
					// We're on a non-focused row clicking "show".
					state.visibility.sessions[row.key] = true;
					if (previouslyFocused) {
						state.visibility.sessions[previouslyFocused] = true;
					}
				}
			} else {
				state.visibility.sessions[row.key] = !visible;
			}
			saveVisibility();
			renderAll();
		});
		actions.appendChild(showBtn);

		const focusBtn = document.createElement("button");
		focusBtn.type = "button";
		focusBtn.className = `filter-btn ghost focus-btn ${focused ? "active" : ""}`;
		// Keep the visible label stable as "focus" so the action column
		// width doesn't twitch when state flips (operator-requested
		// 2026-05-17). Sighted users see the .active accent fill on the
		// focused row's button; assistive tech reads aria-pressed +
		// aria-label for the state.
		focusBtn.textContent = "focus";
		focusBtn.setAttribute("aria-pressed", focused ? "true" : "false");
		focusBtn.setAttribute(
			"aria-label",
			focused
				? `${row.label} is focused — activate to clear focus and show every session.`
				: `Focus on ${row.label} — restrict every chart to this session.`,
		);
		focusBtn.title = focused
			? "Focused — activate to show every session again."
			: `Restrict every chart to ${row.label} only.`;
		focusBtn.addEventListener("click", () => {
			if (focused) clearFocus();
			else focusSession(row.key);
		});
		actions.appendChild(focusBtn);

		const deleteBtn = document.createElement("button");
		deleteBtn.type = "button";
		deleteBtn.className = "filter-btn ghost danger";
		deleteBtn.textContent = "delete";
		deleteBtn.title = `Delete session ${row.label} from the proxy store`;
		deleteBtn.disabled = state.inFlight.has(`purge-${row.key}`);
		deleteBtn.addEventListener("click", () => purgeSession(row.key, row.label));
		actions.appendChild(deleteBtn);
		tdActions.appendChild(actions);
		tr.appendChild(tdActions);

		tbody.appendChild(tr);
	}
}

function renderChartsGrid() {
	const grid = document.getElementById("chartsGrid");
	if (!grid) return;
	// Idempotent: build each card once and reuse it on every subsequent
	// render. The previous implementation did `grid.innerHTML = ""` and
	// rebuilt every card on each poll tick (4×/s at refreshMs 250), which
	// collapsed the grid to zero height and re-expanded it every tick —
	// the page reflowed, scroll jumped, charts resize-jittered (clientWidth
	// read mid-layout), and hover overlays were destroyed. Reusing the
	// nodes and repainting only the SVG removes that jank. Regression test:
	// "re-render reuses chart-card and hover nodes ... (no jank)".
	for (const metric of METRICS) {
		let card = grid.querySelector(`.chart-card[data-metric="${metric.key}"]`);
		if (!card) {
			card = createChartCard(metric);
			grid.appendChild(card);
		}
		syncLinkedSuggestions(card, metric);
		// Repaint into the persistent holder. Deferred to a microtask so a
		// just-created card has resolved its layout (clientWidth) before
		// paintChart reads it.
		const holder = card.querySelector(".mini-chart");
		const readout = card.querySelector(".chart-card-readout");
		const hover = card.querySelector(".chart-hover");
		queueMicrotask(() => paintChart(metric, holder, readout, hover));
	}
}

/**
 * Build the persistent scaffold for one chart card — created once and
 * reused across renders (see renderChartsGrid). The SVG itself and the
 * linked suggestions are filled in separately on every render.
 *
 * <figure>+<figcaption> so screen readers announce the caption as the
 * chart's accessible name and the readout (latest value + visible-
 * session count) is part of that announcement — the figcaption is the
 * text-equivalent representation of the SVG.
 */
function createChartCard(metric) {
	const card = document.createElement("figure");
	card.className = "chart-card";
	card.dataset.metric = metric.key;

	const caption = document.createElement("figcaption");
	caption.className = "chart-card-header";
	const title = document.createElement("span");
	title.className = "chart-card-title";
	title.style.color = metric.color;
	title.textContent = metric.label;
	caption.appendChild(title);

	const readout = document.createElement("span");
	readout.className = "chart-card-readout";
	caption.appendChild(readout);
	card.appendChild(caption);

	const chartHolder = document.createElement("div");
	chartHolder.className = "mini-chart";
	chartHolder.id = `chart-${metric.key}`;
	card.appendChild(chartHolder);

	// Hover overlay (absolutely positioned, hidden until pointermove
	// inside the holder). Persists across repaints — never re-created.
	const hover = document.createElement("div");
	hover.className = "chart-hover hidden";
	hover.dataset.metric = metric.key;
	card.appendChild(hover);

	return card;
}

/**
 * Reconcile the linked-suggestion nodes inside a chart card with the
 * current suggestion set. Suggestions appear/disappear between ticks, so
 * the old nodes are removed and the current ones re-appended in place —
 * without disturbing the persistent caption/holder/hover nodes above
 * them. Any suggestion whose id maps to this metric renders below the
 * chart, with a left-border accent framing the pair.
 */
function syncLinkedSuggestions(card, metric) {
	for (const node of [...card.children]) {
		if (node.classList.contains("linked-suggestion")) node.remove();
	}
	const linked = linkedSuggestionsFor(metric.key);
	if (linked.length > 0) {
		card.classList.add("has-linked-suggestion");
		card.style.borderLeftColor = metric.color;
		for (const sug of linked) {
			card.appendChild(buildSuggestionCard(sug, "linked-suggestion"));
		}
	} else {
		card.classList.remove("has-linked-suggestion");
		card.style.borderLeftColor = "";
	}
}

function getSeriesList(metric) {
	if (Array.isArray(metric.series) && metric.series.length > 0) {
		return metric.series.map((s) => ({
			field: s.field,
			label: s.label ?? s.field,
			color: s.color ?? metric.color ?? "var(--accent)",
		}));
	}
	return [
		{
			field: metric.key,
			label: metric.label,
			color: metric.color ?? "var(--accent)",
		},
	];
}

/**
 * Robust upper bound for a value series, via the Tukey upper fence
 * (Q3 + 1.5·IQR) clamped to the observed max. tps/ttft charts are
 * routinely dominated by lone spikes (cold-cache TTFT, near-zero-
 * denominator tps); scaling the y-axis to the raw max flattens every
 * normal point against the floor. The fence pins the axis to the bulk
 * of the distribution; out-of-fence points clip at the chart ceiling
 * (see the clamped `y` mapping) and the precise latest value still
 * shows in the readout. Falls back to the raw max for <4 points.
 */
function robustUpperBound(values) {
	const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
	const n = xs.length;
	if (n === 0) return 0;
	if (n < 4) return xs[n - 1];
	const q = (p) => {
		const idx = p * (n - 1);
		const lo = Math.floor(idx);
		const hi = Math.ceil(idx);
		return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
	};
	const q1 = q(0.25);
	const q3 = q(0.75);
	return Math.min(xs[n - 1], q3 + 1.5 * (q3 - q1));
}

function computeYMaxMulti(metric, allLines) {
	if (metric.scale === "pct") return 100;
	const values = [];
	for (const line of allLines) {
		for (const p of line.points) values.push(p.value);
	}
	let max = robustUpperBound(values);
	if (metric.scale === "tps" && max < state.thresholds.tpsHigh) {
		max = state.thresholds.tpsHigh;
	}
	if (metric.scale === "ttft" && max < state.thresholds.ttftHigh) {
		max = state.thresholds.ttftHigh;
	}
	if (max <= 0) max = 1;
	return max;
}

/**
 * Mean of `field` over samples where mode.passthrough was true. Returns
 * null if no passthrough samples exist — caller skips the baseline
 * line. Reads from full `allSamples` (not the halved view) so a
 * baseline captured hours ago still anchors today's chart.
 */
function computeBaseline(allSamples, field) {
	let sum = 0;
	let count = 0;
	for (const s of allSamples) {
		if (!s.mode?.passthrough) continue;
		const v = s[field];
		if (typeof v === "number" && Number.isFinite(v)) {
			sum += v;
			count++;
		}
	}
	return count > 0 ? sum / count : null;
}

/**
 * Render the +/- delta vs baseline for a single series. Returns
 * { html, better } where html is a small markup snippet for the chart
 * readout and `better` indicates direction. When direction is unset or
 * current/baseline missing, returns null.
 */
function baselineDeltaChip(metric, current, baseline) {
	if (
		current == null ||
		!Number.isFinite(current) ||
		baseline == null ||
		!Number.isFinite(baseline)
	) {
		return null;
	}
	const delta = current - baseline;
	const direction = metric.direction;
	const better =
		direction === "higher-better"
			? delta > 0
			: direction === "lower-better"
				? delta < 0
				: null;
	const cls =
		better == null
			? "chart-card-baseline"
			: better
				? "chart-card-baseline better"
				: "chart-card-baseline worse";
	// "+" only for positive deltas; negatives already carry their own "-"
	// from formatAxisValue, and zero gets no sign. (Previously the sign was
	// concatenated twice here — "++8%" — and an abs+strip second path also
	// dropped the minus on negative deltas.)
	const sign = delta > 0 ? "+" : "";
	const deltaStr = formatAxisValue(metric, delta);
	return {
		html: `<span class="${cls}" title="baseline ${formatAxisValue(metric, baseline)}">${sign}${deltaStr} vs baseline</span>`,
		better,
	};
}

// Default chart display window: the most-recent 15 minutes, anchored to
// wall-clock now (see chartTimeDomain) so the right edge tracks the
// present and samples scroll off the left as they age — the window
// visibly empties out when traffic stops. Operator-requested 2026-05-29,
// replacing the earlier fraction-of-span halving.
const DISPLAY_WINDOW_MS = 15 * 60 * 1000;

// Samples that fall inside the now-anchored window. Used for line
// building, markers, and the robust y-scale, so out-of-window samples
// don't drag the y-axis or draw stray off-window segments. Returns the
// (possibly empty) in-window slice — no fallback to the full series,
// since that would defeat the empty-out behavior.
function displayWindow(allSamples) {
	const start = Date.now() - DISPLAY_WINDOW_MS;
	return allSamples.filter((s) => Date.parse(s.ts) >= start);
}

// The now-anchored x-axis domain shared by both chart renderers: the
// right edge is the present moment, the left edge is 15 minutes prior.
// Independent of the sample timestamps, so the axis holds still and the
// data slides across it (rather than the data stretching edge-to-edge).
function chartTimeDomain() {
	const max = Date.now();
	return { min: max - DISPLAY_WINDOW_MS, max };
}

function paintChart(metric, holder, readout, hover) {
	const allSamples = state.samples;
	// Snap the SVG to an integer pixel size matching the holder, so the
	// viewBox is 1:1 with screen pixels and text inside renders at its
	// declared font-size (no aspect-ratio stretching of glyphs).
	const w = Math.max(320, holder.clientWidth || 360);
	const h = Math.max(220, Math.round(w * 0.42));
	const pad = { l: 44, r: 12, t: 14, b: 28 };
	const innerW = Math.max(10, w - pad.l - pad.r);
	const innerH = Math.max(10, h - pad.t - pad.b);

	if (allSamples.length === 0) {
		holder.innerHTML = `<div class="empty">no samples yet</div>`;
		readout.textContent = "";
		hover?.classList.add("hidden");
		return;
	}

	const samples = displayWindow(allSamples);

	const sessionRows = buildSessionList();
	const visibleSessionKeys = new Set(
		sessionRows.filter((r) => isSessionVisible(r.key)).map((r) => r.key),
	);

	const seriesList = getSeriesList(metric);

	// Build, per series: per-session lines + aggregate line + baseline.
	// Each series is keyed by its `field` (e.g. "next", "week").
	const seriesData = seriesList.map((s) => {
		const perSessionLines = [];
		const seriesMetric = { key: s.field, aggregate: metric.aggregate };
		for (const row of sessionRows) {
			if (!visibleSessionKeys.has(row.key)) continue;
			const pts = perSessionSeries(samples, seriesMetric, row.key);
			if (pts.length === 0) continue;
			const style = sessionStyle(row.key);
			perSessionLines.push({
				key: row.key,
				label: row.label,
				color: style.color,
				dash: style.dash,
				points: pts,
			});
		}
		const aggregateLine = state.visibility.aggregate
			? computeAggregateSeries(samples, seriesMetric, visibleSessionKeys)
			: [];
		const baseline = computeBaseline(allSamples, s.field);
		return {
			field: s.field,
			label: s.label,
			color: s.color,
			perSessionLines,
			aggregateLine,
			baseline,
		};
	});

	const allLines = seriesData.flatMap((s) => [
		...s.perSessionLines,
		...(s.aggregateLine.length > 0 ? [{ points: s.aggregateLine }] : []),
	]);

	const { min: tsMin, max: tsMax } = chartTimeDomain();
	const tsSpan = Math.max(1, tsMax - tsMin);
	const yMax = computeYMaxMulti(metric, allLines);

	const x = (ts) => pad.l + ((Date.parse(ts) - tsMin) / tsSpan) * innerW;
	// Clamp to the plotting area so values above the robust yMax (lone
	// outliers, see computeYMaxMulti) clip flat at the ceiling rather than
	// drawing up over the title/axis labels.
	const y = (v) =>
		Math.max(pad.t, Math.min(pad.t + innerH, pad.t + (1 - v / yMax) * innerH));

	// Width/height attributes pin the SVG's drawing surface to an exact
	// pixel size (1:1 with the viewBox), so the CSS-driven width:100%
	// scales the whole picture uniformly — text included.
	let svg = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${metric.label} over time">`;

	// Background gridlines + y-axis labels.
	for (let i = 0; i <= 4; i++) {
		const frac = i / 4;
		const yy = pad.t + (1 - frac) * innerH;
		svg += `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${(w - pad.r).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--grid-line)" stroke-width="0.5" />`;
		const labelV = yMax * frac;
		svg += `<text x="${pad.l - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${formatAxisValue(metric, labelV)}</text>`;
	}

	// X-axis time labels — the now-anchored domain bounds (left = 15 min
	// ago, right = now), independent of the sample timestamps.
	const tsLabelY = h - pad.b + 16;
	svg += `<text x="${pad.l}" y="${tsLabelY.toFixed(1)}" text-anchor="start" font-size="11" fill="var(--muted)">${escapeAttr(formatLocalTime(tsMin))}</text>`;
	svg += `<text x="${(w - pad.r).toFixed(1)}" y="${tsLabelY.toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${escapeAttr(formatLocalTime(tsMax))}</text>`;

	// Mode-change vertical markers (color + dash per toggle).
	svg += renderModeMarkers(samples, x, pad, innerH);

	// Per-series rendering loop. For each series: thin per-session lines,
	// then the thicker aggregate on top, then a horizontal baseline.
	for (const s of seriesData) {
		for (const line of s.perSessionLines) {
			const d = buildPath(line.points, x, y, tsMax);
			if (!d) continue;
			const dashAttr =
				line.dash && line.dash !== "none"
					? ` stroke-dasharray="${line.dash}"`
					: "";
			svg += `<path class="series series-session" data-series="${escapeAttr(s.field)}" data-session="${escapeAttr(line.key)}" d="${d}" stroke="${line.color}" stroke-width="1.8" fill="none" opacity="0.85"${dashAttr} />`;
		}
		if (s.aggregateLine.length > 0) {
			const d = buildPath(s.aggregateLine, x, y, tsMax);
			if (d) {
				svg += `<path class="series series-aggregate" data-series="${escapeAttr(s.field)}" data-metric="${metric.key}" d="${d}" stroke="${s.color}" stroke-width="3.2" fill="none" />`;
			}
		}
		// Baseline horizontal reference line — only when a passthrough
		// baseline is available for this series.
		if (s.baseline != null && s.baseline >= 0 && s.baseline <= yMax) {
			const by = y(s.baseline).toFixed(1);
			svg += `<line class="series-baseline" data-series="${escapeAttr(s.field)}" x1="${pad.l}" y1="${by}" x2="${(w - pad.r).toFixed(1)}" y2="${by}" stroke="${s.color}" stroke-width="1" stroke-dasharray="10 5" opacity="0.5"><title>${escapeAttr(s.label)} baseline ${formatAxisValue(metric, s.baseline)}</title></line>`;
			svg += `<text x="${(w - pad.r - 4).toFixed(1)}" y="${(y(s.baseline) - 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${s.color}" opacity="0.7">baseline ${escapeAttr(s.label)}</text>`;
		}
	}

	svg += "</svg>";
	holder.innerHTML = svg;

	// Header readout: per-series latest + delta vs baseline (when
	// available). For single-series charts, drops the series label.
	const readoutParts = [];
	for (const s of seriesData) {
		const lastAgg = s.aggregateLine.length
			? s.aggregateLine[s.aggregateLine.length - 1].value
			: latestPerSessionAverage(s.perSessionLines);
		if (lastAgg == null) continue;
		const prefix = seriesList.length > 1 ? `${escapeAttr(s.label)} ` : "";
		let part = `${prefix}<strong>${formatAxisValue(metric, lastAgg)}</strong>`;
		const delta = baselineDeltaChip(metric, lastAgg, s.baseline);
		if (delta) part += ` ${delta.html}`;
		readoutParts.push(part);
	}
	const visibleCount = seriesData.reduce(
		(n, s) => n + (s.perSessionLines.length > 0 ? 1 : 0),
		0,
	);
	if (readoutParts.length === 0) {
		readout.textContent = `${visibleCount}/${sessionRows.length} sessions`;
	} else {
		readout.innerHTML = `${readoutParts.join(" · ")} · ${sessionRows.length} session${sessionRows.length === 1 ? "" : "s"}`;
	}

	// Hover crosshair (single-series only for now — multi-series hover
	// gets confusing). seriesData[0] suffices when single-series.
	if (hover) {
		if (seriesList.length === 1) {
			attachChartHover(holder, hover, {
				metric,
				samples,
				perSessionLines: seriesData[0].perSessionLines,
				aggregateLine: seriesData[0].aggregateLine,
				pad,
				w,
				h,
				tsMin,
				tsSpan,
			});
		} else {
			hover.classList.add("hidden");
			holder.onpointermove = null;
			holder.onpointerleave = null;
		}
	}
}

function renderModeMarkers(samples, x, pad, innerH) {
	let out = "";
	let prevMode = null;
	for (const s of samples) {
		if (!s.mode) continue;
		if (prevMode) {
			const xx = x(s.ts);
			const timeLabel = formatLocalTime(s.ts);
			const modeLine = (cls) => {
				const style = MODE_LINE_STYLE[cls];
				if (!style) return "";
				const direction = describeFlip(cls, prevMode, s.mode);
				const titleText = escapeAttr(
					`${style.label} ${direction} · ${timeLabel}`,
				);
				return `<line class="mode-line ${cls}" x1="${xx.toFixed(1)}" y1="${pad.t}" x2="${xx.toFixed(1)}" y2="${pad.t + innerH}" stroke="${style.color}" stroke-width="1" stroke-dasharray="${style.dash}" opacity="0.26"><title>${titleText}</title></line>`;
			};
			if (s.mode.passthrough !== prevMode.passthrough)
				out += modeLine("passthrough");
			if (s.mode.keepAliveEnabled !== prevMode.keepAliveEnabled)
				out += modeLine("keep-alive");
			if (s.mode.stripEphemeralFromSystem !== prevMode.stripEphemeralFromSystem)
				out += modeLine("strip-ephemeral");
			if (s.mode.injectExtendedCacheTtl !== prevMode.injectExtendedCacheTtl)
				out += modeLine("extend-cache-ttl");
			if (s.mode.mobile !== prevMode.mobile) out += modeLine("mobile");
			if (s.mode.keepAliveModeExtended !== prevMode.keepAliveModeExtended)
				out += modeLine("keep-alive-extended");
			if (s.mode.autoContinue !== prevMode.autoContinue)
				out += modeLine("auto-continue");
		}
		prevMode = s.mode;
	}
	return out;
}

/**
 * Composite overview chart at the top of the dashboard. Every metric
 * is plotted on a single 0-100 y-axis: pct metrics directly, ttft and
 * tps normalized via their threshold-high values (so they share scale
 * with the percentages). The legend below shows each metric's latest
 * raw value in its line color.
 */
function renderOverviewChart() {
	const holder = document.getElementById("overviewChart");
	const legend = document.getElementById("overviewLegend");
	if (!holder || !legend) return;

	const allSamples = state.samples;
	if (allSamples.length === 0) {
		holder.innerHTML = `<div class="empty">no samples yet</div>`;
		legend.innerHTML = "";
		return;
	}

	const w = Math.max(640, holder.clientWidth || 800);
	const h = Math.max(280, Math.round(w * 0.34));
	// Symmetric horizontal padding so the right axis can carry the TTFT
	// millisecond scale (other metrics on this chart are normalized to
	// the left 0-100% axis; only TTFT is read in real units off the right).
	const pad = { l: 44, r: 52, t: 14, b: 28 };
	const innerW = Math.max(10, w - pad.l - pad.r);
	const innerH = Math.max(10, h - pad.t - pad.b);
	const ttftHigh = state.thresholds.ttftHigh || 5000;

	const samples = displayWindow(allSamples);

	const sessionRows = buildSessionList();
	const visibleSessionKeys = new Set(
		sessionRows.filter((r) => isSessionVisible(r.key)).map((r) => r.key),
	);

	// Build a list of overview "tracks" — one per displayed metric / sub-
	// series. Each track has a field name, label, color, and a function
	// that normalizes raw values to the 0-100 axis.
	const tracks = [];
	for (const m of METRICS) {
		const series = getSeriesList(m);
		for (const s of series) {
			tracks.push({
				field: s.field,
				label: series.length > 1 ? `${m.label}/${s.label}` : m.label,
				color: s.color,
				metric: m,
				normalize: makeOverviewNormalizer(m),
			});
		}
	}

	const { min: tsMin, max: tsMax } = chartTimeDomain();
	const tsSpan = Math.max(1, tsMax - tsMin);
	const x = (ts) => pad.l + ((Date.parse(ts) - tsMin) / tsSpan) * innerW;
	const y = (pct) => pad.t + (1 - pct / 100) * innerH;

	let svg = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="overview of all metrics">`;

	// Gridlines with dual y-axes: left is the normalized 0-100% scale
	// every metric shares for overlay; right is labelled in milliseconds
	// against the TTFT line so the operator can read TTFT in real units
	// off the chart. TTFT normalization is v / (2 × ttftHigh) — that's
	// the inverse mapping we render here.
	for (let i = 0; i <= 4; i++) {
		const frac = i / 4;
		const yy = pad.t + (1 - frac) * innerH;
		svg += `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${(w - pad.r).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--grid-line)" stroke-width="0.5" />`;
		svg += `<text x="${pad.l - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(frac * 100)}%</text>`;
		const ms = Math.round(frac * 2 * ttftHigh);
		svg += `<text x="${(w - pad.r + 6).toFixed(1)}" y="${(yy + 3).toFixed(1)}" text-anchor="start" font-size="11" fill="var(--muted)">${ms}</text>`;
	}
	svg += `<text x="${(w - pad.r + 6).toFixed(1)}" y="${pad.t - 4}" text-anchor="start" font-size="10" fill="var(--muted)" font-style="italic">ms (TTFT)</text>`;

	const tsLabelY = h - pad.b + 16;
	svg += `<text x="${pad.l}" y="${tsLabelY.toFixed(1)}" text-anchor="start" font-size="11" fill="var(--muted)">${escapeAttr(formatLocalTime(tsMin))}</text>`;
	svg += `<text x="${(w - pad.r).toFixed(1)}" y="${tsLabelY.toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${escapeAttr(formatLocalTime(tsMax))}</text>`;

	// Mode-change markers (same as per-metric charts).
	svg += renderModeMarkers(samples, x, pad, innerH);

	// One line per track, aggregated across visible sessions. We use a
	// simple "mean of latest per session" forward-fill so the line
	// stays continuous even when sessions report at staggered times.
	const legendItems = [];
	for (const track of tracks) {
		const seriesMetric = { key: track.field, aggregate: "mean" };
		const series = computeAggregateSeries(
			samples,
			seriesMetric,
			visibleSessionKeys,
		);
		if (series.length === 0) continue;
		const normalized = series.map((p) => ({
			ts: p.ts,
			value: track.normalize(p.value),
		}));
		const d = buildPath(normalized, x, y, tsMax);
		if (!d) continue;
		svg += `<path class="overview-line" data-field="${escapeAttr(track.field)}" d="${d}" stroke="${track.color}" stroke-width="2.6" fill="none" opacity="0.9" />`;
		const latestRaw = series[series.length - 1].value;
		legendItems.push({
			color: track.color,
			label: track.label,
			value: formatAxisValue(track.metric, latestRaw),
		});
	}

	svg += "</svg>";
	holder.innerHTML = svg;

	legend.innerHTML = "";
	for (const item of legendItems) {
		const wrap = document.createElement("span");
		wrap.className = "overview-legend-item";
		const swatch = document.createElement("span");
		swatch.className = "overview-legend-swatch";
		swatch.style.background = item.color;
		wrap.appendChild(swatch);
		const lab = document.createElement("span");
		lab.className = "overview-legend-label";
		lab.textContent = item.label;
		wrap.appendChild(lab);
		const val = document.createElement("span");
		val.className = "overview-legend-value";
		val.textContent = item.value;
		wrap.appendChild(val);
		legend.appendChild(wrap);
	}
}

function makeOverviewNormalizer(metric) {
	if (metric.scale === "pct") return (v) => Math.max(0, Math.min(100, v));
	if (metric.scale === "tps") {
		const high = state.thresholds.tpsHigh || 75;
		// Map [0, 2 × high] → [0, 100] so values right at the green
		// threshold show as 50% on the overview axis. Clamp at 100.
		return (v) => Math.max(0, Math.min(100, (v / (2 * high)) * 100));
	}
	if (metric.scale === "ttft") {
		const high = state.thresholds.ttftHigh || 5000;
		return (v) => Math.max(0, Math.min(100, (v / (2 * high)) * 100));
	}
	return (v) => Math.max(0, Math.min(100, v));
}

/**
 * Attach a pointermove handler that updates a chart's hover chip.
 * Finds the sample whose timestamp is closest to the cursor's x
 * position and renders timestamp + per-line values into the chip.
 *
 * Listeners are replaced on every paint (we set .onpointermove rather
 * than addEventListener), so we don't leak handlers across polls.
 */
function attachChartHover(holder, hover, ctx) {
	const {
		metric,
		samples,
		perSessionLines,
		aggregateLine,
		pad,
		w,
		h,
		tsMin,
		tsSpan,
	} = ctx;
	const card = holder.parentElement;
	const sampleTimestamps = samples.map((s) => Date.parse(s.ts));

	holder.onpointerleave = () => {
		hover.classList.add("hidden");
	};

	holder.onpointermove = (event) => {
		const rect = holder.getBoundingClientRect();
		if (rect.width <= 0) return;
		const xPx = ((event.clientX - rect.left) / rect.width) * w;
		const innerW = Math.max(10, w - pad.l - pad.r);
		const xFrac = Math.max(0, Math.min(1, (xPx - pad.l) / innerW));
		const ts = tsMin + xFrac * tsSpan;
		// Find the closest sample timestamp.
		let nearest = sampleTimestamps[0];
		let nearestDist = Math.abs(ts - nearest);
		for (const tts of sampleTimestamps) {
			const d = Math.abs(ts - tts);
			if (d < nearestDist) {
				nearest = tts;
				nearestDist = d;
			}
		}
		// Collect lines whose nearest sample value is finite.
		const rows = [];
		for (const line of perSessionLines) {
			const p = nearestPoint(line.points, nearest);
			if (p)
				rows.push({ color: line.color, label: line.label, value: p.value });
		}
		if (aggregateLine.length > 0) {
			const p = nearestPoint(aggregateLine, nearest);
			if (p) rows.push({ color: metric.color, label: "agg", value: p.value });
		}
		if (rows.length === 0) {
			hover.classList.add("hidden");
			return;
		}
		hover.innerHTML = "";
		const tsEl = document.createElement("div");
		tsEl.className = "ts";
		tsEl.textContent = formatLocalTime(new Date(nearest).toISOString());
		hover.appendChild(tsEl);
		for (const row of rows) {
			const r = document.createElement("div");
			r.className = "row";
			const sw = document.createElement("span");
			sw.className = "swatch";
			sw.style.background = row.color;
			r.appendChild(sw);
			const lab = document.createElement("span");
			lab.textContent = `${row.label}: ${formatAxisValue(metric, row.value)}`;
			r.appendChild(lab);
			hover.appendChild(r);
		}
		// Position to the right of the cursor, clamped to the card.
		const cardRect = card.getBoundingClientRect();
		const left = Math.min(
			cardRect.width - 220,
			Math.max(0, event.clientX - cardRect.left + 12),
		);
		const top = Math.max(0, event.clientY - cardRect.top - 4);
		hover.style.left = `${left}px`;
		hover.style.top = `${top}px`;
		hover.classList.remove("hidden");
	};
}

/**
 * Build a CSV string from the current sessions table data and trigger
 * a browser download. Includes every column the desktop table shows
 * (label + per-metric means + idle), plus the sessionKey so an
 * external spreadsheet can re-join against other clawback exports.
 *
 * Pure-DOM Blob + anchor click — no third-party libs, no network.
 */
function downloadSessionsCsv() {
	const rows = buildSessionList();
	const stats = computeSessionRowStats();
	const header = [
		"sessionKey",
		"label",
		"context",
		"quota",
		"week",
		"hit",
		"turn",
		"tps",
		"ttft",
		"evict",
	];
	const lines = [header.map(csvEscape).join(",")];
	for (const row of rows) {
		const entry = stats.get(row.key);
		const means = entry?.means ?? {};
		const sessionMeta = state.sessions.find((s) => s.key === row.key);
		const evict = formatEvictCell(sessionMeta);
		const numeric = (v) =>
			v == null || !Number.isFinite(v) ? "" : v.toFixed(2);
		lines.push(
			[
				csvEscape(row.key),
				csvEscape(row.label),
				numeric(means.context),
				numeric(means.next),
				numeric(means.week),
				numeric(means.hit),
				numeric(means.turn),
				numeric(means.tps),
				numeric(means.ttft),
				csvEscape(evict.state === "unknown" ? "" : evict.text),
			].join(","),
		);
	}
	const csv = `${lines.join("\n")}\n`;
	const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	a.download = `clawback-sessions-${stamp}.csv`;
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function csvEscape(value) {
	const s = String(value ?? "");
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

function nearestPoint(points, targetMs) {
	if (!points || points.length === 0) return null;
	let best = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const p of points) {
		const d = Math.abs(Date.parse(p.ts) - targetMs);
		if (d < bestDist) {
			best = p;
			bestDist = d;
		}
	}
	return best;
}

function latestPerSessionAverage(perSessionLines) {
	let sum = 0;
	let n = 0;
	for (const line of perSessionLines) {
		const last = line.points[line.points.length - 1];
		if (last) {
			sum += last.value;
			n++;
		}
	}
	return n > 0 ? sum / n : null;
}

function buildPath(points, x, y, extendToTs) {
	if (!points || points.length === 0) return "";
	let pts = points;
	if (extendToTs != null) {
		// Forward-fill the last known value flat to `now` (the right edge of
		// the now-anchored domain), the live-tail idiom: the line is visibly
		// pinned to now instead of ending short and appearing to drift away
		// from the anchor as time advances. It also turns a lone sample into
		// a drawn segment rather than an invisible moveto. The held tail ages
		// out naturally once its source sample leaves the 15-min window.
		const last = points[points.length - 1];
		pts = [
			...points,
			{ ts: new Date(extendToTs).toISOString(), value: last.value },
		];
	}
	let d = "";
	let move = true;
	for (const p of pts) {
		const xx = x(p.ts);
		const yy = y(p.value);
		d += `${move ? "M" : "L"} ${xx.toFixed(1)} ${yy.toFixed(1)} `;
		move = false;
	}
	return d.trim();
}

function formatAxisValue(metric, v) {
	if (v == null || !Number.isFinite(v)) return "—";
	switch (metric.scale) {
		case "pct":
			return `${Math.round(v)}%`;
		case "tps":
			return `${Math.round(v)}`;
		case "ttft":
			return `${Math.round(v)}ms`;
		default:
			return String(v);
	}
}

function escapeAttr(s) {
	return String(s).replace(/[&<>"']/g, (c) => {
		switch (c) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return c;
		}
	});
}

async function toggleEndpoint(endpoint, key) {
	if (state.inFlight.has(key)) return;
	state.inFlight.add(key);
	renderButtons();
	try {
		const r = await authedFetch(`/_proxy/${endpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "toggle" }),
		});
		if (!r.ok) {
			const text = await r.text().catch(() => "");
			throw new Error(`HTTP ${r.status} ${text}`);
		}
		await r.json().catch(() => null);
		await poll();
	} catch (e) {
		setStatus("warn", `${key} toggle failed: ${e.message}`);
	} finally {
		state.inFlight.delete(key);
		renderButtons();
	}
}

async function clearHistory() {
	if (state.inFlight.has("clear")) return;
	const ok = globalThis.confirm
		? globalThis.confirm(
				"Wipe the proxy's metrics history? Charts will start empty.",
			)
		: true;
	if (!ok) return;
	state.inFlight.add("clear");
	renderButtons();
	try {
		const r = await authedFetch("/_proxy/metrics", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "clear" }),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		await r.json().catch(() => null);
		state.samples = [];
		renderAll();
		setStatus("ok", "history cleared");
	} catch (e) {
		setStatus("warn", `clear failed: ${e.message}`);
	} finally {
		state.inFlight.delete("clear");
		renderButtons();
	}
}

/**
 * Trigger a baseline capture run. In classic mode the server flips
 * passthrough on for N turns; in shadow mode (the toggle) it instead
 * keeps clawback armed and fires a parallel no-clawback twin per turn
 * at ~2× token cost. The poll loop refreshes `state.baselineCapture`
 * so the button reflects progress without a full re-render here.
 */
async function startCaptureBaseline() {
	if (state.inFlight.has("capture-baseline")) return;
	if (state.baselineCapture?.active) return;
	const shadow = Boolean(
		document.getElementById("captureShadowToggle")?.checked,
	);
	state.inFlight.add("capture-baseline");
	renderCaptureBaselineButton();
	try {
		const r = await authedFetch("/_proxy/capture-baseline", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ shadow }),
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
		state.baselineCapture = {
			active: Boolean(body.active),
			turnsRemaining: body.turnsRemaining | 0,
			targetTurns: body.targetTurns | 0,
			startedAt: body.startedAt ?? null,
			shadow: Boolean(body.shadow),
			defaultShadow: Boolean(body.defaultShadow),
		};
		showToast(
			body.shadow
				? `shadow baseline armed — ${body.targetTurns ?? "?"} turn(s) at ~2× token cost (clawback.md stays on)`
				: `baseline capture armed — ${body.targetTurns ?? "?"} turn(s)`,
			body.shadow ? "warn" : "info",
		);
	} catch (e) {
		showToast(`capture baseline failed: ${e.message}`, "warn");
	} finally {
		state.inFlight.delete("capture-baseline");
		// Pull fresh state so the button picks up the in-progress shape;
		// poll() will keep ticking it down as the server decrements.
		await poll();
	}
}

async function purgeSession(sessionKey, label) {
	const inflightKey = `purge-${sessionKey}`;
	if (state.inFlight.has(inflightKey)) return;
	// Confirm — purge is irreversible.
	const ok = globalThis.confirm
		? globalThis.confirm(`Delete session "${label}" (${sessionKey})?`)
		: true;
	if (!ok) return;
	state.inFlight.add(inflightKey);
	renderAll();
	try {
		const r = await authedFetch(
			`/_proxy/sessions/${encodeURIComponent(sessionKey)}`,
			{ method: "DELETE" },
		);
		if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
		await r.json().catch(() => null);
		await poll();
		setStatus("ok", `purged ${label}`);
	} catch (e) {
		setStatus("warn", `purge failed: ${e.message}`);
	} finally {
		state.inFlight.delete(inflightKey);
		renderAll();
	}
}

async function purgeAll() {
	if (state.inFlight.has("purge-all")) return;
	const ok = globalThis.confirm
		? globalThis.confirm(
				"Delete EVERY session from the proxy store? This cannot be undone.",
			)
		: true;
	if (!ok) return;
	state.inFlight.add("purge-all");
	renderButtons();
	try {
		const r = await authedFetch("/_proxy/sessions", { method: "DELETE" });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const body = await r.json().catch(() => ({}));
		await poll();
		setStatus("ok", `purged ${body.purged ?? 0} sessions`);
	} catch (e) {
		setStatus("warn", `purge-all failed: ${e.message}`);
	} finally {
		state.inFlight.delete("purge-all");
		renderButtons();
	}
}

/**
 * Bulk-delete every session whose prompt cache has already evicted
 * (per formatEvictCell, i.e. now - max(lastActivity, lastKeepAliveAt)
 * has exceeded the session's ttlMode). Skips the _aggregate bucket
 * because it isn't a real session in the store. Issues one DELETE
 * per session in parallel via Promise.allSettled; reports successes
 * and failures via a toast.
 */
async function purgeAllEvicted() {
	if (state.inFlight.has("purge-evicted")) return;
	const now = Date.now();
	const targets = [];
	for (const s of state.sessions) {
		if (!s || !s.key || s.key === AGGREGATE_BUCKET) continue;
		const e = formatEvictCell(s, now);
		if (e.state === "evicted") {
			targets.push({ key: s.key, label: s.label ?? s.key });
		}
	}
	if (targets.length === 0) {
		showToast("no evicted sessions to delete", "info");
		return;
	}
	const ok = globalThis.confirm
		? globalThis.confirm(
				`Delete ${targets.length} evicted session${targets.length === 1 ? "" : "s"}? This cannot be undone.`,
			)
		: true;
	if (!ok) return;
	state.inFlight.add("purge-evicted");
	renderAll();
	try {
		const results = await Promise.allSettled(
			targets.map(({ key }) =>
				authedFetch(`/_proxy/sessions/${encodeURIComponent(key)}`, {
					method: "DELETE",
				}).then((r) => {
					if (!r.ok && r.status !== 404) {
						throw new Error(`HTTP ${r.status}`);
					}
				}),
			),
		);
		const failed = results.filter((r) => r.status === "rejected").length;
		await poll();
		const ok = targets.length - failed;
		if (failed > 0) {
			showToast(
				`${ok}/${targets.length} evicted sessions deleted; ${failed} failed`,
				"warn",
			);
			setStatus("warn", `evicted purge: ${failed} failed`);
		} else {
			showToast(`${ok} evicted session${ok === 1 ? "" : "s"} deleted`, "info");
			setStatus("ok", `purged ${ok} evicted sessions`);
		}
	} catch (e) {
		setStatus("warn", `purge-evicted failed: ${e.message}`);
	} finally {
		state.inFlight.delete("purge-evicted");
		renderAll();
	}
}

function schedulePolling() {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = null;
	}
	if (state.refreshMs > 0) {
		state.timer = setInterval(poll, state.refreshMs);
	}
	updateStaleIndicator();
}

/**
 * Show "paused" next to the status when the operator has set refresh
 * to off. Without this, the charts silently freeze and there's no cue
 * that you're looking at stale data.
 */
function updateStaleIndicator() {
	const ind = document.getElementById("staleIndicator");
	if (!ind) return;
	ind.classList.toggle("hidden", state.refreshMs !== 0);
}

// Wire up event handlers (idempotent — script runs once).
loadVisibility();
loadDismissedSuggestions();

const refreshSelect = document.getElementById("refreshSelect");
if (refreshSelect) {
	refreshSelect.addEventListener("change", (e) => {
		state.refreshMs = Number(e.target.value);
		schedulePolling();
	});
}
const enabledBtn = document.getElementById("enabledToggle");
if (enabledBtn)
	enabledBtn.addEventListener("click", () =>
		toggleEndpoint("passthrough", "passthrough"),
	);
const baselineBannerToggleBtn = document.getElementById("baselineBannerToggle");
if (baselineBannerToggleBtn)
	baselineBannerToggleBtn.addEventListener("click", () =>
		toggleEndpoint("passthrough", "passthrough"),
	);
const keepAliveBtn = document.getElementById("keepAliveToggle");
if (keepAliveBtn)
	keepAliveBtn.addEventListener("click", () =>
		toggleEndpoint("keep-alive", "keep-alive"),
	);
const extendCacheTtlBtn = document.getElementById("extendCacheTtlToggle");
if (extendCacheTtlBtn)
	extendCacheTtlBtn.addEventListener("click", () =>
		toggleEndpoint("extend-cache-ttl", "extend-cache-ttl"),
	);
const stripEphBtn = document.getElementById("stripEphemeralToggle");
if (stripEphBtn)
	stripEphBtn.addEventListener("click", () =>
		toggleEndpoint("strip-ephemeral", "strip-ephemeral"),
	);
const mobileBtn = document.getElementById("mobileToggle");
if (mobileBtn)
	mobileBtn.addEventListener("click", () => toggleEndpoint("mobile", "mobile"));
const keepAliveExtendedBtn = document.getElementById("keepAliveExtendedToggle");
if (keepAliveExtendedBtn)
	keepAliveExtendedBtn.addEventListener("click", () =>
		toggleEndpoint("keep-alive-extended", "keep-alive-extended"),
	);
const autoContinueBtn = document.getElementById("autoContinueToggle");
if (autoContinueBtn)
	autoContinueBtn.addEventListener("click", () =>
		toggleEndpoint("auto-continue", "auto-continue"),
	);
const suggestionsResetBtn = document.getElementById("suggestionsResetBtn");
if (suggestionsResetBtn)
	suggestionsResetBtn.addEventListener("click", resetDismissedSuggestions);
const suggestionsAcceptAllBtn = document.getElementById(
	"suggestionsAcceptAllBtn",
);
if (suggestionsAcceptAllBtn)
	suggestionsAcceptAllBtn.addEventListener("click", applyAllSuggestions);
const suggestionsDismissAllBtn = document.getElementById(
	"suggestionsDismissAllBtn",
);
if (suggestionsDismissAllBtn)
	suggestionsDismissAllBtn.addEventListener("click", dismissAllSuggestions);
const clearBtn = document.getElementById("clearHistoryBtn");
if (clearBtn) clearBtn.addEventListener("click", clearHistory);
const purgeAllBtn = document.getElementById("purgeAllBtn");
if (purgeAllBtn) purgeAllBtn.addEventListener("click", purgeAll);
const purgeEvictedBtn = document.getElementById("purgeEvictedBtn");
if (purgeEvictedBtn) purgeEvictedBtn.addEventListener("click", purgeAllEvicted);
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
if (downloadCsvBtn)
	downloadCsvBtn.addEventListener("click", downloadSessionsCsv);
const captureBaselineBtn = document.getElementById("captureBaselineBtn");
if (captureBaselineBtn)
	captureBaselineBtn.addEventListener("click", startCaptureBaseline);
const captureShadowToggle = document.getElementById("captureShadowToggle");
if (captureShadowToggle)
	// Re-render on toggle so the warn note + button "×2" label update
	// immediately, without waiting for the next poll tick.
	captureShadowToggle.addEventListener("change", renderCaptureBaselineButton);
const helpBtn = document.getElementById("helpBtn");
if (helpBtn)
	helpBtn.addEventListener("click", () => {
		if (state.helpOverlayOpen) hideHelpOverlay();
		else showHelpOverlay();
	});
const helpCloseBtn = document.getElementById("helpCloseBtn");
if (helpCloseBtn) helpCloseBtn.addEventListener("click", hideHelpOverlay);
const helpOverlay = document.getElementById("helpOverlay");
if (helpOverlay)
	helpOverlay.addEventListener("click", (e) => {
		// Click on the scrim (not the panel) closes.
		if (e.target === helpOverlay) hideHelpOverlay();
	});

// Global keyboard shortcuts. Ignored when focus is in an editable
// element so toggles can't fire while the operator types in a session
// label or similar input box.
document.addEventListener("keydown", (e) => {
	const target = e.target;
	const isEditable =
		target instanceof HTMLElement &&
		(target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT" ||
			target.isContentEditable);
	if (isEditable) return;
	if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
		e.preventDefault();
		if (state.helpOverlayOpen) hideHelpOverlay();
		else showHelpOverlay();
		return;
	}
	if (e.key === "Escape" && state.helpOverlayOpen) {
		e.preventDefault();
		hideHelpOverlay();
		return;
	}
	if (state.helpOverlayOpen) return;
	const binding = HOTKEY_BINDINGS[e.key];
	if (!binding) return;
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	e.preventDefault();
	const [endpoint, inflightKey] = binding;
	toggleEndpoint(endpoint, inflightKey);
});

const aggregateBtn = document.getElementById("aggregateToggle");
if (aggregateBtn) {
	aggregateBtn.addEventListener("click", () => {
		state.visibility.aggregate = !state.visibility.aggregate;
		saveVisibility();
		renderAll();
	});
}
const showAllBtn = document.getElementById("showAllBtn");
if (showAllBtn) {
	showAllBtn.addEventListener("click", () => {
		state.focusedSession = null;
		for (const row of buildSessionList()) {
			state.visibility.sessions[row.key] = true;
		}
		saveVisibility();
		renderAll();
	});
}
const showNoneBtn = document.getElementById("showNoneBtn");
if (showNoneBtn) {
	showNoneBtn.addEventListener("click", () => {
		state.focusedSession = null;
		for (const row of buildSessionList()) {
			state.visibility.sessions[row.key] = false;
		}
		saveVisibility();
		renderAll();
	});
}
const clearFocusBtn = document.getElementById("clearFocusBtn");
if (clearFocusBtn) clearFocusBtn.addEventListener("click", clearFocus);

poll();
schedulePolling();
