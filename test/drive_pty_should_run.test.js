import {
	formatProgress,
	idleWithKeepAlive,
	shouldRunTurn,
} from "../benchmark/bin/drive_pty.js";

// shouldRunTurn is the PTY driver's loop predicate, extracted so the
// termination logic is testable without spawning a real `claude` PTY. A run
// ends on ANY of: claude exited, the turn budget is spent, or the wall-clock
// deadline (--max-sec) passed. The deadline lets us drive a "run for N minutes"
// load while --turns acts only as an upper safety bound.

describe("shouldRunTurn", () => {
	test("count-driven (no deadline): runs while index < turns, stops at the budget", () => {
		const args = { exited: false, runDeadline: null };
		expect(shouldRunTurn({ ...args, index: 0, turns: 3 })).toBe(true);
		expect(shouldRunTurn({ ...args, index: 2, turns: 3 })).toBe(true);
		// index === turns is the off-by-one boundary: the budget is spent.
		expect(shouldRunTurn({ ...args, index: 3, turns: 3 })).toBe(false);
		expect(shouldRunTurn({ ...args, index: 4, turns: 3 })).toBe(false);
	});

	test("exited short-circuits regardless of budget or deadline", () => {
		expect(
			shouldRunTurn({
				index: 0,
				turns: 100,
				exited: true,
				runDeadline: Date.now() + 1_000_000,
			}),
		).toBe(false);
	});

	test("deadline stops the run even when the turn budget is not spent", () => {
		const now = 1_000_000;
		// turns is a huge safety bound (the --max-sec usage); the deadline governs.
		expect(
			shouldRunTurn({
				index: 5,
				turns: 9999,
				exited: false,
				runDeadline: now + 1,
				now,
			}),
		).toBe(true);
		// At the deadline (now >= runDeadline) the run ends.
		expect(
			shouldRunTurn({
				index: 5,
				turns: 9999,
				exited: false,
				runDeadline: now,
				now,
			}),
		).toBe(false);
		expect(
			shouldRunTurn({
				index: 5,
				turns: 9999,
				exited: false,
				runDeadline: now - 1,
				now,
			}),
		).toBe(false);
	});

	test("turn budget still bounds the run even with a far-future deadline", () => {
		const now = 1_000_000;
		expect(
			shouldRunTurn({
				index: 3,
				turns: 3,
				exited: false,
				runDeadline: now + 1_000_000,
				now,
			}),
		).toBe(false);
	});
});

// formatProgress builds the per-turn "where are we" line. Count-driven runs
// derive % from the (1-based) turn number over the budget; --max-sec runs
// derive it from wall-clock elapsed over the deadline, because there the turn
// budget is only a safety bound.
describe("formatProgress", () => {
	test("count-driven: percent and bar track turn number over budget", () => {
		const startMs = 1_000_000;
		// index 2 (0-based) → turn 3 of 10 → 30%.
		const line = formatProgress({
			index: 2,
			turns: 10,
			startMs,
			now: startMs + 80_000,
			runDeadline: null,
			maxSec: null,
		});
		expect(line).toBe("turn 3/10 · 30% [###-------] · 1m20s elapsed");
	});

	test("count-driven: the final turn reads as 100% and a full bar", () => {
		const startMs = 0;
		const line = formatProgress({
			index: 9,
			turns: 10,
			startMs,
			now: 5_000,
			runDeadline: null,
			maxSec: null,
		});
		expect(line).toBe("turn 10/10 · 100% [##########] · 5s elapsed");
	});

	test("--max-sec: percent is wall-clock based, turn shown without the safety bound", () => {
		const startMs = 0;
		// 12 min into a 75-min cap → 16%, regardless of the huge turn budget.
		const line = formatProgress({
			index: 11,
			turns: 9999,
			startMs,
			now: 12 * 60_000,
			runDeadline: startMs + 4500_000,
			maxSec: 4500,
		});
		expect(line).toBe("turn 12 · 16% [##--------] · 12m00s/75m00s elapsed");
	});

	test("fraction is clamped to [0,1] so a deadline overrun never overflows the bar", () => {
		const startMs = 0;
		const line = formatProgress({
			index: 50,
			turns: 9999,
			startMs,
			now: 99 * 60_000, // past the cap
			runDeadline: startMs + 60 * 60_000,
			maxSec: 3600,
		});
		expect(line).toContain("100%");
		expect(line).toContain("[##########]");
	});
});

