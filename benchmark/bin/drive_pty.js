#!/usr/bin/env node
/**
 * PTY-driven load generator (the "faithful" arm of TEST.md §4a).
 *
 * Drives the REAL `claude` binary through clawback's own PTY channel
 * (reusing src/launch_claude.js -> ptyProcess.write(), the same mechanism
 * auto-continue uses) by typing scripted prompts on a schedule. Because the
 * bytes on the wire are produced by the genuine Claude Code client, this is
 * the only driver that faithfully exercises the 1h-TTL nested-cache-control
 * rewrite (arm A2). Data is captured by the proxy's --turn-log; this script
 * produces no telemetry of its own.
 *
 * SUBMIT + CONFIRM (the reliability fix, see benchmark/lib/turn_submit.js):
 * each prompt is typed WITHOUT a trailing Enter, paused, then Enter is sent as
 * its own keystroke — a combined `${prompt}\r` write gets coalesced by Claude
 * Code's bracketed-paste handling and the CR never submits. The driver then
 * CONFIRMS the turn landed before moving on: it tails the proxy's --turn-log
 * for a new non-ping /v1/messages record (authoritative) or watches the PTY
 * burst into output (claude visibly started), and escalates the Enter encoding
 * (\r -> \n -> \r\n) only when BOTH stay silent — the no-op-Enter signature.
 *
 * A turn is considered COMPLETE (after it's confirmed started) when the PTY
 * emits no new bytes for --settle-sec seconds (Claude Code's TUI has no machine
 * "done" marker; the injected inter-turn gap dominates timing, so quiescence is
 * sufficient once we know the turn actually began).
 *
 * Requires node-pty (clawback's optional dep) and a running clawback proxy.
 * Pass --turn-log <path> (the SAME file the proxy writes) to enable
 * authoritative turn-log confirmation; without it the driver confirms on PTY
 * activity alone.
 *
 * Usage:
 *   node benchmark/bin/drive_pty.js --profile L2 --turns 30 \
 *     --prompts benchmark/prompts/coding.txt [--port 8787] [--settle-sec 8]
 *     [--turn-log <path>] [--confirm-sec 6] [--cwd <dir>] [--command claude]
 *     [--model <id>] [--effort <level>] [--transcript <path>] [--max-sec 4500]
 *     [--pty-keepalive-sec 900] [--keepalive-token 🔥] [--tee-arm]
 *     [--no-clear] [--dry-run]
 *
 * --model pins claude's model (e.g. claude-haiku-4-5-20251001) so plumbing
 * and baseline arms stay cheap; omit to use claude's configured default.
 *
 * --effort sets claude's reasoning level (low|medium|high|xhigh|max), forwarded
 * verbatim as `claude --effort <level>`. Effort changes the size of the thinking
 * blocks that ride inside each assistant turn — and thinking blocks are part of
 * what gets cached and re-read next turn — so it materially shifts the cache
 * economics clawback is measured on. NOTE the jagged availability: Haiku has NO
 * effort control (it ignores/rejects the flag), and `xhigh` exists only on
 * Opus 4.7/4.8. Omit to use the model's default effort.
 *
 * --max-sec caps the run by WALL CLOCK (e.g. 4500 = 75 min): the loop stops at
 * the deadline regardless of turn count, so --turns becomes an upper safety
 * bound. Use it to drive a "run for N minutes" load instead of guessing how
 * many turns land at the target duration (per-turn cadence is noisy).
 *
 * --pty-keepalive-sec N drives a PTY KEEP-ALIVE during each inter-turn gap:
 * every N seconds of idle, the driver types a tiny real turn (--keepalive-token,
 * default 🔥) into the LIVE claude PTY. Unlike the proxy/server-side keep-alive
 * (which replays a captured Authorization header and goes auth-stale the moment
 * claude rotates its OAuth bearer mid-gap), a PTY ping is a genuine client turn:
 * it refreshes the bearer AND re-warms the exact Anthropic cache key for the
 * real session. Pair it with tee.js --keepalive-token <same token> so the tee
 * routes the ping primary-only (never billed/shadowed/paired) — the A0 baseline
 * must stay cold for the paired reclaim to mean anything. Omit to disable.
 *
 * --tee-arm closes the keep-alive's second contamination vector: Claude Code
 * fires its OWN side-channel requests (auto-title generation) that are NOT the
 * keep-alive token, and one can fire moments after a 🔥 ping (triggered by
 * claude's response to it). The token-matching the tee does can't catch those,
 * so they'd be fanned to the cold A0 shadow and re-warm it. With --tee-arm the
 * driver arms the tee's pairing window (POST /__tee/arm) around each REAL prompt
 * and disarms it (/__tee/disarm) for the gap, so while idle EVERY request the
 * tee sees routes primary-only. Requires tee.js --require-arm; the run_paired.sh
 * harness wires both automatically whenever PTY keep-alive is on.
 *
 * RUN-START RESET: by default the driver sends `/clear` ONCE, right after
 * claude's TUI boots and before the first prompt, so every arm begins from a
 * clean, comparable conversation (fresh-session isolation — `/clear` is a real
 * client command, not a harness-only byte mutation, so it stays production-
 * faithful). This is deliberately NOT per-turn: a mid-run reset would mutate
 * context and pollute the inter-turn cache timing the benchmark measures. Pass
 * --no-clear to keep claude's existing conversation (e.g. to resume one).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchClaude } from "../../src/launch_claude.js";
import { submitTurn } from "../lib/turn_submit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Loop predicate, extracted so it's unit-testable without spawning a PTY.
// A run ends when claude exited, the turn budget is spent, OR the wall-clock
// deadline passed. The deadline lets us drive a "run for N minutes" load
// (TEST.md timed blocks) instead of guessing a turn count that lands at the
// wrong duration; turns then acts as an upper safety bound.
export function shouldRunTurn({
	index,
	turns,
	exited,
	runDeadline,
	now = Date.now(),
}) {
	if (exited) return false;
	if (index >= turns) return false;
	if (runDeadline != null && now >= runDeadline) return false;
	return true;
}

// Compact "where are we" line for the turn loop, extracted so the formatting
// is unit-testable. `index` is 0-based (turns COMPLETED before this one);
// turnNo is shown 1-based. Progress is wall-clock based when a --max-sec
// deadline governs the run — there the turn budget is only a safety bound, so
// index/turns would badly understate how far along we are — otherwise it's
// turn-count based. Returns e.g.
//   "turn 3/10 · 30% [###-------] · 1m20s elapsed"            (count-driven)
//   "turn 12 · 16% [##--------] · 12m00s/75m00s elapsed"      (--max-sec)
export function formatProgress({
	index,
	turns,
	startMs,
	now = Date.now(),
	runDeadline = null,
	maxSec = null,
	barWidth = 10,
}) {
	const elapsedMs = Math.max(0, now - startMs);
	const turnNo = index + 1;
	const wallClock = runDeadline != null && maxSec != null && maxSec > 0;
	let frac;
	let head;
	let tail;
	if (wallClock) {
		frac = elapsedMs / (maxSec * 1000);
		head = `turn ${turnNo}`;
		tail = `${formatElapsed(elapsedMs)}/${formatElapsed(maxSec * 1000)} elapsed`;
	} else {
		frac = turns > 0 ? turnNo / turns : 0;
		head = `turn ${turnNo}/${turns}`;
		tail = `${formatElapsed(elapsedMs)} elapsed`;
	}
	frac = Math.max(0, Math.min(1, frac));
	const pct = Math.round(frac * 100);
	const filled = Math.round(frac * barWidth);
	const bar = "#".repeat(filled) + "-".repeat(Math.max(0, barWidth - filled));
	return `${head} · ${pct}% [${bar}] · ${tail}`;
}

function formatElapsed(ms) {
	const totalSec = Math.round(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

// Inter-turn gap ranges in ms. Same fixture/prompts; only timing varies.
// L4 (overnight / date rollover) cannot be faithfully automated in a short
// run — use a real overnight window; the range here is a long-gap proxy.
const PROFILES = {
	L0: [1_000, 15_000],
	L1: [60_000, 300_000],
	L2: [300_000, 1_800_000],
	L3: [1_800_000, 5_400_000],
	L4: [3_600_000, 7_200_000],
};

function parseArgs(argv) {
	const o = {
		profile: "L0",
		turns: 10,
		prompts: path.join(HERE, "..", "prompts", "coding.txt"),
		settleSec: 8,
		maxTurnSec: 180,
		host: "127.0.0.1",
		port: 8787,
		command: "claude",
		model: null,
		effort: null,
		cwd: process.cwd(),
		transcript: null,
		gapSec: null,
		maxSec: null,
		turnLog: null,
		confirmSec: 6,
		clearOnStart: true,
		ptyKeepAliveSec: null,
		keepAliveToken: "🔥",
		teeArm: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--profile") o.profile = argv[++i];
		else if (a === "--turns") o.turns = Number(argv[++i]);
		else if (a === "--prompts") o.prompts = argv[++i];
		else if (a === "--settle-sec") o.settleSec = Number(argv[++i]);
		else if (a === "--max-turn-sec") o.maxTurnSec = Number(argv[++i]);
		else if (a === "--host") o.host = argv[++i];
		else if (a === "--port") o.port = Number(argv[++i]);
		else if (a === "--command") o.command = argv[++i];
		else if (a === "--model") o.model = argv[++i];
		else if (a === "--effort") o.effort = argv[++i];
		else if (a === "--cwd") o.cwd = argv[++i];
		else if (a === "--transcript") o.transcript = argv[++i];
		else if (a === "--turn-log") o.turnLog = argv[++i];
		else if (a === "--confirm-sec") o.confirmSec = Number(argv[++i]);
		else if (a === "--gap-sec") o.gapSec = Number(argv[++i]);
		else if (a === "--max-sec") o.maxSec = Number(argv[++i]);
		else if (a === "--pty-keepalive-sec") o.ptyKeepAliveSec = Number(argv[++i]);
		else if (a === "--keepalive-token") o.keepAliveToken = argv[++i];
		else if (a === "--tee-arm") o.teeArm = true;
		else if (a === "--no-clear") o.clearOnStart = false;
		else if (a === "--dry-run") o.dryRun = true;
		else if (a === "-h" || a === "--help") o.help = true;
		else throw new Error(`unknown option: ${a}`);
	}
	// Validate the VALUE only (not model compatibility — that table rots).
	// claude itself rejects an unknown effort; we fail early with a clearer
	// message so a typo doesn't burn a proxy start + a token.
	if (o.effort != null) {
		const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
		if (!EFFORTS.has(o.effort)) {
			throw new Error(
				`--effort must be one of low|medium|high|xhigh|max (got '${o.effort}')`,
			);
		}
	}
	return o;
}

function loadPrompts(file) {
	const text = fs.readFileSync(file, "utf8");
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Idle an inter-turn gap, optionally firing a PTY keep-alive ping every
// intervalMs. Extracted + dependency-injected (sendPing/sleep/now) so the
// cadence is unit-testable without a real PTY or wall-clock. Semantics:
//   - intervalMs <= 0  -> a single plain sleep for the whole gap, 0 pings
//     (keep-alive disabled — identical to the old `await sleep(gapMs)`).
//   - otherwise         -> sleep in intervalMs slices; after each FULL slice
//     that still lands before the gap end, fire one ping. The final partial
//     slice (gap not a multiple of intervalMs) is slept WITHOUT a trailing
//     ping — we never ping at/after the deadline (the next real turn re-warms
//     anyway). A ping's own wall cost is absorbed: we recompute remaining from
//     `now()` each loop, so a slow ping shortens the next slice instead of
//     overrunning the gap. Returns the number of pings sent.
export async function idleWithKeepAlive({
	gapMs,
	intervalMs,
	sendPing,
	sleep: sleepFn,
	now = Date.now,
	log = null,
}) {
	if (!(intervalMs > 0)) {
		await sleepFn(Math.max(0, gapMs));
		return 0;
	}
	const end = now() + gapMs;
	let pings = 0;
	while (true) {
		const remaining = end - now();
		if (remaining <= 0) break;
		await sleepFn(Math.min(intervalMs, remaining));
		if (now() >= end) break;
		await sendPing();
		pings++;
		if (log) log(pings);
	}
	return pings;
}

// Tail the proxy's --turn-log to detect when a REAL (non-ping) /v1/messages
// turn lands — the authoritative "the prompt actually submitted" signal.
// A keep-alive ping also writes a record (arm contains "ping"); those are NOT
// a turn landing, so they're filtered out. A byte offset tracks position so
// only records appended AFTER sync() count toward the current turn; the proxy
// writes this file from a separate process, so we re-read it on demand.
function makeTurnLogWatcher(turnLogPath) {
	let offset = 0;
	let buf = "";
	const sizeOf = () => {
		try {
			return fs.statSync(turnLogPath).size;
		} catch {
			return -1; // not created yet (proxy writes lazily) or unreadable
		}
	};
	// Read [offset, size), advance offset past consumed COMPLETE lines (a
	// trailing partial line stays buffered), and return parsed records.
	const readNew = () => {
		const size = sizeOf();
		if (size < 0) return [];
		if (size < offset) {
			offset = 0; // truncated/rotated under us
			buf = "";
		}
		if (size === offset) return [];
		let chunk = "";
		try {
			const fd = fs.openSync(turnLogPath, "r");
			try {
				const len = size - offset;
				const b = Buffer.allocUnsafe(len);
				const n = fs.readSync(fd, b, 0, len, offset);
				chunk = b.subarray(0, n).toString("utf8");
				offset += n;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return [];
		}
		buf += chunk;
		const out = [];
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) {
				try {
					out.push(JSON.parse(line));
				} catch {
					/* partial/corrupt line — skip */
				}
			}
			nl = buf.indexOf("\n");
		}
		return out;
	};
	const isRealTurn = (rec) => !String(rec?.arm ?? "").includes("ping");
	return {
		enabled: Boolean(turnLogPath),
		// Discard everything up to now so the next drainHasReal() only sees
		// records produced AFTER this point (call at the START of each turn).
		sync() {
			const size = sizeOf();
			offset = size < 0 ? 0 : size;
			buf = "";
		},
		// True if any new REAL (non-ping) turn record has landed since sync().
		drainHasReal() {
			return readNew().some(isRealTurn);
		},
	};
}

