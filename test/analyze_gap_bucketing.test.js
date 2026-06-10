import {
	assignGaps,
	bucketFor,
	discardWarmup,
} from "../benchmark/bin/analyze.js";

// Regression for the L0 gap-bucket COLLAPSE (the "clustered runs" bug).
//
// THE BUG: assignGaps() grouped turns by (knobProfile, sessionKey) to compute
// inter-turn gaps. Claude Code stamps a per-request `cch` token as the first
// system block, which rotates EVERY request. clawback's SESSION KEY is a hash
// of the system AS FORWARDED, so on the passthrough arm (cch not stripped) the
// sessionKey changes on every turn. Each turn was therefore the lone member of
// its key group -> prev=null -> gapMs=null -> gapBucket="first". ALL passthrough
// turns collapsed into the "first" bucket, so they never shared a gap bucket
// with the treatment arm, every per-bucket comparison was flagged
// insufficient, and the headline fell back to non-matched arms (the nonsense
// "-165.5% vs baseline" seen in the L0 smoke run).
//
// THE FIX: compute gap/bucket grouped by `systemStableKey` (the always-stripped
// reference prefix, stable across cch rotation and present on every record),
// while keeping ping coverage attributed along that same stable timeline.

const base = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (offsetMs) => new Date(base + offsetMs).toISOString();

describe("assignGaps groups by systemStableKey, not the cch-rotated sessionKey", () => {
	test("passthrough turns sharing one stable prefix get real gaps (not all 'first')", () => {
		// One logical context, four turns 10s apart. cch rotates sessionKey every
		// request — exactly what passthrough does to Claude Code traffic.
		const turns = [
			{
				knobProfile: "A0",
				systemStableKey: "ssk-main",
				sessionKey: "cch-a",
				ts: iso(0),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk-main",
				sessionKey: "cch-b",
				ts: iso(10_000),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk-main",
				sessionKey: "cch-c",
				ts: iso(20_000),
			},
			// A long idle gap to prove non-"first" buckets resolve correctly too.
			{
				knobProfile: "A0",
				systemStableKey: "ssk-main",
				sessionKey: "cch-d",
				ts: iso(20_000 + 420_000),
			},
		];
		assignGaps(turns, []);

		// First turn has no predecessor; the rest get the true wall-clock gap.
		expect(turns[0].gapMs).toBeNull();
		expect(turns[0].gapBucket).toBe("first");
		expect(turns[1].gapMs).toBe(10_000);
		expect(turns[1].gapBucket).toBe("[0,30s)");
		expect(turns[2].gapMs).toBe(10_000);
		expect(turns[2].gapBucket).toBe("[0,30s)");
		expect(turns[3].gapMs).toBe(420_000);
		expect(turns[3].gapBucket).toBe("[5m,30m)");

		// The collapse signature: only ONE turn should be "first", not all four.
		const firsts = turns.filter((t) => t.gapBucket === "first").length;
		expect(firsts).toBe(1);
	});

	test("distinct stable prefixes (probe vs main calls) keep independent timelines", () => {
		// A real user turn fires multiple /v1/messages with different system
		// prompts (an out=1 probe, the big main turn). They have different
		// systemStableKeys and land milliseconds apart. They must NOT contaminate
		// each other's gaps: the main timeline's gap is main-to-main, not
		// main-to-probe.
		const turns = [
			{
				knobProfile: "A0",
				systemStableKey: "ssk-main",
				sessionKey: "m1",
				ts: iso(0),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk-probe",
				sessionKey: "p1",
				ts: iso(50),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk-main",
				sessionKey: "m2",
				ts: iso(10_000),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk-probe",
				sessionKey: "p2",
				ts: iso(10_050),
			},
		];
		assignGaps(turns, []);

		const main = turns.filter((t) => t.systemStableKey === "ssk-main");
		const probe = turns.filter((t) => t.systemStableKey === "ssk-probe");
		// Main-to-main gap is the full 10s, not the 50ms to the interleaved probe.
		expect(main[1].gapMs).toBe(10_000);
		expect(probe[1].gapMs).toBe(10_000);
	});

	test("knobProfile still partitions: same prefix across arms does not merge", () => {
		const turns = [
			{
				knobProfile: "A0",
				systemStableKey: "ssk",
				sessionKey: "x",
				ts: iso(0),
			},
			{
				knobProfile: "A5",
				systemStableKey: "ssk",
				sessionKey: "y",
				ts: iso(3_000),
			},
		];
		assignGaps(turns, []);
		// Different arms => each is the first turn on its own timeline.
		expect(turns[0].gapBucket).toBe("first");
		expect(turns[1].gapBucket).toBe("first");
	});
});