// idleWithKeepAlive drives the inter-turn idle and (optionally) fires a PTY
// keep-alive ping every intervalMs. It's dependency-injected (sleep/now/sendPing)
// so the cadence is verifiable on a fake clock with zero real wall time — we
// assert ping COUNT and exact TIMING, plus the "never overrun the gap" invariant.
describe("idleWithKeepAlive", () => {
	// Fake-clock harness: sleep advances virtual time; sendPing records the
	// instant it fired and advances the clock by pingCostMs (to model a ping that
	// itself consumes wall time). Lets us assert ping count + timing exactly.
	function harness({ pingCostMs = 0 } = {}) {
		let clock = 0;
		const pingTimes = [];
		const sleepFn = (ms) => {
			clock += Math.max(0, ms);
			return Promise.resolve();
		};
		const now = () => clock;
		const sendPing = () => {
			pingTimes.push(clock);
			clock += pingCostMs;
			return Promise.resolve();
		};
		return { sleepFn, now, sendPing, pingTimes };
	}

	test("fires a ping every intervalMs, never AT/after the deadline", async () => {
		const h = harness();
		const pings = await idleWithKeepAlive({
			gapMs: 900_000,
			intervalMs: 300_000,
			sendPing: h.sendPing,
			sleep: h.sleepFn,
			now: h.now,
		});
		// 900k / 300k → pings at 300k and 600k; the 900k boundary is the deadline
		// (we never ping at the end — the next real turn re-warms anyway).
		expect(pings).toBe(2);
		expect(h.pingTimes).toEqual([300_000, 600_000]);
	});

	test("intervalMs <= 0 disables keep-alive: one plain sleep, zero pings", async () => {
		const h = harness();
		const pings = await idleWithKeepAlive({
			gapMs: 500_000,
			intervalMs: 0,
			sendPing: h.sendPing,
			sleep: h.sleepFn,
			now: h.now,
		});
		expect(pings).toBe(0);
		expect(h.pingTimes).toEqual([]);
		expect(h.now()).toBe(500_000); // still slept the whole gap
	});

	test("a 90-min gap with a 15-min cadence fires 5 pings", async () => {
		const h = harness();
		const pings = await idleWithKeepAlive({
			gapMs: 90 * 60_000,
			intervalMs: 15 * 60_000,
			sendPing: h.sendPing,
			sleep: h.sleepFn,
			now: h.now,
		});
		// 15,30,45,60,75 min → 5 pings; 90 min is the deadline.
		expect(pings).toBe(5);
		expect(h.pingTimes).toEqual([
			15 * 60_000,
			30 * 60_000,
			45 * 60_000,
			60 * 60_000,
			75 * 60_000,
		]);
	});

	test("a ping's own wall cost is absorbed — it shortens the next slice, never overruns the gap", async () => {
		// Each ping costs 10s of wall time. With a 300s gap and 100s cadence a
		// naive impl would drift past the deadline; idleWithKeepAlive recomputes
		// remaining from now() each loop so the gap end is always respected.
		const h = harness({ pingCostMs: 10_000 });
		const pings = await idleWithKeepAlive({
			gapMs: 300_000,
			intervalMs: 100_000,
			sendPing: h.sendPing,
			sleep: h.sleepFn,
			now: h.now,
		});
		// t=100k ping(→110k), t=210k ping(→220k), then remaining 80k < 100k slept
		// with NO ping (lands exactly at 300k). 2 pings, never overran.
		expect(pings).toBe(2);
		expect(h.pingTimes).toEqual([100_000, 210_000]);
		expect(h.now()).toBe(300_000);
	});

	test("a gap shorter than the interval fires no ping (just sleeps the gap)", async () => {
		const h = harness();
		const pings = await idleWithKeepAlive({
			gapMs: 120_000,
			intervalMs: 300_000,
			sendPing: h.sendPing,
			sleep: h.sleepFn,
			now: h.now,
		});
		expect(pings).toBe(0);
		expect(h.pingTimes).toEqual([]);
		expect(h.now()).toBe(120_000);
	});
});
