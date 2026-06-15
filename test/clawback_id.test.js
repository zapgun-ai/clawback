import {
	composeSessionLabel,
	extractClawbackArgs,
	mintClawbackId,
	sanitizeHostSegment,
	validateClawbackId,
	validateLabel,
} from "../src/clawback_id.js";

describe("mintClawbackId", () => {
	test("produces 8 hex chars", () => {
		const id = mintClawbackId();
		expect(id).toMatch(/^[0-9a-f]{8}$/);
	});

	test("collisions are statistically negligible across small batches", () => {
		const ids = new Set();
		for (let i = 0; i < 1000; i++) ids.add(mintClawbackId());
		// 1000 picks from 2^32 → expected collisions ≪ 1. Allow 1 slop
		// for paranoia, but a real collision here would be a red flag.
		expect(ids.size).toBeGreaterThanOrEqual(999);
	});
});

describe("validateLabel", () => {
	test("accepts simple labels", () => {
		expect(validateLabel("red")).toBe("red");
		expect(validateLabel("branch-foo")).toBe("branch-foo");
		expect(validateLabel("v1.2.3")).toBe("v1.2.3");
	});

	test("trims surrounding whitespace", () => {
		expect(validateLabel("  trimmed  ")).toBe("trimmed");
	});

	test("allows internal space (after first char)", () => {
		expect(validateLabel("branch foo")).toBe("branch foo");
	});

	test("rejects empty and overlong", () => {
		// Max bumped 32 → 64 (2026-05-28) for the `<host>:<label>` prefix.
		expect(() => validateLabel("")).toThrow(/1-64/);
		expect(() => validateLabel("   ")).toThrow(/1-64/);
		expect(() => validateLabel("x".repeat(65))).toThrow(/1-64/);
		// 33–64 chars are now valid (were not before the bump).
		expect(validateLabel("x".repeat(33))).toBe("x".repeat(33));
		expect(validateLabel("x".repeat(64))).toBe("x".repeat(64));
	});

	test("allows a colon as the host/label separator (not as first char)", () => {
		expect(validateLabel("alexmac:branch-foo")).toBe("alexmac:branch-foo");
		expect(validateLabel("alexmac:branch foo")).toBe("alexmac:branch foo");
		// Leading colon would let a bare label masquerade as host-prefixed.
		expect(() => validateLabel(":nohost")).toThrow();
	});

	test("allows '@' (subsequent only) for the detached-HEAD auto label", () => {
		// computeDefaultSessionLabel mints `<repo>:@<short-sha>` for a detached
		// HEAD; the server gate must accept it. Not valid as the first char.
		expect(validateLabel("clawback:@a1b2c3d")).toBe("clawback:@a1b2c3d");
		expect(() => validateLabel("@head")).toThrow();
	});

	test("rejects path-unsafe and control chars", () => {
		expect(() => validateLabel("with/slash")).toThrow();
		expect(() => validateLabel("with\nnewline")).toThrow();
		expect(() => validateLabel("with\ttab")).toThrow();
	});

	test("rejects leading space", () => {
		// Trim makes leading space disappear, so " foo" actually validates as "foo".
		// But " " with non-empty after-trim trimmed-down to "" already throws above.
		// The constraint we DO want: " foo " trims to "foo" and is accepted.
		expect(validateLabel(" foo ")).toBe("foo");
	});

	test("rejects reserved sentinels", () => {
		expect(() => validateLabel("_default")).toThrow(/reserved/);
		expect(() => validateLabel("_aggregate")).toThrow(/reserved/);
	});

	test("rejects non-string input", () => {
		expect(() => validateLabel(null)).toThrow();
		expect(() => validateLabel(42)).toThrow();
		expect(() => validateLabel(undefined)).toThrow();
	});
});

