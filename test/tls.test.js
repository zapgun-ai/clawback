import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import {
	defaultCertHostnames,
	defaultCertIps,
	initCert,
} from "../src/init_cert.js";
import { createLogger } from "../src/logger.js";
import { probeClawback } from "../src/probe.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

// Generate one cert+key for the whole suite — openssl shell-out costs ~200ms
// per invocation; once is plenty for a smoke harness.
let CERT;
let CERT_DIR;

beforeAll(() => {
	CERT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-tls-"));
	CERT = initCert({ outDir: CERT_DIR, force: true });
});

afterAll(() => {
	if (CERT_DIR) fs.rmSync(CERT_DIR, { recursive: true, force: true });
});

function makeConfig(extra = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-tls-cfg-"));
	const merged = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: "http://127.0.0.1:1",
		stateFile: path.join(dir, "state.json"),
		turnLogFile: null,
		sessionLogDir: null,
		tls: true,
		tlsCertFile: CERT.certPath,
		tlsKeyFile: CERT.keyPath,
		...extra,
	};
	merged._baselineSnapshot = {
		injectExtendedCacheTtl: merged.injectExtendedCacheTtl,
		stripEphemeralFromSystem: merged.stripEphemeralFromSystem,
		keepAliveEnabled: merged.keepAliveEnabled,
		gzipOutgoing: merged.gzipOutgoing,
		forceNonStreaming: merged.forceNonStreaming,
	};
	return { config: merged, dir };
}

function noopScheduler() {
	return {
		start() {},
		stop() {},
		ensureScheduled() {},
		cancelSession() {},
	};
}

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function httpsGet(port, urlPath, headers = {}) {
	return new Promise((resolve, reject) => {
		https
			.get(
				{
					host: "127.0.0.1",
					port,
					path: urlPath,
					rejectUnauthorized: false,
					headers,
				},
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
			)
			.on("error", reject);
	});
}

function httpRequest(port, urlPath, method = "GET", headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: urlPath, method, headers },
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

