#!/usr/bin/env node
/**
 * Paired shadow-mode tee (TEST.md "Fix A" — turn-matched A/B).
 *
 * Sits in front of TWO unmodified clawback instances and fans every real
 * Claude Code request to both, so each /v1/messages turn is billed under both
 * arms for the SAME request bytes (same cch, same system, same tools). That
 * turns the A/B from two free-running sessions (which diverge after the first
 * sampled token → 342 vs 352 turns, not turn-matched) into an exact per-turn
 * counterfactual the analyzer can pair (see benchmark/bin/analyze.js
 * `pairBillableByPairSeq` / `bootstrapPairedDiff`).
 *
 *   claude ──ANTHROPIC_BASE_URL──▶ tee ──┬─▶ clawback PRIMARY (A5 stack) ─▶ Anthropic
 *                                         └─▶ clawback SHADOW  (A0 passthrough) ─▶ Anthropic
 *
 * PRIMARY is streamed back to claude verbatim (claude only ever sees this arm,
 * so the session it builds is real and unmodified). SHADOW runs concurrently,
 * its response is consumed for `usage` then discarded — claude never waits on
 * it, so it adds no client latency. Each arm writes ONE NDJSON record per turn,
 * both stamped with the same internal `pairSeq`.
 *
 * WHAT NEVER CROSSES THE WIRE: `pairSeq` is a tee-internal counter. The tee
 * adds NO header, query param, or body field to either upstream request — it
 * forwards the exact bytes claude sent (minus hop-by-hop headers). Anthropic
 * sees two ordinary Claude Code requests. The clawback instances are
 * byte-for-byte unmodified; this is a test OF clawback, not a fork of it.
 *
 * NO API KEY: the tee forwards claude's inbound `Authorization` (the Claude Max
 * OAuth bearer) to both clawback instances, which forward it to Anthropic. The
 * tee never originates credentials.
 *
 * COST: ~2x your Anthropic quota for the window (every turn is billed twice,
 * once per arm) — the price of an exact paired measurement.
 *
 * USAGE CAPTURE reuses clawback's own `createBodyTap` (src/telemetry.js), so
 * SSE/JSON + gzip/br handling is identical to what the proxy logs — the tee's
 * numbers and the instances' own --turn-logs (if enabled) should agree.
 *
 * Records are written only when a turn produced a `usage` block (a 2xx with
 * tokens). A failed/aborted turn on either arm writes no record, so its pairSeq
 * has no partner and the analyzer drops it from the paired set (it never
 * fabricates a zero-token pair).
 *
 * Output files are named so `analyze.js` picks up the right knobProfile from
 * the basename: pass `A0.ndjson` (shadow) and `A5.ndjson` (primary) and the
 * analyzer labels them A0 / A5 with no --label needed.
 *
 * Usage:
 *   node benchmark/bin/tee.js \
 *     --listen-port 8788 \
 *     --primary-port 8790 --shadow-port 8791 \
 *     --out-primary runs/paired/A5.ndjson \
 *     --out-shadow  runs/paired/A0.ndjson \
 *     [--host 127.0.0.1] [--primary-arm treatment] [--shadow-arm passthrough]
 *
 * Then point the load driver at the tee:
 *   node benchmark/bin/drive_pty.js --port 8788 ...
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createBodyTap } from "../../src/telemetry.js";

// Hop-by-hop headers must not be forwarded to the upstream (RFC 7230 §6.1);
// host/content-length are recomputed by the http client from the body buffer.
const HOP_BY_HOP = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"upgrade",
]);

// Only real generation turns are paired/logged: a POST to exactly /v1/messages.
// /v1/messages/count_tokens (a longer path) is excluded — it returns
// `{input_tokens}` with no usage block and would pollute the token counts
// (the same class of bug fixed proxy-side in task #45). Everything else
// (GET, models, oauth, count_tokens) is still proxied to the primary so claude
// works, but not shadowed or logged.
export function isBillable(method, pathname) {
	return method === "POST" && pathname === "/v1/messages";
}

// Copy inbound headers for an upstream request, dropping hop-by-hop. Keeps
// Authorization (the OAuth bearer), anthropic-version, anthropic-beta,
// content-type, etc. verbatim — the tee is a transparent forwarder.
export function upstreamHeaders(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(k.toLowerCase())) continue;
		out[k] = v;
	}
	return out;
}

// model lives in the request body; pull it for the cost appendix (analyzer
// prices per-model). Safe on non-JSON / partial bodies.
export function parseModel(bodyBuf) {
	try {
		const b = JSON.parse(bodyBuf.toString("utf8"));
		return typeof b?.model === "string" ? b.model : null;
	} catch {
		return null;
	}
}

// Flatten an Anthropic message `content` (string OR an array of content blocks)
// to its plain text. Only `text` blocks contribute; tool_use/image/etc. are
// ignored. Used to recognize the PTY keep-alive ping by its payload.
function messageText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => p && p.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join("");
	}
	return "";
}

// Claude Code DECORATES a user turn at send time: it injects ephemeral context
// (skills list, "as you answer..." context, slash-command echoes) as its OWN
// text blocks — each opening with a known wrapper tag — and leaves the user's
// typed text as a separate, un-wrapped block. Recover only the USER-TYPED text:
// the keep-alive ping must be recognized by what the driver typed, never by the
// whole concatenation, because an injected <system-reminder> can itself MENTION
// the token (it carries the operator's memory index, whose entries can list the
// token). Keying on token-presence would false-match a real turn as a ping and
// route a billable turn primary-only — silently dropping it from the paired set.
// A block we fail to classify stays IN (errs toward "not a ping" → fanned, the
// safe direction), never toward a false ping.
const INJECTED_BLOCK_RE =
	/^\s*<\/?(?:system-reminder|local-command-[a-z-]+|command-[a-z-]+)\b/;

function userTypedText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(p) =>
					p &&
					p.type === "text" &&
					typeof p.text === "string" &&
					!INJECTED_BLOCK_RE.test(p.text),
			)
			.map((p) => p.text)
			.join("");
	}
	return "";
}

// DIAGNOSTIC (off unless a capture path is given): when a keep-alive token is
// configured, dump any /v1/messages turn whose CURRENT (last) user message
// contains the token but was NOT recognized as a ping — the decorated-ping
// near-miss behind the detection bug (Claude Code appends ephemeral
// <system-reminder> context to the wire body at send time, so a typed "🔥" no
// longer exact-matches). Captures the last message's exact shape so we can write
// the regression test from a REAL body instead of guessing the wrapper. Pure
// observation — never alters routing/billing and never throws into the hot path.
function captureNearMiss(capturePath, { body, token, matched }) {
	if (!capturePath || !token || matched) return;
	let b;
	try {
		b = JSON.parse(body.toString("utf8"));
	} catch {
		return;
	}
	const msgs = b?.messages;
	if (!Array.isArray(msgs) || msgs.length === 0) return;
	const last = msgs[msgs.length - 1];
	const lastText = messageText(last?.content);
	// Gate on the CURRENT turn only (not history): a real prompt whose history
	// happens to contain an earlier 🔥 is not a near-miss.
	if (!lastText.includes(String(token))) return;
	try {
		fs.appendFileSync(
			capturePath,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				token,
				lastRole: last?.role ?? null,
				lastTextTrim: lastText.trim(),
				lastTextLen: lastText.length,
				lastContent: last?.content ?? null,
				tailRoles: msgs.slice(-3).map((m) => m?.role ?? null),
			})}\n`,
			{ mode: 0o600 },
		);
	} catch {
		/* diagnostic must never break the proxy path */
	}
}

