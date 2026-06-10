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
let nextResponse;

beforeAll(async () => {
	upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const r = nextResponse ?? {
				status: 200,
				headers: { "content-type": "application/json" },
				body: Buffer.from('{"type":"message","usage":{}}'),
			};
			res.writeHead(r.status, r.headers);
			res.end(r.body);
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => {
	upstream?.close();
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-bodytap-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
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

function listen(server) {
	return new Promise((r) =>
		server.listen(0, "127.0.0.1", () => r(server.address().port)),
	);
}

function teardown({ scheduler, server, dir }) {
	scheduler.stop();
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

function postMessages(port, body) {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = http.request(
			{
				method: "POST",
				host: "127.0.0.1",
				port,
				path: "/v1/messages",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload),
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

const usageBody = {
	type: "message",
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	usage: {
		input_tokens: 100,
		output_tokens: 50,
		cache_creation_input_tokens: 200,
		cache_read_input_tokens: 8500,
	},
};

describe("body tap decodes upstream Content-Encoding before parsing usage", () => {
	test("identity (uncompressed) JSON: counters accumulate (baseline)", async () => {
		nextResponse = {
			status: 200,
			headers: { "content-type": "application/json" },
			body: Buffer.from(JSON.stringify(usageBody)),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postMessages(port, {
				model: "claude-opus-4-7",
				system: "x",
				tools: [],
				messages: [{ role: "user", content: "hi" }],
			});
			await new Promise((r) => setTimeout(r, 50));
			const sessions = ctx.store.all();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].cacheReadTokens).toBe(8500);
			expect(sessions[0].cacheCreationTokens).toBe(200);
			expect(sessions[0].cacheMissTokens).toBe(100);
		} finally {
			teardown(ctx);
		}
	});

	test("gzip-encoded JSON: counters STILL accumulate (was broken)", async () => {
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "application/json",
				"content-encoding": "gzip",
			},
			body: zlib.gzipSync(Buffer.from(JSON.stringify(usageBody))),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postMessages(port, {
				model: "claude-opus-4-7",
				system: "y",
				tools: [],
				messages: [{ role: "user", content: "hi" }],
			});
			await new Promise((r) => setTimeout(r, 50));
			const sessions = ctx.store.all();
			expect(sessions).toHaveLength(1);
			// Pre-fix this would be 0 across the board because the body tap
			// saw gzip bytes and JSON.parse failed silently.
			expect(sessions[0].cacheReadTokens).toBe(8500);
			expect(sessions[0].cacheCreationTokens).toBe(200);
			expect(sessions[0].cacheMissTokens).toBe(100);
		} finally {
			teardown(ctx);
		}
	});

	test("brotli-encoded JSON: counters accumulate", async () => {
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "application/json",
				"content-encoding": "br",
			},
			body: zlib.brotliCompressSync(Buffer.from(JSON.stringify(usageBody))),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postMessages(port, {
				model: "claude-opus-4-7",
				system: "z",
				tools: [],
				messages: [{ role: "user", content: "hi" }],
			});
			await new Promise((r) => setTimeout(r, 50));
			const sessions = ctx.store.all();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].cacheReadTokens).toBe(8500);
		} finally {
			teardown(ctx);
		}
	});

	test("gzip-encoded SSE stream: usage from completed turn parses cleanly", async () => {
		// PLAN §37: SSE bodyTap emits on message_delta+stop_reason, NOT on
		// message_start — message_start only seeds id + cache_* fields into
		// closure state. So the fixture must carry a complete turn for usage
		// to land.
		const sse =
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","usage":{"input_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0}}}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"content-encoding": "gzip",
			},
			body: zlib.gzipSync(Buffer.from(sse)),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postMessages(port, {
				model: "claude-opus-4-7",
				system: "sse-test",
				tools: [],
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			});
			await new Promise((r) => setTimeout(r, 50));
			const sessions = ctx.store.all();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].cacheReadTokens).toBe(1000);
			expect(sessions[0].cacheMissTokens).toBe(50);
		} finally {
			teardown(ctx);
		}
	});

	test("unknown encoding: telemetry quietly skips, response still flows", async () => {
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "application/json",
				"content-encoding": "weirdcoding",
			},
			body: Buffer.from(JSON.stringify(usageBody)),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await postMessages(port, {
				model: "claude-opus-4-7",
				system: "unknown-enc",
				tools: [],
				messages: [{ role: "user", content: "hi" }],
			});
			expect(r.status).toBe(200);
			await new Promise((r) => setTimeout(r, 50));
			const sessions = ctx.store.all();
			expect(sessions).toHaveLength(1);
			// applyUsageToSession never ran (decoder couldn't be built), so
			// the field stays at its initial undefined / 0.
			expect(sessions[0].cacheReadTokens ?? 0).toBe(0);
		} finally {
			teardown(ctx);
		}
	});
});
