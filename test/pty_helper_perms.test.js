import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePtySpawnHelperExecutable } from "../src/pty_helper_perms.js";

let root;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-pty-perms-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeHelper(relDir, mode) {
	const dir = path.join(root, relDir);
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, "spawn-helper");
	fs.writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode });
	// writeFileSync mode is subject to umask; force the exact bits so the
	// "already executable / not executable" assertions are deterministic.
	fs.chmodSync(p, mode);
	return p;
}

const isExec = (p) => (fs.statSync(p).mode & 0o111) !== 0;

test("adds the execute bit to a non-executable prebuilt spawn-helper", () => {
	const helper = writeHelper(
		path.join("prebuilds", `${process.platform}-${process.arch}`),
		0o644,
	);
	expect(isExec(helper)).toBe(false);

	const fixed = ensurePtySpawnHelperExecutable({ pkgRoot: root });

	expect(fixed).toEqual([helper]);
	expect(isExec(helper)).toBe(true);
	// Read/write bits are preserved; we only OR in execute.
	expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
});

test("fixes a build/Release spawn-helper (built-from-source layout)", () => {
	const helper = writeHelper(path.join("build", "Release"), 0o644);
	const fixed = ensurePtySpawnHelperExecutable({ pkgRoot: root });
	expect(fixed).toEqual([helper]);
	expect(isExec(helper)).toBe(true);
});

test("leaves an already-executable helper untouched (returns [])", () => {
	const helper = writeHelper(
		path.join("prebuilds", `${process.platform}-${process.arch}`),
		0o755,
	);
	const before = fs.statSync(helper).mode;
	const fixed = ensurePtySpawnHelperExecutable({ pkgRoot: root });
	expect(fixed).toEqual([]);
	expect(fs.statSync(helper).mode).toBe(before);
});

test("no-op when the spawn-helper is absent", () => {
	const fixed = ensurePtySpawnHelperExecutable({ pkgRoot: root });
	expect(fixed).toEqual([]);
});

test("no-op on win32 (conpty has no spawn-helper)", () => {
	// Even with a non-exec helper present, the win32 branch returns early.
	const helper = writeHelper(path.join("build", "Release"), 0o644);
	const fixed = ensurePtySpawnHelperExecutable({
		pkgRoot: root,
		platform: "win32",
	});
	expect(fixed).toEqual([]);
	expect(isExec(helper)).toBe(false);
});

test("targets the platform/arch-specific prebuild dir", () => {
	// A helper for a different arch must NOT be touched; only the running
	// platform-arch dir node-pty would actually load from.
	const otherArch = process.arch === "arm64" ? "x64" : "arm64";
	const other = writeHelper(
		path.join("prebuilds", `${process.platform}-${otherArch}`),
		0o644,
	);
	const mine = writeHelper(
		path.join("prebuilds", `${process.platform}-${process.arch}`),
		0o644,
	);
	const fixed = ensurePtySpawnHelperExecutable({ pkgRoot: root });
	expect(fixed).toEqual([mine]);
	expect(isExec(mine)).toBe(true);
	expect(isExec(other)).toBe(false);
});
