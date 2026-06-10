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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-newtoggle-"));
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
		stripEphemeralFromSystem: merged.stripEphemeralFromSystem,
		keepAliveEnabled: merged.keepAliveEnabled,
	};
	if (merged.passthrough) {
		merged.injectExtendedCacheTtl = false;
		merged.stripEphemeralFromSystem = false;
		merged.keepAliveEnabled = false;
	}
	const store = new SessionStore({ filePath: merged.stateFile, logger });
	const scheduler = {
		start() {},
		stop() {},
		ensureScheduled() {},
		cancelSession() {},
	};
	const server = createServer({
		config: merged,
		store,
		scheduler,
		logger,
	});
	return { config: merged, store, scheduler, server, dir };
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

test("GET /_proxy/extend-cache-ttl returns current state", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/extend-cache-ttl");
	expect(r.status).toBe(200);
	expect(r.body).toEqual({
		injectExtendedCacheTtl: true,
		passthrough: false,
	});
	teardown(s);
});

test("POST /_proxy/extend-cache-ttl toggles", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/extend-cache-ttl", "POST", {
		action: "toggle",
	});
	expect(r.status).toBe(200);
	expect(r.body.injectExtendedCacheTtl).toBe(false);
	expect(s.config.injectExtendedCacheTtl).toBe(false);
	teardown(s);
});

test("POST /_proxy/extend-cache-ttl returns 409 under passthrough", async () => {
	const s = setup({ passthrough: true });
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/extend-cache-ttl", "POST", {
		action: "toggle",
	});
	expect(r.status).toBe(409);
	teardown(s);
});

test("GET /_proxy/strip-extended-cache-ttl returns current state", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/strip-extended-cache-ttl");
	expect(r.status).toBe(200);
	expect(r.body).toEqual({
		stripExtendedCacheTtl: false,
		injectExtendedCacheTtl: true,
		passthrough: false,
	});
	teardown(s);
});

test("POST /_proxy/strip-extended-cache-ttl on also clears inject (mutually exclusive)", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(
		port,
		"/_proxy/strip-extended-cache-ttl",
		"POST",
		{
			action: "on",
		},
	);
	expect(r.status).toBe(200);
	expect(r.body.stripExtendedCacheTtl).toBe(true);
	expect(r.body.injectExtendedCacheTtl).toBe(false);
	expect(s.config.stripExtendedCacheTtl).toBe(true);
	expect(s.config.injectExtendedCacheTtl).toBe(false);
	teardown(s);
});

test("POST /_proxy/strip-extended-cache-ttl off leaves inject untouched", async () => {
	const s = setup({
		stripExtendedCacheTtl: true,
		injectExtendedCacheTtl: false,
	});
	const port = await listen(s.server);
	const r = await jsonRequest(
		port,
		"/_proxy/strip-extended-cache-ttl",
		"POST",
		{
			action: "off",
		},
	);
	expect(r.status).toBe(200);
	expect(r.body.stripExtendedCacheTtl).toBe(false);
	// disabling strip does NOT presume the operator wants 1h back
	expect(r.body.injectExtendedCacheTtl).toBe(false);
	expect(s.config.injectExtendedCacheTtl).toBe(false);
	teardown(s);
});

test("POST /_proxy/strip-extended-cache-ttl returns 409 under passthrough", async () => {
	const s = setup({ passthrough: true });
	const port = await listen(s.server);
	const r = await jsonRequest(
		port,
		"/_proxy/strip-extended-cache-ttl",
		"POST",
		{
			action: "toggle",
		},
	);
	expect(r.status).toBe(409);
	teardown(s);
});

test("POST /_proxy/mobile flips bundle on", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/mobile", "POST", {
		action: "on",
	});
	expect(r.status).toBe(200);
	expect(s.config.mobile).toBe(true);
	expect(s.config.gzipOutgoing).toBe(true);
	expect(s.config.forceNonStreaming).toBe(true);
	teardown(s);
});

test("POST /_proxy/mobile flips bundle off", async () => {
	const s = setup({
		mobile: true,
		gzipOutgoing: true,
		forceNonStreaming: true,
	});
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/mobile", "POST", {
		action: "off",
	});
	expect(r.status).toBe(200);
	expect(s.config.mobile).toBe(false);
	expect(s.config.gzipOutgoing).toBe(false);
	expect(s.config.forceNonStreaming).toBe(false);
	teardown(s);
});

test("POST /_proxy/keep-alive-extended toggles + refuses under passthrough", async () => {
	const s = setup();
	const port = await listen(s.server);
	let r = await jsonRequest(port, "/_proxy/keep-alive-extended", "POST", {
		action: "on",
	});
	expect(r.status).toBe(200);
	expect(s.config.keepAliveModeExtended).toBe(true);

	s.config.passthrough = true;
	r = await jsonRequest(port, "/_proxy/keep-alive-extended", "POST", {
		action: "toggle",
	});
	expect(r.status).toBe(409);
	teardown(s);
});

