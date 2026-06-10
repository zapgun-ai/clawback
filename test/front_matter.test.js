import { parseFrontMatter, stringifyFrontMatter } from "../src/front_matter.js";

describe("parseFrontMatter", () => {
	test("parses a flat scalar mapping between fences", () => {
		const { data, body } = parseFrontMatter(
			[
				"---",
				'host: "0.0.0.0"',
				"port: 8787",
				"passthrough: false",
				"---",
				"",
			].join("\n"),
		);
		expect(data).toEqual({ host: "0.0.0.0", port: 8787, passthrough: false });
		expect(body).toBe("");
	});

	test("round-trips a hostile adminToken (':' '#' '\"' '\\\\')", () => {
		const secret = 'a:b#c"d\\e';
		const text = stringifyFrontMatter({ adminToken: secret });
		const { data } = parseFrontMatter(text);
		expect(data.adminToken).toBe(secret);
	});

	test("a numeric-looking quoted string stays a string", () => {
		const { data } = parseFrontMatter(
			["---", 'agentId: "01234"', "---", ""].join("\n"),
		);
		expect(data.agentId).toBe("01234");
	});

	test("a bare number parses as a number, not a string", () => {
		const { data } = parseFrontMatter(
			["---", "keepAliveMinMs: 240000", "ratio: -1.5e3", "---", ""].join("\n"),
		);
		expect(data.keepAliveMinMs).toBe(240000);
		expect(data.ratio).toBe(-1500);
	});

	test("booleans and null parse to JS primitives", () => {
		const { data } = parseFrontMatter(
			["---", "a: true", "b: false", "c: null", "d: ~", "e:", "---", ""].join(
				"\n",
			),
		);
		expect(data).toEqual({ a: true, b: false, c: null, d: null, e: null });
	});

	test("skips comment and blank lines inside the fence", () => {
		const { data } = parseFrontMatter(
			[
				"---",
				"# a comment",
				"",
				"port: 8787",
				"  # indented comment",
				"---",
			].join("\n"),
		);
		expect(data).toEqual({ port: 8787 });
	});

	test("returns the markdown body after the closing fence", () => {
		const { data, body } = parseFrontMatter(
			["---", "port: 8787", "---", "", "# Title", "", "prose here"].join("\n"),
		);
		expect(data).toEqual({ port: 8787 });
		expect(body).toBe("\n# Title\n\nprose here");
	});

	test("tolerates a leading BOM", () => {
		const { data } = parseFrontMatter(
			`﻿${["---", "port: 8787", "---"].join("\n")}`,
		);
		expect(data).toEqual({ port: 8787 });
	});

	test("accepts CRLF line endings", () => {
		const { data, body } = parseFrontMatter(
			["---", "port: 8787", "---", "body"].join("\r\n"),
		);
		expect(data).toEqual({ port: 8787 });
		expect(body).toBe("body");
	});

	test("reads a hand-edited single-quoted scalar with doubled-quote escape", () => {
		const { data } = parseFrontMatter(
			["---", "note: 'it''s fine'", "---"].join("\n"),
		);
		expect(data.note).toBe("it's fine");
	});

	test("throws when the document does not open with a fence", () => {
		expect(() => parseFrontMatter("port: 8787\n")).toThrow(
			/front-matter fence/,
		);
	});

	test("throws on an unterminated fence", () => {
		expect(() => parseFrontMatter("---\nport: 8787\n")).toThrow(/unterminated/);
	});

	test("throws on a line missing a colon", () => {
		expect(() => parseFrontMatter("---\nport 8787\n---\n")).toThrow(
			/expected "key: value"/,
		);
	});

	test("throws on an empty key", () => {
		expect(() => parseFrontMatter("---\n: 8787\n---\n")).toThrow(/empty key/);
	});

	test("throws on a non-string input", () => {
		expect(() => parseFrontMatter(null)).toThrow(TypeError);
	});
});

describe("stringifyFrontMatter", () => {
	test("emits a fenced mapping with double-quoted strings", () => {
		const out = stringifyFrontMatter({ host: "0.0.0.0", port: 8787 });
		expect(out).toBe('---\nhost: "0.0.0.0"\nport: 8787\n---\n');
	});

	test("skips undefined values and runtime-only (underscore) keys", () => {
		const out = stringifyFrontMatter({
			port: 8787,
			missing: undefined,
			_baselineSnapshot: { huge: true },
		});
		expect(out).toBe("---\nport: 8787\n---\n");
	});

	test("appends a markdown body after a blank line", () => {
		const out = stringifyFrontMatter({ port: 8787 }, "# Title\n\nprose");
		expect(out).toBe("---\nport: 8787\n---\n\n# Title\n\nprose\n");
	});

	test("serializes null/boolean/number literally", () => {
		const out = stringifyFrontMatter({ a: null, b: true, c: 0, d: -1.5 });
		expect(out).toBe("---\na: null\nb: true\nc: 0\nd: -1.5\n---\n");
	});

	test("throws on a non-plain-object input", () => {
		expect(() => stringifyFrontMatter(null)).toThrow(TypeError);
		expect(() => stringifyFrontMatter([1, 2])).toThrow(TypeError);
	});

	test("throws on a nested (non-scalar) value", () => {
		expect(() => stringifyFrontMatter({ nested: { a: 1 } })).toThrow(
			/flat scalars only/,
		);
	});

	test("throws on a non-finite number", () => {
		expect(() => stringifyFrontMatter({ x: Number.POSITIVE_INFINITY })).toThrow(
			/non-finite/,
		);
	});
});

describe("round-trip", () => {
	test("a full config object survives stringify -> parse", () => {
		const config = {
			host: "127.0.0.1",
			port: 8787,
			passthrough: false,
			keepAliveEnabled: true,
			keepAliveMinMs: 240000,
			adminToken: 'secret:with#weird"chars\\and more',
			remoteUrl: null,
		};
		const { data } = parseFrontMatter(stringifyFrontMatter(config));
		expect(data).toEqual(config);
	});
});
