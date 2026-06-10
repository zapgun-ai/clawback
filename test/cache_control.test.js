import {
	hasNestedCacheControl,
	injectIntoBody,
	resolvedTtlMode,
} from "../src/cache_control.js";

const ON = { injectExtendedCacheTtl: true, rewriteNestedCacheControl: true };
const OFF = { injectExtendedCacheTtl: false };
const ON_LEGACY = {
	injectExtendedCacheTtl: true,
	rewriteNestedCacheControl: false,
};
const STRIP = { stripExtendedCacheTtl: true };
const STRIP_AND_INJECT = {
	stripExtendedCacheTtl: true,
	injectExtendedCacheTtl: true,
	rewriteNestedCacheControl: true,
};

function parseBody(out) {
	expect(out.body).toBeInstanceOf(Buffer);
	return JSON.parse(out.body.toString("utf8"));
}

describe("injectIntoBody — top-level injection (no nested cache_control)", () => {
	test("injects {ttl:1h} on a plain body with system + tools", () => {
		const body = {
			model: "claude-opus-4-5",
			system: "x",
			tools: [{ name: "Bash" }],
			messages: [{ role: "user", content: "hi" }],
		};
		const out = injectIntoBody(body, ON);
		const parsed = parseBody(out);
		expect(parsed.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(out.telemetry).toMatchObject({
			eligible: true,
			topLevelAdded: true,
			blocksRewritten: 0,
			alreadyExtended: 0,
			ttlMode: "1h",
		});
	});

	test("returns null body when injection is off", () => {
		const out = injectIntoBody({ system: "x" }, OFF);
		expect(out.body).toBeNull();
		expect(out.telemetry.ttlMode).toBe("5m");
	});

	test("knob-off arm still observes client cache_control for telemetry", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "x",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		};
		const out = injectIntoBody(body, OFF);
		expect(out.body).toBeNull();
		expect(out.telemetry).toMatchObject({
			eligible: true,
			alreadyExtended: 1,
			ttlMode: "1h",
		});
	});

	test("returns null body when there's nothing cacheable (no system, no tools, no cache_control)", () => {
		const out = injectIntoBody({ messages: [] }, ON);
		expect(out.body).toBeNull();
		expect(out.telemetry.eligible).toBe(false);
	});

	test("returns null body on malformed body", () => {
		expect(injectIntoBody(null, ON).body).toBeNull();
		expect(injectIntoBody("string", ON).body).toBeNull();
		expect(injectIntoBody([], ON).body).toBeNull();
	});
});

describe("hasNestedCacheControl — block-level detection", () => {
	test("detects cache_control on a system block", () => {
		const body = {
			system: [
				{ type: "text", text: "you are helpful" },
				{
					type: "text",
					text: "longer prefix...",
					cache_control: { type: "ephemeral", ttl: "5m" },
				},
			],
		};
		expect(hasNestedCacheControl(body)).toBe(true);
	});

	test("detects cache_control on a tool", () => {
		const body = {
			tools: [
				{ name: "Bash" },
				{ name: "Edit", cache_control: { type: "ephemeral", ttl: "5m" } },
			],
		};
		expect(hasNestedCacheControl(body)).toBe(true);
	});

	test("detects cache_control on a content block inside messages", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hi" },
						{
							type: "text",
							text: "context",
							cache_control: { type: "ephemeral", ttl: "5m" },
						},
					],
				},
			],
		};
		expect(hasNestedCacheControl(body)).toBe(true);
	});

	test("returns false for a body with no nested cache_control anywhere", () => {
		const body = {
			system: [{ type: "text", text: "x" }],
			tools: [{ name: "Bash" }],
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		};
		expect(hasNestedCacheControl(body)).toBe(false);
	});

	test("string-form system + string-form content do not crash", () => {
		const body = {
			system: "you are helpful",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(hasNestedCacheControl(body)).toBe(false);
	});
});