// Recognize the PTY keep-alive ping: a /v1/messages turn whose LAST user
// message is exactly the driver's keep-alive token (e.g. "🔥"). The driver
// types this tiny turn into the live claude PTY during a gap to (a) refresh the
// OAuth bearer and (b) re-warm the exact Anthropic cache key — but it is NOT a
// real benchmark turn, so the tee must route it primary-only and never bill,
// shadow, pair, or log it (else the A0 baseline gets warmed and the paired
// reclaim is contaminated). Returns false when no token is configured.
export function isKeepAlivePing(bodyBuf, token) {
	if (!token) return false;
	let b;
	try {
		b = JSON.parse(bodyBuf.toString("utf8"));
	} catch {
		return false;
	}
	const msgs = b?.messages;
	if (!Array.isArray(msgs) || msgs.length === 0) return false;
	const last = msgs[msgs.length - 1];
	if (last?.role !== "user") return false;
	return userTypedText(last.content).trim() === String(token).trim();
}

// Decide whether a /v1/messages turn is a PAIRED (billable) turn — fanned to the
// shadow, given a pairSeq, and logged on both arms. A turn pairs iff it is a POST
// /v1/messages, NOT a keep-alive ping, AND (when pairing is gated by
// --require-arm) the DRIVER has armed the pairing window.
//
// The armed gate is the robust fix for a contamination vector isKeepAlivePing
// alone cannot close: during an idle/keep-alive gap Claude Code fires its OWN
// side-channel requests (auto-title generation), and one fired 0.66s AFTER the
// primary-only 🔥 turn in the shakedown — a real /v1/messages that is NOT the
// token, so detection missed it and the tee fanned it to BOTH arms, re-warming
// the cold A0 baseline and invalidating the >60min reclaim. The driver knows
// exactly when a REAL measured turn is in flight, so it arms the window around
// each prompt and disarms it for the gap; while disarmed EVERY non-real request
// (the 🔥 ping, title gen, any future CC side-channel) routes primary-only and
// the baseline stays genuinely cold. isKeepAlivePing is kept as a second line of
// defense (a ping is primary-only even if a turn is somehow armed). Errs safe:
// unsure (disarmed) → not paired → never warms the shadow.
export function shouldPair({ isPost, isPing, requireArm, armed }) {
	if (!isPost || isPing) return false;
	return requireArm ? Boolean(armed) : true;
}

