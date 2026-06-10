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
import { createTurnLog } from "../src/turn_log.js";

const logger = createLogger("silent");

// A realistic completed-turn SSE: message_start seeds id + cache_* fields,
// message_delta carries stop_reason + final output_tokens. This is the
// shape Anthropic streams for a normal generation turn.
const COMPLETED_SSE =
	"event: message_start\n" +
	'data: {"type":"message_start","message":{"id":"msg_race","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"stop_reason":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":42296,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n' +
	"event: content_block_start\n" +
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
	"event: content_block_delta\n" +
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A longer answer that spans the stream."}}\n\n' +
	"event: content_block_stop\n" +
	'data: {"type":"content_block_stop","index":0}\n\n' +
	"event: message_delta\n" +
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":278}}\n\n' +
	"event: message_stop\n" +
	'data: {"type":"message_stop"}\n\n';

let upstream;
let upstreamPort;
// Each test sets this to control exactly what the stub Anthropic returns.
let nextResponse;

beforeAll(async () => {
	upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const r = nextResponse;
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-stream-"));
	const turnLogFile = path.join(dir, "turns.ndjson");
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		turnLogFile,
		// Keep the request untouched so the response path is the only variable.
		injectExtendedCacheTtl: false,
		stripEphemeralFromSystem: false,
		mobileMode: false,
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const turnLog = createTurnLog({ filePath: config.turnLogFile, logger });
	const scheduler = new KeepAliveScheduler({
		config,
		store,
		logger,
		fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
	});
	const server = createServer({ config, store, scheduler, logger, turnLog });
	return { config, store, scheduler, server, turnLog, dir, turnLogFile };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function teardown({ scheduler, server, turnLog, dir }) {
	scheduler.stop();
	turnLog.close();
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

function post(port, urlPath, body) {
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
					"anthropic-version": "2023-06-01",
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

async function readTurnRecords(ctx) {
	// Let any async telemetry settle, then flush the log before reading.
	await new Promise((r) => setTimeout(r, 40));
	ctx.turnLog.close();
	await new Promise((r) => setTimeout(r, 20));
	if (!fs.existsSync(ctx.turnLogFile)) return [];
	return fs
		.readFileSync(ctx.turnLogFile, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

describe("turn-log usage capture across response encodings", () => {
	// THE BUG (harness gate, Task #45): compressed SSE usage is parsed by an
	// ASYNC zlib decoder (telemetry.js makeStreamDecoder → decoder.on("data")).
	// The turn-log record is written synchronously when proxyRequest resolves
	// on upRes "end" (server.js await proxyRequest → turnLog.write). For
	// gzip/br responses the decoder's flush — which carries message_delta and
	// thus the final usage — lands on a LATER tick, AFTER the record was
	// already written with usage:null. Uncompressed SSE parses synchronously
	// inside consume() and is captured, which is why the L2 Haiku run dropped
	// usage on some real streamed turns but not others (nondeterministic by
	// whether/when the decoder flushed). The response bytes are forwarded fine
	// either way — this is a telemetry observation race, not stream corruption.
	test("gzip-encoded completed SSE turn records usage (was dropped by async-decoder race)", async () => {
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"content-encoding": "gzip",
			},
			body: zlib.gzipSync(Buffer.from(COMPLETED_SSE)),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const res = await post(port, "/agent-gz/v1/messages", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 512,
				stream: true,
			});
			expect(res.status).toBe(200);
			const records = await readTurnRecords(ctx);
			expect(records).toHaveLength(1);
			expect(records[0].usage).not.toBeNull();
			expect(records[0].usage.output_tokens).toBe(278);
			expect(records[0].usage.cache_creation_input_tokens).toBe(42296);
		} finally {
			teardown(ctx);
		}
	});

	// Control: the uncompressed path parses synchronously, so usage has always
	// been captured. This isolates the bug above to the async decoder.
	test("identity (uncompressed) completed SSE turn records usage", async () => {
		nextResponse = {
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: Buffer.from(COMPLETED_SSE),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await post(port, "/agent-id/v1/messages", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 512,
				stream: true,
			});
			const records = await readTurnRecords(ctx);
			expect(records).toHaveLength(1);
			expect(records[0].usage?.output_tokens).toBe(278);
		} finally {
			teardown(ctx);
		}
	});

	// brotli is the other encoding Claude Code negotiates; same async decoder.
	test("brotli-encoded completed SSE turn records usage", async () => {
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"content-encoding": "br",
			},
			body: zlib.brotliCompressSync(Buffer.from(COMPLETED_SSE)),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await post(port, "/agent-br/v1/messages", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 512,
				stream: true,
			});
			const records = await readTurnRecords(ctx);
			expect(records).toHaveLength(1);
			expect(records[0].usage?.output_tokens).toBe(278);
		} finally {
			teardown(ctx);
		}
	});
});

