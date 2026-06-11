import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	KeepAliveScheduler,
	buildHeaders,
	buildKeepAliveBody,
} from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { SessionStore } from "../src/store.js";
import { createTurnLog } from "../src/turn_log.js";

const logger = createLogger("silent");

function mkStore() {
	const fp = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "clawback-ka-")),
		"state.json",
	);
	return new SessionStore({ filePath: fp, logger });
}

const baseConfig = {
	upstream: "https://api.anthropic.com",
	keepAliveMinMs: 100,
	keepAliveMaxMs: 100,
	gracePeriodMs: 1000,
	keepAliveTimeoutMs: 5000,
};

test("buildKeepAliveBody embeds model, system, tools, max_tokens:1", () => {
	const raw = buildKeepAliveBody(
		{ model: "claude-opus-4-5", system: "sys", tools: [{ name: "t" }] },
		{},
	);
	const body = JSON.parse(raw);
	expect(body.max_tokens).toBe(1);
	expect(body.stream).toBe(false);
	expect(body.model).toBe("claude-opus-4-5");
	expect(body.system).toBe("sys");
	expect(body.tools).toEqual([{ name: "t" }]);
	expect(body.messages).toEqual([{ role: "user", content: "keep-alive" }]);
});

test("buildKeepAliveBody falls back to default model and skips absent fields", () => {
	const raw = buildKeepAliveBody({}, {});
	const body = JSON.parse(raw);
	expect(typeof body.model).toBe("string");
	expect(body.model.length).toBeGreaterThan(0);
	expect("system" in body).toBe(false);
	expect("tools" in body).toBe(false);
});

test("buildKeepAliveBody always uses the session model (per-model cache)", () => {
	// Anthropic's prompt cache is per-model — pings must use the same
	// model as the operator's real turns or they create a parallel cache
	// the real turns never read.
	const raw = buildKeepAliveBody(
		{ model: "claude-opus-4-5" },
		{ keepAliveModel: "claude-haiku-4-5" },
	);
	expect(JSON.parse(raw).model).toBe("claude-opus-4-5");
});

test("buildHeaders copies auth headers and sets content-type", () => {
	const h = buildHeaders(
		{
			authHeaders: {
				authorization: "Bearer secret",
				"anthropic-version": "2023-06-01",
			},
		},
		'{"x":1}',
	);
	expect(h["content-type"]).toBe("application/json");
	expect(h.authorization).toBe("Bearer secret");
	expect(h["anthropic-version"]).toBe("2023-06-01");
});

test("scheduler pings session, updates counters", async () => {
	const store = mkStore();
	store.upsert("s1", () => ({
		key: "s1",
		mode: "hash",
		keepAliveTokensUsed: 0,
		keepAliveCount: 0,
		authHeaders: { authorization: "Bearer k" },
		system: "sys",
		model: "claude-opus-4-5",
	}));

	let calls = 0;
	const scheduler = new KeepAliveScheduler({
		config: baseConfig,
		store,
		logger,
		fetchImpl: async () => {
			calls++;
			return {
				ok: true,
				status: 200,
				outputTokens: 1,
				rateLimit: {},
				tokensReset: null,
			};
		},
	});

	scheduler.ensureScheduled("s1");
	await new Promise((r) => setTimeout(r, 500));
	scheduler.stop();

	expect(calls).toBeGreaterThanOrEqual(1);
	expect(store.has("s1")).toBe(true);
	const updated = store.get("s1");
	expect(updated.keepAliveCount).toBeGreaterThanOrEqual(1);
});

test("PLAN §22: 401 marks session authStale instead of fatal-purging", async () => {
	const store = mkStore();
	store.upsert("s2", () => ({
		key: "s2",
		mode: "hash",
		keepAliveTokensUsed: 0,
		keepAliveFailures: 0,
		authHeaders: { authorization: "Bearer bad" },
		model: "claude-opus-4-5",
		system: "the captured prefix we want to preserve",
		tools: [{ name: "Bash" }],
	}));

	const scheduler = new KeepAliveScheduler({
		config: baseConfig,
		store,
		logger,
		fetchImpl: async () => ({
			ok: false,
			status: 401,
			error: "unauthorized",
			needsAuthRefresh: true,
		}),
	});

	scheduler.ensureScheduled("s2");
	await new Promise((r) => setTimeout(r, 250));
	scheduler.stop();

	// Session preserved; captured system/tools intact.
	expect(store.has("s2")).toBe(true);
	const after = store.get("s2");
	expect(after.authStale).toBe(true);
	expect(after.lastKeepAliveStatus).toBe(401);
	expect(after.system).toBe("the captured prefix we want to preserve");
	expect(after.tools).toEqual([{ name: "Bash" }]);
});

