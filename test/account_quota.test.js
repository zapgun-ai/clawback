import {
	getQuotaObservation,
	overlayAccountQuota,
	recordQuotaObservation,
	resetAccountQuota,
} from "../src/account_quota.js";

// State is a process-global singleton; wipe it between tests so order can't
// leak an observation from one case into the next.
beforeEach(() => resetAccountQuota());
afterEach(() => resetAccountQuota());

describe("recordQuotaObservation / getQuotaObservation", () => {
	test("records a window's used_percentage and resets_at", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 30, resets_at: 1000 },
		});
		expect(getQuotaObservation("five_hour")).toEqual({
			resetsAt: 1000,
			pct: 30,
		});
		// The other window stays unrecorded.
		expect(getQuotaObservation("seven_day")).toBeNull();
	});

	test("tracks five_hour and seven_day independently", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 30, resets_at: 1000 },
			seven_day: { used_percentage: 70, resets_at: 5000 },
		});
		expect(getQuotaObservation("five_hour").pct).toBe(30);
		expect(getQuotaObservation("seven_day").pct).toBe(70);
	});

	test("within the same window (same resets_at) keeps the MAX used_percentage", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 60, resets_at: 1000 },
		});
		// A busier session reports a higher reading for the same window → wins.
		recordQuotaObservation({
			five_hour: { used_percentage: 82, resets_at: 1000 },
		});
		expect(getQuotaObservation("five_hour").pct).toBe(82);
		// A stale session reports a LOWER reading for the same window → ignored.
		recordQuotaObservation({
			five_hour: { used_percentage: 41, resets_at: 1000 },
		});
		expect(getQuotaObservation("five_hour").pct).toBe(82);
	});

	test("a newer resets_at supersedes, even when its used_percentage is lower", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 90, resets_at: 1000 },
		});
		// Window rolled over: new (higher) resets_at, low fresh usage. The
		// rollover must win — otherwise the bar would stick at the old 90%.
		recordQuotaObservation({
			five_hour: { used_percentage: 5, resets_at: 2000 },
		});
		expect(getQuotaObservation("five_hour")).toEqual({
			resetsAt: 2000,
			pct: 5,
		});
	});

	test("an older resets_at is ignored (a stale session reporting a past window)", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 12, resets_at: 2000 },
		});
		recordQuotaObservation({
			five_hour: { used_percentage: 88, resets_at: 1000 },
		});
		expect(getQuotaObservation("five_hour")).toEqual({
			resetsAt: 2000,
			pct: 12,
		});
	});

	test("missing resets_at on either side falls back to last-writer-wins", () => {
		// No window identity available, so we can't do the monotonic merge —
		// take the most recent report. (Older Claude Code / partial payloads.)
		recordQuotaObservation({ five_hour: { used_percentage: 70 } });
		recordQuotaObservation({ five_hour: { used_percentage: 20 } });
		expect(getQuotaObservation("five_hour").pct).toBe(20);
	});

	test("skips non-numeric / missing used_percentage and never throws on garbage", () => {
		recordQuotaObservation({ five_hour: { used_percentage: "high" } });
		recordQuotaObservation({ five_hour: { used_percentage: null } });
		recordQuotaObservation({ five_hour: {} });
		expect(getQuotaObservation("five_hour")).toBeNull();
		expect(() => recordQuotaObservation(null)).not.toThrow();
		expect(() => recordQuotaObservation("nonsense")).not.toThrow();
		expect(() => recordQuotaObservation(undefined)).not.toThrow();
		expect(getQuotaObservation("five_hour")).toBeNull();
	});

	test("a 0% reading for a fresh window is recorded (0 is a real value)", () => {
		recordQuotaObservation({ seven_day: { used_percentage: 0, resets_at: 9 } });
		expect(getQuotaObservation("seven_day")).toEqual({ resetsAt: 9, pct: 0 });
	});
});

describe("overlayAccountQuota", () => {
	test("returns the input unchanged when nothing has been recorded", () => {
		const session = { context_window: { used_percentage: 42 } };
		expect(overlayAccountQuota(session)).toBe(session);
	});

	test("overlays the recorded value onto a session that reported its own (stale) one", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 85, resets_at: 1000 },
		});
		// This idle session's payload still says 40% — the overlay lifts it to
		// the account-global 85%.
		const session = {
			context_window: { used_percentage: 10 },
			rate_limits: { five_hour: { used_percentage: 40, resets_at: 1000 } },
		};
		const out = overlayAccountQuota(session);
		expect(out.rate_limits.five_hour.used_percentage).toBe(85);
		expect(out.rate_limits.five_hour.resets_at).toBe(1000);
		// Non-quota fields pass through untouched.
		expect(out.context_window.used_percentage).toBe(10);
	});

	test("synthesizes a window block for a session that never reported it", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 55, resets_at: 1000 },
		});
		// A fresh session with no rate_limits at all still shows the account quota.
		const session = { context_window: { used_percentage: 5 } };
		const out = overlayAccountQuota(session);
		expect(out.rate_limits.five_hour.used_percentage).toBe(55);
	});

	test("does not mutate the input session", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 77, resets_at: 1000 },
		});
		const session = {
			rate_limits: { five_hour: { used_percentage: 12, resets_at: 1000 } },
		};
		const out = overlayAccountQuota(session);
		expect(out).not.toBe(session);
		expect(out.rate_limits).not.toBe(session.rate_limits);
		// Original is left exactly as the caller passed it.
		expect(session.rate_limits.five_hour.used_percentage).toBe(12);
	});

	test("preserves other rate_limits keys the session carried", () => {
		recordQuotaObservation({
			five_hour: { used_percentage: 50, resets_at: 1000 },
		});
		const session = {
			rate_limits: {
				five_hour: { used_percentage: 9, resets_at: 1000 },
				seven_day: { used_percentage: 33, resets_at: 5000 },
			},
		};
		const out = overlayAccountQuota(session);
		expect(out.rate_limits.five_hour.used_percentage).toBe(50);
		// seven_day wasn't recorded globally, so the session's own value stays.
		expect(out.rate_limits.seven_day.used_percentage).toBe(33);
	});

	test("returns non-object input unchanged", () => {
		expect(overlayAccountQuota(null)).toBeNull();
		expect(overlayAccountQuota(undefined)).toBeUndefined();
		const arr = [1, 2];
		expect(overlayAccountQuota(arr)).toBe(arr);
	});
});
