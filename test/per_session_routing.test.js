// PLAN §39 (Phase 1): per-session statusline routing + sessions endpoint
// label POST + metrics ?session filter. End-to-end against a live admin
// HTTP surface, no upstream Anthropic involved.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { appendSample, clearSamples } from "../src/metrics_log.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

beforeEach(() => {
	clearSamples();
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-per-session-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
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

function jsonReq(port, urlPath, method = "GET", body = null) {
	return new Promise((resolve, reject) => {
		const payload = body == null ? null : JSON.stringify(body);
		const req = http.request(
			{
				method,
				host: "127.0.0.1",
				port,
				path: urlPath,
				headers: payload
					? {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(payload),
						}
					: {},
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: text.length ? JSON.parse(text) : null,
					});
				});
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

function textReq(port, urlPath, method = "GET", body = null) {
	return new Promise((resolve, reject) => {
		const payload = body == null ? null : JSON.stringify(body);
		const req = http.request(
			{
				method,
				host: "127.0.0.1",
				port,
				path: urlPath,
				headers: payload
					? {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(payload),
						}
					: {},
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
		if (payload) req.write(payload);
		req.end();
	});
}

describe("POST /_proxy/sessions/<id> with {label}", () => {
	test("creates a stub session record when none exists", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/sessions/a3f9b2c1", "POST", {
				label: "red",
			});
			expect(r.status).toBe(200);
			expect(r.body.key).toBe("a3f9b2c1");
			expect(r.body.label).toBe("red");
			expect(r.body.labelSource).toBe("operator");
			expect(ctx.store.get("a3f9b2c1")).toBeTruthy();
			expect(ctx.store.get("a3f9b2c1").label).toBe("red");
		} finally {
			teardown(ctx);
		}
	});

	test("updates the label on an existing session record without clobbering other fields", async () => {
		const ctx = setup();
		ctx.store.upsert("k1", () => ({
			key: "k1",
			mode: "path",
			cacheReadTokens: 1234,
			createdAt: "2026-01-01T00:00:00.000Z",
		}));
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/sessions/k1", "POST", {
				label: "blue-thing",
			});
			expect(r.status).toBe(200);
			expect(r.body.label).toBe("blue-thing");
			expect(ctx.store.get("k1").cacheReadTokens).toBe(1234);
			expect(ctx.store.get("k1").createdAt).toBe("2026-01-01T00:00:00.000Z");
		} finally {
			teardown(ctx);
		}
	});

	test("rejects invalid labels with 400", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const tooLong = await jsonReq(
				port,
				"/_proxy/sessions/k1",
				"POST",
				// Label max is 64 (bumped from 32 for the host prefix); 65 overflows.
				{ label: "x".repeat(65) },
			);
			expect(tooLong.status).toBe(400);
			const bad = await jsonReq(port, "/_proxy/sessions/k1", "POST", {
				label: "with/slash",
			});
			expect(bad.status).toBe(400);
			const reserved = await jsonReq(port, "/_proxy/sessions/k1", "POST", {
				label: "_default",
			});
			expect(reserved.status).toBe(400);
		} finally {
			teardown(ctx);
		}
	});

	test("missing body / wrong shape returns 400", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const noBody = await jsonReq(port, "/_proxy/sessions/k1", "POST", {});
			expect(noBody.status).toBe(400);
			const wrongType = await jsonReq(port, "/_proxy/sessions/k1", "POST", {
				label: 42,
			});
			expect(wrongType.status).toBe(400);
		} finally {
			teardown(ctx);
		}
	});
});

describe("GET /_proxy/sessions enrichment", () => {
	test("merges store records with metrics-ring summaries", async () => {
		const ctx = setup();
		ctx.store.upsert("red", () => ({
			key: "red",
			mode: "path",
			label: "red-label",
			labelSource: "operator",
		}));
		appendSample({
			source: "upstream",
			sessionKey: "red",
			hit: 50,
			label: "red-label",
		});
		appendSample({
			source: "upstream",
			sessionKey: "red",
			hit: 60,
			label: "red-label",
		});
		// Metrics-only session (no store record) should also appear in
		// the response so the UI can show historical overlays.
		appendSample({
			source: "upstream",
			sessionKey: "ghost",
			hit: 99,
			label: "ghost",
		});

		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/sessions");
			expect(r.status).toBe(200);
			expect(r.body.count).toBe(2);
			const red = r.body.sessions.find((s) => s.key === "red");
			expect(red).toBeDefined();
			expect(red.label).toBe("red-label");
			expect(red.sampleCount).toBe(2);
			expect(red.lastSampleTs).toBeTruthy();
			const ghost = r.body.sessions.find((s) => s.key === "ghost");
			expect(ghost).toBeDefined();
			expect(ghost.mode).toBe("metrics-only");
			expect(ghost.sampleCount).toBe(1);
		} finally {
			teardown(ctx);
		}
	});

	test("the _aggregate legacy bucket is hidden from the sessions listing", async () => {
		const ctx = setup();
		// A legacy statusline POST (no per-session URL) lands in _aggregate.
		appendSample({ source: "statusline", hit: 25 });
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/sessions");
			expect(r.status).toBe(200);
			expect(
				r.body.sessions.find((s) => s.key === "_aggregate"),
			).toBeUndefined();
		} finally {
			teardown(ctx);
		}
	});
});