describe("injectIntoBody — nested cache_control rewrite (the Claude Code path)", () => {
	test("rewrites a 5m nested block on system to ttl=1h", () => {
		const body = {
			system: [
				{ type: "text", text: "you are helpful" },
				{
					type: "text",
					text: "longer cached prefix",
					cache_control: { type: "ephemeral", ttl: "5m" },
				},
			],
			messages: [{ role: "user", content: "hi" }],
		};
		const out = injectIntoBody(body, ON);
		const parsed = parseBody(out);
		expect(parsed.system[1].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(parsed.cache_control).toBeUndefined(); // no top-level added
		expect(out.telemetry).toMatchObject({
			eligible: true,
			topLevelAdded: false,
			blocksRewritten: 1,
			ttlMode: "1h",
		});
	});

	test("rewrites an implicit-ttl nested block (the dominant Claude Code shape)", () => {
		// Claude Code sends `cache_control: {type: "ephemeral"}` with no
		// ttl field → Anthropic defaults to 5m. This is the case the
		// pre-rewrite implementation silently let pass at 5m.
		const body = {
			system: [
				{
					type: "text",
					text: "prefix",
					cache_control: { type: "ephemeral" },
				},
			],
			tools: [{ name: "Bash" }],
		};
		const out = injectIntoBody(body, ON);
		const parsed = parseBody(out);
		expect(parsed.system[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(out.telemetry.blocksRewritten).toBe(1);
	});

	test("rewrites multiple nested blocks across system, tools, and messages in one turn", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral" },
				},
			],
			tools: [
				{ name: "Bash", cache_control: { type: "ephemeral", ttl: "5m" } },
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "ctx",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};
		const out = injectIntoBody(body, ON);
		const parsed = parseBody(out);
		expect(parsed.system[0].cache_control.ttl).toBe("1h");
		expect(parsed.tools[0].cache_control.ttl).toBe("1h");
		expect(parsed.messages[0].content[0].cache_control.ttl).toBe("1h");
		expect(out.telemetry.blocksRewritten).toBe(3);
		expect(out.telemetry.rewriteTurns).toBeUndefined(); // per-turn, not multi
	});

	test("leaves already-1h blocks alone and counts them as alreadyExtended", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		};
		const out = injectIntoBody(body, ON);
		expect(out.body).toBeNull(); // nothing changed
		expect(out.telemetry).toMatchObject({
			eligible: true,
			topLevelAdded: false,
			blocksRewritten: 0,
			alreadyExtended: 1,
			ttlMode: "1h",
		});
	});

	test("rewrites a 5m top-level cache_control to 1h", () => {
		const body = {
			system: "x",
			cache_control: { type: "ephemeral", ttl: "5m" },
		};
		const out = injectIntoBody(body, ON);
		const parsed = parseBody(out);
		expect(parsed.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(out.telemetry.blocksRewritten).toBe(1);
	});

	test("counts non-ephemeral cache_control as skipped, doesn't mutate", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "something-else" },
				},
			],
		};
		const out = injectIntoBody(body, ON);
		expect(out.body).toBeNull();
		expect(out.telemetry.nonEphemeralSkipped).toBe(1);
		expect(out.telemetry.blocksRewritten).toBe(0);
	});
});

describe("injectIntoBody — thinking/redacted_thinking blocks are immutable", () => {
	// Anthropic rejects any `thinking`/`redacted_thinking` block in the latest
	// assistant message that differs from what it originally produced — they're
	// signed and must round-trip untouched ("these blocks must remain as they
	// were in the original response", HTTP 400). Claude Code attaches a
	// cache_control breakpoint at/after such a block, so the 1h rewrite walks
	// straight into it and bumps the ttl, mutating the block → 400. The rewrite
	// must extend everything else but leave these two block types alone.
	test("does not bump cache_control ttl on a thinking block", () => {
		const body = {
			system: [
				{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } },
			],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "answer" },
						{
							type: "thinking",
							thinking: "reasoning",
							signature: "sig-abc",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};
		injectIntoBody(body, ON);
		// the ordinary system block still gets extended...
		expect(body.system[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		// ...but the thinking block must be left exactly as the client sent it.
		expect(body.messages[1].content[1].cache_control).toEqual({
			type: "ephemeral",
		});
	});

	test("does not bump cache_control ttl on a redacted_thinking block", () => {
		const body = {
			system: [
				{ type: "text", text: "prefix", cache_control: { type: "ephemeral" } },
			],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "redacted_thinking",
							data: "encrypted-blob",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};
		injectIntoBody(body, ON);
		expect(body.system[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(body.messages[0].content[0].cache_control).toEqual({
			type: "ephemeral",
		});
	});
});

describe("injectIntoBody — legacy mode (rewriteNestedCacheControl: false)", () => {
	test("skips the nested block, doesn't add top-level (no Anthropic 400)", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral", ttl: "5m" },
				},
			],
		};
		const out = injectIntoBody(body, ON_LEGACY);
		expect(out.body).toBeNull();
		expect(out.telemetry.blocksRewritten).toBe(0);
		expect(out.telemetry.topLevelAdded).toBe(false);
	});

	test("still does top-level injection when no nested cache_control exists", () => {
		const body = {
			system: "x",
			tools: [{ name: "Bash" }],
		};
		const out = injectIntoBody(body, ON_LEGACY);
		const parsed = parseBody(out);
		expect(parsed.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(out.telemetry.topLevelAdded).toBe(true);
	});
});

