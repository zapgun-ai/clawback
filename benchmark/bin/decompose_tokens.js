#!/usr/bin/env node
// Decompose a run's per-arm token usage into the four billable-relevant
// buckets — fresh input, 5m cache-creation, 1h cache-creation, and cache-read
// — so a "regression" in the headline billable number can be ATTRIBUTED to a
// mechanism instead of guessed at.
//
// The headline (analyze.js) reports billable = input + cache_creation as one
// number. That collapses two very different costs: a 5m creation (what
// passthrough pays) and a 1h creation (the 1h-TTL knob's up-front premium,
// which only pays back across a >5-min eviction gap). On a tight loop the 1h
// premium is pure cost with no eviction to amortize against, so a stack that
// bundles 1h-TTL will look like a regression there — EXPECTEDLY. This tool
// shows that split directly: if an arm's excess billable is all 1h-creation
// and its cache-read matches the baseline, the "regression" is the 1h premium,
// not real lost quota.
//
// Reads turns.<label>.ndjson from a run dir (mirrors plot.js --in). Keep-alive
// ping records (arm ~ /ping/) are counted separately, never folded into the
// per-turn billable. Records with no usage (count_tokens, errors) are skipped.
//
// Usage: node benchmark/bin/decompose_tokens.js --in runs/<dir>
//        node benchmark/bin/decompose_tokens.js runs/<dir>/turns.A0.ndjson ...

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const out = { in: null, files: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--in") out.in = argv[++i];
		else if (a === "-h" || a === "--help") out.help = true;
		else out.files.push(a);
	}
	return out;
}

function discover(dir) {
	return fs
		.readdirSync(dir)
		.filter((f) => /^turns\..+\.ndjson$/.test(f))
		.sort()
		.map((f) => path.join(dir, f));
}

function labelOf(file) {
	const m = path.basename(file).match(/^turns\.(.+)\.ndjson$/);
	return m ? m[1] : path.basename(file);
}

function num(x) {
	return Number.isFinite(x) ? x : 0;
}

function accumulate(file) {
	const acc = {
		label: labelOf(file),
		turns: 0,
		pings: 0,
		input: 0,
		create5m: 0,
		create1h: 0,
		read: 0,
		output: 0,
	};
	const text = fs.readFileSync(file, "utf8");
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		let rec;
		try {
			rec = JSON.parse(s);
		} catch {
			continue;
		}
		const u = rec.usage;
		if (!u) continue;
		if (typeof rec.arm === "string" && /ping/.test(rec.arm)) {
			acc.pings++;
			continue;
		}
		acc.turns++;
		acc.input += num(u.input_tokens);
		acc.read += num(u.cache_read_input_tokens);
		acc.output += num(u.output_tokens);
		const cc = u.cache_creation || {};
		acc.create5m += num(cc.ephemeral_5m_input_tokens);
		acc.create1h += num(cc.ephemeral_1h_input_tokens);
	}
	return acc;
}

function per(acc, field) {
	return acc.turns ? acc[field] / acc.turns : 0;
}

function fmt(n) {
	return Math.round(n).toLocaleString("en-US");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(
			"usage: node benchmark/bin/decompose_tokens.js --in <run-dir> | <turns.*.ndjson...>\n",
		);
		return;
	}
	let files = args.files;
	if (args.in) files = [...discover(args.in), ...files];
	if (files.length === 0) {
		process.stderr.write(
			"decompose_tokens: no input (pass --in <dir> or turns.*.ndjson paths)\n",
		);
		process.exit(2);
	}
	const rows = files.map(accumulate);

	// Per-turn table: the four buckets + billable (input + both creations).
	const head = [
		"arm",
		"turns",
		"input/t",
		"5m-create/t",
		"1h-create/t",
		"read/t",
		"billable/t",
		"pings",
	];
	const lines = rows.map((r) => [
		r.label,
		String(r.turns),
		fmt(per(r, "input")),
		fmt(per(r, "create5m")),
		fmt(per(r, "create1h")),
		fmt(per(r, "read")),
		fmt(per(r, "input") + per(r, "create5m") + per(r, "create1h")),
		String(r.pings),
	]);
	const widths = head.map((h, i) =>
		Math.max(h.length, ...lines.map((l) => l[i].length)),
	);
	const pad = (cells) => cells.map((c, i) => c.padStart(widths[i])).join("  ");
	process.stdout.write(`${pad(head)}\n`);
	for (const l of lines) process.stdout.write(`${pad(l)}\n`);

	// Attribution hint: if exactly two arms, show what drives the billable gap.
	if (rows.length === 2) {
		const [a, b] = rows;
		const dCreate1h = per(b, "create1h") - per(a, "create1h");
		const dCreate5m = per(b, "create5m") - per(a, "create5m");
		const dInput = per(b, "input") - per(a, "input");
		const dRead = per(b, "read") - per(a, "read");
		const dBill =
			per(b, "input") +
			per(b, "create5m") +
			per(b, "create1h") -
			(per(a, "input") + per(a, "create5m") + per(a, "create1h"));
		process.stdout.write(
			`\n${b.label} − ${a.label} per turn: billable ${dBill >= 0 ? "+" : ""}${fmt(dBill)}` +
				` = input ${dInput >= 0 ? "+" : ""}${fmt(dInput)}` +
				` + 5m-create ${dCreate5m >= 0 ? "+" : ""}${fmt(dCreate5m)}` +
				` + 1h-create ${dCreate1h >= 0 ? "+" : ""}${fmt(dCreate1h)}` +
				`  (cache-read ${dRead >= 0 ? "+" : ""}${fmt(dRead)}/t — work-match check)\n`,
		);
	}
}

main();