describe("GET /_proxy/metrics ?session= filter", () => {
	test("returns only the specified session's ring when ?session is set", async () => {
		const ctx = setup();
		appendSample({ source: "upstream", sessionKey: "red", hit: 11 });
		appendSample({ source: "upstream", sessionKey: "blue", hit: 22 });
		appendSample({ source: "upstream", sessionKey: "red", hit: 33 });

		const port = await listen(ctx.server);
		try {
			const all = await jsonReq(port, "/_proxy/metrics");
			expect(all.body.samples).toHaveLength(3);
			expect(all.body.session).toBeNull();

			const redOnly = await jsonReq(port, "/_proxy/metrics?session=red");
			expect(redOnly.body.samples).toHaveLength(2);
			expect(redOnly.body.session).toBe("red");
			expect(redOnly.body.samples.every((s) => s.sessionKey === "red")).toBe(
				true,
			);
		} finally {
			teardown(ctx);
		}
	});

	test("POST {action:'clear', session:'<id>'} clears just that ring", async () => {
		const ctx = setup();
		appendSample({ source: "upstream", sessionKey: "red", hit: 1 });
		appendSample({ source: "upstream", sessionKey: "red", hit: 2 });
		appendSample({ source: "upstream", sessionKey: "blue", hit: 3 });

		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/metrics", "POST", {
				action: "clear",
				session: "red",
			});
			expect(r.status).toBe(200);
			expect(r.body.count).toBe(2);
			expect(r.body.session).toBe("red");

			const after = await jsonReq(port, "/_proxy/metrics");
			expect(after.body.samples).toHaveLength(1);
			expect(after.body.samples[0].hit).toBe(3);
		} finally {
			teardown(ctx);
		}
	});
});

describe("GET|POST /_proxy/statusline/<id> per-session routing", () => {
	test("POST /_proxy/statusline/<id> tags the metrics sample with sessionKey and label", async () => {
		const ctx = setup();
		ctx.store.upsert("red", () => ({
			key: "red",
			mode: "path",
			label: "red-label",
			labelSource: "operator",
			lastActivity: "2026-05-15T10:00:00.000Z",
		}));
		const port = await listen(ctx.server);
		try {
			const r = await textReq(port, "/_proxy/statusline/red", "POST", {
				context_window: { used_percentage: 42 },
			});
			expect(r.status).toBe(200);
			// The statusline starts with the operator-supplied label, NOT the
			// literal word "context".
			expect(r.body).toMatch(/red-label/);
			expect(r.body).not.toMatch(/^clawback:\s+context/);

			const samples = await jsonReq(port, "/_proxy/metrics?session=red");
			expect(samples.body.samples).toHaveLength(1);
			expect(samples.body.samples[0].sessionKey).toBe("red");
			expect(samples.body.samples[0].label).toBe("red-label");
		} finally {
			teardown(ctx);
		}
	});

	test("POST /_proxy/statusline/_default falls back to mostRecentSession render", async () => {
		const ctx = setup();
		ctx.store.upsert("any", () => ({
			key: "any",
			mode: "path",
			label: "any",
			lastActivity: "2026-05-15T10:00:00.000Z",
			cacheReadTokens: 500,
			cacheCreationTokens: 50,
			cacheMissTokens: 50,
		}));
		const port = await listen(ctx.server);
		try {
			const r = await textReq(port, "/_proxy/statusline/_default", "POST", {
				context_window: { used_percentage: 11 },
			});
			expect(r.status).toBe(200);
			expect(r.body).toMatch(/context/);
		} finally {
			teardown(ctx);
		}
	});

	test("the legacy no-id POST /_proxy/statusline still works (back-compat)", async () => {
		const ctx = setup();
		ctx.store.upsert("any", () => ({
			key: "any",
			mode: "path",
			lastActivity: "2026-05-15T10:00:00.000Z",
		}));
		const port = await listen(ctx.server);
		try {
			const r = await textReq(port, "/_proxy/statusline", "POST", {
				context_window: { used_percentage: 5 },
			});
			expect(r.status).toBe(200);
			expect(r.body).toMatch(/context/);
		} finally {
			teardown(ctx);
		}
	});

	test("two parallel per-session POSTs land in their own rings independently", async () => {
		const ctx = setup();
		ctx.store.upsert("red", () => ({
			key: "red",
			mode: "path",
			label: "red",
			lastActivity: "2026-05-15T10:00:00.000Z",
		}));
		ctx.store.upsert("blue", () => ({
			key: "blue",
			mode: "path",
			label: "blue",
			lastActivity: "2026-05-15T10:00:00.000Z",
		}));
		const port = await listen(ctx.server);
		try {
			await textReq(port, "/_proxy/statusline/red", "POST", {
				context_window: { used_percentage: 30 },
			});
			await textReq(port, "/_proxy/statusline/blue", "POST", {
				context_window: { used_percentage: 70 },
			});

			const red = await jsonReq(port, "/_proxy/metrics?session=red");
			const blue = await jsonReq(port, "/_proxy/metrics?session=blue");
			expect(red.body.samples).toHaveLength(1);
			expect(blue.body.samples).toHaveLength(1);
			expect(red.body.samples[0].context).toBe(30);
			expect(blue.body.samples[0].context).toBe(70);
		} finally {
			teardown(ctx);
		}
	});
});