describe("injectIntoBody — strip-extended-cache-ttl (force documented 5m)", () => {
	// Mirror of the inject path. Claude Code natively breakpoints its system
	// prompt at 1h (undocumented); strip downgrades those back to Anthropic's
	// documented 5m default by deleting the `ttl` key. Strip WINS over inject
	// (early return) so a tight-loop operator can force 5m deterministically.
	test("strips a nested ttl:1h block back to the 5m default", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		};
		const out = injectIntoBody(body, STRIP);
		const parsed = parseBody(out);
		expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(out.telemetry).toMatchObject({
			eligible: true,
			blocksStripped: 1,
			ttlMode: "5m",
		});
	});

	test("strips a top-level ttl:1h block", () => {
		const body = {
			system: "x",
			cache_control: { type: "ephemeral", ttl: "1h" },
		};
		const out = injectIntoBody(body, STRIP);
		const parsed = parseBody(out);
		expect(parsed.cache_control).toEqual({ type: "ephemeral" });
		expect(out.telemetry.blocksStripped).toBe(1);
		expect(out.telemetry.ttlMode).toBe("5m");
	});

	test("leaves an already-5m block untouched (nothing to strip)", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral", ttl: "5m" },
				},
			],
		};
		const out = injectIntoBody(body, STRIP);
		expect(out.body).toBeNull();
		expect(out.telemetry.blocksStripped).toBe(0);
		expect(out.telemetry.ttlMode).toBe("5m");
	});

	test("strip WINS over inject when both are on", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		};
		const out = injectIntoBody(body, STRIP_AND_INJECT);
		const parsed = parseBody(out);
		expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(out.telemetry).toMatchObject({
			blocksStripped: 1,
			blocksRewritten: 0,
			ttlMode: "5m",
		});
	});

	test("strip mode suppresses 1h injection even with nothing to strip", () => {
		// A 5m block + both knobs on: strip returns before the rewrite loop, so
		// inject never bumps it. Strip mode means "force 5m" — a 5m block stays.
		const body = {
			system: [
				{ type: "text", text: "sys", cache_control: { type: "ephemeral" } },
			],
		};
		const out = injectIntoBody(body, STRIP_AND_INJECT);
		expect(out.body).toBeNull();
		expect(out.telemetry.blocksRewritten).toBe(0);
		expect(out.telemetry.blocksStripped).toBe(0);
		expect(out.telemetry.ttlMode).toBe("5m");
		expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
	});

	test("preserves a signed thinking block's 1h ttl while stripping the rest", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "prefix",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "reasoning",
							signature: "sig-abc",
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
					],
				},
			],
		};
		const out = injectIntoBody(body, STRIP);
		const parsed = parseBody(out);
		// ordinary system block downgraded to the 5m default...
		expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
		// ...but the signed thinking block keeps its 1h ttl byte-for-byte.
		expect(parsed.messages[0].content[0].cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(out.telemetry.blocksStripped).toBe(1);
		expect(out.telemetry.thinkingPreserved).toBe(1);
		// a surviving 1h (the thinking block we couldn't touch) keeps the
		// turn at 1h — ttlMode reflects what SURVIVES the strip.
		expect(out.telemetry.ttlMode).toBe("1h");
	});

	test("returns null body when strip is off (no mutation)", () => {
		const body = {
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		};
		const out = injectIntoBody(body, { stripExtendedCacheTtl: false });
		expect(out.body).toBeNull();
		expect(out.telemetry.blocksStripped).toBe(0);
	});
});

describe("resolvedTtlMode", () => {
	test("returns 1h when injection is on, 5m when off", () => {
		expect(resolvedTtlMode({ injectExtendedCacheTtl: true })).toBe("1h");
		expect(resolvedTtlMode({ injectExtendedCacheTtl: false })).toBe("5m");
	});

	test("strip forces 5m even when injection is on", () => {
		expect(
			resolvedTtlMode({
				stripExtendedCacheTtl: true,
				injectExtendedCacheTtl: true,
			}),
		).toBe("5m");
		expect(resolvedTtlMode({ stripExtendedCacheTtl: true })).toBe("5m");
	});
});
