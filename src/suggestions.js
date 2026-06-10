import { hasActiveInput } from "./claude_input.js";
import { listEvents } from "./events_log.js";

const RATE_LIMIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const TOGGLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const AUTO_CONTINUE_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const FIVE_XX_LOOKBACK_MS = 5 * 60 * 1000;
const NO_TRAFFIC_THRESHOLD_MS = 10 * 60 * 1000;
const MOBILE_RECENT_TOGGLE_MS = 60 * 60 * 1000;
const POST_BASELINE_WINDOW_MS = 30 * 60 * 1000;
const QUOTA_STARVATION_FRAC = 0.1;
const QUOTA_RESET_HORIZON_MS = 30 * 60 * 1000;
// Latest-sample window for context/quota/tps signals. Statusline POSTs
// fire on every Claude Code render tick (sub-second), so a 5-minute
// window captures "current state" without one stale sample bouncing
// the rule on and off.
const RECENT_SAMPLE_WINDOW_MS = 5 * 60 * 1000;
const CONTEXT_COMPACT_THRESHOLD_PCT = 85;
const CONTEXT_STOP_THRESHOLD_PCT = 92;
const QUOTA_NEAR_WALL_PCT = 75;
const MOBILE_TPS_SLOW_THRESHOLD = 30;
const MOBILE_TPS_TTFT_OK_MS = 1000;
// Tight-loop detection for the force-5m rule. A median inter-turn gap below
// this means turns arrive faster than the 5m TTL would evict — so the 1h
// write premium (which Claude Code pays natively, undocumented) buys nothing.
const TIGHT_LOOP_GAP_MS = 60_000;
// Require a few turns before calling a session a "loop" — also guards against
// medianInterTurnGap's 0 default for <2-turn sessions reading as "tight".
const TIGHT_LOOP_MIN_TURNS = 5;

const TOGGLE_EVENT_TYPES = new Set([
	"passthrough-toggle",
	"keep-alive-toggle",
	"strip-ephemeral-toggle",
	"extend-cache-ttl-toggle",
	"mobile-toggle",
	"keep-alive-extended-toggle",
	"auto-continue-toggle",
]);

/**
 * Per-knob and per-combination suggestion rules. Each rule:
 *   - id:               stable per-rule string (UI uses it for dismissal)
 *   - knob:             config field this rule recommends toggling
 *   - severity:         "info" | "warn"
 *   - message:          operator-facing copy
 *   - proposedConfig:   the change to apply if the operator accepts
 *   - applyEndpoint:    admin endpoint to POST to for one-click apply
 *   - applyBody:        request body for that POST
 *   - trigger(ctx):     true → suggestion fires; ctx = aggregated context
 *
 * Rules are evaluated in array order. The evaluator strips `trigger`
 * before returning so the response is JSON-serializable.
 *
 * Rule directions: rules that turn knobs OFF are first-class citizens
 * alongside the turn-ON rules — a knob that stops earning its keep
 * should suggest its own removal.
 */
