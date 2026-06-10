import {
	AGGREGATE_KEY,
	MAX_SAMPLES_PER_SESSION,
	MAX_SESSIONS,
	appendSample,
	clearSamples,
	listSamples,
	listSessionSummaries,
} from "../src/metrics_log.js";

beforeEach(() => {
	clearSamples();
});

describe("metrics_log", () => {
	test("appendSample stores entries with the expected shape and preserves insertion order", () => {
		appendSample({ source: "statusline", hit: 50 });
		appendSample({ source: "upstream", tps: 80, ttft: 250 });
		const out = listSamples();
		expect(out).toHaveLength(2);
		expect(out[0].source).toBe("statusline");
		expect(out[0].hit).toBe(50);
		expect(out[1].source).toBe("upstream");
		expect(out[1].tps).toBe(80);
		expect(out[1].ttft).toBe(250);
		// ts auto-stamped on each entry
		expect(typeof out[0].ts).toBe("string");
		expect(out[0].ts).toMatch(/T.*Z$/);
	});

	test("appendSample drops entries where every metric is null (defensive)", () => {
		// A "no observations" sample is just noise on the chart — drop
		// it so the operator only sees real data points.
		appendSample({ source: "statusline" });
		appendSample({
			source: "upstream",
			context: null,
			next: null,
			week: null,
			hit: null,
			turn: null,
			tps: null,
			ttft: null,
		});
		expect(listSamples()).toHaveLength(0);
	});

	test("appendSample rejects unknown source values (only statusline | upstream)", () => {
		appendSample({ source: "fake", hit: 50 });
		appendSample({ source: null, hit: 50 });
		expect(listSamples()).toHaveLength(0);
	});

	test("ring caps at MAX_SAMPLES_PER_SESSION with FIFO eviction", () => {
		for (let i = 0; i < MAX_SAMPLES_PER_SESSION + 25; i++) {
			appendSample({ source: "upstream", hit: i });
		}
		const out = listSamples({ limit: MAX_SAMPLES_PER_SESSION + 100 });
		expect(out).toHaveLength(MAX_SAMPLES_PER_SESSION);
		// Oldest 25 should have been evicted: first entry is hit=25.
		expect(out[0].hit).toBe(25);
		expect(out[out.length - 1].hit).toBe(MAX_SAMPLES_PER_SESSION + 24);
	});

	test("listSamples filters by since (strict-greater-than ISO timestamp)", () => {
		appendSample({
			source: "upstream",
			hit: 1,
			ts: "2026-05-11T10:00:00.000Z",
		});
		appendSample({
			source: "upstream",
			hit: 2,
			ts: "2026-05-11T10:00:05.000Z",
		});
		appendSample({
			source: "upstream",
			hit: 3,
			ts: "2026-05-11T10:00:10.000Z",
		});
		const out = listSamples({ since: "2026-05-11T10:00:05.000Z" });
		expect(out).toHaveLength(1);
		expect(out[0].hit).toBe(3);
	});

	test("listSamples ignores malformed since (treats as no filter)", () => {
		appendSample({ source: "upstream", hit: 1 });
		appendSample({ source: "upstream", hit: 2 });
		const out = listSamples({ since: "not-a-date" });
		expect(out).toHaveLength(2);
	});

	test("listSamples limits to the N most recent", () => {
		for (let i = 0; i < 10; i++) {
			appendSample({ source: "upstream", hit: i });
		}
		const out = listSamples({ limit: 3 });
		expect(out).toHaveLength(3);
		expect(out.map((s) => s.hit)).toEqual([7, 8, 9]);
	});

	test("listSamples returns defensive copies so callers can't mutate the ring", () => {
		appendSample({ source: "upstream", hit: 50 });
		const out = listSamples();
		out[0].hit = 9999;
		const again = listSamples();
		expect(again[0].hit).toBe(50);
	});

	test("clearSamples wipes the ring and returns the removed count", () => {
		appendSample({ source: "upstream", hit: 1 });
		appendSample({ source: "upstream", hit: 2 });
		expect(clearSamples()).toBe(2);
		expect(listSamples()).toHaveLength(0);
	});

	test("mode snapshot field is preserved verbatim for the UI's mode-change markers", () => {
		appendSample({
			source: "statusline",
			hit: 50,
			mode: {
				passthrough: false,
				keepAliveEnabled: true,
				stripEphemeralFromSystem: true,
			},
		});
		appendSample({
			source: "statusline",
			hit: 51,
			mode: {
				passthrough: true,
				keepAliveEnabled: false,
				stripEphemeralFromSystem: false,
			},
		});
		const out = listSamples();
		expect(out[0].mode.passthrough).toBe(false);
		expect(out[1].mode.passthrough).toBe(true);
	});

	test("non-numeric metric values count as null (Infinity, NaN, strings)", () => {
		// Defensive: only finite numbers count as "real observations" —
		// if a sample arrives with NaN/Infinity, it gets dropped if
		// nothing else carries a real value.
		appendSample({
			source: "upstream",
			hit: Number.NaN,
			tps: Number.POSITIVE_INFINITY,
			ttft: "fast",
		});
		expect(listSamples()).toHaveLength(0);
	});

	// PLAN §39 (Phase 1): per-session bucketing, filter, LRU, summaries.

	test("samples without sessionKey land in the aggregate bucket (back-compat)", () => {
		appendSample({ source: "upstream", hit: 1 });
		const out = listSamples();
		expect(out).toHaveLength(1);
		expect(out[0].sessionKey).toBe(AGGREGATE_KEY);
	});

	test("samples with explicit sessionKey go to that session's ring", () => {
		appendSample({
			source: "upstream",
			sessionKey: "red",
			hit: 11,
			label: "red",
		});
		appendSample({
			source: "upstream",
			sessionKey: "blue",
			hit: 22,
			label: "blue",
		});
		appendSample({ source: "upstream", sessionKey: "red", hit: 33 });

		const red = listSamples({ session: "red" });
		expect(red).toHaveLength(2);
		expect(red.map((s) => s.hit)).toEqual([11, 33]);

		const blue = listSamples({ session: "blue" });
		expect(blue).toHaveLength(1);
		expect(blue[0].hit).toBe(22);

		const all = listSamples();
		expect(all).toHaveLength(3);
	});

	test("listSamples without session merges and sorts across rings by ts", () => {
		appendSample({
			source: "upstream",
			sessionKey: "red",
			hit: 1,
			ts: "2026-05-15T10:00:00.000Z",
		});
		appendSample({
			source: "upstream",
			sessionKey: "blue",
			hit: 2,
			ts: "2026-05-15T10:00:01.000Z",
		});
		appendSample({
			source: "upstream",
			sessionKey: "red",
			hit: 3,
			ts: "2026-05-15T10:00:02.000Z",
		});
		const merged = listSamples();
		expect(merged.map((s) => s.hit)).toEqual([1, 2, 3]);
	});

	test("per-session ring caps at MAX_SAMPLES_PER_SESSION independently", () => {
		for (let i = 0; i < MAX_SAMPLES_PER_SESSION + 5; i++) {
			appendSample({ source: "upstream", sessionKey: "red", hit: i });
		}
		// Blue should NOT be affected by red's overflow.
		appendSample({ source: "upstream", sessionKey: "blue", hit: 999 });

		expect(listSamples({ session: "red" })).toHaveLength(
			MAX_SAMPLES_PER_SESSION,
		);
		expect(listSamples({ session: "blue" })).toHaveLength(1);
	});

	test("global cap of MAX_SESSIONS evicts the oldest-by-lastWriteMs ring", () => {
		// Create MAX_SESSIONS+1 distinct sessions; the first one written
		// (and never re-touched) should be evicted when the cap trips.
		for (let i = 0; i < MAX_SESSIONS + 1; i++) {
			appendSample({ source: "upstream", sessionKey: `s${i}`, hit: i });
		}
		// s0 is the oldest writer → evicted. s1..sN should still be present.
		expect(listSamples({ session: "s0" })).toHaveLength(0);
		expect(listSamples({ session: "s1" })).toHaveLength(1);
		const summaries = listSessionSummaries();
		expect(summaries.length).toBeLessThanOrEqual(MAX_SESSIONS);
		expect(summaries.find((r) => r.sessionKey === "s0")).toBeUndefined();
	});

	test("clearSamples with session arg clears only that ring", () => {
		appendSample({ source: "upstream", sessionKey: "red", hit: 1 });
		appendSample({ source: "upstream", sessionKey: "red", hit: 2 });
		appendSample({ source: "upstream", sessionKey: "blue", hit: 3 });
		expect(clearSamples({ session: "red" })).toBe(2);
		expect(listSamples({ session: "red" })).toHaveLength(0);
		expect(listSamples({ session: "blue" })).toHaveLength(1);
	});

	test("listSessionSummaries returns one row per active session, ordered by recency", async () => {
		appendSample({
			source: "upstream",
			sessionKey: "red",
			hit: 1,
			label: "red-label",
		});
		// Force a small delta between writes so lastWriteMs differs.
		await new Promise((r) => setTimeout(r, 5));
		appendSample({
			source: "upstream",
			sessionKey: "blue",
			hit: 2,
			label: "blue-label",
		});
		await new Promise((r) => setTimeout(r, 5));
		appendSample({ source: "upstream", sessionKey: "red", hit: 3 });

		const rows = listSessionSummaries();
		expect(rows).toHaveLength(2);
		// Red was written most recently → first.
		expect(rows[0].sessionKey).toBe("red");
		expect(rows[0].sampleCount).toBe(2);
		expect(rows[0].label).toBe("red-label");
		expect(rows[1].sessionKey).toBe("blue");
	});
});