test("PLAN §22: ensureScheduled is a no-op for authStale sessions", async () => {
	const store = mkStore();
	store.upsert("s3", () => ({
		key: "s3",
		mode: "hash",
		keepAliveTokensUsed: 0,
		authHeaders: { authorization: "Bearer bad" },
		model: "claude-opus-4-5",
		authStale: true,
	}));

	let pingCount = 0;
	const scheduler = new KeepAliveScheduler({
		config: baseConfig,
		store,
		logger,
		fetchImpl: async () => {
			pingCount++;
			return { ok: true, status: 200, outputTokens: 1 };
		},
	});

	scheduler.ensureScheduled("s3");
	await new Promise((r) => setTimeout(r, 250));
	scheduler.stop();

	expect(pingCount).toBe(0);
	expect(store.has("s3")).toBe(true);
});

test("turn-log receives a ping record per successful keep-alive", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-ka-tl-"));
	const store = new SessionStore({
		filePath: path.join(dir, "state.json"),
		logger,
	});
	const turnLogFile = path.join(dir, "turns.ndjson");
	const turnLog = createTurnLog({ filePath: turnLogFile, logger });
	store.upsert("s3", () => ({
		key: "s3",
		mode: "hash",
		keepAliveTokensUsed: 0,
		keepAliveCount: 0,
		authHeaders: { authorization: "Bearer k" },
		system: "sys",
		model: "claude-sonnet-4-6",
	}));

	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			keepAliveEnabled: true,
			injectExtendedCacheTtl: true,
		},
		store,
		logger,
		turnLog,
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			outputTokens: 3,
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 1000,
			},
			rateLimit: {},
			tokensReset: null,
		}),
	});

	scheduler.ensureScheduled("s3");
	await new Promise((r) => setTimeout(r, 350));
	scheduler.stop();
	turnLog.close();
	await new Promise((r) => setTimeout(r, 20));

	const lines = fs
		.readFileSync(turnLogFile, "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
	expect(lines.length).toBeGreaterThanOrEqual(1);
	const r = JSON.parse(lines[0]);
	expect(r.arm).toBe("treatment-ping");
	expect(r.mode).toBe("ping");
	expect(r.sessionKey).toBe("s3");
	expect(r.model).toBe("claude-sonnet-4-6");
	expect(r.ttlMode).toBe("1h");
	expect(r.usage.output_tokens).toBe(3);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("PLAN §19: 429 does not delay the next ping; failures count up; no purge", async () => {
	const store = mkStore();
	store.upsert("s429", () => ({
		key: "s429",
		mode: "hash",
		keepAliveTokensUsed: 0,
		keepAliveCount: 0,
		keepAliveFailures: 0,
		authHeaders: { authorization: "Bearer k" },
		system: "sys",
		model: "claude-opus-4-5",
	}));

	let calls = 0;
	const scheduler = new KeepAliveScheduler({
		config: baseConfig,
		store,
		logger,
		fetchImpl: async () => {
			calls++;
			return {
				ok: false,
				status: 429,
				error: "Too Many Requests",
				rateLimit: { retry_after_seconds: 3600 },
				tokensReset: null,
				fatal: false,
			};
		},
	});

	scheduler.ensureScheduled("s429");
	await new Promise((r) => setTimeout(r, 500));
	scheduler.stop();

	// With 100ms cadence and no backoff, 500ms should fit at least 3 pings.
	// If a 1h cooldown were applied, we'd see exactly 1.
	expect(calls).toBeGreaterThanOrEqual(3);
	const session = store.get("s429");
	expect(session).toBeTruthy();
	expect(session.keepAliveFailures).toBeGreaterThanOrEqual(3);
	expect(session.cooldownUntil).toBeUndefined();
});

test("turn-log receives a ping record per successful keep-alive", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-ka-tl-"));
	const store = new SessionStore({
		filePath: path.join(dir, "state.json"),
		logger,
	});
	const turnLogFile = path.join(dir, "turns.ndjson");
	const turnLog = createTurnLog({ filePath: turnLogFile, logger });
	store.upsert("s3", () => ({
		key: "s3",
		mode: "hash",
		reservedTokenBudget: 2,
		keepAliveTokensUsed: 0,
		keepAliveCount: 0,
		authHeaders: { "x-api-key": "k" },
		system: "sys",
		model: "claude-sonnet-4-6",
	}));

	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			keepAliveEnabled: true,
			injectExtendedCacheTtl: true,
		},
		store,
		logger,
		turnLog,
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			outputTokens: 3,
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 1000,
			},
			rateLimit: {},
			tokensReset: null,
		}),
	});

	scheduler.ensureScheduled("s3");
	await new Promise((r) => setTimeout(r, 350));
	scheduler.stop();
	turnLog.close();
	await new Promise((r) => setTimeout(r, 20));

	const lines = fs
		.readFileSync(turnLogFile, "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
	expect(lines.length).toBeGreaterThanOrEqual(1);
	const r = JSON.parse(lines[0]);
	expect(r.arm).toBe("treatment-ping");
	expect(r.mode).toBe("ping");
	expect(r.sessionKey).toBe("s3");
	expect(r.model).toBe("claude-sonnet-4-6");
	expect(r.ttlMode).toBe("1h");
	expect(r.usage.output_tokens).toBe(3);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("PLAN §19: 429 does not delay the next ping; failures count up; no purge", async () => {
	const store = mkStore();
	store.upsert("s429", () => ({
		key: "s429",
		mode: "hash",
		keepAliveTokensUsed: 0,
		keepAliveCount: 0,
		keepAliveFailures: 0,
		authHeaders: { authorization: "Bearer k" },
		system: "sys",
		model: "claude-opus-4-5",
	}));

	let calls = 0;
	const scheduler = new KeepAliveScheduler({
		config: baseConfig,
		store,
		logger,
		fetchImpl: async () => {
			calls++;
			return {
				ok: false,
				status: 429,
				error: "Too Many Requests",
				rateLimit: { retry_after_seconds: 3600 },
				tokensReset: null,
				fatal: false,
			};
		},
	});

	scheduler.ensureScheduled("s429");
	await new Promise((r) => setTimeout(r, 500));
	scheduler.stop();

	// With 100ms cadence and no backoff, 500ms should fit at least 3 pings.
	// If a 1h cooldown were applied, we'd see exactly 1.
	expect(calls).toBeGreaterThanOrEqual(3);
	const session = store.get("s429");
	expect(session).toBeTruthy();
	expect(session.keepAliveFailures).toBeGreaterThanOrEqual(3);
	expect(session.cooldownUntil).toBeUndefined();
});

test("_shouldExpire returns grace_period_expired past target_ttl + grace", () => {
	const store = mkStore();
	const scheduler = new KeepAliveScheduler({
		config: { ...baseConfig, gracePeriodMs: 1000 },
		store,
		logger,
		now: () => 10_000,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: new Date(5000).toISOString(),
	});
	expect(reason).toBe("grace_period_expired");
});

test("_shouldExpire returns idle_too_long when lastActivity is past sessionMaxIdleMs", () => {
	const store = mkStore();
	const scheduler = new KeepAliveScheduler({
		config: { ...baseConfig, sessionMaxIdleMs: 1000 },
		store,
		logger,
		now: () => 10_000,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		lastActivity: new Date(5000).toISOString(),
	});
	expect(reason).toBe("idle_too_long");
});

test("_shouldExpire falls back to createdAt when lastActivity missing", () => {
	const store = mkStore();
	const scheduler = new KeepAliveScheduler({
		config: { ...baseConfig, sessionMaxIdleMs: 1000 },
		store,
		logger,
		now: () => 10_000,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		createdAt: new Date(5000).toISOString(),
	});
	expect(reason).toBe("idle_too_long");
});

test("_shouldExpire returns null when within idle window", () => {
	const store = mkStore();
	const scheduler = new KeepAliveScheduler({
		config: { ...baseConfig, sessionMaxIdleMs: 1_000_000 },
		store,
		logger,
		now: () => 10_000,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		lastActivity: new Date(9_500).toISOString(),
	});
	expect(reason).toBe(null);
});

test("_shouldExpire skips idle check when sessionMaxIdleMs is 0", () => {
	const store = mkStore();
	const scheduler = new KeepAliveScheduler({
		config: { ...baseConfig, sessionMaxIdleMs: 0 },
		store,
		logger,
		now: () => 10_000_000,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		lastActivity: new Date(0).toISOString(),
	});
	expect(reason).toBe(null);
});

test("_shouldExpire fast-paths an authStale session past deadSessionMaxIdleMs before the general idle rule", () => {
	const store = mkStore();
	const now = 100 * 3_600_000;
	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			deadSessionMaxIdleMs: 6 * 3_600_000,
			sessionMaxIdleMs: 12 * 3_600_000,
		},
		store,
		logger,
		now: () => now,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		authStale: true,
		// 8h idle: past the 6h dead window but under the 12h general rule.
		lastActivity: new Date(now - 8 * 3_600_000).toISOString(),
	});
	expect(reason).toBe("auth_stale_idle");
});

