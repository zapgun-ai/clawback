import zlib from "node:zlib";

const USAGE_FIELDS = [
	"input_tokens",
	"output_tokens",
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
];

/**
 * Build a body tap that observes the `usage` block in the upstream
 * response. The tap accepts the raw on-the-wire bytes (encoded if
 * Anthropic returned `Content-Encoding: gzip`/`br`/`deflate`) and
 * decodes internally before parsing. Without this, gzipped responses
 * silently broke hit-rate telemetry — the symptom we hit on
 * 2026-05-05 across all OAuth-tier sessions.
 *
 * Emission contract (PLAN §37): callback fires AT MOST ONCE per response,
 * only on turn completion — never on mid-stream events. JSON path emits
 * when the buffered body parses cleanly on `done=true`. SSE path emits on
 * `message_delta` carrying a `stop_reason` (final event before
 * `message_stop`); `message_start` is used only to capture `id` and seed
 * the initial usage snapshot. An aborted SSE stream (no `message_delta`
 * with stop_reason) emits nothing — required so PLAN §37 consumers don't
 * persist a "safe prefix" boundary for a turn the user never saw.
 */
export function createBodyTap({
	contentType,
	contentEncoding = null,
	onMessage,
}) {
	const ct = (contentType || "").toLowerCase();
	const isSse = ct.includes("text/event-stream");
	const isJson = ct.includes("application/json");
	if (!isSse && !isJson) return null;

	const enc = String(contentEncoding || "")
		.toLowerCase()
		.trim();

	let emitted = false;
	const emit = ({ id = null, usage = null, stopReason = null }) => {
		if (emitted) return;
		// We require *some* usage signal to emit at all — without it the
		// callback has nothing telemetry- or contract-shaped to act on.
		if (!usage || typeof usage !== "object") return;
		if (!USAGE_FIELDS.some((f) => usage[f] != null)) return;
		emitted = true;
		try {
			onMessage({ id, usage, stopReason });
		} catch {
			/* swallow — telemetry must never break the response */
		}
	};

	if (isJson) {
		const chunks = [];
		let total = 0;
		const MAX = 4 * 1024 * 1024;
		return (chunk, done) => {
			if (chunk && total < MAX) {
				chunks.push(chunk);
				total += chunk.length;
			}
			if (done) {
				try {
					const raw = Buffer.concat(chunks);
					const decoded = decodeBuffer(raw, enc);
					if (decoded == null) return;
					const parsed = JSON.parse(decoded.toString("utf8"));
					emit({
						id: typeof parsed?.id === "string" ? parsed.id : null,
						usage: parsed?.usage,
						stopReason:
							typeof parsed?.stop_reason === "string"
								? parsed.stop_reason
								: null,
					});
				} catch {
					/* non-JSON, decode failure, or oversize — skip */
				}
			}
		};
	}

	// SSE path: needs a streaming decoder so we can parse events as
	// they arrive without buffering the whole stream. We accumulate id
	// and usage from `message_start`, then emit once on `message_delta`
	// with a stop_reason — never on partial state.
	const decoder = makeStreamDecoder(enc);
	let buffer = "";
	const sseState = { id: null, usage: null };

	const onSseEvent = (parsed) => {
		if (emitted) return;
		if (parsed?.type === "message_start") {
			if (typeof parsed.message?.id === "string") {
				sseState.id = parsed.message.id;
			}
			if (parsed.message?.usage && typeof parsed.message.usage === "object") {
				sseState.usage = parsed.message.usage;
			}
			return;
		}
		if (parsed?.type === "message_delta") {
			const stopReason = parsed?.delta?.stop_reason ?? null;
			if (typeof stopReason !== "string") return;
			// message_delta.usage carries the FINAL usage totals; merge it
			// over the message_start snapshot so cache_* fields (set at
			// message_start) and output_tokens (set at message_delta) both
			// reach the consumer in one event.
			const merged = {
				...(sseState.usage || {}),
				...(parsed.usage && typeof parsed.usage === "object"
					? parsed.usage
					: {}),
			};
			emit({ id: sseState.id, usage: merged, stopReason });
		}
	};

	const consume = (text, done) => {
		buffer += text;
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			processSseEvent(raw, onSseEvent);
			if (emitted) {
				buffer = "";
				return;
			}
			idx = buffer.indexOf("\n\n");
		}
		if (done && buffer.length) {
			processSseEvent(buffer, onSseEvent);
			buffer = "";
		}
	};

	if (!decoder) {
		return (chunk, done) => {
			if (chunk) consume(chunk.toString("utf8"), false);
			if (done) consume("", true);
		};
	}

	let decoderEnded = false;
	decoder.on("data", (chunk) => {
		if (emitted) return;
		try {
			consume(chunk.toString("utf8"), false);
		} catch {}
	});
	decoder.on("end", () => {
		decoderEnded = true;
		try {
			consume("", true);
		} catch {}
	});
	decoder.on("error", () => {
		decoderEnded = true;
		/* swallow — telemetry must never break the response */
	});

	return (chunk, done) => {
		if (decoderEnded) return done ? Promise.resolve() : undefined;
		if (chunk) {
			try {
				decoder.write(chunk);
			} catch {}
		}
		if (done) {
			// zlib flushes asynchronously: the chunk carrying `message_delta`
			// (and thus the turn's final usage) can still be queued inside the
			// decoder when the caller signals end-of-stream. Return a promise
			// that settles once the decoder has drained, so the proxy can await
			// usage capture before resolving the request and writing the
			// turn-log. Without this, gzip/br responses race the turn-log write
			// and persist usage:null on completed turns.
			return new Promise((resolve) => {
				const finish = () => resolve();
				decoder.once("end", finish);
				decoder.once("error", finish);
				try {
					decoder.end();
				} catch {
					finish();
				}
			});
		}
	};
}

function decodeBuffer(buf, encoding) {
	if (!encoding || encoding === "identity") return buf;
	try {
		if (encoding === "gzip" || encoding === "x-gzip")
			return zlib.gunzipSync(buf);
		if (encoding === "deflate") return zlib.inflateSync(buf);
		if (encoding === "br") return zlib.brotliDecompressSync(buf);
	} catch {
		return null;
	}
	return null;
}

function makeStreamDecoder(encoding) {
	if (!encoding || encoding === "identity") return null;
	if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
	if (encoding === "deflate") return zlib.createInflate();
	if (encoding === "br") return zlib.createBrotliDecompress();
	return null;
}

function processSseEvent(raw, onEvent) {
	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			onEvent(JSON.parse(data));
		} catch {
			/* ignore malformed frame */
		}
	}
}

export function applyUsageToSession(prev, usage, now) {
	if (!prev) return prev;
	const add = (base, key) =>
		(base ?? 0) + (typeof usage?.[key] === "number" ? usage[key] : 0);
	return {
		...prev,
		cacheCreationTokens: add(
			prev.cacheCreationTokens,
			"cache_creation_input_tokens",
		),
		cacheReadTokens: add(prev.cacheReadTokens, "cache_read_input_tokens"),
		cacheMissTokens: add(prev.cacheMissTokens, "input_tokens"),
		lastCacheSampleAt: now,
	};
}
