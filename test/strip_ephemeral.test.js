import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
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
			seenUpstreamRequests.push({
				url: req.url,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"usage":{"input_tokens":5,"output_tokens":1}}');
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => {
	upstream?.close();
});

beforeEach(() => {
	seenUpstreamRequests = [];
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-strip-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		turnLogFile: null,
		sessionLogDir: null,
		injectExtendedCacheTtl: false, // Don't add cache_control noise to assertions.
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
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

function requestBodyFor(model, system) {
	return {
		model,
		system,
		tools: [{ name: "read_file" }],
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 1,
	};
}

describe("PLAN §9 — strip ephemeral content from system", () => {
	test("two requests with different dates collapse to one SESSION KEY (default on)", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postJson(
				port,
				"/v1/messages",
				requestBodyFor(
					"claude-opus-4-5",
					"You are helpful.\nToday's date is 2026-04-25.\n<env>cwd: /a</env>",
				),
			);
			await postJson(
				port,
				"/v1/messages",
				requestBodyFor(
					"claude-opus-4-5",
					"You are helpful.\nToday's date is 2026-04-26.\n<env>cwd: /b</env>",
				),
			);

			const sessions = ctx.store.all();
			expect(sessions.length).toBe(1);
			expect(seenUpstreamRequests.length).toBe(2);
			// Both forwarded bodies should have <DATE> placeholder, not the
			// original ISO date, and <env> should be stripped.
			for (const r of seenUpstreamRequests) {
				expect(r.body).toMatch(/<DATE>/);
				expect(r.body).not.toMatch(/2026-04-25/);
				expect(r.body).not.toMatch(/2026-04-26/);
				expect(r.body).toMatch(/<env><STRIPPED><\/env>/);
				expect(r.body).not.toMatch(/cwd: \/a/);
				expect(r.body).not.toMatch(/cwd: \/b/);
			}
		} finally {
			teardown(ctx);
		}
	});

	test("disabling the flag preserves original system bytes and produces two sessions", async () => {
		const ctx = setup({ stripEphemeralFromSystem: false });
		const port = await listen(ctx.server);
		try {
			await postJson(
				port,
				"/v1/messages",
				requestBodyFor(
					"claude-opus-4-5",
					"You are helpful.\nToday's date is 2026-04-25.\n<env>cwd: /a</env>",
				),
			);
			await postJson(
				port,
				"/v1/messages",
				requestBodyFor(
					"claude-opus-4-5",
					"You are helpful.\nToday's date is 2026-04-26.\n<env>cwd: /b</env>",
				),
			);

			const sessions = ctx.store.all();
			expect(sessions.length).toBe(2);
			// Original strings preserved on the wire.
			expect(seenUpstreamRequests[0].body).toMatch(/2026-04-25/);
			expect(seenUpstreamRequests[0].body).toMatch(/cwd: \/a/);
			expect(seenUpstreamRequests[1].body).toMatch(/2026-04-26/);
			expect(seenUpstreamRequests[1].body).toMatch(/cwd: \/b/);
		} finally {
			teardown(ctx);
		}
	});

	test("non-ephemeral requests are not re-serialized (forward bytes unchanged)", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			// system has no ISO date, no "Today's date is", no <env> — strip
			// is a no-op and the original bodyBuffer should pass through.
			await postJson(
				port,
				"/v1/messages",
				requestBodyFor("claude-opus-4-5", "Plain helpful assistant."),
			);
			expect(seenUpstreamRequests.length).toBe(1);
			expect(seenUpstreamRequests[0].body).toMatch(/Plain helpful assistant\./);
			// Cosmetic: no <DATE> placeholder appears since nothing was stripped.
			expect(seenUpstreamRequests[0].body).not.toMatch(/<DATE>/);
		} finally {
			teardown(ctx);
		}
	});

	test("captured session.system stores the stripped value", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postJson(
				port,
				"/v1/messages",
				requestBodyFor(
					"claude-opus-4-5",
					"You are helpful.\nToday's date is 2026-04-25.",
				),
			);
			const sessions = ctx.store.all();
			expect(sessions.length).toBe(1);
			const sys = sessions[0].system;
			const sysText = typeof sys === "string" ? sys : JSON.stringify(sys);
			expect(sysText).not.toMatch(/2026-04-25/);
			expect(sysText).toMatch(/<DATE>/);
		} finally {
			teardown(ctx);
		}
	});
});