export const RULES = [
	// ───── passthrough (baseline arm) ─────
	{
		id: "capture-baseline-due",
		knob: "passthrough",
		severity: "info",
		message:
			"It's been a while since the last baseline capture. " +
			"Apply: starts another — clawback turns off for a few turns to record " +
			"fresh baseline numbers, then re-enables itself automatically.",
		proposedConfig: { captureBaseline: true },
		applyEndpoint: "capture-baseline",
		applyBody: {},
		trigger: ({ history }) => {
			if (history.baselineCaptureActive) return false;
			const ago = history.baselineCapturedMsAgo;
			if (ago == null) return true;
			return ago > 6 * 60 * 60 * 1000;
		},
	},
	{
		id: "regression-vs-baseline",
		knob: "passthrough",
		severity: "warn",
		message:
			"Cache hit rate is materially below your last captured baseline and " +
			"no toggle has changed in the last 24h. clawback or the upstream may " +
			"have shifted under you. Apply: recaptures a fresh baseline to confirm.",
		proposedConfig: { captureBaseline: true },
		applyEndpoint: "capture-baseline",
		applyBody: {},
		trigger: ({ aggregateHitRate, history, toggleActivityLast24h }) => {
			const baseline = history.latestBaselineHitRate;
			if (baseline == null || aggregateHitRate == null) return false;
			if (toggleActivityLast24h > 0) return false;
			return baseline - aggregateHitRate > 0.2;
		},
	},
	{
		id: "toggle-changed-rebaseline",
		knob: "passthrough",
		severity: "info",
		// Closes the gap between capture-baseline-due (6h staleness) and
		// regression-vs-baseline (suppresses for 24h after any toggle, to
		// avoid noise during active tuning). After a knob flip, the
		// operator usually *wants* to know whether the change helped —
		// the rule fires 15 min later (system has stabilized) so they
		// get the nudge while the change is still fresh in their mind.
		message:
			"You changed a toggle recently and haven't captured a fresh " +
			"baseline since. Recapture to measure the impact of the change. " +
			"Apply: starts a fresh baseline capture.",
		proposedConfig: { captureBaseline: true },
		applyEndpoint: "capture-baseline",
		applyBody: {},
		trigger: ({ config, history, lastToggleMsAgo }) =>
			!config.passthrough &&
			!history.baselineCaptureActive &&
			lastToggleMsAgo != null &&
			lastToggleMsAgo > 15 * 60_000 &&
			(history.baselineCapturedMsAgo == null ||
				lastToggleMsAgo < history.baselineCapturedMsAgo),
	},

	// ───── keepAliveEnabled ─────
	{
		id: "keepalive-off-multiturn",
		knob: "keepAliveEnabled",
		severity: "warn",
		message:
			"Multi-turn sessions detected. Without keep-alive the prompt cache " +
			"will expire between turns and you'll pay full cache-creation cost " +
			"every time. Apply: turns keep-alive on so the cache survives between " +
			"turns.",
		proposedConfig: { keepAliveEnabled: true },
		applyEndpoint: "keep-alive",
		applyBody: { action: "on" },
		trigger: ({ config, sessions }) =>
			!config.keepAliveEnabled &&
			!config.passthrough &&
			sessions.some((s) => s.turns >= 2 && s.medianInterTurnGapMs > 5 * 60_000),
	},
	{
		id: "keepalive-single-turn-waste",
		knob: "keepAliveEnabled",
		severity: "info",
		message:
			"Keep-alive has been pinging single-turn sessions that never came " +
			"back. Turning it off saves ping cost; you can re-enable any time. " +
			"Apply: turns keep-alive off.",
		proposedConfig: { keepAliveEnabled: false },
		applyEndpoint: "keep-alive",
		applyBody: { action: "off" },
		trigger: ({ config, singleTurnIdleSessionsLast24h }) =>
			config.keepAliveEnabled &&
			!config.passthrough &&
			singleTurnIdleSessionsLast24h >= 3,
	},
	{
		id: "keepalive-quota-starvation",
		knob: "keepAliveEnabled",
		severity: "warn",
		message:
			"Token bucket is nearly empty and won't reset for a while. Pings " +
			"will eat into the same quota your real turns need. " +
			"Apply: turns keep-alive off until the bucket resets.",
		proposedConfig: { keepAliveEnabled: false },
		applyEndpoint: "keep-alive",
		applyBody: { action: "off" },
		trigger: ({ config, quotaStarvedSessions }) =>
			config.keepAliveEnabled &&
			!config.passthrough &&
			quotaStarvedSessions > 0,
	},

	// ───── injectExtendedCacheTtl (1h) ─────
	{
		id: "ttl-1h-long-sessions",
		knob: "injectExtendedCacheTtl",
		severity: "info",
		message:
			"Your sessions are long enough to benefit from the 1h extended " +
			"cache TTL. Apply: turns on the 1h extended cache TTL.",
		proposedConfig: { injectExtendedCacheTtl: true },
		applyEndpoint: "extend-cache-ttl",
		applyBody: { action: "on" },
		trigger: ({ config, medianSessionLifetimeMs }) =>
			!config.injectExtendedCacheTtl &&
			!config.passthrough &&
			medianSessionLifetimeMs != null &&
			medianSessionLifetimeMs > 15 * 60_000,
	},
	{
		id: "ttl-1h-short-sessions-waste",
		knob: "injectExtendedCacheTtl",
		severity: "info",
		message:
			"Sessions are too short to amortize 1h cache-creation cost. The 1h " +
			"tier charges more on the create side; without long idle gaps, you're " +
			"paying for survival you don't need. Apply: disables the 1h cache TTL.",
		proposedConfig: { injectExtendedCacheTtl: false },
		applyEndpoint: "extend-cache-ttl",
		applyBody: { action: "off" },
		trigger: ({ config, medianSessionLifetimeMs, longestSessionLifetimeMs }) =>
			config.injectExtendedCacheTtl &&
			!config.passthrough &&
			medianSessionLifetimeMs != null &&
			medianSessionLifetimeMs < 5 * 60_000 &&
			longestSessionLifetimeMs != null &&
			longestSessionLifetimeMs < 15 * 60_000,
	},
	{
		// Distinct from ttl-1h-short-sessions-waste above: that rule only
		// stops clawback *injecting* 1h. It does nothing about the 1h
		// headers Claude Code writes natively (undocumented; v2.1.145 tags
		// 2 system breakpoints ttl:"1h"). On a tight loop those native 1h
		// writes are pure waste — reads land inside 5m, so the 1h create
		// premium buys no survival. This rule turns on strip-1h, which
		// actively rewrites those native headers down to the documented 5m,
		// and drops the keep-alive cadence back to match.
		id: "strip-1h-tight-loop",
		knob: "stripExtendedCacheTtl",
		severity: "info",
		message:
			"Tight loop detected: turns arrive faster than the 5-min cache " +
			"evicts. Claude Code natively writes at the 1h tier (undocumented), " +
			"and that premium buys nothing when reads land within 5 min — you're " +
			"overpaying on every cache write. Apply: forces the documented 5m TTL " +
			"and switches keep-alive back to the matching 1-4 min cadence.",
		proposedConfig: {
			stripExtendedCacheTtl: true,
			keepAliveModeExtended: false,
		},
		applyEndpoint: "tight-loop",
		applyBody: { action: "on" },
		trigger: ({ config, sessions }) =>
			!config.stripExtendedCacheTtl &&
			!config.passthrough &&
			sessions.some(
				(s) =>
					s.turns >= TIGHT_LOOP_MIN_TURNS &&
					s.medianInterTurnGapMs > 0 &&
					s.medianInterTurnGapMs < TIGHT_LOOP_GAP_MS,
			),
	},

	// ───── stripEphemeralFromSystem ─────
	{
		id: "strip-ephemeral-low-hit",
		knob: "stripEphemeralFromSystem",
		severity: "warn",
		message:
			"Cache hit rate is below 50%. Date strings in your system prompt " +
			"may be invalidating the cache; strip-ephemeral normalizes them. " +
			"Apply: turns strip-ephemeral on.",
		proposedConfig: { stripEphemeralFromSystem: true },
		applyEndpoint: "strip-ephemeral",
		applyBody: { action: "on" },
		trigger: ({ config, aggregateHitRate }) =>
			!config.stripEphemeralFromSystem &&
			!config.passthrough &&
			aggregateHitRate != null &&
			aggregateHitRate < 0.5,
	},
	{
		id: "strip-ephemeral-still-low",
		knob: "stripEphemeralFromSystem",
		severity: "info",
		message:
			"strip-ephemeral is on but hit rate is still low. The regex set may " +
			"not cover every volatile token in your prompt — consider sharing " +
			"the system prompt so the patterns can be extended.",
		proposedConfig: {},
		applyEndpoint: null,
		applyBody: null,
		trigger: ({ config, aggregateHitRate }) =>
			config.stripEphemeralFromSystem &&
			!config.passthrough &&
			aggregateHitRate != null &&
			aggregateHitRate < 0.4,
	},

	// ───── mobile ─────
	{
		id: "mobile-slow-ttft",
		knob: "mobile",
		severity: "info",
		message:
			"Median TTFT is over 2s. If you're on a tethered or slow connection, " +
			"mobile mode (gzip + non-streaming) cuts radio-on time to save battery. " +
			"Apply: turns mobile mode on (gzip + non-streaming).",
		proposedConfig: { mobile: true },
		applyEndpoint: "mobile",
		applyBody: { action: "on" },
		trigger: ({ config, medianTtftMs }) =>
			!config.mobile && medianTtftMs != null && medianTtftMs > 2000,
	},
	{
		id: "mobile-on-fast-net",
		knob: "mobile",
		severity: "info",
		message:
			"Network looks fast now — non-streaming responses are costing you " +
			"TTFT for compression savings you no longer need. " +
			"Apply: turns mobile mode off.",
		proposedConfig: { mobile: false },
		applyEndpoint: "mobile",
		applyBody: { action: "off" },
		trigger: ({ config, medianTtftMs, mobileToggleMsAgo }) =>
			config.mobile &&
			medianTtftMs != null &&
			medianTtftMs < 400 &&
			mobileToggleMsAgo != null &&
			mobileToggleMsAgo > MOBILE_RECENT_TOGGLE_MS,
	},

	// ───── keepAliveModeExtended ─────
	{
		id: "extended-cadence-with-1h",
		knob: "keepAliveModeExtended",
		severity: "info",
		message:
			"1h TTL is on but pings still fire every 1-4 minutes. The extended " +
			"15-45m cadence cuts keep-alive cost ~6-12×. " +
			"Apply: switches to the 15-45m extended cadence.",
		proposedConfig: { keepAliveModeExtended: true },
		applyEndpoint: "keep-alive-extended",
		applyBody: { action: "on" },
		trigger: ({ config }) =>
			config.injectExtendedCacheTtl &&
			!config.keepAliveModeExtended &&
			!config.passthrough,
	},
	{
		id: "extended-misconfig-no-ttl",
		knob: "keepAliveModeExtended",
		severity: "warn",
		message:
			"Extended cadence (15-45 min) without 1h TTL: your 5-min cache will " +
			"expire between pings, defeating keep-alive. " +
			"Apply: switches back to the default 1-4 min cadence.",
		proposedConfig: { keepAliveModeExtended: false },
		applyEndpoint: "keep-alive-extended",
		applyBody: { action: "off" },
		trigger: ({ config }) =>
			config.keepAliveModeExtended &&
			!config.injectExtendedCacheTtl &&
			!config.passthrough,
	},

	// ───── autoContinue ─────
	{
		id: "auto-continue-hit-wall",
		knob: "autoContinue",
		severity: "warn",
		message:
			"You've hit rate-limit walls in the last 24h. Auto-continue resumes " +
			"claude automatically when the cap clears. " +
			"Apply: turns auto-continue on.",
		proposedConfig: { autoContinue: true },
		applyEndpoint: "auto-continue",
		applyBody: { action: "on" },
		trigger: ({ config, rateLimitHitsLast24h, ptyActive }) =>
			!config.autoContinue && rateLimitHitsLast24h > 0 && ptyActive,
	},
	{
		id: "auto-continue-no-pty",
		knob: "autoContinue",
		severity: "info",
		message:
			"Auto-continue is on but no claude PTY is attached to this clawback. " +
			"Launch via `clawback claude`, or accept that the cap-clear signal " +
			"won't fire any action.",
		proposedConfig: {},
		applyEndpoint: null,
		applyBody: null,
		trigger: ({ config, ptyActive, rateLimitHitsLast24h }) =>
			config.autoContinue && !ptyActive && rateLimitHitsLast24h > 0,
	},

	// ───── K+T+E: the long-session stack ─────
	{
		id: "stack-cold-suggest-all",
		knob: "keepAliveEnabled",
		severity: "info",
		message:
			"First long-running session detected. The keep-alive + 1h TTL + " +
			"extended cadence trio is what this proxy was built for. " +
			"Apply: turns on all three at once.",
		proposedConfig: {
			keepAliveEnabled: true,
			injectExtendedCacheTtl: true,
			keepAliveModeExtended: true,
		},
		applyEndpoint: "stack",
		applyBody: { action: "on" },
		trigger: ({ config, longestSessionLifetimeMs, toggleActivityLast24h }) =>
			!config.passthrough &&
			!config.keepAliveEnabled &&
			!config.injectExtendedCacheTtl &&
			!config.keepAliveModeExtended &&
			longestSessionLifetimeMs != null &&
			longestSessionLifetimeMs > 30 * 60_000 &&
			toggleActivityLast24h === 0,
	},
	{
		id: "stack-partial-completion",
		knob: "keepAliveEnabled",
		severity: "info",
		message:
			"You're 2/3 of the way to the full long-session stack. " +
			"Apply: turns on the remaining knob to complete it.",
		proposedConfig: {
			keepAliveEnabled: true,
			injectExtendedCacheTtl: true,
			keepAliveModeExtended: true,
		},
		applyEndpoint: "stack",
		applyBody: { action: "on" },
		trigger: ({ config }) => {
			if (config.passthrough) return false;
			const k = config.keepAliveEnabled ? 1 : 0;
			const t = config.injectExtendedCacheTtl ? 1 : 0;
			const e = config.keepAliveModeExtended ? 1 : 0;
			// Exact-2 partial state. The extended-cadence-with-1h rule
			// already handles K-off T-on E-off as a special case; we
			// don't double-fire because that rule needs E off too.
			if (k + t + e !== 2) return false;
			// Suppress when T-on E-off K-* — extended-cadence-with-1h owns it.
			if (t === 1 && e === 0) return false;
			return true;
		},
	},
	{
		id: "stack-not-helping",
		knob: "passthrough",
		severity: "warn",
		message:
			"Baseline shows the long-session stack barely moves your hit rate. " +
			"Your spend pattern may not benefit from cache warming as much as " +
			"the defaults assume. Apply: recaptures a fresh baseline to confirm.",
		proposedConfig: { captureBaseline: true },
		applyEndpoint: "capture-baseline",
		applyBody: {},
		trigger: ({ config, aggregateHitRate, history }) => {
			if (config.passthrough) return false;
			if (
				!config.keepAliveEnabled ||
				!config.injectExtendedCacheTtl ||
				!config.keepAliveModeExtended
			) {
				return false;
			}
			const baseline = history.latestBaselineHitRate;
			if (baseline == null || aggregateHitRate == null) return false;
			return aggregateHitRate - baseline < 0.05;
		},
	},

	// ───── Post-baseline learning ─────
	{
		id: "post-baseline-enable-s",
		knob: "stripEphemeralFromSystem",
		severity: "info",
		message:
			"Baseline captured — your raw hit rate is low. strip-ephemeral is " +
			"likely the highest-leverage knob for you. " +
			"Apply: turns strip-ephemeral back on.",
		proposedConfig: { stripEphemeralFromSystem: true },
		applyEndpoint: "strip-ephemeral",
		applyBody: { action: "on" },
		trigger: ({ config, history }) =>
			!config.stripEphemeralFromSystem &&
			!config.passthrough &&
			history.baselineCapturedMsAgo != null &&
			history.baselineCapturedMsAgo < POST_BASELINE_WINDOW_MS &&
			history.latestBaselineHitRate != null &&
			history.latestBaselineHitRate < 0.5,
	},
	{
		id: "post-baseline-skip-s",
		knob: "stripEphemeralFromSystem",
		severity: "info",
		message:
			"Your raw hit rate is already high. strip-ephemeral is unlikely to " +
			"move it meaningfully — leaving it off keeps wire bytes identical to " +
			"what your client sent.",
		proposedConfig: {},
		applyEndpoint: null,
		applyBody: null,
		trigger: ({ config, history }) =>
			!config.stripEphemeralFromSystem &&
			!config.passthrough &&
			history.baselineCapturedMsAgo != null &&
			history.baselineCapturedMsAgo < POST_BASELINE_WINDOW_MS &&
			history.latestBaselineHitRate != null &&
			history.latestBaselineHitRate >= 0.75,
	},
	{
		id: "baseline-no-traffic",
		knob: "passthrough",
		severity: "info",
		message:
			"Baseline capture is running but no traffic is flowing. Send a few " +
			"turns or cancel — clawback is staying off while it waits.",
		proposedConfig: {},
		applyEndpoint: null,
		applyBody: null,
		trigger: ({ history, lastClientTrafficMsAgo }) =>
			history.baselineCaptureActive &&
			lastClientTrafficMsAgo != null &&
			lastClientTrafficMsAgo > NO_TRAFFIC_THRESHOLD_MS,
	},

	// ───── K + A: cache-warm through cooldown ─────
	{
		id: "auto-continue-without-keepalive",
		knob: "keepAliveEnabled",
		severity: "warn",
		message:
			"Auto-continue will resume claude when the cap clears, but the " +
			"prompt cache will be cold by then. " +
			"Apply: turns keep-alive on so the resume is also a cache hit.",
		proposedConfig: { keepAliveEnabled: true },
		applyEndpoint: "keep-alive",
		applyBody: { action: "on" },
		trigger: ({ config, autoContinueFiresLast2h }) =>
			config.autoContinue &&
			!config.keepAliveEnabled &&
			!config.passthrough &&
			autoContinueFiresLast2h > 0,
	},
	{
		id: "cooldown-longer-than-5m-cache",
		knob: "injectExtendedCacheTtl",
		severity: "info",
		message:
			"Your cooldown is longer than the 5-min ephemeral cache window. " +
			"Even with keep-alive on, the cache won't survive the wait. " +
			"Apply: turns on the 1h TTL and extended cadence so the cache makes " +
			"it through.",
		proposedConfig: {
			keepAliveEnabled: true,
			injectExtendedCacheTtl: true,
			keepAliveModeExtended: true,
		},
		applyEndpoint: "stack",
		applyBody: { action: "on" },
		trigger: ({ config, maxRecentCooldownMs }) =>
			config.autoContinue &&
			config.keepAliveEnabled &&
			!config.injectExtendedCacheTtl &&
			!config.passthrough &&
			maxRecentCooldownMs != null &&
			maxRecentCooldownMs > 60 * 60_000,
	},
	// `auto-continue-during-baseline` removed 2026-05-27: the rule was
	// self-defeating. Applying it (POST /_proxy/auto-continue {off})
	// during the baseline window was itself a toggle event that
	// polluted the very baseline it claimed to protect. Replaced by
	// extending the passthrough hard bundle to also force
	// `autoContinue: false` (see src/config.js + applyPassthrough in
	// src/admin.js), which parks auto-continue silently for the
	// baseline window and restores it from `_baselineSnapshot` when
	// the operator exits passthrough. No rule needed — the bundle
	// makes the state correct by construction.

	// ───── Passthrough as diagnostic shortcut ─────
	{
		id: "upstream-failure-isolate",
		knob: "passthrough",
		severity: "warn",
		message:
			"Upstream has been failing repeatedly. " +
			"Apply: flips passthrough on to rule clawback out as the cause; " +
			"if 5xxs persist with passthrough, the issue is Anthropic-side.",
		proposedConfig: { passthrough: true },
		applyEndpoint: "passthrough",
		applyBody: { action: "on" },
		trigger: ({ config, consecutive5xxLast5min }) =>
			!config.passthrough && consecutive5xxLast5min >= 3,
	},
	{
		id: "engine-silent",
		knob: "passthrough",
		severity: "info",
		message:
			"Nothing to suggest right now. Either your config is already " +
			"well-tuned for your traffic, or clawback doesn't have enough " +
			"signal yet. Apply: captures a fresh baseline, or run heavier " +
			"workloads first.",
		proposedConfig: { captureBaseline: true },
		applyEndpoint: "capture-baseline",
		applyBody: {},
		trigger: ({ toggleActivityLast24h, history, eventCount }) =>
			// Need enough events recorded to trust the "no toggles" signal
			// (avoids a fresh proxy firing this on minute one), and an
			// existing baseline so the apply-action isn't a duplicate of
			// capture-baseline-due.
			eventCount >= 5 &&
			toggleActivityLast24h === 0 &&
			history.baselineCapturedMsAgo != null,
	},

	// ───── Context-window pressure (context chart) ─────
	{
		id: "context-near-limit-compact",
		// Advisory rule — there's no clawback knob this maps to.
		// `knob` is set to a real config field so existing UI code
		// reading `rule.knob` doesn't choke; the rule's true action is
		// the PTY /compact below.
		knob: "autoContinue",
		severity: "info",
		message:
			"Context window is filling up. " +
			"Apply: sends /compact to claude to free space. " +
			"(No PTY attached = no card.)",
		proposedConfig: {},
		applyEndpoint: "claude/input",
		applyBody: { text: "/compact\r" },
		trigger: ({ latestContextPct, ptyActive }) =>
			// Suppress entirely without a PTY: /compact has nowhere to go.
			ptyActive &&
			latestContextPct != null &&
			latestContextPct >= CONTEXT_COMPACT_THRESHOLD_PCT &&
			latestContextPct < CONTEXT_STOP_THRESHOLD_PCT,
	},
	{
		id: "context-stop-before-cap",
		knob: "passthrough",
		severity: "warn",
		// Advisory-only: no apply action. The card warns; the operator
		// decides what to do. A future soft-pause feature (PLAN §15.2)
		// will give this rule a real apply target — block + queue
		// further turns at the proxy until the quota window resets,
		// so the operator hits a clawback-managed soft cap rather than
		// Anthropic's hard cap mid-turn.
		message:
			"Context is near the cap AND your quota is close to the wall. " +
			"Hitting Anthropic's hard cap mid-turn is worse than stopping " +
			"voluntarily — wrap up this turn, then let your quota reset. " +
			"Remember: keep-alive pings continue burning tokens until reset; " +
			"check keepAliveReserve on /_proxy/health and leave headroom.",
		proposedConfig: {},
		applyEndpoint: null,
		applyBody: null,
		trigger: ({ latestContextPct, latestNextPct, ptyActive }) =>
			// Only show when there's an attached claude — otherwise the
			// "stop your session" advice has no addressee.
			ptyActive &&
			latestContextPct != null &&
			latestContextPct >= CONTEXT_STOP_THRESHOLD_PCT &&
			latestNextPct != null &&
			latestNextPct >= QUOTA_NEAR_WALL_PCT,
	},

	// ───── TPS chart: mobile mode hiding throughput ─────
	{
		id: "mobile-low-tps-non-streaming",
		knob: "mobile",
		severity: "info",
		message:
			"Mobile mode forces non-streaming, which can make output throughput " +
			"feel slow. Your network looks fast enough (TTFT is reasonable). " +
			"Apply: turns mobile mode off to restore streaming and bring TPS " +
			"back up.",
		proposedConfig: { mobile: false },
		applyEndpoint: "mobile",
		applyBody: { action: "off" },
		trigger: ({ config, medianTps, medianTtftMs }) =>
			config.mobile &&
			medianTps != null &&
			medianTps < MOBILE_TPS_SLOW_THRESHOLD &&
			medianTtftMs != null &&
			medianTtftMs < MOBILE_TPS_TTFT_OK_MS,
	},
];

