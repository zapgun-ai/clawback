import http from "node:http";
import { resetAccountQuota } from "../src/account_quota.js";
import { renderStatusline, resolveStatuslineColor } from "../src/admin.js";
import { DEFAULTS } from "../src/config.js";
import { appendEvent, clearEvents } from "../src/events_log.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

afterEach(() => {
	clearEvents();
	// Account-global quota is a process-global singleton; wipe it so a POST
	// in one test can't leak its observation into the next.
	resetAccountQuota();
});

describe("renderStatusline (pure)", () => {
	const baseCfg = { ...DEFAULTS };
	const fakeStore = { keys: () => [] };
	// Character class for any field graphic: sparkline blocks (U+2581-U+2588),
	// progress-bar eighths (U+2589-U+258F), and the light-shade track (U+2591).
	const GLYPH = "[\\u2581-\\u258F\\u2591]";

	test("renders just the brand when no claude session and no store data", () => {
		// Default prefix is empty. Every metric field is absent (nothing to
		// report), but the `clawback` brand mark always renders — so a fresh
		// proxy with nothing connected shows "clawback", not the empty string.
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStore,
		});
		expect(text).toBe("clawback");
	});

	test("ignores any events passed in (non-numeric event text is dropped)", () => {
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStore,
			events: [{ text: "auto-continue fired 9 bytes" }],
		});
		// Events contribute nothing; only the always-on brand renders.
		expect(text).toBe("clawback");
	});

	test("respects custom prefix", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslinePrefix: ">>> " },
			store: fakeStore,
		});
		// Prefix + the always-on brand (no metric fields to report).
		expect(text).toBe(">>> clawback");
	});

	test("truncates with ellipsis at statuslineMaxChars", () => {
		const fakeStoreWithSession = {
			keys: () => ["k1"],
			all: () => [
				{
					key: "k1",
					lastActivity: "2026-05-04T10:00:00Z",
					cacheReadTokens: 80,
					cacheCreationTokens: 10,
					cacheMissTokens: 10,
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 20 },
			store: fakeStoreWithSession,
			claudeSession: {
				context_window: {
					used_percentage: 42,
					current_usage: {
						input_tokens: 50,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 950,
					},
				},
			},
		});
		expect(text.length).toBe(20);
		expect(text.endsWith("…")).toBe(true);
	});

	// The TUI eviction-countdown field was dropped 2026-05-28 (operator
	// request: declutter the one-line statusline). The eviction concept
	// still lives in the web dashboard's `evict` column (formatEvictCell
	// in src/ui/app.js), which these statusline tests never covered.

	test("progressive truncation drops low-priority fields whole, not mid-glyph", () => {
		// At an intermediate cap the renderer should drop fields by priority
		// (week → quota → brand → tps → turn → cache → context-only) rather than
		// character-slicing. With this fixture the full line runs ~100+
		// chars; capping at 60 should leave context + at least one or two
		// higher-priority fields, with no trailing ellipsis.
		const fakeStoreWithSession = {
			keys: () => ["k1"],
			all: () => [
				{
					key: "k1",
					lastActivity: "2026-05-04T10:00:00Z",
					cacheReadTokens: 80,
					cacheCreationTokens: 10,
					cacheMissTokens: 10,
					recentTps: [40, 50, 60],
					recentTtftMs: [1200, 900, 700],
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 60 },
			store: fakeStoreWithSession,
			claudeSession: {
				context_window: {
					used_percentage: 42,
					current_usage: {
						input_tokens: 50,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 950,
					},
				},
				rate_limits: {
					five_hour: { used_percentage: 30 },
					seven_day: { used_percentage: 20 },
				},
			},
			colorEnabled: false,
		});
		expect(text.length).toBeLessThanOrEqual(60);
		expect(text.endsWith("…")).toBe(false);
		expect(text).toMatch(/context/);
		// `week` is the first to drop — should not survive at 60.
		expect(text).not.toMatch(/\bweek\b/);
	});

	test("falls back to character slice only when context-only still exceeds max", () => {
		// At max=15, even "clawback: context ████░░░░  42%" overflows,
		// so the fallback character-slice kicks in.
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 15 },
			store: { keys: () => [] },
			claudeSession: {
				context_window: { used_percentage: 42 },
			},
		});
		expect(text.length).toBe(15);
		expect(text.endsWith("…")).toBe(true);
	});

	test("does not include passthrough or mobile markers (non-numeric, dropped)", () => {
		const text = renderStatusline({
			config: { ...baseCfg, mobile: true, passthrough: true },
			store: fakeStore,
		});
		expect(text).not.toMatch(/passthrough/);
		expect(text).not.toMatch(/mobile/);
		expect(text).not.toMatch(/treatment/);
	});

	test("does not include any session-count chip (every figure is per-session)", () => {
		const fakeStoreSingle = {
			keys: () => ["k1"],
			all: () => [
				{
					key: "k1",
					lastActivity: "2026-05-06T10:00:00Z",
					cacheReadTokens: 80,
					cacheCreationTokens: 10,
					cacheMissTokens: 10,
				},
			],
		};
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStoreSingle,
		});
		expect(text).not.toMatch(/\bsession(s)?\b/);
	});

	test("renders context% as a fill-up progress bar (not a flat sparkline)", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				context_window: { used_percentage: 14.7 },
				cost: { total_cost_usd: 0.0234 },
			},
		});
		// Cost is intentionally not surfaced. The model tier glyph used
		// to lead the line; it was removed 2026-05-18 because the tps
		// numbers are already model-conditioned in the operator's head.
		// 15% × 8 cells = 1.2 → rounds to 1 full + 7 track cells: "█░░░░░░░".
		// claudeSession is present but no rate_limits, so quota/week render the
		// waiting placeholder; we just check context's bar shape here.
		// Numeric tail is right-padded to PCT_WIDTH (4 chars) so " 15%" follows
		// the bar (1 separator space + 1 pad space).
		expect(text).toMatch(new RegExp(`^context ${GLYPH}{8}  15%`));
	});

	test("renders fixed-width placeholders for every claude-driven field when nothing has loaded yet", () => {
		// Operator-flagged 2026-05-07. A fresh `clawback claude` (no
		// turns yet) used to produce a half-rendered line: context/turn
		// vanished and tps/ttft surfaced a stale unrelated session's
		// numbers. Now every field reserves a fixed-width column —
		// context defaults to a real 0% (since a fresh window genuinely
		// starts near zero), quota/week/turn render ` na%` waiting
		// placeholders, tps renders ` na`. The ttft column is gone — the
		// `clawback` brand mark occupies that slot now (it shows while
		// metrics are warming up, same presence the ttft placeholder had).
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStore,
			claudeSession: {
				context_window: { used_percentage: "not-a-number" },
				cost: { total_cost_usd: 0 },
			},
		});
		expect(text).toBe(
			"context ░░░░░░░░   0% · quota ▒▒▒▒▒▒▒▒  na% · week ▒▒▒▒▒▒▒▒  na% · cache ░░░░░░░░   0% · turn ▒▒▒▒▒▒▒▒  na% · tps ▒▒▒▒▒▒▒▒  na · clawback",
		);
	});

	test("malformed claudeSession (non-object) is silently dropped", () => {
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStore,
			claudeSession: "garbage",
		});
		// The bad session contributes no fields; the always-on brand remains.
		expect(text).toBe("clawback");
	});

	test("appends session-lifetime hit% when the store has accumulated counters", () => {
		const fakeStoreWithSession = {
			keys: () => ["k1"],
			all: () => [
				{
					key: "k1",
					lastActivity: "2026-05-04T10:00:00Z",
					cacheReadTokens: 87000,
					cacheCreationTokens: 8000,
					cacheMissTokens: 5000,
				},
			],
		};
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStoreWithSession,
		});
		expect(text).toMatch(new RegExp(`cache ${GLYPH}+\\s+87%`));
	});

	test("picks the most-recently-active session when the store has multiple", () => {
		const fakeStoreMulti = {
			keys: () => ["old", "new"],
			all: () => [
				{
					key: "old",
					lastActivity: "2026-05-01T10:00:00Z",
					cacheReadTokens: 1,
					cacheCreationTokens: 99,
					cacheMissTokens: 0,
				},
				{
					key: "new",
					lastActivity: "2026-05-04T10:00:00Z",
					cacheReadTokens: 90,
					cacheCreationTokens: 5,
					cacheMissTokens: 5,
				},
			],
		};
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStoreMulti,
		});
		expect(text).toMatch(new RegExp(`cache ${GLYPH}+\\s+90%`));
		expect(text).not.toMatch(new RegExp(`cache ${GLYPH}+\\s+1%`));
	});

	test("renders hit ░░░░░░░░ 0% when the chosen session has zero counters (option B, 2026-05-07)", () => {
		// Pre-fix: hit returned null and the field disappeared whenever
		// `mostRecentSession` picked a session whose cache counters were
		// all zero — easy to trigger when multiple claudes share a proxy
		// (a freshly-ticked but counter-empty session briefly wins the
		// `lastActivity` race). Operator-confirmed option B: render the
		// same `hit ░░░░░░░░ 0%` shape as the fresh-claude path so the
		// column stays reserved and the value is mathematically honest
		// (zero hits over zero observations).
		const fakeStoreZero = {
			keys: () => ["k1"],
			all: () => [
				{
					key: "k1",
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					cacheMissTokens: 0,
				},
			],
		};
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStoreZero,
		});
		expect(text).toMatch(/cache ░{8}\s+0%/);
	});

	test("hit field is omitted entirely when the store has no sessions at all", () => {
		// Different case from the zero-counters one: no clawback session
		// exists, period. With no claudeSession either there is genuinely
		// nothing to render — drop the field rather than fabricating a 0%.
		const fakeStoreEmpty = {
			keys: () => [],
			all: () => [],
		};
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStoreEmpty,
		});
		expect(text).not.toMatch(/\bcache\b/);
	});

	test("hit renders 0% placeholder when claudeSession is attached but store is empty (operator-flagged 2026-05-12)", () => {
		// The exact shape the operator hit: claude code POSTs a populated
		// statusline payload (turn 100%, context populated) but no
		// /v1/messages traffic has reached clawback for this claude yet
		// — so the store is empty. Pre-fix, hit returned null and the
		// column collapsed even though every other field rendered. Fix:
		// when claude is attached the column is always reserved with the
		// real-0% shape, matching the "we have no observations yet"
		// reading.
		const fakeStoreEmpty = {
			keys: () => [],
			all: () => [],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreEmpty,
			claudeSession: {
				context_window: {
					used_percentage: 22,
					current_usage: {
						input_tokens: 0,
						cache_read_input_tokens: 10000,
						cache_creation_input_tokens: 0,
					},
				},
			},
		});
		expect(text).toMatch(/cache ░{8}\s+0%/);
		// And the other fields still render normally.
		expect(text).toMatch(/context [▁-█░]{8}\s+22%/);
		expect(text).toMatch(/turn [▁-█]{8}\s+100%/);
	});

	test("hit shows 0% when only an empty-counter session ticks newer than the active one (operator-flagged 2026-05-07)", () => {
		// The exact shape of the operator-observed regression: a real
		// session with ~50% hit rate is briefly outranked in the
		// `lastActivity` race by a freshly-created but counter-empty
		// session (e.g., a parallel claude's first turn, a probe, a
		// rotated session_id). `mostRecentSession` picks the empty one,
		// so this turn the rendered hit value belongs to the wrong
		// session. The proper fix is the global-session-context work
		// (separate task); this regression test asserts the *display*
		// at least no longer collapses the column when that swap happens.
		const fakeStoreSwap = {
			keys: () => ["active", "fresh"],
			all: () => [
				{
					key: "active",
					lastActivity: "2026-05-07T12:00:00Z",
					cacheReadTokens: 5000,
					cacheCreationTokens: 1000,
					cacheMissTokens: 4000,
				},
				{
					key: "fresh",
					lastActivity: "2026-05-07T12:00:05Z", // 5s newer
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					cacheMissTokens: 0,
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreSwap,
		});
		// "fresh" wins the recency race → hit reads 0% with the empty-track
		// shape rather than disappearing.
		expect(text).toMatch(/cache ░{8}\s+0%/);
	});

	test("appends per-turn hit% from claude's current_usage when present", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				context_window: {
					current_usage: {
						input_tokens: 500,
						output_tokens: 1000,
						cache_creation_input_tokens: 1000,
						cache_read_input_tokens: 8500,
					},
				},
			},
		});
		expect(text).toMatch(new RegExp(`turn ${GLYPH}+\\s+85%`));
	});

	test("renders turn placeholder with na% when current_usage is null (pre-first-API-call)", () => {
		const text = renderStatusline({
			config: baseCfg,
			store: fakeStore,
			claudeSession: { context_window: { current_usage: null } },
		});
		// Reserve the column with the waiting glyph + " na%" (operator-
		// requested 2026-05-07: numeric tail is fixed-width, so the
		// placeholder also occupies PCT_WIDTH chars).
		expect(text).toMatch(/turn ▒{8}\s+na%/);
		// And no real percentage rendered, since there's nothing to compute.
		expect(text).not.toMatch(/turn ▒+\s+\d+%/);
	});

	test("renders context, hit, and turn together — no session count, labels intact", () => {
		const fakeStoreWithSession = {
			keys: () => ["k"],
			all: () => [
				{
					key: "k",
					lastActivity: "2026-05-04T10:00:00Z",
					cacheReadTokens: 80,
					cacheCreationTokens: 10,
					cacheMissTokens: 10,
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreWithSession,
			claudeSession: {
				model: { display_name: "Claude Opus 4.7" },
				context_window: {
					used_percentage: 22,
					current_usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 900,
					},
				},
				rate_limits: {
					five_hour: { used_percentage: 10 },
					seven_day: { used_percentage: 60 },
				},
			},
		});
		// Layout: label SPACE graphic SPACE value%. All five percentage
		// fields are progress bars (8 cells by default). The `clawback` brand
		// mark appends at the end; we don't anchor with $ so this test stays
		// focused on the percentage fields' shape and order.
		// All percentages are right-padded to PCT_WIDTH (4 chars), so the
		// rendered tail after each bar is "1 separator + N-pad-spaces +
		// digits + %". 22%/10%/60%/80%/90% are all 3-char strings padded
		// with one leading space, yielding two spaces between bar and digit.
		expect(text).toMatch(
			new RegExp(
				`^context ${GLYPH}{8}  22% · quota ${GLYPH}{8}  10% · week ${GLYPH}{8}  60% · cache ${GLYPH}{8}  80% · turn ${GLYPH}{8}  90%`,
			),
		);
		// No leading session-count chip.
		expect(text).not.toMatch(/session/);
	});

	test("each field follows label SPACE graphic SPACE value (single space each side)", () => {
		// Operator-requested layout: graphic sits between label and value,
		// with exactly one space on each side. No padding on the value, so
		// 5%, 42%, and 100% all render with identical spacing.
		const cases = [5, 42, 100];
		for (const pct of cases) {
			const text = renderStatusline({
				config: baseCfg,
				store: fakeStore,
				claudeSession: { context_window: { used_percentage: pct } },
			});
			// Numeric tail is right-padded to PCT_WIDTH (4 chars), so we
			// allow variable whitespace between the bar and the digits.
			// Don't anchor with $ — quota/week placeholders may follow context
			// when claudeSession lacks rate_limits.
			expect(text).toMatch(new RegExp(`context ${GLYPH}+\\s+${pct}%`));
			// And NOT the old format with the value before the graphic.
			expect(text).not.toMatch(new RegExp(`context\\s+${pct}%${GLYPH}`));
		}
	});

	test("quota and week fields render fill-up progress bars from claude rate_limits", () => {
		// Claude Code v1.2.80+ posts rate_limits.{five_hour,seven_day} on every
		// statusline update. We render both as progress bars (single bucket,
		// no trend) so the operator can see how close they are to their plan
		// quotas without leaving the editor.
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				rate_limits: {
					five_hour: { used_percentage: 33, resets_at: 1_700_000_000 },
					seven_day: { used_percentage: 81, resets_at: 1_700_500_000 },
				},
			},
		});
		// 8-cell bars at default. 33% × 8 = 2.64 → 3 full + 5 track. 81% × 8
		// = 6.48 → 6 full + 2 track. Assert structural shape per field;
		// numeric tail is right-padded to PCT_WIDTH so allow variable space.
		expect(text).toMatch(new RegExp(`quota ${GLYPH}{8}\\s+33%`));
		expect(text).toMatch(new RegExp(`week ${GLYPH}{8}\\s+81%`));
		// Order: quota before week (smaller window first reads chronologically).
		const idxquota = text.indexOf("quota ");
		const idxweek = text.indexOf("week ");
		expect(idxquota).toBeGreaterThan(-1);
		expect(idxweek).toBeGreaterThan(idxquota);
	});

	test("quota and week show a waiting placeholder with na% when rate_limits hasn't loaded yet", () => {
		// Pre-first-API-response (or older claude < v1.2.80), rate_limits is
		// absent. Operator-requested 2026-05-07: render the medium-shade
		// `▒` bar plus a fixed-width ` na%` tail so the column matches the
		// width of a real percentage and the line doesn't reflow when
		// claude reports a real value.
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				context_window: { used_percentage: 50 },
				// no rate_limits field at all
			},
		});
		expect(text).toMatch(/quota ▒{8}\s+na%/);
		expect(text).toMatch(/week ▒{8}\s+na%/);
	});

	test("quota shows waiting placeholder when only seven_day is populated", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				rate_limits: { seven_day: { used_percentage: 50 } },
			},
		});
		expect(text).toMatch(/quota ▒{8}\s+na%/);
		expect(text).toMatch(new RegExp(`week ${GLYPH}{8}\\s+50%`));
	});

	test("rate_limits with non-numeric used_percentage falls back to the waiting placeholder", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				rate_limits: {
					five_hour: { used_percentage: "high" },
					seven_day: { used_percentage: null },
				},
			},
		});
		expect(text).toMatch(/quota ▒{8}\s+na%/);
		expect(text).toMatch(/week ▒{8}\s+na%/);
	});

	test("waiting placeholder is omitted entirely when no claudeSession is posted", () => {
		// No claudeSession at all means no claude connected. Reserving a
		// column for an unconnected field is just noise.
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
		});
		expect(text).not.toMatch(/\bquota\b/);
		expect(text).not.toMatch(/\bweek\b/);
	});

	test("0% rate-limit renders an empty track (track visible at 0)", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				rate_limits: { seven_day: { used_percentage: 0 } },
			},
		});
		// 8 cells of light-shade track, then "  0%" (right-padded to PCT_WIDTH).
		// Anchors the column width even when the bar is empty.
		expect(text).toMatch(/week ░░░░░░░░\s+0%/);
	});

	test("100% rate-limit renders a fully-filled bar", () => {
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
			claudeSession: {
				rate_limits: { seven_day: { used_percentage: 100 } },
			},
		});
		expect(text).toMatch(/week ████████ 100%/); // 100% is already PCT_WIDTH chars, no padding
	});

	test("statuslineProgressBarLength config widens or narrows the bar", () => {
		const cs = {
			rate_limits: { seven_day: { used_percentage: 50 } },
		};
		const wide = renderStatusline({
			config: {
				...baseCfg,
				statuslineMaxChars: 200,
				statuslineProgressBarLength: 16,
			},
			store: fakeStore,
			claudeSession: cs,
		});
		expect(wide).toMatch(/week ████████░░░░░░░░\s+50%/);

		const narrow = renderStatusline({
			config: {
				...baseCfg,
				statuslineMaxChars: 200,
				statuslineProgressBarLength: 4,
			},
			store: fakeStore,
			claudeSession: cs,
		});
		expect(narrow).toMatch(/week ██░░\s+50%/);
	});

	test("tps field appears once recentTps ring is populated", () => {
		const fakeStoreTps = {
			keys: () => ["k"],
			all: () => [
				{
					key: "k",
					lastActivity: "2026-05-06T10:00:00Z",
					recentTps: [10, 20, 30, 42],
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreTps,
		});
		// Layout: label SPACE sparkline SPACE value (latest tps, right-padded
		// to TPS_WIDTH=3 chars: " 42"). ttft placeholder may follow — anchor
		// on tps's value, not end-of-string.
		expect(text).toMatch(/tps [▁-█]+\s+42(?: ·|$)/);
	});

	test("tps field shows a waiting placeholder when ring is empty (matches ttft pattern)", () => {
		// Operator-flagged 2026-05-07: tps was being omitted entirely when
		// the ring was empty (e.g. only tool-call turns recorded — those
		// fail the TPS_MIN_OUTPUT_TOKENS gate in server.js so don't feed
		// recentTps, while every turn still feeds recentTtftMs). Reserve
		// the column with `▒▒▒▒▒▒▒▒ na` like ttft does so the line
		// doesn't reflow once a real tps sample lands.
		const fakeStoreNoTps = {
			keys: () => ["k"],
			all: () => [
				{
					key: "k",
					lastActivity: "2026-05-06T10:00:00Z",
					// no recentTps field — pre-first-turn or only tool-call turns so far
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreNoTps,
		});
		expect(text).toMatch(/tps ▒▒▒▒▒▒▒▒\s+na(?: ·|$)/);
	});

	test("tps shows placeholder when only ttft samples exist (tool-call-only turns)", () => {
		// The exact state the operator observed: a non-fresh claude with
		// ttft samples in the ring (every turn feeds it) but no tps
		// samples (only tool-call turns so far → all gated out by
		// TPS_MIN_OUTPUT_TOKENS). Pre-fix, tps disappeared from the line.
		// (TTFT itself is no longer rendered — the `clawback` brand occupies
		// that slot — but the ring is still the reason tps lacks a sibling.)
		const fakeStoreTtftOnly = {
			keys: () => ["k"],
			all: () => [
				{
					key: "k",
					lastActivity: "2026-05-07T12:00:00Z",
					recentTtftMs: [1765],
					// no recentTps — tool-call-only turns failed the output_tokens gate
				},
			],
		};
		// Posting a non-fresh claudeSession (current_usage present) so the
		// claudeIsFresh gate doesn't fire — this is the post-first-turn state.
		const claudeSession = {
			context_window: { current_usage: { tokens: { total: 50000 } } },
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreTtftOnly,
			claudeSession,
		});
		expect(text).toMatch(/tps ▒▒▒▒▒▒▒▒\s+na/);
		// ttft sparkline/metric is gone; the brand renders in its place.
		expect(text).not.toMatch(/\bttft\b/);
		expect(text).toMatch(/clawback$/);
	});

	test("brand 'clawback' renders in the ttft slot once a session is active", () => {
		// What used to be the ttft sparkline/metric is now a static brand
		// mark. A populated recentTtftMs ring no longer surfaces any ttft
		// graphic — only the captured data (still in the ring, still fed to
		// the dashboard charts) — and the line ends with the brand.
		const fakeStoreTtft = {
			keys: () => ["k"],
			all: () => [
				{
					key: "k",
					lastActivity: "2026-05-06T10:00:00Z",
					recentTtftMs: [820, 410, 230, 180, 165, 140, 125, 110],
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreTtft,
		});
		expect(text).not.toMatch(/\bttft\b/);
		expect(text).not.toMatch(/110/); // the latest ttft value is not surfaced
		expect(text).toMatch(/clawback$/);
	});

	test("brand still renders (and ttft does not) when no clawback session exists", () => {
		// No session = no clawback observation, so the metric fields are
		// suppressed — but the brand is always-on, so the line is exactly the
		// brand. ttft never appears anywhere anymore.
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStore,
		});
		expect(text).not.toMatch(/\bttft\b/);
		expect(text).toBe("clawback");
	});

	test("numeric tail is fixed-width across all populated values (no reflow as values change)", () => {
		// Operator-requested 2026-05-07: the visual structure of the line
		// must stay stable as values populate. This test asserts that the
		// rendered length of each field is identical at 0%, 42%, and 100%
		// (and the ` na%` placeholder), so subsequent fields don't shift.
		// Same property for tps (0/42/999/na). (ttft is no longer rendered.)
		const cfg = { ...baseCfg, statuslineMaxChars: 200 };
		const measure = (text) => text.length;

		// Percentages: all PCT_WIDTH=4 chars wide → identical line length
		// across 0/42/100/na% for context.
		const pctSamples = [0, 42, 100, "missing"].map((p) => {
			const claudeSession = { context_window: {} };
			if (p !== "missing") claudeSession.context_window.used_percentage = p;
			return measure(
				renderStatusline({ config: cfg, store: fakeStore, claudeSession }),
			);
		});
		// "missing" (na%) renders the placeholder shape; real 0/42/100 all
		// produce a fixed-width tail. Every entry should be the same length.
		expect(new Set(pctSamples).size).toBe(1);

		// tps: TPS_WIDTH=3. Build sessions with a single value in the ring.
		const tpsSamples = [0, 42, 999].map((v) => {
			const store = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						recentTps: [v],
					},
				],
			};
			return measure(renderStatusline({ config: cfg, store }));
		});
		expect(new Set(tpsSamples).size).toBe(1);
	});

	describe("ANSI color (operator-requested 2026-05-07)", () => {
		// Per the design discussion: bars only, three-band thresholds
		// (green/yellow/red), per-field semantic direction. Helpers wrap
		// only the █ glyphs, leaving labels, values, and waiting bars (▒)
		// terminal-default.
		const ANSI_GREEN = "\x1b[32m";
		const ANSI_YELLOW = "\x1b[33m";
		const ANSI_RED = "\x1b[31m";
		const ANSI_RESET = "\x1b[0m";
		// All ANSI escape sequences emitted by the renderer (filtered out of
		// the visible-length math by `visibleLength` below).
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR escapes requires the ESC control char
		const ANSI_ANY = /\x1b\[[0-9;]+m/g;
		const visibleLength = (s) => s.replace(ANSI_ANY, "").length;

		test("colorEnabled=false produces no ANSI escapes anywhere", () => {
			const fakeStoreFull = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						cacheReadTokens: 80,
						cacheCreationTokens: 10,
						cacheMissTokens: 10,
						recentTps: [40, 50, 60, 70],
						recentTtftMs: [200, 250, 300, 350],
					},
				],
			};
			const text = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: fakeStoreFull,
				claudeSession: {
					context_window: {
						used_percentage: 30,
						current_usage: {
							input_tokens: 100,
							cache_read_input_tokens: 900,
							cache_creation_input_tokens: 0,
						},
					},
					rate_limits: {
						five_hour: { used_percentage: 30 },
						seven_day: { used_percentage: 65 },
					},
				},
				colorEnabled: false,
			});
			expect(text).not.toMatch(ANSI_ANY);
		});

		test("context bar colors green/yellow/red on the high-bad ramp", () => {
			const cases = [
				{ pct: 25, color: ANSI_GREEN },
				{ pct: 65, color: ANSI_YELLOW },
				{ pct: 95, color: ANSI_RED },
			];
			for (const { pct, color } of cases) {
				const text = renderStatusline({
					config: { ...baseCfg, statuslineMaxChars: 200 },
					store: fakeStore,
					claudeSession: { context_window: { used_percentage: pct } },
					colorEnabled: true,
				});
				// The escape immediately precedes the █ run for the context bar.
				expect(text).toContain(`context ${color}█`);
				expect(text).toContain(ANSI_RESET);
			}
		});

		test("hit bar inverts the ramp (low pct = red, high pct = green)", () => {
			// 30% rounds to 2 filled cells (still inside the red band, <50%);
			// 90% rounds to 7 cells (green, ≥80%). Below 50% / 8 ≈ 6.25%
			// progressBarFromPct rounds to 0 cells and we skip the color
			// wrap entirely (nothing to color), so we need pct that
			// produces at least one █.
			const lowHit = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						cacheReadTokens: 30,
						cacheCreationTokens: 60,
						cacheMissTokens: 10,
					},
				],
			};
			const highHit = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						cacheReadTokens: 90,
						cacheCreationTokens: 5,
						cacheMissTokens: 5,
					},
				],
			};
			const lowText = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: lowHit,
				colorEnabled: true,
			});
			const highText = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: highHit,
				colorEnabled: true,
			});
			// 30% hit → red; 90% hit → green. Distinguishes the inversion
			// vs the high-bad ramp.
			expect(lowText).toContain(`cache ${ANSI_RED}█`);
			expect(highText).toContain(`cache ${ANSI_GREEN}█`);
		});

		test("tps sparkline colors each cell with the inverse of ttft's direction (higher = greener)", () => {
			// Operator-added 2026-05-07: tps gets the same per-cell
			// coloring shape as ttft, but the direction inverts (higher
			// tps = green, lower tps = red — the opposite of ttft's
			// lower-ms = green). Thresholds are pinned (absolute mode,
			// low=30, high=80) so the test stays independent of the default
			// band tuning: 10 → red, 50 → yellow, 100 → green. All three
			// should appear in the tps section.
			const fakeStoreTps = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						recentTps: [10, 50, 100],
					},
				],
			};
			const text = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslineTpsCalibration: "absolute",
					statuslineTpsThresholdLow: 30,
					statuslineTpsThresholdHigh: 80,
				},
				store: fakeStoreTps,
				colorEnabled: true,
			});
			const tps = text.slice(
				text.indexOf("tps"),
				text.indexOf("·", text.indexOf("tps")),
			);
			expect(tps).toContain(ANSI_RED);
			expect(tps).toContain(ANSI_YELLOW);
			expect(tps).toContain(ANSI_GREEN);
		});

		// Slice the field's substring (label up to the next field
		// separator). The single-value sparklines used in some tests
		// produce 7 padding cells (▁) before the real cell, so a strict
		// "label SPACE color-escape" match fails — we want to assert the
		// color appears *within* the field, not at a fixed offset.
		const fieldSlice = (text, label) => {
			const start = text.indexOf(`${label} `);
			if (start < 0) return "";
			const sep = text.indexOf(" · ", start);
			return sep === -1 ? text.slice(start) : text.slice(start, sep);
		};

		test("relative calibration derives tps bands from the session ring peak (peak/6, peak/2)", () => {
			// statuslineTpsCalibration: "relative" is the default. With >= 4
			// finite samples the helper computes low = peak/6, high = peak/2
			// and colors each cell against those derived bands. For peak=120:
			// low=20, high=60. Cells [10, 30, 50, 70, 90, 120] therefore land:
			//   10 < 20             → red
			//   30 in [20, 60)      → yellow
			//   50 in [20, 60)      → yellow
			//   70 in [60, ∞)       → green
			//   90 in [60, ∞)       → green
			//  120 in [60, ∞)       → green
			// All three colors should appear inside the tps field, and the
			// band boundaries (20/60) are derived from the ring peak — not
			// the absolute default pair (15/40) — which is the property this
			// test pins down.
			const fakeStore = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-26T10:00:00Z",
						recentTps: [10, 30, 50, 70, 90, 120],
					},
				],
			};
			const text = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslineTpsCalibration: "relative",
				},
				store: fakeStore,
				colorEnabled: true,
			});
			const tps = fieldSlice(text, "tps");
			expect(tps).toContain(ANSI_RED);
			expect(tps).toContain(ANSI_YELLOW);
			expect(tps).toContain(ANSI_GREEN);
		});

		test("relative calibration falls back to absolute thresholds when ring is too short", () => {
			// With fewer than TPS_RELATIVE_MIN_SAMPLES (4) finite samples,
			// the relative path bails out and the static config pair takes
			// over. Pin those thresholds so the assertion doesn't drift if
			// the defaults move again: low=40, high=80 → a single sample of
			// 100 must color green.
			const fakeStore = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-26T10:00:00Z",
						recentTps: [100, 100, 100], // 3 samples — below the relative threshold
					},
				],
			};
			const text = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslineTpsCalibration: "relative",
					statuslineTpsThresholdLow: 40,
					statuslineTpsThresholdHigh: 80,
				},
				store: fakeStore,
				colorEnabled: true,
			});
			const tps = fieldSlice(text, "tps");
			// 100 ≥ 80 → green; nothing should be yellow/red here.
			expect(tps).toContain(ANSI_GREEN);
			expect(tps).not.toContain(ANSI_RED);
			expect(tps).not.toContain(ANSI_YELLOW);
		});

		test("absolute calibration ignores the ring peak and uses the static config pair", () => {
			// Same ring as the relative-mode test (peak=120). If relative
			// were active, 30 would land in yellow (low=20). In absolute
			// mode with the pinned pair (low=40, high=80), 30 must land in
			// red instead — proving the ring did NOT drive the bands.
			const fakeStore = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-26T10:00:00Z",
						recentTps: [30, 30, 30, 30, 30, 120],
					},
				],
			};
			const text = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslineTpsCalibration: "absolute",
					statuslineTpsThresholdLow: 40,
					statuslineTpsThresholdHigh: 80,
				},
				store: fakeStore,
				colorEnabled: true,
			});
			const tps = fieldSlice(text, "tps");
			expect(tps).toContain(ANSI_RED); // 30 < 40
			expect(tps).toContain(ANSI_GREEN); // 120 ≥ 80
		});

		test("DEFAULT tps absolute fallback reads green for an Opus-range turn (rescale 2026-06-01)", () => {
			// Operator complaint 2026-06-01: "tps is red too often, make green
			// easier to hit." The bootstrap window (before the relative ring
			// has TPS_RELATIVE_MIN_SAMPLES) uses the absolute fallback pair.
			// We rescaled that default from 25/100 to 15/40 so a typical Opus
			// decode (~30-60 tps) reads green instead of yellow during bootstrap.
			// This pins the DEFAULT band (no per-test override): a single 50-tps
			// sample (<4 → absolute fallback) must be green. Reverting the
			// default to 100 would flip this back to yellow and trip the test.
			const fakeStore = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-26T10:00:00Z",
						recentTps: [50], // 1 sample → absolute fallback (default 15/40)
					},
				],
			};
			const text = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: fakeStore,
				colorEnabled: true,
			});
			const tps = fieldSlice(text, "tps");
			expect(tps).toContain(ANSI_GREEN); // 50 ≥ 40
			expect(tps).not.toContain(ANSI_YELLOW); // was yellow under old 25/100
			expect(tps).not.toContain(ANSI_RED);
		});

		test("DEFAULT tps absolute fallback reads green for an Opus-range turn (rescale 2026-06-01)", () => {
			// Operator complaint 2026-06-01: "tps is red too often, make green
			// easier to hit." The bootstrap window (before the relative ring
			// has TPS_RELATIVE_MIN_SAMPLES) uses the absolute fallback pair.
			// We rescaled that default from 25/100 to 15/40 so a typical Opus
			// decode (~30-60 tps) reads green instead of yellow during bootstrap.
			// This pins the DEFAULT band (no per-test override): a single 50-tps
			// sample (<4 → absolute fallback) must be green. Reverting the
			// default to 100 would flip this back to yellow and trip the test.
			const fakeStore = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-26T10:00:00Z",
						recentTps: [50], // 1 sample → absolute fallback (default 15/40)
					},
				],
			};
			const text = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: fakeStore,
				colorEnabled: true,
			});
			const tps = fieldSlice(text, "tps");
			expect(tps).toContain(ANSI_GREEN); // 50 ≥ 40
			expect(tps).not.toContain(ANSI_YELLOW); // was yellow under old 25/100
			expect(tps).not.toContain(ANSI_RED);
		});

		test("waiting placeholder bar (▒) is never colored", () => {
			// Day/week/turn placeholder + tps/ttft `na` placeholder all use
			// the medium-shade ▒ which intentionally stays terminal-default
			// (the placeholder shape is ALREADY a "no data" signal — color
			// would muddy that). On a fresh-claude render, every store-fed
			// field also takes a 0%-or-na fallback (no filled bar cells),
			// so the entire line should emit zero ANSI escapes even with
			// colorEnabled=true.
			const text = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: fakeStore,
				claudeSession: {
					// Fresh: no rate_limits, no current_usage → all the
					// placeholder code paths fire.
					context_window: {},
				},
				colorEnabled: true,
			});
			expect(text).not.toMatch(ANSI_ANY);
			// And confirm the placeholders are present (regression guard:
			// if the assertion above passed because we accidentally returned
			// the empty string, this would fail).
			expect(text).toMatch(/quota ▒{8}\s+na%/);
			expect(text).toMatch(/turn ▒{8}\s+na%/);
		});

		test("truncation works on visible length and falls back to plain text", () => {
			// Progressive truncation drops fields by priority first; only
			// when even context-only overflows do we fall back to a plain
			// character-slice. ANSI codes inflate String#length but have
			// zero visual width, so the only safe truncation rule at that
			// fallback is "use plain length, return plain text + ellipsis."
			// max=15 forces the fallback: "clawback: context ████░░░░ NN%"
			// runs ~30 chars even with everything else dropped.
			const fakeStoreFull = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						cacheReadTokens: 80,
						cacheCreationTokens: 10,
						cacheMissTokens: 10,
					},
				],
			};
			const text = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 15 },
				store: fakeStoreFull,
				claudeSession: { context_window: { used_percentage: 50 } },
				colorEnabled: true,
			});
			expect(text).not.toMatch(ANSI_ANY);
			expect(text.endsWith("…")).toBe(true);
			expect(text.length).toBe(15);
		});

		test("threshold knobs shift the color bands", () => {
			// Operator-requested 2026-05-07: 50/80 (default) is fine for
			// most accounts, but the operator can dial it tighter or
			// looser. At pct thresholds {low:90, high:95}, a 70% context
			// fill should still be GREEN (it's below the new "low" of
			// 90); at {low:10, high:20}, the same 70% should be RED.
			const cs = { context_window: { used_percentage: 70 } };

			const lax = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslinePctThresholdLow: 90,
					statuslinePctThresholdHigh: 95,
				},
				store: fakeStore,
				claudeSession: cs,
				colorEnabled: true,
			});
			expect(lax).toContain(`context ${ANSI_GREEN}█`);

			const tight = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslinePctThresholdLow: 10,
					statuslinePctThresholdHigh: 20,
				},
				store: fakeStore,
				claudeSession: cs,
				colorEnabled: true,
			});
			expect(tight).toContain(`context ${ANSI_RED}█`);
		});

		test("tps threshold knobs shift the color bands (Haiku-friendly preset)", () => {
			// At 150 tps with default thresholds (30/80), result is green.
			// Bumping thresholds to (200/400) — closer to a Haiku-tuned
			// preset — flips the same 150 tps to red (slow for Haiku).
			const fakeStoreTps = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						recentTps: [150],
					},
				],
			};
			const def = renderStatusline({
				config: { ...baseCfg, statuslineMaxChars: 200 },
				store: fakeStoreTps,
				colorEnabled: true,
			});
			expect(fieldSlice(def, "tps")).toContain(ANSI_GREEN);

			const haiku = renderStatusline({
				config: {
					...baseCfg,
					statuslineMaxChars: 200,
					statuslineTpsThresholdLow: 200,
					statuslineTpsThresholdHigh: 400,
				},
				store: fakeStoreTps,
				colorEnabled: true,
			});
			expect(fieldSlice(haiku, "tps")).toContain(ANSI_RED);
		});

		test("colored line and plain line have the same VISIBLE length", () => {
			// Same inputs, two renders. The colored version contains ANSI
			// codes (longer byte length) but should occupy identical screen
			// columns once those codes are stripped. This is the load-bearing
			// invariant for fixed-width column layout under color.
			const fakeStoreFull = {
				keys: () => ["k"],
				all: () => [
					{
						key: "k",
						lastActivity: "2026-05-06T10:00:00Z",
						cacheReadTokens: 80,
						cacheCreationTokens: 10,
						cacheMissTokens: 10,
						recentTtftMs: [200, 1000, 3000],
					},
				],
			};
			const cs = {
				context_window: {
					used_percentage: 30,
					current_usage: {
						input_tokens: 100,
						cache_read_input_tokens: 900,
						cache_creation_input_tokens: 0,
					},
				},
				rate_limits: {
					five_hour: { used_percentage: 30 },
					seven_day: { used_percentage: 65 },
				},
			};
			const args = {
				config: { ...baseCfg, statuslineMaxChars: 300 },
				store: fakeStoreFull,
				claudeSession: cs,
			};
			const plain = renderStatusline({ ...args, colorEnabled: false });
			const colored = renderStatusline({ ...args, colorEnabled: true });
			expect(visibleLength(colored)).toBe(plain.length);
			// Colored byte length should be strictly larger (ANSI codes added).
			expect(colored.length).toBeGreaterThan(plain.length);
		});
	});

	describe("resolveStatuslineColor", () => {
		const cfg = (statuslineColor) => ({ ...DEFAULTS, statuslineColor });

		test('"off" forces disabled regardless of env / TTY', () => {
			expect(
				resolveStatuslineColor({
					config: cfg("off"),
					env: {},
					isatty: true,
				}),
			).toBe(false);
		});

		test('"on" forces enabled regardless of env / TTY', () => {
			expect(
				resolveStatuslineColor({
					config: cfg("on"),
					env: { NO_COLOR: "1" },
					isatty: false,
				}),
			).toBe(true);
		});

		test('"auto" + NO_COLOR set to non-empty string disables', () => {
			expect(
				resolveStatuslineColor({
					config: cfg("auto"),
					env: { NO_COLOR: "1" },
					isatty: true,
				}),
			).toBe(false);
		});

		test('"auto" + NO_COLOR empty string is ignored (per no-color.org spec)', () => {
			expect(
				resolveStatuslineColor({
					config: cfg("auto"),
					env: { NO_COLOR: "" },
					isatty: true,
				}),
			).toBe(true);
		});

		test('"auto" + non-TTY stdout disables', () => {
			expect(
				resolveStatuslineColor({
					config: cfg("auto"),
					env: {},
					isatty: false,
				}),
			).toBe(false);
		});

		test('"auto" + TTY + no NO_COLOR enables', () => {
			expect(
				resolveStatuslineColor({
					config: cfg("auto"),
					env: {},
					isatty: true,
				}),
			).toBe(true);
		});
	});

	test("fresh claude attached to a busy clawback shows na for tps, not a stranger's numbers", () => {
		// Regression for operator-flagged 2026-05-07: `clawback claude` in
		// a new directory probe-attached to a long-lived clawback. Because
		// the store already had another claude's session with a populated
		// recentTps ring, the statusline rendered numeric tps even though
		// THIS claude hadn't made a single API call. Gate: when
		// claudeSession.context_window.current_usage is null (claude is
		// provably pre-first-call), the per-session figures from the
		// most-recent store session are suppressed. (TTFT used to be in this
		// set too; it's no longer rendered, so the stranger's ttft can't leak
		// regardless — we just assert its value never appears.)
		const fakeStoreOtherSession = {
			keys: () => ["other"],
			all: () => [
				{
					key: "other",
					lastActivity: "2026-05-07T09:00:00Z",
					cacheReadTokens: 0,
					cacheCreationTokens: 100,
					cacheMissTokens: 50,
					recentTps: [10, 20, 1],
					recentTtftMs: [820, 410, 769],
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreOtherSession,
			claudeSession: {
				// Fresh: no current_usage yet, no rate_limits, no used_percentage.
				context_window: {},
			},
		});
		expect(text).toMatch(/tps ▒{8}\s+na/);
		// context defaults to a real 0% (with empty track) per operator
		// preference 2026-05-07; turn shows the placeholder bar + na%.
		expect(text).toMatch(/context ░{8}\s+0%/);
		expect(text).toMatch(/turn ▒{8}\s+na%/);
		// hit is also gated on claudeIsFresh: render OUR 0% (cold-cache
		// projection) instead of the stranger session's actual hit rate.
		// Operator-confirmed 2026-05-07.
		expect(text).toMatch(/cache ░{8}\s+0%/);
		// Specifically: the stale ring values (tps 1, ttft 769) must not appear.
		expect(text).not.toMatch(/tps [▁-█]+\s+1\b/);
		expect(text).not.toMatch(/769/);
	});

	test("tps sparkline scales to its own min/max so trends are visible", () => {
		// Values that vary subtly should still show variation in the
		// sparkline (not all the same block).
		const fakeStoreVarying = {
			keys: () => ["k"],
			all: () => [
				{
					key: "k",
					lastActivity: "2026-05-06T10:00:00Z",
					recentTps: [40, 41, 42, 43],
				},
			],
		};
		const text = renderStatusline({
			config: { ...baseCfg, statuslineMaxChars: 200 },
			store: fakeStoreVarying,
		});
		const m = text.match(/tps ([▁-█]+)\s+\d+/);
		expect(m).not.toBeNull();
		const spark = m[1];
		// 4 cells, with at least 2 distinct block heights (min and max).
		const distinct = new Set(spark.split(""));
		expect(distinct.size).toBeGreaterThanOrEqual(2);
	});
});

