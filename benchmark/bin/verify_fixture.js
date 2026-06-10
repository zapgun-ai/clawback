#!/usr/bin/env node
/**
 * Verify a captured /v1/messages fixture is usable for replay.
 *
 * The replay arm is only faithful if the fixture carries at
 * least one `cache_control` breakpoint: without one, clawback's 1h-TTL
 * rewrite (arm A2) has nothing to rewrite and the headline knob silently
 * becomes a no-op — making absolute replay numbers meaningless. This guard
 * is what lets `scripts/capture_fixture.sh` promote a temp dump to the real
 * fixture only when it actually reproduces Claude Code's cache structure.
 *
 * Prints a one-line summary on success; exits non-zero on bad JSON (2) or
 * zero breakpoints (3).
 *
 * Usage: node benchmark/bin/verify_fixture.js <fixture.json>
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	process.stderr.write("usage: verify_fixture.js <fixture.json>\n");
	process.exit(2);
}

let body;
try {
	body = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
	process.stderr.write(
		`verify_fixture: ${file} is not valid JSON: ${e.message}\n`,
	);
	process.exit(2);
}

let breakpoints = 0;
const countArr = (arr) => {
	if (!Array.isArray(arr)) return;
	for (const x of arr) {
		if (x && typeof x === "object" && x.cache_control) breakpoints++;
	}
};
countArr(body.system);
countArr(body.tools);
if (Array.isArray(body.messages)) {
	for (const m of body.messages) countArr(m?.content);
}
if (body.cache_control) breakpoints++;

const sysDesc = Array.isArray(body.system)
	? `${body.system.length} block(s)`
	: typeof body.system === "string"
		? "string"
		: "none";
const summary =
	`fixture ${file}: ${breakpoints} cache_control breakpoint(s), ` +
	`system=${sysDesc}, tools=${(body.tools || []).length}, ` +
	`model=${body.model ?? "(unset)"}`;

if (breakpoints === 0) {
	process.stderr.write(
		`${summary}\nverify_fixture: NO cache_control breakpoints — the 1h-TTL arm would be a no-op. Recapture from a real Claude Code session.\n`,
	);
	process.exit(3);
}
process.stdout.write(`${summary}\n`);
