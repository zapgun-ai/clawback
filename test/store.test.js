import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/store.js";

let dir;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-store-"));
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

test("upsert creates and preserves prior fields", () => {
	const fp = path.join(dir, "state1.json");
	const store = new SessionStore({ filePath: fp });
	store.upsert("a", () => ({ key: "a", value: 1 }));
	store.upsert("a", (prev) => ({ ...prev, value: 2, added: true }));
	const s = store.get("a");
	expect(s.value).toBe(2);
	expect(s.added).toBe(true);
	expect(s.key).toBe("a");
});

test("delete removes the session", () => {
	const fp = path.join(dir, "state2.json");
	const store = new SessionStore({ filePath: fp });
	store.upsert("a", () => ({ key: "a" }));
	expect(store.has("a")).toBe(true);
	store.delete("a");
	expect(store.has("a")).toBe(false);
});

test("persists to disk and reloads", () => {
	const fp = path.join(dir, "state3.json");
	const a = new SessionStore({ filePath: fp });
	a.upsert("k", () => ({ key: "k", v: 42 }));
	a.flushNow();

	const b = new SessionStore({ filePath: fp });
	expect(b.get("k")).toEqual({ key: "k", v: 42 });
});

test("purgeAll empties the store", () => {
	const fp = path.join(dir, "state4.json");
	const store = new SessionStore({ filePath: fp });
	store.upsert("a", () => ({ key: "a" }));
	store.upsert("b", () => ({ key: "b" }));
	expect(store.purgeAll()).toBe(2);
	expect(store.all()).toEqual([]);
});

test("tolerates missing file", () => {
	const fp = path.join(dir, "does-not-exist.json");
	const store = new SessionStore({ filePath: fp });
	expect(store.all()).toEqual([]);
});

// Audit C1: state.json holds the captured OAuth bearer (session.authHeaders).
// Default umask (022) would leave it world-readable on POSIX, exposing the
// secret to any local user / process running as a different uid.
test("flushNow writes state.json with 0600 (owner-only)", () => {
	// Skipped on platforms where POSIX modes don't apply.
	if (process.platform === "win32") return;
	const fp = path.join(dir, "state-perms.json");
	const store = new SessionStore({ filePath: fp });
	store.upsert("k", () => ({ key: "k", v: 1 }));
	store.flushNow();
	const mode = fs.statSync(fp).mode & 0o777;
	expect(mode).toBe(0o600);
});

test("flushNow chmod-tightens a pre-existing 0644 state.json", () => {
	if (process.platform === "win32") return;
	const fp = path.join(dir, "state-upgrade.json");
	// Simulate an older clawback that wrote 0644 — the chmod-after-rename
	// pass in flushNow should clamp the inherited mode on upgrade.
	fs.writeFileSync(fp, JSON.stringify({ version: 1, sessions: {} }), {
		mode: 0o644,
	});
	fs.chmodSync(fp, 0o644);
	const store = new SessionStore({ filePath: fp });
	store.upsert("k", () => ({ key: "k", v: 2 }));
	store.flushNow();
	const mode = fs.statSync(fp).mode & 0o777;
	expect(mode).toBe(0o600);
});
