import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	inspectTargets,
	removeTargets,
	resolveCleanTargets,
} from "../src/clean.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cwd;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-clean-"));
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("resolveCleanTargets returns absolute paths for relative config entries", () => {
	const targets = resolveCleanTargets({
		config: {
			stateFile: "data/state.json",
			turnLogFile: "data/turns.ndjson",
			sessionLogDir: "logs",
			logFile: null,
		},
		cwd,
	});
	expect(targets).toEqual([
		path.join(cwd, "data/state.json"),
		path.join(cwd, "data/turns.ndjson"),
		path.join(cwd, "logs"),
	]);
});

test("resolveCleanTargets honors absolute paths verbatim", () => {
	const targets = resolveCleanTargets({
		config: {
			stateFile: "/var/lib/clawback/state.json",
			turnLogFile: null,
			sessionLogDir: null,
			logFile: null,
		},
		cwd,
	});
	expect(targets).toEqual(["/var/lib/clawback/state.json"]);
});

test("resolveCleanTargets includes logFile when set, skips when null", () => {
	const withLog = resolveCleanTargets({
		config: {
			stateFile: "data/state.json",
			turnLogFile: null,
			sessionLogDir: null,
			logFile: "logs/proxy.log",
		},
		cwd,
	});
	expect(withLog).toContain(path.join(cwd, "logs/proxy.log"));

	const noLog = resolveCleanTargets({
		config: {
			stateFile: "data/state.json",
			turnLogFile: null,
			sessionLogDir: null,
			logFile: null,
		},
		cwd,
	});
	expect(noLog).toEqual([path.join(cwd, "data/state.json")]);
});

test("resolveCleanTargets dedupes duplicate paths", () => {
	const targets = resolveCleanTargets({
		config: {
			stateFile: "data/x.json",
			turnLogFile: "data/x.json",
			sessionLogDir: null,
			logFile: null,
		},
		cwd,
	});
	expect(targets).toEqual([path.join(cwd, "data/x.json")]);
});

test("inspectTargets classifies file, dir, and missing entries", () => {
	const filePath = path.join(cwd, "data/state.json");
	const dirPath = path.join(cwd, "logs");
	const gonePath = path.join(cwd, "data/nope.json");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "{}");
	fs.mkdirSync(dirPath);
	const out = inspectTargets([filePath, dirPath, gonePath]);
	expect(out).toEqual([
		{ path: filePath, kind: "file" },
		{ path: dirPath, kind: "dir" },
		{ path: gonePath, kind: null },
	]);
});

test("removeTargets deletes files, recursively deletes dirs, returns the actually-removed list", () => {
	const stateFile = path.join(cwd, "data/state.json");
	const turnFile = path.join(cwd, "data/turns.ndjson");
	const logsDir = path.join(cwd, "logs");
	const sessionLog = path.join(logsDir, "session-a/run.log");
	const missing = path.join(cwd, "data/never.json");

	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	fs.writeFileSync(stateFile, "{}");
	fs.writeFileSync(turnFile, "{}");
	fs.mkdirSync(path.dirname(sessionLog), { recursive: true });
	fs.writeFileSync(sessionLog, "log");

	const removed = removeTargets([stateFile, turnFile, logsDir, missing]);
	expect(removed).toEqual([stateFile, turnFile, logsDir]);
	expect(fs.existsSync(stateFile)).toBe(false);
	expect(fs.existsSync(turnFile)).toBe(false);
	expect(fs.existsSync(logsDir)).toBe(false);
	expect(fs.existsSync(missing)).toBe(false);
});

test("removeTargets tidies emptied parent dirs, leaves non-empty parents alone", () => {
	const stateFile = path.join(cwd, "data/state.json");
	const turnFile = path.join(cwd, "data/turns.ndjson");
	const sentinel = path.join(cwd, "data/operator-notes.md");
	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	fs.writeFileSync(stateFile, "{}");
	fs.writeFileSync(turnFile, "{}");
	removeTargets([stateFile, turnFile]);
	expect(fs.existsSync(path.dirname(stateFile))).toBe(false);

	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	fs.writeFileSync(stateFile, "{}");
	fs.writeFileSync(sentinel, "keep me");
	removeTargets([stateFile]);
	expect(fs.existsSync(sentinel)).toBe(true);
	expect(fs.existsSync(path.dirname(stateFile))).toBe(true);
});

test("CLI: `clawback clean` (no --force) previews without deleting", () => {
	const bin = path.resolve(__dirname, "../bin/clawback.js");
	execFileSync(bin, ["init", "--local"], {
		cwd,
		env: { ...process.env, HOME: cwd },
	});
	fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "data/state.json"), "{}");

	const out = execFileSync(bin, ["clean"], {
		cwd,
		env: { ...process.env, HOME: cwd },
	});
	const stdout = out.toString();
	expect(stdout).toMatch(/would remove/);
	expect(stdout).toMatch(/re-run with --force/);
	expect(fs.existsSync(path.join(cwd, "data/state.json"))).toBe(true);
});

test("CLI: `clawback clean --force` deletes the targets", () => {
	const bin = path.resolve(__dirname, "../bin/clawback.js");
	execFileSync(bin, ["init", "--local"], {
		cwd,
		env: { ...process.env, HOME: cwd },
	});
	fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "data/state.json"), "{}");

	const out = execFileSync(bin, ["clean", "--force"], {
		cwd,
		env: { ...process.env, HOME: cwd },
	});
	expect(out.toString()).toMatch(/removed \d+ entr(y|ies)/);
	expect(fs.existsSync(path.join(cwd, "data/state.json"))).toBe(false);
	// Config file is intentionally preserved by `clawback clean`.
	expect(fs.existsSync(path.join(cwd, "CLAWBACK.md"))).toBe(true);
});

test("CLI: `clawback clean` with nothing on disk says so", () => {
	const bin = path.resolve(__dirname, "../bin/clawback.js");
	execFileSync(bin, ["init", "--local"], {
		cwd,
		env: { ...process.env, HOME: cwd },
	});
	const out = execFileSync(bin, ["clean"], {
		cwd,
		env: { ...process.env, HOME: cwd },
	});
	expect(out.toString()).toMatch(/nothing to remove/);
});
