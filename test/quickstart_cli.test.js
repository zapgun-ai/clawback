/**
 * CLI-level tests for `clawback quickstart`. Spawns bin/clawback.js as a
 * subprocess so the assertions cover the dispatcher's exit behavior —
 * not just the underlying runQuickstart() function (which test/quickstart.test.js
 * already exercises).
 *
 * The smoking-gun bug this guards against: the `quickstart` branch used
 * to set up `child.on("exit", ...)` handlers and then fall through to
 * the top-level command parser at the bottom of bin/clawback.js. That
 * parser is invoked with `allowPositionals: false` and synchronously
 * throws ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL on "quickstart", killing
 * the parent before the child can attach to the TTY — which presents
 * to the operator as a hang.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringifyFrontMatter } from "../src/front_matter.js";

const BIN = path.resolve(
	new URL("../bin/clawback.js", import.meta.url).pathname,
);

function runBin(args, { env = {}, cwd, timeoutMs = 20000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			env: { ...process.env, ...env },
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
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			reject(
				new Error(
					`timed out after ${timeoutMs}ms; stdout=${stdout}; stderr=${stderr}`,
				),
			);
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

let cwd;
let homeDir;
let fakeBinDir;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-qs-cli-cwd-"));
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-qs-cli-home-"));
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-qs-cli-bin-"));

	// Fake claude that exits 0 immediately. Lets the spawned
	// `clawback claude` finish without depending on a real claude CLI.
	const fakeClaude = path.join(fakeBinDir, "claude");
	fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterEach(() => {
	for (const d of [cwd, homeDir, fakeBinDir]) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

test("`quickstart` exits cleanly after launching claude (no parseArgs fall-through)", async () => {
	// High random port to minimize the chance of colliding with a real
	// clawback running on 8080 on the dev machine.
	const port = 18000 + Math.floor(Math.random() * 5000);
	fs.writeFileSync(
		path.join(cwd, "CLAWBACK.md"),
		stringifyFrontMatter({ port }),
	);

	const { code, stdout, stderr } = await runBin(["quickstart"], {
		cwd,
		env: {
			HOME: homeDir,
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			CLAWBACK_NO_OPEN_BROWSER: "1",
		},
	});

	// Original bug surfaced as this exact node parseArgs stack trace.
	expect(stderr).not.toMatch(/ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL/);
	expect(stderr).not.toMatch(/Unexpected argument 'quickstart'/);
	// Sanity: we made it past the parent's spawn step.
	expect(stdout).toMatch(/clawback quickstart: launching claude/);
	// Fake claude exited 0; parent should propagate.
	expect(code).toBe(0);

	// Quickstart-launched sessions default to label "clawback" so they
	// show up identifiably in the dashboard's session filter. The label
	// is consumed by `clawback claude` (not forwarded to the spawned
	// claude binary), so we verify it landed by reading the proxy's
	// log file, which records label=… on the spawn line.
	const proxyLog = fs.readFileSync(
		path.join(cwd, "data", "clawback.log"),
		"utf8",
	);
	expect(proxyLog).toMatch(/label=clawback\b/);

	// quickstart writes .gitignore itself (cwd is not a git repo here) and
	// reports it, rather than telling the operator to "Gitignore that file."
	expect(stdout).toMatch(/created \.gitignore/);
	expect(stdout).not.toMatch(/Gitignore that file/);
	const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
	expect(gitignore).toMatch(/CLAWBACK\.md/);
});

test("`quickstart --no-launch` exits 0 without spawning claude", async () => {
	const { code, stdout, stderr } = await runBin(["quickstart", "--no-launch"], {
		cwd,
		env: {
			HOME: homeDir,
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			CLAWBACK_NO_OPEN_BROWSER: "1",
		},
	});
	expect(stderr).not.toMatch(/ERR_PARSE_ARGS/);
	expect(stdout).toMatch(/--no-launch set; skipping claude/);
	expect(code).toBe(0);

	// Default is loopback HTTP: the dashboard opens over http://, and none of
	// the LAN-only affordances (token surfacing, attach hint, 0.0.0.0 bind
	// notice) should appear.
	expect(stdout).toMatch(/dashboard will auto-open at http:\/\//);
	expect(stdout).not.toMatch(/adminToken:/);
	expect(stdout).not.toMatch(/bound to 0\.0\.0\.0/);
	expect(stdout).not.toMatch(/attach another machine/);

	// And the written config reflects the loopback posture.
	const cfg = fs.readFileSync(path.join(cwd, "CLAWBACK.md"), "utf8");
	expect(cfg).toMatch(/host:\s*"?127\.0\.0\.1"?/);
	expect(cfg).not.toMatch(/selfSign/);
});

test("`quickstart --lan --no-launch` binds 0.0.0.0 with TLS and surfaces the LAN affordances", async () => {
	const { code, stdout, stderr } = await runBin(
		["quickstart", "--lan", "--no-launch"],
		{
			cwd,
			env: {
				HOME: homeDir,
				// Isolate any mkcert/self-signed cert writes to a temp data dir.
				XDG_DATA_HOME: path.join(homeDir, "xdg-data"),
				PATH: `${fakeBinDir}:${process.env.PATH}`,
				CLAWBACK_NO_OPEN_BROWSER: "1",
			},
		},
	);
	expect(stderr).not.toMatch(/ERR_PARSE_ARGS/);
	expect(code).toBe(0);

	// LAN posture in the written config.
	const cfg = fs.readFileSync(path.join(cwd, "CLAWBACK.md"), "utf8");
	expect(cfg).toMatch(/host:\s*"?0\.0\.0\.0"?/);
	expect(cfg).toMatch(/selfSign:\s*true/);

	// LAN dashboard is HTTPS and the LAN affordances are surfaced.
	expect(stdout).toMatch(/dashboard will auto-open at https:\/\//);
	expect(stdout).toMatch(/bound to 0\.0\.0\.0/);
	// mkcert may or may not be installed in this environment; either the
	// minted-cert line or the not-found fallback note is acceptable, but the
	// run must not crash.
	expect(stdout + stderr).toMatch(/mkcert|self-signed/);
});

test("`quick` is an alias for `quickstart` (no fall-through to parseArgs)", async () => {
	// The alias is implemented by rewriting process.argv[2] at the top
	// of bin/clawback.js. If the rewrite ever regresses, this test
	// catches it two ways: the "unknown subcommand 'quick'" branch
	// would trip (exit 2 + stderr), or — if the rewrite happens after
	// the top-level parseArgs were reached — we'd see
	// ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL.
	const { code, stdout, stderr } = await runBin(["quick", "--no-launch"], {
		cwd,
		env: {
			HOME: homeDir,
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			CLAWBACK_NO_OPEN_BROWSER: "1",
		},
	});
	expect(stderr).not.toMatch(/ERR_PARSE_ARGS/);
	expect(stderr).not.toMatch(/unknown subcommand/);
	expect(stdout).toMatch(/--no-launch set; skipping claude/);
	expect(code).toBe(0);
});

test("`up` is an alias for `quickstart` (no fall-through to parseArgs)", async () => {
	// Same argv[2] rewrite as the `quick` alias above; guards the same two
	// regressions ("unknown subcommand 'up'" or ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL
	// if the rewrite ever moves after the top-level parseArgs).
	const { code, stdout, stderr } = await runBin(["up", "--no-launch"], {
		cwd,
		env: {
			HOME: homeDir,
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			CLAWBACK_NO_OPEN_BROWSER: "1",
		},
	});
	expect(stderr).not.toMatch(/ERR_PARSE_ARGS/);
	expect(stderr).not.toMatch(/unknown subcommand/);
	expect(stdout).toMatch(/--no-launch set; skipping claude/);
	expect(code).toBe(0);
});

test("bare `clawback` creates a .gitignore for its detritus before starting", async () => {
	// `--admin-path v1` is rejected by config validation, so start() throws
	// and the process exits 1 fast — but the bare command writes .gitignore
	// BEFORE start(), so we can assert it landed without leaving a server
	// running to kill. (cwd is a bare temp dir — no .git/ — proving the
	// forced write doesn't depend on a repo.)
	const { code, stderr } = await runBin(["--admin-path", "v1"], {
		cwd,
		env: { HOME: homeDir },
		timeoutMs: 10000,
	});
	expect(code).toBe(1);
	expect(stderr).toMatch(/failed to start/);

	const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
	expect(gitignore).toMatch(/CLAWBACK\.md/);
	expect(gitignore).toMatch(/data\//);
	expect(gitignore).toMatch(/logs\//);
});
