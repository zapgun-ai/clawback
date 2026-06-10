import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for the watch-run skill's error-detection pipeline
// (.skills/watch-run/scripts/watch_run.sh). Two of these bugs fired in
// production during a live 75-min L1 run (a startup crash and a false ERROR on
// a healthy keep-alive ping); a third is a sibling of the same "a number
// matched where it shouldn't" class. The watcher exposes a hidden
// `--errcount <file>` entry point so the detection can be exercised in isolation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(
	__dirname,
	"..",
	".skills",
	"watch-run",
	"scripts",
	"watch_run.sh",
);

let dir;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-watch-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

// Write fixture lines to a file and return the watcher's error count for them.
function errcount(lines) {
	const f = path.join(dir, "fixture.log");
	const body = Array.isArray(lines) ? `${lines.join("\n")}\n` : lines;
	fs.writeFileSync(f, body);
	const out = execFileSync("bash", [SCRIPT, "--errcount", f], {
		encoding: "utf8",
	});
	return Number(out.trim());
}

describe("watch_run error detection — must NOT cry wolf (regression)", () => {
	test("healthy keep-alive ping whose timestamp ms is .429Z is not an error", () => {
		// The exact line that falsely fired ERROR(+1) during the L1 run: a bare
		// `429` in the old regex matched the millisecond field of the timestamp.
		expect(
			errcount(
				"2026-06-03T23:02:25.429Z [info] keep-alive 0f186e52a120… → 200 ping 7 elapsed=1m",
			),
		).toBe(0);
	});

	test("driver HEAD health probe returning 404 [no-route] is ignored", () => {
		expect(
			errcount("2026-06-03T22:47:00.000Z [info] HEAD / → 404 0ms [no-route]"),
		).toBe(0);
	});

	test("a 4-digit count rendered as → 4096 does not match the 3-digit status form", () => {
		// Same bug class as the .429Z incident: a longer number bleeding into the
		// status matcher. The trailing ([^0-9]|$) anchor is what keeps this at 0.
		expect(
			errcount(
				"2026-06-03T22:50:00.000Z [info] turn 3 → 200 ok cache → 4096 tokens",
			),
		).toBe(0);
	});

	test("a line carrying both a .500Z ms and a → 200 status is clean", () => {
		expect(errcount("2026-06-03T23:10:00.500Z [info] turn 5 → 200 ok")).toBe(0);
	});

	test("a file with no error lines returns a clean 0 (no grep -c double-count crash)", () => {
		// The old `grep -c … || echo 0` printed `0\n0` on a no-match file, which
		// crashed the loop's arithmetic. errcount must return a single 0.
		expect(
			errcount([
				"[info] starting",
				"[info] turn 1 → 200",
				"[info] turn 2 → 200",
			]),
		).toBe(0);
	});

	test("a missing file returns 0", () => {
		const out = execFileSync(
			"bash",
			[SCRIPT, "--errcount", path.join(dir, "absent.log")],
			{
				encoding: "utf8",
			},
		);
		expect(Number(out.trim())).toBe(0);
	});
});

describe("watch_run error detection — must NOT go blind (coverage)", () => {
	test("a 529 overloaded during a keep-alive ping is a real error", () => {
		expect(
			errcount("2026-06-03T23:05:00.000Z [info] keep-alive → 529 overloaded"),
		).toBeGreaterThanOrEqual(1);
	});

	test("HTTP 5xx on a real turn is an error", () => {
		expect(
			errcount(
				"2026-06-03T23:06:00.000Z [info] turn 9 → 500 Internal Server Error",
			),
		).toBeGreaterThanOrEqual(1);
	});

	test("a port collision (EADDRINUSE) is an error", () => {
		expect(
			errcount("Error: listen EADDRINUSE: address already in use :::8790"),
		).toBeGreaterThanOrEqual(1);
	});

	test("a python Traceback is an error", () => {
		expect(
			errcount("Traceback (most recent call last):"),
		).toBeGreaterThanOrEqual(1);
	});

	test("an [error] log line is an error", () => {
		expect(
			errcount("2026-06-03T23:07:00.000Z [error] proxy crashed"),
		).toBeGreaterThanOrEqual(1);
	});

	test("counts exactly the failing lines among benign traffic", () => {
		expect(
			errcount([
				"[info] turn 1 → 200 ok",
				"[error] boom",
				"Traceback (most recent call last):",
				"[info] keep-alive → 200 ping 3",
			]),
		).toBe(2);
	});
});
