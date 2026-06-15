import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringifyFrontMatter } from "../src/front_matter.js";
import {
	buildBaseUrl,
	launchClaude,
	normalizeRemoteUrl,
	resolveCommandOnPath,
} from "../src/launch_claude.js";

let cwd;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-claude-cmd-"));
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

function fakeSpawn(captured) {
	return (command, args, opts) => {
		captured.command = command;
		captured.args = args;
		captured.opts = opts;
		return Object.assign(new EventEmitter(), { kill: () => {} });
	};
}

test("buildBaseUrl uses host and port verbatim", () => {
	expect(buildBaseUrl({ host: "127.0.0.1", port: 8080 })).toBe(
		"http://127.0.0.1:8080",
	);
	expect(buildBaseUrl({ host: "10.0.0.5", port: 9090 })).toBe(
		"http://10.0.0.5:9090",
	);
});

test("buildBaseUrl rewrites bind-only wildcards to loopback", () => {
	expect(buildBaseUrl({ host: "0.0.0.0", port: 8080 })).toBe(
		"http://127.0.0.1:8080",
	);
	expect(buildBaseUrl({ host: "::", port: 8080 })).toBe(
		"http://127.0.0.1:8080",
	);
});

test("resolveCommandOnPath finds executable files and skips everything else", () => {
	const bin = path.join(cwd, "bin");
	fs.mkdirSync(bin);
	const exe = path.join(bin, "claude");
	fs.writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "not-exec"), "data", { mode: 0o644 });
	fs.mkdirSync(path.join(bin, "a-dir"), { mode: 0o755 });
	const env = {
		PATH: [path.join(cwd, "missing"), bin].join(path.delimiter),
	};
	expect(resolveCommandOnPath("claude", env)).toBe(exe);
	expect(resolveCommandOnPath("not-exec", env)).toBe(null);
	expect(resolveCommandOnPath("a-dir", env)).toBe(null);
	expect(resolveCommandOnPath("absent", env)).toBe(null);
	expect(resolveCommandOnPath(exe, env)).toBe(exe);
	expect(resolveCommandOnPath("claude", { PATH: "" })).toBe(null);
});

test("launchClaude rejects with install instructions when claude is not on PATH", async () => {
	const emptyBin = path.join(cwd, "empty-bin");
	fs.mkdirSync(emptyBin);
	const env = { HOME: cwd, PATH: emptyBin };
	await expect(
		launchClaude({ cwd, env, stdinIsTty: false, stdoutIsTty: false }),
	).rejects.toThrow(/`claude` not found on PATH/);
	await expect(
		launchClaude({ cwd, env, stdinIsTty: false, stdoutIsTty: false }),
	).rejects.toThrow(/claude\.ai\/install\.sh/);
	await expect(
		launchClaude({ cwd, env, stdinIsTty: false, stdoutIsTty: false }),
	).rejects.toThrow(/@anthropic-ai\/claude-code/);
});

test("launchClaude spawns claude with ANTHROPIC_BASE_URL set from defaults", async () => {
	const captured = {};
	const env = { HOME: cwd, PATH: "/usr/bin", FOO: "bar" };
	const { baseUrl, mode } = await launchClaude({
		args: ["--resume"],
		cwd,
		env,
		spawnFn: fakeSpawn(captured),
	});
	expect(mode).toBe("spawn");
	expect(captured.command).toBe("claude");
	expect(captured.args).toEqual(["--resume"]);
	expect(captured.opts.stdio).toBe("inherit");
	expect(captured.opts.cwd).toBe(cwd);
	expect(baseUrl).toBe("http://127.0.0.1:8080");
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
	expect(captured.opts.env.FOO).toBe("bar");
});