describe("sanitizeHostSegment", () => {
	test("strips the domain suffix", () => {
		expect(sanitizeHostSegment("Alexs-MacBook-Pro.local")).toBe(
			"Alexs-MacBook-Pro",
		);
		expect(sanitizeHostSegment("devbox.example.com")).toBe("devbox");
	});

	test("passes a plain short hostname through unchanged", () => {
		expect(sanitizeHostSegment("alexmac")).toBe("alexmac");
	});

	test("replaces unsafe chars and trims punctuation", () => {
		expect(sanitizeHostSegment("weird host!name")).toBe("weird-host-name");
		expect(sanitizeHostSegment("-leading.trailing-")).toBe("leading");
	});

	test("caps at 24 chars", () => {
		expect(sanitizeHostSegment("a".repeat(40))).toBe("a".repeat(24));
	});

	test("returns null for empty / non-string / nothing-usable", () => {
		expect(sanitizeHostSegment("")).toBeNull();
		expect(sanitizeHostSegment(null)).toBeNull();
		expect(sanitizeHostSegment(42)).toBeNull();
		expect(sanitizeHostSegment("...")).toBeNull();
	});

	test("output is always a valid label segment (composes cleanly)", () => {
		const host = sanitizeHostSegment("Alexs-MacBook-Pro.local");
		// The composed `host:id` must pass validateLabel (server re-checks it).
		expect(() =>
			validateLabel(composeSessionLabel(host, "a3f9b2c1")),
		).not.toThrow();
	});
});

describe("composeSessionLabel", () => {
	test("joins host and base with a colon", () => {
		expect(composeSessionLabel("alexmac", "a3f9b2c1")).toBe("alexmac:a3f9b2c1");
		expect(composeSessionLabel("alexmac", "branch foo")).toBe(
			"alexmac:branch foo",
		);
	});

	test("caps the composed label at 64 chars", () => {
		const out = composeSessionLabel("h".repeat(24), "b".repeat(60));
		expect(out.length).toBe(64);
		expect(out.startsWith("hhhhhhhhhhhhhhhhhhhhhhhh:")).toBe(true);
	});
});

describe("validateClawbackId", () => {
	test("accepts minted ids", () => {
		const id = mintClawbackId();
		expect(validateClawbackId(id)).toBe(id);
	});

	test("accepts claude-style UUIDs", () => {
		const uuid = "01985f3c-9f1b-7e2d-9abc-1234567890ab";
		expect(validateClawbackId(uuid)).toBe(uuid);
	});

	test("rejects leading underscore (would collide with router reservation)", () => {
		expect(() => validateClawbackId("_default")).toThrow();
		expect(() => validateClawbackId("_proxy")).toThrow();
	});

	test("rejects reserved tokens", () => {
		expect(() => validateClawbackId("v1")).toThrow(/reserved/);
		expect(() => validateClawbackId("_proxy")).toThrow();
	});

	test("rejects path-unsafe chars", () => {
		expect(() => validateClawbackId("with/slash")).toThrow();
		expect(() => validateClawbackId("with space")).toThrow();
		expect(() => validateClawbackId("with?query")).toThrow();
	});

	test("rejects empty and overlong", () => {
		expect(() => validateClawbackId("")).toThrow();
		expect(() => validateClawbackId("x".repeat(65))).toThrow();
	});
});