// ---- 2x-cost guard ----------------------------------------------------
// Shadow mode fans every billable turn to BOTH arms, so it bills against the
// operator's Anthropic quota ~twice for the run's duration. Make that
// impossible to miss (a loud banner) and impossible to trigger by accident
// (an explicit switch). resolveAck is pure so the gate is unit-tested; main()
// does the I/O (print banner, prompt, or refuse).
export function shadowCostBanner() {
	return [
		"+====================================================================+",
		"|  WARNING: shadow-mode tee burns Anthropic tokens ~2x AS FAST       |",
		"|                                                                    |",
		"|  Every billable turn is sent to BOTH arms (primary + shadow), so   |",
		"|  it bills against your quota TWICE for the duration of this run --  |",
		"|  the price of an exact turn-matched A/B. Stop any time with Ctrl-C. |",
		"+====================================================================+",
		"",
	].join("\n");
}

// Decide whether the tee may start. `--ack-2x` is the explicit opt-in switch;
// without it we PROMPT on an interactive TTY and REFUSE on a non-interactive
// one — a script must opt in on purpose, so the 2x spend is never silent.
export function resolveAck({ ack, isTTY }) {
	if (ack) return { proceed: true, needsPrompt: false };
	if (isTTY) return { proceed: false, needsPrompt: true };
	return {
		proceed: false,
		needsPrompt: false,
		reason:
			"shadow mode doubles token spend; pass --ack-2x to run non-interactively",
	};
}

// The turn-log record shape. Matches the subset of clawback's own turn-log that
// the analyzer reads (ts, arm, model, usage, httpStatus, wallMs, ttftMs) plus
// the tee-internal `pairSeq` the paired bootstrap groups on. systemStableKey /
// sessionKey are intentionally omitted: the tee sees only the pre-clawback body
// and cannot know what each instance forwarded after its own rewrites (A5
// strips cch, A0 does not), so faking them would misreport fragmentation. The
// fragmentation table is therefore empty on a tee run (it's measured from the
// instances' own --turn-logs / the standalone A0-vs-A5 run); the tee's job is
// the turn-matched reclaim headline.
export function makeRecord({
	ts,
	arm,
	pairSeq,
	model,
	usage,
	httpStatus,
	wallMs,
	ttftMs,
}) {
	return { ts, arm, pairSeq, model, usage, httpStatus, wallMs, ttftMs };
}

// Append-one-NDJSON-line writer with 0600 perms (turn-logs can contain
// model/usage metadata; treat them as sensitive like the proxy does).
function makeWriter(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const fd = fs.openSync(filePath, "a", 0o600);
	return {
		write(record) {
			fs.writeSync(fd, `${JSON.stringify(record)}\n`);
		},
		close() {
			try {
				fs.closeSync(fd);
			} catch {
				/* already closed */
			}
		},
	};
}

