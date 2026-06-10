import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");
let upstream;
let upstreamPort;

beforeAll(async () => {
	upstream = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => upstream?.close());

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-toggle-"));
	// Build config the way other server-level tests do — bypass loadConfig
	// (which validates port > 0), but mirror its post-merge baselineSnapshot
	// + passthrough-bundle override so the toggle endpoint behaves the same.
	const merged = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		turnLogFile: null,
		sessionLogDir: null,
		...overrides,
	};
	merged._baselineSnapshot = {
		injectExtendedCacheTtl: merged.injectExtendedCacheTtl,
		rewriteNestedCacheControl: merged.rewriteNestedCacheControl,
		stripEphemeralFromSystem: merged.stripEphemeralFromSystem,
		keepAliveEnabled: merged.keepAliveEnabled,
	};
	if (merged.passthrough) {
		merged.injectExtendedCacheTtl = false;
		merged.rewriteNestedCacheControl = false;
		merged.stripEphemeralFromSystem = false;
		merged.keepAliveEnabled = false;
	}
	const config = merged;
	const store = new SessionStore({ filePath: config.stateFile, logger });
	let started = false;
	let stopped = false;
	const scheduler = {
		start() {
			started = true;
		},
		stop() {
			stopped = true;
		},
		ensureScheduled() {},
		cancelSession() {},
		_state: () => ({ started, stopped }),
	};
	const server = createServer({ config, store, scheduler, logger });
	return { config, store, scheduler, server, dir };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function teardown({ server, dir }) {
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

function jsonRequest(port, urlPath, method = "GET", body = null) {
	return new Promise((resolve, reject) => {
		const headers = { "content-type": "application/json" };
		const payload = body == null ? null : JSON.stringify(body);
		if (payload) headers["content-length"] = Buffer.byteLength(payload);
		const req = http.request(
			{ method, host: "127.0.0.1", port, path: urlPath, headers },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
					}),
				);
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

describe("/_proxy/passthrough runtime toggle", () => {
	test("GET reports the boot-time mode and the operator's pre-passthrough snapshot", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await jsonRequest(port, "/_proxy/passthrough");
			expect(r.status).toBe(200);
			expect(r.body.passthrough).toBe(false);
			expect(r.body.injectExtendedCacheTtl).toBe(true);
			expect(r.body.stripEphemeralFromSystem).toBe(true);
			expect(r.body.keepAliveEnabled).toBe(true);
			// Snapshot reflects what would be restored on toggle-off.
			expect(r.body.baselineSnapshot).toEqual({
				injectExtendedCacheTtl: true,
				rewriteNestedCacheControl: true,
				stripEphemeralFromSystem: true,
				keepAliveEnabled: true,
			});
		} finally {
			teardown(ctx);
		}
	});

	test('POST {action:"toggle"} flips off → on and stops the scheduler', async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await jsonRequest(port, "/_proxy/passthrough", "POST", {
				action: "toggle",
			});
			expect(r.status).toBe(200);
			expect(r.body.passthrough).toBe(true);
			expect(r.body.injectExtendedCacheTtl).toBe(false);
			expect(r.body.stripEphemeralFromSystem).toBe(false);
			expect(r.body.keepAliveEnabled).toBe(false);
			expect(ctx.scheduler._state().stopped).toBe(true);
			// Live config object also mutated (next request would see passthrough on).
			expect(ctx.config.passthrough).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("POST toggle is reversible — on → off restores from snapshot and restarts scheduler", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await jsonRequest(port, "/_proxy/passthrough", "POST", {
				action: "toggle",
			});
			const r = await jsonRequest(port, "/_proxy/passthrough", "POST", {
				action: "toggle",
			});
			expect(r.body.passthrough).toBe(false);
			expect(r.body.injectExtendedCacheTtl).toBe(true);
			expect(r.body.stripEphemeralFromSystem).toBe(true);
			expect(r.body.keepAliveEnabled).toBe(true);
			expect(ctx.scheduler._state().started).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("POST {enabled:true} forces on; {enabled:false} forces off", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			let r = await jsonRequest(port, "/_proxy/passthrough", "POST", {
				enabled: true,
			});
			expect(r.body.passthrough).toBe(true);
			r = await jsonRequest(port, "/_proxy/passthrough", "POST", {
				enabled: false,
			});
			expect(r.body.passthrough).toBe(false);
		} finally {
			teardown(ctx);
		}
	});

	test("snapshot captures the operator's intent — non-default flags survive a round-trip", async () => {
		const ctx = setup({ injectExtendedCacheTtl: false });
		const port = await listen(ctx.server);
		try {
			// Snapshot should remember inject was off.
			let r = await jsonRequest(port, "/_proxy/passthrough");
			expect(r.body.baselineSnapshot.injectExtendedCacheTtl).toBe(false);
			// Toggle on then off — inject should still be off (operator's intent preserved).
			await jsonRequest(port, "/_proxy/passthrough", "POST", {
				action: "toggle",
			});
			r = await jsonRequest(port, "/_proxy/passthrough", "POST", {
				action: "toggle",
			});
			expect(r.body.passthrough).toBe(false);
			expect(r.body.injectExtendedCacheTtl).toBe(false);
			expect(r.body.stripEphemeralFromSystem).toBe(true);
			expect(r.body.keepAliveEnabled).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("POST with bogus body returns 400", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await jsonRequest(port, "/_proxy/passthrough", "POST", {
				something: "else",
			});
			expect(r.status).toBe(400);
		} finally {
			teardown(ctx);
		}
	});
});
