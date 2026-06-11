import { _getRing, appendEvent, clearEvents } from "../src/events_log.js";
import { RULES, buildContext, evaluate } from "../src/suggestions.js";

void _getRing;

void _getRing;

function makeStore(sessions) {
	return {
		all: () => sessions,
	};
}

function ctx(overrides = {}) {
	const base = {
		config: {
			passthrough: false,
			keepAliveEnabled: true,
			injectExtendedCacheTtl: true,
			stripEphemeralFromSystem: true,
			keepAliveModeExtended: true,
			mobile: false,
			autoContinue: false,
			...(overrides.config ?? {}),
		},
		samples: overrides.samples ?? [],
		sessions: overrides.sessions ?? [],
		aggregateHitRate: overrides.aggregateHitRate ?? null,
		medianTtftMs: overrides.medianTtftMs ?? null,
		medianSessionLifetimeMs: overrides.medianSessionLifetimeMs ?? null,
		longestSessionLifetimeMs: overrides.longestSessionLifetimeMs ?? null,
		rateLimitHitsLast24h: overrides.rateLimitHitsLast24h ?? 0,
		ptyActive: overrides.ptyActive ?? false,
		singleTurnIdleSessionsLast24h: overrides.singleTurnIdleSessionsLast24h ?? 0,
		quotaStarvedSessions: overrides.quotaStarvedSessions ?? 0,
		lastClientTrafficMsAgo: overrides.lastClientTrafficMsAgo ?? null,
		consecutive5xxLast5min: overrides.consecutive5xxLast5min ?? 0,
		mobileToggleMsAgo: overrides.mobileToggleMsAgo ?? null,
		autoContinueFiresLast2h: overrides.autoContinueFiresLast2h ?? 0,
		maxRecentCooldownMs: overrides.maxRecentCooldownMs ?? null,
		toggleActivityLast24h: overrides.toggleActivityLast24h ?? 0,
		eventCount: overrides.eventCount ?? 0,
		latestContextPct: overrides.latestContextPct ?? null,
		latestNextPct: overrides.latestNextPct ?? null,
		medianTps: overrides.medianTps ?? null,
		history: overrides.history ?? {
			everToggledPassthrough: false,
			baselineCapturedMsAgo: null,
			baselineCaptureActive: false,
			latestBaselineHitRate: null,
		},
	};
	return base;
}

// ───── Registry integrity ─────

test("rules registry has 30 entries with stable IDs", () => {
	// Count dropped from 30 to 29 on 2026-05-27 with the removal of
	// `auto-continue-during-baseline` (replaced by passthrough's hard
	// bundle forcing autoContinue: false during baseline windows), then
	// back to 30 on 2026-06-02 with the addition of `strip-1h-tight-loop`
	// (forces the documented 5m TTL on tight loops by stripping the native
	// 1h headers Claude Code writes). See src/suggestions.js.
	expect(RULES).toHaveLength(30);
	const ids = RULES.map((r) => r.id);
	expect(new Set(ids).size).toBe(30);
	for (const r of RULES) {
		expect(typeof r.id).toBe("string");
		expect(typeof r.knob).toBe("string");
		expect(typeof r.message).toBe("string");
		// applyEndpoint is null for advisory-only rules (warn + dismiss
		// with no server action). Concrete rules must provide both an
		// endpoint string AND a body so the UI's Apply button works.
		if (r.applyEndpoint == null) {
			expect(r.applyBody).toBeNull();
		} else {
			expect(typeof r.applyEndpoint).toBe("string");
			expect(r.applyBody).toBeDefined();
		}
	}
});

test("advisory rule context-stop-before-cap has no apply target", () => {
	const rule = RULES.find((r) => r.id === "context-stop-before-cap");
	expect(rule).toBeDefined();
	expect(rule.applyEndpoint).toBeNull();
	expect(rule.applyBody).toBeNull();
	expect(rule.severity).toBe("warn");
});

test("evaluate strips trigger functions from output", () => {
	const out = evaluate(ctx({}));
	for (const r of out) {
		expect(r.trigger).toBeUndefined();
		expect(r.id).toBeDefined();
	}
});

// ───── Existing rule coverage ─────