// Issue one upstream request to a clawback instance. Streams response chunks to
// `onChunk(buf)` (the primary pipes these to the client; the shadow discards
// them) and resolves with {usage, httpStatus, wallMs, ttftMs} once the response
// — and any async gzip/br decoder inside the tap — has fully drained. Usage is
// captured via clawback's own createBodyTap so SSE/JSON + content-encoding are
// handled exactly as the proxy handles them.
function forward({ host, port, method, reqPath, headers, body }, onChunk) {
	return new Promise((resolve) => {
		const startMs = Date.now();
		let ttftMs = null;
		let usage = null;
		const upstream = http.request(
			{ host, port, method, path: reqPath, headers },
			(res) => {
				if (onChunk) onChunk({ kind: "head", res });
				const tap = createBodyTap({
					contentType:
						res.headers["content-type"] ?? res.headers["Content-Type"] ?? "",
					contentEncoding:
						res.headers["content-encoding"] ??
						res.headers["Content-Encoding"] ??
						null,
					onMessage: ({ usage: u }) => {
						usage = u;
					},
				});
				res.on("data", (chunk) => {
					if (ttftMs == null) ttftMs = Date.now() - startMs;
					if (onChunk) onChunk({ kind: "data", chunk });
					try {
						tap?.(chunk, false);
					} catch {
						/* tap must never break the proxy path */
					}
				});
				res.on("end", async () => {
					try {
						await tap?.(null, true);
					} catch {
						/* swallow — usage stays whatever we captured */
					}
					if (onChunk) onChunk({ kind: "end" });
					resolve({
						usage,
						httpStatus: res.statusCode ?? null,
						wallMs: Date.now() - startMs,
						ttftMs,
					});
				});
				res.on("error", () => {
					if (onChunk) onChunk({ kind: "error" });
					resolve({
						usage,
						httpStatus: res.statusCode ?? null,
						wallMs: Date.now() - startMs,
						ttftMs,
					});
				});
			},
		);
		upstream.on("error", () => {
			if (onChunk) onChunk({ kind: "error" });
			resolve({
				usage: null,
				httpStatus: null,
				wallMs: Date.now() - startMs,
				ttftMs,
			});
		});
		if (body?.length) upstream.write(body);
		upstream.end();
	});
}

function parseArgs(argv) {
	const o = {
		host: "127.0.0.1",
		listenPort: 8788,
		primaryPort: 8790,
		shadowPort: 8791,
		primaryArm: "treatment",
		shadowArm: "passthrough",
		outPrimary: null,
		outShadow: null,
		ack2x: false,
		keepAliveToken: null,
		requireArm: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--host") o.host = argv[++i];
		else if (a === "--listen-port") o.listenPort = Number(argv[++i]);
		else if (a === "--primary-port") o.primaryPort = Number(argv[++i]);
		else if (a === "--shadow-port") o.shadowPort = Number(argv[++i]);
		else if (a === "--primary-arm") o.primaryArm = argv[++i];
		else if (a === "--shadow-arm") o.shadowArm = argv[++i];
		else if (a === "--out-primary") o.outPrimary = argv[++i];
		else if (a === "--out-shadow") o.outShadow = argv[++i];
		else if (a === "--ack-2x" || a === "--yes-burn-2x") o.ack2x = true;
		else if (a === "--keepalive-token") o.keepAliveToken = argv[++i];
		else if (a === "--require-arm") o.requireArm = true;
		else if (a === "-h" || a === "--help") o.help = true;
		else throw new Error(`unknown option: ${a}`);
	}
	return o;
}

const HELP = `paired shadow-mode tee — see header of benchmark/bin/tee.js

  node benchmark/bin/tee.js --listen-port 8788 \\
    --primary-port 8790 --shadow-port 8791 \\
    --out-primary runs/paired/A5.ndjson --out-shadow runs/paired/A0.ndjson

Point the driver at --listen-port; point claude (via the driver) at the tee.
Name outputs A5.ndjson / A0.ndjson so analyze.js labels them by basename.

COST: shadow mode bills your Anthropic quota ~2x for the run (every turn goes
to both arms). The tee REFUSES to start non-interactively without --ack-2x, and
prompts on a TTY. Pass --ack-2x to acknowledge.

  --keepalive-token T   route a PTY keep-alive ping (a /v1/messages turn whose
                        last user message is exactly T, e.g. the driver's
                        --keepalive-token) to PRIMARY only — never billed,
                        shadowed, paired, or logged. Off if unset.
  --require-arm         gate pairing on an out-of-band control channel: the tee
                        pairs a turn ONLY while the driver has armed the window
                        (POST /__tee/arm before a real prompt, /__tee/disarm for
                        the gap). While disarmed, every /v1/messages routes
                        primary-only, so Claude Code side-channels fired during a
                        gap (auto-title gen, triggered by the 🔥 ping) can't warm
                        the cold A0 baseline. Pair with the driver's --tee-arm.
`;