async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(
			"see header of benchmark/bin/drive_pty.js for usage\n",
		);
		return;
	}
	const prompts = loadPrompts(o.prompts);
	if (prompts.length === 0) throw new Error(`no prompts in ${o.prompts}`);
	const baseConfig = { host: o.host, port: o.port, tls: false };

	if (o.dryRun) {
		process.stdout.write(
			`[dry-run] profile=${o.profile} turns=${o.turns} settle=${o.settleSec}s ` +
				`maxTurn=${o.maxTurnSec}s${o.maxSec ? ` maxRun=${o.maxSec}s` : ""} ` +
				`proxy=http://${o.host}:${o.port}` +
				`${o.model ? ` model=${o.model}` : ""}` +
				`${o.effort ? ` effort=${o.effort}` : ""}` +
				`${o.ptyKeepAliveSec ? ` pty-keepalive=${o.ptyKeepAliveSec}s('${o.keepAliveToken}')` : ""}` +
				`${o.teeArm ? " tee-arm=on" : ""}` +
				` clear-on-start=${o.clearOnStart}\n`,
		);
		process.stdout.write(
			`[dry-run] ${prompts.length} prompt(s) loaded from ${o.prompts}\n`,
		);
		// With --max-sec the turn count is deadline-bound, not --turns-bound, so a
		// full list would be the (huge) safety bound — preview a handful instead.
		const previewN = o.maxSec ? Math.min(12, o.turns - 1) : o.turns - 1;
		const gaps = [];
		for (let i = 0; i < previewN; i++)
			gaps.push(Math.round(pickGapMs(o) / 1000));
		const more = o.maxSec ? " … (deadline governs turn count)" : "";
		process.stdout.write(
			`[dry-run] planned inter-turn gaps (s): ${gaps.join(", ") || "(none)"}${more}\n`,
		);
		process.stdout.write(
			`[dry-run] would type prompt[i % ${prompts.length}] each turn, then idle the gap.\n`,
		);
		return;
	}

	const launched = await launchClaude({
		config: baseConfig,
		// `--model` pins claude's model for cost control (e.g. Haiku for cheap
		// plumbing/baseline arms); `--effort` pins the reasoning level. Both
		// forwarded verbatim to the claude CLI.
		args: [
			...(o.model ? ["--model", o.model] : []),
			...(o.effort ? ["--effort", o.effort] : []),
		],
		cwd: o.cwd,
		command: o.command,
		// Force a PTY even when our own stdio is not a TTY — node-pty allocates
		// its own pty; we own the master and write keystrokes into it.
		stdinIsTty: true,
		stdoutIsTty: true,
		cols: 120,
		rows: 40,
	});
	if (launched.mode !== "pty" || !launched.ptyProcess) {
		throw new Error(
			"PTY mode unavailable — install node-pty (`npm i node-pty`) and run where it can allocate a pty.",
		);
	}
	const pty = launched.ptyProcess;
	process.stdout.write(
		`[drive] claude launched in PTY -> ${launched.baseUrl}\n`,
	);

	let lastDataAt = Date.now();
	let totalBytes = 0;
	let exited = false;
	const transcript = o.transcript
		? fs.createWriteStream(o.transcript, { flags: "a", mode: 0o600 })
		: null;
	pty.onData((d) => {
		lastDataAt = Date.now();
		totalBytes += d.length;
		process.stdout.write(d);
		transcript?.write(d);
	});
	pty.onExit(() => {
		exited = true;
	});

	// Resolve when the PTY has been quiet for settleMs, or maxTurnMs elapsed.
	const waitForTurn = async () => {
		const settleMs = o.settleSec * 1000;
		const deadline = Date.now() + o.maxTurnSec * 1000;
		// Reset the quiescence clock to now so we measure silence AFTER the prompt.
		lastDataAt = Date.now();
		while (!exited) {
			await sleep(250);
			if (Date.now() - lastDataAt >= settleMs) return "settled";
			if (Date.now() >= deadline) return "timeout";
		}
		return "exited";
	};

	const watcher = makeTurnLogWatcher(o.turnLog);
	if (!watcher.enabled)
		process.stdout.write(
			"[drive] no --turn-log given; confirming submits on PTY activity only (pass --turn-log <proxy turn-log> for authoritative confirmation)\n",
		);
	// Sustained post-Enter output that proves claude actually started a turn.
	// A no-op Enter (the bug) leaves the box idle — well under this; a real
	// turn streams far more within confirmSec. A false "pty" only degrades to
	// the old behavior (no escalation), never injects a stray newline.
	const ACTIVITY_BYTES = 800;

	// Confirm ONE Enter keystroke (submitTurn calls this right after each
	// Enter write). Returns the source label on success, or null (→ escalate)
	// only when BOTH the turn-log and the PTY stay silent for confirmSec — the
	// no-op-Enter signature. Snapshots the byte count at call time so only
	// output produced AFTER this Enter counts.
	const confirm = async () => {
		const bytesAtEnter = totalBytes;
		const deadline = Date.now() + o.confirmSec * 1000;
		while (!exited && Date.now() < deadline) {
			await sleep(150);
			if (watcher.drainHasReal()) return "turnlog";
			if (totalBytes - bytesAtEnter >= ACTIVITY_BYTES) return "pty";
		}
		if (watcher.drainHasReal()) return "turnlog";
		if (totalBytes - bytesAtEnter >= ACTIVITY_BYTES) return "pty";
		return null;
	};

	// Fire ONE PTY keep-alive ping: type the keep-alive token as a real turn into
	// the LIVE claude PTY, confirm it submitted, then wait for it to settle. This
	// is a genuine client turn — it refreshes claude's OAuth bearer AND re-warms
	// the exact Anthropic cache key for the real session, which the proxy-side
	// keep-alive (captured-header replay) cannot do once the bearer rotates. The
	// tee recognizes the token as a ping and routes it primary-only (never
	// billed/shadowed/paired), so the A0 baseline stays cold. Guarded on `exited`
	// so a ping racing shutdown is a no-op.
	const sendKeepAlivePing = async () => {
		if (exited) return;
		watcher.sync();
		const sub = await submitTurn({
			write: (s) => pty.write(s),
			confirm,
			sleep,
			text: o.keepAliveToken,
			opts: {
				typePauseMs: 250,
				interEnterMs: 150,
				log: (m) => process.stdout.write(`[drive]   keepalive: ${m}\n`),
			},
		});
		if (exited) return;
		process.stdout.write(
			`[drive] keep-alive ping '${o.keepAliveToken}' ${
				sub.confirmed ? `submitted (${sub.how})` : "UNCONFIRMED"
			}\n`,
		);
		await waitForTurn();
	};

	// Let claude finish booting its TUI before the first prompt.
	await waitForTurn();

	// Run-start context reset (default on; --no-clear opts out). ONCE here, not
	// per-turn: a fresh conversation makes every arm start comparable, while a
	// mid-run /clear would mutate context and pollute inter-turn cache timing.
	// `/clear` is a local TUI command (no /v1/messages), so we don't use the
	// turn-log-confirming submitTurn path — just type it, then send Enter as its
	// OWN keystroke (the same bracketed-paste fix: a combined "/clear\r" gets
	// coalesced and the CR never submits), and let the TUI redraw settle.
	if (o.clearOnStart && !exited) {
		process.stdout.write("[drive] /clear — run-start context reset\n");
		pty.write("/clear");
		await sleep(250);
		pty.write("\r");
		await waitForTurn();
	}

	// A --max-sec run stops at the wall-clock deadline; --turns is then just the
	// upper safety bound. Without it, the run is purely turn-count driven.
	const runDeadline =
		o.maxSec != null && o.maxSec > 0 ? Date.now() + o.maxSec * 1000 : null;
	// Anchor for the elapsed/progress readout — set after boot + reset so the
	// bar reflects load time, not TUI startup.
	const startMs = Date.now();

	// PTY keep-alive cadence in ms (0 = disabled). When set, the inter-turn idle
	// fires a token ping every kaMs of gap to keep the bearer + cache key warm.
	const kaMs =
		o.ptyKeepAliveSec != null && o.ptyKeepAliveSec > 0
			? o.ptyKeepAliveSec * 1000
			: 0;
	if (kaMs > 0)
		process.stdout.write(
			`[drive] PTY keep-alive ON: ping '${o.keepAliveToken}' every ${o.ptyKeepAliveSec}s of inter-turn idle\n`,
		);

	// Arm/disarm the tee's pairing window (--tee-arm) over its out-of-band control
	// channel. The tee pairs a turn to the A0 shadow ONLY while armed, so we arm
	// around each REAL prompt and DISARM for the gap: the 🔥 keep-alive AND any
	// Claude Code side-channel it triggers (auto-title generation) then route
	// primary-only, and the cold baseline stays cold. Best-effort and non-fatal —
	// a control-channel hiccup must never abort a multi-hour token run (a missed
	// arm only under-drives the pair set; the next prompt re-arms).
	const setPairing = (on) =>
		new Promise((resolve) => {
			if (!o.teeArm) return resolve(false);
			const req = http.request(
				{
					host: o.host,
					port: o.port,
					method: "POST",
					path: on ? "/__tee/arm" : "/__tee/disarm",
					timeout: 2000,
				},
				(res) => {
					res.on("data", () => {});
					res.on("end", () => resolve(true));
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
			req.end();
		});
	if (o.teeArm)
		process.stdout.write(
			"[drive] tee armed-pairing ON: arm /__tee/arm around each prompt, disarm for the gap\n",
		);

	let confirmedTurns = 0;
	let attemptedTurns = 0;
	for (
		let i = 0;
		shouldRunTurn({ index: i, turns: o.turns, exited, runDeadline });
		i++
	) {
		attemptedTurns++;
		const prompt = prompts[i % prompts.length];
		const progress = formatProgress({
			index: i,
			turns: o.turns,
			startMs,
			runDeadline,
			maxSec: o.maxSec,
		});
		process.stdout.write(`\n[drive] ${progress}: ${prompt.slice(0, 70)}\n`);
		// Arm the tee pairing window for this REAL turn (no-op unless --tee-arm).
		await setPairing(true);
		// Baseline the turn-log so only records from THIS turn can confirm it
		// (records still trailing from the previous turn must not count).
		watcher.sync();
		const sub = await submitTurn({
			write: (s) => pty.write(s),
			confirm,
			sleep,
			text: prompt,
			opts: {
				typePauseMs: 250,
				interEnterMs: 150,
				log: (m) => process.stdout.write(`[drive]   ${m}\n`),
			},
		});
		if (sub.confirmed) {
			confirmedTurns++;
			const plural = sub.attempts === 1 ? "" : "s";
			process.stdout.write(
				`[drive] turn ${i + 1} submitted via ${JSON.stringify(sub.encoding)} (${sub.how}, ${sub.attempts} attempt${plural}); awaiting completion\n`,
			);
			const why = await waitForTurn();
			process.stdout.write(`[drive] turn ${i + 1} ${why}\n`);
		} else {
			process.stdout.write(
				`[drive] turn ${i + 1} UNCONFIRMED after ${sub.attempts} Enter attempts — no turn-log record and no PTY activity; continuing.\n`,
			);
		}
		// Disarm BEFORE the gap: the turn has settled, so any Claude Code
		// side-channel that fires now (auto-title gen) — and every 🔥 keep-alive
		// during the idle — must route primary-only, never touching the cold A0
		// baseline. No-op unless --tee-arm.
		await setPairing(false);
		// Idle the inter-turn gap only if another turn will actually run (turn
		// budget left and deadline not yet reached). When a deadline is set, clamp
		// the gap so we never sleep past it (matters for long-gap profiles).
		const nextWillRun = shouldRunTurn({
			index: i + 1,
			turns: o.turns,
			exited,
			runDeadline,
		});
		if (nextWillRun) {
			let gapMs = pickGapMs(o);
			if (runDeadline != null)
				gapMs = Math.max(0, Math.min(gapMs, runDeadline - Date.now()));
			process.stdout.write(
				`[drive] idle ${Math.round(gapMs / 1000)}s before next turn` +
					`${kaMs > 0 ? ` (keep-alive every ${o.ptyKeepAliveSec}s)` : ""}\n`,
			);
			const pings = await idleWithKeepAlive({
				gapMs,
				intervalMs: kaMs,
				sendPing: sendKeepAlivePing,
				sleep,
				now: Date.now,
				log: (n) =>
					process.stdout.write(
						`[drive] keep-alive ping ${n} sent during idle\n`,
					),
			});
			if (pings > 0)
				process.stdout.write(
					`[drive] ${pings} keep-alive ping(s) during this gap\n`,
				);
		}
	}
	const denom = runDeadline != null ? attemptedTurns : o.turns;
	process.stdout.write(
		`[drive] confirmed ${confirmedTurns}/${denom} turn(s) submitted` +
			`${runDeadline != null ? ` (${o.maxSec}s wall-clock cap)` : ""}\n`,
	);

	process.stdout.write("\n[drive] done; exiting claude\n");
	if (!exited) {
		pty.write("\x03"); // Ctrl-C
		await sleep(300);
		pty.write("\x03");
		await sleep(500);
		try {
			pty.kill();
		} catch {
			/* already gone */
		}
	}
	transcript?.end();
}

// Run only when executed directly (`node drive_pty.js ...`), not when imported
// by a test. Comparing the module URL to argv[1]'s file URL is the robust ESM
// equivalent of `require.main === module`.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((e) => {
		process.stderr.write(`drive_pty: ${e.message}\n`);
		process.exit(1);
	});
}
