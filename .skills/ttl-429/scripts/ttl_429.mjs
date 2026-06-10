#!/usr/bin/env node
// ttl_429.mjs — does a keep-alive ping that itself gets 429'd still refresh the
// prompt cache TTL on Anthropic's side? A 429'd ping returns NO usage body, so
// its effect is invisible directly; it is only observable through the NEXT
// successful request on the same SESSION KEY. This reads one or more instance
// turn-logs (per-proxy ndjson with sessionKey + httpStatus + usage), and for
// every 429'd ping classifies it by what the next success read:
//
//   REFRESH?   429'd ping, then a success that read WARM (cache_read>0) AFTER
//              more than --ttl-sec elapsed since the last known-warm event, with
//              NO intervening 200 to muddy it → the 429'd ping itself kept the
//              cache alive across the TTL boundary.
//   NO-REFRESH 429'd ping, next success read COLD (cache_read=0) → it did not.
//   INCONCLUSIVE  a 200 (ping or turn) landed between the 429 and the probe (a
//              success refreshes regardless, masking the 429), OR the probe came
//              back inside the TTL window (cache would have survived anyway).
//
// It also prints per-session ping warmth, which surfaces PHANTOM keep-alive
// loops — sessions whose every ping reads cold (an uncacheable aux context the
// keep-alive should never have armed).
//
// Usage: node .skills/ttl-429/scripts/ttl_429.mjs [--ttl-sec N] <instance.*.ndjson> [...]
//   --ttl-sec  cache TTL boundary in seconds (default 300 = Anthropic default;
//              pass 3600 for an arm running --inject-extended-cache-ttl).
import fs from "node:fs";

const argv = process.argv.slice(2);
let ttlSec = 300;
const files = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--ttl-sec") ttlSec = Number(argv[++i]);
	else files.push(argv[i]);
}
if (!files.length) {
	console.error("usage: ttl_429.mjs [--ttl-sec N] <instance.*.ndjson> [...]");
	process.exit(2);
}
const ttlMs = ttlSec * 1000;
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "—");

const rows = [];
for (const file of files) {
	for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			/* skip malformed */
		}
	}
}
rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

const u = (o) => o.usage || {};
const read = (o) => u(o).cache_read_input_tokens || 0;
const create = (o) => u(o).cache_creation_input_tokens || 0;
const ok = (o) => o.httpStatus === 200 && o.usage != null;
const warm = (o) => ok(o) && (read(o) > 0 || create(o) > 0);
const ping429 = (o) => o.mode === "ping" && o.httpStatus === 429;
const t = (o) => Date.parse(o.ts);

// group by session
const bySession = new Map();
for (const o of rows) {
	const k = o.sessionKey || "∅";
	if (!bySession.has(k)) bySession.set(k, []);
	bySession.get(k).push(o);
}

console.log(
	`ttl boundary: ${ttlSec}s | files: ${files.length} | rows: ${rows.length}`,
);

// ---- per-session ping warmth (surfaces phantom keep-alive loops) ----
console.log(
	"\n=== per-session ping warmth (phantom = many pings, none warm) ===",
);
for (const [k, evs] of bySession) {
	const pings = evs.filter((o) => o.mode === "ping");
	if (!pings.length) continue;
	const w = pings.filter((o) => o.httpStatus === 200 && read(o) > 0).length;
	const cold = pings.filter(
		(o) => o.httpStatus === 200 && read(o) === 0,
	).length;
	const r429 = pings.filter((o) => o.httpStatus === 429).length;
	const real = evs.filter((o) => o.mode !== "ping").length;
	const phantom =
		w === 0 && pings.length >= 3 ? "  ⚠ PHANTOM (no warm ping ever)" : "";
	console.log(
		`  ${k.slice(0, 12)}…  realTurns=${String(real).padStart(3)}  pings=${String(
			pings.length,
		).padStart(3)}  warm=${String(w).padStart(3)}  cold=${String(cold).padStart(
			3,
		)}  429=${String(r429).padStart(2)}${phantom}`,
	);
}

