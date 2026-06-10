/**
 * Pure-function tests for the per-metric chart aggregation helpers
 * (PLAN §39 Phase 2). No DOM, no jsdom — just the math.
 */
import {
	AGGREGATE_BUCKET,
	DASH_PATTERNS,
	PALETTE,
	computeAggregateSeries,
	hashString,
	perSessionSeries,
	sessionStyle,
} from "../src/ui/aggregation.js";

function sample({ ts, sessionKey, ...metrics }) {
	return { ts, sessionKey, ...metrics };
}

test("hashString is deterministic and FNV-1a 32-bit", () => {
	const a = hashString("session-a");
	const b = hashString("session-a");
	expect(a).toBe(b);
	expect(a).toBeGreaterThanOrEqual(0);
	expect(a).toBeLessThanOrEqual(0xffffffff);
});

test("sessionStyle assigns stable color/dash to a sessionKey", () => {
	const s1 = sessionStyle("abc12345");
	const s2 = sessionStyle("abc12345");
	expect(s1).toEqual(s2);
	expect(PALETTE).toContain(s1.color);
	expect(DASH_PATTERNS).toContain(s1.dash);
	expect(s1.isLegacy).toBe(false);
});

test("sessionStyle marks _aggregate as legacy", () => {
	const s = sessionStyle(AGGREGATE_BUCKET);
	expect(s.isLegacy).toBe(true);
	expect(s.color).toBe("var(--muted)");
});

test("sessionStyle distributes across palette: at least 5 distinct colors over 50 keys", () => {
	const colors = new Set();
	for (let i = 0; i < 50; i++) {
		colors.add(sessionStyle(`s-${i.toString(16).padStart(8, "0")}`).color);
	}
	// Hashing into 10 buckets — 50 keys should hit at least half.
	expect(colors.size).toBeGreaterThanOrEqual(5);
});

test("perSessionSeries filters by sessionKey and skips nulls", () => {
	const samples = [
		sample({ ts: "2026-05-16T12:00:00.000Z", sessionKey: "A", hit: 50 }),
		sample({ ts: "2026-05-16T12:00:10.000Z", sessionKey: "B", hit: 70 }),
		sample({ ts: "2026-05-16T12:00:20.000Z", sessionKey: "A", hit: null }),
		sample({ ts: "2026-05-16T12:00:30.000Z", sessionKey: "A", hit: 60 }),
	];
	const out = perSessionSeries(samples, { key: "hit" }, "A");
	expect(out).toEqual([
		{ ts: "2026-05-16T12:00:00.000Z", value: 50 },
		{ ts: "2026-05-16T12:00:30.000Z", value: 60 },
	]);
});

test("perSessionSeries routes null sessionKey samples to _aggregate", () => {
	const samples = [sample({ ts: "2026-05-16T12:00:00.000Z", hit: 42 })];
	const out = perSessionSeries(samples, { key: "hit" }, AGGREGATE_BUCKET);
	expect(out).toEqual([{ ts: "2026-05-16T12:00:00.000Z", value: 42 }]);
});

test("computeAggregateSeries returns [] when metric has no aggregate", () => {
	const samples = [sample({ ts: "x", sessionKey: "A", turn: 50 })];
	const out = computeAggregateSeries(
		samples,
		{ key: "turn", aggregate: null },
		new Set(["A"]),
	);
	expect(out).toEqual([]);
});

