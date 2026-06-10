/**
 * PLAN §24 trigger: detect "session was capped → now cleared" and decide
 * whether to fire `writeInput(autoContinueText)` into the operator's running
 * claude session.
 *
 * Pure-data design: this module returns `{updates, fireText}` rather than
 * calling the writer itself. The caller (server.js per-request,
 * keepalive.js per-ping) merges `updates` into the session via
 * `store.upsert` and, if `fireText` is non-null, hands the text to
 * `claude_input.writeInput`.
 *
 * State machine on the session record:
 *   - `capState: "normal"` (default; nothing pending)
 *   - `capState: "capped"`  (most recent observation showed cap pressure)
 *
 * Transitions are driven by `processObservation` per real-request response
 * or per keep-alive ping. The cooldown protects against a tight
 * fire→turn→429→fire loop if the model's continuation immediately gets
 * rate-limited again.
 */

const REMAINING_KEYS = [
	"tokens_remaining",
	"input_tokens_remaining",
	"output_tokens_remaining",
];

/**
 * True if this observation indicates the session is at/over the cap.
 * Two signals: HTTP 429 from upstream, or any rate-limit "remaining" counter
 * we can find that's at zero. Either is sufficient.
 */
export function isCapped({ rateLimit, httpStatus }) {
	if (httpStatus === 429) return true;
	if (!rateLimit || typeof rateLimit !== "object") return false;
	for (const k of REMAINING_KEYS) {
		const v = rateLimit[k];
		if (typeof v === "number" && v <= 0) return true;
	}
	return false;
}

/**
 * Process one observation against the session's prior state. Returns:
 *   - `updates`: null, or a partial session record to merge in.
 *   - `fireText`: null, or the string to deliver into the running claude.
 *
 * No side effects.
 */
export function processObservation({
	session,
	rateLimit,
	httpStatus,
	config,
	now = new Date(),
}) {
	if (!config?.autoContinue) return EMPTY;
	if (!session) return EMPTY;

	const capped = isCapped({ rateLimit, httpStatus });
	const prev = session.capState ?? "normal";
	const nowIso = now.toISOString();
	const nowMs = now.getTime();

	if (capped) {
		if (prev === "capped") return EMPTY;
		return {
			updates: { capState: "capped", cappedAt: nowIso },
			fireText: null,
		};
	}

	// Not capped right now.
	if (prev !== "capped") return EMPTY;

	// Transition: was capped, now isn't. Decide whether to fire.
	const cooldownMs = config.autoContinueCooldownMs ?? 0;
	const lastFiredMs = session.lastAutoContinueFiredAt
		? new Date(session.lastAutoContinueFiredAt).getTime()
		: 0;
	const cooldownOk = nowMs - lastFiredMs >= cooldownMs;

	if (!cooldownOk) {
		return {
			updates: { capState: "normal", capClearedAt: nowIso },
			fireText: null,
		};
	}

	const text = config.autoContinueText ?? "continue\n";
	return {
		updates: {
			capState: "normal",
			capClearedAt: nowIso,
			lastAutoContinueFiredAt: nowIso,
			autoContinueFires: (session.autoContinueFires ?? 0) + 1,
		},
		fireText: text,
	};
}

const EMPTY = Object.freeze({ updates: null, fireText: null });
