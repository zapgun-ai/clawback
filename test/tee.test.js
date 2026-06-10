import http from "node:http";
import {
	createTeeServer,
	isBillable,
	isKeepAlivePing,
	makeRecord,
	parseModel,
	resolveAck,
	shadowCostBanner,
	shouldPair,
	upstreamHeaders,
} from "../benchmark/bin/tee.js";

// ---- pure helpers ------------------------------------------------------

describe("tee pure helpers", () => {
	test("isBillable matches only POST /v1/messages", () => {
		expect(isBillable("POST", "/v1/messages")).toBe(true);
		expect(isBillable("POST", "/v1/messages/count_tokens")).toBe(false);
		expect(isBillable("GET", "/v1/messages")).toBe(false);
		expect(isBillable("POST", "/v1/models")).toBe(false);
	});

	test("upstreamHeaders drops hop-by-hop but keeps auth and anthropic headers", () => {
		const out = upstreamHeaders({
			host: "tee:8788",
			connection: "keep-alive",
			"content-length": "123",
			"transfer-encoding": "chunked",
			authorization: "Bearer oauth-xyz",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "prompt-caching",
			"content-type": "application/json",
		});
		expect(out.authorization).toBe("Bearer oauth-xyz");
		expect(out["anthropic-version"]).toBe("2023-06-01");
		expect(out["anthropic-beta"]).toBe("prompt-caching");
		expect(out["content-type"]).toBe("application/json");
		expect(out.host).toBeUndefined();
		expect(out.connection).toBeUndefined();
		expect(out["content-length"]).toBeUndefined();
		expect(out["transfer-encoding"]).toBeUndefined();
	});

	test("parseModel reads model off a JSON body, null otherwise", () => {
		expect(parseModel(Buffer.from(JSON.stringify({ model: "claude-x" })))).toBe(
			"claude-x",
		);
		expect(parseModel(Buffer.from("not json"))).toBeNull();
		expect(parseModel(Buffer.from(JSON.stringify({ noModel: 1 })))).toBeNull();
	});

	test("shadowCostBanner is a loud warning that shadow mode doubles token spend", () => {
		const b = shadowCostBanner();
		// The whole point of the warning: it must name the 2x token cost so an
		// operator can't miss that this run bills against their quota twice.
		expect(b).toMatch(/2x|2×|twice|double/i);
		expect(b).toMatch(/token/i);
		// Loud, not a one-liner buried in startup noise.
		expect(b).toMatch(/WARNING/);
	});

	test("resolveAck: --ack-2x is the explicit switch — proceed, no prompt", () => {
		expect(resolveAck({ ack: true, isTTY: false })).toEqual({
			proceed: true,
			needsPrompt: false,
		});
		expect(resolveAck({ ack: true, isTTY: true })).toEqual({
			proceed: true,
			needsPrompt: false,
		});
	});

	test("resolveAck: interactive without the switch must prompt before burning 2x", () => {
		const d = resolveAck({ ack: false, isTTY: true });
		expect(d.proceed).toBe(false);
		expect(d.needsPrompt).toBe(true);
	});

	test("resolveAck: non-interactive without the switch refuses (no silent 2x spend)", () => {
		const d = resolveAck({ ack: false, isTTY: false });
		expect(d.proceed).toBe(false);
		expect(d.needsPrompt).toBe(false);
		expect(d.reason).toMatch(/ack-2x|acknowledg|2x/i);
	});

	test("makeRecord shapes the analyzer-compatible record", () => {
		const r = makeRecord({
			ts: "2026-06-01T00:00:00.000Z",
			arm: "treatment",
			pairSeq: 7,
			model: "claude-x",
			usage: { input_tokens: 1 },
			httpStatus: 200,
			wallMs: 12,
			ttftMs: 3,
		});
		expect(r).toEqual({
			ts: "2026-06-01T00:00:00.000Z",
			arm: "treatment",
			pairSeq: 7,
			model: "claude-x",
			usage: { input_tokens: 1 },
			httpStatus: 200,
			wallMs: 12,
			ttftMs: 3,
		});
	});

	test("isKeepAlivePing: last user message equal to the token is a ping", () => {
		// string content form
		const body = Buffer.from(
			JSON.stringify({
				model: "claude-x",
				messages: [
					{ role: "user", content: "real question" },
					{ role: "assistant", content: "an answer" },
					{ role: "user", content: "🔥" },
				],
			}),
		);
		expect(isKeepAlivePing(body, "🔥")).toBe(true);
		// content-as-blocks form (claude sends arrays of {type:'text'} blocks);
		// surrounding whitespace is tolerated.
		const blockBody = Buffer.from(
			JSON.stringify({
				messages: [{ role: "user", content: [{ type: "text", text: " 🔥 " }] }],
			}),
		);
		expect(isKeepAlivePing(blockBody, "🔥")).toBe(true);
	});

	test("isKeepAlivePing: a real prompt, wrong token, or non-ping shape is NOT a ping", () => {
		const real = Buffer.from(
			JSON.stringify({ messages: [{ role: "user", content: "refactor foo" }] }),
		);
		expect(isKeepAlivePing(real, "🔥")).toBe(false);
		// right shape, wrong token
		const wrong = Buffer.from(
			JSON.stringify({ messages: [{ role: "user", content: "🔥" }] }),
		);
		expect(isKeepAlivePing(wrong, "🌊")).toBe(false);
		// the ping must be the LAST message and from the user
		const lastAssistant = Buffer.from(
			JSON.stringify({
				messages: [
					{ role: "user", content: "🔥" },
					{ role: "assistant", content: "🔥" },
				],
			}),
		);
		expect(isKeepAlivePing(lastAssistant, "🔥")).toBe(false);
		// no token configured -> feature off -> never a ping
		expect(isKeepAlivePing(wrong, null)).toBe(false);
		// non-JSON / empty / no messages must not throw and must be false
		expect(isKeepAlivePing(Buffer.from("not json"), "🔥")).toBe(false);
		expect(isKeepAlivePing(Buffer.from(JSON.stringify({})), "🔥")).toBe(false);
		expect(
			isKeepAlivePing(Buffer.from(JSON.stringify({ messages: [] })), "🔥"),
		).toBe(false);
	});

	// Regression: paired-sonnet-L4-90min fanned every 🔥 to BOTH arms (60 turns
	// paired, shadow never went cold) because Claude Code DECORATES the turn at
	// send time. Captured off the wire (TEE_NEARMISS_CAPTURE): it PREPENDS
	// ephemeral context as its own <system-reminder>/<command-*> text blocks and
	// the user's typed text is the last, un-wrapped block. messageText() concats
	// all of it, so the old exact-match saw a ~16KB string and missed the ping.
	test("isKeepAlivePing: a 🔥 ping decorated with injected <system-reminder> blocks IS a ping", () => {
		const decoratedPing = Buffer.from(
			JSON.stringify({
				messages: [
					{ role: "user", content: "earlier question" },
					{ role: "assistant", content: "earlier answer" },
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "<system-reminder>\nThe following skills are available for use with the Skill tool:\n- smoke: ...\n</system-reminder>",
							},
							{
								type: "text",
								text: "<local-command-stdout></local-command-stdout>",
							},
							{ type: "text", text: "🔥" },
						],
					},
				],
			}),
		);
		expect(isKeepAlivePing(decoratedPing, "🔥")).toBe(true);
	});

	// The dangerous direction: an injected <system-reminder> can MENTION the token
	// (it carries the operator's MEMORY.md index, whose entry titles can contain
	// 🔥). A real, user-typed turn must NOT be mistaken for a ping — else the tee
	// routes a billable turn primary-only and silently drops it from the paired
	// set. So detection keys on the USER-TYPED block, never on token presence.
	test("isKeepAlivePing: a real turn whose injected reminder merely MENTIONS 🔥 is NOT a ping", () => {
		const realTurnWithTokenInReminder = Buffer.from(
			JSON.stringify({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "<system-reminder>\nMEMORY.md index:\n- 🔥 keep-alive detection bug invalidates L4 runs\n</system-reminder>",
							},
							{ type: "text", text: "Reply with exactly: ok" },
						],
					},
				],
			}),
		);
		expect(isKeepAlivePing(realTurnWithTokenInReminder, "🔥")).toBe(false);
	});
});

