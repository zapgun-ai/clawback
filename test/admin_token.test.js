import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleAdmin } from "../src/admin.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

function makeConfig(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-token-"));
	const merged = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: "http://127.0.0.1:1",
		stateFile: path.join(dir, "state.json"),
		turnLogFile: null,
		sessionLogDir: null,
		...overrides,
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

function makeStore(config) {
	return new SessionStore({ filePath: config.stateFile, logger });
}

function noopScheduler() {
	return {
		start() {},
		stop() {},
		ensureScheduled() {},
		cancelSession() {},
	};
}

// Direct-invoke harness for non-loopback testing. The real-HTTP harness
// always reports remoteAddress as 127.0.0.1, which the loopback exemption
// bypasses — we need a mocked socket to simulate a LAN/WAN caller.
function mockReq({ method, url, headers = {}, remoteAddress = "10.0.0.5" }) {
	return {
		method,
		url,
		headers,
		socket: { remoteAddress },
	};
}

function mockRes() {
	const captured = {};
	const res = {
		headersSent: false,
		writeHead(status, h) {
			captured.status = status;
			captured.headers = h;
			res.headersSent = true;
		},
		end(body) {
			captured.body = body;
			try {
				captured.json = body?.length ? JSON.parse(body) : null;
			} catch {
				captured.json = null;
			}
		},
	};
	return { res, captured };
}

async function callAdmin({
	method,
	url,
	headers,
	remoteAddress,
	config,
	store,
}) {
	const req = mockReq({ method, url, headers, remoteAddress });
	const { res, captured } = mockRes();
	await handleAdmin(req, res, {
		store,
		scheduler: noopScheduler(),
		config,
		logger,
	});
	return captured;
}

describe("admin bearer token", () => {
	describe("token unset (back-compat)", () => {
		test("write requests pass without Authorization", async () => {
			const { config, dir } = makeConfig({ adminToken: null });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				config,
				store,
				remoteAddress: "10.0.0.5",
			});
			expect(captured.status).toBe(200);
			fs.rmSync(dir, { recursive: true, force: true });
		});
	});

	describe("token set", () => {
		const TOKEN = "s3cr3t-token-value";

		test("loopback POST without Authorization is exempt", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				config,
				store,
				remoteAddress: "127.0.0.1",
			});
			expect(captured.status).toBe(200);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("loopback (IPv6) DELETE without Authorization is exempt", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				config,
				store,
				remoteAddress: "::1",
			});
			expect(captured.status).toBe(200);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("loopback (IPv4-mapped IPv6) is exempt", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				config,
				store,
				remoteAddress: "::ffff:127.0.0.1",
			});
			expect(captured.status).toBe(200);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("non-loopback write without Authorization returns 401", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(captured.status).toBe(401);
			expect(captured.json?.error).toBe("unauthorized");
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("non-loopback write with wrong token returns 401", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				headers: { authorization: "Bearer wrong-token" },
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(captured.status).toBe(401);
			expect(captured.json?.error).toBe("unauthorized");
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("non-loopback write with right token returns 200", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				headers: { authorization: `Bearer ${TOKEN}` },
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(captured.status).toBe(200);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("non-loopback POST is gated identically to DELETE", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const unauth = await callAdmin({
				method: "POST",
				url: "/_proxy/passthrough",
				headers: { "content-type": "application/json" },
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(unauth.status).toBe(401);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("non-loopback GET is open (token only gates writes)", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "GET",
				url: "/_proxy/health",
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(captured.status).toBe(200);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("bearer prefix is case-insensitive but token compare is exact", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const lower = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				headers: { authorization: `bearer ${TOKEN}` },
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(lower.status).toBe(200);

			// Slight perturbation of the token must be rejected.
			const perturbed = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				headers: { authorization: `Bearer ${TOKEN.toUpperCase()}` },
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(perturbed.status).toBe(401);
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test("malformed Authorization header is rejected", async () => {
			const { config, dir } = makeConfig({ adminToken: TOKEN });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "DELETE",
				url: "/_proxy/sessions",
				headers: { authorization: "NotBearer something" },
				config,
				store,
				remoteAddress: "192.168.1.50",
			});
			expect(captured.status).toBe(401);
			fs.rmSync(dir, { recursive: true, force: true });
		});
	});

	describe("token is not exposed in any GET response body", () => {
		test("/_proxy/health.config does not include adminToken", async () => {
			const { config, dir } = makeConfig({ adminToken: "do-not-leak-me" });
			const store = makeStore(config);
			const captured = await callAdmin({
				method: "GET",
				url: "/_proxy/health",
				config,
				store,
				remoteAddress: "127.0.0.1",
			});
			expect(captured.status).toBe(200);
			expect(JSON.stringify(captured.json)).not.toContain("do-not-leak-me");
			expect(captured.json?.config?.adminToken).toBeUndefined();
			fs.rmSync(dir, { recursive: true, force: true });
		});
	});

	describe("real-HTTP smoke (loopback exemption)", () => {
		let server;
		let port;
		let cleanup;

		beforeEach(async () => {
			const { config, dir } = makeConfig({ adminToken: "smoke-token" });
			const store = makeStore(config);
			server = createServer({
				config,
				store,
				scheduler: noopScheduler(),
				logger,
			});
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			port = server.address().port;
			cleanup = () => {
				server.close();
				fs.rmSync(dir, { recursive: true, force: true });
			};
		});

		afterEach(() => cleanup?.());

		test("DELETE /_proxy/sessions from 127.0.0.1 succeeds without Authorization", async () => {
			const status = await new Promise((resolve, reject) => {
				const req = http.request(
					{
						method: "DELETE",
						host: "127.0.0.1",
						port,
						path: "/_proxy/sessions",
					},
					(res) => {
						res.resume();
						res.on("end", () => resolve(res.statusCode));
					},
				);
				req.on("error", reject);
				req.end();
			});
			expect(status).toBe(200);
		});
	});
});

// Audit H1: CSRF + DNS-rebinding hardening. These checks run before the
// adminToken gate and apply regardless of whether a token is configured,
// because a same-origin browser POST or a rebound page can otherwise
// reach loopback unauthenticated.
describe("CSRF / DNS-rebinding hardening (assertOriginSafe)", () => {
	function makeAdminCtx() {
		const { config, dir } = makeConfig({ adminToken: null });
		const store = makeStore(config);
		return { config, store, dir };
	}

	test("POST without Content-Type is 415 (kills text/plain CORS bypass)", async () => {
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "POST",
			url: "/_proxy/passthrough",
			headers: {}, // no content-type
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		expect(captured.status).toBe(415);
		expect(captured.json?.error).toBe("unsupported_media_type");
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("POST with Content-Type: text/plain is 415", async () => {
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "POST",
			url: "/_proxy/passthrough",
			headers: { "content-type": "text/plain" },
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		expect(captured.status).toBe(415);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("DELETE without Content-Type passes (DELETE has no body)", async () => {
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "DELETE",
			url: "/_proxy/sessions",
			headers: {},
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		expect(captured.status).toBe(200);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("Host header that doesn't match the listening interface is 421", async () => {
		// Simulate a real socket so localAddress is populated.
		const ctx = makeAdminCtx();
		const req = {
			method: "POST",
			url: "/_proxy/passthrough",
			headers: {
				"content-type": "application/json",
				host: "attacker.evil",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store: ctx.store,
			scheduler: noopScheduler(),
			config: ctx.config,
			logger,
		});
		expect(captured.status).toBe(421);
		expect(captured.json?.error).toBe("misdirected_request");
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("Host: localhost is accepted even when bound to 127.0.0.1", async () => {
		// DELETE chosen over POST to avoid the endpoint's JSON-body
		// validation; what we're proving is that the CSRF gate doesn't
		// 421 a `Host: localhost` header.
		const ctx = makeAdminCtx();
		const req = {
			method: "DELETE",
			url: "/_proxy/sessions",
			headers: {
				host: "localhost:8080",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store: ctx.store,
			scheduler: noopScheduler(),
			config: ctx.config,
			logger,
		});
		expect(captured.status).toBe(200);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("Cross-origin POST (Origin: http://evil) is 403", async () => {
		const ctx = makeAdminCtx();
		const req = {
			method: "POST",
			url: "/_proxy/passthrough",
			headers: {
				"content-type": "application/json",
				origin: "http://evil.example",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store: ctx.store,
			scheduler: noopScheduler(),
			config: ctx.config,
			logger,
		});
		expect(captured.status).toBe(403);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("Same-origin write (Origin: http://127.0.0.1:PORT) passes", async () => {
		const ctx = makeAdminCtx();
		const req = {
			method: "DELETE",
			url: "/_proxy/sessions",
			headers: {
				origin: "http://127.0.0.1:8080",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store: ctx.store,
			scheduler: noopScheduler(),
			config: ctx.config,
			logger,
		});
		expect(captured.status).toBe(200);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("statusline endpoint is exempt (legacy curl line stays working)", async () => {
		// The pre-existing statusLine command in operator settings.json
		// uses curl --data-binary @- without -H content-type. Forcing the
		// check there would break every existing operator silently on
		// upgrade. The endpoint only writes to the metrics ring.
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "POST",
			url: "/_proxy/statusline/_default",
			headers: {}, // no content-type
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		// Server responds 200 with plain-text statusline content even
		// when the JSON body fails to parse (renderStatusline falls
		// back to clawback-only render).
		expect(captured.status).toBe(200);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("Host/Origin checks skip when the request PRESENTS the bearer (unlocks --remote)", async () => {
		// Remote operators dial in by hostname: `clawback claude --remote
		// homelab.local`. The server's localAddress is the bound IP,
		// which won't equal the hostname. The Host check would 421 these
		// legitimate calls. A PRESENTED valid bearer is the auth boundary,
		// so Host/Origin are skipped for it — but only for presented
		// tokens, not merely configured ones (see the rebinding test
		// below).
		const { config, dir } = makeConfig({ adminToken: "remote-tok" });
		const store = makeStore(config);
		const req = {
			method: "DELETE",
			url: "/_proxy/sessions",
			headers: {
				host: "homelab.local:8888",
				origin: "https://homelab.local:8888",
				authorization: "Bearer remote-tok",
			},
			socket: { remoteAddress: "192.168.1.50", localAddress: "192.168.1.5" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store,
			scheduler: noopScheduler(),
			config,
			logger,
		});
		expect(captured.status).toBe(200);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("rebound loopback write on a token-configured proxy is 421 (token configured ≠ token presented)", async () => {
		// The DNS-rebinding regression this whole layering exists for:
		// loopback writes are token-EXEMPT, so if configuring a token
		// skipped Host/Origin by itself, a rebound page (browser connects
		// to 127.0.0.1, sends Host: attacker.evil, no bearer) would reach
		// the write surface with no check at all. The skip must require
		// the bearer to be PRESENTED.
		const { config, dir } = makeConfig({ adminToken: "tok" });
		const store = makeStore(config);
		const req = {
			method: "POST",
			url: "/_proxy/passthrough",
			headers: {
				"content-type": "application/json",
				host: "attacker.evil",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store,
			scheduler: noopScheduler(),
			config,
			logger,
		});
		expect(captured.status).toBe(421);
		expect(captured.json?.error).toBe("misdirected_request");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a WRONG bearer does not unlock the Host/Origin skip", async () => {
		const { config, dir } = makeConfig({ adminToken: "tok" });
		const store = makeStore(config);
		const req = {
			method: "POST",
			url: "/_proxy/passthrough",
			headers: {
				"content-type": "application/json",
				host: "attacker.evil",
				authorization: "Bearer not-the-token",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store,
			scheduler: noopScheduler(),
			config,
			logger,
		});
		expect(captured.status).toBe(421);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("hostname GET on a token-configured proxy stays open without a bearer", async () => {
		// The documented read posture: GETs are open even with a token
		// set, and remote operators read the UI/health by hostname. The
		// presented-bearer tightening must not break that.
		const { config, dir } = makeConfig({ adminToken: "tok" });
		const store = makeStore(config);
		const req = {
			method: "GET",
			url: "/_proxy/health",
			headers: { host: "homelab.local:8888" },
			socket: { remoteAddress: "192.168.1.50", localAddress: "192.168.1.5" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store,
			scheduler: noopScheduler(),
			config,
			logger,
		});
		expect(captured.status).toBe(200);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("statusline write carrying an Origin header is 403 (no browser writes)", async () => {
		// curl (the only legitimate statusline writer) never sends Origin;
		// a browser always does on cross-origin POSTs. A rebound page must
		// not be able to spray junk into the metrics ring.
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "POST",
			url: "/_proxy/statusline/_default",
			headers: { origin: "http://evil.example" },
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		expect(captured.status).toBe(403);
		expect(captured.json?.error).toBe("forbidden");
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("statusline write with Origin: null is 403 (sandboxed iframe is still a browser)", async () => {
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "POST",
			url: "/_proxy/statusline/_default",
			headers: { origin: "null" },
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		expect(captured.status).toBe(403);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("statusline GET with an Origin header stays open (read-only, browsers may read)", async () => {
		const ctx = makeAdminCtx();
		const captured = await callAdmin({
			method: "GET",
			url: "/_proxy/statusline/_default",
			headers: { origin: "http://evil.example" },
			config: ctx.config,
			store: ctx.store,
			remoteAddress: "127.0.0.1",
		});
		expect(captured.status).toBe(200);
		fs.rmSync(ctx.dir, { recursive: true, force: true });
	});

	test("Content-Type check applies even when adminToken is set", async () => {
		// The token shortcuts Host/Origin but not the simple-request
		// content-type guard — that defense is cheap and orthogonal to
		// auth (it stops a same-origin malicious page from skipping
		// preflight via text/plain on a tokened proxy).
		const { config, dir } = makeConfig({ adminToken: "tok" });
		const store = makeStore(config);
		const req = {
			method: "POST",
			url: "/_proxy/passthrough",
			headers: {
				"content-type": "text/plain",
				authorization: "Bearer tok",
			},
			socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" },
		};
		const { res, captured } = mockRes();
		await (await import("../src/admin.js")).handleAdmin(req, res, {
			store,
			scheduler: noopScheduler(),
			config,
			logger,
		});
		expect(captured.status).toBe(415);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
