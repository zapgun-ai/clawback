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
	// Loopback + plain HTTP by design: the overlay no longer forces
	// host=0.0.0.0 / selfSign (those auto-enabled HTTPS with a self-signed
	// cert — a security warning on the first screen). Only the cache knob.
	expect(result.init.overlaidKeys.sort()).toEqual(["keepAliveModeExtended"]);
	// initConfig still mints a token on a fresh create.
	expect(result.init.adminTokenMinted).toBe(true);

	const { data: parsed, body } = parseFrontMatter(
		fs.readFileSync(result.init.targetPath, "utf8"),
	);
	expect(parsed.keepAliveModeExtended).toBe(true);
	// No host override → loadConfig defaults to the loopback bind, which
	// does NOT auto-enable TLS. And no selfSign is written.
	expect(parsed.host).toBeUndefined();
	expect(parsed.selfSign).toBeUndefined();
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
	// Only keepAliveModeExtended is overlaid now; the operator's host is left
	// as-is and selfSign is no longer forced.
	expect(result.init.overlaidKeys.sort()).toEqual(["keepAliveModeExtended"]);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	// Operator's own host choice is preserved untouched...
	expect(reread.host).toBe("0.0.0.0");
	expect(reread.keepAliveModeExtended).toBe(true);
	// ...and quickstart did not inject selfSign.
	expect(reread.selfSign).toBeUndefined();
});

test("runQuickstart with --force overwrites existing config", () => {
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ host: "old" }));

	const result = runQuickstart({ cwd, env: { HOME: home }, force: true });
	expect(result.init.action).toBe("overwrote");
	expect(result.init.adminTokenMinted).toBe(true);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	// Force wipes back to the stub, then default-good is overlaid: the prior
	// `host: "old"` is gone and nothing replaces it, so the loopback DEFAULT
	// governs the bind (no auto-TLS, no cert warning).
	expect(reread.host).toBeUndefined();
	expect(reread.keepAliveModeExtended).toBe(true);
	// A fresh token is minted on overwrite.
	expect(reread.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("applyDefaultGoodOverlay overlays only keepAliveModeExtended and preserves operator keys", () => {
	// Pre-existing operator config with no adminToken. The overlay adds
	// keepAliveModeExtended and mints a token in-place (so a later widen to a
	// non-loopback bind stays paired with a shared secret), but does NOT
	// force host / selfSign — quickstart is loopback + plain HTTP. The
	// operator's other keys (port=9999) are preserved.
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ port: 9999 }));

	const result = applyDefaultGoodOverlay(cfgPath);
	expect(result.overlaidKeys.sort()).toEqual(["keepAliveModeExtended"]);
	expect(result.adminTokenMinted).toBe(true);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	// No host / selfSign injected → loopback default governs (no auto-TLS).
	expect(reread.host).toBeUndefined();
	expect(reread.selfSign).toBeUndefined();
	expect(reread.keepAliveModeExtended).toBe(true);
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

test("quickstart's generated config loads as a loopback HTTP bind (no auto-TLS, no cert warning)", () => {
	// quickstart is loopback + plain HTTP by design: the dashboard opens at
	// http://127.0.0.1:… with no self-signed-cert browser warning. The
	// generated config must therefore load WITHOUT auto-enabling TLS.
	runQuickstart({ cwd, env: { HOME: home } });

	const env = { HOME: home, XDG_CONFIG_HOME: "" };
	let loaded;
	expect(() => {
		loaded = loadConfig({ cwd, env });
	}).not.toThrow();
	const { config } = loaded;
	// Loopback default → no open-network auto-enable → plain HTTP.
	expect(config.host).toBe("127.0.0.1");
	expect(config.tls).toBe(false);
	expect(config._tlsAutoEnabled).toBeUndefined();
	// The core invariant still holds: never non-loopback AND tokenless. Here
	// it's satisfied by the loopback bind (admin auth is loopback-exempt).
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
