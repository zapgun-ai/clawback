import {
	STRIP_PATTERNS,
	computeFingerprints,
	stripEphemeral,
} from "../src/fingerprint.js";

describe("stripEphemeral", () => {
	test("returns null for null system", () => {
		expect(stripEphemeral(null).stripped).toBeNull();
		expect(stripEphemeral(null).removed).toEqual([]);
	});

	test("strips iso dates from string system", () => {
		const { stripped, removed } = stripEphemeral("today: 2026-04-24 ok");
		expect(stripped).toBe("today: <DATE> ok");
		expect(removed).toEqual([{ pattern: "iso-date", value: "2026-04-24" }]);
	});

	test("strips 'Today's date is ...' sentence before the bare date pattern", () => {
		const { stripped, removed } = stripEphemeral(
			"Today's date is 2026-04-24. Rest of system.",
		);
		expect(stripped).toBe("Today's date is <DATE>. Rest of system.");
		expect(removed.some((r) => r.pattern === "today-date-sentence")).toBe(true);
	});

	test("strips <env> blocks", () => {
		const input = "preamble <env>cwd: /x\nrepo: foo</env> tail";
		const { stripped, removed } = stripEphemeral(input);
		expect(stripped).toBe("preamble <env><STRIPPED></env> tail");
		expect(removed.some((r) => r.pattern === "env-block")).toBe(true);
	});

	test("handles array-of-blocks system", () => {
		const system = [
			{ type: "text", text: "Today's date is 2026-04-24." },
			{ type: "text", text: "be helpful" },
		];
		const { stripped, removed } = stripEphemeral(system);
		expect(stripped).toEqual([
			{ type: "text", text: "Today's date is <DATE>." },
			{ type: "text", text: "be helpful" },
		]);
		expect(removed.length).toBeGreaterThan(0);
	});

	test("passes non-text blocks through unchanged", () => {
		const system = [{ type: "image", source: { data: "..." } }];
		const { stripped, removed } = stripEphemeral(system);
		expect(stripped).toEqual(system);
		expect(removed).toEqual([]);
	});

	test("each STRIP_PATTERN has a unique name", () => {
		const names = STRIP_PATTERNS.map((p) => p.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("normalizes the rotating Claude Code billing-cch token", () => {
		const a =
			"x-anthropic-billing-header: cc_version=2.1.119.ccb; cc_entrypoint=cli; cch=6da5c;";
		const b =
			"x-anthropic-billing-header: cc_version=2.1.119.ccb; cc_entrypoint=cli; cch=8f31f;";
		const sa = stripEphemeral(a);
		const sb = stripEphemeral(b);
		expect(sa.stripped).toBe(sb.stripped);
		expect(sa.stripped).toContain("cch=<CCH>");
		expect(sa.removed.find((r) => r.pattern === "billing-cch")).toBeTruthy();
	});

	test("billing-cch normalization preserves cc_version and cc_entrypoint", () => {
		const text =
			"x-anthropic-billing-header: cc_version=2.1.119.ccb; cc_entrypoint=cli; cch=abcdef;";
		const { stripped } = stripEphemeral(text);
		expect(stripped).toContain("cc_version=2.1.119.ccb");
		expect(stripped).toContain("cc_entrypoint=cli");
		expect(stripped).not.toContain("abcdef");
	});
});

describe("computeFingerprints", () => {
	const tools = [{ name: "Bash" }, { name: "Edit" }];

	test("is deterministic for the same input", () => {
		const a = computeFingerprints({ system: "x", tools });
		const b = computeFingerprints({ system: "x", tools });
		expect(a).toEqual(b);
	});

	test("systemStableKey is identical under date rotation", () => {
		const day1 = computeFingerprints({
			system: "You are helpful. Today's date is 2026-04-24.",
			tools,
		});
		const day2 = computeFingerprints({
			system: "You are helpful. Today's date is 2026-04-25.",
			tools,
		});
		expect(day1.systemStableKey).toBe(day2.systemStableKey);
		expect(day1.toolsKey).toBe(day2.toolsKey);
	});

	test("systemStableKey is identical under <env> rotation", () => {
		const before = computeFingerprints({
			system: "prefix <env>cwd: /a\nbranch: main</env> tail",
			tools,
		});
		const after = computeFingerprints({
			system: "prefix <env>cwd: /a\nbranch: feature\nmodified: x.js</env> tail",
			tools,
		});
		expect(before.systemStableKey).toBe(after.systemStableKey);
	});

	test("toolsKey changes when tools change", () => {
		const a = computeFingerprints({ system: "x", tools });
		const b = computeFingerprints({
			system: "x",
			tools: [...tools, { name: "Write" }],
		});
		expect(a.toolsKey).not.toBe(b.toolsKey);
	});

	test("systemStableKey changes when non-date system content changes", () => {
		const a = computeFingerprints({
			system: "You are helpful. Today's date is 2026-04-24.",
			tools,
		});
		const b = computeFingerprints({
			system: "You are ruthless. Today's date is 2026-04-24.",
			tools,
		});
		expect(a.systemStableKey).not.toBe(b.systemStableKey);
	});

	test("key ordering inside tools does not matter", () => {
		const toolsA = [{ name: "Bash", schema: { a: 1, b: 2 } }];
		const toolsB = [{ name: "Bash", schema: { b: 2, a: 1 } }];
		const a = computeFingerprints({ system: "x", tools: toolsA });
		const b = computeFingerprints({ system: "x", tools: toolsB });
		expect(a.toolsKey).toBe(b.toolsKey);
	});

	test("strippedSystemPreview reports pattern counts", () => {
		const fp = computeFingerprints({
			system: "Today's date is 2026-04-24. Also 2026-04-24 again. <env>x</env>",
			tools,
		});
		const preview = fp.strippedSystemPreview;
		const names = preview.map((p) => p.pattern);
		expect(names).toEqual(expect.arrayContaining(["iso-date", "env-block"]));
		const isoDate = preview.find((p) => p.pattern === "iso-date");
		expect(isoDate.count).toBeGreaterThanOrEqual(1);
		expect(isoDate.sample).toMatch(/2026-04-24/);
	});

	test("handles null system / null tools", () => {
		const fp = computeFingerprints({ system: null, tools: null });
		expect(typeof fp.toolsKey).toBe("string");
		expect(fp.toolsKey).toHaveLength(64);
		expect(typeof fp.systemStableKey).toBe("string");
		expect(fp.systemStableKey).toHaveLength(64);
		expect(fp.strippedSystemPreview).toEqual([]);
	});
});