test("launchClaude reflects host/port from auto-discovered ./CLAWBACK.md", async () => {
	fs.writeFileSync(
		path.join(cwd, "CLAWBACK.md"),
		stringifyFrontMatter({ host: "127.0.0.1", port: 9091 }),
	);
	const captured = {};
	const env = { HOME: cwd, PATH: "/usr/bin" };
	const { baseUrl } = await launchClaude({
		args: [],
		cwd,
		env,
		spawnFn: fakeSpawn(captured),
	});
	expect(baseUrl).toBe("http://127.0.0.1:9091");
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9091");
});

test("launchClaude forwards passthrough args verbatim, including flags", async () => {
	const captured = {};
	await launchClaude({
		args: ["--", "--help", "-p", "hello"],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
	});
	expect(captured.args).toEqual(["--", "--help", "-p", "hello"]);
});

test("launchClaude uses pre-supplied config without re-reading from disk", async () => {
	// Put a CLAWBACK.md on disk that would say port 9091; pass an explicit
	// config that says 7070. The explicit one must win and disk is not consulted.
	fs.writeFileSync(
		path.join(cwd, "CLAWBACK.md"),
		stringifyFrontMatter({ host: "127.0.0.1", port: 9091 }),
	);
	const captured = {};
	const { baseUrl, sources } = await launchClaude({
		args: [],
		config: { host: "127.0.0.1", port: 7070 },
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
	});
	expect(baseUrl).toBe("http://127.0.0.1:7070");
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7070");
	expect(sources).toEqual([]);
});

test("launchClaude overrides any pre-existing ANTHROPIC_BASE_URL in env", async () => {
	const captured = {};
	await launchClaude({
		args: [],
		cwd,
		env: {
			HOME: cwd,
			PATH: "/usr/bin",
			ANTHROPIC_BASE_URL: "https://api.anthropic.com",
		},
		spawnFn: fakeSpawn(captured),
	});
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
});

test("launchClaude uses PTY mode when a ptyFactory is supplied and stdio is TTY", async () => {
	const captured = {};
	const fakePty = {
		write: () => {},
		kill: () => {},
		onData: () => {},
		onExit: () => {},
		resize: () => {},
	};
	const ptyFactory = (opts) => {
		captured.opts = opts;
		return fakePty;
	};
	const result = await launchClaude({
		args: ["--resume"],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		ptyFactory,
		stdinIsTty: true,
		stdoutIsTty: true,
		cols: 132,
		rows: 50,
	});
	expect(result.mode).toBe("pty");
	expect(result.ptyProcess).toBe(fakePty);
	expect(result.child).toBeUndefined();
	expect(captured.opts.command).toBe("claude");
	expect(captured.opts.args).toEqual(["--resume"]);
	expect(captured.opts.cols).toBe(132);
	expect(captured.opts.rows).toBe(50);
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
});

test("launchClaude falls back to spawn when stdin is not a TTY (e.g. piped input)", async () => {
	const captured = {};
	let ptyFactoryCalled = false;
	const ptyFactory = () => {
		ptyFactoryCalled = true;
		return null;
	};
	const result = await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
		ptyFactory,
		stdinIsTty: false,
		stdoutIsTty: true,
	});
	expect(result.mode).toBe("spawn");
	expect(ptyFactoryCalled).toBe(false);
});

test("launchClaude falls back to spawn when ptyFactory returns null (node-pty missing)", async () => {
	const captured = {};
	const result = await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		// spawnFn null forces the PTY path to be tried first; ptyFactory rejects.
		ptyFactory: null,
		spawnFn: fakeSpawn(captured),
		stdinIsTty: true,
		stdoutIsTty: true,
	});
	// spawnFn was provided so allowPty is false; mode must be spawn.
	expect(result.mode).toBe("spawn");
});

// PLAN §39 (Phase 1): clawback id baked into the URL path + propagated to
// the child as CLAWBACK_PROXY_URL / CLAWBACK_SESSION_ID / CLAWBACK_SESSION_LABEL.
// These are what the spawned claude's statusline command reads to route the
// per-session POST to /_proxy/statusline/<id>.

test("buildBaseUrl appends clawback id as path component when provided", () => {
	expect(buildBaseUrl({ host: "127.0.0.1", port: 8080 }, "a3f9b2c1")).toBe(
		"http://127.0.0.1:8080/a3f9b2c1",
	);
});

