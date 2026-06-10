#!/usr/bin/env node
// Per-arm turn-log quick stats: a fast, read-only peek at one or more clawback
// turn-log NDJSON files. Unlike the full `bench` analyzer it does no
// bootstrap / CI / pricing — it just tallies what a single arm produced, so it
// is cheap to run at each arm boundary while a suite is still in flight.
// Safe on an actively-appended file: a partial trailing line is skipped, not
// fatal. Reads files already on disk; never touches the running proxy.

import fs from "node:fs";

function fmt(n) {
	return Number(n).toLocaleString("en-US");
}

function pct(n, d) {
	return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}

function summarize(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { error: err.code === "ENOENT" ? "missing" : String(err) };
	}
	const lines = text.split("\n").filter((l) => l.length > 0);
	const recs = [];
	let skipped = 0;
	for (const line of lines) {
		try {
			recs.push(JSON.parse(line));
		} catch {
			skipped++; // partial trailing line on a live file, or corruption
		}
	}
	const status = {};
	const ttl = {};
	const budgets = new Set();
	let pings = 0;
	let withBudget = 0;
	let sumIn = 0;
	let sumOut = 0;
	let sumRead = 0;
	let sumCreate = 0;
	let sum5m = 0;
	let sum1h = 0;
	let sumWall = 0;
	let wallN = 0;
	let firstRead = null;
	let lastRead = null;
	for (const r of recs) {
		if (r.arm === "treatment-ping") {
			pings++; // synthetic keep-alive cost, not a billable client turn
			continue;
		}
		status[r.httpStatus] = (status[r.httpStatus] ?? 0) + 1;
		if (r.ttlMode) ttl[r.ttlMode] = (ttl[r.ttlMode] ?? 0) + 1;
		if (r.thinkingBudget != null) {
			budgets.add(r.thinkingBudget);
			withBudget++;
		}
		const u = r.usage ?? {};
		sumIn += u.input_tokens ?? 0;
		sumOut += u.output_tokens ?? 0;
		const read = u.cache_read_input_tokens ?? 0;
		sumRead += read;
		sumCreate += u.cache_creation_input_tokens ?? 0;
		const cc = u.cache_creation ?? {};
		sum5m += cc.ephemeral_5m_input_tokens ?? 0;
		sum1h += cc.ephemeral_1h_input_tokens ?? 0;
		if (firstRead === null) firstRead = read;
		lastRead = read;
		if (typeof r.wallMs === "number") {
			sumWall += r.wallMs;
			wallN++;
		}
	}
	return {
		billable: recs.length - pings,
		pings,
		skipped,
		status,
		ttl,
		budgets: [...budgets],
		withBudget,
		sumIn,
		sumOut,
		sumRead,
		sumCreate,
		sum5m,
		sum1h,
		hitRate: pct(sumRead, sumRead + sumCreate + sumIn),
		firstRead: firstRead ?? 0,
		lastRead: lastRead ?? 0,
		meanWall: wallN > 0 ? Math.round(sumWall / wallN) : null,
	};
}

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: node benchmark/bin/arm_stat.js <turn-log.ndjson>...");
	process.exit(2);
}

for (const file of files) {
	const label = file.replace(/.*turns\.?/, "").replace(/\.ndjson$/, "") || file;
	const s = summarize(file);
	console.log(`\n=== ${label} ===`);
	if (s.error) {
		console.log(`(${s.error})`);
		continue;
	}
	const statusStr =
		Object.entries(s.status)
			.map(([k, v]) => `${k}:${v}`)
			.join(" ") || "(none)";
	const allOk =
		Object.keys(s.status).length > 0 &&
		Object.keys(s.status).every((k) => k === "200");
	console.log(
		`turns: ${s.billable} billable${s.pings ? ` + ${s.pings} ping` : ""}${s.skipped ? ` (${s.skipped} partial line skipped)` : ""}`,
	);
	console.log(
		`httpStatus: ${statusStr}${allOk ? "  ✓" : "  ⚠️ non-200 present"}`,
	);
	const ttlStr = Object.entries(s.ttl)
		.map(([k, v]) => `${k}:${v}`)
		.join(" ");
	if (ttlStr) console.log(`ttlMode: ${ttlStr}`);
	console.log(
		`cache_read:   sum ${fmt(s.sumRead)}  (per-turn first→last ${fmt(s.firstRead)} → ${fmt(s.lastRead)})`,
	);
	console.log(
		`cache_create: sum ${fmt(s.sumCreate)}  (ephemeral 5m ${fmt(s.sum5m)} / 1h ${fmt(s.sum1h)})`,
	);
	console.log(`input: sum ${fmt(s.sumIn)}   output: sum ${fmt(s.sumOut)}`);
	console.log(`hit rate (read / read+create+input): ${s.hitRate}`);
	if (s.withBudget) {
		console.log(
			`thinkingBudget: ${s.budgets.join(", ")} (on ${s.withBudget}/${s.billable} turns)`,
		);
	}
	if (s.meanWall != null) console.log(`mean wallMs: ${fmt(s.meanWall)}`);
}
