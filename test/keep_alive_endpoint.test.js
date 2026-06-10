import http from "node:http";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

function setupServer(overrides = {}) {
	const dir = `/tmp/clawback-keepalive-${process.pid}-${Math.random()
		.toString(36)
		.slice(2)}`;
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		stateFile: `${dir}/state.json`,
		turnLogFile: null,
		sessionLogDir: null,
		keepAliveEnabled: true,
		passthrough: false,
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const startCalls = [];
	const stopCalls = [];
	const scheduler = {
		start() {
			startCalls.push(Date.now());
		},
		stop() {
			stopCalls.push(Date.now());
		},
		ensureScheduled() {},
		cancelSession() {},
	};
	const server = createServer({ config, store, scheduler, logger });
	return { config, store, scheduler, server, startCalls, stopCalls };
}

function listen(server) {
	return new Promise((r) =>
		server.listen(0, "127.0.0.1", () => r(server.address().port)),
	);
}

function jsonReq(port, urlPath, method = "GET", body = null) {
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

describe("/_proxy/keep-alive admin endpoint", () => {
	test("GET returns current keep-alive state plus passthrough context", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/keep-alive");
			expect(r.status).toBe(200);
			expect(r.body).toEqual({
				keepAliveEnabled: true,
				passthrough: false,
			});
		} finally {
			ctx.server.close();
		}
	});

	test("POST {action:'off'} stops the scheduler and flips the config flag", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				action: "off",
			});
			expect(r.status).toBe(200);
			expect(r.body.keepAliveEnabled).toBe(false);
			expect(ctx.config.keepAliveEnabled).toBe(false);
			expect(ctx.stopCalls.length).toBeGreaterThanOrEqual(1);
			expect(ctx.startCalls.length).toBe(0);
		} finally {
			ctx.server.close();
		}
	});

	test("POST {action:'toggle'} flips the flag once each call", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			let r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				action: "toggle",
			});
			expect(r.body.keepAliveEnabled).toBe(false);
			r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				action: "toggle",
			});
			expect(r.body.keepAliveEnabled).toBe(true);
			expect(ctx.startCalls.length).toBeGreaterThanOrEqual(1);
			expect(ctx.stopCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			ctx.server.close();
		}
	});

	test("POST {enabled: true/false} works as an explicit setter", async () => {
		const ctx = setupServer({ keepAliveEnabled: false });
		const port = await listen(ctx.server);
		try {
			let r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				enabled: true,
			});
			expect(r.body.keepAliveEnabled).toBe(true);
			r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				enabled: false,
			});
			expect(r.body.keepAliveEnabled).toBe(false);
		} finally {
			ctx.server.close();
		}
	});

	test("POST is refused with 409 while passthrough is on (mutual exclusivity)", async () => {
		const ctx = setupServer({ passthrough: true, keepAliveEnabled: false });
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				action: "on",
			});
			expect(r.status).toBe(409);
			expect(r.body.error).toBe("conflict");
			expect(r.body.message).toMatch(/passthrough/);
			// State unchanged.
			expect(ctx.config.keepAliveEnabled).toBe(false);
			expect(ctx.startCalls.length).toBe(0);
		} finally {
			ctx.server.close();
		}
	});

	test("POST with malformed body returns 400", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/keep-alive", "POST", {
				weird: "thing",
			});
			expect(r.status).toBe(400);
			expect(r.body.error).toBe("bad_request");
		} finally {
			ctx.server.close();
		}
	});

	test("DELETE returns 405", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/keep-alive", "DELETE");
			expect(r.status).toBe(405);
		} finally {
			ctx.server.close();
		}
	});
});