test("rule: capture-baseline-due fires when no baseline ever captured", () => {
	const out = evaluate(
		ctx({
			samples: Array.from({ length: 60 }, (_, i) => ({ ts: i })),
			history: {
				everToggledPassthrough: false,
				baselineCapturedMsAgo: null,
				baselineCaptureActive: false,
				latestBaselineHitRate: null,
			},
		}),
	);
	expect(out.find((r) => r.id === "capture-baseline-due")).toBeDefined();
});

test("rule: capture-baseline-due fires when the last capture was > 6h ago", () => {
	const out = evaluate(
		ctx({
			history: {
				everToggledPassthrough: false,
				baselineCapturedMsAgo: 7 * 60 * 60 * 1000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.6,
			},
		}),
	);
	expect(out.find((r) => r.id === "capture-baseline-due")).toBeDefined();
});

test("rule: capture-baseline-due does NOT fire when the last capture was within 6h", () => {
	const out = evaluate(
		ctx({
			history: {
				everToggledPassthrough: false,
				baselineCapturedMsAgo: 60 * 60 * 1000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.6,
			},
		}),
	);
	expect(out.find((r) => r.id === "capture-baseline-due")).toBeUndefined();
});

test("rule: capture-baseline-due is suppressed during an active capture", () => {
	const out = evaluate(
		ctx({
			history: {
				everToggledPassthrough: false,
				baselineCapturedMsAgo: null,
				baselineCaptureActive: true,
				latestBaselineHitRate: null,
			},
		}),
	);
	expect(out.find((r) => r.id === "capture-baseline-due")).toBeUndefined();
});

test("rule: keepalive-off-multiturn fires on multi-turn idle sessions", () => {
	const out = evaluate(
		ctx({
			config: { keepAliveEnabled: false },
			sessions: [{ turns: 3, medianInterTurnGapMs: 10 * 60_000 }],
		}),
	);
	expect(out.find((r) => r.id === "keepalive-off-multiturn")).toBeDefined();
});

test("rule: keepalive-off-multiturn does NOT fire when keep-alive is on", () => {
	const out = evaluate(
		ctx({
			config: { keepAliveEnabled: true },
			sessions: [{ turns: 3, medianInterTurnGapMs: 10 * 60_000 }],
		}),
	);
	expect(out.find((r) => r.id === "keepalive-off-multiturn")).toBeUndefined();
});

test("rule: ttl-1h-long-sessions fires for sessions over 15min", () => {
	const out = evaluate(
		ctx({
			config: { injectExtendedCacheTtl: false },
			medianSessionLifetimeMs: 20 * 60_000,
		}),
	);
	expect(out.find((r) => r.id === "ttl-1h-long-sessions")).toBeDefined();
});

test("rule: strip-1h-tight-loop fires on a fast multi-turn loop", () => {
	const out = evaluate(
		ctx({
			config: { stripExtendedCacheTtl: false },
			// 5 turns at a 20s median gap — reads land well inside the 5m
			// window, so the native 1h write premium is pure waste.
			sessions: [{ turns: 5, medianInterTurnGapMs: 20_000 }],
		}),
	);
	const rule = out.find((r) => r.id === "strip-1h-tight-loop");
	expect(rule).toBeDefined();
	expect(rule.proposedConfig).toEqual({
		stripExtendedCacheTtl: true,
		keepAliveModeExtended: false,
	});
	expect(rule.applyEndpoint).toBe("tight-loop");
});

test("rule: strip-1h-tight-loop does NOT fire once strip is already on", () => {
	// Non-self-defeating: the apply sets stripExtendedCacheTtl true, and
	// the trigger guards on it being false, so the card retires after one
	// click instead of re-firing on the same loop it just fixed.
	const out = evaluate(
		ctx({
			config: { stripExtendedCacheTtl: true },
			sessions: [{ turns: 5, medianInterTurnGapMs: 20_000 }],
		}),
	);
	expect(out.find((r) => r.id === "strip-1h-tight-loop")).toBeUndefined();
});

test("rule: strip-1h-tight-loop does NOT fire on slow-gap sessions", () => {
	// A 10-min median gap crosses the 5m cliff — this is 1h's turf, not a
	// tight loop. Stripping to 5m here would force cache-creation cost.
	const out = evaluate(
		ctx({
			config: { stripExtendedCacheTtl: false },
			sessions: [{ turns: 8, medianInterTurnGapMs: 10 * 60_000 }],
		}),
	);
	expect(out.find((r) => r.id === "strip-1h-tight-loop")).toBeUndefined();
});

