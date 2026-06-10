import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	detectStatuslineTierConflicts,
	isClawbackStatusline,
	resolveEffectiveStatusline,
	resolveSettingsPath,
	setupStatusline,
	uninstallStatusline,
} from "../src/setup_statusline.js";

let tmp;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-setupstl-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveSettingsPath", () => {
	test("default = $HOME/.claude/settings.json", () => {
		expect(resolveSettingsPath({ env: { HOME: tmp } })).toBe(
			path.join(tmp, ".claude", "settings.json"),
		);
	});

	test("--project = <cwd>/.claude/settings.json", () => {
		expect(
			resolveSettingsPath({
				project: true,
				cwd: tmp,
				env: { HOME: "/dev/null" },
			}),
		).toBe(path.join(tmp, ".claude", "settings.json"));
	});

	test("explicit settingsPath wins over both", () => {
		const explicit = path.join(tmp, "weird", "place.json");
		expect(
			resolveSettingsPath({
				settingsPath: explicit,
				project: true,
				cwd: "/somewhere/else",
				env: { HOME: "/another/place" },
			}),
		).toBe(explicit);
	});

	test("missing $HOME without --project / --settings throws", () => {
		expect(() => resolveSettingsPath({ env: {} })).toThrow(/HOME/);
	});
});

describe("setupStatusline", () => {
	test("creates settings.json with the statusLine block when none exists", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
		});
		expect(r.action).toBe("created");
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.type).toBe("command");
		// PLAN §39 (Phase 1): the curl command now reads CLAWBACK_PROXY_URL /
		// CLAWBACK_SESSION_ID at runtime so it routes to the right per-session
		// endpoint, with `_default` as the fallback that maps to the legacy
		// no-id aggregate path on the server side.
		expect(contents.statusLine.command).toMatch(/curl -sf/);
		expect(contents.statusLine.command).toMatch(/--data-binary @-/);
		// Self-healing transport: `-L` follows clawback's 308 http→https
		// upgrade; `-k` accepts the local self-signed cert. The baked command
		// works whether the proxy is currently serving http or https.
		expect(contents.statusLine.command).toMatch(/curl -sf -L -k /);
		expect(contents.statusLine.command).toMatch(
			/\$\{CLAWBACK_PROXY_URL:-http:\/\/127\.0\.0\.1:8080\}/,
		);
		expect(contents.statusLine.command).toMatch(
			/_proxy\/statusline\/\$\{CLAWBACK_SESSION_ID:-_default\}/,
		);
	});

	test("merges into existing settings.json without losing other keys", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(
			target,
			JSON.stringify({
				model: "claude-opus-4-7",
				permissions: { allow: ["Bash(npm test)"] },
			}),
		);
		const r = setupStatusline({ settingsPath: target });
		expect(r.action).toBe("merged");
		const contents = JSON.parse(fs.readFileSync(target, "utf8"));
		expect(contents.model).toBe("claude-opus-4-7");
		expect(contents.permissions.allow).toEqual(["Bash(npm test)"]);
		expect(contents.statusLine.type).toBe("command");
	});

	test("refuses to overwrite an existing statusLine without --force", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(
			target,
			JSON.stringify({ statusLine: { type: "command", command: "echo hi" } }),
		);
		const r = setupStatusline({ settingsPath: target });
		expect(r.action).toBe("skipped");
		expect(r.previous).toEqual({ type: "command", command: "echo hi" });
		const contents = JSON.parse(fs.readFileSync(target, "utf8"));
		expect(contents.statusLine.command).toBe("echo hi");
	});

	test("--force overwrites an existing statusLine", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(
			target,
			JSON.stringify({ statusLine: { type: "command", command: "echo hi" } }),
		);
		const r = setupStatusline({ settingsPath: target, force: true });
		expect(r.action).toBe("overwrote");
		const contents = JSON.parse(fs.readFileSync(target, "utf8"));
		expect(contents.statusLine.command).toMatch(/_proxy\/statusline/);
		expect(contents.statusLine.command).not.toMatch(/echo hi/);
	});

	test("rewrites bind-only host (0.0.0.0) to loopback so curl works", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			host: "0.0.0.0",
			port: 31337,
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(/http:\/\/127\.0\.0\.1:31337/);
		expect(contents.statusLine.command).not.toMatch(/0\.0\.0\.0/);
	});

	test("respects custom adminPathPrefix", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			adminPathPrefix: "_ctrl",
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(/\/_ctrl\/statusline/);
	});

	test("creates parent .claude directory if missing", () => {
		const target = path.join(tmp, ".claude", "settings.json");
		const r = setupStatusline({ settingsPath: target });
		expect(r.action).toBe("created");
		expect(fs.existsSync(target)).toBe(true);
	});

	test("malformed existing JSON throws a helpful error", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(target, "{not: json,");
		expect(() => setupStatusline({ settingsPath: target })).toThrow(
			/not valid JSON/,
		);
	});

	test("empty settings.json is treated as {} (creates statusLine cleanly)", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(target, "");
		const r = setupStatusline({ settingsPath: target });
		expect(r.action).toBe("merged");
		const contents = JSON.parse(fs.readFileSync(target, "utf8"));
		expect(contents.statusLine.type).toBe("command");
	});

	// `--remote URL` bakes a remote clawback URL as the default in the
	// curl line, so claude sessions launched WITHOUT `clawback claude`
	// (env vars unset) still hit the remote endpoint. The shell expansion
	// preserves per-invocation override via CLAWBACK_PROXY_URL.

	test("--remote bakes a remote URL as the curl default", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			remoteUrl: "http://remoteclawback.ca:8888",
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(
			/\$\{CLAWBACK_PROXY_URL:-http:\/\/remoteclawback\.ca:8888\}/,
		);
		// Local host/port no longer appears in the curl default.
		expect(contents.statusLine.command).not.toMatch(/127\.0\.0\.1/);
	});

	test("--remote strips trailing slash so the default doesn't double up", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			remoteUrl: "http://remoteclawback.ca:8888/",
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(
			/\$\{CLAWBACK_PROXY_URL:-http:\/\/remoteclawback\.ca:8888\}\/_proxy/,
		);
	});

	test("https remote auto-adds curl -k (self-signed-cert ergonomics)", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			remoteUrl: "https://remoteclawback.ca:8888",
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(/curl -sf -L -k /);
	});

	test("http remote does NOT add curl -k", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			remoteUrl: "http://remoteclawback.ca:8888",
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(/curl -sf -L --data-binary/);
		expect(contents.statusLine.command).not.toMatch(/ -k /);
	});

	test("--remote respects adminPathPrefix for the trailing path", () => {
		const r = setupStatusline({
			settingsPath: path.join(tmp, "settings.json"),
			adminPathPrefix: "_ctrl",
			remoteUrl: "http://remoteclawback.ca:8888",
		});
		const contents = JSON.parse(fs.readFileSync(r.targetPath, "utf8"));
		expect(contents.statusLine.command).toMatch(/\/_ctrl\/statusline/);
	});
});