// ---- armed-pairing gate (shouldPair) ----------------------------------

// The keep-alive contamination has a SECOND vector beyond the 🔥 ping itself:
// Claude Code fires side-channel requests (auto-title generation) during the
// idle gap — and in the shakedown one fired 0.66s AFTER the primary-only 🔥
// turn (claude's notable 🔥 response triggered the title gen). It is NOT the
// token, so isKeepAlivePing can't catch it; the tee fanned it to BOTH arms and
// re-warmed the cold A0 baseline (runs/shakedown-sonnet-max-L3-20260605-083226
// A0.ndjson pairSeq 4: cr=34397, thinking=0). The robust guard is a gate: the
// tee pairs ONLY while the DRIVER has armed the window (around a real prompt);
// during the gap it is disarmed, so EVERY side-channel routes primary-only.
describe("shouldPair (armed-pairing gate)", () => {
	test("ungated (requireArm=false) keeps the old behavior: every non-ping POST pairs", () => {
		expect(
			shouldPair({
				isPost: true,
				isPing: false,
				requireArm: false,
				armed: false,
			}),
		).toBe(true);
		expect(
			shouldPair({
				isPost: true,
				isPing: false,
				requireArm: false,
				armed: true,
			}),
		).toBe(true);
	});

	test("ungated: a ping or a non-POST never pairs", () => {
		expect(
			shouldPair({
				isPost: true,
				isPing: true,
				requireArm: false,
				armed: true,
			}),
		).toBe(false);
		expect(
			shouldPair({
				isPost: false,
				isPing: false,
				requireArm: false,
				armed: true,
			}),
		).toBe(false);
	});

	test("gated (requireArm=true): a non-ping POST pairs ONLY while armed — the contamination guard", () => {
		// THE BUG, stated as a boolean: a side-channel (CC auto-title gen) firing
		// during a DISARMED idle/keep-alive gap must NOT pair, or it warms the
		// cold A0 baseline and the >60min reclaim is invalid.
		expect(
			shouldPair({
				isPost: true,
				isPing: false,
				requireArm: true,
				armed: false,
			}),
		).toBe(false);
		expect(
			shouldPair({
				isPost: true,
				isPing: false,
				requireArm: true,
				armed: true,
			}),
		).toBe(true);
	});

	test("gated: a 🔥 ping is primary-only even while armed (defense in depth)", () => {
		expect(
			shouldPair({ isPost: true, isPing: true, requireArm: true, armed: true }),
		).toBe(false);
	});
});