test("POST /_proxy/stack flips all three long-session knobs on", async () => {
	const s = setup({
		keepAliveEnabled: false,
		injectExtendedCacheTtl: false,
		keepAliveModeExtended: false,
	});
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/stack", "POST", {
		action: "on",
	});
	expect(r.status).toBe(200);
	expect(r.body).toEqual({
		keepAliveEnabled: true,
		injectExtendedCacheTtl: true,
		keepAliveModeExtended: true,
	});
	expect(s.config.keepAliveEnabled).toBe(true);
	expect(s.config.injectExtendedCacheTtl).toBe(true);
	expect(s.config.keepAliveModeExtended).toBe(true);
	teardown(s);
});

test("POST /_proxy/stack flips all three off", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/stack", "POST", {
		action: "off",
	});
	expect(r.status).toBe(200);
	expect(s.config.keepAliveEnabled).toBe(false);
	expect(s.config.injectExtendedCacheTtl).toBe(false);
	expect(s.config.keepAliveModeExtended).toBe(false);
	teardown(s);
});

test("POST /_proxy/stack returns 409 under passthrough", async () => {
	const s = setup({ passthrough: true });
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/stack", "POST", {
		action: "on",
	});
	expect(r.status).toBe(409);
	teardown(s);
});

test("POST /_proxy/tight-loop on forces 5m + fast cadence, clears inject", async () => {
	// Start from the long-session stack (inject 1h + extended cadence) and
	// confirm the tight-loop fix flips strip on, clears inject, and drops
	// the cadence back to fast — the two halves of the force-5m move.
	const s = setup({
		stripExtendedCacheTtl: false,
		injectExtendedCacheTtl: true,
		keepAliveModeExtended: true,
	});
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/tight-loop", "POST", {
		action: "on",
	});
	expect(r.status).toBe(200);
	expect(r.body).toEqual({
		stripExtendedCacheTtl: true,
		injectExtendedCacheTtl: false,
		keepAliveModeExtended: false,
	});
	expect(s.config.stripExtendedCacheTtl).toBe(true);
	expect(s.config.injectExtendedCacheTtl).toBe(false);
	expect(s.config.keepAliveModeExtended).toBe(false);
	teardown(s);
});

test("POST /_proxy/tight-loop off lifts strip but leaves cadence alone", async () => {
	// Disabling only undoes the strip; it does not presume the operator
	// wants the extended cadence back (symmetric with strip-extended-cache
	// -ttl leaving inject untouched on disable).
	const s = setup({
		stripExtendedCacheTtl: true,
		keepAliveModeExtended: true,
	});
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/tight-loop", "POST", {
		action: "off",
	});
	expect(r.status).toBe(200);
	expect(s.config.stripExtendedCacheTtl).toBe(false);
	expect(s.config.keepAliveModeExtended).toBe(true);
	teardown(s);
});

test("POST /_proxy/tight-loop returns 409 under passthrough", async () => {
	const s = setup({ passthrough: true });
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/tight-loop", "POST", {
		action: "on",
	});
	expect(r.status).toBe(409);
	teardown(s);
});

test("POST /_proxy/auto-continue toggles", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/auto-continue", "POST", {
		action: "toggle",
	});
	expect(r.status).toBe(200);
	expect(s.config.autoContinue).toBe(true);
	teardown(s);
});

test("GET /_proxy/suggestions returns an array (possibly empty)", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/suggestions");
	expect(r.status).toBe(200);
	expect(Array.isArray(r.body.suggestions)).toBe(true);
	teardown(s);
});

test("GET /_proxy/capture-baseline returns the inactive shape on a fresh proxy", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/capture-baseline");
	expect(r.status).toBe(200);
	expect(r.body).toMatchObject({
		active: false,
		turnsRemaining: 0,
		targetTurns: 0,
		defaultTurns: expect.any(Number),
	});
	teardown(s);
});

test("POST /_proxy/capture-baseline arms a capture and forces passthrough on", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/capture-baseline", "POST", {});
	expect(r.status).toBe(200);
	expect(r.body.active).toBe(true);
	expect(r.body.turnsRemaining).toBeGreaterThan(0);
	expect(r.body.targetTurns).toBe(r.body.turnsRemaining);
	expect(typeof r.body.startedAt).toBe("string");
	expect(s.config.passthrough).toBe(true);
	teardown(s);
});

