import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, sanitizeSessionFilename } from "../src/logger.js";

let dir;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-logger-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeSessionFilename", () => {
	test("passes through alphanumerics, dot, dash, underscore", () => {
		expect(sanitizeSessionFilename("MY_AGENT-1.session")).toBe(
			"MY_AGENT-1.session",
		);
		expect(sanitizeSessionFilename("abcdef0123456789")).toBe(
			"abcdef0123456789",
		);
	});

	test("replaces unsafe chars with underscore", () => {
		expect(sanitizeSessionFilename("foo/bar:baz qux")).toBe("foo_bar_baz_qux");
	});

	test("returns null for empty / nullish input", () => {
		expect(sanitizeSessionFilename(null)).toBeNull();
		expect(sanitizeSessionFilename(undefined)).toBeNull();
		expect(sanitizeSessionFilename("")).toBeNull();
	});

	test("truncates absurdly long keys", () => {
		const huge = "x".repeat(500);
		expect(sanitizeSessionFilename(huge).length).toBeLessThanOrEqual(128);
	});
});

describe("logger.forSession", () => {
	test("tees session-tagged lines into <sessionLogDir>/<key>.log.txt", async () => {
		const sessionLogDir = path.join(dir, "logs");
		const mainLog = path.join(dir, "main.log");
		const logger = createLogger("info", { file: mainLog, sessionLogDir });

		const sessKey = "abc123def456";
		logger.forSession(sessKey).info("hello from session");
		logger.info("hello from main only");
		await logger.close();

		const sessFile = path.join(sessionLogDir, `${sessKey}.log.txt`);
		expect(fs.existsSync(sessFile)).toBe(true);
		const sessContents = fs.readFileSync(sessFile, "utf8");
		expect(sessContents).toMatch(/hello from session/);
		expect(sessContents).not.toMatch(/hello from main only/);

		const mainContents = fs.readFileSync(mainLog, "utf8");
		expect(mainContents).toMatch(/hello from session/);
		expect(mainContents).toMatch(/hello from main only/);
	});

	test("does nothing per-session when sessionLogDir is null", async () => {
		const mainLog = path.join(dir, "main.log");
		const logger = createLogger("info", {
			file: mainLog,
			sessionLogDir: null,
		});

		logger.forSession("abc").info("x");
		await logger.close();

		const entries = fs.readdirSync(dir);
		// Only main.log should exist; no per-session dir or files.
		expect(entries.includes("logs")).toBe(false);
		expect(fs.readFileSync(mainLog, "utf8")).toMatch(/x/);
	});

	test("respects log-level threshold for per-session writes too", async () => {
		const sessionLogDir = path.join(dir, "logs");
		const mainLog = path.join(dir, "main.log");
		const logger = createLogger("warn", { file: mainLog, sessionLogDir });

		const sessKey = "abc";
		logger.forSession(sessKey).info("info-suppressed");
		logger.forSession(sessKey).warn("warn-kept");
		await logger.close();

		const contents = fs.readFileSync(
			path.join(sessionLogDir, `${sessKey}.log.txt`),
			"utf8",
		);
		expect(contents).not.toMatch(/info-suppressed/);
		expect(contents).toMatch(/warn-kept/);
	});

	test("sanitizes path-mode keys with unsafe chars before opening file", async () => {
		const sessionLogDir = path.join(dir, "logs");
		const mainLog = path.join(dir, "main.log");
		const logger = createLogger("info", { file: mainLog, sessionLogDir });

		logger.forSession("agent/with:slashes").info("stay safe");
		await logger.close();

		const files = fs.readdirSync(sessionLogDir);
		expect(files).toContain("agent_with_slashes.log.txt");
	});

	test("forSession on a session-scoped logger returns the parent's session logger semantics", async () => {
		const sessionLogDir = path.join(dir, "logs");
		const mainLog = path.join(dir, "main.log");
		const logger = createLogger("info", { file: mainLog, sessionLogDir });

		const sub = logger.forSession("first").forSession("second");
		sub.info("crossover");
		await logger.close();

		const secondFile = path.join(sessionLogDir, "second.log.txt");
		expect(fs.existsSync(secondFile)).toBe(true);
		expect(fs.readFileSync(secondFile, "utf8")).toMatch(/crossover/);
	});

	test("close ends both main and per-session streams without throwing", async () => {
		const sessionLogDir = path.join(dir, "logs");
		const mainLog = path.join(dir, "main.log");
		const logger = createLogger("info", { file: mainLog, sessionLogDir });
		logger.forSession("a").info("a-line");
		logger.forSession("b").info("b-line");
		await expect(logger.close()).resolves.not.toThrow();
		// Idempotent.
		await expect(logger.close()).resolves.not.toThrow();
	});
});