describe("TLS dispatcher", () => {
	test("HTTPS request reaches the admin handler", async () => {
		const { config, dir } = makeConfig();
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const server = createServer({
			config,
			store,
			scheduler: noopScheduler(),
			logger,
		});
		const port = await listen(server);

		const res = await httpsGet(port, "/_proxy/health");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe("ok");

		await new Promise((r) => server.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("HTTP request on the TLS port returns 308 to https://", async () => {
		const { config, dir } = makeConfig();
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const server = createServer({
			config,
			store,
			scheduler: noopScheduler(),
			logger,
		});
		const port = await listen(server);

		const res = await httpRequest(port, "/_proxy/health", "GET");
		expect(res.status).toBe(308);
		expect(res.headers.location).toMatch(/^https:\/\//);
		expect(res.headers.location).toContain("/_proxy/health");
		expect(res.headers["x-clawback-upgrade"]).toBe("https");

		await new Promise((r) => server.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("probe over HTTP follows the 308 upgrade and recognizes clawback over TLS", async () => {
		// Regression (the user's Error 3): `clawback claude` launched from a dir
		// whose config has no tls key probes over plain HTTP, but the running
		// proxy auto-enabled TLS (non-loopback bind). Before upgrade-following,
		// the probe saw the 308 and refused to attach ("occupied by something
		// that doesn't look like clawback (non-200 status 308 ...)"). It must
		// instead follow the upgrade, re-probe over HTTPS, and recognize clawback.
		const { config, dir } = makeConfig();
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const server = createServer({
			config,
			store,
			scheduler: noopScheduler(),
			logger,
		});
		const port = await listen(server);

		// tls defaults to false → the probe starts over plain HTTP and must
		// self-heal to https off the dispatcher's 308.
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(true);
		expect(result.tls).toBe(true);
		expect(result.info.config._clawback).toBe(true);
		expect(result.info.config.tls).toBe(true);

		await new Promise((r) => server.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("308 redirect preserves the request path including query", async () => {
		const { config, dir } = makeConfig();
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const server = createServer({
			config,
			store,
			scheduler: noopScheduler(),
			logger,
		});
		const port = await listen(server);

		const res = await httpRequest(port, "/_proxy/metrics?since=2026-01-01");
		expect(res.status).toBe(308);
		expect(res.headers.location).toContain("/_proxy/metrics?since=2026-01-01");

		await new Promise((r) => server.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("redirect target uses the configured TLS port even if Host carried a different one", async () => {
		const { config, dir } = makeConfig();
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const server = createServer({
			config,
			store,
			scheduler: noopScheduler(),
			logger,
		});
		const port = await listen(server);

		const res = await httpRequest(port, "/_proxy/health", "GET", {
			host: "127.0.0.1:9999",
		});
		expect(res.status).toBe(308);
		expect(res.headers.location).toBe(
			`https://127.0.0.1:${port}/_proxy/health`,
		);

		await new Promise((r) => server.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("plain HTTP mode (tls=false) bypasses the dispatcher entirely", async () => {
		const { config, dir } = makeConfig({
			tls: false,
			tlsCertFile: null,
			tlsKeyFile: null,
		});
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const server = createServer({
			config,
			store,
			scheduler: noopScheduler(),
			logger,
		});
		const port = await listen(server);

		// In plain mode, HTTP reaches the admin handler directly — no redirect.
		const res = await httpRequest(port, "/_proxy/health");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe("ok");

		await new Promise((r) => server.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("createServer throws clearly when cert/key are unreadable", () => {
		const { config, dir } = makeConfig({ tlsCertFile: "/no/such/cert.pem" });
		const store = new SessionStore({ filePath: config.stateFile, logger });
		expect(() =>
			createServer({
				config,
				store,
				scheduler: noopScheduler(),
				logger,
			}),
		).toThrow(/tls=true but cert\/key files are unreadable/);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("init-cert", () => {
	test("creates cert + key with key mode 0600", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-"));
		const result = initCert({ outDir: dir });
		expect(result.action).toBe("created");
		expect(fs.existsSync(result.certPath)).toBe(true);
		expect(fs.existsSync(result.keyPath)).toBe(true);
		const keyMode = fs.statSync(result.keyPath).mode & 0o777;
		expect(keyMode).toBe(0o600);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("idempotent without --force", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-"));
		const first = initCert({ outDir: dir });
		const beforeCert = fs.readFileSync(first.certPath, "utf8");
		const second = initCert({ outDir: dir });
		expect(second.action).toBe("skipped");
		expect(fs.readFileSync(first.certPath, "utf8")).toBe(beforeCert);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("--force overwrites", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-"));
		const first = initCert({ outDir: dir });
		const beforeCert = fs.readFileSync(first.certPath, "utf8");
		const second = initCert({ outDir: dir, force: true });
		expect(second.action).toBe("overwrote");
		// PEM should differ because openssl generates a fresh keypair.
		expect(fs.readFileSync(second.certPath, "utf8")).not.toBe(beforeCert);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("cert is loadable as a TLS context", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-"));
		const result = initCert({ outDir: dir });
		// Smoke test: pretend to spin up an https server with the cert.
		// If openssl produced malformed PEM, https.createServer would throw.
		const tlsServer = https.createServer(
			{
				cert: fs.readFileSync(result.certPath),
				key: fs.readFileSync(result.keyPath),
			},
			(req, res) => {
				res.writeHead(200).end("ok");
			},
		);
		await new Promise((r) => tlsServer.listen(0, "127.0.0.1", r));
		const port = tlsServer.address().port;
		const res = await httpsGet(port, "/");
		expect(res.status).toBe(200);
		expect(res.body).toBe("ok");
		await new Promise((r) => tlsServer.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("default SANs always include loopback + localhost, and only valid IPs", () => {
		const hostnames = defaultCertHostnames();
		const ips = defaultCertIps();
		// Loopback + localhost are non-negotiable — the local launcher and
		// statusline curl dial 127.0.0.1.
		expect(hostnames).toContain("localhost");
		expect(ips).toContain("127.0.0.1");
		expect(ips).toContain("::1");
		// Every IP SAN must be a literal openssl will accept (net.isIP != 0);
		// scoped/link-local forms with a zone id are filtered out upstream.
		for (const ip of ips) expect(net.isIP(ip)).not.toBe(0);
		// Hostnames must be SAN-safe (no spaces / openssl-hostile chars).
		for (const h of hostnames) expect(h).toMatch(/^[A-Za-z0-9.-]+$/);
		// No duplicates leak through the dedup.
		expect(new Set(ips).size).toBe(ips.length);
		expect(new Set(hostnames).size).toBe(hostnames.length);
	});

	test("missing openssl is reported as a clear error", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-"));
		expect(() =>
			initCert({ outDir: dir, openssl: "/no/such/binary/please" }),
		).toThrow(/openssl failed to generate cert/);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// mkcert isn't installed in CI, so we inject `exec` to assert the spawned
	// command shape and let a fake stand in for the real binary. The error
	// path uses a genuine bad binary path to exercise the ENOENT branch.
	test("--mkcert spawns mkcert with -cert-file/-key-file and all SAN names", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-mkcert-"));
		const certPath = path.join(dir, "cert.pem");
		const keyPath = path.join(dir, "key.pem");
		const calls = [];
		const fakeExec = (file, args) => {
			calls.push({ file, args });
			// Stand in for mkcert: write placeholder files so the chmod + return
			// path behaves as it would after a real mint.
			fs.writeFileSync(certPath, "cert");
			fs.writeFileSync(keyPath, "key");
			return Buffer.from("");
		};
		const result = initCert({
			outDir: dir,
			mkcert: true,
			mkcertBin: "mkcert",
			exec: fakeExec,
			hostnames: ["localhost", "devbox.local"],
			ips: ["127.0.0.1", "::1"],
		});
		expect(result.tool).toBe("mkcert");
		expect(result.action).toBe("created");
		expect(calls).toHaveLength(1);
		expect(calls[0].file).toBe("mkcert");
		expect(calls[0].args).toEqual([
			"-cert-file",
			certPath,
			"-key-file",
			keyPath,
			"localhost",
			"devbox.local",
			"127.0.0.1",
			"::1",
		]);
		// Key is locked down even on the mkcert path.
		expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("--mkcert respects --force / skip semantics like the openssl path", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-mkcert-"));
		fs.writeFileSync(path.join(dir, "cert.pem"), "existing");
		let calls = 0;
		const fakeExec = () => {
			calls += 1;
			return Buffer.from("");
		};
		// Without --force, an existing pair short-circuits before exec.
		const skipped = initCert({ outDir: dir, mkcert: true, exec: fakeExec });
		expect(skipped.action).toBe("skipped");
		expect(skipped.tool).toBe("mkcert");
		expect(calls).toBe(0);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("missing mkcert is reported as a clear error with an install hint", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-mkcert-"));
		expect(() =>
			initCert({ outDir: dir, mkcert: true, mkcertBin: "/no/such/mkcert" }),
		).toThrow(/mkcert failed to generate cert.*brew install mkcert/s);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
