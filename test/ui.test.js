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
import { createUiServer } from "../src/ui_server.js";

const logger = createLogger("silent");

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-ui-"));
	const turnLogFile = overrides.turnLogFile ?? path.join(dir, "turns.ndjson");
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
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
		turnLog,
		fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
	});
	const uiServer = createUiServer({ logger });
	const server = createServer({
		config,
		store,
		scheduler,
		logger,
		turnLog,
		uiServer,
	});
	return {
		config,
		store,
		scheduler,
		server,
		turnLog,
		turnLogFile,
		dir,
	};
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

function getJson(port, urlPath) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ method: "GET", host: "127.0.0.1", port, path: urlPath },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("UI static assets", () => {
	test("GET /_proxy/ui/ returns HTML", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await getJson(port, "/_proxy/ui/");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/text\/html/);
			expect(r.body).toMatch(/<title>clawback/);
		} finally {
			teardown(ctx);
		}
	});

	test("GET /_proxy/ui/app.js returns JavaScript", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await getJson(port, "/_proxy/ui/app.js");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/javascript/);
			expect(r.body.length).toBeGreaterThan(100);
		} finally {
			teardown(ctx);
		}
	});

	test("GET /_proxy/ui/style.css returns CSS", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await getJson(port, "/_proxy/ui/style.css");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/text\/css/);
		} finally {
			teardown(ctx);
		}
	});
});
