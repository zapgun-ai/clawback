import http from "node:http";
import {
	captureBaselineStatus,
	completeBaselineCapture,
	startBaselineCapture,
} from "../src/admin.js";
import { clearEvents, listEvents } from "../src/events_log.js";
import {
	fireShadowBaseline,
	shadowRequestHeaders,
} from "../src/shadow_baseline.js";

// ---- helpers -----------------------------------------------------------

function sseBody(startUsage, deltaUsage) {
	const ev = (type, obj) =>
		`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
	return (
		ev("message_start", { message: { id: "msg_test", usage: startUsage } }) +
		ev("message_delta", {
			delta: { stop_reason: "end_turn" },
			usage: deltaUsage,
		}) +
		ev("message_stop", {})
	);
}

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function makeScheduler() {
	return {
		stopCount: 0,
		startCount: 0,
		stop() {
			this.stopCount++;
		},
		start() {
			this.startCount++;
		},
	};
}

const logger = { info() {}, warn() {}, debug() {} };

// Config in the "armed" shape: every optimization on, NOT in passthrough —
// exactly the state a real operator runs in when they click "capture
// baseline (shadow)". Shadow mode must keep all of this on.
function armedConfig(extra = {}) {
	return {
		passthrough: false,
		injectExtendedCacheTtl: true,
		rewriteNestedCacheControl: true,
		stripEphemeralFromSystem: true,
		keepAliveEnabled: true,
		autoContinue: false,
		baselineCaptureTurns: 5,
		...extra,
	};
}

// A store stub aggregateCacheTokens() understands: it sums these fields
// across .all(). One synthetic "armed" session whose tokens give an 82% hit.
function storeWith({ read, create, miss }) {
	return {
		all: () => [
			{
				cacheReadTokens: read,
				cacheCreationTokens: create,
				cacheMissTokens: miss,
			},
		],
	};
}

// ---- admin lifecycle: shadow must NOT forfeit the armed knobs ----------

describe("startBaselineCapture shadow mode", () => {
	test("does NOT impose passthrough and keeps every armed knob on", () => {
		const config = armedConfig();
		const scheduler = makeScheduler();
		startBaselineCapture(config, {
			store: storeWith({ read: 0, create: 0, miss: 0 }),
			scheduler,
			logger,
			shadow: true,
		});

		// The whole point of shadow mode: the live/primary path stays armed.
		expect(config.passthrough).toBe(false);
		expect(config.injectExtendedCacheTtl).toBe(true);
		expect(config.rewriteNestedCacheControl).toBe(true);
		expect(config.stripEphemeralFromSystem).toBe(true);
		expect(config.keepAliveEnabled).toBe(true);
		// Scheduler must not be stopped — keep-alive keeps running for primary.
		expect(scheduler.stopCount).toBe(0);

		const cap = config._baselineCapture;
		expect(cap.active).toBe(true);
		expect(cap.shadow).toBe(true);
		expect(cap.targetTurns).toBe(5);
		// A fresh accumulator for the passthrough (baseline) arm's usage.
		expect(cap.shadowTotals).toEqual({ read: 0, create: 0, miss: 0 });
	});

	test("default (non-shadow) still imposes passthrough — regression guard", () => {
		const config = armedConfig();
		const scheduler = makeScheduler();
		startBaselineCapture(config, {
			store: storeWith({ read: 0, create: 0, miss: 0 }),
			scheduler,
			logger,
		});

		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);
		expect(config.stripEphemeralFromSystem).toBe(false);
		expect(scheduler.stopCount).toBe(1);
		expect(config._baselineCapture.shadow).toBeFalsy();
	});
});

describe("captureBaselineStatus reflects shadow", () => {
	test("defaultShadow follows config; shadow follows the active capture", () => {
		const config = armedConfig({ baselineCaptureShadow: true });
		expect(captureBaselineStatus(config).defaultShadow).toBe(true);

		const scheduler = makeScheduler();
		startBaselineCapture(config, {
			store: storeWith({ read: 0, create: 0, miss: 0 }),
			scheduler,
			logger,
			shadow: true,
		});
		const st = captureBaselineStatus(config);
		expect(st.active).toBe(true);
		expect(st.shadow).toBe(true);
	});
});

describe("completeBaselineCapture in shadow mode", () => {
	test("reports baseline hit rate AND the armed hit rate side by side", () => {
		clearEvents();
		const config = armedConfig();
		// Hand-build an active shadow capture: startTotals at zero, shadow arm
		// accumulated a 90% baseline (90 read / 100), and the store reflects an
		// 82% armed hit rate over the same window (82 read / 100).
		config._baselineCapture = {
			active: true,
			turnsRemaining: 0,
			targetTurns: 5,
			startedAt: new Date().toISOString(),
			startTotals: { read: 0, create: 0, miss: 0 },
			imposedPassthrough: false,
			shadow: true,
			shadowTotals: { read: 90, create: 0, miss: 10 },
		};
		completeBaselineCapture(config, {
			store: storeWith({ read: 82, create: 18, miss: 0 }),
			scheduler: makeScheduler(),
			logger,
		});

		const ev = listEvents({ limit: 50 }).find(
			(e) => e.type === "baseline-captured",
		);
		expect(ev).toBeTruthy();
		expect(ev.meta.shadow).toBe(true);
		// Contract preserved: meta.hitRate is ALWAYS the no-clawback baseline.
		// In shadow mode that comes from the shadow arm (0.90), not the store.
		expect(ev.meta.hitRate).toBeCloseTo(0.9, 5);
		// The bonus shadow mode buys: the armed hit rate over the same turns.
		expect(ev.meta.armedHitRate).toBeCloseTo(0.82, 5);
	});

	test("non-shadow completion keeps legacy semantics (hitRate from store, no armedHitRate)", () => {
		clearEvents();
		const config = armedConfig({ passthrough: true });
		config._baselineCapture = {
			active: true,
			turnsRemaining: 0,
			targetTurns: 3,
			startedAt: new Date().toISOString(),
			startTotals: { read: 0, create: 0, miss: 0 },
			imposedPassthrough: true,
		};
		completeBaselineCapture(config, {
			store: storeWith({ read: 9, create: 0, miss: 91 }),
			scheduler: makeScheduler(),
			logger,
		});
		const ev = listEvents({ limit: 50 }).find(
			(e) => e.type === "baseline-captured",
		);
		expect(ev.meta.hitRate).toBeCloseTo(0.09, 5);
		expect(ev.meta.armedHitRate == null).toBe(true);
		expect(ev.meta.shadow).toBeFalsy();
	});
});

// ---- the fire-and-forget shadow forward --------------------------------

describe("shadowRequestHeaders", () => {
	test("keeps auth + anthropic headers, drops hop-by-hop, rewrites host/content-length", () => {
		const out = shadowRequestHeaders(
			{
				authorization: "Bearer oauth-xyz",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "prompt-caching",
				host: "old:1",
				connection: "keep-alive",
				"content-length": "999",
				"transfer-encoding": "chunked",
			},
			{ host: "api.anthropic.com", contentLength: 42 },
		);
		expect(out.authorization).toBe("Bearer oauth-xyz");
		expect(out["anthropic-version"]).toBe("2023-06-01");
		expect(out["anthropic-beta"]).toBe("prompt-caching");
		expect(out.host).toBe("api.anthropic.com");
		expect(out["content-length"]).toBe(42);
		expect(out.connection).toBeUndefined();
		expect(out["transfer-encoding"]).toBeUndefined();
	});
});

describe("fireShadowBaseline", () => {
	let upstream;
	let upstreamSeen;
	let port;
	const SSE = sseBody(
		{
			input_tokens: 120,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		{ output_tokens: 7 },
	);

	beforeAll(async () => {
		upstreamSeen = [];
		upstream = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				upstreamSeen.push({
					method: req.method,
					url: req.url,
					headers: req.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				});
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(SSE);
			});
		});
		port = await listen(upstream);
	});

	afterAll(async () => {
		await close(upstream);
	});

	test("replays the pristine body, forwards the bearer, taps usage, adds NO clawback header", async () => {
		const body = JSON.stringify({
			model: "claude-haiku-4-5-20251001",
			stream: true,
			system: "S",
		});
		let captured = null;
		const r = await fireShadowBaseline({
			upstreamBase: `http://127.0.0.1:${port}`,
			forwardPath: "/v1/messages",
			body: Buffer.from(body),
			clientHeaders: {
				authorization: "Bearer oauth-xyz",
				"anthropic-version": "2023-06-01",
				host: "should-be-rewritten:1",
				"content-length": "999",
			},
			timeoutMs: 5000,
			onUsage: (u) => {
				captured = u;
			},
			logger,
		});

		expect(r.ok).toBe(true);
		expect(captured).toBeTruthy();
		// The shadow arm captured the no-clawback baseline usage (120 in).
		expect(captured.input_tokens).toBe(120);
		expect(captured.output_tokens).toBe(7);

		const seen = upstreamSeen.find((s) => s.url === "/v1/messages");
		expect(seen.method).toBe("POST");
		// Pristine Claude Code bytes, verbatim — this is what makes it the A0 baseline.
		expect(seen.body).toBe(body);
		expect(seen.headers.authorization).toBe("Bearer oauth-xyz");
		expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
		expect(seen.headers.host).toBe(`127.0.0.1:${port}`);
		expect(seen.headers["content-length"]).toBe(
			String(Buffer.byteLength(body)),
		);
		// Nothing Anthropic could correlate back to clawback: no pairing header.
		for (const name of Object.keys(seen.headers)) {
			expect(name.toLowerCase()).not.toMatch(/pair|correl|clawback/);
		}
	});

	test("never rejects on a dead upstream (fire-and-forget contract)", async () => {
		const r = await fireShadowBaseline({
			upstreamBase: "http://127.0.0.1:1",
			forwardPath: "/v1/messages",
			body: Buffer.from("{}"),
			clientHeaders: {},
			timeoutMs: 500,
			onUsage: () => {
				throw new Error("should not be called on a dead upstream");
			},
			logger,
		});
		expect(r.ok).toBe(false);
	});

	test("refuses an off-host (protocol-relative) forward path", async () => {
		const r = await fireShadowBaseline({
			upstreamBase: `http://127.0.0.1:${port}`,
			forwardPath: "//evil.example.com/v1/messages",
			body: Buffer.from("{}"),
			clientHeaders: {},
			onUsage: () => {
				throw new Error("must not forward off-host");
			},
			logger,
		});
		expect(r.ok).toBe(false);
	});
});