test("rule: strip-1h-tight-loop does NOT fire below the turn floor", () => {
	// A 2-turn session is too short to call a loop; the turn floor also
	// guards against medianInterTurnGap's 0 default reading as "tight".
	const out = evaluate(
		ctx({
			config: { stripExtendedCacheTtl: false },
			sessions: [{ turns: 2, medianInterTurnGapMs: 20_000 }],
		}),
	);
	expect(out.find((r) => r.id === "strip-1h-tight-loop")).toBeUndefined();
});

test("rule: extended-cadence-with-1h fires when 1h TTL on but cadence default", () => {
	const out = evaluate(ctx({ config: { keepAliveModeExtended: false } }));
	expect(out.find((r) => r.id === "extended-cadence-with-1h")).toBeDefined();
});

test("rule: extended-cadence-with-1h does NOT fire when 1h TTL is off", () => {
	const out = evaluate(
		ctx({
			config: { injectExtendedCacheTtl: false, keepAliveModeExtended: false },
		}),
	);
	expect(out.find((r) => r.id === "extended-cadence-with-1h")).toBeUndefined();
});

test("rule: strip-ephemeral-low-hit fires when hit rate < 50%", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: false },
			aggregateHitRate: 0.3,
		}),
	);
	expect(out.find((r) => r.id === "strip-ephemeral-low-hit")).toBeDefined();
});

test("rule: strip-ephemeral-low-hit does NOT fire when hit rate high", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: false },
			aggregateHitRate: 0.8,
		}),
	);
	expect(out.find((r) => r.id === "strip-ephemeral-low-hit")).toBeUndefined();
});

test("rule: mobile-slow-ttft fires when median TTFT > 2s", () => {
	const out = evaluate(ctx({ medianTtftMs: 3500 }));
	expect(out.find((r) => r.id === "mobile-slow-ttft")).toBeDefined();
});

test("rule: auto-continue-hit-wall fires when rate-limit hit + PTY active", () => {
	const out = evaluate(ctx({ rateLimitHitsLast24h: 2, ptyActive: true }));
	expect(out.find((r) => r.id === "auto-continue-hit-wall")).toBeDefined();
});

test("rule: auto-continue-hit-wall does NOT fire without PTY", () => {
	const out = evaluate(ctx({ rateLimitHitsLast24h: 2, ptyActive: false }));
	expect(out.find((r) => r.id === "auto-continue-hit-wall")).toBeUndefined();
});

// ───── New: regression-vs-baseline (P) ─────

test("rule: regression-vs-baseline fires when hit rate dropped >20pp from baseline with no toggle activity", () => {
	const out = evaluate(
		ctx({
			aggregateHitRate: 0.4,
			toggleActivityLast24h: 0,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 8 * 60 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.7,
			},
		}),
	);
	expect(out.find((r) => r.id === "regression-vs-baseline")).toBeDefined();
});

test("rule: regression-vs-baseline does NOT fire when toggles changed in 24h", () => {
	const out = evaluate(
		ctx({
			aggregateHitRate: 0.4,
			toggleActivityLast24h: 1,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 8 * 60 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.7,
			},
		}),
	);
	expect(out.find((r) => r.id === "regression-vs-baseline")).toBeUndefined();
});

// ───── New: keepalive-single-turn-waste (K, off-direction) ─────

test("rule: keepalive-single-turn-waste fires when many single-turn idle sessions", () => {
	const out = evaluate(
		ctx({
			config: { keepAliveEnabled: true },
			singleTurnIdleSessionsLast24h: 5,
		}),
	);
	expect(out.find((r) => r.id === "keepalive-single-turn-waste")).toBeDefined();
});

test("rule: keepalive-single-turn-waste does NOT fire when keep-alive off", () => {
	const out = evaluate(
		ctx({
			config: { keepAliveEnabled: false },
			singleTurnIdleSessionsLast24h: 5,
		}),
	);
	expect(
		out.find((r) => r.id === "keepalive-single-turn-waste"),
	).toBeUndefined();
});

// ───── New: keepalive-quota-starvation (K, off-direction) ─────

test("rule: keepalive-quota-starvation fires when a session is quota-starved", () => {
	const out = evaluate(
		ctx({
			config: { keepAliveEnabled: true },
			quotaStarvedSessions: 1,
		}),
	);
	expect(out.find((r) => r.id === "keepalive-quota-starvation")).toBeDefined();
});

