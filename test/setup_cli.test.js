/**
 * CLI-level tests for `clawback setup`. Spawns bin/clawback.js as a
 * subprocess so the assertions cover the actual argument parsing +
 * validation surface the operator hits, not just the underlying
 * setupStatusline() function.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve(
	new URL("../bin/clawback.js", import.meta.url).pathname,
);

function runBin(args, { env = {}, cwd } = {}) {
	return new Promise((resolve) => {
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
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

let cwd;
let homeDir;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-setupcli-cwd-"));
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-setupcli-home-"));
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(homeDir, { recursive: true, force: true });
});

test("`setup --force` without a target exits 2 with a message mentioning claude and copilot", async () => {
	const { code, stderr } = await runBin(["setup", "--force"], {
		cwd,
		env: { HOME: homeDir },
	});
	expect(code).toBe(2);
	// The message has to call out --force AND list both valid targets.
	expect(stderr).toMatch(/--force/);
	expect(stderr).toMatch(/claude/);
	expect(stderr).toMatch(/copilot/);
});

test("`setup` with no target keeps the historical default and writes the statusLine to ~/.claude/settings.json", async () => {
	const { code, stdout } = await runBin(["setup"], {
		cwd,
		env: { HOME: homeDir },
	});
	expect(code).toBe(0);
	expect(stdout).toMatch(/clawback setup claude:/);
	const target = path.join(homeDir, ".claude", "settings.json");
	expect(fs.existsSync(target)).toBe(true);
});

test("`setup claude --force` succeeds and reports the overwrite", async () => {
	// Pre-seed an existing statusLine so --force is meaningful.
	const claudeDir = path.join(homeDir, ".claude");
	fs.mkdirSync(claudeDir, { recursive: true });
	fs.writeFileSync(
		path.join(claudeDir, "settings.json"),
		JSON.stringify({ statusLine: { type: "command", command: "echo old" } }),
	);
	const { code, stdout } = await runBin(["setup", "claude", "--force"], {
		cwd,
		env: { HOME: homeDir },
	});
	expect(code).toBe(0);
	expect(stdout).toMatch(/clawback setup claude: overwrote/);
});

test("`setup copilot` is recognised as a target but explicitly not yet implemented", async () => {
	const { code, stderr } = await runBin(["setup", "copilot"], {
		cwd,
		env: { HOME: homeDir },
	});
	expect(code).toBe(2);
	expect(stderr).toMatch(/copilot/);
	expect(stderr).toMatch(/not yet implemented/);
});

test("`setup bogus` is rejected with an unknown-target message listing the valid set", async () => {
	const { code, stderr } = await runBin(["setup", "bogus"], {
		cwd,
		env: { HOME: homeDir },
	});
	expect(code).toBe(2);
	expect(stderr).toMatch(/unknown target/);
	expect(stderr).toMatch(/claude/);
	expect(stderr).toMatch(/copilot/);
});

test("`setup --help` lists both targets in the help output", async () => {
	const { code, stdout } = await runBin(["setup", "--help"], {
		cwd,
		env: { HOME: homeDir },
	});
	expect(code).toBe(0);
	expect(stdout).toMatch(/claude/);
	expect(stdout).toMatch(/copilot/);
});