test("_shouldExpire leaves a healthy session alone inside the dead window (only the general idle rule applies)", () => {
	const store = mkStore();
	const now = 100 * 3_600_000;
	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			deadSessionMaxIdleMs: 6 * 3_600_000,
			sessionMaxIdleMs: 12 * 3_600_000,
		},
		store,
		logger,
		now: () => now,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		// not authStale: 8h idle is past the dead window but under 12h.
		lastActivity: new Date(now - 8 * 3_600_000).toISOString(),
	});
	expect(reason).toBe(null);
});

test("_shouldExpire keeps an authStale session still inside the dead window", () => {
	const store = mkStore();
	const now = 100 * 3_600_000;
	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			deadSessionMaxIdleMs: 6 * 3_600_000,
			sessionMaxIdleMs: 12 * 3_600_000,
		},
		store,
		logger,
		now: () => now,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		authStale: true,
		// 3h idle: still inside the 6h dead window.
		lastActivity: new Date(now - 3 * 3_600_000).toISOString(),
	});
	expect(reason).toBe(null);
});

test("_shouldExpire skips the fast-path when deadSessionMaxIdleMs is 0", () => {
	const store = mkStore();
	const now = 100 * 3_600_000;
	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			deadSessionMaxIdleMs: 0,
			sessionMaxIdleMs: 12 * 3_600_000,
		},
		store,
		logger,
		now: () => now,
	});
	const reason = scheduler._shouldExpire({
		keepAliveTokensUsed: 0,
		targetTtl: null,
		authStale: true,
		// 8h idle: would hit the fast-path, but it's disabled; still under 12h.
		lastActivity: new Date(now - 8 * 3_600_000).toISOString(),
	});
	expect(reason).toBe(null);
});

