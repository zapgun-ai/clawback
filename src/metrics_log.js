/**
 * Per-session in-memory metric sample rings.
 *
 * PLAN §33 (original): one global 2000-sample ring for the web UI's
 * normalized time-series chart.
 *
 * PLAN §39 (Phase 1, 2026-05-15): partitioned by clawback session id.
 * Each session has its own ~500-sample ring; up to MAX_SESSIONS distinct
 * sessions are tracked, with LRU eviction by last-write time when the
 * cap is exceeded. Samples carry their `sessionKey` so the Phase 2 UI
 * can render per-session overlays alongside the aggregate.
 *
 * Back-compat: callers that don't pass a `sessionKey` route to the
 * `_aggregate` bucket. This keeps the legacy `/_proxy/statusline` POST
 * path (no per-session URL) producing samples the way it did pre-§39.
 *
 * Process-local, not persisted. Phase 3 (PLAN §34) will move this to
 * SQLite for durability across restarts.
 */

export const AGGREGATE_KEY = "_aggregate";
export const MAX_SAMPLES_PER_SESSION = 500;
export const MAX_SESSIONS = 64;

const METRIC_FIELDS = ["context", "next", "week", "hit", "turn", "tps", "ttft"];

/**
 * `Map<sessionKey, { samples, lastWriteMs }>`. Insertion order is
 * mostly LRU but we re-stamp `lastWriteMs` on every append, so eviction
 * picks the actually-oldest writer rather than the first-created.
 */
const rings = new Map();

function getRing(sessionKey) {
	let ring = rings.get(sessionKey);
	if (!ring) {
		// Stamp lastWriteMs at creation so a brand-new ring isn't picked
		// as its own eviction victim when maybeEvict runs below.
		ring = { samples: [], lastWriteMs: Date.now() };
		rings.set(sessionKey, ring);
		maybeEvict();
	}
	return ring;
}

function maybeEvict() {
	if (rings.size <= MAX_SESSIONS) return;
	let victimKey = null;
	let oldest = Number.POSITIVE_INFINITY;
	for (const [key, ring] of rings) {
		if (ring.lastWriteMs < oldest) {
			oldest = ring.lastWriteMs;
			victimKey = key;
		}
	}
	if (victimKey != null) rings.delete(victimKey);
}

/**
 * Append a sample to the per-session ring (or `_aggregate` if no
 * `sessionKey` is provided).
 *
 * `source` is "statusline" or "upstream". All metric fields are
 * optional — pass null for unobserved ones. A sample where every
 * metric field is null is dropped (defensive: avoids spurious
 * "phantom turn" dots on the chart).
 *
 * `mode` is a snapshot of the runtime toggles at append time. Shape
 * mirrors `passthroughStatus`:
 *   { passthrough, keepAliveEnabled, stripEphemeralFromSystem }.
 *
 * `label` is the operator-supplied or auto-derived display name for
 * the session, copied onto the sample so the UI can render filter
 * buttons without joining against another endpoint. Set once per
 * session by the first sample (subsequent samples may overwrite if
 * the operator changes the label via POST /_proxy/sessions/<id>).
 */
export function appendSample({
	source,
	sessionKey = AGGREGATE_KEY,
	label = null,
	ts = null,
	context = null,
	next = null,
	week = null,
	hit = null,
	turn = null,
	tps = null,
	ttft = null,
	mode = null,
} = {}) {
	if (source !== "statusline" && source !== "upstream") return;
	const entry = {
		ts: ts ?? new Date().toISOString(),
		source,
		sessionKey,
		label,
		context,
		next,
		week,
		hit,
		turn,
		tps,
		ttft,
		mode,
	};
	const hasAny = METRIC_FIELDS.some((k) => {
		const v = entry[k];
		return typeof v === "number" && Number.isFinite(v);
	});
	if (!hasAny) return;
	const ring = getRing(sessionKey);
	ring.samples.push(entry);
	ring.lastWriteMs = Date.now();
	if (ring.samples.length > MAX_SAMPLES_PER_SESSION) {
		ring.samples.splice(0, ring.samples.length - MAX_SAMPLES_PER_SESSION);
	}
}

/**
 * Returns samples in chronological order (oldest first). With no
 * `session` filter, samples from every ring are merged and sorted by
 * `ts`. With `session`, only that ring is returned.
 *
 * `since` filters to samples strictly after the given ISO timestamp;
 * `limit` caps the returned slice to the N most recent.
 *
 * Returns defensive shallow copies — callers can't mutate the rings.
 */
export function listSamples({
	session = null,
	since = null,
	limit = MAX_SAMPLES_PER_SESSION * MAX_SESSIONS,
} = {}) {
	let out;
	if (session != null) {
		const ring = rings.get(session);
		out = ring ? ring.samples.slice() : [];
	} else {
		out = [];
		for (const ring of rings.values()) {
			out.push(...ring.samples);
		}
		out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	}
	if (since) {
		const cutoff = Date.parse(since);
		if (!Number.isNaN(cutoff)) {
			out = out.filter((s) => Date.parse(s.ts) > cutoff);
		}
	}
	if (limit > 0 && out.length > limit) {
		out = out.slice(-limit);
	}
	return out.map((s) => ({ ...s }));
}

/**
 * Clear samples. With no `session`, clears every ring (returns total
 * removed). With `session`, clears just that ring.
 */
export function clearSamples({ session = null } = {}) {
	if (session != null) {
		const ring = rings.get(session);
		if (!ring) return 0;
		const removed = ring.samples.length;
		ring.samples.length = 0;
		return removed;
	}
	let removed = 0;
	for (const ring of rings.values()) {
		removed += ring.samples.length;
		ring.samples.length = 0;
	}
	rings.clear();
	return removed;
}

/**
 * Returns a `[{sessionKey, label, sampleCount, firstSeenMs, lastWriteMs}]`
 * snapshot for `/_proxy/sessions` to merge with the durable session
 * record. Ordered by `lastWriteMs` descending.
 */
export function listSessionSummaries() {
	const rows = [];
	for (const [sessionKey, ring] of rings) {
		const samples = ring.samples;
		if (samples.length === 0) continue;
		const first = samples[0];
		const last = samples[samples.length - 1];
		rows.push({
			sessionKey,
			label: last.label ?? first.label ?? null,
			sampleCount: samples.length,
			firstTs: first.ts,
			lastTs: last.ts,
			lastWriteMs: ring.lastWriteMs,
		});
	}
	rows.sort((a, b) => b.lastWriteMs - a.lastWriteMs);
	return rows;
}
