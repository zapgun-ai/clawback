import { isCapped, processObservation } from "../src/auto_continue.js";

const ON = {
	autoContinue: true,
	autoContinueText: "continue\r",
	autoContinueCooldownMs: 5 * 60 * 1000,
};
const OFF = { autoContinue: false };

describe("isCapped", () => {
	test("HTTP 429 alone is enough", () => {
		expect(isCapped({ httpStatus: 429 })).toBe(true);
	});

	test("tokens_remaining=0 is enough", () => {
		expect(isCapped({ rateLimit: { tokens_remaining: 0 } })).toBe(true);
	});

	test("input_tokens_remaining=0 is enough", () => {
		expect(isCapped({ rateLimit: { input_tokens_remaining: 0 } })).toBe(true);
	});

	test("output_tokens_remaining=0 is enough", () => {
		expect(isCapped({ rateLimit: { output_tokens_remaining: 0 } })).toBe(true);
	});

	test("any positive remaining means not capped (even if other fields missing)", () => {
		expect(isCapped({ rateLimit: { tokens_remaining: 1 } })).toBe(false);
		expect(isCapped({ rateLimit: { tokens_remaining: 100000 } })).toBe(false);
	});

	test("missing data is not capped", () => {
		expect(isCapped({})).toBe(false);
		expect(isCapped({ rateLimit: {} })).toBe(false);
		expect(isCapped({ rateLimit: null })).toBe(false);
	});
});

describe("processObservation — auto-continue disabled", () => {
	test("returns no updates and no fire when autoContinue is off", () => {
		const r = processObservation({
			session: { capState: "capped" },
			rateLimit: { tokens_remaining: 1000 },
			httpStatus: 200,
			config: OFF,
			now: new Date("2026-04-28T12:00:00Z"),
		});
		expect(r.updates).toBeNull();
		expect(r.fireText).toBeNull();
	});
});

describe("processObservation — capped → cleared transitions", () => {
	const now = new Date("2026-04-28T12:00:00Z");

	test("normal + capped observation → marks capState capped, no fire", () => {
		const r = processObservation({
			session: { capState: "normal" },
			rateLimit: { tokens_remaining: 0 },
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.updates).toEqual({
			capState: "capped",
			cappedAt: now.toISOString(),
		});
		expect(r.fireText).toBeNull();
	});

	test("capped + cleared observation (no prior fire) → fires and resets state", () => {
		const r = processObservation({
			session: { capState: "capped" },
			rateLimit: { tokens_remaining: 50000 },
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.fireText).toBe("continue\r");
		expect(r.updates.capState).toBe("normal");
		expect(r.updates.capClearedAt).toBe(now.toISOString());
		expect(r.updates.lastAutoContinueFiredAt).toBe(now.toISOString());
		expect(r.updates.autoContinueFires).toBe(1);
	});

	test("capped + cleared but cooldown active → reset state without firing", () => {
		const recent = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
		const r = processObservation({
			session: {
				capState: "capped",
				lastAutoContinueFiredAt: recent,
			},
			rateLimit: { tokens_remaining: 50000 },
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.fireText).toBeNull();
		expect(r.updates).toEqual({
			capState: "normal",
			capClearedAt: now.toISOString(),
		});
	});

	test("capped + cleared with cooldown elapsed → fires", () => {
		const ago = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
		const r = processObservation({
			session: {
				capState: "capped",
				lastAutoContinueFiredAt: ago,
				autoContinueFires: 3,
			},
			rateLimit: { tokens_remaining: 50000 },
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.fireText).toBe("continue\r");
		expect(r.updates.autoContinueFires).toBe(4);
	});

	test("normal + cleared observation → no transition, no fire", () => {
		const r = processObservation({
			session: { capState: "normal" },
			rateLimit: { tokens_remaining: 50000 },
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.updates).toBeNull();
		expect(r.fireText).toBeNull();
	});

	test("capped + capped observation again → idempotent, no updates", () => {
		const r = processObservation({
			session: { capState: "capped", cappedAt: "2026-04-28T11:00:00Z" },
			rateLimit: { tokens_remaining: 0 },
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.updates).toBeNull();
		expect(r.fireText).toBeNull();
	});

	test("HTTP 429 alone (no rate-limit headers) marks capped", () => {
		const r = processObservation({
			session: { capState: "normal" },
			rateLimit: null,
			httpStatus: 429,
			config: ON,
			now,
		});
		expect(r.updates.capState).toBe("capped");
	});

	test("autoContinueText override is respected", () => {
		const r = processObservation({
			session: { capState: "capped" },
			rateLimit: { tokens_remaining: 1 },
			httpStatus: 200,
			config: { ...ON, autoContinueText: "go on\n" },
			now,
		});
		expect(r.fireText).toBe("go on\n");
	});

	test("missing session is a no-op", () => {
		const r = processObservation({
			session: null,
			rateLimit: {},
			httpStatus: 200,
			config: ON,
			now,
		});
		expect(r.updates).toBeNull();
		expect(r.fireText).toBeNull();
	});
});