test("rule: keepalive-quota-starvation does NOT fire when no starved sessions", () => {
	const out = evaluate(
		ctx({
			config: { keepAliveEnabled: true },
			quotaStarvedSessions: 0,
		}),
	);
	expect(
		out.find((r) => r.id === "keepalive-quota-starvation"),
	).toBeUndefined();
});

// ───── New: ttl-1h-short-sessions-waste (T, off-direction) ─────

test("rule: ttl-1h-short-sessions-waste fires for short median + no long sessions", () => {
	const out = evaluate(
		ctx({
			config: { injectExtendedCacheTtl: true },
			medianSessionLifetimeMs: 2 * 60_000,
			longestSessionLifetimeMs: 10 * 60_000,
		}),
	);
	expect(out.find((r) => r.id === "ttl-1h-short-sessions-waste")).toBeDefined();
});

test("rule: ttl-1h-short-sessions-waste does NOT fire when any session is long", () => {
	const out = evaluate(
		ctx({
			config: { injectExtendedCacheTtl: true },
			medianSessionLifetimeMs: 2 * 60_000,
			longestSessionLifetimeMs: 20 * 60_000,
		}),
	);
	expect(
		out.find((r) => r.id === "ttl-1h-short-sessions-waste"),
	).toBeUndefined();
});

// ───── New: strip-ephemeral-still-low (S, diagnostic) ─────

test("rule: strip-ephemeral-still-low fires when S on and hit rate still <40%", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: true },
			aggregateHitRate: 0.3,
		}),
	);
	expect(out.find((r) => r.id === "strip-ephemeral-still-low")).toBeDefined();
});

test("rule: strip-ephemeral-still-low does NOT fire when S off", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: false },
			aggregateHitRate: 0.3,
		}),
	);
	expect(out.find((r) => r.id === "strip-ephemeral-still-low")).toBeUndefined();
});

// ───── New: mobile-on-fast-net (M, off-direction) ─────

test("rule: mobile-on-fast-net fires when M on, TTFT fast, and toggle is stale", () => {
	const out = evaluate(
		ctx({
			config: { mobile: true },
			medianTtftMs: 200,
			mobileToggleMsAgo: 2 * 60 * 60_000,
		}),
	);
	expect(out.find((r) => r.id === "mobile-on-fast-net")).toBeDefined();
});

test("rule: mobile-on-fast-net does NOT fire when mobile was just toggled", () => {
	const out = evaluate(
		ctx({
			config: { mobile: true },
			medianTtftMs: 200,
			mobileToggleMsAgo: 5 * 60_000,
		}),
	);
	expect(out.find((r) => r.id === "mobile-on-fast-net")).toBeUndefined();
});

// ───── New: extended-misconfig-no-ttl (E, safety) ─────

test("rule: extended-misconfig-no-ttl fires when E on but T off", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveModeExtended: true,
				injectExtendedCacheTtl: false,
			},
		}),
	);
	expect(out.find((r) => r.id === "extended-misconfig-no-ttl")).toBeDefined();
});

test("rule: extended-misconfig-no-ttl does NOT fire when both on", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveModeExtended: true,
				injectExtendedCacheTtl: true,
			},
		}),
	);
	expect(out.find((r) => r.id === "extended-misconfig-no-ttl")).toBeUndefined();
});

// ───── New: auto-continue-no-pty (A, diagnostic) ─────

test("rule: auto-continue-no-pty fires when A on but no PTY attached and walls hit", () => {
	const out = evaluate(
		ctx({
			config: { autoContinue: true },
			ptyActive: false,
			rateLimitHitsLast24h: 2,
		}),
	);
	expect(out.find((r) => r.id === "auto-continue-no-pty")).toBeDefined();
});

test("rule: auto-continue-no-pty does NOT fire when PTY active", () => {
	const out = evaluate(
		ctx({
			config: { autoContinue: true },
			ptyActive: true,
			rateLimitHitsLast24h: 2,
		}),
	);
	expect(out.find((r) => r.id === "auto-continue-no-pty")).toBeUndefined();
});

// ───── New: stack-cold-suggest-all (K+T+E bundle) ─────

test("rule: stack-cold-suggest-all fires on long sessions with all three knobs off", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveEnabled: false,
				injectExtendedCacheTtl: false,
				keepAliveModeExtended: false,
			},
			longestSessionLifetimeMs: 45 * 60_000,
			toggleActivityLast24h: 0,
		}),
	);
	expect(out.find((r) => r.id === "stack-cold-suggest-all")).toBeDefined();
});

