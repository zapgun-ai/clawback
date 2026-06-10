import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { createReportServer } from "../src/report.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";
import { createTurnLog } from "../src/turn_log.js";
import { createUiServer } from "../src/ui_server.js";

const logger = createLogger("silent");

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
const CSV = "ts,arm,usd_estimate\n2026-05-01T00:00:00Z,treatment,0.5\n";
const SECRET_LOG = "BEARER-ish secret that must never be served\n";

// Write a synthetic completed run into reportDir. Always drops a proxy log
// and a raw turns ndjson alongside, so tests can assert those sensitive
// siblings stay unreachable.
function writeRun(reportDir, id, summary, opts = {}) {
	const dir = path.join(reportDir, id);
	fs.mkdirSync(path.join(dir, "charts"), { recursive: true });
	fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
	fs.writeFileSync(path.join(dir, "charts", "tokens_saved.svg"), SVG);
	if (opts.csv !== false) fs.writeFileSync(path.join(dir, "report.csv"), CSV);
	if (opts.md) fs.writeFileSync(path.join(dir, "report.md"), "# report\n");
	if (opts.manifest) {
		fs.writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({ pricingVersion: "2026-05-28" }),
		);
	}
	fs.writeFileSync(path.join(dir, "proxy.A0.log"), SECRET_LOG);
	fs.writeFileSync(path.join(dir, "turns.A0.ndjson"), '{"secret":true}\n');
}

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-report-"));
	const reportDir = path.join(dir, "runs");
	fs.mkdirSync(reportDir, { recursive: true });
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		stateFile: path.join(dir, "state.json"),
		turnLogFile: path.join(dir, "turns.ndjson"),
		reportDir,
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
	const reportServer = createReportServer({ logger, config });
	const server = createServer({
		config,
		store,
		scheduler,
		logger,
		turnLog,
		uiServer,
		reportServer,
	});
	return { config, store, scheduler, server, turnLog, dir, reportDir };
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

function get(port, urlPath, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ method: "GET", host: "127.0.0.1", port, path: urlPath, headers },
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

const summaryFor = (generatedAt, extra = {}) => ({
	generatedAt,
	seed: 42,
	bootstrap: 2000,
	pricingHash: "deadbeef",
	clawbackVersions: ["0.1.0"],
	nTurns: 5,
	arms: [],
	savings: [],
	...extra,
});

describe("report viewer — static + base injection", () => {
	test("GET /<prefix>/report/ serves HTML with the prefixed <base>", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/text\/html/);
			expect(r.body).toMatch(/<title>clawback/);
			expect(r.body).toContain('<base href="/_proxy/report/" />');
			expect(r.body).not.toContain("__BASE__");
		} finally {
			teardown(ctx);
		}
	});

	test("custom --admin-path is reflected in the injected <base>", async () => {
		const ctx = setup({ adminPathPrefix: "ctrl" });
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/ctrl/report/");
			expect(r.status).toBe(200);
			expect(r.body).toContain('<base href="/ctrl/report/" />');
			// The default prefix must NOT leak in.
			expect(r.body).not.toContain("/_proxy/report/");
		} finally {
			teardown(ctx);
		}
	});

	test("serves report.js and report.css static assets", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const js = await get(port, "/_proxy/report/report.js");
			expect(js.status).toBe(200);
			expect(js.headers["content-type"]).toMatch(/javascript/);
			const css = await get(port, "/_proxy/report/report.css");
			expect(css.status).toBe(200);
			expect(css.headers["content-type"]).toMatch(/text\/css/);
		} finally {
			teardown(ctx);
		}
	});
});