// ---- integration: fan-out + paired records ----------------------------

// Minimal Anthropic-style SSE body: message_start carries cache/input usage,
// message_delta carries the final stop_reason + output_tokens. clawback's tap
// (which the tee reuses) merges them into one usage object.
function sseBody(startUsage, deltaUsage) {
	const ev = (type, obj) =>
		`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
	return (
		ev("message_start", { message: { id: "msg_test", usage: startUsage } }) +
		ev("message_delta", {
			delta: { stop_reason: "end_turn" },
			usage: deltaUsage,
		}) +
		ev("message_stop", {})
	);
}

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function post(port, reqPath, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const data = Buffer.from(body ?? "");
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path: reqPath,
				headers: { "content-type": "application/json", ...headers },
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(data);
	});
}

function get(port, reqPath) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method: "GET", path: reqPath },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

async function waitFor(cond, ms = 2000) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return cond();
}

describe("tee fan-out and paired logging", () => {
	let primaryUp;
	let shadowUp;
	let tee;
	let primaryRecs;
	let shadowRecs;
	let primarySeen;
	let shadowSeen;
	const PRIMARY_SSE = sseBody(
		{
			input_tokens: 10,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 90,
		},
		{ output_tokens: 5 },
	);
	const SHADOW_SSE = sseBody(
		{
			input_tokens: 120,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		{ output_tokens: 5 },
	);

	beforeAll(async () => {
		primarySeen = [];
		shadowSeen = [];
		primaryRecs = [];
		shadowRecs = [];

		primaryUp = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				primarySeen.push({
					method: req.method,
					url: req.url,
					headers: req.headers,
				});
				if (req.method === "POST" && req.url === "/v1/messages") {
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.end(PRIMARY_SSE);
				} else {
					res.writeHead(200, { "content-type": "application/json" });
					res.end("{}");
				}
			});
		});
		shadowUp = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				shadowSeen.push({
					method: req.method,
					url: req.url,
					headers: req.headers,
				});
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(SHADOW_SSE);
			});
		});
		const primaryPort = await listen(primaryUp);
		const shadowPort = await listen(shadowUp);
		const built = createTeeServer({
			host: "127.0.0.1",
			primaryPort,
			shadowPort,
			primaryWriter: { write: (r) => primaryRecs.push(r) },
			shadowWriter: { write: (r) => shadowRecs.push(r) },
		});
		tee = built.server;
		tee.teePort = await listen(tee);
	});

	afterAll(async () => {
		await close(tee);
		await close(primaryUp);
		await close(shadowUp);
	});

	test("a billable turn is streamed from primary and paired across both arms", async () => {
		const body = JSON.stringify({
			model: "claude-haiku-4-5-20251001",
			stream: true,
		});
		const res = await post(tee.teePort, "/v1/messages", body, {
			authorization: "Bearer oauth-xyz",
		});
		// claude sees the PRIMARY arm's bytes, verbatim.
		expect(res.status).toBe(200);
		expect(res.body).toBe(PRIMARY_SSE);

		await waitFor(() => primaryRecs.length >= 1 && shadowRecs.length >= 1);
		expect(primaryRecs).toHaveLength(1);
		expect(shadowRecs).toHaveLength(1);

		const p = primaryRecs[0];
		const s = shadowRecs[0];
		// Same internal pairSeq ties the two arms together.
		expect(p.pairSeq).toBe(1);
		expect(s.pairSeq).toBe(1);
		expect(p.arm).toBe("treatment");
		expect(s.arm).toBe("passthrough");
		// Each arm captured ITS OWN usage (10 billable vs 120 billable).
		expect(p.usage.input_tokens).toBe(10);
		expect(p.usage.output_tokens).toBe(5);
		expect(s.usage.input_tokens).toBe(120);
		expect(p.model).toBe("claude-haiku-4-5-20251001");
		expect(p.httpStatus).toBe(200);
	});

	test("the OAuth bearer is forwarded to both arms and NO pairing header crosses the wire", async () => {
		const both = [...primarySeen, ...shadowSeen].filter(
			(r) => r.url === "/v1/messages",
		);
		expect(both.length).toBeGreaterThanOrEqual(2);
		for (const seen of both) {
			expect(seen.headers.authorization).toBe("Bearer oauth-xyz");
			// The tee must add nothing Anthropic could see: no pairing/correlation
			// header on either upstream request.
			for (const name of Object.keys(seen.headers)) {
				expect(name.toLowerCase()).not.toMatch(/pair|correl|clawback/);
			}
		}
	});

	test("count_tokens and GETs are proxied to primary only — never shadowed or logged", async () => {
		const beforeP = primaryRecs.length;
		const beforeS = shadowRecs.length;
		const shadowHitsBefore = shadowSeen.length;

		await post(
			tee.teePort,
			"/v1/messages/count_tokens",
			JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
		);
		await get(tee.teePort, "/v1/models");

		// Give any (erroneous) async shadow a chance to land before asserting none did.
		await waitFor(() => false, 100);
		expect(primaryRecs.length).toBe(beforeP);
		expect(shadowRecs.length).toBe(beforeS);
		expect(shadowSeen.length).toBe(shadowHitsBefore);
		// But the primary DID see them (claude still works).
		expect(primarySeen.some((r) => r.url === "/v1/messages/count_tokens")).toBe(
			true,
		);
		expect(primarySeen.some((r) => r.url === "/v1/models")).toBe(true);
	});
});

// ---- keep-alive ping routing ------------------------------------------

// A PTY keep-alive ping is a real /v1/messages turn (it must hit the wire to
// refresh the bearer + re-warm the cache key) whose payload is exactly the
// driver's token. The tee must forward it to PRIMARY ONLY — never shadow it,
// never log it, never give it a pairSeq — or the A0 baseline gets warmed by our
// own ping and the paired reclaim is understated.
describe("tee keep-alive ping routing", () => {
	let primaryUp;
	let shadowUp;
	let tee;
	let primaryRecs;
	let shadowRecs;
	let primarySeen;
	let shadowSeen;
	let teeStats;
	const SSE = sseBody(
		{
			input_tokens: 10,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 90,
		},
		{ output_tokens: 5 },
	);

	beforeAll(async () => {
		primarySeen = [];
		shadowSeen = [];
		primaryRecs = [];
		shadowRecs = [];
		primaryUp = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				primarySeen.push({ method: req.method, url: req.url });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(SSE);
			});
		});
		shadowUp = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				shadowSeen.push({ method: req.method, url: req.url });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(SSE);
			});
		});
		const primaryPort = await listen(primaryUp);
		const shadowPort = await listen(shadowUp);
		const built = createTeeServer({
			host: "127.0.0.1",
			primaryPort,
			shadowPort,
			primaryWriter: { write: (r) => primaryRecs.push(r) },
			shadowWriter: { write: (r) => shadowRecs.push(r) },
			keepAliveToken: "🔥",
		});
		tee = built.server;
		teeStats = built.stats;
		tee.teePort = await listen(tee);
	});

	afterAll(async () => {
		await close(tee);
		await close(primaryUp);
		await close(shadowUp);
	});

	test("a 🔥 ping warms PRIMARY only — never shadowed, never logged, never paired", async () => {
		const body = JSON.stringify({
			model: "claude-sonnet-4-6",
			stream: true,
			messages: [{ role: "user", content: "🔥" }],
		});
		const res = await post(tee.teePort, "/v1/messages", body, {
			authorization: "Bearer oauth-xyz",
		});
		// The ping still streams back from primary — it IS a real turn on the wire.
		expect(res.status).toBe(200);
		expect(res.body).toBe(SSE);
		// Give any (erroneous) async shadow a chance to land before asserting none.
		await waitFor(() => false, 150);
		expect(primarySeen.some((r) => r.url === "/v1/messages")).toBe(true);
		expect(shadowSeen.length).toBe(0);
		expect(primaryRecs.length).toBe(0);
		expect(shadowRecs.length).toBe(0);
		// No pairSeq was consumed — the ping is invisible to the paired analyzer.
		expect(teeStats().pairs).toBe(0);
	});

	test("a real turn after a ping IS fanned to both arms and paired as pair 1", async () => {
		const body = JSON.stringify({
			model: "claude-sonnet-4-6",
			stream: true,
			messages: [{ role: "user", content: "refactor the parser" }],
		});
		const res = await post(tee.teePort, "/v1/messages", body, {
			authorization: "Bearer oauth-xyz",
		});
		expect(res.status).toBe(200);
		await waitFor(() => primaryRecs.length >= 1 && shadowRecs.length >= 1);
		expect(primaryRecs).toHaveLength(1);
		expect(shadowRecs).toHaveLength(1);
		// The skipped ping did NOT consume a pair number: the first REAL turn is
		// pair 1, not 2. This is the contamination guard, stated as a number.
		expect(primaryRecs[0].pairSeq).toBe(1);
		expect(shadowRecs[0].pairSeq).toBe(1);
		expect(teeStats().pairs).toBe(1);
	});
});

// ---- armed-pairing gate: end-to-end (--require-arm) --------------------

// With --require-arm, pairing is gated by an out-of-band control channel the
// driver drives (POST /__tee/arm before a real prompt, /__tee/disarm during the
// gap). This is the robust fix for the title-gen contamination: while disarmed,
// EVERY /v1/messages routes primary-only, so a side-channel CC fires in the gap
// (auto-title gen, itself triggered by the primary-only 🔥) can't warm the cold
// A0 baseline. The control requests must never reach the upstreams (production
// fidelity: nothing the tee invents crosses the wire to Anthropic).
describe("tee armed-pairing gate (--require-arm)", () => {
	let primaryUp;
	let shadowUp;
	let tee;
	let primaryRecs;
	let shadowRecs;
	let primarySeen;
	let shadowSeen;
	let teeStats;
	const SSE = sseBody(
		{
			input_tokens: 10,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 90,
		},
		{ output_tokens: 5 },
	);

	beforeAll(async () => {
		primarySeen = [];
		shadowSeen = [];
		primaryRecs = [];
		shadowRecs = [];
		primaryUp = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				primarySeen.push({ method: req.method, url: req.url });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(SSE);
			});
		});
		shadowUp = http.createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				shadowSeen.push({ method: req.method, url: req.url });
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(SSE);
			});
		});
		const primaryPort = await listen(primaryUp);
		const shadowPort = await listen(shadowUp);
		const built = createTeeServer({
			host: "127.0.0.1",
			primaryPort,
			shadowPort,
			primaryWriter: { write: (r) => primaryRecs.push(r) },
			shadowWriter: { write: (r) => shadowRecs.push(r) },
			keepAliveToken: "🔥",
			requireArm: true,
		});
		tee = built.server;
		teeStats = built.stats;
		tee.teePort = await listen(tee);
	});

	afterAll(async () => {
		await close(tee);
		await close(primaryUp);
		await close(shadowUp);
	});

	test("the /__tee/arm|disarm control path is handled locally — never forwarded upstream", async () => {
		const armed = await post(tee.teePort, "/__tee/arm", "");
		expect(armed.status).toBe(200);
		expect(JSON.parse(armed.body).armed).toBe(true);
		expect(teeStats().armed).toBe(true);
		const disarmed = await post(tee.teePort, "/__tee/disarm", "");
		expect(JSON.parse(disarmed.body).armed).toBe(false);
		expect(teeStats().armed).toBe(false);
		// Neither upstream ever saw a control request: it adds nothing to the wire.
		await waitFor(() => false, 50);
		expect(primarySeen.some((s) => s.url.startsWith("/__tee/"))).toBe(false);
		expect(shadowSeen.some((s) => s.url.startsWith("/__tee/"))).toBe(false);
		// And no pair was consumed by the control traffic.
		expect(teeStats().pairs).toBe(0);
	});

	test("while DISARMED, a non-ping side-channel turn is primary-only (the title-gen contamination guard)", async () => {
		await post(tee.teePort, "/__tee/disarm", "");
		const shadowHitsBefore = shadowSeen.length;
		// A Claude Code auto-title-generation-shaped request: a genuine
		// /v1/messages (NOT the 🔥 token), exactly the side-channel that fired
		// 0.66s after the 🔥 turn in the shakedown and got fanned to the shadow.
		const titleGen = JSON.stringify({
			model: "claude-sonnet-4-6",
			stream: true,
			messages: [
				{ role: "user", content: "summarize what this project does" },
				{ role: "assistant", content: "clawback is a local proxy…" },
				{
					role: "user",
					content: "Generate a concise 5-word title for this conversation.",
				},
			],
		});
		const res = await post(tee.teePort, "/v1/messages", titleGen, {
			authorization: "Bearer oauth-xyz",
		});
		// Still streamed from primary so claude keeps working…
		expect(res.status).toBe(200);
		expect(res.body).toBe(SSE);
		// …but the cold shadow NEVER saw it, and it was neither paired nor logged.
		await waitFor(() => false, 150);
		expect(shadowSeen.length).toBe(shadowHitsBefore);
		expect(shadowRecs.length).toBe(0);
		expect(primaryRecs.length).toBe(0);
		expect(teeStats().pairs).toBe(0);
	});

	test("ARM, then a real prompt IS fanned to both arms and paired as pair 1", async () => {
		await post(tee.teePort, "/__tee/arm", "");
		const real = JSON.stringify({
			model: "claude-sonnet-4-6",
			stream: true,
			messages: [{ role: "user", content: "refactor the parser" }],
		});
		const res = await post(tee.teePort, "/v1/messages", real, {
			authorization: "Bearer oauth-xyz",
		});
		expect(res.status).toBe(200);
		await waitFor(() => primaryRecs.length >= 1 && shadowRecs.length >= 1);
		expect(primaryRecs).toHaveLength(1);
		expect(shadowRecs).toHaveLength(1);
		// The disarmed side-channel above consumed NO pair number — the first real
		// armed turn is pair 1. This is the contamination guard, stated as a number.
		expect(primaryRecs[0].pairSeq).toBe(1);
		expect(shadowRecs[0].pairSeq).toBe(1);
		expect(teeStats().pairs).toBe(1);
	});

	test("while ARMED, a 🔥 ping is STILL primary-only (defense in depth over the gate)", async () => {
		await post(tee.teePort, "/__tee/arm", "");
		const shadowHitsBefore = shadowSeen.length;
		const pairsBefore = teeStats().pairs;
		const ping = JSON.stringify({
			model: "claude-sonnet-4-6",
			stream: true,
			messages: [{ role: "user", content: "🔥" }],
		});
		const res = await post(tee.teePort, "/v1/messages", ping, {
			authorization: "Bearer oauth-xyz",
		});
		expect(res.status).toBe(200);
		await waitFor(() => false, 150);
		// The ping warmed primary only; the shadow stayed cold and no pair landed.
		expect(shadowSeen.length).toBe(shadowHitsBefore);
		expect(teeStats().pairs).toBe(pairsBefore);
	});
});
