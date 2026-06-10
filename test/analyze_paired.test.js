import {
	bootstrapDiff,
	bootstrapPairedDiff,
	pairBillableByPairSeq,
} from "../benchmark/bin/analyze.js";

// A turn-log record as the benchmark tee writes it: pairSeq ties the two arms
// of one real Claude Code request together. billableInputFor reads
// input_tokens + cache_creation_input_tokens off usage.
function turn(pairSeq, arm, billable) {
	return {
		pairSeq,
		arm,
		usage: { input_tokens: billable, cache_creation_input_tokens: 0 },
	};
}

describe("pairBillableByPairSeq", () => {
	test("matches passthrough+treatment turns sharing a pairSeq", () => {
		const turns = [
			turn(1, "passthrough", 100),
			turn(1, "treatment", 80),
			turn(2, "passthrough", 200),
			turn(2, "treatment", 150),
		];
		const { pairs, incomplete, nSeqs } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([
			{ base: 100, treat: 80 },
			{ base: 200, treat: 150 },
		]);
		expect(incomplete).toBe(0);
		expect(nSeqs).toBe(2);
	});

	test("sums input + cache_creation for billable input", () => {
		const turns = [
			{
				pairSeq: 1,
				arm: "passthrough",
				usage: { input_tokens: 30, cache_creation_input_tokens: 70 },
			},
			{
				pairSeq: 1,
				arm: "treatment",
				usage: { input_tokens: 5, cache_creation_input_tokens: 0 },
			},
		];
		const { pairs } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([{ base: 100, treat: 5 }]);
	});

	test("a seq with only one arm is incomplete, not paired", () => {
		const turns = [
			turn(1, "passthrough", 100),
			turn(1, "treatment", 80),
			turn(2, "passthrough", 200),
		];
		const { pairs, incomplete } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([{ base: 100, treat: 80 }]);
		expect(incomplete).toBe(1);
	});

	test("ignores arms other than passthrough/treatment (e.g. keep-alive ping)", () => {
		const turns = [
			turn(1, "passthrough", 100),
			turn(1, "treatment", 80),
			turn(1, "treatment-ping", 5),
		];
		const { pairs } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([{ base: 100, treat: 80 }]);
	});

	test("first-wins when an arm appears twice for one seq", () => {
		const turns = [
			turn(1, "passthrough", 100),
			turn(1, "passthrough", 999),
			turn(1, "treatment", 80),
		];
		const { pairs } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([{ base: 100, treat: 80 }]);
	});

	test("turns without pairSeq yield no pairs (unpaired fallback)", () => {
		const turns = [
			{ arm: "passthrough", usage: { input_tokens: 100 } },
			{ arm: "treatment", usage: { input_tokens: 80 } },
		];
		const { pairs, nSeqs } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([]);
		expect(nSeqs).toBe(0);
	});

	test("emits pairs in ascending pairSeq order regardless of input order", () => {
		const turns = [
			turn(3, "treatment", 280),
			turn(3, "passthrough", 300),
			turn(1, "passthrough", 100),
			turn(2, "treatment", 150),
			turn(1, "treatment", 80),
			turn(2, "passthrough", 200),
		];
		const { pairs } = pairBillableByPairSeq(turns);
		expect(pairs).toEqual([
			{ base: 100, treat: 80 },
			{ base: 200, treat: 150 },
			{ base: 300, treat: 280 },
		]);
	});
});

describe("bootstrapPairedDiff", () => {
	const pairs = [
		{ base: 100, treat: 98 },
		{ base: 200, treat: 197 },
		{ base: 300, treat: 296 },
		{ base: 400, treat: 395 },
		{ base: 500, treat: 494 },
	];

	test("point estimate is mean(base - treat)", () => {
		const r = bootstrapPairedDiff(pairs, {
			seed: 42,
			iters: 2000,
			key: "reclaim",
		});
		// deltas = [2, 3, 4, 5, 6] -> mean 4
		expect(r.mean).toBeCloseTo(4, 10);
		expect(r.n).toBe(5);
		expect(r.lo).toBeLessThanOrEqual(r.mean);
		expect(r.hi).toBeGreaterThanOrEqual(r.mean);
	});

	test("is deterministic for a fixed seed", () => {
		const a = bootstrapPairedDiff(pairs, {
			seed: 42,
			iters: 2000,
			key: "reclaim",
		});
		const b = bootstrapPairedDiff(pairs, {
			seed: 42,
			iters: 2000,
			key: "reclaim",
		});
		expect(a).toEqual(b);
	});

	test("degenerates to the point estimate with < 2 pairs", () => {
		expect(
			bootstrapPairedDiff([{ base: 100, treat: 90 }], {
				seed: 42,
				iters: 2000,
				key: "x",
			}),
		).toEqual({ mean: 10, lo: 10, hi: 10, n: 1 });
		expect(
			bootstrapPairedDiff([], { seed: 42, iters: 2000, key: "x" }),
		).toEqual({
			mean: null,
			lo: null,
			hi: null,
			n: 0,
		});
	});

	// The whole point of pairing: when the arms co-vary (each pair hit the same
	// fixture/cch/tools), the per-pair delta is tight even though the arms each
	// span a wide range. The paired bootstrap exploits that; the independent
	// two-sample bootstrap throws it away and reports a much wider CI.
	test("paired CI is tighter than unpaired on positively-correlated arms", () => {
		const base = [100, 200, 300, 400, 500];
		const treat = [98, 197, 296, 395, 494];
		const corr = base.map((b, i) => ({ base: b, treat: treat[i] }));
		const paired = bootstrapPairedDiff(corr, {
			seed: 42,
			iters: 2000,
			key: "reclaim",
		});
		const unpaired = bootstrapDiff(base, treat, {
			seed: 42,
			iters: 2000,
			key: "reclaim",
		});
		// Same point estimate (mean(base)=300, mean(treat)=296).
		expect(paired.mean).toBeCloseTo(4, 10);
		expect(unpaired.mean).toBeCloseTo(4, 10);
		const wPaired = paired.hi - paired.lo;
		const wUnpaired = unpaired.hi - unpaired.lo;
		expect(wPaired).toBeLessThan(wUnpaired);
	});
});