test("rule: stack-cold-suggest-all does NOT fire when operator has been toggling", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveEnabled: false,
				injectExtendedCacheTtl: false,
				keepAliveModeExtended: false,
			},
			longestSessionLifetimeMs: 45 * 60_000,
			toggleActivityLast24h: 2,
		}),
	);
	expect(out.find((r) => r.id === "stack-cold-suggest-all")).toBeUndefined();
});

// ───── New: stack-partial-completion ─────

test("rule: stack-partial-completion fires when K+E on but T off", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveEnabled: true,
				injectExtendedCacheTtl: false,
				keepAliveModeExtended: true,
			},
		}),
	);
	expect(out.find((r) => r.id === "stack-partial-completion")).toBeDefined();
});

test("rule: stack-partial-completion suppressed when extended-cadence-with-1h owns it", () => {
	// T-on E-off → extended-cadence-with-1h's special case.
	const out = evaluate(
		ctx({
			config: {
				keepAliveEnabled: true,
				injectExtendedCacheTtl: true,
				keepAliveModeExtended: false,
			},
		}),
	);
	expect(out.find((r) => r.id === "stack-partial-completion")).toBeUndefined();
	expect(out.find((r) => r.id === "extended-cadence-with-1h")).toBeDefined();
});

// ───── New: stack-not-helping ─────

test("rule: stack-not-helping fires when full stack barely beats baseline", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveEnabled: true,
				injectExtendedCacheTtl: true,
				keepAliveModeExtended: true,
			},
			aggregateHitRate: 0.62,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 2 * 60 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.6,
			},
		}),
	);
	expect(out.find((r) => r.id === "stack-not-helping")).toBeDefined();
});

test("rule: stack-not-helping does NOT fire when stack adds meaningful lift", () => {
	const out = evaluate(
		ctx({
			config: {
				keepAliveEnabled: true,
				injectExtendedCacheTtl: true,
				keepAliveModeExtended: true,
			},
			aggregateHitRate: 0.85,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 2 * 60 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.6,
			},
		}),
	);
	expect(out.find((r) => r.id === "stack-not-helping")).toBeUndefined();
});

// ───── New: post-baseline-enable-s / -skip-s ─────

test("rule: post-baseline-enable-s fires within 30min of a low-rate baseline", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: false },
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 5 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.3,
			},
		}),
	);
	expect(out.find((r) => r.id === "post-baseline-enable-s")).toBeDefined();
	expect(out.find((r) => r.id === "post-baseline-skip-s")).toBeUndefined();
});

test("rule: post-baseline-skip-s fires within 30min of a high-rate baseline", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: false },
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 5 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.85,
			},
		}),
	);
	expect(out.find((r) => r.id === "post-baseline-skip-s")).toBeDefined();
	expect(out.find((r) => r.id === "post-baseline-enable-s")).toBeUndefined();
});

test("rule: post-baseline-* do NOT fire once 30min window has passed", () => {
	const out = evaluate(
		ctx({
			config: { stripEphemeralFromSystem: false },
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 45 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.3,
			},
		}),
	);
	expect(out.find((r) => r.id === "post-baseline-enable-s")).toBeUndefined();
	expect(out.find((r) => r.id === "post-baseline-skip-s")).toBeUndefined();
});

// ───── New: baseline-no-traffic ─────

test("rule: baseline-no-traffic fires during an active capture with no traffic", () => {
	const out = evaluate(
		ctx({
			lastClientTrafficMsAgo: 20 * 60_000,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: null,
				baselineCaptureActive: true,
				latestBaselineHitRate: null,
			},
		}),
	);
	expect(out.find((r) => r.id === "baseline-no-traffic")).toBeDefined();
});

test("rule: baseline-no-traffic does NOT fire when traffic is flowing", () => {
	const out = evaluate(
		ctx({
			lastClientTrafficMsAgo: 30_000,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: null,
				baselineCaptureActive: true,
				latestBaselineHitRate: null,
			},
		}),
	);
	expect(out.find((r) => r.id === "baseline-no-traffic")).toBeUndefined();
});

// ───── New: K+A combinations ─────