test("_gcSweep purges authStale sessions whose lastActivity is past sessionMaxIdleMs", () => {
	const store = mkStore();
	const now = 1_000_000_000;
	store.upsert("stale-authStale", () => ({
		key: "stale-authStale",
		mode: "hash",
		authStale: true,
		lastActivity: new Date(now - 10 * 3_600_000).toISOString(), // 10h ago
		keepAliveTokensUsed: 0,
	}));
	store.upsert("fresh-authStale", () => ({
		key: "fresh-authStale",
		mode: "hash",
		authStale: true,
		lastActivity: new Date(now - 60_000).toISOString(), // 1min ago
		keepAliveTokensUsed: 0,
	}));
	store.upsert("fresh-active", () => ({
		key: "fresh-active",
		mode: "hash",
		lastActivity: new Date(now - 60_000).toISOString(),
		keepAliveTokensUsed: 0,
	}));

	const scheduler = new KeepAliveScheduler({
		config: { ...baseConfig, sessionMaxIdleMs: 5 * 3_600_000 }, // 5h
		store,
		logger,
		now: () => now,
	});

	scheduler._gcSweep();

	expect(store.has("stale-authStale")).toBe(false);
	expect(store.has("fresh-authStale")).toBe(true);
	expect(store.has("fresh-active")).toBe(true);
});

test("start() runs the sweep once and re-runs on gcSweepIntervalMs", async () => {
	const store = mkStore();
	const tNow = { v: 1_000_000_000 };
	store.upsert("dead", () => ({
		key: "dead",
		mode: "hash",
		authStale: true,
		lastActivity: new Date(tNow.v - 24 * 3_600_000).toISOString(),
		keepAliveTokensUsed: 0,
	}));

	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			sessionMaxIdleMs: 60_000,
			gcSweepIntervalMs: 50,
			keepAliveEnabled: false,
		},
		store,
		logger,
		now: () => tNow.v,
	});

	scheduler.start();
	// Sweep on start() should have already purged the dead session.
	expect(store.has("dead")).toBe(false);

	// Add another stale one after start(); the periodic sweep should catch it.
	store.upsert("dead2", () => ({
		key: "dead2",
		mode: "hash",
		authStale: true,
		lastActivity: new Date(tNow.v - 24 * 3_600_000).toISOString(),
		keepAliveTokensUsed: 0,
	}));
	await new Promise((r) => setTimeout(r, 120));
	scheduler.stop();
	expect(store.has("dead2")).toBe(false);
});

