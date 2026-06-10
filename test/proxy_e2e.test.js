import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { clearSamples } from "../src/metrics_log.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

let upstream;
let upstreamPort;
let seenUpstreamRequests = [];

// PLAN §39: metrics_log is module-scoped state shared across the whole
// test file. Without a between-test clear, /v1/messages traffic from one
// test populates the metrics ring with session keys ("agent-1", "agent-2",
// etc.) that then leak into the next test's /_proxy/sessions response
// (which now enriches with metrics-only sessions for the UI overlay
// feature).
beforeEach(() => {
	clearSamples();
});

beforeAll(async () => {
	upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			seenUpstreamRequests.push({
				method: req.method,
				url: req.url,
				headers: req.headers,
				body,
			});
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"anthropic-ratelimit-tokens-remaining": "40000",
				"anthropic-ratelimit-tokens-reset": "2026-04-18T10:30:00Z",
			});
			res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
			res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => {
	upstream?.close();
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-e2e-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		keepAliveMinMs: 60_000,
		keepAliveMaxMs: 240_000,
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

function postJson(port, urlPath, body, extraHeaders = {}) {
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
					...extraHeaders,
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

function request(port, urlPath, method = "GET") {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ method, host: "127.0.0.1", port, path: urlPath },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

test("path mode: strips agentId, forwards to upstream, captures session", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		const res = await postJson(port, "/alex-alpha/v1/messages", {
			model: "claude-opus-4-5",
			system: "be helpful",
			tools: [{ name: "read_file" }],
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 10,
		});
		expect(res.status).toBe(200);
		expect(seenUpstreamRequests.length).toBe(1);
		expect(seenUpstreamRequests[0].url).toBe("/v1/messages");

		const session = ctx.store.get("alex-alpha");
		expect(session).toBeTruthy();
		expect(session.mode).toBe("path");
		expect(session.model).toBe("claude-opus-4-5");
		expect(session.authHeaders.authorization).toBe("Bearer test-key");
		expect(session.targetTtl).toBe("2026-04-18T10:30:00.000Z");
	} finally {
		teardown(ctx);
	}
});

test("e2e: nested cache_control on system gets rewritten to ttl=1h on the wire", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		// Mirrors what Claude Code actually sends: per-block
		// cache_control with no explicit ttl. Pre-rewrite this landed at
		// Anthropic's 5m default, and clawback's top-level injection got
		// skipped entirely because nested cache_control was present.
		const res = await postJson(port, "/cc-rewrite/v1/messages", {
			model: "claude-opus-4-5",
			system: [
				{
					type: "text",
					text: "you are helpful",
					cache_control: { type: "ephemeral" },
				},
			],
			tools: [
				{ name: "Bash", cache_control: { type: "ephemeral", ttl: "5m" } },
			],
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(200);
		expect(seenUpstreamRequests.length).toBe(1);
		const fwd = JSON.parse(seenUpstreamRequests[0].body);
		expect(fwd.system[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(fwd.tools[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		// No top-level injection — would 400 against the rewritten nested blocks.
		expect(fwd.cache_control).toBeUndefined();

		const session = ctx.store.get("cc-rewrite");
		expect(session.ttlMode).toBe("1h");
		expect(session.cacheControlInjection).toMatchObject({
			eligibleTurns: 1,
			rewriteTurns: 1,
			blocksRewritten: 2,
			topLevelTurns: 0,
			alreadyExtendedTurns: 0,
		});
	} finally {
		teardown(ctx);
	}
});

test("e2e: rewriteNestedCacheControl=false reverts to legacy skip behaviour", async () => {
	seenUpstreamRequests = [];
	const ctx = setup({ rewriteNestedCacheControl: false });
	const port = await listen(ctx.server);
	try {
		const res = await postJson(port, "/cc-legacy/v1/messages", {
			model: "claude-opus-4-5",
			system: [
				{
					type: "text",
					text: "x",
					cache_control: { type: "ephemeral", ttl: "5m" },
				},
			],
			messages: [{ role: "user", content: "hi" }],
		});
		expect(res.status).toBe(200);
		const fwd = JSON.parse(seenUpstreamRequests[0].body);
		// Legacy path: leave the 5m block alone, don't add top-level.
		expect(fwd.system[0].cache_control.ttl).toBe("5m");
		expect(fwd.cache_control).toBeUndefined();
		const session = ctx.store.get("cc-legacy");
		expect(session.ttlMode).toBe("5m");
		expect(session.cacheControlInjection.blocksRewritten).toBe(0);
	} finally {
		teardown(ctx);
	}
});

test("hash mode: same system+tools yields same session key", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		const body = {
			model: "claude-opus-4-5",
			system: "be helpful",
			tools: [{ name: "read_file" }],
			messages: [{ role: "user", content: "one" }],
			max_tokens: 10,
		};
		await postJson(port, "/v1/messages", body);
		await postJson(port, "/v1/messages", {
			...body,
			messages: [{ role: "user", content: "two" }],
		});

		const keys = ctx.store.keys();
		expect(keys.length).toBe(1);
		expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
	} finally {
		teardown(ctx);
	}
});

test("hash mode: different system yields different sessions", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		await postJson(port, "/v1/messages", {
			system: "a",
			messages: [],
			max_tokens: 1,
		});
		await postJson(port, "/v1/messages", {
			system: "b",
			messages: [],
			max_tokens: 1,
		});
		expect(ctx.store.keys().length).toBe(2);
	} finally {
		teardown(ctx);
	}
});