test("POST /_proxy/capture-baseline is idempotent — re-arming restarts the counter", async () => {
	const s = setup();
	const port = await listen(s.server);
	await jsonRequest(port, "/_proxy/capture-baseline", "POST", {});
	// Manually tick down a couple of turns to simulate progress.
	s.config._baselineCapture.turnsRemaining = 2;
	const r = await jsonRequest(port, "/_proxy/capture-baseline", "POST", {});
	expect(r.status).toBe(200);
	expect(r.body.turnsRemaining).toBe(r.body.targetTurns);
	teardown(s);
});

test("GET /_proxy/health publicConfig includes new MVP knobs + _clawback marker", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/health");
	expect(r.status).toBe(200);
	expect(r.body.config).toMatchObject({
		injectExtendedCacheTtl: true,
		mobile: false,
		gzipOutgoing: false,
		forceNonStreaming: false,
		autoContinue: false,
		stripEphemeralFromSystem: true,
		keepAliveModeExtended: false,
		_clawback: true,
	});
	teardown(s);
});

test("GET /_proxy/health exposes keepAliveReserve with zero-state on a fresh proxy", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/health");
	expect(r.status).toBe(200);
	expect(r.body.keepAliveReserve).toEqual({
		tokens: 0,
		pings: 0,
		bySession: {},
	});
	teardown(s);
});

test("GET /_proxy/health: keepAliveReserve projects from session targetTtl + cacheReadTokens", async () => {
	const s = setup();
	// Seed the store with one session whose quota resets in 1 hour
	// (more than the 2.5-min average cadence, so several pings remain).
	const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	s.store.upsert("k1", () => ({
		key: "k1",
		mode: "hash",
		createdAt: new Date().toISOString(),
		targetTtl: future,
		keepAliveCount: 4,
		cacheReadTokens: 40000,
		cacheCreationTokens: 0,
		cacheMissTokens: 0,
		authStale: false,
	}));
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/health");
	expect(r.status).toBe(200);
	expect(r.body.keepAliveReserve.tokens).toBeGreaterThan(0);
	expect(r.body.keepAliveReserve.pings).toBeGreaterThan(0);
	expect(r.body.keepAliveReserve.bySession.k1).toBeDefined();
	teardown(s);
});

test("GET /_proxy/health: keepAliveReserve is zero when passthrough is on", async () => {
	const s = setup({ passthrough: true });
	const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	s.store.upsert("k1", () => ({
		key: "k1",
		mode: "hash",
		createdAt: new Date().toISOString(),
		targetTtl: future,
		keepAliveCount: 4,
		cacheReadTokens: 40000,
		cacheCreationTokens: 0,
		cacheMissTokens: 0,
	}));
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/health");
	expect(r.status).toBe(200);
	expect(r.body.keepAliveReserve.tokens).toBe(0);
	teardown(s);
});

test("GET /_proxy/health: cacheControlInjection aggregates per-session counters", async () => {
	const s = setup();
	s.store.upsert("k1", () => ({
		key: "k1",
		mode: "hash",
		createdAt: new Date().toISOString(),
		cacheControlInjection: {
			eligibleTurns: 10,
			topLevelTurns: 1,
			rewriteTurns: 8,
			alreadyExtendedTurns: 1,
			blocksRewritten: 17,
			nonEphemeralSkipped: 0,
			lastTurnAt: new Date().toISOString(),
		},
	}));
	s.store.upsert("k2", () => ({
		key: "k2",
		mode: "path",
		createdAt: new Date().toISOString(),
		cacheControlInjection: {
			eligibleTurns: 4,
			topLevelTurns: 0,
			rewriteTurns: 4,
			alreadyExtendedTurns: 0,
			blocksRewritten: 6,
			nonEphemeralSkipped: 1,
			lastTurnAt: new Date().toISOString(),
		},
	}));
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/health");
	expect(r.status).toBe(200);
	expect(r.body.cacheControlInjection).toMatchObject({
		eligibleTurns: 14,
		topLevelTurns: 1,
		rewriteTurns: 12,
		alreadyExtendedTurns: 1,
		blocksRewritten: 23,
		nonEphemeralSkipped: 1,
		turnsAt1hTier: 14,
	});
	// coverage = 14/14 = 1.0 — every eligible turn ended up at the 1h tier
	expect(r.body.cacheControlInjection.coverage).toBeCloseTo(1.0);
	teardown(s);
});

test("GET /_proxy/health: cacheControlInjection.coverage is null on a fresh proxy", async () => {
	const s = setup();
	const port = await listen(s.server);
	const r = await jsonRequest(port, "/_proxy/health");
	expect(r.status).toBe(200);
	expect(r.body.cacheControlInjection.eligibleTurns).toBe(0);
	expect(r.body.cacheControlInjection.coverage).toBeNull();
	teardown(s);
});