// ---- the 429 → TTL question ----
const verdicts = [];
for (const [k, evs] of bySession) {
	let warmAt = null; // ts of last known-warm event on this session
	for (let i = 0; i < evs.length; i++) {
		const o = evs[i];
		if (warm(o)) warmAt = t(o);
		if (!ping429(o)) continue;
		// find the next success on this session
		let probe = null;
		const intervening200 = false;
		for (let j = i + 1; j < evs.length; j++) {
			const n = evs[j];
			if (ok(n)) {
				probe = n;
				break;
			}
			// another 429'd ping in between is fine; a NON-ping 200 can't happen here
			// because ok() already caught it. (kept for clarity)
		}
		if (!probe) {
			verdicts.push({
				k,
				cls: "OPEN",
				note: "no success after the 429 yet (run still live / session ended)",
			});
			continue;
		}
		// was there a 200 between the 429 and the probe? by construction the probe
		// is the FIRST success after the 429, so any success between them IS the
		// probe — no masking 200. (Masking only matters across MULTIPLE 429s.)
		const sinceWarm = warmAt != null ? t(probe) - warmAt : null;
		const crossedTtl = sinceWarm != null && sinceWarm > ttlMs;
		const probeWarm = read(probe) > 0;
		let cls;
		if (warmAt == null)
			cls = "INCONCLUSIVE"; // never warm before → nothing to refresh
		else if (!crossedTtl)
			cls = "INCONCLUSIVE"; // boundary not crossed → warm anyway
		else cls = probeWarm ? "REFRESH" : "NO-REFRESH";
		verdicts.push({
			k,
			cls,
			note: `429@${evs[i].ts} → probe@${probe.ts} (${probe.mode}) read=${fmt(
				read(probe),
			)} | sinceWarm=${sinceWarm == null ? "—" : `${(sinceWarm / 1000).toFixed(0)}s`}${
				crossedTtl ? " >TTL" : " <TTL"
			}`,
		});
	}
}

console.log(`\n=== 429'd-ping → TTL verdicts (ttl=${ttlSec}s) ===`);
const r429total = rows.filter(ping429).length;
if (r429total === 0) {
	console.log(
		"  no 429'd keep-alive pings in this data — cannot answer the question.\n" +
			"  the every-cadence success pings keep the cache warm, so a 429'd ping is\n" +
			"  never isolated across a TTL boundary. need rate-limit PRESSURE: see the\n" +
			"  controlled design (cold gap > ttl, NO pty keep-alive, primary-only ping,\n" +
			"  burst load timed to 429 the gap-ping).",
	);
} else {
	for (const v of verdicts)
		console.log(`  [${v.cls.padEnd(12)}] ${v.k.slice(0, 12)}…  ${v.note}`);
	const tally = {};
	for (const v of verdicts) tally[v.cls] = (tally[v.cls] || 0) + 1;
	console.log(
		`\n  429'd pings: ${r429total} | ${Object.entries(tally)
			.map(([c, n]) => `${c}=${n}`)
			.join("  ")}`,
	);
	if (tally.REFRESH && !tally["NO-REFRESH"])
		console.log(
			"  VERDICT: a 429'd ping DID refresh the TTL (warm across the boundary, no 200 in between).",
		);
	else if (tally["NO-REFRESH"] && !tally.REFRESH)
		console.log(
			"  VERDICT: a 429'd ping did NOT refresh the TTL (cold probe across the boundary).",
		);
	else if (tally.REFRESH && tally["NO-REFRESH"])
		console.log(
			"  VERDICT: MIXED — inspect individual events; the 429→TTL effect is not clean here.",
		);
	else
		console.log(
			"  VERDICT: inconclusive — no 429'd ping was cleanly isolated across the TTL boundary.",
		);
}