describe("uninstallStatusline", () => {
	test("reports 'missing' when the settings file does not exist", () => {
		const target = path.join(tmp, "settings.json");
		const r = uninstallStatusline({ settingsPath: target });
		expect(r).toEqual({ targetPath: target, action: "missing" });
		expect(fs.existsSync(target)).toBe(false);
	});

	test("reports 'no-statusline' when settings exist but have no statusLine key", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(target, JSON.stringify({ theme: "dark" }));
		const r = uninstallStatusline({ settingsPath: target });
		expect(r.action).toBe("no-statusline");
		expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
			theme: "dark",
		});
	});

	test("strips statusLine while preserving other keys", () => {
		const target = path.join(tmp, "settings.json");
		const before = {
			theme: "dark",
			model: "claude-opus-4-7",
			statusLine: { type: "command", command: "echo hi" },
		};
		fs.writeFileSync(target, JSON.stringify(before));
		const r = uninstallStatusline({ settingsPath: target });
		expect(r.action).toBe("removed");
		expect(r.previous).toEqual({ type: "command", command: "echo hi" });
		const after = JSON.parse(fs.readFileSync(target, "utf8"));
		expect(after).toEqual({ theme: "dark", model: "claude-opus-4-7" });
		expect(after.statusLine).toBeUndefined();
	});

	test("removes the file entirely when statusLine was the only key", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(
			target,
			JSON.stringify({ statusLine: { type: "command", command: "echo hi" } }),
		);
		const r = uninstallStatusline({ settingsPath: target });
		expect(r.action).toBe("removed-file");
		expect(fs.existsSync(target)).toBe(false);
	});

	test("is idempotent (second run after removal reports 'missing')", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(
			target,
			JSON.stringify({ statusLine: { type: "command", command: "echo hi" } }),
		);
		uninstallStatusline({ settingsPath: target });
		const r2 = uninstallStatusline({ settingsPath: target });
		expect(r2.action).toBe("missing");
	});

	test("throws on a malformed JSON file (same shape as setupStatusline)", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(target, "{ not valid json");
		expect(() => uninstallStatusline({ settingsPath: target })).toThrow(
			/not valid JSON/,
		);
	});

	test("throws when top-level is not an object (e.g. an array)", () => {
		const target = path.join(tmp, "settings.json");
		fs.writeFileSync(target, JSON.stringify(["just", "an", "array"]));
		expect(() => uninstallStatusline({ settingsPath: target })).toThrow(
			/not a JSON object/,
		);
	});

	test("--project resolves to <cwd>/.claude/settings.json (mirrors setup)", () => {
		const projectClaude = path.join(tmp, ".claude");
		fs.mkdirSync(projectClaude);
		const target = path.join(projectClaude, "settings.json");
		fs.writeFileSync(
			target,
			JSON.stringify({
				theme: "dark",
				statusLine: { type: "command", command: "echo hi" },
			}),
		);
		const r = uninstallStatusline({
			project: true,
			cwd: tmp,
			env: { HOME: "/dev/null" },
		});
		expect(r.action).toBe("removed");
		expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
			theme: "dark",
		});
	});
});

