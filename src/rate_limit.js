const INT_HEADERS = [
	"anthropic-ratelimit-requests-limit",
	"anthropic-ratelimit-requests-remaining",
	"anthropic-ratelimit-tokens-limit",
	"anthropic-ratelimit-tokens-remaining",
	"anthropic-ratelimit-input-tokens-limit",
	"anthropic-ratelimit-input-tokens-remaining",
	"anthropic-ratelimit-output-tokens-limit",
	"anthropic-ratelimit-output-tokens-remaining",
];

const RESET_HEADERS = [
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-reset",
	"anthropic-ratelimit-input-tokens-reset",
	"anthropic-ratelimit-output-tokens-reset",
];

export function parseRateLimit(headers) {
	const out = {};
	for (const name of INT_HEADERS) {
		const raw = headers[name];
		if (raw != null) {
			const n = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
			if (!Number.isNaN(n)) out[toKey(name)] = n;
		}
	}
	for (const name of RESET_HEADERS) {
		const raw = headers[name];
		if (raw != null) {
			const v = Array.isArray(raw) ? raw[0] : raw;
			const d = new Date(v);
			if (!Number.isNaN(d.getTime())) out[toKey(name)] = d.toISOString();
		}
	}
	const ra = headers["retry-after"];
	if (ra != null) {
		const raw = Array.isArray(ra) ? ra[0] : ra;
		const n = Number.parseInt(raw, 10);
		if (!Number.isNaN(n)) {
			out.retry_after_seconds = n;
		} else {
			const d = new Date(raw);
			if (!Number.isNaN(d.getTime())) {
				out.retry_after_seconds = Math.max(
					0,
					Math.round((d.getTime() - Date.now()) / 1000),
				);
			}
		}
	}
	return out;
}

export function formatDuration(ms) {
	if (ms == null || Number.isNaN(ms)) return "?";
	const abs = Math.abs(ms);
	const s = Math.round(abs / 1000);
	const sign = ms < 0 ? "-" : "";
	if (s < 60) return `${sign}${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${sign}${m}m`;
	const h = Math.floor(m / 60);
	const remMin = m % 60;
	return remMin ? `${sign}${h}h${remMin}m` : `${sign}${h}h`;
}

export function tokensResetIso(headers) {
	const raw = headers["anthropic-ratelimit-tokens-reset"];
	if (raw == null) return null;
	const v = Array.isArray(raw) ? raw[0] : raw;
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString();
}

function toKey(headerName) {
	return headerName.replace(/^anthropic-ratelimit-/, "").replace(/-/g, "_");
}