test("rule: auto-continue-without-keepalive fires when A on, K off, recent cooldown", () => {
	const out = evaluate(
		ctx({
			config: { autoContinue: true, keepAliveEnabled: false },
			autoContinueFiresLast2h: 1,
		}),
	);
	expect(
		out.find((r) => r.id === "auto-continue-without-keepalive"),
	).toBeDefined();
});

test("rule: cooldown-longer-than-5m-cache fires on hour-plus cooldowns", () => {
	const out = evaluate(
		ctx({
			config: {
				autoContinue: true,
				keepAliveEnabled: true,
				injectExtendedCacheTtl: false,
			},
			maxRecentCooldownMs: 90 * 60_000,
		}),
	);
	expect(
		out.find((r) => r.id === "cooldown-longer-than-5m-cache"),
	).toBeDefined();
});

// The `auto-continue-during-baseline` rule was removed 2026-05-27.
// Applying it (POST /_proxy/auto-continue {off}) during the baseline
// window was itself a toggle event that polluted the measurement.
// Replaced by extending the passthrough hard bundle to force
// `autoContinue: false` in loadConfig + applyPassthrough — see
// src/config.js + src/admin.js — and by adding the 409 guard on the
// /_proxy/auto-continue endpoint while passthrough is on. The state
// is correct by construction; no rule needed.
test("dropped rule: auto-continue-during-baseline no longer exists", () => {
	const out = evaluate(
		ctx({
			config: { autoContinue: true },
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: null,
				baselineCaptureActive: true,
				latestBaselineHitRate: null,
			},
		}),
	);
	expect(
		out.find((r) => r.id === "auto-continue-during-baseline"),
	).toBeUndefined();
});

// ───── New: P-as-diagnostic ─────

test("rule: upstream-failure-isolate fires after multiple 5xxs in 5min", () => {
	const out = evaluate(ctx({ consecutive5xxLast5min: 4 }));
	expect(out.find((r) => r.id === "upstream-failure-isolate")).toBeDefined();
});

test("rule: upstream-failure-isolate does NOT fire below threshold", () => {
	const out = evaluate(ctx({ consecutive5xxLast5min: 2 }));
	expect(out.find((r) => r.id === "upstream-failure-isolate")).toBeUndefined();
});

test("rule: engine-silent fires when proxy is idle and quietly tuned", () => {
	const out = evaluate(
		ctx({
			eventCount: 50,
			toggleActivityLast24h: 0,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 60 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.7,
			},
		}),
	);
	expect(out.find((r) => r.id === "engine-silent")).toBeDefined();
});

test("rule: engine-silent does NOT fire on fresh proxies with few events", () => {
	const out = evaluate(
		ctx({
			eventCount: 2,
			toggleActivityLast24h: 0,
			history: {
				everToggledPassthrough: true,
				baselineCapturedMsAgo: 60 * 60_000,
				baselineCaptureActive: false,
				latestBaselineHitRate: 0.7,
			},
		}),
	);
	expect(out.find((r) => r.id === "engine-silent")).toBeUndefined();
});

// ───── buildContext aggregation ─────

// ───── New: context-near-limit-compact ─────

test("rule: context-near-limit-compact fires above 85% with PTY active", () => {
	const out = evaluate(
		ctx({
			latestContextPct: 88,
			ptyActive: true,
		}),
	);
	expect(out.find((r) => r.id === "context-near-limit-compact")).toBeDefined();
});

test("rule: context-near-limit-compact does NOT fire without a PTY", () => {
	const out = evaluate(
		ctx({
			latestContextPct: 88,
			ptyActive: false,
		}),
	);
	expect(
		out.find((r) => r.id === "context-near-limit-compact"),
	).toBeUndefined();
});

test("rule: context-near-limit-compact yields to context-stop above 92%", () => {
	const out = evaluate(
		ctx({
			latestContextPct: 95,
			latestNextPct: 80,
			ptyActive: true,
		}),
	);
	expect(
		out.find((r) => r.id === "context-near-limit-compact"),
	).toBeUndefined();
	expect(out.find((r) => r.id === "context-stop-before-cap")).toBeDefined();
});

// ───── New: context-stop-before-cap ─────

test("rule: context-stop-before-cap fires when context+quota both near walls", () => {
	const out = evaluate(
		ctx({
			latestContextPct: 95,
			latestNextPct: 88,
			ptyActive: true,
		}),
	);
	expect(out.find((r) => r.id === "context-stop-before-cap")).toBeDefined();
});

