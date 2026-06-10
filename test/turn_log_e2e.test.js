import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";
import { createTurnLog } from "../src/turn_log.js";

const logger = createLogger("silent");

let upstream;
let upstreamPort;

beforeAll(async () => {
	upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			res.writeHead(200, {
				"content-type": "application/json",
				"anthropic-ratelimit-tokens-remaining": "40000",
			});
			res.end(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 1000,
						cache_read_input_tokens: 2000,
					},
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-turn-e2e-"));
	const turnLogFile = path.join(dir, "turns.ndjson");
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		turnLogFile,
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const turnLog = createTurnLog({ filePath: config.turnLogFile, logger });
	const scheduler = new KeepAliveScheduler({
		config,
		store,
		logger,
		fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
	});
	const server = createServer({ config, store, scheduler, logger, turnLog });
	return { config, store, scheduler, server, turnLog, dir, turnLogFile };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function teardown({ scheduler, server, turnLog, dir }) {
	scheduler.stop();
	turnLog.close();
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

function readTurnLines(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

describe("turn-log end-to-end", () => {
	test("writes one NDJSON record per forwarded /v1/messages, with all expected fields", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const res = await postJson(port, "/agent-a/v1/messages", {
				model: "claude-sonnet-4-6",
				system: "be helpful",
				tools: [{ name: "read_file" }],
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			});
			expect(res.status).toBe(200);
			await new Promise((r) => setTimeout(r, 30));
			ctx.turnLog.close();
			await new Promise((r) => setTimeout(r, 30));

			const records = readTurnLines(ctx.turnLogFile);
			expect(records).toHaveLength(1);
			const r = records[0];
			expect(r.sessionKey).toBe("agent-a");
			expect(r.mode).toBe("path");
			expect(r.model).toBe("claude-sonnet-4-6");
			expect(r.ttlMode).toBe("1h");
			expect(r.arm).toBe("treatment");
			expect(r.httpStatus).toBe(200);
			expect(typeof r.wallMs).toBe("number");
			expect(r.usage.input_tokens).toBe(100);
			expect(r.usage.cache_read_input_tokens).toBe(2000);
			expect(typeof r.clawbackVersion).toBe("string");
			expect(r.cadenceMode).toBe("default");
			// No thinking config in this request → budget is null, not undefined.
			expect(r.thinkingBudget).toBeNull();
		} finally {
			teardown(ctx);
		}
	});

	test("records thinkingBudget from request thinking.budget_tokens", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const res = await postJson(port, "/agent-think/v1/messages", {
				model: "claude-sonnet-4-6",
				system: "be helpful",
				thinking: { type: "enabled", budget_tokens: 8000 },
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			});
			expect(res.status).toBe(200);
			await new Promise((r) => setTimeout(r, 30));
			ctx.turnLog.close();
			await new Promise((r) => setTimeout(r, 30));

			const records = readTurnLines(ctx.turnLogFile);
			expect(records).toHaveLength(1);
			// Effort/reasoning level is self-describing in the log: the resolved
			// thinking budget (which --effort sets) rides in the same report.
			expect(records[0].thinkingBudget).toBe(8000);
		} finally {
			teardown(ctx);
		}
	});

	test("shadow fan-out turn-log record also carries thinkingBudget", async () => {
		const ctx = setup();
		// Arm an in-proxy shadow baseline capture: armed knobs stay on the
		// primary path AND a passthrough twin is fanned per turn. Both arms
		// bill the same request bytes, so both must record the same budget.
		ctx.config._baselineCapture = {
			active: true,
			shadow: true,
			turnsRemaining: 5,
			targetTurns: 5,
			startedAt: new Date().toISOString(),
			startTotals: { read: 0, create: 0, miss: 0 },
			shadowTotals: { read: 0, create: 0, miss: 0 },
			imposedPassthrough: false,
		};
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/agent-shadow/v1/messages", {
				model: "claude-sonnet-4-6",
				system: "be helpful",
				thinking: { type: "enabled", budget_tokens: 12000 },
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 10,
			});
			// The shadow forward is fire-and-forget; give it room to land.
			await new Promise((r) => setTimeout(r, 120));
			ctx.turnLog.close();
			await new Promise((r) => setTimeout(r, 30));

			const records = readTurnLines(ctx.turnLogFile);
			// One primary (treatment) record + one shadow (passthrough) record.
			const arms = records.map((r) => r.arm).sort();
			expect(arms).toEqual(["passthrough", "treatment"]);
			for (const r of records) {
				expect(r.thinkingBudget).toBe(12000);
			}
		} finally {
			teardown(ctx);
		}
	});

	test("passthrough arm labels records correctly and does not set ttlMode=1h", async () => {
		const ctx = setup({ passthrough: true });
		// Re-resolve: passthrough forces injectExtendedCacheTtl=false manually
		ctx.config.injectExtendedCacheTtl = false;
		ctx.config.keepAliveEnabled = false;
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/agent-b/v1/messages", {
				model: "claude-sonnet-4-6",
				system: "hi",
				messages: [],
				max_tokens: 1,
			});
			await new Promise((r) => setTimeout(r, 30));
			ctx.turnLog.close();
			await new Promise((r) => setTimeout(r, 30));

			const records = readTurnLines(ctx.turnLogFile);
			expect(records).toHaveLength(1);
			expect(records[0].arm).toBe("passthrough");
			expect(records[0].ttlMode).toBe("5m");
		} finally {
			teardown(ctx);
		}
	});

	test("does not log non-messages paths", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/v1/complete", { prompt: "legacy" });
			await new Promise((r) => setTimeout(r, 30));
			ctx.turnLog.close();
			await new Promise((r) => setTimeout(r, 30));

			const records = readTurnLines(ctx.turnLogFile);
			expect(records).toHaveLength(0);
		} finally {
			teardown(ctx);
		}
	});

	test("turnLogFile=null disables logging", async () => {
		const ctx = setup({ turnLogFile: null });
		expect(ctx.turnLog.enabled).toBe(false);
		const port = await listen(ctx.server);
		try {
			await postJson(port, "/agent-c/v1/messages", {
				model: "claude-sonnet-4-6",
				system: "hi",
				messages: [],
				max_tokens: 1,
			});
			expect(ctx.turnLog.writeCount).toBe(0);
		} finally {
			teardown(ctx);
		}
	});
});