test("admin API: list, get, delete sessions", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		await postJson(port, "/agent-1/v1/messages", {
			system: "hi",
			messages: [],
			max_tokens: 1,
		});
		await postJson(port, "/agent-2/v1/messages", {
			system: "hi",
			messages: [],
			max_tokens: 1,
		});

		const list = await request(port, "/_proxy/sessions");
		const parsed = JSON.parse(list.body);
		expect(parsed.count).toBe(2);

		const one = await request(port, "/_proxy/sessions/agent-1");
		expect(one.status).toBe(200);

		const del = await request(port, "/_proxy/sessions/agent-1", "DELETE");
		expect(del.status).toBe(200);

		const missing = await request(port, "/_proxy/sessions/agent-1");
		expect(missing.status).toBe(404);

		const delAll = await request(port, "/_proxy/sessions", "DELETE");
		expect(delAll.status).toBe(200);
		expect(ctx.store.keys().length).toBe(0);
	} finally {
		teardown(ctx);
	}
});

test("admin API: health returns status ok", async () => {
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		const r = await request(port, "/_proxy/health");
		expect(r.status).toBe(200);
		const body = JSON.parse(r.body);
		expect(body.status).toBe("ok");
		expect(typeof body.version).toBe("string");
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
	} finally {
		teardown(ctx);
	}
});

test("admin API: GET /_proxy/version returns the package version", async () => {
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		const r = await request(port, "/_proxy/version");
		expect(r.status).toBe(200);
		const body = JSON.parse(r.body);
		expect(typeof body.version).toBe("string");
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		// Match the value the bin's --version flag prints, since both
		// must be the same source of truth (src/version.js).
		const { CLAWBACK_VERSION } = await import("../src/version.js");
		expect(body.version).toBe(CLAWBACK_VERSION);
	} finally {
		teardown(ctx);
	}
});

test("non-messages path passes through unchanged (no session captured)", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		const res = await postJson(port, "/v1/complete", { prompt: "legacy" });
		expect(res.status).toBe(200);
		expect(ctx.store.keys().length).toBe(0);
		expect(seenUpstreamRequests[0].url).toBe("/v1/complete");
	} finally {
		teardown(ctx);
	}
});

test("baseline capture: each forwarded /v1/messages decrements; passthrough flips off when zero", async () => {
	const ctx = setup({ baselineCaptureTurns: 3 });
	const port = await listen(ctx.server);
	try {
		// Arm a 3-turn capture. passthrough flips on synchronously.
		const armed = await postJson(port, "/_proxy/capture-baseline", {});
		expect(armed.status).toBe(200);
		const armedBody = JSON.parse(armed.body);
		expect(armedBody.active).toBe(true);
		expect(armedBody.targetTurns).toBe(3);
		expect(armedBody.turnsRemaining).toBe(3);
		expect(ctx.config.passthrough).toBe(true);

		// Turn 1.
		await postJson(port, "/agent-1/v1/messages", {
			model: "claude-sonnet-4-6",
			system: "be helpful",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
		});
		expect(ctx.config._baselineCapture.turnsRemaining).toBe(2);
		expect(ctx.config.passthrough).toBe(true);

		// Turn 2.
		await postJson(port, "/agent-1/v1/messages", {
			model: "claude-sonnet-4-6",
			system: "be helpful",
			messages: [{ role: "user", content: "again" }],
			max_tokens: 1,
		});
		expect(ctx.config._baselineCapture.turnsRemaining).toBe(1);
		expect(ctx.config.passthrough).toBe(true);

		// Turn 3 — auto-completes the capture.
		await postJson(port, "/agent-1/v1/messages", {
			model: "claude-sonnet-4-6",
			system: "be helpful",
			messages: [{ role: "user", content: "and again" }],
			max_tokens: 1,
		});
		expect(ctx.config._baselineCapture.active).toBe(false);
		expect(ctx.config._baselineCapture.turnsRemaining).toBe(0);
		expect(ctx.config.passthrough).toBe(false);

		// A `baseline-captured` event is in the ring after completion.
		const evts = await request(port, "/_proxy/events");
		const list = JSON.parse(evts.body).events;
		expect(list.some((e) => e.type === "baseline-captured")).toBe(true);
	} finally {
		teardown(ctx);
	}
});

