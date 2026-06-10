import {
	completeBaselineCapture,
	startBaselineCapture,
	tickBaselineCapture,
} from "../src/admin.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("silent");

// A no-op scheduler with just the surface startBaselineCapture /
// applyPassthrough touch (start/stop). We don't assert on it here — the
// invariant under test is the config's passthrough state, not the scheduler.
function fakeScheduler() {
	return { start() {}, stop() {}, ensureScheduled() {}, cancelSession() {} };
}

// Build a config the way boot does: snapshot the operator's intervention
// intent PRE-passthrough-override (mirrors src/config.js:334), then apply the
// passthrough hard-bundle if the operator asked for passthrough (mirrors
// src/config.js:344). This reproduces exactly what a `clawback --passthrough`
// process holds in memory when the fresh-proxy baseline capture arms.
function makeConfig(overrides = {}) {
	const merged = { ...DEFAULTS, ...overrides };
	merged._baselineSnapshot = {
		injectExtendedCacheTtl: merged.injectExtendedCacheTtl,
		rewriteNestedCacheControl: merged.rewriteNestedCacheControl,
		stripEphemeralFromSystem: merged.stripEphemeralFromSystem,
		keepAliveEnabled: merged.keepAliveEnabled,
		autoContinue: merged.autoContinue,
	};
	if (merged.passthrough) {
		merged.injectExtendedCacheTtl = false;
		merged.rewriteNestedCacheControl = false;
		merged.stripEphemeralFromSystem = false;
		merged.keepAliveEnabled = false;
		merged.autoContinue = false;
	}
	return merged;
}

// Drive a baseline capture to completion by ticking targetTurns times.
function runCaptureToCompletion(config, deps) {
	const target = config._baselineCapture?.targetTurns ?? 0;
	for (let i = 0; i < target; i++) tickBaselineCapture(config, deps);
}

describe("baseline capture preserves an operator's explicit --passthrough", () => {
	// THE BUG: completeBaselineCapture flips passthrough OFF whenever
	// config.passthrough is currently true — but on a fresh proxy started with
	// --passthrough, passthrough was the OPERATOR's choice, not the capture's
	// imposition. The buggy restore turned passthrough off and re-enabled
	// 1h-TTL injection after ~5 turns (observed live: turn-log records flipped
	// arm:"passthrough"/ttl:5m -> arm:"treatment"/ttl:1h). CLAUDE.md: passthrough
	// is "not configurable away."
	test("a proxy started with passthrough STAYS passthrough after the capture window", () => {
		const config = makeConfig({ passthrough: true, baselineCaptureTurns: 3 });
		const deps = { store: null, scheduler: fakeScheduler(), logger };

		// Sanity: the hard-bundle is in effect at boot.
		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);

		startBaselineCapture(config, deps);
		expect(config._baselineCapture.active).toBe(true);
		// Still passthrough while capturing (it always was).
		expect(config.passthrough).toBe(true);

		runCaptureToCompletion(config, deps);

		// The invariant: the operator asked for passthrough, so it must remain
		// passthrough — interventions must NOT silently switch on.
		expect(config._baselineCapture.active).toBe(false);
		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);
		expect(config.rewriteNestedCacheControl).toBe(false);
		expect(config.stripEphemeralFromSystem).toBe(false);
		expect(config.keepAliveEnabled).toBe(false);
	});

	// NO REGRESSION: the normal case — operator wants interventions, the fresh
	// proxy briefly forces passthrough to measure a baseline, then restores the
	// operator's interventions. This must keep working unchanged.
	test("a proxy started in treatment mode captures a passthrough baseline, then restores interventions", () => {
		const config = makeConfig({ passthrough: false, baselineCaptureTurns: 3 });
		const deps = { store: null, scheduler: fakeScheduler(), logger };

		expect(config.passthrough).toBe(false);
		expect(config.injectExtendedCacheTtl).toBe(true);

		startBaselineCapture(config, deps);
		// Capture imposes passthrough for the measurement window.
		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);

		runCaptureToCompletion(config, deps);

		// Restored to the operator's intent (interventions back on).
		expect(config.passthrough).toBe(false);
		expect(config.injectExtendedCacheTtl).toBe(true);
		expect(config.rewriteNestedCacheControl).toBe(true);
		expect(config.stripEphemeralFromSystem).toBe(true);
		expect(config.keepAliveEnabled).toBe(true);
	});

	// The completion path is what flips the flag, so guard it directly too:
	// completing a capture that was armed while already-passthrough must be a
	// no-op for the passthrough flag.
	test("completeBaselineCapture does not disable an operator-set passthrough", () => {
		const config = makeConfig({ passthrough: true, baselineCaptureTurns: 1 });
		const deps = { store: null, scheduler: fakeScheduler(), logger };
		startBaselineCapture(config, deps);
		completeBaselineCapture(config, deps);
		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);
	});
});
