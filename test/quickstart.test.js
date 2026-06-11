import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { parseFrontMatter, stringifyFrontMatter } from "../src/front_matter.js";
import { applyDefaultGoodOverlay, runQuickstart } from "../src/quickstart.js";

let cwd;
let home;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-quickstart-cwd-"));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-quickstart-home-"));
});

afterEach(() => {
	for (const d of [cwd, home]) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

test("runQuickstart creates CLAWBACK.md with default-good overlay when absent", () => {
	const result = runQuickstart({
		cwd,
		env: { HOME: home },
	});
	expect(result.init.action).toBe("created");
	expect(result.init.targetPath).toBe(path.join(cwd, "CLAWBACK.md"));
	expect(result.init.overlaidKeys.sort()).toEqual(
		["host", "selfSign", "keepAliveModeExtended"].sort(),
	);
	expect(result.init.adminTokenMinted).toBe(true);

	const { data: parsed, body } = parseFrontMatter(
		fs.readFileSync(result.init.targetPath, "utf8"),
	);
	expect(parsed.keepAliveModeExtended).toBe(true);
	// LAN bind is safe because adminToken is auto-minted at the same time.
	expect(parsed.host).toBe("0.0.0.0");
	// 0.0.0.0 triggers open-network TLS auto-enable; selfSign lets the
	// proxy mint a cert at startup instead of refusing to boot.
	expect(parsed.selfSign).toBe(true);
	// The init.js discovery doc-block (markdown body after the fence) is
	// preserved verbatim through the overlay rewrite.
	expect(body).toMatch(/turnLogFile/);
	// adminToken from init.js initConfig is preserved.
	expect(parsed.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("runQuickstart wires the statusline at ~/.claude/settings.json", () => {
	const result = runQuickstart({
		cwd,
		env: { HOME: home },
	});
	expect(result.setup.action).toBe("created");
	expect(result.setup.targetPath).toBe(
		path.join(home, ".claude", "settings.json"),
	);
	const parsed = JSON.parse(fs.readFileSync(result.setup.targetPath, "utf8"));
	expect(parsed.statusLine).toBeDefined();
	expect(parsed.statusLine.type).toBe("command");
	expect(parsed.statusLine.command).toMatch(/_proxy\/statusline/);
});

test("runQuickstart with --project writes statusline to project scope", () => {
	const result = runQuickstart({
		cwd,
		env: { HOME: home },
		project: true,
	});
	expect(result.setup.targetPath).toBe(
		path.join(cwd, ".claude", "settings.json"),
	);
});

test("runQuickstart is idempotent: re-running preserves operator's choices", () => {
	runQuickstart({ cwd, env: { HOME: home } });

	// User edits CLAWBACK.md to turn off keepAliveModeExtended, keeping
	// the markdown body intact like a real front-matter edit would.
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	const { data: parsed, body } = parseFrontMatter(
		fs.readFileSync(cfgPath, "utf8"),
	);
	parsed.keepAliveModeExtended = false;
	fs.writeFileSync(cfgPath, stringifyFrontMatter(parsed, body));

	// Re-running quickstart should NOT clobber that.
	const result = runQuickstart({ cwd, env: { HOME: home } });
	expect(result.init.action).toBe("skipped");
	expect(result.init.overlaidKeys).toEqual([]);
	// On skipped runs we don't re-mint or re-surface the operator's token.
	expect(result.init.adminTokenMinted).toBe(false);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	expect(reread.keepAliveModeExtended).toBe(false);
});

test("runQuickstart re-overlays default-good when config exists but key absent", () => {
	// Operator has an existing CLAWBACK.md without keepAliveModeExtended.
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ host: "0.0.0.0" }));

	const result = runQuickstart({ cwd, env: { HOME: home } });
	expect(result.init.action).toBe("defaults-overlaid");
	// host already present, so only selfSign + keepAliveModeExtended land.
	expect(result.init.overlaidKeys.sort()).toEqual(
		["keepAliveModeExtended", "selfSign"].sort(),
	);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	expect(reread.host).toBe("0.0.0.0");
	expect(reread.keepAliveModeExtended).toBe(true);
	expect(reread.selfSign).toBe(true);
});

test("runQuickstart with --force overwrites existing config", () => {
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ host: "old" }));

	const result = runQuickstart({ cwd, env: { HOME: home }, force: true });
	expect(result.init.action).toBe("overwrote");
	expect(result.init.adminTokenMinted).toBe(true);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	// Force wipes back to the stub, then default-good is overlaid:
	// the prior `host: "old"` is gone and the LAN-default takes its place.
	expect(reread.host).toBe("0.0.0.0");
	expect(reread.keepAliveModeExtended).toBe(true);
	// A fresh token is minted on overwrite.
	expect(reread.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("applyDefaultGoodOverlay mints an adminToken so host=0.0.0.0 can land on a tokenless config", () => {
	// Pre-existing operator config with no adminToken. The overlay mints
	// a token in-place so the LAN-bind safety gate is satisfied, then
	// applies host=0.0.0.0. The operator's other keys (port=9999) are
	// preserved.
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ port: 9999 }));

	const result = applyDefaultGoodOverlay(cfgPath);
	expect(result.overlaidKeys.sort()).toEqual(
		["host", "selfSign", "keepAliveModeExtended"].sort(),
	);
	expect(result.adminTokenMinted).toBe(true);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	expect(reread.host).toBe("0.0.0.0");
	expect(reread.keepAliveModeExtended).toBe(true);
	expect(reread.selfSign).toBe(true);
	expect(reread.port).toBe(9999);
	expect(reread.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("applyDefaultGoodOverlay returns empty overlaidKeys when all defaults present", () => {
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(
		cfgPath,
		stringifyFrontMatter({
			keepAliveModeExtended: false,
			host: "127.0.0.1",
			selfSign: false,
			adminToken: "a".repeat(43),
		}),
	);
	const result = applyDefaultGoodOverlay(cfgPath);
	expect(result.overlaidKeys).toEqual([]);
	expect(result.adminTokenMinted).toBe(false);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	// Operator's explicit choices (including host) survive untouched.
	expect(reread.keepAliveModeExtended).toBe(false);
	expect(reread.host).toBe("127.0.0.1");
});

test("quickstart's generated config loads through the real security gate (default-secure)", () => {
	// The overlay opens host=0.0.0.0, which loadConfig.validate refuses
	// UNLESS an adminToken is set. This ties the quickstart output to the
	// actual gate: if a future change ever opened the bind without minting
	// a token, loadConfig would throw here instead of silently shipping an
	// unauthenticated LAN-reachable proxy.
	runQuickstart({ cwd, env: { HOME: home } });

	const env = { HOME: home, XDG_CONFIG_HOME: "" };
	let loaded;
	expect(() => {
		loaded = loadConfig({ cwd, env });
	}).not.toThrow();
	const { config } = loaded;
	// LAN bind is paired with a high-entropy shared secret...
	expect(config.host).toBe("0.0.0.0");
	expect(config.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
	// ...and the open-network bind auto-enabled TLS.
	expect(config.tls).toBe(true);
	// The core invariant, stated directly: never non-loopback AND tokenless.
	const isLoopback =
		config.host === "127.0.0.1" ||
		config.host === "::1" ||
		config.host === "localhost" ||
		config.host.startsWith("127.");
	expect(isLoopback || Boolean(config.adminToken)).toBe(true);
});

test("quickstart rotates the adminToken: independent installs get distinct tokens", () => {
	const cwd2 = fs.mkdtempSync(
		path.join(os.tmpdir(), "clawback-quickstart-cwd2-"),
	);
	try {
		const a = runQuickstart({ cwd, env: { HOME: home } });
		const b = runQuickstart({ cwd: cwd2, env: { HOME: home } });
		expect(a.init.adminTokenMinted).toBe(true);
		expect(b.init.adminTokenMinted).toBe(true);
		const tokenA = parseFrontMatter(fs.readFileSync(a.init.targetPath, "utf8"))
			.data.adminToken;
		const tokenB = parseFrontMatter(fs.readFileSync(b.init.targetPath, "utf8"))
			.data.adminToken;
		expect(tokenA).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(tokenB).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(tokenA).not.toBe(tokenB);
	} finally {
		fs.rmSync(cwd2, { recursive: true, force: true });
	}
});

test("runQuickstart re-runs setup when a FOREIGN statusLine occupies the target tier (setup not yet run)", () => {
	// A developer who already uses Claude Code with their own custom
	// statusline installs clawback and runs quickstart. Before the fix,
	// setupStatusline refused to overwrite ANY pre-existing statusLine
	// without --force, so quickstart reported success while clawback's
	// metrics statusline was silently never wired. "Setup hasn't been run
	// yet" (clawback isn't the effective block) must trigger the wire.
	const settingsPath = path.join(home, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(
		settingsPath,
		`${JSON.stringify(
			{
				statusLine: { type: "command", command: "echo my-custom-statusline" },
				otherKey: 42,
			},
			null,
			2,
		)}\n`,
	);

	const result = runQuickstart({ cwd, env: { HOME: home } });

	// clawback's statusline is now wired...
	const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	expect(parsed.statusLine.command).toMatch(/_proxy\/statusline/);
	// ...the operator's other settings are preserved (merge, not clobber)...
	expect(parsed.otherKey).toBe(42);
	// ...and quickstart reports that it displaced a non-clawback block, so
	// the CLI can surface what was replaced + how to restore it.
	expect(result.setup.action).toBe("overwrote");
	expect(result.setup.replacedForeign).toBe(true);
	expect(result.setup.previous).toEqual({
		type: "command",
		command: "echo my-custom-statusline",
	});
});

test("runQuickstart leaves an already-effective clawback statusline untouched (idempotent)", () => {
	// First run wires clawback's statusline.
	runQuickstart({ cwd, env: { HOME: home } });
	const settingsPath = path.join(home, ".claude", "settings.json");
	const before = fs.readFileSync(settingsPath, "utf8");

	// Second run must NOT rewrite it — clawback is already the effective
	// block, so setup is genuinely already done. (Guards against the
	// re-run logic over-firing and churning the file every quickstart.)
	const result = runQuickstart({ cwd, env: { HOME: home } });
	expect(result.setup.action).toBe("skipped");
	expect(result.setup.replacedForeign).toBe(false);
	expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
});

test("runQuickstart reports shadowedBy when a higher-precedence foreign block defeats the wire", () => {
	// Operator keeps a custom statusline at the project tier
	// (<cwd>/.claude/settings.json, rank 2). quickstart defaults to the
	// user tier (rank 1), so even after a successful wire the project
	// block shadows it and the statusline stays dark. Report that rather
	// than claim success.
	const projectSettings = path.join(cwd, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
	fs.writeFileSync(
		projectSettings,
		`${JSON.stringify(
			{ statusLine: { type: "command", command: "echo project-custom" } },
			null,
			2,
		)}\n`,
	);

	const result = runQuickstart({ cwd, env: { HOME: home } });

	// The user-tier wire happened...
	expect(result.setup.action).not.toBe("skipped");
	const userSettings = JSON.parse(
		fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
	);
	expect(userSettings.statusLine.command).toMatch(/_proxy\/statusline/);
	// ...but a higher-precedence foreign block still wins; surface it.
	expect(result.setup.shadowedBy).toEqual({
		tier: "project",
		path: projectSettings,
	});
});

test("applyDefaultGoodOverlay rejects an unparseable config (not front matter)", () => {
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	// A fenceless JSON blob is not a clawback config; the overlay must
	// refuse rather than clobber whatever the operator actually has.
	fs.writeFileSync(cfgPath, JSON.stringify(["a", "b"]));
	expect(() => applyDefaultGoodOverlay(cfgPath)).toThrow(
		/must open with a YAML front-matter fence/,
	);
});
