import http from "node:http";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

function setupServer(overrides = {}) {
	const dir = `/tmp/clawback-strip-${process.pid}-${Math.random()
		.toString(36)
		.slice(2)}`;
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		stateFile: `${dir}/state.json`,
		turnLogFile: null,
		sessionLogDir: null,
		stripEphemeralFromSystem: true,
		passthrough: false,
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const scheduler = {
		start() {},
		stop() {},
		ensureScheduled() {},
		cancelSession() {},
	};
	const server = createServer({ config, store, scheduler, logger });
	return { config, store, scheduler, server };
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

describe("/_proxy/strip-ephemeral admin endpoint", () => {
	test("GET returns current state plus passthrough context", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/strip-ephemeral");
			expect(r.status).toBe(200);
			expect(r.body).toEqual({
				stripEphemeralFromSystem: true,
				passthrough: false,
			});
		} finally {
			ctx.server.close();
		}
	});

	test("POST {action:'off'} flips the config flag", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/strip-ephemeral", "POST", {
				action: "off",
			});
			expect(r.status).toBe(200);
			expect(r.body.stripEphemeralFromSystem).toBe(false);
			expect(ctx.config.stripEphemeralFromSystem).toBe(false);
		} finally {
			ctx.server.close();
		}
	});

	test("POST {action:'toggle'} flips on each call", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			let r = await jsonReq(port, "/_proxy/strip-ephemeral", "POST", {
				action: "toggle",
			});
			expect(r.body.stripEphemeralFromSystem).toBe(false);
			r = await jsonReq(port, "/_proxy/strip-ephemeral", "POST", {
				action: "toggle",
			});
			expect(r.body.stripEphemeralFromSystem).toBe(true);
		} finally {
			ctx.server.close();
		}
	});

	test("POST is refused with 409 while passthrough is on (mutual exclusivity)", async () => {
		const ctx = setupServer({
			passthrough: true,
			stripEphemeralFromSystem: false,
		});
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/strip-ephemeral", "POST", {
				action: "on",
			});
			expect(r.status).toBe(409);
			expect(r.body.error).toBe("conflict");
			expect(r.body.message).toMatch(/passthrough/);
			expect(ctx.config.stripEphemeralFromSystem).toBe(false);
		} finally {
			ctx.server.close();
		}
	});

	test("POST with malformed body returns 400", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/strip-ephemeral", "POST", {
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
			const r = await jsonReq(port, "/_proxy/strip-ephemeral", "DELETE");
			expect(r.status).toBe(405);
		} finally {
			ctx.server.close();
		}
	});
});