describe("/_proxy/statusline admin endpoint", () => {
	function setup(overrides = {}) {
		const dir = `/tmp/clawback-statusline-${process.pid}-${Math.random().toString(36).slice(2)}`;
		const config = {
			...DEFAULTS,
			port: 0,
			host: "127.0.0.1",
			stateFile: `${dir}/state.json`,
			turnLogFile: null,
			sessionLogDir: null,
			// These endpoint tests assert rendered CONTENT (field merging,
			// truncation, ordering), not color. The endpoint now resolves
			// color as isatty:true (consumer is the TUI), so default output
			// carries ANSI; force it off here so content regexes stay
			// stable. The color-on-by-default path has its own test below.
			statuslineColor: "off",
			...overrides,
		};
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const scheduler = {
			start() {},
			stop() {},
			ensureScheduled() {},
			cancelSession() {},
		};
		const server = createServer({ config, store, scheduler, logger });
		return { config, store, scheduler, server };
	}

	function fetchPlain(port, urlPath) {
		return new Promise((resolve, reject) => {
			const req = http.get(
				{ host: "127.0.0.1", port, path: urlPath },
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () =>
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			req.on("error", reject);
		});
	}

	function fetchJsonAdmin(port, urlPath) {
		return new Promise((resolve, reject) => {
			const req = http.get(
				{ host: "127.0.0.1", port, path: urlPath },
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						const body = Buffer.concat(chunks).toString("utf8");
						try {
							resolve(JSON.parse(body || "{}"));
						} catch (e) {
							reject(new Error(`bad json: ${body}`));
						}
					});
				},
			);
			req.on("error", reject);
		});
	}

	function jsonPost(port, urlPath, body) {
		return new Promise((resolve, reject) => {
			const payload = JSON.stringify(body ?? {});
			const req = http.request(
				{
					method: "POST",
					host: "127.0.0.1",
					port,
					path: urlPath,
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(payload),
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

	test("returns text/plain (not JSON) so shell-curl prints it cleanly", async () => {
		const ctx = setup();
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await fetchPlain(port, "/_proxy/statusline");
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toMatch(/text\/plain/);
			// Default prefix is empty and there are no metric fields to render,
			// so the body is just the always-on `clawback` brand mark.
			expect(r.body).toBe("clawback");
		} finally {
			ctx.server.close();
		}
	});

	// POST with optional extra headers + a claude body, returning the plain
	// rendered statusline. Used for the per-render branch-refresh tests.
	function postStatusline(port, urlPath, body, headers = {}) {
		return new Promise((resolve, reject) => {
			const payload = JSON.stringify(body ?? {});
			const req = http.request(
				{
					method: "POST",
					host: "127.0.0.1",
					port,
					path: urlPath,
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(payload),
						...headers,
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

	test("auto label: branch header refreshes the branch, index is appended, change persisted", async () => {
		const ctx = setup();
		// Seed a git-auto-labeled session (launch-time branch = main).
		ctx.store.upsert("sess1", () => ({
			key: "sess1",
			label: "clawback:main",
			labelSource: "auto",
			mode: "path",
		}));
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await postStatusline(
				port,
				"/_proxy/statusline/sess1",
				{ context_window: { used_percentage: 10 } },
				{
					"x-clawback-autolabel": "1",
					"x-clawback-label": "clawback:main",
					"x-clawback-branch": "feat-auth",
				},
			);
			expect(r.status).toBe(200);
			// The left field (context label) reads the live branch + index 0.
			expect(r.body.startsWith("clawback:feat-auth:0 ")).toBe(true);
			// And the change is persisted so the dashboard tracks it too.
			const s = ctx.store.get("sess1");
			expect(s.label).toBe("clawback:feat-auth:0");
			expect(s.labelBase).toBe("clawback:feat-auth");
			expect(s.labelIndex).toBe(0);
		} finally {
			ctx.server.close();
		}
	});

	test("auto label: a second session on the same base gets index 1", async () => {
		const ctx = setup();
		// sess-a already holds index 0 on base clawback:main.
		ctx.store.upsert("sess-a", () => ({
			key: "sess-a",
			label: "clawback:main:0",
			labelBase: "clawback:main",
			labelIndex: 0,
			labelSource: "auto",
			mode: "path",
		}));
		ctx.store.upsert("sess-b", () => ({
			key: "sess-b",
			label: "clawback:main",
			labelSource: "auto",
			mode: "path",
		}));
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await postStatusline(
				port,
				"/_proxy/statusline/sess-b",
				{ context_window: { used_percentage: 10 } },
				{ "x-clawback-autolabel": "1", "x-clawback-label": "clawback:main" },
			);
			expect(r.body.startsWith("clawback:main:1 ")).toBe(true);
			expect(ctx.store.get("sess-b").labelIndex).toBe(1);
			// A re-render keeps the assigned index stable (idempotent).
			const r2 = await postStatusline(
				port,
				"/_proxy/statusline/sess-b",
				{ context_window: { used_percentage: 10 } },
				{ "x-clawback-autolabel": "1", "x-clawback-label": "clawback:main" },
			);
			expect(r2.body.startsWith("clawback:main:1 ")).toBe(true);
			expect(ctx.store.get("sess-b").labelIndex).toBe(1);
		} finally {
			ctx.server.close();
		}
	});

	test("auto label with no branch segment still gets an index", async () => {
		const ctx = setup();
		// Non-git launch label (bare dir name, no colon) — nothing to swap, but
		// the uniqueness index is still appended.
		ctx.store.upsert("sess2", () => ({
			key: "sess2",
			label: "myproject",
			labelSource: "auto",
			mode: "path",
		}));
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await postStatusline(
				port,
				"/_proxy/statusline/sess2",
				{ context_window: { used_percentage: 10 } },
				{
					"x-clawback-autolabel": "1",
					"x-clawback-label": "myproject",
					"x-clawback-branch": "feat",
				},
			);
			expect(r.body.startsWith("myproject:0 ")).toBe(true);
			expect(ctx.store.get("sess2").label).toBe("myproject:0");
		} finally {
			ctx.server.close();
		}
	});

	test("operator label self-heals from the header but is never indexed", async () => {
		const ctx = setup();
		// A record whose operator seed was lost (recreated by traffic → key).
		ctx.store.upsert("sess-op", () => ({
			key: "sess-op",
			label: "sess-op",
			labelSource: "auto",
			mode: "path",
		}));
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await postStatusline(
				port,
				"/_proxy/statusline/sess-op",
				{ context_window: { used_percentage: 10 } },
				{ "x-clawback-label": "my-fixed-name" }, // no autolabel header
			);
			expect(r.body.startsWith("my-fixed-name ")).toBe(true);
			const s = ctx.store.get("sess-op");
			expect(s.label).toBe("my-fixed-name");
			expect(s.labelSource).toBe("operator");
		} finally {
			ctx.server.close();
		}
	});

	test("an operator-set record is never overwritten by an auto header", async () => {
		const ctx = setup();
		ctx.store.upsert("sess-fixed", () => ({
			key: "sess-fixed",
			label: "chosen",
			labelSource: "operator",
			mode: "path",
		}));
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await postStatusline(
				port,
				"/_proxy/statusline/sess-fixed",
				{ context_window: { used_percentage: 10 } },
				{
					"x-clawback-autolabel": "1",
					"x-clawback-label": "clawback:main",
					"x-clawback-branch": "feat",
				},
			);
			expect(r.body.startsWith("chosen ")).toBe(true);
			expect(ctx.store.get("sess-fixed").label).toBe("chosen");
		} finally {
			ctx.server.close();
		}
	});

	test("without any label header the stored label is rendered unchanged", async () => {
		const ctx = setup();
		ctx.store.upsert("sess3", () => ({
			key: "sess3",
			label: "clawback:main:0",
			labelBase: "clawback:main",
			labelIndex: 0,
			labelSource: "auto",
			mode: "path",
		}));
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await postStatusline(port, "/_proxy/statusline/sess3", {
				context_window: { used_percentage: 10 },
			});
			expect(r.body.startsWith("clawback:main:0 ")).toBe(true);
			expect(ctx.store.get("sess3").label).toBe("clawback:main:0");
		} finally {
			ctx.server.close();
		}
	});

	test("event text is no longer surfaced (non-numeric, dropped)", async () => {
		appendEvent({ type: "test", text: "hello from clawback" });
		const ctx = setup();
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await fetchPlain(port, "/_proxy/statusline");
			expect(r.body).not.toMatch(/hello from clawback/);
			// Default prefix empty, no metric fields → just the brand mark.
			expect(r.body).toBe("clawback");
		} finally {
			ctx.server.close();
		}
	});

	test("respects custom prefix from config", async () => {
		const ctx = setup({ statuslinePrefix: "[clawback] " });
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await fetchPlain(port, "/_proxy/statusline");
			// Prefix + the always-on brand mark (no metric body fields).
			expect(r.body).toBe("[clawback] clawback");
		} finally {
			ctx.server.close();
		}
	});

	test("POST with claude session JSON merges its fields into the line", async () => {
		appendEvent({ type: "test", text: "hello" });
		const ctx = setup({ statuslineMaxChars: 200 });
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const claudeJson = JSON.stringify({
				model: { display_name: "Claude Opus 4.7" },
				context_window: { used_percentage: 33 },
				cost: { total_cost_usd: 0.05 },
			});
			const r = await new Promise((resolve, reject) => {
				const req = http.request(
					{
						method: "POST",
						host: "127.0.0.1",
						port,
						path: "/_proxy/statusline",
						headers: {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(claudeJson),
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
				req.end(claudeJson);
			});
			expect(r.status).toBe(200);
			// Model name is non-numeric → dropped. Only context (numeric+label) survives.
			expect(r.body).not.toMatch(/Claude Opus 4\.7/);
			// context is now a progress bar (eighths + light-shade track) rather
			// than a sparkline, so widen the glyph class accordingly.
			expect(r.body).toMatch(/context [▁-▏░]+\s+33%/);
			// Cost intentionally not surfaced.
			expect(r.body).not.toMatch(/\$/);
		} finally {
			ctx.server.close();
		}
	});

	test("POST renders ANSI color by default even though the server is headless", async () => {
		// Regression for operator-flagged 2026-05-28: the statusline rendered
		// colorless in the Claude Code TUI. The clawback server runs headless
		// (process.stdout.isTTY is false), so resolving color off the server's
		// own stdout stripped it — but the real sink is Claude Code's
		// ANSI-capable TUI. The endpoint now resolves color as isatty:true, so
		// statuslineColor "auto" (the shipped default) emits ANSI through the
		// HTTP path. Override the describe-wide "off" back to "auto" and guard
		// NO_COLOR so the assertion is deterministic in any CI env.
		const savedNoColor = process.env.NO_COLOR;
		// biome-ignore lint/performance/noDelete: delete is the only way to unset an env var; assigning undefined sets the string "undefined"
		delete process.env.NO_COLOR;
		const ctx = setup({ statuslineColor: "auto", statuslineMaxChars: 200 });
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await jsonPost(port, "/_proxy/statusline", {
				context_window: { used_percentage: 33 },
			});
			expect(r.status).toBe(200);
			// At least one ANSI SGR escape (the colored context bar cells).
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR escapes requires the ESC control char
			expect(r.body).toMatch(/\x1b\[[0-9;]+m/);
		} finally {
			ctx.server.close();
			// biome-ignore lint/performance/noDelete: delete is the only way to unset an env var; assigning undefined sets the string "undefined"
			if (savedNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = savedNoColor;
		}
	});

	test("POST writes a sample to the metrics ring with the same numbers the line renders", async () => {
		// PLAN §33: every statusline POST feeds the metrics ring so the
		// web UI can plot the same values the terminal shows. Verify the
		// integration end-to-end: POST → /_proxy/metrics returns the
		// sample with context/turn/mode populated. Read back through the
		// HTTP endpoint (not direct module import) to avoid any chance
		// of cross-module-instance state drift under jest-vm-modules.
		// Clear any leftover samples from earlier tests first.
		const ctx = setup({ statuslineMaxChars: 200 });
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			await jsonPost(port, "/_proxy/metrics", { action: "clear" });
			const claudeJson = JSON.stringify({
				context_window: {
					used_percentage: 33,
					current_usage: {
						input_tokens: 0,
						cache_read_input_tokens: 8000,
						cache_creation_input_tokens: 2000,
					},
				},
			});
			await new Promise((resolve, reject) => {
				const req = http.request(
					{
						method: "POST",
						host: "127.0.0.1",
						port,
						path: "/_proxy/statusline",
						headers: {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(claudeJson),
						},
					},
					(res) => {
						res.on("data", () => {});
						res.on("end", resolve);
					},
				);
				req.on("error", reject);
				req.end(claudeJson);
			});
			const fetched = await fetchJsonAdmin(port, "/_proxy/metrics");
			expect(fetched.samples).toHaveLength(1);
			expect(fetched.samples[0].source).toBe("statusline");
			expect(fetched.samples[0].context).toBe(33);
			// turn = 8000 / (8000 + 2000 + 0) = 80
			expect(fetched.samples[0].turn).toBe(80);
			expect(fetched.samples[0].mode).toMatchObject({
				passthrough: false,
				keepAliveEnabled: expect.any(Boolean),
				stripEphemeralFromSystem: expect.any(Boolean),
			});
		} finally {
			ctx.server.close();
		}
	});

	test("account-global quota: one session's reported quota lifts another session that never reported it", async () => {
		// PLAN §12.2: the five_hour ("quota") / seven_day ("week") windows are
		// account-global. A busy session reports fresh quota; an idle session's
		// payload carries no rate_limits (or a stale one). With accountGlobalQuota
		// on (the DEFAULTS) the idle session must render the busy session's
		// freshest value, not " na%". This is the cross-session integration of
		// recordQuotaObservation → overlayAccountQuota through the live endpoint.
		const ctx = setup({ statuslineMaxChars: 200 });
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			// Session A (busy) reports real plan quota on its last API response.
			const a = await jsonPost(port, "/_proxy/statusline/sessionA", {
				context_window: { used_percentage: 50 },
				rate_limits: {
					five_hour: { used_percentage: 85, resets_at: 1000 },
					seven_day: { used_percentage: 60, resets_at: 5000 },
				},
			});
			expect(a.status).toBe(200);
			expect(a.body).toMatch(/quota[^·]*85%/);
			expect(a.body).toMatch(/week[^·]*60%/);

			// Session B (idle) carries no rate_limits at all — pre-overlay it would
			// render the na% waiting placeholder. The overlay synthesizes the
			// account-global windows so B shows A's 85% / 60%.
			const b = await jsonPost(port, "/_proxy/statusline/sessionB", {
				context_window: { used_percentage: 5 },
			});
			expect(b.status).toBe(200);
			expect(b.body).toMatch(/quota[^·]*85%/);
			expect(b.body).toMatch(/week[^·]*60%/);
			expect(b.body).not.toMatch(/quota[^·]*na%/);
			// B's own per-session context field (labeled with its session id) is
			// untouched by the overlay — only rate_limits is lifted.
			expect(b.body).toMatch(/sessionB[^·]*5%/);
		} finally {
			ctx.server.close();
		}
	});

	test("account-global quota off renders the strict per-session value (na% for an idle session)", async () => {
		// The accountGlobalQuota kill-switch (multi-account escape hatch, §23):
		// with it off, a session that never reported rate_limits shows na%, even
		// after another session reported real quota.
		const ctx = setup({
			statuslineMaxChars: 200,
			accountGlobalQuota: false,
		});
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			await jsonPost(port, "/_proxy/statusline/sessionA", {
				context_window: { used_percentage: 50 },
				rate_limits: {
					five_hour: { used_percentage: 85, resets_at: 1000 },
					seven_day: { used_percentage: 60, resets_at: 5000 },
				},
			});
			const b = await jsonPost(port, "/_proxy/statusline/sessionB", {
				context_window: { used_percentage: 5 },
			});
			expect(b.status).toBe(200);
			expect(b.body).toMatch(/quota[^·]*na%/);
			expect(b.body).toMatch(/week[^·]*na%/);
		} finally {
			ctx.server.close();
		}
	});

	test("POST with malformed JSON body falls back to clawback-only render", async () => {
		appendEvent({ type: "test", text: "hello" });
		const ctx = setup();
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await new Promise((resolve, reject) => {
				const req = http.request(
					{
						method: "POST",
						host: "127.0.0.1",
						port,
						path: "/_proxy/statusline",
						headers: {
							"content-type": "application/json",
							"content-length": 12,
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
				req.end("not json !@#");
			});
			expect(r.status).toBe(200);
			// Malformed body falls through to the brand-only render. With no
			// claude session and an empty store, the body is just the brand.
			expect(r.body).toBe("clawback");
		} finally {
			ctx.server.close();
		}
	});

	test("DELETE returns 405", async () => {
		const ctx = setup();
		await new Promise((r) => ctx.server.listen(0, "127.0.0.1", r));
		const port = ctx.server.address().port;
		try {
			const r = await new Promise((resolve, reject) => {
				const req = http.request(
					{
						method: "DELETE",
						host: "127.0.0.1",
						port,
						path: "/_proxy/statusline",
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
				req.end();
			});
			expect(r.status).toBe(405);
		} finally {
			ctx.server.close();
		}
	});
});

describe("per-session statusline scoping (regression: borrowed metrics, 2026-06-02)", () => {
	// A scoped /_proxy/statusline/<id> request must render THAT session's own
	// hit/tps/ttft. Before the fix, a request for a session with no store
	// entry (claude launched but no /v1/messages forwarded yet) fell back to
	// mostRecentSession and borrowed a *sibling* session's numbers, so every
	// idle session's statusline showed the one active session's metrics —
	// "identical across sessions; ttft always green" (operator-flagged).
	const cfg = { ...DEFAULTS, statuslineColor: "off" };
	const attachedClaude = {
		context_window: {
			used_percentage: 42,
			current_usage: {
				input_tokens: 7,
				cache_read_input_tokens: 3,
				cache_creation_input_tokens: 0,
			},
		},
	};
	const sessionAAA = {
		key: "AAA",
		label: "alpha",
		lastActivity: "2026-06-02T10:00:00Z",
		cacheReadTokens: 900,
		cacheCreationTokens: 50,
		cacheMissTokens: 50,
		recentTps: [144, 144, 144, 144],
		recentTtftMs: [1234, 1234, 1234, 1234],
	};
	const storeWithAAA = {
		keys: () => ["AAA"],
		all: () => [sessionAAA],
		get: (k) => (k === "AAA" ? sessionAAA : undefined),
	};

	test("a scoped request for an unknown session does not borrow a sibling's tps", () => {
		const text = renderStatusline({
			config: cfg,
			store: storeWithAAA,
			requestedSessionId: "BBB", // not in the store
			clawbackSession: undefined, // store.get("BBB") miss
			claudeSession: attachedClaude,
		});
		// AAA's distinctive values must NOT leak into BBB's statusline (144 is
		// AAA's tps; 1234 was its ttft, which is no longer rendered at all).
		expect(text).not.toContain("144");
		expect(text).not.toContain("1234");
		// The tps column stays reserved (no reflow) via the waiting placeholder.
		expect(text).toMatch(/tps[▁-▒ ]*na/);
	});

	test("two known sessions render their own distinct metrics, not a shared aggregate", () => {
		const sessionBBB = {
			key: "BBB",
			label: "beta",
			lastActivity: "2026-06-02T11:00:00Z",
			cacheReadTokens: 100,
			cacheCreationTokens: 0,
			cacheMissTokens: 0,
			recentTps: [55, 55, 55, 55],
			recentTtftMs: [4321, 4321, 4321, 4321],
		};
		const store2 = {
			keys: () => ["AAA", "BBB"],
			all: () => [sessionAAA, sessionBBB],
			get: (k) =>
				k === "AAA" ? sessionAAA : k === "BBB" ? sessionBBB : undefined,
		};
		const a = renderStatusline({
			config: cfg,
			store: store2,
			requestedSessionId: "AAA",
			clawbackSession: sessionAAA,
			claudeSession: attachedClaude,
		});
		const b = renderStatusline({
			config: cfg,
			store: store2,
			requestedSessionId: "BBB",
			clawbackSession: sessionBBB,
			claudeSession: attachedClaude,
		});
		// tps is the distinguishing marker now (ttft 1234/4321 is no longer
		// rendered). Each session shows its own tps, never the sibling's.
		expect(a).toContain("144");
		expect(a).not.toContain("55");
		expect(b).toContain("55");
		expect(b).not.toContain("144");
	});

	test("the legacy no-id endpoint still aggregates via mostRecentSession", () => {
		// No requestedSessionId, no clawbackSession: the /_proxy/statusline
		// (no id, or _default) path must keep its pre-PLAN-§39 behavior.
		const text = renderStatusline({
			config: cfg,
			store: storeWithAAA,
			claudeSession: attachedClaude,
		});
		// tps (144) is the session-fed marker; ttft (1234) is no longer rendered.
		expect(text).toContain("144");
	});

	test("a scoped request for a known session renders that session's own metrics", () => {
		const text = renderStatusline({
			config: cfg,
			store: storeWithAAA,
			requestedSessionId: "AAA",
			clawbackSession: sessionAAA,
			claudeSession: attachedClaude,
		});
		// tps (144) is the session-fed marker; ttft (1234) is no longer rendered.
		expect(text).toContain("144");
	});
});