test("buildBaseUrl with no clawback id returns the bare base URL (back-compat)", () => {
	expect(buildBaseUrl({ host: "127.0.0.1", port: 8080 })).toBe(
		"http://127.0.0.1:8080",
	);
	expect(buildBaseUrl({ host: "127.0.0.1", port: 8080 }, null)).toBe(
		"http://127.0.0.1:8080",
	);
});

test("launchClaude with clawbackId sets ANTHROPIC_BASE_URL with path AND propagates env vars", async () => {
	const captured = {};
	const env = { HOME: cwd, PATH: "/usr/bin" };
	const { baseUrl, clawbackId, label } = await launchClaude({
		args: [],
		cwd,
		env,
		spawnFn: fakeSpawn(captured),
		clawbackId: "a3f9b2c1",
		label: "red",
	});
	expect(baseUrl).toBe("http://127.0.0.1:8080/a3f9b2c1");
	expect(clawbackId).toBe("a3f9b2c1");
	expect(label).toBe("red");
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe(
		"http://127.0.0.1:8080/a3f9b2c1",
	);
	expect(captured.opts.env.CLAWBACK_PROXY_URL).toBe("http://127.0.0.1:8080");
	expect(captured.opts.env.CLAWBACK_SESSION_ID).toBe("a3f9b2c1");
	expect(captured.opts.env.CLAWBACK_SESSION_LABEL).toBe("red");
});

test("launchClaude without clawbackId omits the propagation env vars", async () => {
	const captured = {};
	await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
	});
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080");
	expect(captured.opts.env.CLAWBACK_PROXY_URL).toBeUndefined();
	expect(captured.opts.env.CLAWBACK_SESSION_ID).toBeUndefined();
});

test("launchClaude with clawbackId but no label omits CLAWBACK_SESSION_LABEL", async () => {
	const captured = {};
	await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
		clawbackId: "a3f9b2c1",
	});
	expect(captured.opts.env.CLAWBACK_SESSION_ID).toBe("a3f9b2c1");
	expect(captured.opts.env.CLAWBACK_SESSION_LABEL).toBeUndefined();
});

test("launchClaude sets CLAWBACK_AUTOLABEL=1 only for a git-auto label", async () => {
	// autoLabel true → the statusline command refreshes the branch per render.
	const a = {};
	await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(a),
		clawbackId: "a3f9b2c1",
		label: "clawback:main",
		autoLabel: true,
	});
	expect(a.opts.env.CLAWBACK_AUTOLABEL).toBe("1");

	// Operator --label (autoLabel default false) → no refresh signal.
	const b = {};
	await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(b),
		clawbackId: "a3f9b2c1",
		label: "my-work",
	});
	expect(b.opts.env.CLAWBACK_AUTOLABEL).toBeUndefined();
});

// `--remote URL`: launchClaude's remoteUrl override replaces the
// config-derived host:port for ANTHROPIC_BASE_URL and CLAWBACK_PROXY_URL,
// so the spawned claude (and its statusline curl) target the remote
// clawback instead of localhost.

describe("normalizeRemoteUrl", () => {
	test("strips trailing slash", () => {
		expect(normalizeRemoteUrl("http://remote.example:8888/")).toBe(
			"http://remote.example:8888",
		);
	});

	test("preserves explicit port", () => {
		expect(normalizeRemoteUrl("http://remote.example:8888")).toBe(
			"http://remote.example:8888",
		);
	});

	test("drops default port (URL parser doesn't surface :80/:443)", () => {
		expect(normalizeRemoteUrl("http://remote.example")).toBe(
			"http://remote.example",
		);
		expect(normalizeRemoteUrl("https://remote.example")).toBe(
			"https://remote.example",
		);
	});

	test("drops any path/query/hash the user pasted", () => {
		expect(
			normalizeRemoteUrl("http://remote.example:8888/some/path?x=1#frag"),
		).toBe("http://remote.example:8888");
	});

	test("rejects non-http(s) schemes", () => {
		expect(() => normalizeRemoteUrl("ftp://remote.example")).toThrow(
			/must be http:\/\/ or https:\/\//,
		);
	});

	test("rejects empty / non-string input", () => {
		expect(() => normalizeRemoteUrl("")).toThrow(/empty/);
		expect(() => normalizeRemoteUrl(null)).toThrow(/empty/);
		expect(() => normalizeRemoteUrl(undefined)).toThrow(/empty/);
	});

	test("rejects gibberish", () => {
		expect(() => normalizeRemoteUrl("not a url")).toThrow(/invalid remote URL/);
	});
});

