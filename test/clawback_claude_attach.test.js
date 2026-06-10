/**
 * Integration test for `clawback claude` attach mode (PLAN §30.5).
 *
 * Spawns the bin as a child process. A fake `claude` binary on PATH echoes
 * its ANTHROPIC_BASE_URL so we can assert what the bin pointed it at. When
 * a clawback is already listening, the bin must attach (not start a second
 * proxy) and the spawned claude must see the running server's URL.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
	composeSessionLabel,
	sanitizeHostSegment,
} from "../src/clawback_id.js";
import { stringifyFrontMatter } from "../src/front_matter.js";

const BIN = path.resolve(
	new URL("../bin/clawback.js", import.meta.url).pathname,
);

function startFakeClawback({ port = 0, body } = {}) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			if (req.url === "/_proxy/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		server.listen(port, "127.0.0.1", () => {
			resolve({ server, port: server.address().port });
		});
	});
}

function makeFakeClaude(dir) {
	const stub = path.join(dir, "claude");
	const script = `#!/usr/bin/env node
process.stdout.write("FAKE_CLAUDE_URL=" + (process.env.ANTHROPIC_BASE_URL || "") + "\\n");
process.exit(0);
`;
	fs.writeFileSync(stub, script);
	fs.chmodSync(stub, 0o755);
	return stub;
}

function runBin({ args, env, cwd }) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			env,
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c.toString();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString();
		});
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

let cwd;
let pathDir;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-attach-cwd-"));
	pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-attach-path-"));
	makeFakeClaude(pathDir);
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(pathDir, { recursive: true, force: true });
});

test("attaches to a running clawback and points claude at it (no second proxy)", async () => {
	const { server, port } = await startFakeClawback({
		body: {
			status: "ok",
			config: {
				_clawback: true,
				keepAliveMinMs: 60000,
				adminPathPrefix: "_proxy",
				autoContinue: false,
			},
		},
	});
	try {
		fs.writeFileSync(
			path.join(cwd, "CLAWBACK.md"),
			stringifyFrontMatter({ host: "127.0.0.1", port }),
		);
		const result = await runBin({
			args: ["claude"],
			env: {
				...process.env,
				HOME: cwd,
				PATH: `${pathDir}:${process.env.PATH ?? ""}`,
				XDG_CONFIG_HOME: path.join(cwd, ".config-empty"),
			},
			cwd,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`FAKE_CLAUDE_URL=http://127.0.0.1:${port}`);
		expect(result.stderr).toMatch(/attached to running clawback/);
		// The probe path must not have logged "proxy logs ->" — that's only
		// printed when we start an in-process proxy.
		expect(result.stderr).not.toMatch(/proxy logs ->/);
	} finally {
		server.close();
	}
});

test("warns when running clawback has autoContinue on but no PTY is available", async () => {
	// In this test the spawned "claude" is a plain node script, not a TTY,
	// so launchClaude falls back to spawn mode (no PTY). The reverse
	// channel cannot register a callback without a PTY, so the launcher
	// must emit the historical "input routing is disabled" warning when
	// the running clawback has autoContinue on.
	const { server, port } = await startFakeClawback({
		body: {
			status: "ok",
			config: {
				_clawback: true,
				keepAliveMinMs: 60000,
				adminPathPrefix: "_proxy",
				autoContinue: true,
			},
		},
	});
	try {
		fs.writeFileSync(
			path.join(cwd, "CLAWBACK.md"),
			stringifyFrontMatter({ host: "127.0.0.1", port }),
		);
		const result = await runBin({
			args: ["claude"],
			env: {
				...process.env,
				HOME: cwd,
				PATH: `${pathDir}:${process.env.PATH ?? ""}`,
				XDG_CONFIG_HOME: path.join(cwd, ".config-empty"),
			},
			cwd,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(/auto-continue/);
		expect(result.stderr).toMatch(/reverse-channel input routing is disabled/);
	} finally {
		server.close();
	}
});

// `clawback claude --remote URL` short-circuits the probe + in-process
// proxy entirely. The remote may or may not be reachable from this host
// (we don't probe it) — claude is just pointed at the URL and the
// launcher exits when claude does.

test("--remote skips probe, skips local proxy, points claude at the remote URL", async () => {
	// Stand up a fake "remote" clawback that captures the session-label
	// POST so we can verify the launcher routes admin traffic to the
	// remote rather than to the local config's host:port.
	const labelPosts = [];
	const { server, port } = await new Promise((resolve) => {
		const s = http.createServer((req, res) => {
			if (req.method === "POST" && req.url.startsWith("/_proxy/sessions/")) {
				let body = "";
				req.on("data", (c) => {
					body += c.toString();
				});
				req.on("end", () => {
					labelPosts.push({ url: req.url, body });
					res.writeHead(200, { "content-type": "application/json" });
					res.end("{}");
				});
				return;
			}
			res.writeHead(404);
			res.end();
		});
		s.listen(0, "127.0.0.1", () =>
			resolve({ server: s, port: s.address().port }),
		);
	});
	try {
		// Point the local CLAWBACK.md at a port nothing's listening on.
		// If the launcher accidentally probes the LOCAL host:port, the
		// probe will (correctly) say "unreachable", but that's a code
		// path we want to skip entirely with --remote. The proof: a
		// local proxy startup would emit "proxy logs ->" on stderr;
		// asserting its absence is the cleanest check.
		fs.writeFileSync(
			path.join(cwd, "CLAWBACK.md"),
			stringifyFrontMatter({ host: "127.0.0.1", port: 1 }),
		);
		const remoteUrl = `http://127.0.0.1:${port}`;
		const result = await runBin({
			args: ["claude", "--remote", remoteUrl, "--label", "from-remote"],
			env: {
				...process.env,
				HOME: cwd,
				PATH: `${pathDir}:${process.env.PATH ?? ""}`,
				XDG_CONFIG_HOME: path.join(cwd, ".config-empty"),
			},
			cwd,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(
			new RegExp(`FAKE_CLAUDE_URL=http://127\\.0\\.0\\.1:${port}/[0-9a-f]{8}`),
		);
		expect(result.stderr).toMatch(/remote/);
		// No local proxy started.
		expect(result.stderr).not.toMatch(/proxy logs ->/);
		// No "attached to running clawback" — that's the local-probe path.
		expect(result.stderr).not.toMatch(/attached to running clawback/);
		// Label POST landed on the remote, not on localhost:1.
		expect(labelPosts.length).toBe(1);
		expect(labelPosts[0].url).toMatch(/^\/_proxy\/sessions\/[0-9a-f]{8}$/);
		// The launcher prefixes its origin hostname so the remote dashboard
		// can attribute the session to this machine (e.g. alexmac:from-remote).
		// Mirror the bin's logic to compute the expected value on whatever
		// host the test runs on.
		const host = sanitizeHostSegment(os.hostname());
		const expectedLabel = host
			? composeSessionLabel(host, "from-remote")
			: "from-remote";
		expect(JSON.parse(labelPosts[0].body)).toEqual({ label: expectedLabel });
	} finally {
		server.close();
	}
});

test("local attach records the bare --label, NOT host-prefixed", async () => {
	// Regression (2026-05-29): the origin-host prefix is a shared-dashboard
	// concern and must apply only on a --remote launch. A local attach must
	// record the operator's label verbatim — `--label work` shows `work`,
	// not `<thishost>:work`. Stand up a fake clawback that both answers the
	// health probe (so the launcher takes the attach branch) and captures
	// the session-label POST.
	const labelPosts = [];
	const { server, port } = await new Promise((resolve) => {
		const s = http.createServer((req, res) => {
			if (req.url === "/_proxy/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						status: "ok",
						config: {
							_clawback: true,
							keepAliveMinMs: 60000,
							adminPathPrefix: "_proxy",
							autoContinue: false,
						},
					}),
				);
				return;
			}
			if (req.method === "POST" && req.url.startsWith("/_proxy/sessions/")) {
				let body = "";
				req.on("data", (c) => {
					body += c.toString();
				});
				req.on("end", () => {
					labelPosts.push({ url: req.url, body });
					res.writeHead(200, { "content-type": "application/json" });
					res.end("{}");
				});
				return;
			}
			res.writeHead(404);
			res.end();
		});
		s.listen(0, "127.0.0.1", () =>
			resolve({ server: s, port: s.address().port }),
		);
	});
	try {
		fs.writeFileSync(
			path.join(cwd, "CLAWBACK.md"),
			stringifyFrontMatter({ host: "127.0.0.1", port }),
		);
		const result = await runBin({
			args: ["claude", "--label", "local-work"],
			env: {
				...process.env,
				HOME: cwd,
				PATH: `${pathDir}:${process.env.PATH ?? ""}`,
				XDG_CONFIG_HOME: path.join(cwd, ".config-empty"),
			},
			cwd,
		});
		expect(result.code).toBe(0);
		// Took the local attach branch, not the remote one.
		expect(result.stderr).toMatch(/attached to running clawback/);
		expect(result.stderr).not.toMatch(/remote/);
		// The recorded label is the bare operator value — no host prefix.
		expect(labelPosts.length).toBe(1);
		expect(labelPosts[0].url).toMatch(/^\/_proxy\/sessions\/[0-9a-f]{8}$/);
		expect(JSON.parse(labelPosts[0].body)).toEqual({ label: "local-work" });
	} finally {
		server.close();
	}
});

test("--remote rejects an invalid URL with a clear error (exit 2)", async () => {
	const result = await runBin({
		args: ["claude", "--remote", "not a url"],
		env: {
			...process.env,
			HOME: cwd,
			PATH: `${pathDir}:${process.env.PATH ?? ""}`,
			XDG_CONFIG_HOME: path.join(cwd, ".config-empty"),
		},
		cwd,
	});
	expect(result.code).toBe(2);
	expect(result.stderr).toMatch(/invalid remote URL|must be http/);
	expect(result.stdout).not.toContain("FAKE_CLAUDE_URL");
});

test("refuses to attach when something non-clawback is on the port", async () => {
	const { server, port } = await new Promise((resolve) => {
		const s = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("not clawback");
		});
		s.listen(0, "127.0.0.1", () =>
			resolve({ server: s, port: s.address().port }),
		);
	});
	try {
		fs.writeFileSync(
			path.join(cwd, "CLAWBACK.md"),
			stringifyFrontMatter({ host: "127.0.0.1", port }),
		);
		const result = await runBin({
			args: ["claude"],
			env: {
				...process.env,
				HOME: cwd,
				PATH: `${pathDir}:${process.env.PATH ?? ""}`,
				XDG_CONFIG_HOME: path.join(cwd, ".config-empty"),
			},
			cwd,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(
			/occupied by something that doesn't look like clawback/i,
		);
		expect(result.stdout).not.toContain("FAKE_CLAUDE_URL");
	} finally {
		server.close();
	}
});
