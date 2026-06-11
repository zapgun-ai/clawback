import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import {
	handleAdmin,
	sampleModeSnapshot,
	tickBaselineCapture,
} from "./admin.js";
import { processObservation } from "./auto_continue.js";
import { injectIntoBody, resolvedTtlMode } from "./cache_control.js";
import { writeInput } from "./claude_input.js";
import { appendEvent } from "./events_log.js";
import { computeFingerprints, stripEphemeral } from "./fingerprint.js";
import { appendSample } from "./metrics_log.js";
import { proxyRequest } from "./proxy.js";
import {
	formatDuration,
	parseRateLimit,
	tokensResetIso,
} from "./rate_limit.js";
import { identifySession } from "./router.js";
import { fireShadowBaseline } from "./shadow_baseline.js";
import { applyUsageToSession, createBodyTap } from "./telemetry.js";
import { CLAWBACK_VERSION } from "./version.js";

// Length of the per-session TPS ring buffer. Serves two consumers:
//   1. Sparkline display (admin.js): reads the trailing SPARK_LEN (8)
//      samples for the statusline render.
//   2. Relative calibration (admin.js): when
//      statuslineTpsCalibration === "relative", uses the *full* ring
//      to compute a peak that anchors the red/yellow/green bands. Needs
//      enough samples to be stable across one-off cache-warm spikes.
// 32 is roughly 5-15 minutes of active claude usage — long enough that
// the per-model decode-rate peak settles, short enough that a session
// switching models eventually re-anchors. 32 floats = 256 bytes per
// session in state.json, which is fine.
const TPS_RING_LEN = 32;

// Per-session ring of time-to-first-token (ms) for the same statusline
// sparkline width. TTFT is the cleanest cache-warmth signal we have:
// warm cache → low TTFT (~100-500ms), cold → high (~1000-3000ms). Unlike
// tps it doesn't need a min-tokens filter — TTFT is meaningful for
// every kind of turn, including tool-call-only responses.
const TTFT_RING_LEN = 8;

// Minimum output_tokens for a response to feed the recentTps ring.
// Below this, the response is almost certainly a tool-call-only turn
// or a tiny acknowledgement, where output_tokens / wall_seconds is
// noise — usually pulled to ~1 by short generations. The actual
// generation rate the operator cares about always produces well over
// this many output tokens, so the threshold drops noise without
// affecting normal turns.
const TPS_MIN_OUTPUT_TOKENS = 20;

// Minimum generation-window denominator (ms) for the tps calculation.
// `tps = output_tokens / ((elapsed - ttftMs) / 1000)` — when the cache
// is warm and the response is short, `elapsed - ttftMs` can be near
// zero, yielding absurdly large or `Infinity` rates. Floor it so the
// signal stays bounded.
const TPS_MIN_GENERATION_MS = 50;

const AUTH_HEADER_KEYS = [
	"authorization",
	"anthropic-version",
	"anthropic-beta",
	"anthropic-dangerous-direct-browser-access",
	"user-agent",
	"x-stainless-arch",
	"x-stainless-lang",
	"x-stainless-package-version",
	"x-stainless-os",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
];