test("rule: context-stop-before-cap does NOT fire on context alone if quota is healthy", () => {
	const out = evaluate(
		ctx({
			latestContextPct: 95,
			latestNextPct: 30,
			ptyActive: true,
		}),
	);
	expect(out.find((r) => r.id === "context-stop-before-cap")).toBeUndefined();
});

// ───── New: mobile-low-tps-non-streaming ─────

test("rule: mobile-low-tps-non-streaming fires on M on + low TPS + reasonable TTFT", () => {
	const out = evaluate(
		ctx({
			config: { mobile: true },
			medianTps: 18,
			medianTtftMs: 600,
		}),
	);
	expect(
		out.find((r) => r.id === "mobile-low-tps-non-streaming"),
	).toBeDefined();
});

test("rule: mobile-low-tps-non-streaming does NOT fire when TTFT is also slow", () => {
	const out = evaluate(
		ctx({
			config: { mobile: true },
			medianTps: 18,
			medianTtftMs: 3500,
		}),
	);
	expect(
		out.find((r) => r.id === "mobile-low-tps-non-streaming"),
	).toBeUndefined();
});

test("rule: mobile-low-tps-non-streaming does NOT fire when mobile is off", () => {
	const out = evaluate(
		ctx({
			config: { mobile: false },
			medianTps: 18,
			medianTtftMs: 600,
		}),
	);
	expect(
		out.find((r) => r.id === "mobile-low-tps-non-streaming"),
	).toBeUndefined();
});

// ───── buildContext: sample-derived signals ─────

test("buildContext: latestContextPct picks most recent finite context from window", () => {
	const now = Date.parse("2026-05-18T12:00:00Z");
	const samples = [
		{ ts: "2026-05-18T11:58:00Z", context: 70 },
		{ ts: "2026-05-18T11:59:00Z", context: 75 },
		{ ts: "2026-05-18T11:59:30Z", context: null },
	];
	const c = buildContext({
		config: {},
		store: makeStore([]),
		samples,
		now,
	});
	expect(c.latestContextPct).toBe(75);
});

test("buildContext: latestContextPct ignores samples outside the 5min window", () => {
	const now = Date.parse("2026-05-18T12:00:00Z");
	const samples = [
		// 10 min old → excluded
		{ ts: "2026-05-18T11:50:00Z", context: 90 },
	];
	const c = buildContext({
		config: {},
		store: makeStore([]),
		samples,
		now,
	});
	expect(c.latestContextPct).toBe(null);
});

test("buildContext: medianTps from recent samples", () => {
	const now = Date.parse("2026-05-18T12:00:00Z");
	const samples = [
		{ ts: "2026-05-18T11:58:00Z", tps: 20 },
		{ ts: "2026-05-18T11:59:00Z", tps: 40 },
		{ ts: "2026-05-18T11:59:30Z", tps: 60 },
	];
	const c = buildContext({
		config: {},
		store: makeStore([]),
		samples,
		now,
	});
	expect(c.medianTps).toBe(40);
});

test("buildContext: aggregateHitRate weighted across sessions", () => {
	const store = makeStore([
		{ cacheReadTokens: 100, cacheCreationTokens: 50, cacheMissTokens: 50 },
		{ cacheReadTokens: 200, cacheCreationTokens: 100, cacheMissTokens: 100 },
	]);
	const c = buildContext({ config: {}, store, samples: [] });
	expect(c.aggregateHitRate).toBeCloseTo(300 / 600, 5);
});

test("buildContext: medianTtftMs from session recentTtftMs rings", () => {
	const store = makeStore([
		{ recentTtftMs: [100, 200, 300] },
		{ recentTtftMs: [1000, 2000] },
	]);
	const c = buildContext({ config: {}, store });
	expect(c.medianTtftMs).toBe(300);
});

test("buildContext: longestSessionLifetimeMs picks the largest lifetime", () => {
	const now = Date.parse("2026-05-17T12:00:00Z");
	const store = makeStore([
		{
			createdAt: "2026-05-17T11:55:00Z",
			lastActivity: "2026-05-17T11:58:00Z",
		},
		{
			createdAt: "2026-05-17T10:00:00Z",
			lastActivity: "2026-05-17T11:00:00Z",
		},
	]);
	const c = buildContext({ config: {}, store, now });
	expect(c.longestSessionLifetimeMs).toBe(60 * 60_000);
});

