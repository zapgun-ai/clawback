import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DEFAULTS } from "../src/config.js";
import { KeepAliveScheduler } from "../src/keepalive.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

// Why this file exists (the salt confound, #65/#66):
//
// Anthropic's prompt cache keys on the EXACT bytes we forward (the ANTHROPIC
// KEY, per CLAUDE.md). The proxy's forward path has two modes:
//
//   - passthrough / no-op: forward the client's pristine `bodyBuffer`.
//   - any content mutation (strip-ephemeral, 1h-TTL rewrite, mobile, and the
//     now-removed benchmark salt): forward `JSON.stringify(parsedBody)` —
//     RE-SERIALIZED bytes (src/server.js, src/cache_control.js).
//
// Re-serialization is only byte-faithful if the client's wire bytes were
// already in V8's canonical `JSON.stringify` form. A client that emits
// non-canonical JSON — escaped `\uXXXX` non-ASCII, escaped `\/`, HTML-escaped
// `<` — round-trips to DIFFERENT bytes, silently cold-starting the cache
// for the whole prefix. The benchmark `--cache-salt` tripped exactly this:
// it forced re-serialization on every treatment turn, which is why salted arms
// measured ~0% cache warming while the pristine passthrough baseline measured
// ~98%. The salt is gone; these tests lock in the invariant it violated AND
// verify the byte-faithfulness CANARY that now guards the residual production
// risk: when re-serialization would change a non-canonical client's bytes,
// clawback forwards the pristine body and skips the cache knobs
// (strip-ephemeral / 1h-TTL) rather than cold-start the very cache it exists
// to preserve.

const logger = createLogger("silent");

let upstream;
let upstreamPort;
let seenRawBodies = [];

beforeAll(async () => {
	upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			// Keep the EXACT bytes — this is what Anthropic content-addresses.
			seenRawBodies.push(Buffer.concat(chunks));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
			res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = upstream.address().port;
});

afterAll(() => {
	upstream?.close();
});

function setup(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-bf-"));
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		upstream: `http://127.0.0.1:${upstreamPort}`,
		stateFile: path.join(dir, "state.json"),
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const scheduler = new KeepAliveScheduler({
		config,
		store,
		logger,
		fetchImpl: async () => ({ ok: true, status: 200, outputTokens: 1 }),
	});
	const server = createServer({ config, store, scheduler, logger });
	return { config, store, scheduler, server, dir };
}

async function listen(server) {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server.address().port;
}

function teardown({ scheduler, server, dir }) {
	scheduler.stop();
	server.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

// Send EXACT bytes — unlike proxy_e2e's postJson, this never re-canonicalizes
// the body, so we can put non-canonical JSON (escaped \uXXXX) on the wire the
// way a non-V8 client would.
function postRaw(port, urlPath, rawBody) {
	const payload = Buffer.from(rawBody, "utf8");
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				method: "POST",
				host: "127.0.0.1",
				port,
				path: urlPath,
				headers: {
					"content-type": "application/json",
					"content-length": payload.length,
					authorization: "Bearer test-key",
					"anthropic-version": "2023-06-01",
				},
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
		req.end(payload);
	});
}

// A Claude-Code-shaped body whose system text carries an EM DASH written as an
// escaped `—` on the wire (6 ASCII chars: backslash u 2 0 1 4). V8's
// JSON.stringify would emit the literal UTF-8 em dash instead, so this is the
// canonical "non-canonical client" probe.
function wireWithEscapedDash({ nestedCacheControl }) {
	const stableBlock = nestedCacheControl
		? '{"type":"text","text":"tool guidance","cache_control":{"type":"ephemeral"}}'
		: '{"type":"text","text":"tool guidance"}';
	return [
		"{",
		'"model":"claude-haiku-4-5-20251001",',
		'"max_tokens":1,',
		'"system":[',
		'{"type":"text","text":"You are Claude \\u2014 a helpful assistant"},',
		stableBlock,
		"],",
		'"messages":[{"role":"user","content":"hi"}]',
		"}",
	].join("");
}