// Option A (keep-alive-side fragmentation): on the L3 paired run, the A5 arm
// armed THREE keep-alive loops for one conversation — the real 28KB/81KB
// context plus two junk aux contexts (1KB/2B and 0B/0B). Anthropic will not
// cache a prefix below its minimum cacheable length, so pinging a sub-threshold
// prefix writes nothing: pure cost, zero reclaim. The gate skips arming a loop
// for a cacheable prefix smaller than keepAliveMinPrefixBytes. See NEXT.md.
describe("keepAliveMinPrefixBytes gate (Option A)", () => {
	function mkSession(store, key, { system, tools }) {
		store.upsert(key, () => ({
			key,
			mode: "hash",
			keepAliveTokensUsed: 0,
			keepAliveCount: 0,
			authHeaders: { authorization: "Bearer k" },
			model: "claude-opus-4-5",
			system,
			tools,
		}));
	}

	test("does NOT arm a loop for a sub-threshold cacheable prefix", async () => {
		const store = mkStore();
		// Empty cacheable prefix: the 0B/0B junk aux context from the L3 run.
		mkSession(store, "tiny", { system: "", tools: [] });

		let pings = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...baseConfig, keepAliveMinPrefixBytes: 1024 },
			store,
			logger,
			fetchImpl: async () => {
				pings++;
				return { ok: true, status: 200, outputTokens: 1, rateLimit: {} };
			},
		});

		scheduler.ensureScheduled("tiny");
		// No timer registered → no keep-alive loop for this junk context.
		expect(scheduler.timers.has("tiny")).toBe(false);
		// And nothing fires across several cadence windows (100ms cadence).
		await new Promise((r) => setTimeout(r, 250));
		scheduler.stop();
		expect(pings).toBe(0);
		// The session itself is preserved — gating keep-alive must not evict it.
		expect(store.has("tiny")).toBe(true);
	});

	test("arms a loop for a cacheable prefix at/above the floor", () => {
		const store = mkStore();
		mkSession(store, "big", { system: "x".repeat(2048), tools: [] });

		const scheduler = new KeepAliveScheduler({
			config: { ...baseConfig, keepAliveMinPrefixBytes: 1024 },
			store,
			logger,
			fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
		});

		scheduler.ensureScheduled("big");
		expect(scheduler.timers.has("big")).toBe(true);
		scheduler.stop();
	});

	test("keepAliveMinPrefixBytes:0 disables the gate (empty prefix still armed)", () => {
		const store = mkStore();
		mkSession(store, "tiny0", { system: "", tools: [] });

		const scheduler = new KeepAliveScheduler({
			config: { ...baseConfig, keepAliveMinPrefixBytes: 0 },
			store,
			logger,
			fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
		});

		scheduler.ensureScheduled("tiny0");
		expect(scheduler.timers.has("tiny0")).toBe(true);
		scheduler.stop();
	});

	test("absent keepAliveMinPrefixBytes leaves keep-alive ungated (back-compat)", () => {
		const store = mkStore();
		// baseConfig has no keepAliveMinPrefixBytes; a 3-byte prefix must arm.
		mkSession(store, "compat", { system: "sys", tools: undefined });

		const scheduler = new KeepAliveScheduler({
			config: baseConfig,
			store,
			logger,
			fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
		});

		scheduler.ensureScheduled("compat");
		expect(scheduler.timers.has("compat")).toBe(true);
		scheduler.stop();
	});
});