describe("ping coverage is attributed along the stable-prefix timeline", () => {
	test("a ping between two treatment turns is counted via systemStableKey", () => {
		// Treatment (strip-ephemeral) collapses cch -> the sessionKey is stable,
		// and the keep-alive ping shares the same systemStableKey. The ping landing
		// in the idle gap must be attributed to the following turn.
		const turns = [
			{
				knobProfile: "A5",
				systemStableKey: "ssk-main",
				sessionKey: "stable",
				ts: iso(0),
			},
			{
				knobProfile: "A5",
				systemStableKey: "ssk-main",
				sessionKey: "stable",
				ts: iso(600_000),
			},
		];
		const pings = [
			{
				knobProfile: "A5",
				systemStableKey: "ssk-main",
				sessionKey: "stable",
				ts: iso(300_000),
			},
		];
		assignGaps(turns, pings);

		expect(turns[1].gapMs).toBe(600_000);
		expect(turns[1].gapBucket).toBe("[5m,30m)");
		expect(turns[1].pingsSincePrevTurn).toBe(1);
		expect(turns[1].msSinceLastPing).toBe(300_000);
		// The first turn had no idle window before it.
		expect(turns[0].pingsSincePrevTurn).toBe(0);
	});
});

// Warm-up discard is the Anthropic-side carry-over guard ab_block.sh's
// cache-hygiene header promises for byte-identical serial arms (keep-alive vs
// passthrough forward the same real-turn bytes, so within 5 min arm B's OPENING
// turns can read arm A's still-warm Anthropic cache and inflate B's hit rate).
// Per-arm --state isolates only the clawback SESSION KEY, not the content-
// addressed ANTHROPIC KEY, so the analyzer must drop each arm's opening turns.
describe("discardWarmup drops each arm's opening turns (carry-over guard)", () => {
	test("drops the first n per (knobProfile, systemStableKey), keeps the rest", () => {
		const turns = [
			{
				knobProfile: "A0",
				systemStableKey: "ssk",
				sessionKey: "a",
				ts: iso(0),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk",
				sessionKey: "b",
				ts: iso(10_000),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk",
				sessionKey: "c",
				ts: iso(20_000),
			},
			{
				knobProfile: "A1",
				systemStableKey: "ssk",
				sessionKey: "d",
				ts: iso(0),
			},
			{
				knobProfile: "A1",
				systemStableKey: "ssk",
				sessionKey: "e",
				ts: iso(10_000),
			},
		];
		assignGaps(turns, []);
		const kept = discardWarmup(turns, 1);

		// A0: t0 dropped, t1+t2 kept; A1: t0 dropped, t1 kept.
		expect(kept.length).toBe(3);
		expect(kept.filter((t) => t.knobProfile === "A0").length).toBe(2);
		expect(kept.filter((t) => t.knobProfile === "A1").length).toBe(1);

		// The dropped turns are exactly the cold-start "first"-bucket ones — the
		// turns most exposed to a prior arm's warm cache. None should survive.
		expect(kept.some((t) => t.gapBucket === "first")).toBe(false);

		// Kept turns retain the TRUE intra-arm gap to their (now-dropped)
		// predecessor; discard runs AFTER assignGaps so a kept turn is never
		// misread as a fresh "first".
		const a0 = kept
			.filter((t) => t.knobProfile === "A0")
			.sort((x, y) => (x.ts < y.ts ? -1 : 1));
		expect(a0[0].gapMs).toBe(10_000);
	});

	test("warmup<=0 is a no-op (default keeps every turn)", () => {
		const turns = [
			{
				knobProfile: "A0",
				systemStableKey: "ssk",
				sessionKey: "a",
				ts: iso(0),
			},
			{
				knobProfile: "A0",
				systemStableKey: "ssk",
				sessionKey: "b",
				ts: iso(10_000),
			},
		];
		assignGaps(turns, []);
		expect(discardWarmup(turns, 0)).toHaveLength(2);
		expect(discardWarmup(turns, Number.NaN)).toHaveLength(2);
	});

	test("distinct prefixes (probe vs main) each get their own discard", () => {
		// Probe and main are separate cached prefixes -> each cold-starts
		// independently -> each must drop its own opening turn.
		const turns = [
			{
				knobProfile: "A0",
				systemStableKey: "main",
				sessionKey: "m1",
				ts: iso(0),
			},
			{
				knobProfile: "A0",
				systemStableKey: "main",
				sessionKey: "m2",
				ts: iso(10_000),
			},
			{
				knobProfile: "A0",
				systemStableKey: "probe",
				sessionKey: "p1",
				ts: iso(50),
			},
			{
				knobProfile: "A0",
				systemStableKey: "probe",
				sessionKey: "p2",
				ts: iso(10_050),
			},
		];
		assignGaps(turns, []);
		const kept = discardWarmup(turns, 1);
		expect(kept.filter((t) => t.systemStableKey === "main")).toHaveLength(1);
		expect(kept.filter((t) => t.systemStableKey === "probe")).toHaveLength(1);
	});
});

describe("bucketFor boundaries (sanity)", () => {
	test("null -> first, exclusive upper bounds", () => {
		expect(bucketFor(null)).toBe("first");
		expect(bucketFor(0)).toBe("[0,30s)");
		expect(bucketFor(29_999)).toBe("[0,30s)");
		expect(bucketFor(30_000)).toBe("[30s,5m)");
		expect(bucketFor(300_000)).toBe("[5m,30m)");
		expect(bucketFor(3_600_000)).toBe("[60m,inf)");
	});
});
