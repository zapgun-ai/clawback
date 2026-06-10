/**
 * In-memory ring buffer of recent clawback events.
 *
 * Plan §26 (avenue D): clawback's own UI surfaces operationally
 * interesting transitions ("passthrough toggled", "auto-continue
 * fired", "401 → auth-stale", "fragmentation collapse on boot",
 * "mobile mode activated") so the operator has visibility without
 * needing to grep logs. The ring buffer is process-local and not
 * persisted — events represent runtime activity, not durable state.
 *
 * Cap is a constant to keep the surface tiny. ~200 events × short
 * messages = a few KB. Older entries fall off when newer ones land.
 *
 * Read by `GET /_proxy/events` and the UI's "clawback events" card.
 */

const MAX_EVENTS = 200;

const ring = [];

export function appendEvent({ type, text, sessionKey = null, meta = null }) {
	if (typeof type !== "string" || typeof text !== "string") return;
	const entry = {
		ts: new Date().toISOString(),
		type,
		text,
		sessionKey,
		meta,
	};
	ring.push(entry);
	if (ring.length > MAX_EVENTS) {
		ring.splice(0, ring.length - MAX_EVENTS);
	}
}

export function listEvents({ limit = MAX_EVENTS, since = null } = {}) {
	let out = ring;
	if (since) {
		const cutoff = new Date(since).getTime();
		if (!Number.isNaN(cutoff)) {
			out = out.filter((e) => Date.parse(e.ts) > cutoff);
		}
	}
	if (limit > 0 && out.length > limit) {
		out = out.slice(-limit);
	}
	// Return newest-first for the UI; cheaper to slice + reverse than
	// to maintain a reverse-ordered ring.
	return [...out].reverse();
}

export function clearEvents() {
	ring.length = 0;
}

export function _getRing() {
	return ring;
}