describe("isClawbackStatusline", () => {
	test("matches a block whose command hits /_proxy/statusline", () => {
		expect(
			isClawbackStatusline({
				type: "command",
				command: "curl -sf http://127.0.0.1:8080/_proxy/statusline/_default",
			}),
		).toBe(true);
	});

	test("matches a block that expands CLAWBACK_PROXY_URL", () => {
		expect(
			isClawbackStatusline({
				type: "command",
				command: "bash -c 'curl \"${CLAWBACK_PROXY_URL:-http://x}/s\"'",
			}),
		).toBe(true);
	});

	test("rejects an unrelated statusLine command", () => {
		expect(isClawbackStatusline({ type: "command", command: "echo hi" })).toBe(
			false,
		);
	});

	test("rejects null / non-object / command-less blocks", () => {
		expect(isClawbackStatusline(null)).toBe(false);
		expect(isClawbackStatusline("string")).toBe(false);
		expect(isClawbackStatusline({ type: "command" })).toBe(false);
		expect(isClawbackStatusline({ command: 42 })).toBe(false);
	});
});

describe("detectStatuslineTierConflicts", () => {
	// The detector scans the *other* standard Claude Code settings tiers
	// after a write. We isolate the user tier (env.HOME) from the project
	// tiers (cwd) by giving each its own subdir under tmp, so a write to
	// one never lands in another's path.
	let userHome;
	let projectDir;

	beforeEach(() => {
		userHome = path.join(tmp, "home");
		projectDir = path.join(tmp, "proj");
		fs.mkdirSync(userHome, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
	});

	const tierPath = {
		user: () => path.join(userHome, ".claude", "settings.json"),
		project: () => path.join(projectDir, ".claude", "settings.json"),
		"project-local": () =>
			path.join(projectDir, ".claude", "settings.local.json"),
	};

	function writeStatusline(p, command) {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify({ statusLine: { type: "command", command } }),
		);
	}

	const CLAWBACK_CMD =
		"curl -sf http://127.0.0.1:8080/_proxy/statusline/_default || true";

	test("flags a HIGHER-precedence clawback block that shadows the write", () => {
		// Write lands on the user tier; a clawback block already sits at the
		// project tier, which Claude Code resolves *over* user — so it shadows.
		writeStatusline(tierPath.project(), CLAWBACK_CMD);
		const r = detectStatuslineTierConflicts({
			targetPath: tierPath.user(),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.writtenTier).toBe("user");
		expect(r.conflicts).toEqual([
			{ tier: "project", path: tierPath.project(), shadows: true },
		]);
	});

	test("flags a LOWER-precedence clawback block as now-redundant", () => {
		// Write lands on the project tier; a stale clawback block sits at the
		// user tier, which project outranks — so the write shadows it.
		writeStatusline(tierPath.user(), CLAWBACK_CMD);
		const r = detectStatuslineTierConflicts({
			targetPath: tierPath.project(),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.writtenTier).toBe("project");
		expect(r.conflicts).toEqual([
			{ tier: "user", path: tierPath.user(), shadows: false },
		]);
	});

	test("project-local shadows a project-tier write", () => {
		writeStatusline(tierPath["project-local"](), CLAWBACK_CMD);
		const r = detectStatuslineTierConflicts({
			targetPath: tierPath.project(),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.writtenTier).toBe("project");
		expect(r.conflicts).toEqual([
			{
				tier: "project-local",
				path: tierPath["project-local"](),
				shadows: true,
			},
		]);
	});

	test("ignores a non-clawback statusLine at another tier", () => {
		writeStatusline(tierPath.project(), "echo hi");
		const r = detectStatuslineTierConflicts({
			targetPath: tierPath.user(),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.writtenTier).toBe("user");
		expect(r.conflicts).toEqual([]);
	});

	test("a malformed settings file at another tier never throws", () => {
		const p = tierPath.project();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "{ not: valid json,");
		expect(() =>
			detectStatuslineTierConflicts({
				targetPath: tierPath.user(),
				cwd: projectDir,
				env: { HOME: userHome },
			}),
		).not.toThrow();
		const r = detectStatuslineTierConflicts({
			targetPath: tierPath.user(),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.conflicts).toEqual([]);
	});

	test("writtenTier is null for an explicit non-standard --settings path", () => {
		// An explicit path that matches no standard tier: precedence is
		// unknown, so any found block reports shadows:null rather than guessing.
		writeStatusline(tierPath.project(), CLAWBACK_CMD);
		const r = detectStatuslineTierConflicts({
			targetPath: path.join(tmp, "weird", "place.json"),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.writtenTier).toBeNull();
		expect(r.conflicts).toEqual([
			{ tier: "project", path: tierPath.project(), shadows: null },
		]);
	});

	test("no conflicts when no other tier holds a clawback block", () => {
		const r = detectStatuslineTierConflicts({
			targetPath: tierPath.user(),
			cwd: projectDir,
			env: { HOME: userHome },
		});
		expect(r.conflicts).toEqual([]);
	});
});

describe("resolveEffectiveStatusline", () => {
	// Same isolation as the conflict detector: the user tier lives under
	// env.HOME, the project tiers under cwd, each its own subdir so a write to
	// one never bleeds into another's path.
	let userHome;
	let projectDir;

	beforeEach(() => {
		userHome = path.join(tmp, "home");
		projectDir = path.join(tmp, "proj");
		fs.mkdirSync(userHome, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
	});

	const tierPath = {
		user: () => path.join(userHome, ".claude", "settings.json"),
		project: () => path.join(projectDir, ".claude", "settings.json"),
		"project-local": () =>
			path.join(projectDir, ".claude", "settings.local.json"),
	};

	function writeStatusline(p, command) {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(
			p,
			JSON.stringify({ statusLine: { type: "command", command } }),
		);
	}

	const CLAWBACK_CMD =
		"curl -sf http://127.0.0.1:8080/_proxy/statusline/_default || true";

	const resolve = () =>
		resolveEffectiveStatusline({ cwd: projectDir, env: { HOME: userHome } });

	test("returns one entry per standard tier in user→project→project-local order", () => {
		const { entries } = resolve();
		expect(entries.map((e) => e.tier)).toEqual([
			"user",
			"project",
			"project-local",
		]);
	});

	test("no statusLine at any tier → effective is null, all entries absent", () => {
		const { entries, effective } = resolve();
		expect(effective).toBeNull();
		expect(entries.every((e) => e.present === false)).toBe(true);
		expect(entries.every((e) => e.isClawback === false)).toBe(true);
		expect(entries.every((e) => e.block === null)).toBe(true);
	});

	test("only the user tier present → user is effective", () => {
		writeStatusline(tierPath.user(), CLAWBACK_CMD);
		const { effective } = resolve();
		expect(effective.tier).toBe("user");
		expect(effective.present).toBe(true);
		expect(effective.isClawback).toBe(true);
	});

	test("highest-rank present tier wins (project-local over project over user)", () => {
		writeStatusline(tierPath.user(), CLAWBACK_CMD);
		writeStatusline(tierPath.project(), CLAWBACK_CMD);
		writeStatusline(tierPath["project-local"](), CLAWBACK_CMD);
		const { effective } = resolve();
		expect(effective.tier).toBe("project-local");
	});

	test("project-local outranks project when user is absent", () => {
		writeStatusline(tierPath.project(), CLAWBACK_CMD);
		writeStatusline(tierPath["project-local"](), CLAWBACK_CMD);
		const { effective } = resolve();
		expect(effective.tier).toBe("project-local");
	});

	test("effective is the active block even when it is NOT clawback's", () => {
		// A stale non-clawback block at the higher tier is what Claude Code
		// runs; resolve must report it (isClawback:false) rather than skipping
		// to the lower clawback block — that's how doctor explains shadowing.
		writeStatusline(tierPath.user(), CLAWBACK_CMD);
		writeStatusline(tierPath.project(), "echo hi");
		const { entries, effective } = resolve();
		expect(effective.tier).toBe("project");
		expect(effective.isClawback).toBe(false);
		const userEntry = entries.find((e) => e.tier === "user");
		expect(userEntry.isClawback).toBe(true);
	});

	test("a malformed settings file is treated as absent and never throws", () => {
		const p = tierPath.project();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "{ not: valid json,");
		writeStatusline(tierPath.user(), CLAWBACK_CMD);
		expect(() => resolve()).not.toThrow();
		const { entries, effective } = resolve();
		expect(effective.tier).toBe("user");
		const projectEntry = entries.find((e) => e.tier === "project");
		expect(projectEntry.present).toBe(false);
		expect(projectEntry.block).toBeNull();
	});

	test("carries the resolved block so callers can inspect the command", () => {
		writeStatusline(tierPath.user(), CLAWBACK_CMD);
		const { effective } = resolve();
		expect(effective.block).toEqual({ type: "command", command: CLAWBACK_CMD });
	});
});
