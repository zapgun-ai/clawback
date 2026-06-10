import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("runQuickstart creates CLAWBACK.md with the loopback default-good overlay when absent", () => {
	const result = runQuickstart({
		cwd,
		env: { HOME: home },
	});
	expect(result.init.action).toBe("created");
	expect(result.init.targetPath).toBe(path.join(cwd, "CLAWBACK.md"));
	// Default is loopback HTTP: host + keepAliveModeExtended, and NO selfSign
	// (no TLS on loopback → no cert → no browser warning, working statusline).
	expect(result.init.overlaidKeys.sort()).toEqual(
		["host", "keepAliveModeExtended"].sort(),
	);
	expect(result.init.adminTokenMinted).toBe(true);

	const { data: parsed, body } = parseFrontMatter(
		fs.readFileSync(result.init.targetPath, "utf8"),
	);
	expect(parsed.keepAliveModeExtended).toBe(true);
	expect(parsed.host).toBe("127.0.0.1");
	// No TLS material is configured for the loopback default.
	expect(parsed.selfSign).toBeUndefined();
	// The init.js discovery doc-block (markdown body after the fence) is
	// preserved verbatim through the overlay rewrite.
	expect(body).toMatch(/turnLogFile/);
	// adminToken from init.js initConfig is preserved (loopback-harmless,
	// keeps the file attach-ready).
	expect(parsed.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("runQuickstart --lan overlays the 0.0.0.0 + selfSign LAN posture", () => {
	const result = runQuickstart({
		cwd,
		env: { HOME: home },
		lan: true,
	});
	expect(result.init.overlaidKeys.sort()).toEqual(
		["host", "selfSign", "keepAliveModeExtended"].sort(),
	);
	const { data: parsed } = parseFrontMatter(
		fs.readFileSync(result.init.targetPath, "utf8"),
	);
	// LAN bind is safe because adminToken is auto-minted at the same time.
	expect(parsed.host).toBe("0.0.0.0");
	// 0.0.0.0 triggers open-network TLS auto-enable; selfSign lets the proxy
	// mint a cert at startup as a fallback when mkcert isn't available.
	expect(parsed.selfSign).toBe(true);
	expect(parsed.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("runQuickstart creates .gitignore (with the managed entries) even outside a git repo", () => {
	// cwd is a bare temp dir — no .git/. quickstart still pre-ignores the
	// secret-bearing CLAWBACK.md so it can't be committed later.
	expect(fs.existsSync(path.join(cwd, ".gitignore"))).toBe(false);
	const result = runQuickstart({ cwd, env: { HOME: home } });
	expect(result.gitignore.action).toBe("created");
	expect(result.gitignore.added).toEqual(["CLAWBACK.md", "data/", "logs/"]);
	const contents = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
	expect(contents).toMatch(/CLAWBACK\.md/);
	expect(contents).toMatch(/data\//);
	expect(contents).toMatch(/logs\//);
});

test("runQuickstart appends to an existing .gitignore without clobbering it", () => {
	fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");
	const result = runQuickstart({ cwd, env: { HOME: home } });
	expect(result.gitignore.action).toBe("added");
	const contents = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
	expect(contents).toMatch(/node_modules\//);
	expect(contents).toMatch(/CLAWBACK\.md/);
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
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ host: "127.0.0.1" }));

	const result = runQuickstart({ cwd, env: { HOME: home } });
	expect(result.init.action).toBe("defaults-overlaid");
	// host already present, so only keepAliveModeExtended lands (the loopback
	// default overlay doesn't carry selfSign — there's no TLS to provision).
	expect(result.init.overlaidKeys.sort()).toEqual(["keepAliveModeExtended"]);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	expect(reread.host).toBe("127.0.0.1");
	expect(reread.keepAliveModeExtended).toBe(true);
	expect(reread.selfSign).toBeUndefined();
});

test("runQuickstart with --force overwrites existing config", () => {
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ host: "old" }));

	const result = runQuickstart({ cwd, env: { HOME: home }, force: true });
	expect(result.init.action).toBe("overwrote");
	expect(result.init.adminTokenMinted).toBe(true);

	const reread = parseFrontMatter(fs.readFileSync(cfgPath, "utf8")).data;
	// Force wipes back to the stub, then default-good is overlaid:
	// the prior `host: "old"` is gone and the loopback default takes its place.
	expect(reread.host).toBe("127.0.0.1");
	expect(reread.keepAliveModeExtended).toBe(true);
	// A fresh token is minted on overwrite.
	expect(reread.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("applyDefaultGoodOverlay({lan}) mints an adminToken so host=0.0.0.0 can land on a tokenless config", () => {
	// Pre-existing operator config with no adminToken. The LAN overlay mints
	// a token in-place so the LAN-bind safety gate is satisfied, then
	// applies host=0.0.0.0. The operator's other keys (port=9999) are
	// preserved.
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(cfgPath, stringifyFrontMatter({ port: 9999 }));

	const result = applyDefaultGoodOverlay(cfgPath, { lan: true });
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

test("applyDefaultGoodOverlay rejects an unparseable config (not front matter)", () => {
	const cfgPath = path.join(cwd, "CLAWBACK.md");
	// A fenceless JSON blob is not a clawback config; the overlay must
	// refuse rather than clobber whatever the operator actually has.
	fs.writeFileSync(cfgPath, JSON.stringify(["a", "b"]));
	expect(() => applyDefaultGoodOverlay(cfgPath)).toThrow(
		/must open with a YAML front-matter fence/,
	);
});
