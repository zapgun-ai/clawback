/**
 * Pure helpers for the per-metric chart aggregation logic (PLAN §39
 * Phase 2). No DOM access, no globals, no fetch — extracted so the
 * math can be unit-tested independently of the jsdom UI tests.
 *
 * Functions:
 *   computeAggregateSeries(samples, metric, includedSessions)
 *   perSessionSeries(samples, metric, sessionKey)
 *   sessionStyle(sessionKey)
 *   hashString(s)
 */

export const AGGREGATE_BUCKET = "_aggregate";

export const PALETTE = [
	"#4E79A7",
	"#F28E2C",
	"#E15759",
	"#76B7B2",
	"#59A14F",
	"#EDC949",
	"#AF7AA1",
	"#FF9DA7",
	"#9C755F",
	"#BAB0AC",
];

export const DASH_PATTERNS = ["none", "6 3", "2 3", "8 3 2 3"];

/** FNV-1a 32-bit hash. Stable across reloads. */
export function hashString(s) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export function sessionStyle(sessionKey) {
	if (sessionKey === AGGREGATE_BUCKET) {
		return { color: "var(--muted)", dash: "2 2", isLegacy: true };
	}
	const h = hashString(sessionKey);
	const color = PALETTE[h % PALETTE.length];
	const dash =
		DASH_PATTERNS[Math.floor(h / PALETTE.length) % DASH_PATTERNS.length];
	return { color, dash, isLegacy: false };
}

/**
 * Forward-fill carry across sessions. For each chronological sample
 * we update that session's running value, then emit the aggregator
 * across all sessions that have ever reported a value. This gives a
 * continuous aggregate even when sessions report at staggered
 * timestamps.
 *
 * `metric` is { key, aggregate } — `aggregate` ∈
 * {"mean", "weighted-mean", "max", null}. `null` returns [].
 *
 * `includedSessions` is a Set of sessionKeys to include — typically
 * the set of currently-visible session filters. Hidden sessions are
 * skipped so the operator's filter selection shapes the aggregate.
 *
 * Returns `[{ ts, value }]` chronologically.
 */
export function computeAggregateSeries(samples, metric, includedSessions) {
	if (!metric.aggregate) return [];
	const latest = new Map();
	const weights = new Map();
	const out = [];
	for (const s of samples) {
		const key = s.sessionKey ?? AGGREGATE_BUCKET;
		if (includedSessions && !includedSessions.has(key)) continue;
		const v = s[metric.key];
		if (typeof v === "number" && Number.isFinite(v)) {
			latest.set(key, v);
			weights.set(key, (weights.get(key) ?? 0) + 1);
		}
		if (latest.size === 0) continue;
		const agg = aggregate(metric.aggregate, latest, weights);
		if (agg != null && Number.isFinite(agg)) {
			out.push({ ts: s.ts, value: agg });
		}
	}
	return out;
}

function aggregate(kind, latest, weights) {
	switch (kind) {
		case "mean": {
			let sum = 0;
			let n = 0;
			for (const v of latest.values()) {
				sum += v;
				n++;
			}
			return n > 0 ? sum / n : null;
		}
		case "weighted-mean": {
			let num = 0;
			let den = 0;
			for (const [k, v] of latest) {
				const w = weights.get(k) ?? 1;
				num += v * w;
				den += w;
			}
			return den > 0 ? num / den : null;
		}
		case "max": {
			let max = Number.NEGATIVE_INFINITY;
			for (const v of latest.values()) {
				if (v > max) max = v;
			}
			return max === Number.NEGATIVE_INFINITY ? null : max;
		}
		default:
			return null;
	}
}

export function perSessionSeries(samples, metric, sessionKey) {
	const out = [];
	for (const s of samples) {
		const key = s.sessionKey ?? AGGREGATE_BUCKET;
		if (key !== sessionKey) continue;
		const v = s[metric.key];
		if (typeof v === "number" && Number.isFinite(v)) {
			out.push({ ts: s.ts, value: v });
		}
	}
	return out;
}