describe("extractClawbackArgs", () => {
	const mintFn = () => "MINTED_ID";

	test("no flags → mints an id, no label, no passthrough surprises", () => {
		const r = extractClawbackArgs([], { mintFn });
		expect(r.passthrough).toEqual([]);
		expect(r.clawbackId).toBe("MINTED_ID");
		expect(r.clawbackIdSource).toBe("minted");
		expect(r.clawbackLabel).toBeNull();
	});

	test("--label <name> is intercepted, NOT forwarded to claude", () => {
		const r = extractClawbackArgs(["--label", "red", "--other"], { mintFn });
		expect(r.clawbackLabel).toBe("red");
		expect(r.passthrough).toEqual(["--other"]);
		expect(r.clawbackId).toBe("MINTED_ID");
	});

	test("--label=value (equals form) also intercepted", () => {
		const r = extractClawbackArgs(["--label=blue-thing", "--keep"], { mintFn });
		expect(r.clawbackLabel).toBe("blue-thing");
		expect(r.passthrough).toEqual(["--keep"]);
	});

	test("--resume <id> is observed AND forwarded; id becomes clawback id", () => {
		const r = extractClawbackArgs(["--resume", "abc123", "--other"], {
			mintFn,
		});
		expect(r.clawbackId).toBe("abc123");
		expect(r.clawbackIdSource).toBe("resume");
		expect(r.passthrough).toEqual(["--resume", "abc123", "--other"]);
	});

	test("--resume=<id> (equals form) is also observed AND forwarded", () => {
		const r = extractClawbackArgs(["--resume=abc123"], { mintFn });
		expect(r.clawbackId).toBe("abc123");
		expect(r.clawbackIdSource).toBe("resume");
		expect(r.passthrough).toEqual(["--resume=abc123"]);
	});

	test("-r short form also recognized as --resume", () => {
		const r = extractClawbackArgs(["-r", "abc123"], { mintFn });
		expect(r.clawbackId).toBe("abc123");
		expect(r.passthrough).toEqual(["-r", "abc123"]);
	});

	test("args after `--` are treated as opaque (claude's flags, not ours)", () => {
		// A claude flag named "--label" after `--` must NOT be intercepted.
		const r = extractClawbackArgs(["--", "--label", "claude-flag"], { mintFn });
		expect(r.clawbackLabel).toBeNull();
		expect(r.passthrough).toEqual(["--", "--label", "claude-flag"]);
	});

	test("--label without a value throws", () => {
		expect(() => extractClawbackArgs(["--label"], { mintFn })).toThrow(
			/--label requires a value/,
		);
		expect(() =>
			extractClawbackArgs(["--label", "--next-flag"], { mintFn }),
		).toThrow(/--label requires a value/);
	});

	test("invalid label value rejected via validateLabel", () => {
		expect(() =>
			extractClawbackArgs(["--label", "_default"], { mintFn }),
		).toThrow(/reserved/);
	});

	test("invalid --resume id rejected via validateClawbackId", () => {
		expect(() =>
			extractClawbackArgs(["--resume", "_bad"], { mintFn }),
		).toThrow();
	});

	test("--remote <url> is intercepted, NOT forwarded to claude", () => {
		const r = extractClawbackArgs(
			["--remote", "http://clawback.example:8888", "--other"],
			{ mintFn },
		);
		expect(r.remoteUrl).toBe("http://clawback.example:8888");
		expect(r.passthrough).toEqual(["--other"]);
	});

	test("--remote=<url> (equals form) also intercepted", () => {
		const r = extractClawbackArgs(
			["--remote=https://clawback.example:8888", "--keep"],
			{ mintFn },
		);
		expect(r.remoteUrl).toBe("https://clawback.example:8888");
		expect(r.passthrough).toEqual(["--keep"]);
	});

	test("default (no --remote) → remoteUrl is null", () => {
		const r = extractClawbackArgs([], { mintFn });
		expect(r.remoteUrl).toBeNull();
	});

	test("--remote without a value throws", () => {
		expect(() => extractClawbackArgs(["--remote"], { mintFn })).toThrow(
			/--remote requires a URL/,
		);
		expect(() =>
			extractClawbackArgs(["--remote", "--next-flag"], { mintFn }),
		).toThrow(/--remote requires a URL/);
	});

	test("--remote= (empty value) throws", () => {
		expect(() => extractClawbackArgs(["--remote="], { mintFn })).toThrow(
			/--remote requires a URL/,
		);
	});

	test("--remote <url> is intercepted, NOT forwarded to claude", () => {
		const r = extractClawbackArgs(
			["--remote", "http://clawback.example:8888", "--other"],
			{ mintFn },
		);
		expect(r.remoteUrl).toBe("http://clawback.example:8888");
		expect(r.passthrough).toEqual(["--other"]);
	});

	test("--remote=<url> (equals form) also intercepted", () => {
		const r = extractClawbackArgs(
			["--remote=https://clawback.example:8888", "--keep"],
			{ mintFn },
		);
		expect(r.remoteUrl).toBe("https://clawback.example:8888");
		expect(r.passthrough).toEqual(["--keep"]);
	});

	test("default (no --remote) → remoteUrl is null", () => {
		const r = extractClawbackArgs([], { mintFn });
		expect(r.remoteUrl).toBeNull();
	});

	test("--remote without a value throws", () => {
		expect(() => extractClawbackArgs(["--remote"], { mintFn })).toThrow(
			/--remote requires a URL/,
		);
		expect(() =>
			extractClawbackArgs(["--remote", "--next-flag"], { mintFn }),
		).toThrow(/--remote requires a URL/);
	});

	test("--remote= (empty value) throws", () => {
		expect(() => extractClawbackArgs(["--remote="], { mintFn })).toThrow(
			/--remote requires a URL/,
		);
	});
});
