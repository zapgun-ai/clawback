#!/usr/bin/env node

// clawback cache-breakpoint inspector
//
// Answers, for a captured /v1/messages body (or a stored clawback session),
// the question "where are the prompt-cache breakpoints, and which ephemeral
// tokens (cch / date / <env>) sit inside which cached prefixes?" — i.e. what
// does a single mutation cold-start.
//
// This is STATIC: it spends no tokens and calls no API. Anthropic caches the
// CUMULATIVE prefix (tools -> system -> messages) up to each `cache_control`
// block, exact-match. So an ephemeral token at cache-order position P
// invalidates every breakpoint at position >= P when it rotates. That single
// fact characterizes the whole structure — no exhaustive 2^N probe needed.
//
// Usage:
//   node benchmark/bin/inspect_breakpoints.js <path>
//     <path> may be a raw /v1/messages JSON body, a benchmark fixture, or a
//     clawback --state file (the largest captured session is inspected).
//   --json   emit the machine-readable model instead of the text report.

import fs from "node:fs";

// Ephemeral patterns mirror src/fingerprint.js STRIP_PATTERNS. Kept local so
// the inspector has no src/ import and can run against any JSON on disk.
const EPHEMERAL = [
	{ name: "cch", re: /cch=[0-9a-f]+/i, rotates: "every request" },
	{
		name: "today-date",
		re: /Today['’]s date is[^.\n<]*/i,
		rotates: "daily (midnight)",
	},
	{
		name: "iso-date",
		re: /\b\d{4}-\d{2}-\d{2}\b/,
		rotates: "daily (midnight)",
	},
	{
		name: "env-block",
		re: /<env>[\s\S]*?<\/env>/i,
		rotates: "on cwd/git change",
	},
];

function approxTokens(s) {
	// Rough: ~4 chars/token. Labelled an estimate everywhere it surfaces.
	return Math.max(1, Math.round((s || "").length / 4));
}

function blockText(b) {
	if (typeof b === "string") return b;
	if (b && typeof b.text === "string") return b.text;
	return JSON.stringify(b);
}

function hasBreakpoint(b) {
	return !!b?.cache_control;
}

function ttlOf(b) {
	return b?.cache_control?.ttl || (hasBreakpoint(b) ? "5m" : null);
}

// Normalize whatever we loaded into { source, note, model, tools[], system[],
// messages[] } where each entry is the raw block/object.
function normalize(raw, path) {
	if (raw?.sessions && typeof raw.sessions === "object") {
		const keys = Object.keys(raw.sessions);
		let best = null;
		let bestLen = -1;
		for (const k of keys) {
			const len = JSON.stringify(raw.sessions[k]).length;
			if (len > bestLen) {
				bestLen = len;
				best = raw.sessions[k];
			}
		}
		return {
			source: `${path} (state session ${String(best?.key).slice(0, 12)}…, largest of ${keys.length})`,
			note: "state session: messages are not persisted, so message-tail breakpoints are not shown",
			model: best?.model,
			tools: Array.isArray(best?.tools) ? best.tools : [],
			system: Array.isArray(best?.system)
				? best.system
				: best?.system
					? [{ type: "text", text: String(best.system) }]
					: [],
			messages: [],
		};
	}
	// raw /v1/messages body or fixture (top-level _ keys are stripped by replay)
	const system = Array.isArray(raw.system)
		? raw.system
		: raw.system
			? [{ type: "text", text: String(raw.system) }]
			: [];
	return {
		source: path,
		note: null,
		model: raw.model,
		tools: Array.isArray(raw.tools) ? raw.tools : [],
		system,
		messages: Array.isArray(raw.messages) ? raw.messages : [],
	};
}

// Build the cache-ordered segment list: tools, then system, then messages.
function buildPrefix({ tools, system, messages }) {
	const segs = [];
	tools.forEach((t, i) => {
		const text = JSON.stringify(t);
		segs.push({
			region: "tools",
			idx: i,
			label: `tool[${i}] ${t?.name ? t.name : "?"}`,
			text,
			tok: approxTokens(text),
			bp: hasBreakpoint(t),
			ttl: ttlOf(t),
		});
	});
	system.forEach((b, i) => {
		const text = blockText(b);
		const oneLine = text.replace(/\s+/g, " ").slice(0, 60);
		segs.push({
			region: "system",
			idx: i,
			label: `system[${i}] ${JSON.stringify(oneLine)}`,
			text,
			tok: approxTokens(text),
			bp: hasBreakpoint(b),
			ttl: ttlOf(b),
		});
	});
	messages.forEach((m, i) => {
		const text = JSON.stringify(m.content !== undefined ? m.content : m);
		segs.push({
			region: "messages",
			idx: i,
			label: `message[${i}] (${m?.role || "?"})`,
			text,
			tok: approxTokens(text),
			bp: hasBreakpoint(m),
			ttl: ttlOf(m),
		});
	});
	return segs;
}

function analyze(segs) {
	const breakpoints = [];
	segs.forEach((s, pos) => {
		if (s.bp) breakpoints.push({ pos, label: s.label, ttl: s.ttl });
	});

	const ephemeral = [];
	segs.forEach((s, pos) => {
		for (const e of EPHEMERAL) {
			const m = s.text.match(e.re);
			if (m) {
				// which breakpoints sit at pos or later => this token is inside their prefix
				const poisoned = breakpoints.filter((b) => b.pos >= pos);
				ephemeral.push({
					name: e.name,
					rotates: e.rotates,
					pos,
					segLabel: s.label,
					sample: m[0].slice(0, 48),
					poisoned: poisoned.map((b) => b.pos),
				});
			}
		}
	});

	const totalCachedTok = breakpoints.length
		? segs
				.slice(0, breakpoints[breakpoints.length - 1].pos + 1)
				.reduce((a, s) => a + s.tok, 0)
		: 0;

	return { breakpoints, ephemeral, totalCachedTok };
}

function report(model, segs, a, source, note) {
	const L = [];
	L.push("clawback cache-breakpoint inspector");
	L.push(`source: ${source}`);
	if (note) L.push(`note:   ${note}`);
	if (model) L.push(`model:  ${model}`);
	L.push("");
	L.push(
		"CACHE PREFIX (order: tools -> system -> messages); ~tok = chars/4 estimate",
	);
	L.push("  pos  ~tok  breakpoint   segment");
	L.push("  ---  ----  -----------  ----------------------------------------");
	segs.forEach((s, pos) => {
		const bp = s.bp ? `BREAK ${String(s.ttl).padEnd(4)}` : "           ";
		const eph = EPHEMERAL.filter((e) => e.re.test(s.text)).map((e) => e.name);
		const mark = eph.length ? `   <-- ${eph.join(", ")}` : "";
		L.push(
			`  ${String(pos).padStart(3)}  ${String(s.tok).padStart(4)}  ${bp}  ${s.label}${mark}`,
		);
	});
	L.push("");
	L.push(
		`BREAKPOINTS: ${a.breakpoints.length}${
			a.breakpoints.length
				? ` (${a.breakpoints.map((b) => b.ttl).join(", ")})`
				: ""
		}`,
	);
	if (!a.breakpoints.length) {
		L.push(
			"  No cache_control breakpoints found — nothing is cached, so rotation is moot here.",
		);
	}
	L.push("EPHEMERAL TOKENS (clawback strip-ephemeral removes these):");
	if (!a.ephemeral.length) {
		L.push("  (none found in this body)");
	}
	for (const e of a.ephemeral) {
		const n = a.breakpoints.length;
		const k = e.poisoned.length;
		L.push(
			`  ${e.name.padEnd(11)} pos ${e.pos} (${e.segLabel.split(" ").slice(0, 1).join("")}) rotates ${e.rotates}`,
		);
		L.push(
			`              -> poisons ${k}/${n} breakpoint prefix(es)  [${e.sample}]`,
		);
	}
	L.push("");
	// Verdict centered on cch (the per-request rotator)
	const cch = a.ephemeral.find((e) => e.name === "cch");
	if (cch && a.breakpoints.length) {
		const all = cch.poisoned.length === a.breakpoints.length;
		L.push("VERDICT:");
		if (all) {
			L.push(
				`  cch sits BEFORE the earliest breakpoint (pos ${a.breakpoints[0].pos}). Every cached`,
			);
			L.push(
				`  prefix includes it, so a new cch per request cold-starts ${cch.poisoned.length}/${a.breakpoints.length} prefixes`,
			);
			L.push(
				`  = ~${a.totalCachedTok} cached tokens (≈100%) every request. No breakpoint isolates`,
			);
			L.push(
				"  tools or anything ahead of cch, so nothing survives the rotation.",
			);
		} else {
			L.push(
				`  cch poisons ${cch.poisoned.length}/${a.breakpoints.length} breakpoint prefix(es). Prefixes BEFORE pos ${cch.pos}`,
			);
			L.push(
				"  (e.g. an isolated tools breakpoint) survive cch rotation and stay warm.",
			);
		}
		L.push(
			"  strip-ephemeral removes cch -> prefixes stable -> warm reads restored.",
		);
	} else if (a.breakpoints.length && !cch) {
		L.push(
			"VERDICT: no cch in this body — rotation here is driven only by date/env (daily/dir).",
		);
	}
	return L.join("\n");
}

function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes("--json");
	const path = args.find((x) => !x.startsWith("--"));
	if (!path) {
		console.error(
			"usage: node benchmark/bin/inspect_breakpoints.js <body-or-state.json> [--json]",
		);
		process.exit(2);
	}
	const raw = JSON.parse(fs.readFileSync(path, "utf8"));
	const norm = normalize(raw, path);
	const segs = buildPrefix(norm);
	const a = analyze(segs);
	if (asJson) {
		console.log(
			JSON.stringify(
				{
					source: norm.source,
					model: norm.model,
					breakpoints: a.breakpoints,
					ephemeral: a.ephemeral,
					totalCachedTok: a.totalCachedTok,
					segments: segs.map((s) => ({
						region: s.region,
						idx: s.idx,
						tok: s.tok,
						bp: s.bp,
						ttl: s.ttl,
					})),
				},
				null,
				2,
			),
		);
	} else {
		console.log(report(norm.model, segs, a, norm.source, norm.note));
	}
}

main();
