#!/usr/bin/env node
// frag_cost.mjs — does clawback SESSION-KEY fragmentation actually cold-start
// Anthropic's prompt cache? Reads one or more instance turn-logs (the per-proxy
// ndjson with sessionKey + systemStableKey + usage) and, per arm, partitions
// REAL turns (mode=hash; keep-alive pings excluded) into "fresh key" vs "repeat
// key" — fresh = this turn's SESSION KEY differs from the previous real turn on
// the SAME systemStableKey stream. If fresh-key turns still read warm
// (cache_read >> cache_creation), then SESSION-KEY fragmentation is NOT a valid
// proxy for Anthropic cold-starts on this build.
//
// Usage: node .skills/frag-cost/scripts/frag_cost.mjs <instance.ARM.ndjson> [more.ndjson ...]
import fs from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
	console.error("usage: frag_cost.mjs <instance.*.ndjson> [...]");
	process.exit(2);
}

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "—");
const mean = (a) =>
	a.length ? a.reduce((s, x) => s + x, 0) / a.length : Number.NaN;

for (const file of files) {
	const rows = fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((o) => o.mode === "hash"); // real turns only; drop keep-alive pings

	rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

	const u = (o) => o.usage || {};
	const read = (o) => u(o).cache_read_input_tokens || 0;
	const create = (o) => u(o).cache_creation_input_tokens || 0;
	const inp = (o) => u(o).input_tokens || 0;
	const billable = (o) => inp(o) + create(o);

	// per-stream fresh/repeat partition
	const lastKeyByStream = new Map();
	const fresh = [];
	const repeat = [];
	const firstInStream = [];
	const seenStream = new Set();
	const keysByStream = new Map();
	for (const o of rows) {
		const stream = o.systemStableKey || "∅";
		if (!keysByStream.has(stream)) keysByStream.set(stream, new Set());
		keysByStream.get(stream).add(o.sessionKey);
		if (!seenStream.has(stream)) {
			seenStream.add(stream);
			firstInStream.push(o);
			lastKeyByStream.set(stream, o.sessionKey);
			continue;
		}
		if (o.sessionKey !== lastKeyByStream.get(stream)) fresh.push(o);
		else repeat.push(o);
		lastKeyByStream.set(stream, o.sessionKey);
	}

	const distinctSession = new Set(rows.map((o) => o.sessionKey)).size;
	const sumRead = rows.reduce((s, o) => s + read(o), 0);
	const sumCreate = rows.reduce((s, o) => s + create(o), 0);
	const sumInp = rows.reduce((s, o) => s + inp(o), 0);
	const hitRate = sumRead / (sumRead + sumCreate + sumInp);

	const arm = rows[0]?.arm ?? "?";
	console.log(`\n=== ${file}  (arm=${arm}) ===`);
	console.log(
		`real turns: ${rows.length} | distinct SESSION KEYs: ${distinctSession} | distinct systemStableKeys: ${seenStream.size}`,
	);
	console.log(
		`token-weighted hit rate (read / read+create+input): ${(hitRate * 100).toFixed(1)}%`,
	);
	console.log(
		"fragmentation per systemStableKey stream (distinct session keys):",
	);
	for (const [stream, keys] of keysByStream) {
		const n = rows.filter((o) => (o.systemStableKey || "∅") === stream).length;
		console.log(
			`  ${stream.slice(0, 12)}  keys=${keys.size}  turns=${n}${keys.size > 1 ? "  ⚠ fragmented" : ""}`,
		);
	}

	const row = (label, set) =>
		console.log(
			`  ${label.padEnd(22)} n=${String(set.length).padStart(3)}  ` +
				`read=${fmt(mean(set.map(read))).padStart(8)}  ` +
				`creation=${fmt(mean(set.map(create))).padStart(7)}  ` +
				`input=${fmt(mean(set.map(inp))).padStart(6)}  ` +
				`billable=${fmt(mean(set.map(billable))).padStart(7)}`,
		);
	console.log("mean usage by SESSION-KEY freshness (the decisive cut):");
	row("fresh key (rotated)", fresh);
	row("repeat key (stable)", repeat);
	row("first-in-stream", firstInStream);

	// verdict
	const fr = mean(fresh.map(read));
	const fc = mean(fresh.map(create));
	if (fresh.length) {
		const ratio = fc > 0 ? fr / fc : Number.POSITIVE_INFINITY;
		const warm = fr > fc * 2; // reads dominate creation => served warm
		console.log(
			`VERDICT: fresh-key turns read ${fmt(fr)} vs create ${fmt(fc)} (read/create=${
				Number.isFinite(ratio) ? ratio.toFixed(1) : "∞"
			}) → ${
				warm
					? "served WARM despite rotation ⇒ SESSION-KEY fragmentation is NOT a cold-start proxy on this build."
					: "cold-started ⇒ fragmentation DOES map to Anthropic cost."
			}`,
		);
	}
}