/**
 * Evaluate every rule against `context` and return the applicable ones,
 * stripped of their `trigger` function so the result is JSON-safe.
 */
export function evaluate(context) {
	const out = [];
	for (const rule of RULES) {
		let fires = false;
		try {
			fires = Boolean(rule.trigger(context));
		} catch {
			fires = false;
		}
		if (!fires) continue;
		const { trigger, ...rest } = rule;
		void trigger;
		out.push(rest);
	}
	return out;
}

/**
 * Build the evaluation context. Pulls from the in-memory store, the
 * metrics ring (samples passed in), and the event log ring. Keep this
 * cheap — it runs on every poll of `/_proxy/suggestions`.
 */
export function buildContext({
	config,
	store,
	samples = [],
	now = Date.now(),
} = {}) {
	const storeSessions = store?.all?.() ?? [];
	const sessions = storeSessions.map((s) => sessionStats(s, now));

	const aggregateHitRate = computeAggregateHitRate(storeSessions);
	const medianTtftMs = computeMedianTtft(storeSessions);
	const medianSessionLifetimeMs = computeMedianLifetime(sessions);
	const longestSessionLifetimeMs = computeLongestLifetime(sessions);
	const lastClientTrafficMsAgo = computeLastClientTrafficMsAgo(
		storeSessions,
		now,
	);
	const singleTurnIdleSessionsLast24h = countSingleTurnIdle(storeSessions, now);
	const quotaStarvedSessions = countQuotaStarved(storeSessions, now);
	const events = listEvents({ limit: 200 });
	const rateLimitHitsLast24h = countEvents(
		events,
		now,
		RATE_LIMIT_LOOKBACK_MS,
		(e) => e.type === "rate-limit-hit" || e.type === "auth-stale",
	);
	const toggleActivityLast24h = countEvents(
		events,
		now,
		TOGGLE_LOOKBACK_MS,
		(e) => TOGGLE_EVENT_TYPES.has(e.type),
	);
	const consecutive5xxLast5min = countEvents(
		events,
		now,
		FIVE_XX_LOOKBACK_MS,
		(e) => e.type === "upstream-5xx",
	);
	const mobileToggleMsAgo = lastEventMsAgo(
		events,
		now,
		(e) => e.type === "mobile-toggle",
	);
	const lastToggleMsAgo = lastEventMsAgo(events, now, (e) =>
		TOGGLE_EVENT_TYPES.has(e.type),
	);
	const autoContinueFireEvents = recentEventsByType(
		events,
		now,
		AUTO_CONTINUE_LOOKBACK_MS,
		"auto-continue-fire",
	);
	const maxRecentCooldownMs = maxMetaField(
		autoContinueFireEvents,
		"cooldownMs",
	);
	const latestBaselineEvent = lastEventByType(events, "baseline-captured");
	const latestBaselineHitRate =
		latestBaselineEvent?.meta?.hitRate != null
			? latestBaselineEvent.meta.hitRate
			: null;
	const baselineCapturedMsAgo =
		latestBaselineEvent != null
			? Math.max(0, now - Date.parse(latestBaselineEvent.ts))
			: null;
	const baselineCaptureActive = Boolean(config?._baselineCapture?.active);

	// Statusline-derived signals (context %, quota %, tps): pulled from
	// the recent samples window. Latest = most recent finite value in
	// the window; median over all finite values gives the steady-state
	// reading rules want, not a single-tick spike.
	const recentSamples = samples.filter((s) => {
		const t = s?.ts ? Date.parse(s.ts) : Number.NaN;
		return Number.isFinite(t) && now - t <= RECENT_SAMPLE_WINDOW_MS;
	});
	const latestContextPct = latestFiniteFrom(recentSamples, "context");
	const latestNextPct = latestFiniteFrom(recentSamples, "next");
	const medianTps = medianFiniteFrom(recentSamples, "tps");

	return {
		config,
		samples,
		sessions,
		aggregateHitRate,
		medianTtftMs,
		medianSessionLifetimeMs,
		longestSessionLifetimeMs,
		rateLimitHitsLast24h,
		ptyActive: hasActiveInput(),
		singleTurnIdleSessionsLast24h,
		quotaStarvedSessions,
		lastClientTrafficMsAgo,
		consecutive5xxLast5min,
		mobileToggleMsAgo,
		lastToggleMsAgo,
		autoContinueFiresLast2h: autoContinueFireEvents.length,
		maxRecentCooldownMs,
		toggleActivityLast24h,
		eventCount: events.length,
		latestContextPct,
		latestNextPct,
		medianTps,
		history: {
			everToggledPassthrough: events.some(
				(e) => e.type === "passthrough-toggle",
			),
			baselineCapturedMsAgo,
			baselineCaptureActive,
			latestBaselineHitRate,
		},
	};
}