test("capture-body: one-shot dump of the pristine system+tools body at 0600", async () => {
	seenUpstreamRequests = [];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-cap-"));
	const fixturePath = path.join(dir, "fixture.json");
	const ctx = setup({ captureBodyPath: fixturePath });
	const port = await listen(ctx.server);
	try {
		// A thin continuation turn (no tools) must NOT be captured.
		await postJson(port, "/cap/v1/messages", {
			model: "claude-haiku-4-5-20251001",
			system: [{ type: "text", text: "sys" }],
			messages: [{ role: "user", content: "thin" }],
			max_tokens: 1,
		});
		expect(fs.existsSync(fixturePath)).toBe(false);

		// A thin auxiliary turn with an EMPTY tools array (`tools: []`) must
		// NOT be captured. Claude Code's title/topic Haiku side-calls send
		// `tools: []` — that is `!= null`, so a `tools == null` latch would
		// wrongly grab this breakpoint-free body and the 1h-TTL arm would
		// replay a no-op fixture.
		await postJson(port, "/cap/v1/messages", {
			model: "claude-haiku-4-5-20251001",
			system: [{ type: "text", text: "sys" }],
			tools: [],
			messages: [{ role: "user", content: "aux" }],
			max_tokens: 1,
		});
		expect(fs.existsSync(fixturePath)).toBe(false);

		// A rich turn (system + tools) is captured pristine.
		const rich = {
			model: "claude-haiku-4-5-20251001",
			system: [
				{
					type: "text",
					text: "you are helpful",
					cache_control: { type: "ephemeral" },
				},
			],
			tools: [{ name: "Bash", cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: "rich" }],
			max_tokens: 1,
		};
		await postJson(port, "/cap/v1/messages", rich);
		expect(fs.existsSync(fixturePath)).toBe(true);
		const captured = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
		// Pristine: cache_control is the client's original 5m-default (NOT the
		// 1h rewrite clawback applies on the wire), proving we dumped pre-mutation.
		expect(captured.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(captured.tools[0].name).toBe("Bash");
		expect(captured.messages[0].content).toBe("rich");
		if (process.platform !== "win32") {
			const mode = fs.statSync(fixturePath).mode & 0o777;
			expect(mode & 0o077).toBe(0); // owner-only — body holds prompts/tools
		}

		// One-shot: a later, different rich turn does NOT overwrite.
		await postJson(port, "/cap/v1/messages", { ...rich, _marker: "second" });
		const after = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
		expect(after._marker).toBeUndefined();
	} finally {
		teardown(ctx);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Audit H2: a client sending `GET //evil/v1/foo` would, before the fix,
// have caused proxy.js to compute `new URL("//evil/v1/foo", upstreamBase)`
// → `https://evil/v1/foo`. clawback must refuse rather than forward.
test("rejects // request-target SSRF", async () => {
	seenUpstreamRequests = [];
	const ctx = setup();
	const port = await listen(ctx.server);
	try {
		// http.request normalizes paths starting with `/`; the only way to
		// inject a `//host/...` request-target is via a raw socket write.
		const { createConnection } = await import("node:net");
		const sock = createConnection(port, "127.0.0.1");
		await new Promise((resolve, reject) => {
			sock.once("connect", resolve);
			sock.once("error", reject);
		});
		sock.write(
			`GET //evil.example/v1/anything HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
		);
		const chunks = [];
		for await (const chunk of sock) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		const statusLine = raw.split("\r\n")[0];
		// Either an outright 400 from the new guard, OR a non-2xx that
		// didn't reach the test upstream. The thing we MUST verify is that
		// the test upstream (which only accepts /v1/messages) didn't get
		// hit with an evil-host-bound request.
		expect(statusLine).toMatch(/^HTTP\/1\.1 4\d\d/);
		expect(seenUpstreamRequests).toEqual([]);
	} finally {
		teardown(ctx);
	}
});
