import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GLOBAL_CONFIG_SUBPATH } from "../src/config.js";
import { parseFrontMatter } from "../src/front_matter.js";
import { initConfig, resolveInitTarget } from "../src/init.js";

let cwd;
let home;
let xdg;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-cwd-"));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-home-"));
	xdg = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-init-xdg-"));
});

afterEach(() => {
	for (const d of [cwd, home, xdg]) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

test("resolveInitTarget defaults to ./CLAWBACK.md (local)", () => {
	const target = resolveInitTarget({ cwd, env: { HOME: home } });
	expect(target).toBe(path.join(cwd, "CLAWBACK.md"));
});

test("resolveInitTarget --global uses XDG when set", () => {
	const target = resolveInitTarget({
		global: true,
		cwd,
		env: { HOME: home, XDG_CONFIG_HOME: xdg },
	});
	expect(target).toBe(path.join(xdg, GLOBAL_CONFIG_SUBPATH));
});

test("resolveInitTarget --global falls back to $HOME/.config", () => {
	const target = resolveInitTarget({
		global: true,
		cwd,
		env: { HOME: home, XDG_CONFIG_HOME: "" },
	});
	expect(target).toBe(path.join(home, ".config", GLOBAL_CONFIG_SUBPATH));
});

test("resolveInitTarget --config wins over --global", () => {
	const explicit = path.join(cwd, "custom.json");
	const target = resolveInitTarget({
		global: true,
		configPath: explicit,
		cwd,
		env: { HOME: home, XDG_CONFIG_HOME: xdg },
	});
	expect(target).toBe(explicit);
});

test("resolveInitTarget rejects --global with --local", () => {
	expect(() =>
		resolveInitTarget({ global: true, local: true, cwd, env: { HOME: home } }),
	).toThrow(/mutually exclusive/);
});

test("initConfig creates ./CLAWBACK.md by default", () => {
	const { targetPath, action, adminToken } = initConfig({
		cwd,
		env: { HOME: home },
	});
	expect(action).toBe("created");
	expect(targetPath).toBe(path.join(cwd, "CLAWBACK.md"));
	const { data: parsed, body } = parseFrontMatter(
		fs.readFileSync(targetPath, "utf8"),
	);
	// Front matter contains only a freshly-minted `adminToken` for
	// LAN-bind safety. Everything else stays at DEFAULTS so changes to
	// those still propagate to existing operators. The human-readable
	// discovery text lives in the markdown body, not a front-matter key.
	expect(Object.keys(parsed).sort()).toEqual(["adminToken"]);
	expect(body).toMatch(/turnLogFile/);
	expect(body).toMatch(/keepAliveModeExtended/);
	expect(body).toMatch(/adminToken/);
	expect(parsed.adminToken).toBe(adminToken);
	// base64url over 32 bytes → 43 chars, [A-Za-z0-9_-].
	expect(parsed.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("initConfig mints a fresh adminToken on every run", () => {
	const a = initConfig({ cwd, env: { HOME: home } });
	fs.rmSync(a.targetPath);
	const b = initConfig({ cwd, env: { HOME: home } });
	expect(a.adminToken).toBeTruthy();
	expect(b.adminToken).toBeTruthy();
	expect(a.adminToken).not.toBe(b.adminToken);
});

test("initConfig respects an explicit adminToken (test seam)", () => {
	const { targetPath, adminToken } = initConfig({
		cwd,
		env: { HOME: home },
		adminToken: "fixed-test-token",
	});
	expect(adminToken).toBe("fixed-test-token");
	const { data: parsed } = parseFrontMatter(
		fs.readFileSync(targetPath, "utf8"),
	);
	expect(parsed.adminToken).toBe("fixed-test-token");
});

test("initConfig chmods the file 0o600 (POSIX only)", () => {
	if (process.platform === "win32") return;
	const { targetPath } = initConfig({ cwd, env: { HOME: home } });
	const mode = fs.statSync(targetPath).mode & 0o777;
	expect(mode).toBe(0o600);
});

test("initConfig creates global path with mkdir -p", () => {
	const { targetPath, action } = initConfig({
		global: true,
		cwd,
		env: { HOME: home, XDG_CONFIG_HOME: xdg },
	});
	expect(action).toBe("created");
	expect(targetPath).toBe(path.join(xdg, GLOBAL_CONFIG_SUBPATH));
	expect(fs.existsSync(targetPath)).toBe(true);
});

test("initConfig refuses to overwrite without --force", () => {
	const target = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(target, JSON.stringify({ port: 9999 }));
	const { action } = initConfig({ cwd, env: { HOME: home } });
	expect(action).toBe("skipped");
	const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
	expect(parsed).toEqual({ port: 9999 });
});

test("initConfig overwrites with --force", () => {
	const target = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(target, JSON.stringify({ port: 9999 }));
	const { action } = initConfig({ force: true, cwd, env: { HOME: home } });
	expect(action).toBe("overwrote");
	const { data: parsed } = parseFrontMatter(fs.readFileSync(target, "utf8"));
	expect(Object.keys(parsed).sort()).toEqual(["adminToken"]);
});

test("initConfig skipped returns adminToken=null (doesn't surface operator's prior secret)", () => {
	const target = path.join(cwd, "CLAWBACK.md");
	fs.writeFileSync(target, JSON.stringify({ adminToken: "user-set" }));
	const { action, adminToken } = initConfig({ cwd, env: { HOME: home } });
	expect(action).toBe("skipped");
	expect(adminToken).toBeNull();
});

test("initConfig writes to explicit --config path", () => {
	const explicit = path.join(cwd, "deep", "nested", "config.json");
	const { targetPath, action } = initConfig({
		configPath: explicit,
		cwd,
		env: { HOME: home },
	});
	expect(action).toBe("created");
	expect(targetPath).toBe(explicit);
	expect(fs.existsSync(explicit)).toBe(true);
});

test("initConfig --global without HOME or XDG_CONFIG_HOME throws", () => {
	expect(() => initConfig({ global: true, cwd, env: {} })).toThrow(
		/cannot resolve global config path/,
	);
});

test("local init in a git repo with no .gitignore creates one with the managed block", () => {
	fs.mkdirSync(path.join(cwd, ".git"));
	const { gitignore } = initConfig({ cwd, env: { HOME: home } });
	expect(gitignore.action).toBe("created");
	expect(gitignore.added).toEqual(["CLAWBACK.md", "data/", "logs/"]);
	const contents = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
	expect(contents).toBe(
		"# Added by `clawback init`\nCLAWBACK.md\ndata/\nlogs/\n",
	);
});

test("local init appends managed block to existing .gitignore lacking trailing newline", () => {
	fs.mkdirSync(path.join(cwd, ".git"));
	const gitignorePath = path.join(cwd, ".gitignore");
	fs.writeFileSync(gitignorePath, "node_modules/\ncoverage/", "utf8");
	const { gitignore } = initConfig({ cwd, env: { HOME: home } });
	expect(gitignore.action).toBe("added");
	expect(gitignore.added).toEqual(["CLAWBACK.md", "data/", "logs/"]);
	const contents = fs.readFileSync(gitignorePath, "utf8");
	expect(contents).toBe(
		"node_modules/\ncoverage/\n# Added by `clawback init`\nCLAWBACK.md\ndata/\nlogs/\n",
	);
});

test("local init appends only missing entries when some are already present", () => {
	fs.mkdirSync(path.join(cwd, ".git"));
	const gitignorePath = path.join(cwd, ".gitignore");
	fs.writeFileSync(gitignorePath, "node_modules/\ndata/\n", "utf8");
	const { gitignore } = initConfig({ cwd, env: { HOME: home } });
	expect(gitignore.action).toBe("added");
	expect(gitignore.added).toEqual(["CLAWBACK.md", "logs/"]);
	const contents = fs.readFileSync(gitignorePath, "utf8");
	expect(contents).toBe(
		"node_modules/\ndata/\n# Added by `clawback init`\nCLAWBACK.md\nlogs/\n",
	);
});

test("local init leaves .gitignore untouched when every managed entry is already present", () => {
	fs.mkdirSync(path.join(cwd, ".git"));
	const gitignorePath = path.join(cwd, ".gitignore");
	const before = "node_modules/\nCLAWBACK.md\ndata/\nlogs/\n";
	fs.writeFileSync(gitignorePath, before, "utf8");
	const { gitignore } = initConfig({ cwd, env: { HOME: home } });
	expect(gitignore.action).toBe("already-present");
	expect(gitignore.added).toEqual([]);
	expect(fs.readFileSync(gitignorePath, "utf8")).toBe(before);
});

test("local init outside a git repo does not touch .gitignore", () => {
	const { gitignore } = initConfig({ cwd, env: { HOME: home } });
	expect(gitignore.action).toBe("skipped-no-repo");
	expect(gitignore.added).toEqual([]);
	expect(fs.existsSync(path.join(cwd, ".gitignore"))).toBe(false);
});

test("global init never touches cwd .gitignore", () => {
	fs.mkdirSync(path.join(cwd, ".git"));
	const { gitignore } = initConfig({
		global: true,
		cwd,
		env: { HOME: home, XDG_CONFIG_HOME: xdg },
	});
	expect(gitignore).toBeNull();
	expect(fs.existsSync(path.join(cwd, ".gitignore"))).toBe(false);
});
