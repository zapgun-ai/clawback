import http from "node:http";
import { probeClawback } from "../src/probe.js";

function startServer(handler) {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: server.address().port });
		});
	});
}

test("probe returns isClawback=true on a well-shaped /health response", async () => {
	const { server, port } = await startServer((req, res) => {
		expect(req.url).toBe("/_proxy/health");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				uptimeSeconds: 12,
				sessions: 0,
				config: {
					_clawback: true,
					keepAliveMinMs: 60000,
					adminPathPrefix: "_proxy",
					autoContinue: false,
				},
			}),
		);
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(true);
		expect(result.error).toBeNull();
		// Probed over plain HTTP (tls defaults to false) and the server answered
		// directly — no upgrade — so the discovered transport is http.
		expect(result.tls).toBe(false);
		expect(result.info.config._clawback).toBe(true);
	} finally {
		server.close();
	}
});

test("probe surfaces autoContinue from the running server's config", async () => {
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				config: {
					_clawback: true,
					keepAliveMinMs: 60000,
					adminPathPrefix: "_proxy",
					autoContinue: true,
				},
			}),
		);
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.isClawback).toBe(true);
		expect(result.info.config.autoContinue).toBe(true);
	} finally {
		server.close();
	}
});

test("probe respects a custom adminPathPrefix", async () => {
	const { server, port } = await startServer((req, res) => {
		expect(req.url).toBe("/myadmin/health");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				config: {
					_clawback: true,
					keepAliveMinMs: 60000,
					adminPathPrefix: "myadmin",
				},
			}),
		);
	});
	try {
		const result = await probeClawback({
			host: "127.0.0.1",
			port,
			adminPathPrefix: "myadmin",
		});
		expect(result.isClawback).toBe(true);
	} finally {
		server.close();
	}
});

test("probe rewrites bind-only host 0.0.0.0 to loopback", async () => {
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				config: {
					_clawback: true,
					keepAliveMinMs: 60000,
					adminPathPrefix: "_proxy",
				},
			}),
		);
	});
	try {
		const result = await probeClawback({ host: "0.0.0.0", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(true);
	} finally {
		server.close();
	}
});

test("probe returns reachable=true, isClawback=false on a 200 with the wrong shape", async () => {
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"hello": "world"}');
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(false);
		expect(result.error).toMatch(/shape/);
		expect(result.info).toEqual({ hello: "world" });
	} finally {
		server.close();
	}
});

test("probe returns reachable=true, isClawback=false on a non-JSON body", async () => {
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("hello world");
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(false);
		expect(result.error).toMatch(/JSON/);
	} finally {
		server.close();
	}
});

test("probe rejects status='ok' but missing clawback-specific config keys", async () => {
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok", config: { foo: "bar" } }));
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.isClawback).toBe(false);
	} finally {
		server.close();
	}
});

test("probe returns reachable=true, isClawback=false on non-200 status", async () => {
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(404);
		res.end();
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(false);
		expect(result.error).toMatch(/non-200 status 404/);
	} finally {
		server.close();
	}
});

test("a stray 308 without clawback's upgrade marker is NOT followed (reported as non-200)", async () => {
	// An unrelated service that happens to answer /_proxy/health with a 308 but
	// no `x-clawback-upgrade` header and no https:// Location must not bounce the
	// probe onto TLS. The 3xx is reported as a plain non-200 so the caller
	// refuses to attach rather than chasing a phantom upgrade.
	const { server, port } = await startServer((_req, res) => {
		res.writeHead(308, { location: "http://127.0.0.1:9/elsewhere" });
		res.end();
	});
	try {
		const result = await probeClawback({ host: "127.0.0.1", port });
		expect(result.reachable).toBe(true);
		expect(result.isClawback).toBe(false);
		expect(result.error).toMatch(/non-200 status 308/);
		expect(result.tls).toBe(false);
	} finally {
		server.close();
	}
});

test("probe returns reachable=false when nothing is listening (ECONNREFUSED)", async () => {
	// Bind a server then close it so the port is reliably empty.
	const { server, port } = await startServer((_req, res) => res.end());
	await new Promise((r) => server.close(r));
	const result = await probeClawback({ host: "127.0.0.1", port });
	expect(result.reachable).toBe(false);
	expect(result.isClawback).toBe(false);
	expect(result.error).toBeTruthy();
});

test("probe returns reachable=false on timeout", async () => {
	// Server accepts the connection but never responds.
	const { server, port } = await startServer(() => {
		// Intentionally hang.
	});
	try {
		const result = await probeClawback({
			host: "127.0.0.1",
			port,
			timeoutMs: 50,
		});
		expect(result.reachable).toBe(false);
		expect(result.error).toMatch(/timeout|aborted|socket/i);
	} finally {
		server.close();
		// The server has open sockets; force-destroy.
		server.closeAllConnections?.();
	}
});

test("probe never throws — failure modes are all returned", async () => {
	// Garbage host should resolve into an error path, not a thrown exception.
	const result = await probeClawback({
		host: "127.0.0.1",
		port: 1, // privileged, refused
		timeoutMs: 100,
	});
	expect(result.reachable).toBe(false);
});