test("launchClaude with remoteUrl points ANTHROPIC_BASE_URL at the remote (with session id)", async () => {
	const captured = {};
	const env = { HOME: cwd, PATH: "/usr/bin" };
	const { baseUrl, proxyUrl } = await launchClaude({
		args: [],
		cwd,
		env,
		spawnFn: fakeSpawn(captured),
		clawbackId: "a3f9b2c1",
		remoteUrl: "http://remoteclawback.ca:8888",
	});
	expect(baseUrl).toBe("http://remoteclawback.ca:8888/a3f9b2c1");
	expect(proxyUrl).toBe("http://remoteclawback.ca:8888");
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe(
		"http://remoteclawback.ca:8888/a3f9b2c1",
	);
	expect(captured.opts.env.CLAWBACK_PROXY_URL).toBe(
		"http://remoteclawback.ca:8888",
	);
	expect(captured.opts.env.CLAWBACK_SESSION_ID).toBe("a3f9b2c1");
});

test("launchClaude with remoteUrl wins over local CLAWBACK.md", async () => {
	fs.writeFileSync(
		path.join(cwd, "CLAWBACK.md"),
		stringifyFrontMatter({ host: "127.0.0.1", port: 9091 }),
	);
	const captured = {};
	const { baseUrl } = await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
		clawbackId: "feedface",
		remoteUrl: "https://elsewhere.example:443",
	});
	expect(baseUrl).toBe("https://elsewhere.example/feedface");
	expect(captured.opts.env.ANTHROPIC_BASE_URL).toBe(
		"https://elsewhere.example/feedface",
	);
});

test("launchClaude with remoteUrl strips trailing slash so URL doesn't double-up", async () => {
	const captured = {};
	const { baseUrl } = await launchClaude({
		args: [],
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
		clawbackId: "deadbeef",
		remoteUrl: "http://remote.example:8888/",
	});
	expect(baseUrl).toBe("http://remote.example:8888/deadbeef");
});

test("launchClaude with remoteUrl does NOT add local NODE_EXTRA_CA_CERTS", async () => {
	const certPath = path.join(cwd, "fake-cert.pem");
	fs.writeFileSync(certPath, "fake cert");
	const captured = {};
	await launchClaude({
		args: [],
		config: {
			host: "127.0.0.1",
			port: 8080,
			tls: true,
			tlsCertFile: certPath,
		},
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
		clawbackId: "abc12345",
		remoteUrl: "https://remote.example:8443",
	});
	// Local TLS cert is for the local proxy; it's irrelevant to a remote
	// endpoint and would just clutter the spawned claude's trust store.
	expect(captured.opts.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
});

test("launchClaude without remoteUrl preserves the existing NODE_EXTRA_CA_CERTS injection", async () => {
	const certPath = path.join(cwd, "fake-cert.pem");
	fs.writeFileSync(certPath, "fake cert");
	const captured = {};
	await launchClaude({
		args: [],
		config: {
			host: "127.0.0.1",
			port: 8080,
			tls: true,
			tlsCertFile: certPath,
		},
		cwd,
		env: { HOME: cwd, PATH: "/usr/bin" },
		spawnFn: fakeSpawn(captured),
	});
	expect(captured.opts.env.NODE_EXTRA_CA_CERTS).toBe(certPath);
});
