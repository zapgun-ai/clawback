import http from "node:http";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { appendSample, clearSamples } from "../src/metrics_log.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

beforeEach(() => {
	clearSamples();
});

function setupServer(overrides = {}) {
	const dir = `/tmp/clawback-metrics-${process.pid}-${Math.random()
		.toString(36)
		.slice(2)}`;
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		stateFile: `${dir}/state.json`,
		turnLogFile: null,
		sessionLogDir: null,
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

describe("/_proxy/metrics admin endpoint", () => {
	test("GET returns the ring contents in {samples, capacity, returned} shape", async () => {
		appendSample({ source: "statusline", hit: 50 });
		appendSample({ source: "upstream", tps: 80 });
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/metrics");
			expect(r.status).toBe(200);
			expect(Array.isArray(r.body.samples)).toBe(true);
			expect(r.body.samples).toHaveLength(2);
			// PLAN §39: capacity is now per-session (500), not the global 2000.
			expect(r.body.capacity).toBe(500);
			expect(r.body.returned).toBe(2);
			expect(r.body.samples[0].source).toBe("statusline");
			expect(r.body.samples[0].hit).toBe(50);
			expect(r.body.samples[1].source).toBe("upstream");
		} finally {
			ctx.server.close();
		}
	});

	test("GET ?since= filters to samples strictly after the given timestamp", async () => {
		appendSample({
			source: "upstream",
			hit: 10,
			ts: "2026-05-12T10:00:00.000Z",
		});
		appendSample({
			source: "upstream",
			hit: 20,
			ts: "2026-05-12T10:01:00.000Z",
		});
		appendSample({
			source: "upstream",
			hit: 30,
			ts: "2026-05-12T10:02:00.000Z",
		});
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(
				port,
				"/_proxy/metrics?since=2026-05-12T10:00:30.000Z",
			);
			expect(r.status).toBe(200);
			expect(r.body.samples).toHaveLength(2);
			expect(r.body.samples[0].hit).toBe(20);
			expect(r.body.samples[1].hit).toBe(30);
		} finally {
			ctx.server.close();
		}
	});

	test("GET ?limit= caps the result to the N most recent", async () => {
		for (let i = 0; i < 5; i++) appendSample({ source: "upstream", hit: i });
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/metrics?limit=2");
			expect(r.status).toBe(200);
			expect(r.body.samples).toHaveLength(2);
			expect(r.body.samples[0].hit).toBe(3);
			expect(r.body.samples[1].hit).toBe(4);
		} finally {
			ctx.server.close();
		}
	});

	test("POST {action:'clear'} wipes the ring and reports how many were cleared", async () => {
		appendSample({ source: "upstream", hit: 1 });
		appendSample({ source: "upstream", hit: 2 });
		appendSample({ source: "upstream", hit: 3 });
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/metrics", "POST", {
				action: "clear",
			});
			expect(r.status).toBe(200);
			// PLAN §39: clear-all response includes session: null to mirror the
			// optional {session: "<id>"} branch that clears just one ring.
			expect(r.body).toEqual({ cleared: true, count: 3, session: null });

			const after = await jsonReq(port, "/_proxy/metrics");
			expect(after.body.samples).toHaveLength(0);
		} finally {
			ctx.server.close();
		}
	});

	test("POST with an unknown action returns 400", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/metrics", "POST", {
				action: "explode",
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
			const r = await jsonReq(port, "/_proxy/metrics", "DELETE");
			expect(r.status).toBe(405);
		} finally {
			ctx.server.close();
		}
	});
});
