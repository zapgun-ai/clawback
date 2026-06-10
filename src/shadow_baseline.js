import http from "node:http";
import https from "node:https";
import { createBodyTap } from "./telemetry.js";

// Headers we never forward verbatim: hop-by-hop (RFC 7230 §6.1) plus
// content-length, which we recompute for the body we actually replay, plus
// x-api-key, which clawback never relays (security/legal — see proxy.js
// STRIP_REQUEST_HEADERS; the shadow must not relay it either).
const DROP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
	"x-api-key",
]);

/**
 * Build the headers for the shadow (passthrough-baseline) request.
 *
 * Start from the client's own headers — we MUST forward the same OAuth
 * bearer and `anthropic-*` headers the real request carried, or the
 * baseline wouldn't bill against the same account/tier. Drop hop-by-hop,
 * then set `host` + `content-length` for the pristine body we're
 * replaying.
 *
 * We add NOTHING Anthropic could correlate back to clawback: no pairing,
 * correlation, or clawback header crosses the wire. The pairSeq that ties
 * the two turn-log records together lives only in clawback's own log
 * (CLAUDE.md: "I don't want to send a header that Anthropic could see").
 */
export function shadowRequestHeaders(clientHeaders, { host, contentLength }) {
	const out = {};
	for (const [k, v] of Object.entries(clientHeaders || {})) {
		if (DROP_HEADERS.has(k.toLowerCase())) continue;
		out[k] = v;
	}
	out.host = host;
	if (contentLength != null) out["content-length"] = contentLength;
	return out;
}

/**
 * Fire ONE passthrough shadow request: replay the pristine Claude Code body
 * upstream, tap its `usage`, and discard the response body. This is the
 * in-proxy twin of the benchmark tee's shadow arm — it captures the
 * no-clawback baseline WITHOUT forfeiting the armed knobs on the primary
 * path the user is actually working in.
 *
 * Fire-and-forget by contract: the returned promise NEVER rejects (every
 * failure resolves to `{ ok: false, reason }`), and callers must NOT await
 * it on the request hot path. A slow, throttled, or broken shadow can then
 * never delay or break the primary stream the user sees.
 *
 * COST: this is a SECOND billable request per turn (~2x quota for the
 * capture window) — the caller owns the guard + the operator warning. It
 * also adds real load against the user's live Anthropic limits, which can
 * bring a 429 wall forward in their actual session; that is inherent to any
 * 2x measurement and is the price of a turn-matched baseline.
 */
export function fireShadowBaseline({
	upstreamBase,
	forwardPath,
	body,
	clientHeaders,
	timeoutMs,
	onUsage,
	logger,
}) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (r) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};

		let url;
		try {
			if (typeof forwardPath !== "string" || !forwardPath.startsWith("/")) {
				return done({ ok: false, reason: "bad-path" });
			}
			url = new URL(forwardPath, upstreamBase);
			// Same off-host defense as proxy.js: a protocol-relative target
			// (`//evil/x`) resolves to a different origin — refuse it so the
			// shadow can never replay the OAuth bearer to a stranger.
			if (url.origin !== new URL(upstreamBase).origin) {
				return done({ ok: false, reason: "off-host" });
			}
		} catch (e) {
			return done({ ok: false, reason: e.message });
		}

		const isHttps = url.protocol === "https:";
		const mod = isHttps ? https : http;
		const headers = shadowRequestHeaders(clientHeaders, {
			host: url.host,
			contentLength: body != null ? Buffer.byteLength(body) : undefined,
		});

		const req = mod.request(
			{
				method: "POST",
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				headers,
			},
			(res) => {
				const tap = createBodyTap({
					contentType: res.headers["content-type"],
					contentEncoding: res.headers["content-encoding"] ?? null,
					onMessage: ({ usage }) => {
						try {
							onUsage?.(usage, res.statusCode ?? null);
						} catch {
							/* telemetry must never break the shadow */
						}
					},
				});
				// We don't pipe anywhere — just drain so the socket frees, and
				// feed the tap so usage is observed.
				res.on("data", (chunk) => {
					if (tap) {
						try {
							tap(chunk, false);
						} catch {
							/* ignore */
						}
					}
				});
				res.on("end", async () => {
					if (tap) {
						try {
							await tap(null, true);
						} catch {
							/* ignore */
						}
					}
					done({ ok: true, status: res.statusCode ?? null });
				});
				res.on("error", (err) => {
					logger?.debug?.(`shadow response error (ignored): ${err.message}`);
					done({ ok: false, reason: err.message });
				});
			},
		);

		if (timeoutMs) {
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error(`shadow timeout after ${timeoutMs}ms`));
			});
		}
		req.on("error", (err) => {
			logger?.debug?.(`shadow request error (ignored): ${err.message}`);
			done({ ok: false, reason: err.message });
		});

		if (body != null) req.end(body);
		else req.end();
	});
}
