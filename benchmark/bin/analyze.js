#!/usr/bin/env node
/**
 * clawback benchmark analyzer.
 *
 * Reads per-turn NDJSON turn-logs emitted by a running clawback proxy
 * (`--turn-log <path>`) and produces, in the --out directory:
 *
 *   report.csv     turn-level rows for plotting (consumed by plot.js)
 *   summary.json   per (knobProfile x arm x gapBucket) aggregates + CIs
 *   report.md      human-readable headline + per-bucket table
 *   manifest.json  inputs, pricing hash, seed, coverage
 *
 * Cost is computed analyzer-side from benchmark/pricing.json so the proxy
 * stays out of the pricing business and historical runs can be re-priced.
 * Savings are reported as treatment-vs-passthrough within the SAME gap
 * bucket, with bootstrap 95% CIs (seeded -> byte-identical reruns).
 *
 * Usage:
 *   node benchmark/bin/analyze.js --out <dir> [opts] <input...>
 *     --out <dir>          output directory (required)
 *     --label name=path    assign knobProfile `name` to records from path
 *                          (repeatable). Bare inputs use their basename.
 *     --seed <n>           bootstrap PRNG seed (default 42)
 *     --bootstrap <n>      bootstrap iterations (default 2000)
 *     --warmup <n>         drop the first n turns of each (knobProfile,
 *                          systemStableKey) timeline before stats — the
 *                          carry-over guard for byte-identical serial arms
 *                          (default 0; ab_block.sh passes 1)
 *     --pricing <path>     pricing table (default benchmark/pricing.json)
 *   Inputs are .ndjson files or directories containing them.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRICING = path.join(HERE, "..", "pricing.json");

// Below this per-arm bucket count, report.md flags savings as `insufficient`
// rather than printing a CI exploded by a near-zero baseline. Raw values stay
// in summary.json. The reportable-headline target is >= 200 turns/arm; 30 is the floor
// below which a savings % is actively misleading.
const MIN_REPORTABLE_N = 30;

// Gap buckets bracket the 5-min and 60-min eviction boundaries.
const GAP_BUCKETS = [
	{ key: "first", lo: -1, hi: -1 },
	{ key: "[0,30s)", lo: 0, hi: 30_000 },
	{ key: "[30s,5m)", lo: 30_000, hi: 300_000 },
	{ key: "[5m,30m)", lo: 300_000, hi: 1_800_000 },
	{ key: "[30m,60m)", lo: 1_800_000, hi: 3_600_000 },
	{ key: "[60m,inf)", lo: 3_600_000, hi: Number.POSITIVE_INFINITY },
];
const BUCKET_ORDER = GAP_BUCKETS.map((b) => b.key);

export function bucketFor(gapMs) {
	if (gapMs == null) return "first";
	for (const b of GAP_BUCKETS) {
		if (b.key === "first") continue;
		if (gapMs >= b.lo && gapMs < b.hi) return b.key;
	}
	return "[60m,inf)";
}

// ---- arg parsing ------------------------------------------------------

function parseArgs(argv) {
	const out = {
		inputs: [],
		labels: [],
		seed: 42,
		bootstrap: 2000,
		warmup: 0,
		outDir: null,
		pricing: DEFAULT_PRICING,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out") out.outDir = argv[++i];
		else if (a === "--seed") out.seed = Number(argv[++i]);
		else if (a === "--bootstrap") out.bootstrap = Number(argv[++i]);
		else if (a === "--warmup") out.warmup = Number(argv[++i]);
		else if (a === "--pricing") out.pricing = argv[++i];
		else if (a === "--label") {
			const spec = argv[++i] ?? "";
			const eq = spec.indexOf("=");
			if (eq === -1) throw new Error(`--label expects name=path, got: ${spec}`);
			out.labels.push({ name: spec.slice(0, eq), path: spec.slice(eq + 1) });
		} else if (a === "-h" || a === "--help") {
			out.help = true;
		} else if (a.startsWith("--")) {
			throw new Error(`unknown option: ${a}`);
		} else {
			out.inputs.push(a);
		}
	}
	return out;
}

// Resolve {inputs[], labels[]} into a flat list of {path, label}.
function resolveSources({ inputs, labels }) {
	const sources = [];
	const expand = (p, label) => {
		const st = fs.statSync(p);
		if (st.isDirectory()) {
			for (const f of fs.readdirSync(p).sort()) {
				if (f.endsWith(".ndjson")) {
					const full = path.join(p, f);
					sources.push({ path: full, label: label ?? basenameLabel(full) });
				}
			}
		} else {
			sources.push({ path: p, label: label ?? basenameLabel(p) });
		}
	};
	for (const { name, path: p } of labels) expand(p, name);
	for (const p of inputs) expand(p, null);
	if (sources.length === 0)
		throw new Error("no inputs (.ndjson files or directories)");
	return sources;
}

function basenameLabel(p) {
	return path.basename(p).replace(/\.ndjson$/, "");
}

// ---- pricing ----------------------------------------------------------

function loadPricing(p) {
	const raw = fs.readFileSync(p, "utf8");
	const table = JSON.parse(raw);
	const hash = crypto
		.createHash("sha256")
		.update(canonical(table))
		.digest("hex")
		.slice(0, 16);
	return { table, hash };
}

// Deterministic key ordering so the hash is stable across machines.
function canonical(v) {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}

function modelRates(table, modelId) {
	const m = String(modelId ?? "");
	let best = null;
	for (const key of Object.keys(table.models)) {
		if (m.startsWith(key) && (best == null || key.length > best.length))
			best = key;
	}
	return best ? table.models[best] : table.fallback;
}

// $ for one turn from its usage block.
function usdFor(table, modelId, usage) {
	if (!usage) return 0;
	const rates = modelRates(table, modelId);
	const mul = table.multipliers;
	const baseIn = rates.inputPerMtok / 1e6;
	const baseOut = rates.outputPerMtok / 1e6;
	const input = num(usage.input_tokens);
	const read = num(usage.cache_read_input_tokens);
	const ccTotal = num(usage.cache_creation_input_tokens);
	const out = num(usage.output_tokens);
	let e5 = usage.cache_creation?.ephemeral_5m_input_tokens;
	let e1 = usage.cache_creation?.ephemeral_1h_input_tokens;
	if (e5 == null && e1 == null) {
		// No split available: treat all creation as 5m tier.
		e5 = ccTotal;
		e1 = 0;
	} else {
		e5 = num(e5);
		e1 = num(e1);
	}
	return (
		baseIn *
			(mul.input * input +
				mul.cacheWrite5m * e5 +
				mul.cacheWrite1h * e1 +
				mul.cacheRead * read) +
		baseOut * mul.output * out
	);
}

function hitRateFor(usage) {
	if (!usage) return null;
	const input = num(usage.input_tokens);
	const read = num(usage.cache_read_input_tokens);
	const cc = num(usage.cache_creation_input_tokens);
	const denom = read + cc + input;
	if (denom <= 0) return null;
	return read / denom;
}

// "Billable input" = the full-rate input buckets that consume your quota:
// uncached input + cache writes. cache_read is the discounted reuse (priced at
// a fraction of input) and is reported separately, NOT counted here. Output is
// identical across arms (same model, same work) so it's excluded. This is the
// no-pricing token-reclaim metric the report leads with: how many full-rate
// tokens clawback keeps off your quota vs passthrough.
function billableInputFor(usage) {
	if (!usage) return 0;
	return num(usage.input_tokens) + num(usage.cache_creation_input_tokens);
}

function cacheReadFor(usage) {
	return usage ? num(usage.cache_read_input_tokens) : 0;
}

function num(x) {
	return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

// ---- seeded bootstrap -------------------------------------------------

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seedFromKey(globalSeed, key) {
	const h = crypto.createHash("sha256").update(key).digest();
	return (globalSeed ^ h.readUInt32LE(0)) >>> 0;
}

function mean(xs) {
	if (xs.length === 0) return null;
	let s = 0;
	for (const x of xs) s += x;
	return s / xs.length;
}

function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Bootstrap the mean of one sample. Returns {mean, lo, hi, n}.
function bootstrapMean(xs, { seed, iters, key }) {
	const obs = mean(xs);
	if (xs.length < 2) return { mean: obs, lo: obs, hi: obs, n: xs.length };
	const rng = mulberry32(seedFromKey(seed, `mean:${key}`));
	const means = new Array(iters);
	const n = xs.length;
	for (let b = 0; b < iters; b++) {
		let s = 0;
		for (let i = 0; i < n; i++) s += xs[(rng() * n) | 0];
		means[b] = s / n;
	}
	means.sort((a, c) => a - c);
	return {
		mean: obs,
		lo: percentile(means, 0.025),
		hi: percentile(means, 0.975),
		n,
	};
}

// Bootstrap % savings of treat vs base: (base-treat)/base * 100.
function bootstrapSavings(treat, base, { seed, iters, key }) {
	const mt = mean(treat);
	const mb = mean(base);
	const obs = mb && mb !== 0 ? ((mb - mt) / mb) * 100 : null;
	if (treat.length < 2 || base.length < 2 || !mb)
		return { mean: obs, lo: obs, hi: obs };
	const rng = mulberry32(seedFromKey(seed, `sav:${key}`));
	const vals = new Array(iters);
	for (let b = 0; b < iters; b++) {
		let st = 0;
		for (let i = 0; i < treat.length; i++)
			st += treat[(rng() * treat.length) | 0];
		let sb = 0;
		for (let i = 0; i < base.length; i++) sb += base[(rng() * base.length) | 0];
		const mtb = st / treat.length;
		const mbb = sb / base.length;
		vals[b] = mbb !== 0 ? ((mbb - mtb) / mbb) * 100 : 0;
	}
	vals.sort((a, c) => a - c);
	return {
		mean: obs,
		lo: percentile(vals, 0.025),
		hi: percentile(vals, 0.975),
	};
}

// Bootstrap the difference base-mean minus treat-mean. Returns {mean,lo,hi}.
// Used for reclaimed-tokens/turn: positive => clawback spent fewer billable
// input tokens per turn than passthrough.
export function bootstrapDiff(base, treat, { seed, iters, key }) {
	const mb = mean(base);
	const mt = mean(treat);
	const obs = mb == null || mt == null ? null : mb - mt;
	if (base.length < 2 || treat.length < 2)
		return { mean: obs, lo: obs, hi: obs };
	const rng = mulberry32(seedFromKey(seed, `diff:${key}`));
	const vals = new Array(iters);
	for (let b = 0; b < iters; b++) {
		let sb = 0;
		for (let i = 0; i < base.length; i++) sb += base[(rng() * base.length) | 0];
		let st = 0;
		for (let i = 0; i < treat.length; i++)
			st += treat[(rng() * treat.length) | 0];
		vals[b] = sb / base.length - st / treat.length;
	}
	vals.sort((a, c) => a - c);
	return {
		mean: obs,
		lo: percentile(vals, 0.025),
		hi: percentile(vals, 0.975),
	};
}

// Group turns into matched (base, treat) pairs by the tee's internal pairSeq.
// pairSeq is assigned by the benchmark tee — it fans one real Claude Code
// request to both arms and stamps both turn-log records with the same id — and
// NEVER crosses the wire to Anthropic. For each seq we take the first
// passthrough turn as `base` and the first treatment turn as `treat`
// (first-wins guards against an accidental duplicate). Arms other than
// passthrough/treatment (e.g. keep-alive pings) are ignored. Turns lacking a
// pairSeq (live dogfood, replay, the existing unpaired runs) produce no pairs,
// so the analyzer transparently falls back to the unpaired estimator. Pairs are
// emitted in ascending pairSeq order so the downstream bootstrap is
// deterministic regardless of input record order.
export function pairBillableByPairSeq(turns) {
	const bySeq = new Map();
	for (const t of turns) {
		if (t.pairSeq == null) continue;
		const arm = t.arm;
		if (arm !== "passthrough" && arm !== "treatment") continue;
		if (!bySeq.has(t.pairSeq))
			bySeq.set(t.pairSeq, { base: null, treat: null });
		const slot = bySeq.get(t.pairSeq);
		const field = arm === "passthrough" ? "base" : "treat";
		if (slot[field] != null) continue; // first-wins
		slot[field] = billableInputFor(t.usage ?? {});
	}
	const seqs = [...bySeq.keys()].sort((a, b) => {
		const na = Number(a);
		const nb = Number(b);
		if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
		return String(a).localeCompare(String(b));
	});
	const pairs = [];
	let incomplete = 0;
	for (const seq of seqs) {
		const slot = bySeq.get(seq);
		if (slot.base != null && slot.treat != null)
			pairs.push({ base: slot.base, treat: slot.treat });
		else incomplete++;
	}
	return { pairs, incomplete, nSeqs: bySeq.size };
}

// Paired bootstrap of (base - treat) over matched pairs. The point estimate is
// mean(base - treat); we resample PAIR INDICES jointly (a one-sample bootstrap
// on the per-pair delta array), so within-pair correlation — turn k hit the
// same fixture, the same cch, the same tools in both arms — cancels out and the
// CI is tighter than the independent two-sample `bootstrapDiff` whenever the
// arms co-vary. Because pairs are exact counterfactuals, the total is the exact
// sum of deltas, not a projection. Returns {mean, lo, hi, n}.
export function bootstrapPairedDiff(pairs, { seed, iters, key }) {
	const deltas = pairs.map((p) => p.base - p.treat);
	const obs = mean(deltas);
	if (deltas.length < 2)
		return { mean: obs, lo: obs, hi: obs, n: deltas.length };
	const rng = mulberry32(seedFromKey(seed, `paired:${key}`));
	const n = deltas.length;
	const vals = new Array(iters);
	for (let b = 0; b < iters; b++) {
		let s = 0;
		for (let i = 0; i < n; i++) s += deltas[(rng() * n) | 0];
		vals[b] = s / n;
	}
	vals.sort((a, c) => a - c);
	return {
		mean: obs,
		lo: percentile(vals, 0.025),
		hi: percentile(vals, 0.975),
		n,
	};
}

// ---- load & enrich ----------------------------------------------------

function loadTurns(sources, pricing) {
	const turns = []; // non-ping turns
	const pings = []; // arm === treatment-ping
	const perSource = new Map(); // path -> {nRecords, arms:Set, minTs, maxTs, label}
	for (const { path: p, label } of sources) {
		const text = fs.readFileSync(p, "utf8");
		const stat = {
			nRecords: 0,
			arms: new Set(),
			minTs: null,
			maxTs: null,
			label,
		};
		perSource.set(p, stat);
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let rec;
			try {
				rec = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!rec || typeof rec !== "object" || !rec.arm) continue;
			stat.nRecords++;
			stat.arms.add(rec.arm);
			if (rec.ts) {
				if (!stat.minTs || rec.ts < stat.minTs) stat.minTs = rec.ts;
				if (!stat.maxTs || rec.ts > stat.maxTs) stat.maxTs = rec.ts;
			}
			const usd = usdFor(pricing.table, rec.model, rec.usage);
			const enriched = { ...rec, knobProfile: label, usd };
			if (rec.arm === "treatment-ping") pings.push(enriched);
			else turns.push(enriched);
		}
	}
	return { turns, pings, perSource };
}

// Compute inter-turn gap AND keep-alive ping coverage per
// (knobProfile, systemStableKey) timeline. We MUST group on systemStableKey,
// not sessionKey: Claude Code stamps a per-request `cch` token as the first
// system block that rotates every request, so on the passthrough arm the
// SESSION KEY (hash of system AS FORWARDED) changes every turn. Grouping by
// sessionKey there put each turn alone in its group -> gapMs=null ->
// gapBucket="first", collapsing every passthrough turn into one bucket and
// breaking the per-bucket arm comparison (the "clustered runs" bug). The
// systemStableKey is the always-stripped reference prefix: stable across cch
// rotation, present on every record, and it still separates genuinely different
// contexts (probe vs main calls). Fall back to sessionKey only for older
// records that predate systemStableKey. Pings carry the same systemStableKey,
// so warmth is attributed to the gap it covered with no proxy change: for each
// real turn, how many pings landed in (prevTurnTs, thisTurnTs] and how long
// since the last one (ping coverage).
function contextKey(rec) {
	return `${rec.knobProfile}\u0000${rec.systemStableKey ?? rec.sessionKey ?? ""}`;
}
export function assignGaps(turns, pings = []) {
	const pingsByKey = new Map();
	for (const p of pings) {
		const pk = contextKey(p);
		const pms = Date.parse(p.ts);
		if (!Number.isFinite(pms)) continue;
		if (!pingsByKey.has(pk)) pingsByKey.set(pk, []);
		pingsByKey.get(pk).push(pms);
	}
	for (const parr of pingsByKey.values()) parr.sort((a, b) => a - b);

	const byKey = new Map();
	for (const t of turns) {
		const k = contextKey(t);
		if (!byKey.has(k)) byKey.set(k, []);
		byKey.get(k).push(t);
	}
	for (const [k, arr] of byKey) {
		arr.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
		const pingTs = pingsByKey.get(k) ?? [];
		let prev = null;
		for (const t of arr) {
			const hi = Date.parse(t.ts);
			const ms = prev ? hi - Date.parse(prev.ts) : null;
			t.gapMs = ms != null && Number.isFinite(ms) && ms >= 0 ? ms : null;
			t.gapBucket = bucketFor(t.gapMs);
			const lo = prev ? Date.parse(prev.ts) : Number.NEGATIVE_INFINITY;
			let count = 0;
			let lastPing = null;
			for (const pts of pingTs) {
				if (pts > lo && pts <= hi) {
					count++;
					lastPing = pts;
				}
			}
			t.pingsSincePrevTurn = count;
			t.msSinceLastPing = lastPing == null ? null : hi - lastPing;
			prev = t;
		}
	}
}

// Warm-up discard — the Anthropic-side carry-over guard.
// Drop the first `n` real turns of each (knobProfile, systemStableKey)
// timeline. Those opening turns are (a) the cold-start the steady-state
// comparison should exclude and (b) the only turns that can read a PRIOR
// serial arm's still-warm Anthropic cache when two arms forward byte-identical
// content (keep-alive vs passthrough). Per-arm --state isolates only the
// clawback SESSION KEY; the content-addressed ANTHROPIC KEY is unaffected, so
// without this drop a brief serial-arm overlap would inflate the later arm's
// hit rate. Run AFTER assignGaps so each KEPT turn keeps the true intra-arm gap
// to its (now-dropped) predecessor instead of being misread as a fresh "first".
// n<=0 (the default) keeps every turn. Pings are left untouched: their per-turn
// coverage is already attributed by assignGaps, and at the small n this guards
// with (typically 1) the ping-overhead denominator shift is negligible.
export function discardWarmup(turns, n) {
	if (!Number.isFinite(n) || n <= 0) return turns;
	const byKey = new Map();
	for (const t of turns) {
		const k = contextKey(t);
		if (!byKey.has(k)) byKey.set(k, []);
		byKey.get(k).push(t);
	}
	const drop = new Set();
	for (const arr of byKey.values()) {
		arr.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
		for (let i = 0; i < Math.min(n, arr.length); i++) drop.add(arr[i]);
	}
	return turns.filter((t) => !drop.has(t));
}

// Prefix fragmentation: distinct clawback SESSION KEYs observed per stable
// system prefix (systemStableKey), per knobProfile. 1 is ideal (one logical
// context -> one Anthropic cache key); >1 means the same context split across
// keys, each cold-starting Anthropic's cache. strip-ephemeral collapses this to
// 1 — computable from the log alone, no proxy change.
export function computePrefixFragmentation(turns) {
	const byProfile = new Map();
	for (const t of turns) {
		const ssk = t.systemStableKey;
		if (!ssk || !t.sessionKey) continue;
		if (!byProfile.has(t.knobProfile)) byProfile.set(t.knobProfile, new Map());
		const m = byProfile.get(t.knobProfile);
		if (!m.has(ssk)) m.set(ssk, new Set());
		m.get(ssk).add(t.sessionKey);
	}
	const out = [];
	for (const [knobProfile, m] of byProfile) {
		for (const [systemStableKey, keys] of m) {
			out.push({
				knobProfile,
				systemStableKey: String(systemStableKey).slice(0, 12),
				distinctSessionKeys: keys.size,
				sessionKeys: [...keys].map((s) => String(s).slice(0, 12)).sort(),
			});
		}
	}
	out.sort(
		(a, b) =>
			a.knobProfile.localeCompare(b.knobProfile) ||
			b.distinctSessionKeys - a.distinctSessionKeys ||
			a.systemStableKey.localeCompare(b.systemStableKey),
	);
	return out;
}

// ---- aggregation ------------------------------------------------------

function aggregate(turns, pings, { seed, iters }) {
	// Per-profile ping overhead, amortized across that profile's treatment turns.
	const pingUsdByProfile = new Map();
	for (const p of pings)
		pingUsdByProfile.set(
			p.knobProfile,
			(pingUsdByProfile.get(p.knobProfile) ?? 0) + p.usd,
		);
	const treatCountByProfile = new Map();
	for (const t of turns) {
		if (t.arm === "treatment")
			treatCountByProfile.set(
				t.knobProfile,
				(treatCountByProfile.get(t.knobProfile) ?? 0) + 1,
			);
	}

	// Strata: profile x arm x bucket.
	const strata = new Map();
	const stratumKey = (t) =>
		`${t.knobProfile}\u0000${t.arm}\u0000${t.gapBucket}`;
	for (const t of turns) {
		const k = stratumKey(t);
		if (!strata.has(k)) strata.set(k, []);
		strata.get(k).push(t);
	}

	const arms = [];
	for (const [k, ts] of strata) {
		const [knobProfile, arm, gapBucket] = k.split("\u0000");
		const usds = ts.map((t) => t.usd);
		const hits = ts.map((t) => hitRateFor(t.usage)).filter((x) => x != null);
		const pingCovs = ts.map((t) => t.pingsSincePrevTurn ?? 0);
		const pingCoverageShare = ts.length
			? pingCovs.filter((c) => c > 0).length / ts.length
			: null;
		const totalUsd = usds.reduce((a, b) => a + b, 0);
		const pingOverheadUsd = pingUsdByProfile.get(knobProfile) ?? 0;
		const nTreat = treatCountByProfile.get(knobProfile) ?? 0;
		const usdCI = bootstrapMean(usds, { seed, iters, key: `usd:${k}` });
		const hitCI = bootstrapMean(hits, { seed, iters, key: `hit:${k}` });
		const amortizedPing =
			arm === "treatment" && nTreat > 0 ? pingOverheadUsd / nTreat : 0;
		arms.push({
			knobProfile,
			arm,
			gapBucket,
			nTurns: ts.length,
			meanUsdPerTurn: usdCI,
			meanCacheHitRate: hitCI,
			totalUsd,
			pingOverheadUsd: arm === "treatment" ? pingOverheadUsd : 0,
			netUsdPerTurn: usdCI.mean == null ? null : usdCI.mean + amortizedPing,
			meanPingsSincePrevTurn: mean(pingCovs),
			pingCoverageShare,
		});
	}
	arms.sort(
		(a, b) =>
			a.knobProfile.localeCompare(b.knobProfile) ||
			a.arm.localeCompare(b.arm) ||
			BUCKET_ORDER.indexOf(a.gapBucket) - BUCKET_ORDER.indexOf(b.gapBucket),
	);

	// Savings: each treatment profile vs the pooled passthrough baseline, per bucket.
	const baseByBucket = new Map();
	for (const t of turns) {
		if (t.arm !== "passthrough") continue;
		if (!baseByBucket.has(t.gapBucket)) baseByBucket.set(t.gapBucket, []);
		baseByBucket.get(t.gapBucket).push(t.usd);
	}
	const treatByPB = new Map(); // `${profile}\u0000${bucket}` -> usds
	for (const t of turns) {
		if (t.arm !== "treatment") continue;
		const k = `${t.knobProfile}\u0000${t.gapBucket}`;
		if (!treatByPB.has(k)) treatByPB.set(k, []);
		treatByPB.get(k).push(t.usd);
	}
	const savings = [];
	for (const [k, tUsds] of treatByPB) {
		const [knobProfile, gapBucket] = k.split("\u0000");
		const bUsds = baseByBucket.get(gapBucket) ?? [];
		if (bUsds.length === 0) continue;
		const ci = bootstrapSavings(tUsds, bUsds, { seed, iters, key: `${k}` });
		savings.push({
			knobProfile,
			gapBucket,
			nTreat: tUsds.length,
			nBase: bUsds.length,
			meanTreatUsd: mean(tUsds),
			meanBaseUsd: mean(bUsds),
			savingsPct: ci,
		});
	}
	savings.sort(
		(a, b) =>
			a.knobProfile.localeCompare(b.knobProfile) ||
			BUCKET_ORDER.indexOf(a.gapBucket) - BUCKET_ORDER.indexOf(b.gapBucket),
	);

	return { arms, savings };
}

// The headline the report leads with: billable input tokens (input + cache
// writes) clawback keeps off your quota vs the passthrough baseline. No
// pricing involved — just observed token counts. Pooled passthrough is the
// baseline; pooled treatment (everything non-passthrough) is clawback. The
// per-turn reclaim is the robust figure (a rate, valid even when the arms have
// different turn counts); the total is exact only when the arms are matched
// (same fixture, same turn count — the replay harness), else it's a projection
// of the per-turn rate over the treatment turns and flagged as such.
function aggregateTokens(turns, { seed, iters }) {
	const perArmMap = new Map();
	const baseSamples = [];
	const treatSamples = [];
	let baseCacheRead = 0;
	let treatCacheRead = 0;
	for (const t of turns) {
		const u = t.usage ?? {};
		const billable = billableInputFor(u);
		const read = cacheReadFor(u);
		const k = `${t.knobProfile}\u0000${t.arm}`;
		if (!perArmMap.has(k)) {
			perArmMap.set(k, {
				knobProfile: t.knobProfile,
				arm: t.arm,
				nTurns: 0,
				totalBillable: 0,
				totalCacheRead: 0,
				totalInput: 0,
				totalCacheCreation: 0,
				totalOutput: 0,
			});
		}
		const acc = perArmMap.get(k);
		acc.nTurns++;
		acc.totalBillable += billable;
		acc.totalCacheRead += read;
		acc.totalInput += num(u.input_tokens);
		acc.totalCacheCreation += num(u.cache_creation_input_tokens);
		acc.totalOutput += num(u.output_tokens);
		if (t.arm === "passthrough") {
			baseSamples.push(billable);
			baseCacheRead += read;
		} else {
			treatSamples.push(billable);
			treatCacheRead += read;
		}
	}
	const perArm = [...perArmMap.values()].map((a) => ({
		knobProfile: a.knobProfile,
		arm: a.arm,
		nTurns: a.nTurns,
		totalBillable: a.totalBillable,
		meanBillablePerTurn: a.nTurns ? a.totalBillable / a.nTurns : null,
		totalCacheRead: a.totalCacheRead,
		totalInput: a.totalInput,
		totalCacheCreation: a.totalCacheCreation,
		totalOutput: a.totalOutput,
	}));
	perArm.sort(
		(a, b) =>
			a.knobProfile.localeCompare(b.knobProfile) || a.arm.localeCompare(b.arm),
	);

	const baseMean = mean(baseSamples);
	const treatMean = mean(treatSamples);
	const baseTotal = baseSamples.reduce((a, b) => a + b, 0);
	const treatTotal = treatSamples.reduce((a, b) => a + b, 0);
	const reclaimedPerTurn =
		baseMean != null && treatMean != null ? baseMean - treatMean : null;
	const reclaimedPerTurnCI = bootstrapDiff(baseSamples, treatSamples, {
		seed,
		iters,
		key: "reclaim",
	});
	const matched =
		baseSamples.length > 0 && baseSamples.length === treatSamples.length;
	const reclaimedTotal = matched
		? baseTotal - treatTotal
		: reclaimedPerTurn != null
			? Math.round(reclaimedPerTurn * treatSamples.length)
			: null;
	const pctLessPerTurn =
		baseMean && reclaimedPerTurn != null
			? (reclaimedPerTurn / baseMean) * 100
			: null;

	// Paired (turn-matched) estimator — only populated when the tee tagged turns
	// with pairSeq. Each pair is the same real request billed under both arms, so
	// this is the rigorous figure: an exact per-pair counterfactual with a CI
	// that exploits within-pair correlation. Falls back to null (report leads
	// with the unpaired pooled figure) when there are no pairs.
	const paired = pairBillableByPairSeq(turns);
	const hasPairs = paired.pairs.length >= 2;
	const reclaimedPerTurnPaired = hasPairs
		? mean(paired.pairs.map((p) => p.base - p.treat))
		: null;
	const reclaimedPerTurnPairedCI = hasPairs
		? bootstrapPairedDiff(paired.pairs, { seed, iters, key: "reclaim" })
		: null;
	const reclaimedTotalPaired = hasPairs
		? paired.pairs.reduce((a, p) => a + (p.base - p.treat), 0)
		: null;
	const basePairedMean = hasPairs
		? mean(paired.pairs.map((p) => p.base))
		: null;
	const pctLessPaired =
		basePairedMean && reclaimedPerTurnPaired != null
			? (reclaimedPerTurnPaired / basePairedMean) * 100
			: null;

	return {
		billableDef:
			"input_tokens + cache_creation_input_tokens (full-rate input; excludes cache_read and output)",
		baseline: {
			arm: "passthrough",
			nTurns: baseSamples.length,
			totalBillable: baseTotal,
			meanBillablePerTurn: baseMean,
			totalCacheRead: baseCacheRead,
		},
		treatment: {
			nTurns: treatSamples.length,
			totalBillable: treatTotal,
			meanBillablePerTurn: treatMean,
			totalCacheRead: treatCacheRead,
		},
		reclaimedPerTurn,
		reclaimedPerTurnCI,
		reclaimedTotal,
		reclaimedTotalIsProjected: !matched,
		pctLessPerTurn,
		nPairs: paired.pairs.length,
		nPairsIncomplete: paired.incomplete,
		reclaimedPerTurnPaired,
		reclaimedPerTurnPairedCI,
		reclaimedTotalPaired,
		pctLessPaired,
		perArm,
	};
}

// ---- writers ----------------------------------------------------------

const CSV_COLS = [
	"ts",
	"arm",
	"knobProfile",
	"sessionKey",
	"model",
	"ttlMode",
	"cadenceMode",
	"thinkingBudget",
	"gapMs",
	"gapBucket",
	"input_tokens",
	"cache_creation_tokens",
	"cache_read_tokens",
	"output_tokens",
	"ephemeral_5m_tokens",
	"ephemeral_1h_tokens",
	"cache_hit_rate",
	"usd_estimate",
	"wallMs",
	"ttftMs",
	"httpStatus",
	"pingsSincePrevTurn",
	"msSinceLastPing",
	"clawbackVersion",
	"pricingHash",
];

function csvEscape(v) {
	if (v == null) return "";
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, turns, pricingHash) {
	const rows = [CSV_COLS.join(",")];
	const sorted = [...turns].sort((a, b) =>
		a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
	);
	for (const t of sorted) {
		const u = t.usage ?? {};
		const row = [
			t.ts,
			t.arm,
			t.knobProfile,
			t.sessionKey,
			t.model,
			t.ttlMode,
			t.cadenceMode,
			t.thinkingBudget ?? "",
			t.gapMs ?? "",
			t.gapBucket,
			num(u.input_tokens),
			num(u.cache_creation_input_tokens),
			num(u.cache_read_input_tokens),
			num(u.output_tokens),
			num(u.cache_creation?.ephemeral_5m_input_tokens),
			num(u.cache_creation?.ephemeral_1h_input_tokens),
			hitRateFor(u) ?? "",
			t.usd.toFixed(6),
			t.wallMs ?? "",
			t.ttftMs ?? "",
			t.httpStatus ?? "",
			t.pingsSincePrevTurn ?? 0,
			t.msSinceLastPing ?? "",
			t.clawbackVersion ?? "",
			pricingHash,
		];
		rows.push(row.map(csvEscape).join(","));
	}
	fs.writeFileSync(file, `${rows.join("\n")}\n`);
}

function fmtUsd(x) {
	return x == null ? "n/a" : `$${x.toFixed(5)}`;
}
function fmtPct(x) {
	return x == null ? "n/a" : `${x.toFixed(1)}%`;
}
function fmtTok(x) {
	return x == null ? "n/a" : Math.round(x).toLocaleString("en-US");
}

function writeReportMd(
	file,
	{ arms, savings, prefixFragmentation, tokens },
	meta,
) {
	const L = [];
	L.push("# clawback benchmark report", "");
	L.push(`- generated: ${meta.generatedAt}`);
	L.push(`- bootstrap: ${meta.iters} iters, seed ${meta.seed}`);
	L.push(`- turns: ${meta.nTurns} (+${meta.nPings} keep-alive pings)`, "");

	if (tokens) {
		const b = tokens.baseline;
		const tr = tokens.treatment;
		const ci = tokens.reclaimedPerTurnCI ?? {};
		L.push("## Quota reclaimed vs passthrough (billable input tokens)", "");
		L.push(
			"The headline: how many full-rate input tokens clawback keeps off your quota for the same work — quota you can spend on real problems. **Billable input** = `input_tokens + cache_creation_input_tokens` (the buckets billed at full/premium rate). `cache_read` is the discounted reuse, reported separately; output is identical across arms and excluded. No pricing involved — just observed token counts.",
			"",
		);
		L.push(
			`- baseline (passthrough): **${fmtTok(b?.meanBillablePerTurn)}** billable tokens/turn over ${b?.nTurns ?? 0} turns`,
		);
		L.push(
			`- clawback (treatment): **${fmtTok(tr?.meanBillablePerTurn)}** billable tokens/turn over ${tr?.nTurns ?? 0} turns (${fmtTok(tr?.totalCacheRead)} tokens served from warm cache)`,
		);
		if (tokens.nPairs >= 2) {
			// Turn-matched estimator available (tee run): lead with it. Each pair is
			// the same real request billed under both arms, so the total is exact and
			// the CI is the tight paired-bootstrap interval.
			const pci = tokens.reclaimedPerTurnPairedCI ?? {};
			L.push(
				`- **reclaimed (turn-matched): ${fmtTok(tokens.reclaimedPerTurnPaired)} tokens/turn** [${fmtTok(pci.lo)}, ${fmtTok(pci.hi)}]${tokens.pctLessPaired != null ? ` — ${fmtPct(tokens.pctLessPaired)} less than baseline` : ""} (${tokens.nPairs} paired turns, paired bootstrap)`,
			);
			L.push(
				`- reclaimed total: ${fmtTok(tokens.reclaimedTotalPaired)} tokens (exact — sum over ${tokens.nPairs} matched pairs)`,
			);
			L.push(
				`- _unpaired pooled cross-check: ${fmtTok(tokens.reclaimedPerTurn)} tokens/turn [${fmtTok(ci.lo)}, ${fmtTok(ci.hi)}]_`,
				"",
			);
		} else {
			const reclaimLine =
				tokens.reclaimedPerTurn == null
					? "- reclaimed: n/a"
					: `- **reclaimed: ${fmtTok(tokens.reclaimedPerTurn)} tokens/turn** [${fmtTok(ci.lo)}, ${fmtTok(ci.hi)}]${tokens.pctLessPerTurn != null ? ` — ${fmtPct(tokens.pctLessPerTurn)} less than baseline` : ""}`;
			L.push(reclaimLine);
			L.push(
				`- reclaimed total: ${fmtTok(tokens.reclaimedTotal)} tokens${tokens.reclaimedTotalIsProjected ? " (projected — arms not turn-matched; per-turn rate above is the measured figure)" : ""}`,
				"",
			);
		}
		L.push(
			"> Honest read: the win is conditional on idle gaps. On a tight loop with no idle time the baseline caches well too, so reclaim trends to ~0 (no regression); it grows as gaps cross the 5-min / 60-min eviction boundaries. Lead with the regime, never a context-free number.",
			"",
		);
		L.push(
			"_Cost detail below is an appendix for the curious — verify base rates against anthropic.com/pricing before citing any dollar figure. The product story is tokens/quota, not dollars._",
			"",
		);
	}

	L.push("## Savings vs passthrough (per gap bucket)", "");
	L.push(
		`Positive = cheaper than passthrough. 95% CI in brackets. Buckets with < ${MIN_REPORTABLE_N} turns in either arm are flagged \`insufficient\` — savings %, especially its CI, is meaningless on a near-zero or tiny baseline (raw values are still in summary.json).`,
		"",
	);
	L.push(
		"| knobProfile | gap bucket | n (treat/base) | base $/turn | treat $/turn | savings | 95% CI |",
	);
	L.push("|---|---|---|---|---|---|---|");
	for (const s of savings) {
		const ok =
			s.nBase >= MIN_REPORTABLE_N &&
			s.nTreat >= MIN_REPORTABLE_N &&
			s.meanBaseUsd > 1e-4;
		const sav = ok ? fmtPct(s.savingsPct.mean) : "insufficient";
		const ci = ok
			? `[${fmtPct(s.savingsPct.lo)}, ${fmtPct(s.savingsPct.hi)}]`
			: "—";
		L.push(
			`| ${s.knobProfile} | ${s.gapBucket} | ${s.nTreat}/${s.nBase} | ${fmtUsd(s.meanBaseUsd)} | ${fmtUsd(s.meanTreatUsd)} | ${sav} | ${ci} |`,
		);
	}
	if (savings.length === 0)
		L.push("| _(no paired passthrough + treatment buckets found)_ |||||||");
	L.push("");

	L.push("## Per-arm detail", "");
	L.push(
		"| knobProfile | arm | gap bucket | n | $/turn [95% CI] | hit rate [95% CI] | net $/turn |",
	);
	L.push("|---|---|---|---|---|---|---|");
	for (const a of arms) {
		const u = a.meanUsdPerTurn;
		const h = a.meanCacheHitRate;
		const hr =
			h.mean == null
				? "n/a"
				: `${(h.mean * 100).toFixed(1)}% [${(h.lo * 100).toFixed(1)}, ${(h.hi * 100).toFixed(1)}]`;
		L.push(
			`| ${a.knobProfile} | ${a.arm} | ${a.gapBucket} | ${a.nTurns} | ${fmtUsd(u.mean)} [${fmtUsd(u.lo)}, ${fmtUsd(u.hi)}] | ${hr} | ${fmtUsd(a.netUsdPerTurn)} |`,
		);
	}
	L.push("");
	L.push(
		"## Prefix fragmentation (distinct session keys per system prefix)",
		"",
	);
	L.push(
		"1 = one logical context maps to one Anthropic cache key (ideal). >1 = the same context was split across keys, each cold-starting Anthropic's cache; strip-ephemeral collapses this toward 1.",
		"",
	);
	if (prefixFragmentation?.length) {
		L.push("| knobProfile | system prefix | distinct session keys |");
		L.push("|---|---|---|");
		for (const f of prefixFragmentation) {
			const flag = f.distinctSessionKeys > 1 ? " ⚠️" : "";
			L.push(
				`| ${f.knobProfile} | \`${f.systemStableKey}\` | ${f.distinctSessionKeys}${flag} |`,
			);
		}
		L.push("");
	} else {
		L.push("_(no systemStableKey present in turn-logs)_", "");
	}

	const pingRows = arms.filter((a) => (a.meanPingsSincePrevTurn ?? 0) > 0);
	if (pingRows.length) {
		L.push("## Keep-alive ping coverage", "");
		L.push(
			"Share of turns preceded by >=1 keep-alive ping during the gap, plus mean pings/turn. High coverage on a >5-min gap bucket alongside a high hit rate is keep-alive keeping the cache warm (the warmth test).",
			"",
		);
		L.push(
			"| knobProfile | arm | gap bucket | ping coverage | mean pings/turn |",
		);
		L.push("|---|---|---|---|---|");
		for (const a of pingRows) {
			L.push(
				`| ${a.knobProfile} | ${a.arm} | ${a.gapBucket} | ${fmtPct((a.pingCoverageShare ?? 0) * 100)} | ${(a.meanPingsSincePrevTurn ?? 0).toFixed(2)} |`,
			);
		}
		L.push("");
	}

	fs.writeFileSync(file, L.join("\n"));
}

// ---- main -------------------------------------------------------------

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.outDir) {
		process.stdout.write(
			"usage: node benchmark/bin/analyze.js --out <dir> [--label name=path] [--seed n] [--bootstrap n] [--warmup n] <input...>\n",
		);
		process.exit(args.outDir ? 0 : 2);
	}
	const pricing = loadPricing(args.pricing);
	const sources = resolveSources(args);
	const { turns: allTurns, pings, perSource } = loadTurns(sources, pricing);
	// Gaps on the FULL timeline first, THEN drop each arm's warm-up turns so a
	// kept turn keeps its true intra-arm gap (carry-over guard).
	assignGaps(allTurns, pings);
	const turns = discardWarmup(allTurns, args.warmup);
	const nDiscarded = allTurns.length - turns.length;
	const prefixFragmentation = computePrefixFragmentation(turns);
	const { arms, savings } = aggregate(turns, pings, {
		seed: args.seed,
		iters: args.bootstrap,
	});
	const tokens = aggregateTokens(turns, {
		seed: args.seed,
		iters: args.bootstrap,
	});

	fs.mkdirSync(args.outDir, { recursive: true });
	const generatedAt = new Date().toISOString();
	const versions = [
		...new Set(turns.map((t) => t.clawbackVersion).filter(Boolean)),
	];

	writeCsv(path.join(args.outDir, "report.csv"), turns, pricing.hash);

	const summary = {
		prefixFragmentation,
		generatedAt,
		seed: args.seed,
		bootstrap: args.bootstrap,
		warmup: args.warmup,
		nDiscarded,
		pricingHash: pricing.hash,
		clawbackVersions: versions,
		nTurns: turns.length,
		nPings: pings.length,
		tokens,
		arms,
		savings,
	};
	fs.writeFileSync(
		path.join(args.outDir, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);

	const manifest = {
		generatedAt,
		seed: args.seed,
		bootstrap: args.bootstrap,
		warmup: args.warmup,
		nDiscarded,
		pricingHash: pricing.hash,
		pricingVersion: pricing.table.version,
		pricingTable: pricing.table,
		clawbackVersions: versions,
		inputs: [...perSource.entries()].map(([p, s]) => ({
			path: p,
			knobProfile: s.label,
			nRecords: s.nRecords,
			arms: [...s.arms].sort(),
			minTs: s.minTs,
			maxTs: s.maxTs,
		})),
	};
	fs.writeFileSync(
		path.join(args.outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);

	writeReportMd(
		path.join(args.outDir, "report.md"),
		{ arms, savings, prefixFragmentation, tokens },
		{
			generatedAt,
			pricingHash: pricing.hash,
			iters: args.bootstrap,
			seed: args.seed,
			nTurns: turns.length,
			nPings: pings.length,
		},
	);

	process.stdout.write(
		`analyzed ${turns.length} turns (+${pings.length} pings) from ${sources.length} source(s)` +
			`${nDiscarded ? `, dropped ${nDiscarded} warm-up turn(s) [--warmup ${args.warmup}]` : ""}` +
			` -> ${args.outDir}\n`,
	);
}

// Run only when executed directly (`node analyze.js ...`), not when imported by
// a test. Comparing the module URL to argv[1]'s file URL is the robust ESM
// equivalent of `require.main === module`.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