export function createServer({
	config,
	store,
	scheduler,
	logger,
	turnLog,
	uiServer,
	reportServer,
}) {
	// One-shot body-capture controller for the TEST harness (`--capture-body
	// <path>`). Created once here so its `done` latch persists across
	// requests; null when the knob is off. See maybeCaptureBody.
	const bodyCapture = config.captureBodyPath
		? { path: config.captureBodyPath, done: false }
		: null;
	// One-shot latch for the byte-faithfulness canary's loud warning. Created
	// once here so the warning fires at most once per process (a non-canonical
	// client is non-canonical on every turn — no point spamming the log). The
	// per-turn fallback DECISION is still made fresh each request; only the
	// WARNING is throttled. See maybeCanaryFallback / warnCanaryOnce.
	const canaryGuard = { warned: false };
	const requestListener = (req, res) => {
		handle(req, res, {
			config,
			store,
			scheduler,
			logger,
			turnLog,
			uiServer,
			reportServer,
			bodyCapture,
			canaryGuard,
		}).catch((err) => {
			logger.error("unhandled request error:", err.stack ?? err.message);
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						type: "error",
						error: { type: "internal_error", message: err.message },
					}),
				);
			} else {
				res.destroy();
			}
		});
	};

	const onClientError = (err, socket) => {
		logger.debug(`client error: ${err.message}`);
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	};

	// Plain-HTTP mode (back-compat): one http.Server, no dispatcher.
	if (!config.tls) {
		const server = http.createServer(requestListener);
		server.on("clientError", onClientError);
		return server;
	}

	// TLS mode: single port, two protocols. A net.Server peeks the first
	// byte of each accepted socket and routes:
	//   - 0x16 (TLS handshake)   → the real https.Server
	//   - anything else (HTTP)   → a tiny http.Server that 308-redirects
	//                              to https://<host:port><path>
	//
	// 308 is deliberate: 301/302 cause non-safe-method clients to downgrade
	// POSTs to GETs (RFC 7231). 308 preserves method + body, which is what
	// /v1/messages forwarders need.
	let tlsOptions;
	try {
		tlsOptions = {
			cert: fs.readFileSync(config.tlsCertFile),
			key: fs.readFileSync(config.tlsKeyFile),
		};
	} catch (e) {
		throw new Error(
			`tls=true but cert/key files are unreadable: ${e.message} (run \`clawback init-cert\` or point --tls-cert / --tls-key at an existing pair)`,
		);
	}

	const httpsServer = https.createServer(tlsOptions, requestListener);
	httpsServer.on("clientError", onClientError);

	const redirectServer = http.createServer((req, res) => {
		// Rewrite the Host header's port to match the actual TLS-bound
		// port. Use `req.socket.localPort` rather than `config.port` so
		// the redirect target is correct when the operator passed
		// `port: 0` (OS-assigned), or when a load balancer translates
		// ports in front of clawback.
		const localPort = req.socket?.localPort ?? config.port;
		const rawHost = req.headers.host || `${config.host}:${localPort}`;
		const hostWithoutPort = rawHost.replace(/:\d+$/, "");
		const target = `https://${hostWithoutPort}:${localPort}${req.url}`;
		res.writeHead(308, {
			location: target,
			"content-type": "text/plain; charset=utf-8",
			"x-clawback-upgrade": "https",
		});
		res.end(`Redirecting to ${target}\n`);
	});
	redirectServer.on("clientError", onClientError);

	// Track every accepted socket so `close()` can force-destroy them
	// instead of waiting on net.Server's "wait for connections to drain"
	// semantics. Without this, a process exit (or test teardown) hangs
	// for the full keep-alive idle timeout (5s by default) after each
	// request — once the socket has been emitted to a sub-server, the
	// outer dispatcher considers it still "active" and refuses to
	// resolve close() until it ends naturally.
	const liveSockets = new Set();
	const dispatcher = net.createServer((socket) => {
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
		// One-shot peek: pause, read the first chunk, unshift it back so
		// the chosen sub-server reads it as if it had been there all along.
		// Empty / error sockets are silently dropped — same behaviour the
		// underlying http.Server would have.
		socket.once("data", (chunk) => {
			socket.pause();
			socket.unshift(chunk);
			const target =
				chunk.length > 0 && chunk[0] === 0x16 ? httpsServer : redirectServer;
			target.emit("connection", socket);
			// Resume on the next tick so the sub-server has wired its own
			// 'data' handlers before bytes flow.
			process.nextTick(() => socket.resume());
		});
		socket.on("error", (e) => {
			logger.debug(`tls dispatcher socket error: ${e.message}`);
		});
	});

	// Wrap close() so callers (index.js shutdown, tests) tear down all three
	// pieces, not just the outer TCP listener. The https/http sub-servers
	// hold their own keep-alive timers and may have idle connections from
	// just-finished requests; `closeAllConnections()` boots those off so
	// `close()` resolves immediately instead of waiting for the default
	// 5s keep-alive idle timeout.
	const originalClose = dispatcher.close.bind(dispatcher);
	dispatcher.close = (cb) => {
		let pending = 3;
		const done = (err) => {
			if (err) logger.debug(`tls dispatcher close: ${err.message}`);
			if (--pending === 0 && cb) cb();
		};
		try {
			httpsServer.closeAllConnections?.();
			httpsServer.close(done);
		} catch {
			done();
		}
		try {
			redirectServer.closeAllConnections?.();
			redirectServer.close(done);
		} catch {
			done();
		}
		// Force-destroy every socket the dispatcher accepted. Without this,
		// originalClose waits for those sockets to end on their own — even
		// though the sub-servers have already emitted 'close' on them at
		// the HTTP layer, the TCP socket is still alive in net.Server's
		// connection list until keep-alive idle-times-out.
		for (const s of liveSockets) {
			try {
				s.destroy();
			} catch {
				/* ignore */
			}
		}
		liveSockets.clear();
		originalClose(done);
	};

	return dispatcher;
}

