import { parseRateLimit, tokensResetIso } from "../src/rate_limit.js";

test("parses integer and reset headers", () => {
	const rl = parseRateLimit({
		"anthropic-ratelimit-tokens-remaining": "1234",
		"anthropic-ratelimit-tokens-reset": "2026-04-18T10:00:00Z",
		"anthropic-ratelimit-requests-remaining": "99",
		unrelated: "skip",
	});
	expect(rl.tokens_remaining).toBe(1234);
	expect(rl.tokens_reset).toBe("2026-04-18T10:00:00.000Z");
	expect(rl.requests_remaining).toBe(99);
});

test("tokensResetIso extracts main reset header", () => {
	const iso = tokensResetIso({
		"anthropic-ratelimit-tokens-reset": "2026-04-18T10:00:00Z",
	});
	expect(iso).toBe("2026-04-18T10:00:00.000Z");
});

test("returns null for missing or invalid reset", () => {
	expect(tokensResetIso({})).toBeNull();
	expect(
		tokensResetIso({ "anthropic-ratelimit-tokens-reset": "garbage" }),
	).toBeNull();
});

test("skips non-numeric integer headers", () => {
	const rl = parseRateLimit({
		"anthropic-ratelimit-tokens-remaining": "not-a-number",
	});
	expect(rl.tokens_remaining).toBeUndefined();
});