// Build the tee HTTP server. Writers (objects exposing `write(record)`) are
// injected so tests can capture records in memory; `main` passes file-backed
// writers. Returns { server, stats() } — stats() reports pairs assigned and
// shadow requests still in flight, used by the shutdown banner and by tests.
export function createTeeServer({
	host,
	primaryPort,
	shadowPort,
	primaryArm = "treatment",
	shadowArm = "passthrough",
	primaryWriter,
	shadowWriter,
	keepAliveToken = null,
	requireArm = false,
	nearMissCapture = process.env.TEE_NEARMISS_CAPTURE ?? null,
}) {
	let pairSeq = 0;
	let inflight = 0;
	// Pairing-window state, flipped by the driver via /__tee/arm | /__tee/disarm.
	// Only consulted when requireArm is on (see shouldPair). Default DISARMED so a
	// gated run pairs nothing until the driver explicitly arms a real prompt — the
	// safe failure mode (a missed arm under-drives the run; it never contaminates
	// the cold baseline).
	let armed = false;

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const url = new URL(req.url, "http://localhost");
			const pathname = url.pathname;
			// Out-of-band control channel (driver → tee, localhost): arm/disarm the
			// pairing window. Handled locally and answered immediately — NEVER
			// forwarded to an upstream and adds nothing to the Anthropic wire, so it
			// preserves production fidelity (the tee invents no bytes claude didn't
			// send). Claude only ever calls /v1/* and /, so /__tee/* cannot collide.
			if (pathname === "/__tee/arm" || pathname === "/__tee/disarm") {
				armed = pathname === "/__tee/arm";
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ armed }));
				return;
			}
			const reqPath = req.url; // preserve query string for the upstream
			const headers = upstreamHeaders(req.headers);
			// A keep-alive ping is forwarded to PRIMARY only (to refresh the bearer
			// + re-warm the cache key on the live session) but is NOT billable: no
			// shadow, no pairSeq, no record. Otherwise the A0 baseline would be
			// warmed by our own ping and the paired reclaim would be understated.
			const isPost = isBillable(req.method, pathname);
			const isPing = isPost && isKeepAlivePing(body, keepAliveToken);
			const billable = shouldPair({ isPost, isPing, requireArm, armed });
			// Diagnostic only (no-op unless TEE_NEARMISS_CAPTURE is set): record a
			// decorated-ping near-miss so the regression test uses a real body.
			if (nearMissCapture && isPost)
				captureNearMiss(nearMissCapture, {
					body,
					token: keepAliveToken,
					matched: isPing,
				});
			const ts = new Date().toISOString();
			const seq = billable ? ++pairSeq : null;
			const model = billable ? parseModel(body) : null;

			// SHADOW (A0): fire-and-forget, concurrent, response discarded. claude
			// never waits on it. Only for billable turns.
			if (billable) {
				inflight++;
				forward(
					{
						host,
						port: shadowPort,
						method: req.method,
						reqPath,
						headers,
						body,
					},
					null,
				)
					.then((r) => {
						if (r.usage)
							shadowWriter.write(
								makeRecord({
									ts,
									arm: shadowArm,
									pairSeq: seq,
									model,
									usage: r.usage,
									httpStatus: r.httpStatus,
									wallMs: r.wallMs,
									ttftMs: r.ttftMs,
								}),
							);
					})
					.catch(() => {})
					.finally(() => {
						inflight--;
					});
			}

			// PRIMARY (A5): streamed back to claude verbatim.
			let headWritten = false;
			forward(
				{
					host,
					port: primaryPort,
					method: req.method,
					reqPath,
					headers,
					body,
				},
				(ev) => {
					if (ev.kind === "head") {
						headWritten = true;
						res.writeHead(ev.res.statusCode ?? 502, ev.res.headers);
					} else if (ev.kind === "data") {
						res.write(ev.chunk);
					} else if (ev.kind === "end") {
						res.end();
					} else if (ev.kind === "error") {
						if (!headWritten) res.writeHead(502);
						res.end();
					}
				},
			)
				.then((r) => {
					if (billable && r.usage)
						primaryWriter.write(
							makeRecord({
								ts,
								arm: primaryArm,
								pairSeq: seq,
								model,
								usage: r.usage,
								httpStatus: r.httpStatus,
								wallMs: r.wallMs,
								ttftMs: r.ttftMs,
							}),
						);
				})
				.catch(() => {
					if (!headWritten) {
						try {
							res.writeHead(502);
							res.end();
						} catch {
							/* client gone */
						}
					}
				});
		});
		req.on("error", () => {
			try {
				res.writeHead(400);
				res.end();
			} catch {
				/* client gone */
			}
		});
	});

	return {
		server,
		stats: () => ({ pairs: pairSeq, inflight, armed }),
	};
}