describe("report viewer — run listing + data", () => {
	test("GET runs lists completed runs newest-first, skipping non-runs", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		writeRun(ctx.reportDir, "beta", summaryFor("2026-05-20T00:00:00.000Z"));
		// A subdir with no summary.json is not a run.
		fs.mkdirSync(path.join(ctx.reportDir, "scratch"));
		fs.writeFileSync(path.join(ctx.reportDir, "scratch", "notes.txt"), "x");
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/runs");
			expect(r.status).toBe(200);
			const { runs } = JSON.parse(r.body);
			expect(runs.map((x) => x.id)).toEqual(["beta", "alpha"]);
			expect(runs[0].nTurns).toBe(5);
		} finally {
			teardown(ctx);
		}
	});

	test("empty report dir yields an empty run list (not an error)", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/runs");
			expect(r.status).toBe(200);
			expect(JSON.parse(r.body)).toEqual({ runs: [] });
		} finally {
			teardown(ctx);
		}
	});

	test("GET data?run=<id> returns summary, charts, csvBytes, manifest, md", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"), {
			md: true,
			manifest: true,
		});
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/data?run=alpha");
			expect(r.status).toBe(200);
			const data = JSON.parse(r.body);
			expect(data.id).toBe("alpha");
			expect(data.summary.nTurns).toBe(5);
			expect(data.charts).toEqual(["tokens_saved.svg"]);
			expect(data.csvBytes).toBe(Buffer.byteLength(CSV));
			expect(data.manifest.pricingVersion).toBe("2026-05-28");
			expect(data.reportMarkdown).toMatch(/# report/);
		} finally {
			teardown(ctx);
		}
	});

	test("GET data for a missing run is 404", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/data?run=ghost");
			expect(r.status).toBe(404);
			expect(JSON.parse(r.body).error).toBe("run_not_found");
		} finally {
			teardown(ctx);
		}
	});
});

describe("report viewer — chart + csv", () => {
	test("GET chart/<id>/<file>.svg serves the SVG", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/chart/alpha/tokens_saved.svg");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/image\/svg\+xml/);
			expect(r.body).toBe(SVG);
		} finally {
			teardown(ctx);
		}
	});

	test("chart route only serves .svg (a non-svg run file is 404)", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/chart/alpha/summary.json");
			expect(r.status).toBe(404);
		} finally {
			teardown(ctx);
		}
	});

	test("GET csv/<id> serves report.csv as a download", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			const r = await get(port, "/_proxy/report/csv/alpha");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/text\/csv/);
			expect(r.headers["content-disposition"]).toContain("alpha-report.csv");
			expect(r.body).toBe(CSV);
		} finally {
			teardown(ctx);
		}
	});
});

describe("report viewer — security", () => {
	test("a traversal run id is rejected (400), not resolved", async () => {
		const ctx = setup();
		const port = await listen(ctx.server);
		try {
			const dots = await get(port, "/_proxy/report/data?run=..");
			expect(dots.status).toBe(400);
			expect(JSON.parse(dots.body).error).toBe("bad_run_id");
			// A slash-bearing id fails the safe-name regex before any fs touch.
			const slashed = await get(port, "/_proxy/report/data?run=..%2f..%2fetc");
			expect(slashed.status).toBe(400);
		} finally {
			teardown(ctx);
		}
	});

	test("sensitive run-dir siblings (proxy log, raw ndjson) are unreachable", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			// No route exposes arbitrary run files; the only allowlisted reads
			// are summary/manifest/report.md (via data), report.csv (via csv),
			// and charts/*.svg (via chart). The log must not leak via any path.
			for (const p of [
				"/_proxy/report/proxy.A0.log",
				"/_proxy/report/alpha/proxy.A0.log",
				"/_proxy/report/chart/alpha/proxy.A0.log",
				"/_proxy/report/csv/alpha/../proxy.A0.log",
			]) {
				const r = await get(port, p);
				expect(r.status).toBe(404);
				expect(r.body).not.toContain("secret");
			}
		} finally {
			teardown(ctx);
		}
	});

	test("report GET is exempt from the Host/DNS-rebinding gate (fully public)", async () => {
		const ctx = setup();
		writeRun(ctx.reportDir, "alpha", summaryFor("2026-05-01T00:00:00.000Z"));
		const port = await listen(ctx.server);
		try {
			// A spoofed Host that does not match the bound interface is the
			// DNS-rebinding signature. The metrics endpoint rejects it (421);
			// the read-only report viewer is deliberately exempt and still 200s.
			const bogus = { host: "attacker.example" };
			const metrics = await get(port, "/_proxy/metrics", bogus);
			expect(metrics.status).toBe(421);
			const report = await get(port, "/_proxy/report/runs", bogus);
			expect(report.status).toBe(200);
		} finally {
			teardown(ctx);
		}
	});
});
