import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TurnLog, createTurnLog } from "../src/turn_log.js";

function tmpFile(name) {
	return path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "clawback-turnlog-")),
		name,
	);
}

function readLines(file) {
	const raw = fs.readFileSync(file, "utf8");
	return raw.split("\n").filter((l) => l.length > 0);
}

describe("TurnLog", () => {
	test("disabled when filePath is null", () => {
		const log = new TurnLog({ filePath: null });
		expect(log.enabled).toBe(false);
		log.write({ ts: "x" });
		expect(log.writeCount).toBe(0);
	});

	test("writes one NDJSON line per record", async () => {
		const file = tmpFile("turns.ndjson");
		const log = createTurnLog({ filePath: file });
		log.write({ ts: "2026-04-21T00:00:00Z", foo: 1 });
		log.write({ ts: "2026-04-21T00:00:01Z", foo: 2 });
		log.close();
		await new Promise((r) => setTimeout(r, 10));
		const lines = readLines(file);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ foo: 1 });
		expect(JSON.parse(lines[1])).toMatchObject({ foo: 2 });
	});

	test("creates parent directory if missing", async () => {
		const file = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "clawback-turnlog-dir-")),
			"nested/sub/turns.ndjson",
		);
		const log = createTurnLog({ filePath: file });
		log.write({ x: 1 });
		log.close();
		await new Promise((r) => setTimeout(r, 10));
		expect(fs.existsSync(file)).toBe(true);
	});

	test("appends rather than overwriting on re-open", async () => {
		const file = tmpFile("turns.ndjson");
		let log = createTurnLog({ filePath: file });
		log.write({ a: 1 });
		log.close();
		await new Promise((r) => setTimeout(r, 10));

		log = createTurnLog({ filePath: file });
		log.write({ a: 2 });
		log.close();
		await new Promise((r) => setTimeout(r, 10));

		const lines = readLines(file);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toEqual({ a: 1 });
		expect(JSON.parse(lines[1])).toEqual({ a: 2 });
	});

	test("close is idempotent", () => {
		const file = tmpFile("turns.ndjson");
		const log = createTurnLog({ filePath: file });
		log.write({ a: 1 });
		log.close();
		expect(() => log.close()).not.toThrow();
	});
});