describe("response stream is forwarded byte-identical (non-mobile arms)", () => {
	// The user's hypothesis was a "stale length field after we rewrite the
	// stream." In the A0/A1/A5 arms clawback does NOT rewrite the response at
	// all — it pipes upstream bytes straight through. This proves that: the
	// bytes Claude Code receives are identical to what Anthropic sent, so the
	// stream is internally consistent because it is literally untouched.
	test("identity SSE: client receives byte-identical bytes", async () => {
		const raw = Buffer.from(COMPLETED_SSE);
		nextResponse = {
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: raw,
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const res = await post(port, "/agent-bytes/v1/messages", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 512,
				stream: true,
			});
			expect(res.status).toBe(200);
			expect(res.body.equals(raw)).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("gzip SSE: compressed bytes are forwarded unchanged (not re-coded)", async () => {
		const gz = zlib.gzipSync(Buffer.from(COMPLETED_SSE));
		nextResponse = {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"content-encoding": "gzip",
			},
			body: gz,
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const res = await post(port, "/agent-gzbytes/v1/messages", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 512,
				stream: true,
			});
			expect(res.status).toBe(200);
			expect(res.headers["content-encoding"]).toBe("gzip");
			expect(res.body.equals(gz)).toBe(true);
			// And it still decompresses to exactly the upstream SSE.
			expect(zlib.gunzipSync(res.body).toString("utf8")).toBe(COMPLETED_SSE);
		} finally {
			teardown(ctx);
		}
	});
});

describe("count_tokens is not logged as a turn", () => {
	// THE BUG: looksLikeMessages uses /\/v1\/messages(?:\/|$)/, which also
	// matches /v1/messages/count_tokens. That endpoint returns {input_tokens}
	// with NO usage block, so it was logged as a turn with usage:null —
	// polluting the analyzer's turn denominator (3 of A0's "null" L2 records
	// were actually count_tokens / preflight calls, not dropped turns).
	test("POST /v1/messages/count_tokens does not write a turn-log record", async () => {
		nextResponse = {
			status: 200,
			headers: { "content-type": "application/json" },
			body: Buffer.from(JSON.stringify({ input_tokens: 27 })),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const res = await post(port, "/v1/messages/count_tokens", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(res.status).toBe(200);
			const records = await readTurnRecords(ctx);
			expect(records).toHaveLength(0);
		} finally {
			teardown(ctx);
		}
	});

	test("POST /v1/messages still logs a turn (guard didn't over-match)", async () => {
		nextResponse = {
			status: 200,
			headers: { "content-type": "text/event-stream" },
			body: Buffer.from(COMPLETED_SSE),
		};
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await post(port, "/agent-real/v1/messages", {
				model: "claude-haiku-4-5",
				system: "be helpful",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 512,
				stream: true,
			});
			const records = await readTurnRecords(ctx);
			expect(records).toHaveLength(1);
		} finally {
			teardown(ctx);
		}
	});
});