function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) {
		process.stdout.write(HELP);
		return;
	}
	if (!o.outPrimary || !o.outShadow)
		throw new Error("--out-primary and --out-shadow are required");

	// 2x-cost guard: warn loudly, then require an explicit ack (switch on a TTY
	// prompt, or --ack-2x for scripts) before we start fanning real traffic to
	// both arms. Banner -> stderr so stdout stays clean for the `[tee]` lines a
	// wrapper may parse.
	process.stderr.write(shadowCostBanner());
	const decision = resolveAck({
		ack: o.ack2x,
		isTTY: Boolean(process.stdin.isTTY),
	});
	if (!decision.proceed && !decision.needsPrompt) {
		process.stderr.write(`[tee] refusing to start: ${decision.reason}\n`);
		process.exitCode = 2;
		return;
	}
	if (decision.needsPrompt) {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
		});
		rl.question(
			"[tee] proceed and burn ~2x tokens? type 'yes' to continue: ",
			(ans) => {
				rl.close();
				if (String(ans).trim().toLowerCase() === "yes") {
					startServer(o);
				} else {
					process.stderr.write("[tee] aborted — no confirmation given\n");
					process.exitCode = 2;
				}
			},
		);
		return;
	}
	startServer(o);
}

function startServer(o) {
	const primaryW = makeWriter(o.outPrimary);
	const shadowW = makeWriter(o.outShadow);
	const { server, stats } = createTeeServer({
		host: o.host,
		primaryPort: o.primaryPort,
		shadowPort: o.shadowPort,
		primaryArm: o.primaryArm,
		shadowArm: o.shadowArm,
		primaryWriter: primaryW,
		shadowWriter: shadowW,
		keepAliveToken: o.keepAliveToken,
		requireArm: o.requireArm,
	});

	server.listen(o.listenPort, o.host, () => {
		process.stdout.write(
			`[tee] listening on http://${o.host}:${o.listenPort} ` +
				`-> primary(${o.primaryArm}) :${o.primaryPort}, shadow(${o.shadowArm}) :${o.shadowPort}\n`,
		);
		process.stdout.write(
			`[tee] primary -> ${o.outPrimary}\n[tee] shadow  -> ${o.outShadow}\n`,
		);
		if (o.keepAliveToken)
			process.stdout.write(
				`[tee] keep-alive ping token '${o.keepAliveToken}' -> primary-only (never billed/shadowed/paired)\n`,
			);
		if (o.requireArm)
			process.stdout.write(
				"[tee] armed-pairing gate ON: pairing requires /__tee/arm (driver --tee-arm); disarmed traffic is primary-only\n",
			);
	});

	const shutdown = () => {
		const s = stats();
		process.stdout.write(
			`\n[tee] shutting down (${s.pairs} turns paired, ${s.inflight} shadow(s) in flight)\n`,
		);
		server.close(() => {
			primaryW.close();
			shadowW.close();
			process.exit(0);
		});
		// Don't hang forever on a stuck socket.
		setTimeout(() => {
			primaryW.close();
			shadowW.close();
			process.exit(0);
		}, 3000).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
