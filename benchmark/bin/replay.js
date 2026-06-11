#!/usr/bin/env node
/**
 * HTTP replay load generator (the "reproducible" arm of TEST.md §4b).
 *
 * Replays ONE captured Claude-Code `/v1/messages` body against a running
 * clawback proxy at a scripted inter-turn gap schedule. Because every turn
 * sends byte-identical structure (same system + tools + cache_control
 * breakpoints), the ANTHROPIC KEY is stable across turns, so this isolates
 * clawback's cache mechanic from the content nondeterminism of a live model.
 * The trade-off vs the PTY driver (benchmark/bin/drive_pty.js) is fidelity:
 * the fixture must reproduce Claude Code's exact `cache_control` breakpoints
 * AND the request must carry the same `anthropic-beta` headers, or arm A2
 * (1h-TTL) looks like a no-op. clawback forwards `anthropic-beta` but does
 * NOT add the extended-cache-ttl beta itself (src/server.js AUTH_HEADER_KEYS),
 * so we send a realistic default below — override with --anthropic-beta.
 *
 * Session identity (see CLAUDE.md "SESSION KEY vs ANTHROPIC KEY"):
 *   - SESSION KEY (clawback-owned): we use PATH mode — `/<sessionId>/v1/...` —
 *     and mint a fresh id per invocation so clawback treats each block as a
 *     new session. Free; no body change.
 *   - ANTHROPIC KEY (Anthropic-owned cache key): to defeat the carry-over
 *     confound (TEST.md §7) we prepend a unique nonce text block to `system`
 *     by default, cold-starting Anthropic's prefix cache for THIS block while
 *     preserving every downstream cache_control breakpoint. Pass
 *     --shared-cache to reuse a warm cache across runs (e.g. to measure a
 *     warm-start specifically).
 *
 * Data is captured by the proxy's --turn-log; this script prints a per-turn
 * usage convenience line but produces no telemetry of its own.
 *
 * Auth: NO Anthropic API key. Real Claude Code authenticates with an OAuth
 * bearer (Claude Max) and clawback simply forwards it (src/server.js
 * AUTH_HEADER_KEYS). To match production, a real replay run forwards
 * `Authorization: Bearer $CLAWBACK_OAUTH_TOKEN` IF that env var is set — the
 * same credential `claude` sends, never an `sk-...` key. If it is unset, replay
 * sends no auth (fine for --dry-run plumbing; a real call then 401s). For real
 * traffic prefer the PTY arm (.skills/drive), which uses your actual `claude`
 * login. SPENDS REAL TOKENS only with a bearer set and without --dry-run.
 *
 * Usage:
 *   node benchmark/bin/replay.js --dry-run --profile L0 --turns 5   # plumbing
 *   CLAWBACK_OAUTH_TOKEN=… node benchmark/bin/replay.js \
 *     --profile L2 --turns 30 --fixture benchmark/fixtures/ccode.json \
 *     [--port 8787] [--session-id replay-A5-block1] [--gap-sec 5] \
 *     [--stream] [--shared-cache] [--transcript <path>] [--dry-run]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Inter-turn gap ranges in ms. Mirror benchmark/bin/drive_pty.js so the two
// drivers are comparable at the same profile label.
const PROFILES = {
	L0: [1_000, 15_000],
	L1: [60_000, 300_000],
	L2: [300_000, 1_800_000],
	L3: [1_800_000, 5_400_000],
	L4: [3_600_000, 7_200_000],
};

// Realistic default. Claude Code sends both of these; clawback's 1h-TTL
// rewrite (arm A2) only takes effect if the request is allowed to use the
// extended-cache-ttl beta. Override with --anthropic-beta "" to send none.
const DEFAULT_BETA = "prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11";

function parseArgs(argv) {
	const o = {
		profile: "L0",
		turns: 10,
		fixture: path.join(HERE, "..", "fixtures", "ccode.json"),
		host: "127.0.0.1",
		port: 8787,
		tls: false,
		sessionId: null,
		cacheNonce: null,
		sharedCache: false,
		gapSec: null,
		maxTurnSec: 180,
		anthropicVersion: "2023-06-01",
		anthropicBeta: DEFAULT_BETA,
		model: null,
		stream: false,
		transcript: null,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--profile") o.profile = argv[++i];
		else if (a === "--turns") o.turns = Number(argv[++i]);
		else if (a === "--fixture") o.fixture = argv[++i];
		else if (a === "--host") o.host = argv[++i];
		else if (a === "--port") o.port = Number(argv[++i]);
		else if (a === "--tls") o.tls = true;
		else if (a === "--session-id") o.sessionId = argv[++i];
		else if (a === "--cache-nonce") o.cacheNonce = argv[++i];
		else if (a === "--shared-cache") o.sharedCache = true;
		else if (a === "--gap-sec") o.gapSec = Number(argv[++i]);
		else if (a === "--max-turn-sec") o.maxTurnSec = Number(argv[++i]);
		else if (a === "--anthropic-version") o.anthropicVersion = argv[++i];
		else if (a === "--anthropic-beta") o.anthropicBeta = argv[++i];
		else if (a === "--model") o.model = argv[++i];
		else if (a === "--stream") o.stream = true;
		else if (a === "--transcript") o.transcript = argv[++i];
		else if (a === "--dry-run") o.dryRun = true;
		else if (a === "-h" || a === "--help") o.help = true;
		else throw new Error(`unknown option: ${a}`);
	}
	return o;
}

function pickGapMs(o) {
	if (o.gapSec != null) return o.gapSec * 1000;
	const range = PROFILES[o.profile];
	if (!range)
		throw new Error(
			`unknown profile: ${o.profile} (expected one of ${Object.keys(PROFILES).join(", ")})`,
		);
	const [lo, hi] = range;
	return Math.round(lo + Math.random() * (hi - lo));
}

// Prepend a unique, uncached text block to `system` so Anthropic's prefix
// cache starts cold for this block while every downstream cache_control
// breakpoint keeps its relative structure. Handles both system shapes:
// a bare string or an array of content blocks.
function injectCacheNonce(body, nonce) {
	const marker = `[clawback-replay nonce: ${nonce}]`;
	if (typeof body.system === "string") {
		return { ...body, system: `${marker}\n\n${body.system}` };
	}
	if (Array.isArray(body.system)) {
		return {
			...body,
			system: [{ type: "text", text: marker }, ...body.system],
		};
	}
	// No system block to seed; fall back to a system string.
	return { ...body, system: marker };
}

function summarizeFixture(body) {
	const sys = body.system;
	let sysBlocks = 0;
	let sysBreakpoints = 0;
	if (typeof sys === "string") {
		sysBlocks = 1;
	} else if (Array.isArray(sys)) {
		sysBlocks = sys.length;
		for (const b of sys) if (b?.cache_control) sysBreakpoints++;
	}
	const tools = Array.isArray(body.tools) ? body.tools : [];
	let toolBreakpoints = 0;
	for (const t of tools) if (t?.cache_control) toolBreakpoints++;
	const msgs = Array.isArray(body.messages) ? body.messages.length : 0;
	return {
		model: body.model ?? "(unset)",
		stream: body.stream === true,
		sysBlocks,
		sysBreakpoints,
		tools: tools.length,
		toolBreakpoints,
		msgs,
	};
}

function usageLine(usage) {
	if (!usage || typeof usage !== "object") return "(no usage in response)";
	const inp = usage.input_tokens ?? 0;
	const cc = usage.cache_creation_input_tokens ?? 0;
	const cr = usage.cache_read_input_tokens ?? 0;
	const out = usage.output_tokens ?? 0;
	const denom = inp + cc + cr;
	const hit = denom > 0 ? ((cr / denom) * 100).toFixed(1) : "0.0";
	return `input=${inp} cache_creation=${cc} cache_read=${cr} output=${out} hit=${hit}%`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write("see header of benchmark/bin/replay.js for usage\n");
		return;
	}

	const raw = fs.readFileSync(o.fixture, "utf8");
	let fixture;
	try {
		fixture = JSON.parse(raw);
	} catch (e) {
		throw new Error(`fixture is not valid JSON (${o.fixture}): ${e.message}`);
	}
	if (!fixture || typeof fixture !== "object" || !fixture.messages) {
		throw new Error(
			`fixture ${o.fixture} does not look like a /v1/messages body (missing "messages")`,
		);
	}

	const scheme = o.tls ? "https" : "http";
	const sessionId =
		o.sessionId ??
		`replay-${o.profile}-${crypto.randomBytes(4).toString("hex")}`;
	const url = `${scheme}://${o.host}:${o.port}/${sessionId}/v1/messages`;
	const summary = summarizeFixture(fixture);

	if (o.dryRun) {
		process.stdout.write(
			`[dry-run] profile=${o.profile} turns=${o.turns} maxTurn=${o.maxTurnSec}s ` +
				`stream=${o.stream} sharedCache=${o.sharedCache}\n`,
		);
		process.stdout.write(`[dry-run] POST ${url}\n`);
		process.stdout.write(
			`[dry-run] fixture ${o.fixture}: model=${summary.model} ` +
				`system=${summary.sysBlocks} block(s)/${summary.sysBreakpoints} breakpoint(s) ` +
				`tools=${summary.tools}/${summary.toolBreakpoints} breakpoint(s) ` +
				`messages=${summary.msgs} stream=${summary.stream}\n`,
		);
		if (summary.sysBreakpoints + summary.toolBreakpoints === 0) {
			process.stdout.write(
				"[dry-run] WARNING: fixture has no cache_control breakpoints — " +
					"1h-TTL (A2) and cache-read share will be meaningless. Capture a real one.\n",
			);
		}
		process.stdout.write(
			`[dry-run] anthropic-beta: ${o.anthropicBeta || "(none)"}\n`,
		);
		process.stdout.write(
			`[dry-run] cache: ${o.sharedCache ? "SHARED (no nonce; warm across runs)" : "FRESH (nonce prepended to system)"}\n`,
		);
		const gaps = [];
		for (let i = 0; i < o.turns - 1; i++)
			gaps.push(Math.round(pickGapMs(o) / 1000));
		process.stdout.write(
			`[dry-run] planned inter-turn gaps (s): ${gaps.join(", ") || "(none)"}\n`,
		);
		if (!process.env.CLAWBACK_OAUTH_TOKEN) {
			process.stdout.write(
				"[dry-run] note: CLAWBACK_OAUTH_TOKEN not set — a real run would send no auth " +
					"(401). Set it to your Claude Max OAuth bearer, or use .skills/drive for real traffic.\n",
			);
		}
		return;
	}

	// NO Anthropic API key (see header). Forward an OAuth bearer only if the
	// operator explicitly provides one — the same credential `claude` sends.
	const oauthToken = process.env.CLAWBACK_OAUTH_TOKEN;
	if (!oauthToken) {
		process.stderr.write(
			"replay: CLAWBACK_OAUTH_TOKEN not set — sending no auth header; a real call will " +
				"401. Use --dry-run for plumbing, or .skills/drive (PTY) for real traffic.\n",
		);
	}

	// Per-block cache nonce: stable across this run's turns (so turns 2..N can
	// reuse turn 1's warm cache), unique per run (so blocks are independent).
	const nonce = o.cacheNonce ?? crypto.randomBytes(8).toString("hex");
	const transcript = o.transcript
		? fs.createWriteStream(o.transcript, { flags: "a", mode: 0o600 })
		: null;

	process.stdout.write(`[replay] POST ${url}\n`);
	process.stdout.write(
		`[replay] fixture model=${summary.model} system breakpoints=${summary.sysBreakpoints} tool breakpoints=${summary.toolBreakpoints}\n`,
	);
	if (summary.sysBreakpoints + summary.toolBreakpoints === 0) {
		process.stdout.write(
			"[replay] WARNING: no cache_control breakpoints in fixture — cache study will be meaningless.\n",
		);
	}

	const headers = {
		"content-type": "application/json",
		"anthropic-version": o.anthropicVersion,
	};
	if (oauthToken) headers.authorization = `Bearer ${oauthToken}`;
	if (o.anthropicBeta) headers["anthropic-beta"] = o.anthropicBeta;

	for (let i = 0; i < o.turns; i++) {
		// Drop annotation keys (e.g. _provenance) — Anthropic 400s on unknown
		// top-level fields, so the fixture's documentation must never be sent.
		let body = {};
		for (const [k, v] of Object.entries(fixture))
			if (!k.startsWith("_")) body[k] = v;
		if (o.model) body.model = o.model;
		body.stream = o.stream;
		if (!o.sharedCache) body = injectCacheNonce(body, nonce);

		const payload = JSON.stringify(body);
		const t0 = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), o.maxTurnSec * 1000);
		let status = 0;
		let note = "";
		try {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: payload,
				signal: controller.signal,
			});
			status = res.status;
			if (o.stream) {
				// Drain the SSE stream; usage is recorded by the proxy's turn-log.
				const text = await res.text();
				transcript?.write(text);
				note = "(streamed; see --turn-log for usage)";
			} else {
				const text = await res.text();
				transcript?.write(`${text}\n`);
				try {
					const json = JSON.parse(text);
					note =
						status >= 400
							? `ERROR ${json?.error?.type ?? ""}: ${json?.error?.message ?? text.slice(0, 200)}`
							: usageLine(json.usage);
				} catch {
					note = `(non-JSON response: ${text.slice(0, 120)})`;
				}
			}
		} catch (e) {
			note =
				e.name === "AbortError"
					? `timeout after ${o.maxTurnSec}s`
					: `fetch error: ${e.message}`;
		} finally {
			clearTimeout(timer);
		}
		const wall = Date.now() - t0;
		process.stdout.write(
			`[replay] turn ${i + 1}/${o.turns} ${status} ${wall}ms ${note}\n`,
		);

		if (i < o.turns - 1) {
			const gapMs = pickGapMs(o);
			process.stdout.write(
				`[replay] idle ${Math.round(gapMs / 1000)}s before next turn\n`,
			);
			await sleep(gapMs);
		}
	}

	transcript?.end();
	process.stdout.write("[replay] done\n");
}

main().catch((e) => {
	process.stderr.write(`replay: ${e.message}\n`);
	process.exit(1);
});
