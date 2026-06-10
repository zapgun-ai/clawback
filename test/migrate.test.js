import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../src/canonicalize.js";
import { migrateStoredSessions } from "../src/migrate.js";
import { SessionStore } from "../src/store.js";

let dir;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-migrate-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function captureLogger() {
	const lines = [];
	const log = (level) => (msg) => lines.push({ level, msg });
	return {
		lines,
		debug: log("debug"),
		info: log("info"),
		warn: log("warn"),
		error: log("error"),
	};
}

function rawHashKey(system, tools) {
	const input = canonicalize({ system, tools: tools ?? null });
	return crypto.createHash("sha256").update(input).digest("hex");
}

function makeStore(sessions = []) {
	const stateFile = path.join(dir, "state.json");
	const initialJson = {
		version: 1,
		sessions: Object.fromEntries(sessions.map((s) => [s.key, s])),
	};
	fs.writeFileSync(stateFile, JSON.stringify(initialJson));
	return new SessionStore({ filePath: stateFile, logger: { warn: () => {} } });
}

describe("migrateStoredSessions (PLAN §9 load-time re-strip + merge)", () => {
	test("collapses two cch-only fragments into one", () => {
		const tools = [{ name: "Bash" }];
		const sysA = "billing cch=aaaaa; rest is stable.";
		const sysB = "billing cch=bbbbb; rest is stable.";

		const sessions = [
			{
				key: rawHashKey(sysA, tools),
				mode: "hash",
				system: sysA,
				tools,
				createdAt: "2026-04-27T10:00:00Z",
				lastActivity: "2026-04-27T10:00:00Z",
				keepAliveCount: 3,
				keepAliveTokensUsed: 3,
				keepAliveFailures: 0,
			},
			{
				key: rawHashKey(sysB, tools),
				mode: "hash",
				system: sysB,
				tools,
				createdAt: "2026-04-27T10:05:00Z",
				lastActivity: "2026-04-27T10:30:00Z",
				keepAliveCount: 4,
				keepAliveTokensUsed: 4,
				keepAliveFailures: 1,
			},
		];

		const store = makeStore(sessions);
		const logger = captureLogger();
		const result = migrateStoredSessions({
			store,
			config: { stripEphemeralFromSystem: true },
			logger,
		});

		expect(result).toEqual({ in: 2, out: 1, merged: 1 });
		expect(store.all().length).toBe(1);
		const merged = store.all()[0];
		// Counters summed.
		expect(merged.keepAliveCount).toBe(7);
		expect(merged.keepAliveTokensUsed).toBe(7);
		expect(merged.keepAliveFailures).toBe(1);
		// Most-recent lastActivity wins as the base.
		expect(merged.lastActivity).toBe("2026-04-27T10:30:00Z");
		// System now contains the placeholder.
		expect(merged.system).toContain("cch=<CCH>");
		expect(merged.system).not.toMatch(/cch=aaaaa/);
		expect(merged.system).not.toMatch(/cch=bbbbb/);
		// Logger announced the migration.
		expect(logger.lines.some((l) => l.msg.includes("PLAN §9 migration"))).toBe(
			true,
		);
	});

	test("no-op when stripEphemeralFromSystem is false", () => {
		const tools = [{ name: "Bash" }];
		const sysA = "billing cch=aaaaa; rest";
		const sysB = "billing cch=bbbbb; rest";
		const store = makeStore([
			{ key: rawHashKey(sysA, tools), mode: "hash", system: sysA, tools },
			{ key: rawHashKey(sysB, tools), mode: "hash", system: sysB, tools },
		]);
		const result = migrateStoredSessions({
			store,
			config: { stripEphemeralFromSystem: false },
			logger: captureLogger(),
		});
		expect(result.merged).toBe(0);
		expect(store.all().length).toBe(2);
	});

	test("path-mode sessions are not re-keyed (key independent of system)", () => {
		const sysA = "billing cch=aaaaa; rest";
		const session = {
			key: "my-agent-id",
			mode: "path",
			system: sysA,
			tools: [],
			lastActivity: "2026-04-27T10:00:00Z",
		};
		const store = makeStore([session]);
		const before = JSON.stringify(store.all()[0]);
		migrateStoredSessions({
			store,
			config: { stripEphemeralFromSystem: true },
			logger: captureLogger(),
		});
		expect(store.has("my-agent-id")).toBe(true);
		expect(JSON.stringify(store.all()[0])).toBe(before);
	});

	test("idempotent — re-running on already-migrated state changes nothing", () => {
		const tools = [{ name: "Bash" }];
		const sys = "billing cch=aaaaa; rest";
		const store = makeStore([
			{
				key: rawHashKey(sys, tools),
				mode: "hash",
				system: sys,
				tools,
			},
		]);
		const config = { stripEphemeralFromSystem: true };
		migrateStoredSessions({ store, config, logger: captureLogger() });
		const afterFirst = JSON.stringify(store.all());
		migrateStoredSessions({ store, config, logger: captureLogger() });
		expect(JSON.stringify(store.all())).toBe(afterFirst);
	});

	test("a session with no ephemeral content is left untouched", () => {
		const tools = [{ name: "Bash" }];
		const sys = "Plain stable system prompt with nothing volatile.";
		const key = rawHashKey(sys, tools);
		const store = makeStore([
			{
				key,
				mode: "hash",
				system: sys,
				tools,
				keepAliveCount: 5,
			},
		]);
		const result = migrateStoredSessions({
			store,
			config: { stripEphemeralFromSystem: true },
			logger: captureLogger(),
		});
		expect(result).toEqual({ in: 1, out: 1, merged: 0 });
		expect(store.has(key)).toBe(true);
		expect(store.get(key).keepAliveCount).toBe(5);
	});
});