// Option A++ (observe, don't guess): the byte floor (Option A) is in BYTES but
// Anthropic's cacheability minimum is in TOKENS (≥1024). On the Sonnet L4 90-min
// paired run a 446-token (~1.8KB) startup aux context CLEARED the 1024-byte floor
// yet sat below the token threshold, so it armed a loop and then took 28 cold
// pings (cache_read=0 AND cache_creation=0 every time) — pure cost, zero reclaim.
// The byte gate can't see tokens, so we observe the proof instead: after
// keepAliveColdPingMax consecutive fully-cold successful pings Anthropic has
// shown the prefix is uncacheable, so cancel that session's loop. A genuinely
// cacheable prefix writes cache_creation>0 on its first ping, so this never
// cancels a real one. See project_phantom_keepalive_byte_token_gate memory.
describe("cold-ping cancellation (Option A++)", () => {
	function mkColdSession(store, key) {
		store.upsert(key, () => ({
			key,
			mode: "hash",
			keepAliveTokensUsed: 0,
			keepAliveCount: 0,
			keepAliveFailures: 0,
			authHeaders: { authorization: "Bearer k" },
			model: "claude-opus-4-5",
			// >1024 bytes so the Option-A byte floor lets it arm — this is the
			// phantom: it clears the byte floor but is below the token minimum.
			system: "x".repeat(2000),
			tools: [],
		}));
	}

	const fastCadence = {
		...baseConfig,
		keepAliveMinMs: 20,
		keepAliveMaxMs: 20,
		keepAliveMinPrefixBytes: 1024,
	};

	test("cancels keep-alive after keepAliveColdPingMax fully-cold pings (phantom)", async () => {
		const store = mkStore();
		mkColdSession(store, "phantom");

		let calls = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...fastCadence, keepAliveColdPingMax: 2 },
			store,
			logger,
			fetchImpl: async () => {
				calls++;
				return {
					ok: true,
					status: 200,
					outputTokens: 1,
					usage: {
						input_tokens: 446,
						output_tokens: 1,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
					rateLimit: {},
					tokensReset: null,
				};
			},
		});

		scheduler.ensureScheduled("phantom");
		// 250ms / 20ms cadence = ~12 windows; an uncancelled loop would ping
		// ~12 times. After the fix it stops at exactly keepAliveColdPingMax.
		await new Promise((r) => setTimeout(r, 250));
		// Self-cancelled: the loop is gone BEFORE stop() (which would also
		// clear it) — proves the fix, not the teardown, stopped the pings.
		expect(scheduler.timers.has("phantom")).toBe(false);
		scheduler.stop();

		expect(calls).toBe(2);
		const after = store.get("phantom");
		expect(after.keepAliveUncacheable).toBe(true);
		// The session row itself is preserved — we stop pinging, not evict.
		expect(store.has("phantom")).toBe(true);
	});

	test("a warm prefix keeps pinging — cold streak resets on any cache hit", async () => {
		const store = mkStore();
		mkColdSession(store, "warm");

		let calls = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...fastCadence, keepAliveColdPingMax: 2 },
			store,
			logger,
			fetchImpl: async () => {
				calls++;
				return {
					ok: true,
					status: 200,
					outputTokens: 1,
					usage: {
						input_tokens: 2000,
						output_tokens: 1,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 1800,
					},
					rateLimit: {},
					tokensReset: null,
				};
			},
		});

		scheduler.ensureScheduled("warm");
		await new Promise((r) => setTimeout(r, 250));
		scheduler.stop();

		expect(calls).toBeGreaterThanOrEqual(3);
		const after = store.get("warm");
		expect(after.keepAliveUncacheable).toBeUndefined();
	});

	test("a first-ping cache WRITE (cache_creation>0) is not cold — never cancels a real prefix", async () => {
		const store = mkStore();
		mkColdSession(store, "writes");

		let calls = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...fastCadence, keepAliveColdPingMax: 2 },
			store,
			logger,
			fetchImpl: async () => {
				calls++;
				// Ping 1 writes the cache; subsequent reads. Never fully cold.
				return {
					ok: true,
					status: 200,
					outputTokens: 1,
					usage: {
						input_tokens: 2000,
						output_tokens: 1,
						cache_creation_input_tokens: calls === 1 ? 2000 : 0,
						cache_read_input_tokens: calls === 1 ? 0 : 2000,
					},
					rateLimit: {},
					tokensReset: null,
				};
			},
		});

		scheduler.ensureScheduled("writes");
		await new Promise((r) => setTimeout(r, 250));
		scheduler.stop();

		expect(calls).toBeGreaterThanOrEqual(3);
		expect(store.get("writes").keepAliveUncacheable).toBeUndefined();
	});

	test("keepAliveColdPingMax:0 disables the check (cold pings continue)", async () => {
		const store = mkStore();
		mkColdSession(store, "nogate");

		let calls = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...fastCadence, keepAliveColdPingMax: 0 },
			store,
			logger,
			fetchImpl: async () => {
				calls++;
				return {
					ok: true,
					status: 200,
					outputTokens: 1,
					usage: {
						input_tokens: 446,
						output_tokens: 1,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
					rateLimit: {},
					tokensReset: null,
				};
			},
		});

		scheduler.ensureScheduled("nogate");
		// Timer is still live mid-run (before stop() clears it): the gate is off.
		expect(scheduler.timers.has("nogate")).toBe(true);
		await new Promise((r) => setTimeout(r, 250));
		scheduler.stop();

		expect(calls).toBeGreaterThanOrEqual(3);
		expect(store.get("nogate").keepAliveUncacheable).toBeUndefined();
	});

	test("ensureScheduled is a no-op for a session already proven uncacheable", () => {
		const store = mkStore();
		store.upsert("dead", () => ({
			key: "dead",
			mode: "hash",
			keepAliveTokensUsed: 0,
			authHeaders: { authorization: "Bearer k" },
			model: "claude-opus-4-5",
			// >floor prefix: the byte gate would arm it; the uncacheable flag
			// must win so a phantom stays dead across a restart's re-arm sweep.
			system: "x".repeat(2000),
			tools: [],
			keepAliveUncacheable: true,
		}));

		let pings = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...fastCadence, keepAliveColdPingMax: 2 },
			store,
			logger,
			fetchImpl: async () => {
				pings++;
				return { ok: true, status: 200, outputTokens: 1 };
			},
		});

		scheduler.ensureScheduled("dead");
		expect(scheduler.timers.has("dead")).toBe(false);
		expect(pings).toBe(0);
		expect(store.has("dead")).toBe(true);
		scheduler.stop();
	});

	test("re-arming never orphans a timer — stop() fully silences (timer-leak regression)", async () => {
		// Live-proxy hot loop (data/clawback.run.log session 4278b386: ~2s
		// cadence, duplicate ping numbers, 2064 pings). Root cause: _scheduleNext
		// stored the new timer WITHOUT clearing a pre-existing one. _tick deletes
		// the map entry before its async ping, so a real turn's ensureScheduled
		// lands during the in-flight ping (map empty → guard passes) and arms a
		// timer; then _tick's tail re-arms again — orphaning the first. The map
		// always holds ≤1 timer, so it LOOKS healthy; the orphans live off-book
		// and keep firing. The tell: stop() clears only MAPPED timers, so any
		// orphan pings AFTER stop(). Five direct re-arms model five such races.
		const store = mkStore();
		mkColdSession(store, "leak");

		let calls = 0;
		const scheduler = new KeepAliveScheduler({
			config: { ...fastCadence, keepAliveColdPingMax: 0 },
			store,
			logger,
			fetchImpl: async () => {
				calls++;
				return { ok: true, status: 200, outputTokens: 1 };
			},
		});

		for (let i = 0; i < 5; i++) scheduler._scheduleNext("leak");
		// Map looks fine under BOTH bug and fix — the leak is invisible here.
		expect(scheduler.timers.size).toBe(1);

		scheduler.stop(); // clears only the one MAPPED timer
		const baseline = calls;
		await new Promise((r) => setTimeout(r, 80)); // let any orphan fire

		// Fixed: _scheduleNext clears the prior timer, so nothing is pending
		// after stop(). Buggy: four orphans fire here and ping post-stop.
		expect(calls).toBe(baseline);
		expect(scheduler.timers.size).toBe(0);
	});
});

test("gcSweepIntervalMs=0 disables the periodic sweep but start() sweep still runs", () => {
	const store = mkStore();
	store.upsert("old", () => ({
		key: "old",
		mode: "hash",
		authStale: true,
		lastActivity: new Date(0).toISOString(),
		keepAliveTokensUsed: 0,
	}));
	const scheduler = new KeepAliveScheduler({
		config: {
			...baseConfig,
			sessionMaxIdleMs: 1000,
			gcSweepIntervalMs: 0,
			keepAliveEnabled: false,
		},
		store,
		logger,
		now: () => 10_000_000_000,
	});

	scheduler.start();
	expect(store.has("old")).toBe(false);
	expect(scheduler._gcTimer).toBe(null);
	scheduler.stop();
});
