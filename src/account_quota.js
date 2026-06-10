/**
 * Account-global plan-quota state (PLAN §12.2).
 *
 * Anthropic's 5-hour (`five_hour`) and 7-day (`seven_day`) rate-limit
 * windows are properties of the *account*, not of any single Claude Code
 * session. But each session's statusline payload only carries the
 * `rate_limits` snapshot from *that session's* last API response — so an
 * idle session keeps reporting a stale (too-low) `used_percentage` while a
 * busy session burns the shared quota. Claude Code refreshes the statusline
 * on a timer, so a naive "last report wins" would let the idle session's
 * stale value clobber the busy session's fresh one, and the displayed quota
 * would thrash between sessions.
 *
 * This module keeps one account-global observation per window so every
 * session can render the same, freshest value. Two facts let us merge
 * trustworthily *without* a reliable observation timestamp (the payload
 * carries none):
 *
 *   - `resets_at` identifies the window: same `resets_at` ⇒ same window.
 *   - `used_percentage` is monotonically non-decreasing *within* a window —
 *     usage only accrues until the window resets.
 *
 * So the merge rule per window is:
 *   - newer `resets_at`  → supersede (the window rolled over; take the new,
 *                          typically lower value),
 *   - same  `resets_at`  → keep MAX `used_percentage` (the most-current
 *                          reading across sessions),
 *   - older `resets_at`  → ignore (a stale session reporting a window we've
 *                          already moved past).
 * When `resets_at` is absent on either side (older Claude Code, or a partial
 * payload) we can't identify the window, so we fall back to last-writer-wins
 * for that window — the best available with no window identity.
 *
 * State is process-global and in-memory: the windows are short (≤ 7 days)
 * and a proxy restart simply relearns from the next statusline POST that
 * carries `rate_limits`. No persistence is warranted.
 *
 * SINGLE-ACCOUNT ONLY. This deliberately assumes every session belongs to
 * one Anthropic account. Running two accounts through one proxy would
 * cross-contaminate their quotas — that's gated behind multi-account
 * attribution (PLAN §23) and the operator-facing `accountGlobalQuota`
 * kill-switch.
 */

// The two plan-quota windows we treat as account-global. The per-minute
// token bucket (response-header rate limits) is per-request and not part of
// this — it lives on the session record (see server.js `lastRateLimit`).
export const ACCOUNT_QUOTA_WINDOWS = ["five_hour", "seven_day"];

// window name -> { resetsAt: number|null, pct: number }
const observations = new Map();

function readResetsAt(block) {
	const r = block?.resets_at;
	return typeof r === "number" && Number.isFinite(r) ? r : null;
}

/**
 * Fold a session's `rate_limits` payload into the account-global state. A
 * missing/garbage payload, or a window with a non-numeric `used_percentage`,
 * is silently skipped (advisory — never throws, never breaks a render).
 */
export function recordQuotaObservation(rateLimits) {
	if (!rateLimits || typeof rateLimits !== "object") return;
	for (const name of ACCOUNT_QUOTA_WINDOWS) {
		const block = rateLimits[name];
		const pct = block?.used_percentage;
		if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
		const resetsAt = readResetsAt(block);
		const prev = observations.get(name);
		if (!prev) {
			observations.set(name, { resetsAt, pct });
			continue;
		}
		if (resetsAt != null && prev.resetsAt != null) {
			if (resetsAt > prev.resetsAt) {
				observations.set(name, { resetsAt, pct }); // window rolled over
			} else if (resetsAt === prev.resetsAt && pct > prev.pct) {
				observations.set(name, { resetsAt, pct }); // same window, fresher reading
			}
			// resetsAt < prev.resetsAt → a stale, older window; ignore.
		} else {
			// No window identity on one side → best-effort last-writer-wins.
			observations.set(name, { resetsAt: resetsAt ?? prev.resetsAt, pct });
		}
	}
}

/** The account-global observation for a window, or null if none recorded. */
export function getQuotaObservation(window) {
	return observations.get(window) ?? null;
}

/**
 * Return a shallow clone of `claudeSession` whose `rate_limits` reflect the
 * account-global observation for each known window — synthesizing the block
 * when this session has never reported that window itself (e.g. a fresh
 * session in an account whose quota another session already established).
 *
 * Returns the input unchanged when there's no account-global state yet, or
 * when `claudeSession` isn't a usable object. Only `rate_limits` is touched;
 * `context_window` and every other field pass through by reference, so the
 * per-session `context`/`turn` fields are unaffected.
 */
export function overlayAccountQuota(claudeSession) {
	if (
		!claudeSession ||
		typeof claudeSession !== "object" ||
		Array.isArray(claudeSession)
	) {
		return claudeSession;
	}
	let merged = null;
	for (const name of ACCOUNT_QUOTA_WINDOWS) {
		const obs = observations.get(name);
		if (!obs) continue;
		if (merged == null) merged = { ...(claudeSession.rate_limits ?? {}) };
		merged[name] = {
			...(merged[name] ?? {}),
			used_percentage: obs.pct,
			...(obs.resetsAt != null ? { resets_at: obs.resetsAt } : {}),
		};
	}
	if (merged == null) return claudeSession;
	return { ...claudeSession, rate_limits: merged };
}

/** Test seam: drop all account-global quota state. */
export function resetAccountQuota() {
	observations.clear();
}
