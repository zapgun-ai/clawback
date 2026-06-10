import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { jsonToSseEvents } from "./sse_reemit.js";

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
]);

// Never relayed upstream, no matter what the client sends. clawback is an
// OAuth-bearer proxy (Claude Max); relaying or storing an Anthropic API key
// is a security/legal liability, so x-api-key is dropped at the door — here
// on the forward path, and from the keep-alive auth store (server.js
// AUTH_HEADER_KEYS) and the shadow path (shadow_baseline.js DROP_HEADERS).
const STRIP_REQUEST_HEADERS = new Set(["x-api-key"]);

function sanitizeRequestHeaders(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		const lk = k.toLowerCase();
		if (HOP_BY_HOP.has(lk)) continue;
		if (STRIP_REQUEST_HEADERS.has(lk)) continue;
		out[k] = v;
	}
	return out;
}

function sanitizeResponseHeaders(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		const lk = k.toLowerCase();
		if (
			lk === "connection" ||
			lk === "keep-alive" ||
			lk === "transfer-encoding"
		)
			continue;
		out[k] = v;
	}
	return out;
}

export function proxyRequest({
	clientReq,
	clientRes,
	upstreamBase,
	forwardPath,
	body,
	bodyEncoding = null,
	reemitAsSse = false,
	timeoutMs,
	mutateResponseHeaders,
	logger,
}) {
	return new Promise((resolve) => {
		// Reject protocol-relative request targets: `new URL("//evil/x", base)`
		// resolves to `https://evil/x`, hijacking upstream away from the
		// configured Anthropic host. Node's HTTP parser accepts `//host/path`
		// as a request-target, so without this check a client can send
		// `GET //evil.com/v1/foo HTTP/1.1` and have clawback proxy the
		// request to evil.com (forwarding the client's headers). Tighten to
		// "must start with a single slash, not two."
		if (typeof forwardPath !== "string" || !forwardPath.startsWith("/")) {
			writeError(clientRes, 400, "bad_request", "invalid forward path");
			return resolve({ ok: false, status: 400 });
		}
		if (forwardPath.startsWith("//")) {
			writeError(
				clientRes,
				400,
				"bad_request",
				"protocol-relative request targets are rejected",
			);
			return resolve({ ok: false, status: 400 });
		}
		let upstreamUrl;
		try {
			upstreamUrl = new URL(forwardPath, upstreamBase);
		} catch (e) {
			writeError(clientRes, 502, "invalid_upstream", e.message);
			return resolve({ ok: false, status: 502, error: e });
		}
		// Defense in depth: even if the URL parser somehow yielded an
		// off-host result, refuse to forward to anything other than the
		// configured upstream's origin. Catches future parser quirks and
		// any input that resolves to a different host than upstreamBase.
		const expectedOrigin = new URL(upstreamBase).origin;
		if (upstreamUrl.origin !== expectedOrigin) {
			writeError(
				clientRes,
				400,
				"bad_request",
				"forward path resolves outside the configured upstream",
			);
			return resolve({ ok: false, status: 400 });
		}

		const isHttps = upstreamUrl.protocol === "https:";
		const mod = isHttps ? https : http;
		const headers = sanitizeRequestHeaders(clientReq.headers);
		headers.host = upstreamUrl.host;
		if (body !== undefined && body !== null) {
			headers["content-length"] = Buffer.byteLength(body);
		}
		if (bodyEncoding) {
			headers["content-encoding"] = bodyEncoding;
		}

		const opts = {
			method: clientReq.method,
			hostname: upstreamUrl.hostname,
			port: upstreamUrl.port || (isHttps ? 443 : 80),
			path: upstreamUrl.pathname + upstreamUrl.search,
			headers,
		};

		let upReqFinishedAt = null;
		let firstChunkAt = null;
		const ttftMs = () =>
			upReqFinishedAt != null && firstChunkAt != null
				? firstChunkAt - upReqFinishedAt
				: null;

		const upReq = mod.request(opts, (upRes) => {
			let responseHeaders = sanitizeResponseHeaders(upRes.headers);
			let extracted = null;
			let bodyTap = null;
			if (mutateResponseHeaders) {
				const result = mutateResponseHeaders(upRes.headers, upRes.statusCode);
				if (result) {
					responseHeaders = {
						...responseHeaders,
						...(result.headerOverrides ?? {}),
					};
					extracted = result.extracted ?? null;
					bodyTap =
						typeof result.bodyTap === "function" ? result.bodyTap : null;
				}
			}

			// Mobile-mode SSE re-emit: when clawback rewrote stream:true→false
			// going up, Anthropic returns a single JSON response. Buffer it,
			// translate to SSE event sequence, and emit that to the client (which
			// asked for and expects SSE). Skip on non-2xx so error bodies pass
			// through cleanly.
			const shouldReemit =
				reemitAsSse &&
				typeof upRes.statusCode === "number" &&
				upRes.statusCode >= 200 &&
				upRes.statusCode < 300;
			if (shouldReemit) {
				responseHeaders = rebuildHeadersForSseReemit(responseHeaders);
			}

			try {
				clientRes.writeHead(
					upRes.statusCode ?? 502,
					upRes.statusMessage ?? "",
					responseHeaders,
				);
			} catch (e) {
				upRes.destroy();
				return resolve({ ok: false, status: 502, error: e });
			}

			upRes.on("error", (err) => {
				logger?.warn(`upstream response error: ${err.message}`);
				clientRes.destroy(err);
			});

			clientRes.on("close", () => {
				if (!upRes.complete) upRes.destroy();
			});

			if (shouldReemit) {
				const buffered = [];
				const upstreamEncoding = (
					upRes.headers["content-encoding"] || ""
				).toLowerCase();
				upRes.on("data", (chunk) => {
					if (firstChunkAt == null) firstChunkAt = Date.now();
					buffered.push(chunk);
					if (bodyTap) {
						try {
							bodyTap(chunk, false);
						} catch {}
					}
				});
				upRes.on("end", async () => {
					if (bodyTap) {
						try {
							await bodyTap(null, true);
						} catch {}
					}
					try {
						const raw = Buffer.concat(buffered);
						const decoded = decodeUpstreamBody(raw, upstreamEncoding);
						const message = JSON.parse(decoded);
						const sse = jsonToSseEvents(message);
						clientRes.end(sse);
					} catch (e) {
						logger?.warn(`SSE re-emit failed: ${e.message}`);
						// Fall back: dump the raw bytes so the client sees something
						// rather than a hung stream.
						try {
							clientRes.end(Buffer.concat(buffered));
						} catch {}
					}
					resolve({
						ok: true,
						status: upRes.statusCode,
						extracted,
						ttftMs: ttftMs(),
					});
				});
				upRes.on("close", () => {
					if (!upRes.complete)
						resolve({
							ok: false,
							status: upRes.statusCode,
							extracted,
							ttftMs: ttftMs(),
						});
				});
				return;
			}

			upRes.on("data", (chunk) => {
				if (firstChunkAt == null) firstChunkAt = Date.now();
				if (bodyTap) {
					try {
						bodyTap(chunk, false);
					} catch {
						/* telemetry must not break the response */
					}
				}
			});
			upRes.pipe(clientRes);
			upRes.on("end", async () => {
				if (bodyTap) {
					try {
						// Await: for compressed responses the tap decodes async,
						// and usage lands only after the decoder drains. The client
						// already has every byte (pipe is independent of this), so
						// this only delays the proxy's own resolution / turn-log
						// write until usage has been observed.
						await bodyTap(null, true);
					} catch {
						/* ignore */
					}
				}
				resolve({
					ok: true,
					status: upRes.statusCode,
					extracted,
					ttftMs: ttftMs(),
				});
			});
			upRes.on("close", () => {
				if (!upRes.complete)
					resolve({
						ok: false,
						status: upRes.statusCode,
						extracted,
						ttftMs: ttftMs(),
					});
			});
		});

		upReq.on("finish", () => {
			upReqFinishedAt = Date.now();
		});

		if (timeoutMs) {
			upReq.setTimeout(timeoutMs, () => {
				upReq.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
			});
		}

		upReq.on("error", (err) => {
			// Post-completion socket errors are operationally benign: the
			// response was already proxied through to the client (200 was
			// logged), and the error fired afterwards from the underlying
			// TLS/TCP cleanup. The most common case is a "bad record mac"
			// (SSL alert 20) from Anthropic's edge during connection
			// teardown — Node's default https Agent reuses sockets, and
			// occasionally a stale TLS record races the close. We've
			// already resolved the proxy promise by this point, so all we
			// can do is log it. Demote from warn to debug so it doesn't
			// pollute the default-level log; operators chasing TLS issues
			// can re-enable visibility with --log-level debug.
			const postCompletion =
				clientRes.writableEnded ||
				clientRes.writableFinished ||
				(clientRes.headersSent && clientRes.statusCode < 400);
			if (postCompletion) {
				logger?.debug?.(
					`upstream socket error post-completion (already proxied): ${err.message}`,
				);
				return; // promise already resolved by the data/end handlers
			}
			logger?.warn(`upstream request error: ${err.message}`);
			if (!clientRes.headersSent)
				writeError(clientRes, 502, "upstream_error", err.message);
			else clientRes.destroy(err);
			resolve({ ok: false, error: err });
		});

		clientReq.on("close", () => {
			if (!clientReq.complete && !upReq.destroyed) upReq.destroy();
		});

		if (body !== undefined && body !== null) {
			upReq.end(body);
		} else {
			clientReq.pipe(upReq);
		}
	});
}

function writeError(res, status, code, message) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ type: "error", error: { type: code, message } }));
}

/**
 * Build the response headers we send to the client when re-emitting an
 * upstream JSON response as SSE. Strip content-encoding (we decoded
 * upstream bytes), strip content-length (we don't know the SSE size
 * yet and Anthropic's real streams are chunked anyway), and force the
 * SSE content-type the client originally asked for.
 */
function rebuildHeadersForSseReemit(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		const lk = k.toLowerCase();
		if (lk === "content-encoding") continue;
		if (lk === "content-length") continue;
		if (lk === "content-type") continue;
		out[k] = v;
	}
	out["content-type"] = "text/event-stream; charset=utf-8";
	out["cache-control"] = "no-cache";
	return out;
}

function decodeUpstreamBody(buf, encoding) {
	if (!encoding || encoding === "identity") return buf.toString("utf8");
	if (encoding === "gzip" || encoding === "x-gzip") {
		return zlib.gunzipSync(buf).toString("utf8");
	}
	if (encoding === "deflate") return zlib.inflateSync(buf).toString("utf8");
	if (encoding === "br") return zlib.brotliDecompressSync(buf).toString("utf8");
	throw new Error(`unsupported response encoding for SSE re-emit: ${encoding}`);
}