function latestFiniteFrom(samples, field) {
	for (let i = samples.length - 1; i >= 0; i--) {
		const v = samples[i]?.[field];
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return null;
}

function medianFiniteFrom(samples, field) {
	const vals = [];
	for (const s of samples) {
		const v = s?.[field];
		if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
	}
	return median(vals);
}

function sessionStats(session, now) {
	const turns = session.turnCount ?? session.recentTtftMs?.length ?? 0;
	const createdAtMs = session.createdAt
		? Date.parse(session.createdAt) || null
		: null;
	const lastSeenAtMs = activityMs(session);
	const lifetimeMs =
		createdAtMs != null ? (lastSeenAtMs ?? now) - createdAtMs : null;
	return {
		key: session.key,
		turns,
		lifetimeMs,
		createdAtMs,
		lastSeenAtMs,
		medianInterTurnGapMs: medianInterTurnGap(session),
	};
}

function activityMs(session) {
	const candidate = session.lastSeenAt ?? session.lastActivity ?? null;
	if (!candidate) return null;
	const t = Date.parse(candidate);
	return Number.isFinite(t) ? t : null;
}

function medianInterTurnGap(session) {
	const turns = session.turnCount ?? session.recentTtftMs?.length ?? 0;
	const createdAt = session.createdAt
		? Date.parse(session.createdAt)
		: Number.NaN;
	const lastSeen = activityMs(session);
	if (turns < 2 || !Number.isFinite(createdAt) || !Number.isFinite(lastSeen)) {
		return 0;
	}
	return (lastSeen - createdAt) / Math.max(1, turns - 1);
}

function computeAggregateHitRate(sessions) {
	let read = 0;
	let create = 0;
	let miss = 0;
	for (const s of sessions) {
		read += s.cacheReadTokens ?? 0;
		create += s.cacheCreationTokens ?? 0;
		miss += s.cacheMissTokens ?? 0;
	}
	const total = read + create + miss;
	if (total <= 0) return null;
	return read / total;
}

function computeMedianTtft(sessions) {
	const all = [];
	for (const s of sessions) {
		const ring = s.recentTtftMs;
		if (Array.isArray(ring)) {
			for (const v of ring) {
				if (Number.isFinite(v) && v > 0) all.push(v);
			}
		}
	}
	return median(all);
}

function computeMedianLifetime(sessionStatsList) {
	const ls = [];
	for (const s of sessionStatsList) {
		if (s.lifetimeMs != null && s.lifetimeMs >= 0) ls.push(s.lifetimeMs);
	}
	return median(ls);
}

function computeLongestLifetime(sessionStatsList) {
	let max = null;
	for (const s of sessionStatsList) {
		if (s.lifetimeMs == null || s.lifetimeMs < 0) continue;
		if (max == null || s.lifetimeMs > max) max = s.lifetimeMs;
	}
	return max;
}

function computeLastClientTrafficMsAgo(sessions, now) {
	let latest = null;
	for (const s of sessions) {
		const t = activityMs(s);
		if (t == null) continue;
		if (latest == null || t > latest) latest = t;
	}
	if (latest == null) return null;
	return Math.max(0, now - latest);
}

/**
 * Single-turn idle session count: sessions that had exactly one real turn
 * and have now idled past their `targetTtl`. Falls back to a 30-min idle
 * threshold when targetTtl is unset. Restricted to sessions active within
 * the last 24h so very old single-turn sessions don't keep firing the rule.
 */
function countSingleTurnIdle(sessions, now) {
	let n = 0;
	for (const s of sessions) {
		const turns = s.turnCount ?? s.recentTtftMs?.length ?? 0;
		if (turns !== 1) continue;
		const lastMs = activityMs(s);
		if (lastMs == null) continue;
		if (now - lastMs > 24 * 60 * 60 * 1000) continue;
		const targetTtlMs = s.targetTtl ? Date.parse(s.targetTtl) : Number.NaN;
		const idleThresholdMs = Number.isFinite(targetTtlMs)
			? targetTtlMs
			: lastMs + 30 * 60_000;
		if (now > idleThresholdMs) n++;
	}
	return n;
}

/**
 * Sessions whose last-observed token bucket is below QUOTA_STARVATION_FRAC
 * of a notional full bucket AND whose reset is further away than
 * QUOTA_RESET_HORIZON_MS. The fraction is approximated against a per-bucket
 * heuristic (we don't always know the cap) — if `tokens_limit` is present,
 * use it; otherwise treat any value ≤500 as "starved" since clawback can't
 * meaningfully ping under that.
 */
function countQuotaStarved(sessions, now) {
	let n = 0;
	for (const s of sessions) {
		const rl = s.lastRateLimit;
		if (!rl || typeof rl !== "object") continue;
		const remaining = pickNumber(
			rl.tokens_remaining,
			rl.input_tokens_remaining,
			rl.output_tokens_remaining,
		);
		if (remaining == null) continue;
		const limit = pickNumber(rl.tokens_limit, rl.input_tokens_limit);
		const starved =
			limit != null
				? remaining / limit < QUOTA_STARVATION_FRAC
				: remaining <= 500;
		if (!starved) continue;
		const resetMs = s.targetTtl ? Date.parse(s.targetTtl) : Number.NaN;
		if (!Number.isFinite(resetMs)) continue;
		if (resetMs - now > QUOTA_RESET_HORIZON_MS) n++;
	}
	return n;
}

function pickNumber(...vals) {
	for (const v of vals) {
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return null;
}

function countEvents(events, now, windowMs, predicate) {
	const cutoff = now - windowMs;
	let n = 0;
	for (const ev of events) {
		const t = Date.parse(ev.ts);
		if (!Number.isFinite(t) || t < cutoff) continue;
		if (predicate(ev)) n++;
	}
	return n;
}

function lastEventMsAgo(events, now, predicate) {
	let latest = null;
	for (const ev of events) {
		if (!predicate(ev)) continue;
		const t = Date.parse(ev.ts);
		if (!Number.isFinite(t)) continue;
		if (latest == null || t > latest) latest = t;
	}
	if (latest == null) return null;
	return Math.max(0, now - latest);
}

function lastEventByType(events, type) {
	let latest = null;
	for (const ev of events) {
		if (ev.type !== type) continue;
		const t = Date.parse(ev.ts);
		if (!Number.isFinite(t)) continue;
		if (latest == null || t > Date.parse(latest.ts)) latest = ev;
	}
	return latest;
}

function recentEventsByType(events, now, windowMs, type) {
	const cutoff = now - windowMs;
	const out = [];
	for (const ev of events) {
		if (ev.type !== type) continue;
		const t = Date.parse(ev.ts);
		if (!Number.isFinite(t) || t < cutoff) continue;
		out.push(ev);
	}
	return out;
}

function maxMetaField(events, field) {
	let max = null;
	for (const ev of events) {
		const v = ev?.meta?.[field];
		if (typeof v !== "number" || !Number.isFinite(v)) continue;
		if (max == null || v > max) max = v;
	}
	return max;
}

function median(arr) {
	if (!arr || arr.length === 0) return null;
	const sorted = arr.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid];
	return (sorted[mid - 1] + sorted[mid]) / 2;
}