test("computeAggregateSeries 'mean' averages across active sessions", () => {
	const samples = [
		sample({ ts: "t1", sessionKey: "A", tps: 40 }),
		sample({ ts: "t2", sessionKey: "B", tps: 80 }),
		sample({ ts: "t3", sessionKey: "A", tps: 60 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "tps", aggregate: "mean" },
		new Set(["A", "B"]),
	);
	expect(out).toEqual([
		{ ts: "t1", value: 40 },
		{ ts: "t2", value: 60 }, // (40 + 80) / 2
		{ ts: "t3", value: 70 }, // (60 + 80) / 2
	]);
});

test("computeAggregateSeries 'max' picks the highest across sessions", () => {
	const samples = [
		sample({ ts: "t1", sessionKey: "A", context: 30 }),
		sample({ ts: "t2", sessionKey: "B", context: 80 }),
		sample({ ts: "t3", sessionKey: "A", context: 90 }),
		sample({ ts: "t4", sessionKey: "B", context: 40 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "context", aggregate: "max" },
		new Set(["A", "B"]),
	);
	expect(out).toEqual([
		{ ts: "t1", value: 30 },
		{ ts: "t2", value: 80 },
		{ ts: "t3", value: 90 },
		{ ts: "t4", value: 90 }, // A is still at 90
	]);
});

test("computeAggregateSeries 'weighted-mean' weights by sample count per session", () => {
	const samples = [
		// A reports 4 times at hit=50; B reports once at hit=100.
		sample({ ts: "t1", sessionKey: "A", hit: 50 }),
		sample({ ts: "t2", sessionKey: "A", hit: 50 }),
		sample({ ts: "t3", sessionKey: "A", hit: 50 }),
		sample({ ts: "t4", sessionKey: "A", hit: 50 }),
		sample({ ts: "t5", sessionKey: "B", hit: 100 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "hit", aggregate: "weighted-mean" },
		new Set(["A", "B"]),
	);
	// At t5: A weight=4, B weight=1 → (50*4 + 100*1) / 5 = 300/5 = 60.
	expect(out[out.length - 1]).toEqual({ ts: "t5", value: 60 });
});

test("computeAggregateSeries skips sessions not in includedSessions filter", () => {
	const samples = [
		sample({ ts: "t1", sessionKey: "A", tps: 40 }),
		sample({ ts: "t2", sessionKey: "B", tps: 80 }),
		sample({ ts: "t3", sessionKey: "A", tps: 60 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "tps", aggregate: "mean" },
		new Set(["A"]),
	);
	expect(out).toEqual([
		{ ts: "t1", value: 40 },
		{ ts: "t3", value: 60 },
	]);
});

test("computeAggregateSeries skips non-numeric and non-finite values", () => {
	const samples = [
		sample({ ts: "t1", sessionKey: "A", tps: 40 }),
		sample({ ts: "t2", sessionKey: "A", tps: null }),
		sample({ ts: "t3", sessionKey: "A", tps: Number.POSITIVE_INFINITY }),
		sample({ ts: "t4", sessionKey: "A", tps: Number.NaN }),
		sample({ ts: "t5", sessionKey: "A", tps: 60 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "tps", aggregate: "mean" },
		new Set(["A"]),
	);
	// t2-t4 don't update A's latest, but the sample is still
	// processed and the previous A=40 is reported. At t5 → 60.
	expect(out.map((p) => p.value)).toEqual([40, 40, 40, 40, 60]);
});

test("computeAggregateSeries treats undefined sessionKey as _aggregate bucket", () => {
	const samples = [
		sample({ ts: "t1", sessionKey: undefined, tps: 50 }),
		sample({ ts: "t2", sessionKey: "B", tps: 100 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "tps", aggregate: "mean" },
		new Set([AGGREGATE_BUCKET, "B"]),
	);
	expect(out).toEqual([
		{ ts: "t1", value: 50 },
		{ ts: "t2", value: 75 },
	]);
});

test("computeAggregateSeries with null includedSessions includes everything", () => {
	const samples = [
		sample({ ts: "t1", sessionKey: "A", tps: 50 }),
		sample({ ts: "t2", sessionKey: "B", tps: 100 }),
	];
	const out = computeAggregateSeries(
		samples,
		{ key: "tps", aggregate: "mean" },
		null,
	);
	expect(out).toEqual([
		{ ts: "t1", value: 50 },
		{ ts: "t2", value: 75 },
	]);
});
