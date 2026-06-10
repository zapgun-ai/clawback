import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

let upstream;
let upstreamPort;
let seenUpstreamRequests = [];

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
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [],
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			);
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => {
	upstream?.close();
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-passthrough-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
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
					"anthropic-version": "2023-06-01",
				},
			},
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
		req.end(payload);
	});
}

describe("passthrough config resolution", () => {
	const isolatedEnv = {
		HOME: "/nonexistent-clawback-home",
		XDG_CONFIG_HOME: "",
	};

	test("passthrough=true forces injectExtendedCacheTtl=false and keepAliveEnabled=false", () => {
		const { config: c } = loadConfig({
			cliOverrides: { passthrough: true },
			env: isolatedEnv,
		});
		expect(c.passthrough).toBe(true);
		expect(c.injectExtendedCacheTtl).toBe(false);
		expect(c.keepAliveEnabled).toBe(false);
	});

	test("defaults keep treatment mode on", () => {
		const { config: c } = loadConfig({ env: isolatedEnv });
		expect(c.passthrough).toBe(false);
		expect(c.injectExtendedCacheTtl).toBe(true);
		expect(c.keepAliveEnabled).toBe(true);
	});

	test("explicit injectExtendedCacheTtl=true is overridden by passthrough", () => {
		const { config: c } = loadConfig({
			cliOverrides: { passthrough: true, injectExtendedCacheTtl: true },
			env: isolatedEnv,
		});
		expect(c.injectExtendedCacheTtl).toBe(false);
	});
});

describe("passthrough runtime behavior", () => {
	test("forwards body bytes unchanged (no cache_control injection)", async () => {
		seenUpstreamRequests = [];
		const ctx = setup({
			passthrough: true,
			injectExtendedCacheTtl: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			const body = {
				model: "claude-sonnet-4-6",
				system: "be helpful",
				tools: [{ name: "read_file" }],
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			};
			const expectedBytes = JSON.stringify(body);
			const res = await postJson(port, "/v1/messages", body);
			expect(res.status).toBe(200);
			expect(seenUpstreamRequests).toHaveLength(1);
			expect(seenUpstreamRequests[0].body).toBe(expectedBytes);
			const parsed = JSON.parse(seenUpstreamRequests[0].body);
			expect(parsed.cache_control).toBeUndefined();
		} finally {
			teardown(ctx);
		}
	});

	// Passthrough's entire job is to forward Claude Code's bytes verbatim so the
	// A0 baseline measures native behavior — no re-serialization, no injected
	// blocks (CLAUDE.md: passthrough is "not configurable away"). The stronger
	// guard against non-canonical wire bytes diverging on re-serialization lives
	// in test/byte_faithfulness.test.js; this is the passthrough-suite anchor.
	test("passthrough forwards the request body unchanged", async () => {
		seenUpstreamRequests = [];
		const ctx = setup({
			passthrough: true,
			injectExtendedCacheTtl: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			const body = {
				model: "claude-sonnet-4-6",
				system: "be helpful",
				tools: [{ name: "read_file" }],
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			};
			const expectedBytes = JSON.stringify(body);
			const res = await postJson(port, "/v1/messages", body);

			// The response still comes back fine...
			expect(res.status).toBe(200);
			expect(seenUpstreamRequests).toHaveLength(1);

			// ...and the bytes Anthropic received are byte-identical to what the
			// client sent — no injected block, no re-serialization.
			expect(seenUpstreamRequests[0].body).toBe(expectedBytes);
		} finally {
			teardown(ctx);
		}
	});

	test("treatment mode injects cache_control (control for the above)", async () => {
		seenUpstreamRequests = [];
		const ctx = setup({
			passthrough: false,
			injectExtendedCacheTtl: true,
			keepAliveEnabled: true,
		});
		const port = await listen(ctx.server);
		try {
			const body = {
				model: "claude-sonnet-4-6",
				system: "be helpful",
				tools: [{ name: "read_file" }],
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			};
			await postJson(port, "/v1/messages", body);
			const parsed = JSON.parse(seenUpstreamRequests[0].body);
			expect(parsed.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		} finally {
			teardown(ctx);
		}
	});

	test("no keep-alive timer scheduled after session captured in passthrough", async () => {
		seenUpstreamRequests = [];
		const ctx = setup({
			passthrough: true,
			injectExtendedCacheTtl: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/agent-x/v1/messages", {
				model: "claude-sonnet-4-6",
				system: "hi",
				messages: [],
				max_tokens: 1,
			});
			expect(ctx.store.has("agent-x")).toBe(true);
			expect(ctx.scheduler.timers.size).toBe(0);
		} finally {
			teardown(ctx);
		}
	});

	test("scheduler.start() is a no-op when keepAliveEnabled=false even with existing sessions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-passthrough-"));
		try {
			const config = {
				...DEFAULTS,
				port: 0,
				stateFile: path.join(dir, "state.json"),
				keepAliveEnabled: false,
			};
			const store = new SessionStore({ filePath: config.stateFile, logger });
			store.upsert("preexisting", () => ({
				key: "preexisting",
				mode: "path",
				createdAt: new Date().toISOString(),
				keepAliveTokensUsed: 0,
			}));
			const scheduler = new KeepAliveScheduler({
				config,
				store,
				logger,
				fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
			});
			scheduler.start();
			expect(scheduler.timers.size).toBe(0);
			scheduler.stop();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