async function handle(req, res, ctx) {
	const {
		config,
		store,
		scheduler,
		logger,
		turnLog,
		uiServer,
		reportServer,
		bodyCapture,
		canaryGuard,
	} = ctx;
	const started = Date.now();

	const adminPrefix = `/${config.adminPathPrefix}`;
	if (req.url === adminPrefix || req.url.startsWith(`${adminPrefix}/`)) {
		return handleAdmin(req, res, {
			store,
			scheduler,
			config,
			logger,
			uiServer,
			reportServer,
		});
	}

	const isPost = req.method === "POST";
	const pathname = new URL(req.url, "http://localhost").pathname;
	const looksLikeMessages = isPost && /\/v1\/messages(?:\/|$)/.test(pathname);
	// `/v1/messages/count_tokens` matches looksLikeMessages but is NOT a
	// generation turn: it returns `{input_tokens}` with no `usage` block. It
	// must not be logged as a turn (it would record usage:null and pollute the
	// analyzer's turn denominator) nor burn a baseline-capture turn.
	const isCountTokens =
		isPost && /\/v1\/messages\/count_tokens(?:\/|$)/.test(pathname);

	let bodyBuffer;
	let parsedBody = null;
	let forwardBody;
	let ttlMode = "5m";
	let injectionTelemetry = null;

	let strippedAnything = false;
	let streamRewritten = false;
	let forwardEncoding = null;
	let earlySession = null;
	// Byte-faithfulness canary (see maybeCanaryFallback): set true when a
	// cache knob is active but re-serializing this client's body would change
	// its bytes (non-canonical JSON). On fallback we skip strip + 1h-TTL and
	// forward the pristine bytes rather than cold-start Anthropic's cache.
	let canaryFallback = false;
	// Set only during a SHADOW baseline capture: the per-turn pairSeq shared
	// by the primary turn-log record and its passthrough shadow twin, so the
	// analyzer can pair the two arms turn-for-turn (null otherwise — the
	// analyzer skips null-pairSeq records).
	let pairSeq = null;
	if (looksLikeMessages) {
		try {
			bodyBuffer = await readBody(req, 32 * 1024 * 1024);
		} catch (e) {
			return writeError(res, 413, "request_too_large", e.message);
		}
		try {
			parsedBody = JSON.parse(bodyBuffer.toString("utf8"));
		} catch {
			parsedBody = null;
		}

		// TEST harness (`--capture-body`): dump the pristine, pre-mutation
		// bytes once. Must run before strip/inject so the fixture is the
		// authentic Claude Code body. No-op unless the knob is on.
		maybeCaptureBody({ bodyCapture, bodyBuffer, parsedBody, logger });

		// Byte-faithfulness canary. The cache-preservation knobs (strip-ephemeral,
		// 1h-TTL) forward JSON.stringify(parsedBody), which DE-ESCAPES non-ASCII
		// for a client that put escaped \uXXXX on the wire — silently changing
		// the bytes Anthropic content-addresses and cold-starting the very cache
		// the knobs exist to preserve. Detect that case up front (would a
		// round-trip change the bytes?) and fall back to forwarding the pristine
		// body with the knobs skipped. Mobile's stream rewrite is intentionally
		// NOT guarded: it mutates the body on purpose for a non-cache reason.
		canaryFallback = maybeCanaryFallback({
			parsedBody,
			bodyBuffer,
			config,
			canaryGuard,
			logger,
		});

		// PLAN §9: strip ephemeral content from `system` before identifying
		// the session and forwarding bytes. Skipped on canary fallback.
		if (!canaryFallback && parsedBody && config.stripEphemeralFromSystem) {
			const { stripped, removed } = stripEphemeral(parsedBody.system);
			if (removed.length > 0) {
				parsedBody.system = stripped;
				strippedAnything = true;
			}
		}

		// Mobile mode: rewrite stream:true → false so Anthropic returns a
		// single JSON payload (better gzip, less radio-on time). The
		// response-side will re-emit it as SSE for the client (see
		// proxy.js + sse_reemit.js).
		if (parsedBody && config.forceNonStreaming && parsedBody.stream === true) {
			parsedBody.stream = false;
			streamRewritten = true;
		}

		earlySession = looksLikeMessages
			? identifySession({
					url: req.url,
					body: parsedBody,
					adminPathPrefix: config.adminPathPrefix,
				})
			: null;

		let injectedBody = null;
		if (!canaryFallback) {
			const { body, telemetry } = injectIntoBody(parsedBody, config);
			injectedBody = body;
			injectionTelemetry = telemetry;
			if (telemetry?.ttlMode === "1h") ttlMode = "1h";
		}
		if (injectedBody) {
			forwardBody = injectedBody;
		} else if (strippedAnything || streamRewritten) {
			forwardBody = Buffer.from(JSON.stringify(parsedBody), "utf8");
		} else {
			forwardBody = bodyBuffer;
		}

		// Mobile mode: gzip the outgoing body. Skip below ~1KB — gzip
		// overhead dominates on small payloads (header is ~18 bytes, plus
		// trailer; very short JSON can grow). Anthropic's API accepts
		// content-encoding: gzip on request bodies.
		if (config.gzipOutgoing && forwardBody && forwardBody.length >= 1024) {
			try {
				forwardBody = zlib.gzipSync(forwardBody);
				forwardEncoding = "gzip";
			} catch (e) {
				logger.warn(
					`gzipOutgoing: zlib.gzipSync failed (${e.message}); forwarding uncompressed`,
				);
			}
		}
	}

	// Reuse the session identified inside the mutation pipeline (PLAN §41).
	// For non-message paths earlySession is null; identifySession is also a
	// no-op there so this is equivalent.
	const session = earlySession;

	const fingerprints =
		looksLikeMessages && parsedBody
			? computeFingerprints({
					system: parsedBody.system ?? null,
					tools: parsedBody.tools ?? null,
				})
			: null;

	let forwardPath = req.url;
	let sessionKey = null;
	let sessionMode = null;

	if (session) {
		forwardPath = session.forwardPath;
		sessionKey = session.key;
		sessionMode = session.mode;
		const wasNew = !store.has(session.key);
		captureSessionState({
			store,
			session,
			parsedBody,
			clientHeaders: req.headers,
			config,
			ttlMode,
			fingerprints,
			injectionTelemetry,
			scheduler,
			logger,
		});
		if (wasNew) {
			const captured = store.get(session.key);
			sessionLogger(logger, session.key).info(
				`session captured ${shortKey(session.key)} mode=${session.mode} model=${captured?.model ?? "unknown"} system=${formatBytes(byteSize(captured?.system))} tools=${formatBytes(byteSize(captured?.tools))}`,
			);
		}
	} else if (req.url.match(/^\/[^/]+\/v1\//)) {
		const m = req.url.match(/^\/([^/]+)(\/v1\/.+)$/);
		if (m && m[1] !== "v1" && !m[1].startsWith("_")) {
			forwardPath = m[2];
		}
	}

	// Answer non-API requests locally instead of forwarding them upstream.
	// Clients (Claude Code) probe paths clawback doesn't route — `HEAD
	// /<agentId>`, `/favicon.ico`, `GET /` — that Anthropic doesn't serve
	// either, so forwarding just buys a pointless upstream round-trip and a
	// 404 we'd log as noise. Anything containing `/v1/` (a real API path, with
	// or without a session prefix) still flows through; admin/UI was handled
	// at the top of handle().
	if (!sessionKey && !/\/v1\//.test(pathname)) {
		const elapsed = Date.now() - started;
		res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
		res.end(
			req.method === "HEAD"
				? undefined
				: JSON.stringify({
						error: "not_found",
						message: `clawback does not route ${req.method} ${pathname}`,
					}),
		);
		logger.info(`${req.method} ${req.url} → 404 ${elapsed}ms [no-route]`);
		return;
	}

	// Shadow baseline capture (in-proxy twin of the benchmark tee): while a
	// SHADOW capture is armed we keep serving the armed/primary response to
	// the client AND fan a passthrough copy of THIS turn's pristine body
	// upstream, so we capture the no-clawback baseline WITHOUT forfeiting the
	// optimization for the window. Fire-and-forget: it must never delay or
	// break the primary stream, so we kick it off here (concurrent with the
	// primary) and never await it. COSTS a second billable request per turn
	// (~2x quota) — the operator opted in via the UI toggle + 2x warning.
	// Skip when the primary is already passthrough (the shadow would just
	// duplicate it) and for count_tokens (not a billable turn).
	const cap = config._baselineCapture;
	if (
		looksLikeMessages &&
		!isCountTokens &&
		cap?.active &&
		cap?.shadow &&
		!config.passthrough &&
		bodyBuffer != null
	) {
		pairSeq = cap.pairSeq = (cap.pairSeq | 0) + 1;
		const seq = pairSeq;
		const shadowTsIso = new Date(started).toISOString();
		fireShadowBaseline({
			upstreamBase: config.upstream,
			forwardPath,
			body: bodyBuffer,
			clientHeaders: req.headers,
			timeoutMs: config.requestTimeoutMs,
			logger,
			onUsage: (usage, httpStatus) => {
				// Accumulate the baseline arm's usage so completeBaselineCapture
				// can report the no-clawback hit rate alongside the armed one.
				// Read fresh — the capture may have completed (totals nulled) by
				// the time this fire-and-forget shadow lands.
				const tot = config._baselineCapture?.shadowTotals;
				if (tot && usage && typeof usage === "object") {
					tot.read += usage.cache_read_input_tokens ?? 0;
					tot.create += usage.cache_creation_input_tokens ?? 0;
					tot.miss += usage.input_tokens ?? 0;
				}
				// Paired passthrough turn-log record (same pairSeq as the primary)
				// so the analyzer pairs the two arms turn-for-turn, exactly like
				// the benchmark tee. Only when --turn-log is on.
				if (turnLog?.enabled) {
					turnLog.write({
						ts: shadowTsIso,
						sessionKey,
						mode: sessionMode,
						model: parsedBody?.model ?? null,
						ttlMode: "5m",
						arm: "passthrough",
						httpStatus: httpStatus ?? null,
						wallMs: null,
						ttftMs: null,
						usage: usage ?? null,
						clawbackVersion: CLAWBACK_VERSION,
						cadenceMode: config.keepAliveModeExtended ? "extended" : "default",
						toolsKey: fingerprints?.toolsKey ?? null,
						systemStableKey: fingerprints?.systemStableKey ?? null,
						thinkingBudget: parsedBody?.thinking?.budget_tokens ?? null,
						pairSeq: seq,
					});
				}
			},
		}).catch(() => {
			/* fire-and-forget: never let the shadow disturb the primary */
		});
	}

	let observedRateLimit = null;
	let observedUsage = null;
	const { ok, status, ttftMs } = await proxyRequest({
		clientReq: req,
		clientRes: res,
		upstreamBase: config.upstream,
		forwardPath,
		body: looksLikeMessages ? forwardBody : undefined,
		bodyEncoding: forwardEncoding,
		reemitAsSse: streamRewritten,
		timeoutMs: config.requestTimeoutMs,
		logger,
		mutateResponseHeaders: (h, statusCode) => {
			const rl = parseRateLimit(h);
			if (Object.keys(rl).length) observedRateLimit = rl;
			const result = sessionKey
				? onUpstreamHeaders({
						headers: h,
						statusCode,
						sessionKey,
						store,
						config,
						logger,
						onUsage: (u) => {
							observedUsage = u;
						},
					})
				: onNonSessionHeaders({
						headers: h,
						onUsage: (u) => {
							observedUsage = u;
						},
					});
			return result;
		},
	});

	const elapsed = Date.now() - started;
	const tag = sessionKey
		? `session=${shortKey(sessionKey)}(${sessionMode})`
		: "no-session";
	const logParts = [
		`${req.method} ${req.url} → ${status ?? "?"} ${elapsed}ms [${tag}]`,
	];
	if (status === 429 || (observedRateLimit && status >= 400)) {
		const ra = observedRateLimit?.retry_after_seconds;
		const reset =
			observedRateLimit?.tokens_reset ??
			observedRateLimit?.input_tokens_reset ??
			observedRateLimit?.output_tokens_reset;
		if (ra != null) logParts.push(`retry_after=${formatDuration(ra * 1000)}`);
		if (reset)
			logParts.push(
				`resets_in=${formatDuration(new Date(reset).getTime() - Date.now())}`,
			);
	}
	// Warn only on failures worth attention: any 5xx, or a 4xx on a real
	// session / messages request. Benign client preflights (a HEAD or GET to a
	// path clawback doesn't route → 404 with no session) are noise, not
	// faults, so they log at info — most never reach here anyway thanks to the
	// local-404 short-circuit above.
	const notable =
		(status && status >= 500) ||
		(status && status >= 400 && (sessionKey || looksLikeMessages));
	const requestLogger = sessionKey ? sessionLogger(logger, sessionKey) : logger;
	(notable ? requestLogger.warn : requestLogger.info).call(
		requestLogger,
		logParts.join(" "),
	);

	if (sessionKey && ok && status >= 200 && status < 300) {
		scheduler.ensureScheduled(sessionKey);
		// PLAN §32 (statusline TPS): record output_tokens / wallSeconds
		// per turn into a per-session ring buffer, so the statusline can
		// show a real history sparkline rather than a fake constant block.
		//
		// Filter to "meaningful" responses only (operator-requested
		// 2026-05-06): tool-call-only turns and tiny acknowledgements
		// produce 1-5 output tokens over 1-2 seconds — a real but
		// unhelpful tps reading that drowns out the actual generation
		// rate the operator cares about. The TPS_MIN_OUTPUT_TOKENS
		// threshold drops those without affecting normal long answers.
		// tps measures *generation* throughput, not end-to-end wall clock.
		// Earlier formula `output_tokens / elapsed` lumped in TTFT (queue +
		// prompt processing) + proxy overhead, pulling the visible rate
		// well below the model's actual generation speed. Subtracting
		// `ttftMs` isolates the post-first-token window. Skip when ttftMs
		// is missing (non-streaming responses): without it we can't
		// separate generation from prompt processing, so feeding the ring
		// would just bring back the old noise.
		if (
			looksLikeMessages &&
			observedUsage &&
			typeof observedUsage.output_tokens === "number" &&
			observedUsage.output_tokens >= TPS_MIN_OUTPUT_TOKENS &&
			typeof ttftMs === "number" &&
			Number.isFinite(ttftMs) &&
			ttftMs >= 0 &&
			elapsed > 0
		) {
			const generationMs = Math.max(elapsed - ttftMs, TPS_MIN_GENERATION_MS);
			const tps = observedUsage.output_tokens / (generationMs / 1000);
			if (Number.isFinite(tps) && tps >= 0) {
				store.upsert(sessionKey, (prev) => {
					if (!prev) return prev;
					const ring = Array.isArray(prev.recentTps) ? prev.recentTps : [];
					return { ...prev, recentTps: [...ring, tps].slice(-TPS_RING_LEN) };
				});
			}
		}
		// Independent of tps: capture TTFT for the cache-warmth sparkline.
		// No min-tokens filter — TTFT is meaningful for every turn, including
		// tool-call-only responses (where the "first token" is the first
		// content_block_start event).
		if (
			looksLikeMessages &&
			typeof ttftMs === "number" &&
			Number.isFinite(ttftMs) &&
			ttftMs >= 0
		) {
			store.upsert(sessionKey, (prev) => {
				if (!prev) return prev;
				const ring = Array.isArray(prev.recentTtftMs) ? prev.recentTtftMs : [];
				return {
					...prev,
					recentTtftMs: [...ring, ttftMs].slice(-TTFT_RING_LEN),
				};
			});
		}

		// PLAN §33: feed the metrics ring so the web UI sees turn-cadence
		// updates for hit/tps/ttft even when claude code's statusline POST
		// hasn't landed yet. Pull state fresh from the store so we see the
		// rings we just updated above.
		if (looksLikeMessages) {
			try {
				const fresh = store.get(sessionKey);
				if (fresh) {
					const total =
						(fresh.cacheReadTokens ?? 0) +
						(fresh.cacheCreationTokens ?? 0) +
						(fresh.cacheMissTokens ?? 0);
					const hit = total > 0 ? (fresh.cacheReadTokens / total) * 100 : 0;
					const tpsRing = Array.isArray(fresh.recentTps) ? fresh.recentTps : [];
					const tpsLatest = tpsRing.length ? tpsRing[tpsRing.length - 1] : null;
					const ttftRing = Array.isArray(fresh.recentTtftMs)
						? fresh.recentTtftMs
						: [];
					const ttftLatest = ttftRing.length
						? ttftRing[ttftRing.length - 1]
						: null;
					appendSample({
						source: "upstream",
						// PLAN §39: tag upstream samples with the clawback session
						// key (URL-path id) and its operator-supplied label so the
						// per-session UI can plot this turn's hit/tps/ttft on the
						// correct session's overlay. For hash-mode sessions (no
						// URL path), `sessionKey` is the 64-char fingerprint —
						// the UI shows it as one bucket per fingerprint.
						sessionKey,
						label: fresh.label ?? null,
						context: null,
						next: null,
						week: null,
						hit,
						turn: null,
						tps:
							typeof tpsLatest === "number" && Number.isFinite(tpsLatest)
								? tpsLatest
								: null,
						ttft:
							typeof ttftLatest === "number" && Number.isFinite(ttftLatest)
								? ttftLatest
								: null,
						mode: sampleModeSnapshot(config),
					});
				}
			} catch (e) {
				logger?.warn?.(`metrics sample append (upstream) failed: ${e.message}`);
			}
		}
	}

	if (looksLikeMessages && !isCountTokens && turnLog?.enabled) {
		turnLog.write({
			ts: new Date(started).toISOString(),
			sessionKey,
			mode: sessionMode,
			model: parsedBody?.model ?? null,
			ttlMode,
			arm: config.passthrough ? "passthrough" : "treatment",
			httpStatus: status ?? null,
			wallMs: elapsed,
			ttftMs: ttftMs ?? null,
			usage: observedUsage ?? null,
			clawbackVersion: CLAWBACK_VERSION,
			cadenceMode: config.keepAliveModeExtended ? "extended" : "default",
			toolsKey: fingerprints?.toolsKey ?? null,
			systemStableKey: fingerprints?.systemStableKey ?? null,
			thinkingBudget: parsedBody?.thinking?.budget_tokens ?? null,
			pairSeq,
		});
	}

	// Baseline-capture turn counter: every successful real /v1/messages
	// counts as one captured turn. tickBaselineCapture handles the
	// passthrough auto-revert + event emission when the counter hits
	// zero. Gate on ok+2xx so retries/errors don't burn budget.
	if (
		looksLikeMessages &&
		!isCountTokens &&
		ok &&
		typeof status === "number" &&
		status >= 200 &&
		status < 300
	) {
		try {
			tickBaselineCapture(config, { store, scheduler, logger });
		} catch (e) {
			logger?.warn?.(`tickBaselineCapture failed: ${e.message}`);
		}
	}
}

function captureSessionState({
	store,
	session,
	parsedBody,
	clientHeaders,
	config,
	ttlMode,
	fingerprints,
	injectionTelemetry,
	scheduler,
	logger,
}) {
	const now = new Date().toISOString();
	const authHeaders = extractAuthHeaders(clientHeaders);
	const wasAuthStale = store.get(session.key)?.authStale === true;

	store.upsert(session.key, (prev) => {
		const base = prev ?? {
			key: session.key,
			mode: session.mode,
			createdAt: now,
			keepAliveTokensUsed: 0,
			keepAliveCount: 0,
			keepAliveFailures: 0,
			lastKeepAliveAt: null,
			lastKeepAliveStatus: null,
			targetTtl: null,
			lastRateLimit: null,
		};

		// Per-session cache_control injection counters. Lets operators see
		// "is the 1h knob actually firing on my real turns" — see PLAN §5.1
		// + AGENTS.md ANTHROPIC KEY note. Eligible turns only (knob on or
		// off; alreadyExtended is informative either way). Aggregate is
		// exposed at /_proxy/health.cacheControlInjection.
		const injection = mergeInjectionCounters(
			base.cacheControlInjection,
			injectionTelemetry,
		);

		return {
			...base,
			system: parsedBody?.system ?? base.system ?? null,
			tools: parsedBody?.tools ?? base.tools ?? null,
			model: parsedBody?.model ?? base.model ?? null,
			betas: parsedBody?.betas ?? base.betas ?? null,
			authHeaders,
			authStale: false,
			ttlMode: ttlMode ?? base.ttlMode ?? resolvedTtlMode(config),
			lastActivity: now,
			toolsKey: fingerprints?.toolsKey ?? base.toolsKey ?? null,
			systemStableKey:
				fingerprints?.systemStableKey ?? base.systemStableKey ?? null,
			strippedSystemPreview:
				fingerprints?.strippedSystemPreview ??
				base.strippedSystemPreview ??
				null,
			cacheControlInjection: injection,
		};
	});

	if (
		wasAuthStale &&
		scheduler &&
		typeof scheduler.ensureScheduled === "function"
	) {
		try {
			scheduler.ensureScheduled(session.key);
			sessionLogger(logger, session.key)?.info?.(
				`auth-stale cleared for ${shortKey(session.key)}; keep-alive resumed`,
			);
			appendEvent({
				type: "auth-stale-cleared",
				text: "session resumed: real request refreshed auth, keep-alive re-armed",
				sessionKey: session.key,
			});
		} catch (e) {
			logger?.warn?.(
				`auth-stale clear: ensureScheduled threw for ${session.key}: ${e.message}`,
			);
		}
	}
}

function onUpstreamHeaders({
	headers,
	statusCode,
	sessionKey,
	store,
	config,
	logger,
	onUsage,
}) {
	const rl = parseRateLimit(headers);
	const reset = tokensResetIso(headers);
	store.upsert(sessionKey, (prev) => {
		if (!prev) return prev;
		return {
			...prev,
			targetTtl: reset ?? prev.targetTtl,
			lastRateLimit: Object.keys(rl).length ? rl : prev.lastRateLimit,
		};
	});

	// Per-status events drive suggestion rules that need to count
	// rate-limit walls and upstream outages distinctly from auth-stale
	// signals. Emitted before maybeFireAutoContinue so an A-C fire and
	// the rate-limit-hit it stemmed from share an ordered timestamp.
	if (statusCode === 429) {
		appendEvent({
			type: "rate-limit-hit",
			text: "upstream 429: rate-limit hit",
			sessionKey,
			meta: { status: 429 },
		});
	} else if (statusCode >= 500 && statusCode < 600) {
		appendEvent({
			type: "upstream-5xx",
			text: `upstream ${statusCode}`,
			sessionKey,
			meta: { status: statusCode },
		});
	}

	// Fire-and-forget: writeInput() may now be remote (HTTP fetch) so the
	// call is async, but the response path must not block on it. Any error
	// inside is already swallowed and logged by maybeFireAutoContinue.
	maybeFireAutoContinue({
		sessionKey,
		store,
		config,
		logger,
		rateLimit: rl,
		httpStatus: statusCode,
	}).catch((e) => {
		logger?.warn?.(`maybeFireAutoContinue crashed: ${e.message}`);
	});

	const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
	const contentEncoding =
		headers["content-encoding"] ?? headers["Content-Encoding"] ?? null;
	const bodyTap = createBodyTap({
		contentType,
		contentEncoding,
		onMessage: ({ id, usage }) => {
			const nowIso = new Date().toISOString();
			const nowMs = Date.now();
			// PLAN §37: persist a "safe prefix" boundary for cache-aware
			// consumers (Cozempic et al.) ONLY when Anthropic actually
			// wrote or read a cache entry for this turn. A 200 with zero
			// cache tokens means the prefix was never cached (system+tools
			// below threshold, our §5.1 injection skipped due to nested
			// cache_control, etc.), and persisting a boundary in that case
			// would tell consumers "this prefix is cached" when it isn't.
			const cacheTouched =
				(typeof usage?.cache_creation_input_tokens === "number" &&
					usage.cache_creation_input_tokens > 0) ||
				(typeof usage?.cache_read_input_tokens === "number" &&
					usage.cache_read_input_tokens > 0);
			store.upsert(sessionKey, (prev) => {
				const next = applyUsageToSession(prev, usage, nowIso);
				if (!next) return next;
				if (cacheTouched && typeof id === "string" && id.length > 0) {
					return {
						...next,
						safePrefixAssistantMessageId: id,
						lastObservedAt: nowMs,
					};
				}
				return next;
			});
			onUsage?.(usage);
		},
	});

	return { extracted: rl, bodyTap };
}

function onNonSessionHeaders({ headers, onUsage }) {
	const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
	const contentEncoding =
		headers["content-encoding"] ?? headers["Content-Encoding"] ?? null;
	const bodyTap = createBodyTap({
		contentType,
		contentEncoding,
		onMessage: ({ usage }) => onUsage?.(usage),
	});
	return { extracted: null, bodyTap };
}

/**
 * Per-session injection counter accumulator. `prev` is the running record on
 * the session (or undefined for a brand-new session); `tel` is the per-turn
 * telemetry returned by injectIntoBody. Returns the updated record. Tolerates
 * `tel == null` (non-message paths, or eligible:false bodies) by returning
 * the existing record unchanged.
 *
 * Field semantics:
 *   - eligibleTurns:        knob was on AND body had cacheable content
 *   - topLevelTurns:        added a top-level cache_control on this turn
 *   - rewriteTurns:         rewrote ≥1 nested block on this turn
 *   - alreadyExtendedTurns: every cache_control was already at ttl=1h
 *                           (client manages it directly — knob is a no-op
 *                           for this turn but the ttl is what we want)
 *   - blocksRewritten:      sum of rewritten blocks across turns
 *                           (granular — lets you see "1.7 blocks per turn")
 *   - lastTurnAt:           ISO of the most recent eligible turn
 */
function mergeInjectionCounters(prev, tel) {
	const base = prev ?? {
		eligibleTurns: 0,
		topLevelTurns: 0,
		rewriteTurns: 0,
		alreadyExtendedTurns: 0,
		blocksRewritten: 0,
		nonEphemeralSkipped: 0,
		lastTurnAt: null,
	};
	if (!tel || !tel.eligible) return base;
	return {
		eligibleTurns: (base.eligibleTurns ?? 0) + 1,
		topLevelTurns: (base.topLevelTurns ?? 0) + (tel.topLevelAdded ? 1 : 0),
		rewriteTurns: (base.rewriteTurns ?? 0) + (tel.blocksRewritten > 0 ? 1 : 0),
		alreadyExtendedTurns:
			(base.alreadyExtendedTurns ?? 0) +
			(tel.alreadyExtended > 0 && tel.blocksRewritten === 0 ? 1 : 0),
		blocksRewritten: (base.blocksRewritten ?? 0) + (tel.blocksRewritten ?? 0),
		nonEphemeralSkipped:
			(base.nonEphemeralSkipped ?? 0) + (tel.nonEphemeralSkipped ?? 0),
		lastTurnAt: new Date().toISOString(),
	};
}

function extractAuthHeaders(headers) {
	const out = {};
	for (const key of AUTH_HEADER_KEYS) {
		const v = headers[key] ?? headers[key.toLowerCase()];
		if (v !== undefined) out[key] = Array.isArray(v) ? v.join(", ") : v;
	}
	return out;
}

function sessionLogger(logger, sessionKey) {
	if (!sessionKey || typeof logger?.forSession !== "function") return logger;
	return logger.forSession(sessionKey);
}

/**
 * PLAN §24 trigger fan-in: shared by every observation path
 * (real-request response headers, keep-alive ping result). Pure-function
 * `processObservation` decides; this wrapper applies the side effects
 * (store.upsert + writeInput + log line). Both observation sites — server
 * onUpstreamHeaders and keepalive _tick — call this with the same shape.
 */
async function maybeFireAutoContinue({
	sessionKey,
	store,
	config,
	logger,
	rateLimit,
	httpStatus,
}) {
	if (!config?.autoContinue) return;
	const session = store.get(sessionKey);
	if (!session) return;
	const decision = processObservation({
		session,
		rateLimit,
		httpStatus,
		config,
		now: new Date(),
	});
	if (decision.updates) {
		store.upsert(sessionKey, (prev) =>
			prev ? { ...prev, ...decision.updates } : prev,
		);
	}
	if (decision.fireText) {
		const sLog = sessionLogger(logger, sessionKey);
		const result = await writeInput(decision.fireText);
		if (result.written) {
			sLog?.info?.(
				`auto-continue fired ${result.bytes} bytes into ${result.label} for ${shortKey(sessionKey)}`,
			);
			// cappedAt is set the moment the session transitioned into
			// the capped state; subtracting now gives the cooldown
			// duration. Suggestion rules use this (cooldown-longer-
			// than-5m-cache) to recommend the 1h TTL stack when waits
			// exceed the 5-minute ephemeral cache window.
			const cappedAtMs = session.cappedAt
				? Date.parse(session.cappedAt) || null
				: null;
			const cooldownMs =
				cappedAtMs != null ? Math.max(0, Date.now() - cappedAtMs) : null;
			appendEvent({
				type: "auto-continue-fire",
				text: `auto-continue fired ${result.bytes} bytes into ${result.label}`,
				sessionKey,
				meta: { cooldownMs },
			});
		} else {
			sLog?.warn?.(
				`auto-continue would have fired but writeInput refused: ${result.reason}`,
			);
			appendEvent({
				type: "auto-continue-skipped",
				text: `auto-continue skipped: ${result.reason}`,
				sessionKey,
			});
		}
	}
}

function chainBodyTaps(...taps) {
	const active = taps.filter((t) => typeof t === "function");
	if (active.length === 0) return null;
	if (active.length === 1) return active[0];
	return (chunk, done) => {
		for (const tap of active) {
			try {
				tap(chunk, done);
			} catch {
				/* a tap must never break the response stream */
			}
		}
	};
}

async function readBody(req, maxBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * TEST harness (`--capture-body`): write the pristine /v1/messages body to
 * disk exactly once, for use as a faithful replay fixture. One-shot via the
 * `bodyCapture.done` latch (persists across requests — it lives in
 * createServer scope). Only captures a body carrying `system` and a
 * NON-EMPTY `tools` array, so we skip thin continuation turns and Claude
 * Code's `tools: []` title/topic side-calls, and grab the rich agent turn
 * with its full cache_control breakpoint structure. The bytes are
 * the request body only — never the API key, which rides in headers. Mode
 * 0600 because the body contains the operator's prompt + tool definitions.
 */
function maybeCaptureBody({ bodyCapture, bodyBuffer, parsedBody, logger }) {
	if (!bodyCapture || bodyCapture.done || !bodyBuffer) return;
	if (
		!parsedBody ||
		parsedBody.system == null ||
		!Array.isArray(parsedBody.tools) ||
		parsedBody.tools.length === 0
	) {
		return;
	}
	// Latch before the write so a concurrent in-flight turn can't double-write;
	// re-open the latch only if the write itself failed (allow a later retry).
	bodyCapture.done = true;
	try {
		fs.writeFileSync(bodyCapture.path, bodyBuffer, { mode: 0o600 });
		logger.info(
			`capture-body: wrote ${bodyBuffer.length}B pristine /v1/messages body to ${bodyCapture.path} (cache_control breakpoints preserved)`,
		);
	} catch (e) {
		bodyCapture.done = false;
		logger.warn(
			`capture-body: failed to write ${bodyCapture.path}: ${e.message}`,
		);
	}
}

// Byte-faithfulness canary. Returns true (→ skip cache knobs, forward pristine)
// when a cache-preservation knob is active but re-serializing this client's body
// would NOT reproduce its exact wire bytes. Anthropic content-addresses the
// bytes we forward; the strip/1h paths forward JSON.stringify(parsedBody), which
// de-escapes non-ASCII (`\uXXXX` → literal UTF-8) for a non-canonical client and
// silently cold-starts the cache. Real Claude Code emits V8-canonical JSON (via
// the Anthropic SDK's JSON.stringify), so this should never fire for it — it's
// cheap insurance against a client whose serializer differs. One extra
// stringify per turn, only while a cache knob is on (never in passthrough).
function maybeCanaryFallback({
	parsedBody,
	bodyBuffer,
	config,
	canaryGuard,
	logger,
}) {
	if (!parsedBody || !bodyBuffer) return false;
	if (
		!config.stripEphemeralFromSystem &&
		!config.injectExtendedCacheTtl &&
		!config.stripExtendedCacheTtl
	) {
		return false;
	}
	let faithful;
	try {
		faithful = JSON.stringify(parsedBody) === bodyBuffer.toString("utf8");
	} catch {
		// Can't even re-serialize → definitely not byte-faithful.
		faithful = false;
	}
	if (faithful) return false;
	warnCanaryOnce(canaryGuard, logger);
	return true;
}

function warnCanaryOnce(canaryGuard, logger) {
	if (!canaryGuard || canaryGuard.warned) return;
	canaryGuard.warned = true;
	logger.warn(
		"byte-faithfulness canary: this client's /v1/messages body is NOT canonical JSON " +
			"(re-serializing would change the forwarded bytes, e.g. de-escaping \\uXXXX). " +
			"Forwarding the PRISTINE body and SKIPPING the cache knobs (strip-ephemeral / 1h-TTL / 5m-strip) " +
			"so we don't cold-start Anthropic's prompt cache. If you see this with real Claude Code, " +
			"capture a body and investigate (TEST.md byte-faithfulness). This warns once per process.",
	);
}

function writeError(res, status, type, message) {
	if (res.headersSent) return;
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

function shortKey(k) {
	return k.length > 12 ? `${k.slice(0, 12)}…` : k;
}

function byteSize(v) {
	if (v == null) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(v), "utf8");
	} catch {
		return -1;
	}
}

function formatBytes(n) {
	if (n < 0) return "?";
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