test("buildContext: lastClientTrafficMsAgo reflects most recent activity", () => {
	const now = Date.parse("2026-05-17T12:00:00Z");
	const store = makeStore([
		{ lastActivity: "2026-05-17T11:50:00Z" },
		{ lastActivity: "2026-05-17T11:30:00Z" },
	]);
	const c = buildContext({ config: {}, store, now });
	expect(c.lastClientTrafficMsAgo).toBe(10 * 60_000);
});

test("buildContext: singleTurnIdleSessionsLast24h counts idled-past-targetTtl singletons", () => {
	const now = Date.parse("2026-05-17T12:00:00Z");
	const store = makeStore([
		// idled past targetTtl, 1 turn → counts
		{
			recentTtftMs: [200],
			lastActivity: "2026-05-17T10:00:00Z",
			targetTtl: "2026-05-17T10:30:00Z",
		},
		// multi-turn → doesn't count
		{
			recentTtftMs: [200, 300, 400],
			lastActivity: "2026-05-17T10:00:00Z",
			targetTtl: "2026-05-17T10:30:00Z",
		},
		// still within targetTtl → doesn't count
		{
			recentTtftMs: [200],
			lastActivity: "2026-05-17T11:59:00Z",
			targetTtl: "2026-05-17T13:00:00Z",
		},
	]);
	const c = buildContext({ config: {}, store, now });
	expect(c.singleTurnIdleSessionsLast24h).toBe(1);
});

test("buildContext: quotaStarvedSessions counts low-remaining + far-reset sessions", () => {
	const now = Date.parse("2026-05-17T12:00:00Z");
	const store = makeStore([
		// 5% of limit, reset in 60min → starved
		{
			lastRateLimit: { tokens_remaining: 500, tokens_limit: 10000 },
			targetTtl: "2026-05-17T13:00:00Z",
		},
		// 50% of limit → not starved
		{
			lastRateLimit: { tokens_remaining: 5000, tokens_limit: 10000 },
			targetTtl: "2026-05-17T13:00:00Z",
		},
		// 5% but reset is 10min away → horizon too close
		{
			lastRateLimit: { tokens_remaining: 500, tokens_limit: 10000 },
			targetTtl: "2026-05-17T12:10:00Z",
		},
	]);
	const c = buildContext({ config: {}, store, now });
	expect(c.quotaStarvedSessions).toBe(1);
});

test("buildContext: consecutive5xxLast5min counts upstream-5xx events", () => {
	clearEvents();
	appendEvent({ type: "upstream-5xx", text: "503" });
	appendEvent({ type: "upstream-5xx", text: "502" });
	appendEvent({ type: "upstream-5xx", text: "500" });
	appendEvent({ type: "rate-limit-hit", text: "429" });
	const c = buildContext({ config: {}, store: makeStore([]) });
	expect(c.consecutive5xxLast5min).toBe(3);
	clearEvents();
});

test("buildContext: latestBaselineHitRate threaded from event meta", () => {
	clearEvents();
	appendEvent({
		type: "baseline-captured",
		text: "baseline captured",
		meta: { hitRate: 0.42 },
	});
	const c = buildContext({ config: {}, store: makeStore([]) });
	expect(c.history.latestBaselineHitRate).toBeCloseTo(0.42, 5);
	clearEvents();
});

test("buildContext: maxRecentCooldownMs picks max from auto-continue-fire meta", () => {
	clearEvents();
	appendEvent({
		type: "auto-continue-fire",
		text: "fire",
		meta: { cooldownMs: 90 * 60_000 },
	});
	appendEvent({
		type: "auto-continue-fire",
		text: "fire",
		meta: { cooldownMs: 30 * 60_000 },
	});
	const c = buildContext({ config: {}, store: makeStore([]) });
	expect(c.maxRecentCooldownMs).toBe(90 * 60_000);
	expect(c.autoContinueFiresLast2h).toBe(2);
	clearEvents();
});

test("buildContext: toggleActivityLast24h counts only toggle events", () => {
	clearEvents();
	appendEvent({ type: "keep-alive-toggle", text: "on" });
	appendEvent({ type: "mobile-toggle", text: "on" });
	appendEvent({ type: "auth-stale", text: "401" });
	const c = buildContext({ config: {}, store: makeStore([]) });
	expect(c.toggleActivityLast24h).toBe(2);
	clearEvents();
});
