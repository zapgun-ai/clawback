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
});

test("`quickstart` re-wires the statusline over a pre-existing foreign block and says so", async () => {
	// Operator already has a custom Claude Code statusline. A clean
	// install must still leave clawback's metrics statusline effective —
	// and tell the operator what it displaced (not silently overwrite).
	fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(homeDir, ".claude", "settings.json"),
		`${JSON.stringify(
			{ statusLine: { type: "command", command: "echo MY-CUSTOM" } },
			null,
			2,
		)}\n`,
	);

	const { code, stdout } = await runBin(["quickstart", "--no-launch"], {
		cwd,
		env: {
			HOME: homeDir,
			PATH: `${fakeBinDir}:${process.env.PATH}`,
			CLAWBACK_NO_OPEN_BROWSER: "1",
		},
	});
	expect(code).toBe(0);
	expect(stdout).toMatch(/overwrote statusline/);
	expect(stdout).toMatch(/replaced your existing \(non-clawback\) statusLine/);
	expect(stdout).toMatch(/previous: echo MY-CUSTOM/);

	const parsed = JSON.parse(
		fs.readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"),
	);
	expect(parsed.statusLine.command).toMatch(/_proxy\/statusline/);
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