describe("forward-path byte faithfulness (the salt-confound invariant)", () => {
	test("passthrough forwards non-canonical wire bytes byte-for-byte", async () => {
		seenRawBodies = [];
		const ctx = setup({
			passthrough: true,
			injectExtendedCacheTtl: false,
			stripEphemeralFromSystem: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			const wire = wireWithEscapedDash({ nestedCacheControl: false });
			const res = await postRaw(port, "/v1/messages", wire);
			expect(res.status).toBe(200);
			expect(seenRawBodies).toHaveLength(1);

			// The whole point of A0: Anthropic must receive the client's exact
			// bytes, so its content-addressed cache key matches turn to turn.
			// The escaped — survives verbatim — no re-serialization.
			expect(seenRawBodies[0].equals(Buffer.from(wire, "utf8"))).toBe(true);
			expect(seenRawBodies[0].toString("utf8")).toContain("\\u2014");
		} finally {
			teardown(ctx);
		}
	});

	// The canary in action. A content-mutating knob (1h-TTL) would normally
	// re-serialize the whole body, which de-escapes the — in an unrelated
	// system block and changes the cached-prefix bytes — cold-starting the very
	// cache the knob exists to extend. The byte-faithfulness canary detects
	// that this client is non-canonical (round-trip would change bytes) and
	// FALLS BACK: forward the pristine wire bytes, skip the rewrite. Better to
	// no-op the knob than to silently break the cache.
	test("canary: non-canonical client + 1h-TTL falls back to pristine bytes", async () => {
		seenRawBodies = [];
		const ctx = setup({
			passthrough: false,
			injectExtendedCacheTtl: true,
			rewriteNestedCacheControl: true,
			stripEphemeralFromSystem: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			const wire = wireWithEscapedDash({ nestedCacheControl: true });
			const res = await postRaw(port, "/v1/messages", wire);
			expect(res.status).toBe(200);
			expect(seenRawBodies).toHaveLength(1);
			const fwd = seenRawBodies[0];

			// Canary fired: clawback forwarded the client's EXACT wire bytes…
			expect(fwd.equals(Buffer.from(wire, "utf8"))).toBe(true);
			// …so the escaped — survives verbatim (no de-escaping cold-start)…
			expect(fwd.toString("utf8")).toContain("\\u2014");
			// …and the 1h rewrite was SKIPPED rather than corrupt the cache key.
			expect(fwd.toString("utf8")).not.toContain('"ttl":"1h"');
		} finally {
			teardown(ctx);
		}
	});

	// The other half of the canary: it must not be a blunt instrument. A
	// CANONICAL client (bytes already in V8 `JSON.stringify` form, as real
	// Claude Code's SDK emits) round-trips identically, so re-serialization is
	// byte-faithful and the knob applies as intended — no false fallback.
	test("canary: canonical client still gets the 1h-TTL rewrite (no false positive)", async () => {
		seenRawBodies = [];
		const ctx = setup({
			passthrough: false,
			injectExtendedCacheTtl: true,
			rewriteNestedCacheControl: true,
			stripEphemeralFromSystem: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			// Canonical by construction: JSON.stringify of a real object is
			// exactly what JSON.parse→JSON.stringify round-trips to, so the
			// canary stays silent. The literal em dash is V8-canonical (V8 does
			// not escape it), unlike the — wire form above.
			const wire = JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 1,
				system: [
					{ type: "text", text: "You are Claude — a helpful assistant" },
					{
						type: "text",
						text: "tool guidance",
						cache_control: { type: "ephemeral" },
					},
				],
				messages: [{ role: "user", content: "hi" }],
			});
			const res = await postRaw(port, "/v1/messages", wire);
			expect(res.status).toBe(200);
			expect(seenRawBodies).toHaveLength(1);
			const fwd = seenRawBodies[0].toString("utf8");

			// No false canary: the knob applied (nested ephemeral bumped to 1h)…
			expect(fwd).toContain('"ttl":"1h"');
			// …and the literal em dash is still literal (it always was canonical).
			expect(fwd).toContain("—");
		} finally {
			teardown(ctx);
		}
	});
});

// The other half of "byte faithfulness": when a knob DOES legitimately mutate
// (canonical client, canary silent), it must touch ONLY the bytes it intends
// and leave every unrelated byte — system text, tool defs, message content —
// exactly as the client sent them. A mutation that collaterally re-shapes an
// unrelated block changes the ANTHROPIC KEY just as surely as the salt did.
describe("forward-path mutations change only the intended bytes", () => {
	test("1h-TTL rewrite bumps only the nested cache_control ttl, nothing else", async () => {
		seenRawBodies = [];
		const ctx = setup({
			passthrough: false,
			injectExtendedCacheTtl: true,
			rewriteNestedCacheControl: true,
			stripEphemeralFromSystem: false,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			const original = {
				model: "claude-haiku-4-5-20251001",
				max_tokens: 7,
				system: [
					{ type: "text", text: "SENTINEL-SYS preserve me exactly" },
					{
						type: "text",
						text: "tool guidance",
						cache_control: { type: "ephemeral" },
					},
				],
				tools: [
					{
						name: "SENTINEL_TOOL_read",
						description: "reads a file",
						input_schema: { type: "object" },
					},
				],
				messages: [{ role: "user", content: "SENTINEL-MSG hello" }],
			};
			// Canonical wire (JSON.stringify of an object) so the canary stays
			// silent and the real mutation path runs.
			const wire = JSON.stringify(original);
			const res = await postRaw(port, "/v1/messages", wire);
			expect(res.status).toBe(200);
			expect(seenRawBodies).toHaveLength(1);
			const fwd = seenRawBodies[0].toString("utf8");

			// Mutation applied: the one nested ephemeral block became 1h.
			expect(fwd).toContain('"ttl":"1h"');
			// Collateral bytes survive verbatim — unrelated system text, the tool
			// name, and the message content are all present unchanged.
			expect(fwd).toContain("SENTINEL-SYS preserve me exactly");
			expect(fwd).toContain("SENTINEL_TOOL_read");
			expect(fwd).toContain("SENTINEL-MSG hello");

			// Strongest claim: the forwarded body equals the original with ONLY
			// system[1].cache_control.ttl added. No other field moved or changed.
			const expected = JSON.parse(JSON.stringify(original));
			expected.system[1].cache_control = { type: "ephemeral", ttl: "1h" };
			expect(JSON.parse(fwd)).toEqual(expected);
		} finally {
			teardown(ctx);
		}
	});

	test("strip-ephemeral rewrites only the volatile system span, not messages/tools", async () => {
		seenRawBodies = [];
		const ctx = setup({
			passthrough: false,
			injectExtendedCacheTtl: false,
			stripEphemeralFromSystem: true,
			keepAliveEnabled: false,
		});
		const port = await listen(ctx.server);
		try {
			const original = {
				model: "claude-haiku-4-5-20251001",
				max_tokens: 7,
				system: [
					{
						type: "text",
						text: "Project log entry 2026-06-02 SENTINEL-SYS keep me",
					},
					{
						type: "text",
						text: "tool guidance",
						cache_control: { type: "ephemeral" },
					},
				],
				tools: [
					{
						name: "SENTINEL_TOOL_read",
						description: "reads a file",
						input_schema: { type: "object" },
					},
				],
				// The same volatile ISO date lives in the message too. strip-ephemeral
				// is scoped to `system` ONLY, so this copy must survive untouched —
				// proof the strip doesn't reach unrelated parts of the body.
				messages: [{ role: "user", content: "SENTINEL-MSG hello 2026-06-02" }],
			};
			const wire = JSON.stringify(original);
			const res = await postRaw(port, "/v1/messages", wire);
			expect(res.status).toBe(200);
			expect(seenRawBodies).toHaveLength(1);
			const fwdObj = JSON.parse(seenRawBodies[0].toString("utf8"));

			// Mutation applied: the ISO date in system collapsed to <DATE>.
			expect(fwdObj.system[0].text).toBe(
				"Project log entry <DATE> SENTINEL-SYS keep me",
			);
			// Collateral preservation: the date in the MESSAGE is untouched (strip
			// is scoped to system), and the nested cache_control + tool are intact.
			expect(fwdObj.messages[0].content).toBe("SENTINEL-MSG hello 2026-06-02");

			// Strongest claim: forwarded body equals the original with ONLY the one
			// system text span rewritten. Everything else is byte-for-byte identical.
			const expected = JSON.parse(JSON.stringify(original));
			expected.system[0].text = "Project log entry <DATE> SENTINEL-SYS keep me";
			expect(fwdObj).toEqual(expected);
		} finally {
			teardown(ctx);
		}
	});
});
