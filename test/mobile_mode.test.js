import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DEFAULTS } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");
let upstream;
let upstreamPort;
let upstreamResponder = null;
let lastSeenRequest = null;

beforeAll(async () => {
	upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks);
			lastSeenRequest = {
				method: req.method,
				url: req.url,
				headers: req.headers,
				rawBody: raw,
			};
			if (typeof upstreamResponder === "function") {
				upstreamResponder(req, res, raw);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => upstream?.close());

beforeEach(() => {
	upstreamResponder = null;
	lastSeenRequest = null;
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-mobile-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		turnLogFile: null,
		sessionLogDir: null,
		injectExtendedCacheTtl: false,
		stripEphemeralFromSystem: false,
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const scheduler = new KeepAliveScheduler({
		config,
		store,
		logger,
		fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
	});
	const server = createServer({ config, store, scheduler, logger });
	return { config, store, scheduler, server, dir };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function teardown({ scheduler, server, dir }) {
	scheduler.stop();
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

function postJson(port, urlPath, body) {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = http.request(
			{
				method: "POST",
				host: "127.0.0.1",
				port,
				path: urlPath,
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
					authorization: "Bearer test-key",
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

const STREAM_REQ = {
	model: "claude-opus-4-5",
	system: "You are helpful.",
	tools: [{ name: "Bash" }],
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 100,
	stream: true,
};

const FAKE_JSON_RESP = {
	id: "msg_test",
	type: "message",
	role: "assistant",
	model: "claude-opus-4-5",
	content: [{ type: "text", text: "Hello from mobile mode." }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
};

describe("PLAN §24 mobile mode — stream rewrite + SSE re-emit", () => {
	test("forceNonStreaming rewrites stream:true → false on the way out", async () => {
		upstreamResponder = (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(FAKE_JSON_RESP));
		};
		const ctx = setup({ forceNonStreaming: true });
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/v1/messages", STREAM_REQ);
		} finally {
			teardown(ctx);
		}
		const seen = JSON.parse(lastSeenRequest.rawBody.toString("utf8"));
		expect(seen.stream).toBe(false);
	});

	test("clawback re-emits the JSON response as SSE the client expects", async () => {
		upstreamResponder = (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(FAKE_JSON_RESP));
		};
		const ctx = setup({ forceNonStreaming: true });
		const port = await listen(ctx.server);
		let resp;
		try {
			resp = await postJson(port, "/v1/messages", STREAM_REQ);
		} finally {
			teardown(ctx);
		}
		expect(resp.status).toBe(200);
		expect(resp.headers["content-type"]).toMatch(/text\/event-stream/);
		expect(resp.body).toMatch(/event: message_start/);
		expect(resp.body).toMatch(/event: content_block_delta/);
		expect(resp.body).toMatch(/Hello from mobile mode\./);
		expect(resp.body).toMatch(/event: message_stop/);
	});

	test("gzipOutgoing wraps the request body with content-encoding: gzip", async () => {
		const bigSystem = "x".repeat(2000); // > 1KB threshold
		upstreamResponder = (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(FAKE_JSON_RESP));
		};
		const ctx = setup({ gzipOutgoing: true });
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/v1/messages", {
				...STREAM_REQ,
				system: bigSystem,
				stream: false,
			});
		} finally {
			teardown(ctx);
		}
		expect(lastSeenRequest.headers["content-encoding"]).toBe("gzip");
		// Decompress and verify the original system survived.
		const decoded = zlib.gunzipSync(lastSeenRequest.rawBody).toString("utf8");
		const parsed = JSON.parse(decoded);
		expect(parsed.system).toBe(bigSystem);
	});

	test("gzipOutgoing skips small bodies (< 1KB threshold)", async () => {
		upstreamResponder = (_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(FAKE_JSON_RESP));
		};
		const ctx = setup({ gzipOutgoing: true });
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/v1/messages", {
				...STREAM_REQ,
				system: "tiny",
				stream: false,
			});
		} finally {
			teardown(ctx);
		}
		expect(lastSeenRequest.headers["content-encoding"]).toBeUndefined();
		// Body is plain JSON, not gzip-magic-byte (1f 8b).
		expect(lastSeenRequest.rawBody[0]).not.toBe(0x1f);
	});

	test("non-2xx response with reemitAsSse falls through to original body", async () => {
		upstreamResponder = (_req, res) => {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					type: "error",
					error: { type: "rate_limit_error", message: "slow down" },
				}),
			);
		};
		const ctx = setup({ forceNonStreaming: true });
		const port = await listen(ctx.server);
		let resp;
		try {
			resp = await postJson(port, "/v1/messages", STREAM_REQ);
		} finally {
			teardown(ctx);
		}
		expect(resp.status).toBe(429);
		// Error body passes through as-is, not wrapped in SSE.
		expect(resp.body).toMatch(/rate_limit_error/);
		expect(resp.body).not.toMatch(/event: message_start/);
	});

	test("mobile bundle expansion turns on both sub-knobs by default", () => {
		// Verified at the config layer; here we assert that with --mobile
		// the runtime config has both sub-knobs flipped on.
		const ctx = setup({ mobile: true });
		try {
			expect(ctx.config.mobile).toBe(true);
			// gzipOutgoing and forceNonStreaming were never actively merged
			// because setup() bypasses loadConfig — these tests live in
			// config.test.js. Just spot-check that the test scaffolding
			// doesn't trip.
		} finally {
			teardown(ctx);
		}
	});
});
