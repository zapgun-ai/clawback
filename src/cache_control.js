const EXTENDED_TTL = { type: "ephemeral", ttl: "1h" };

/**
 * Walk `parsedBody` and ensure every Anthropic `cache_control` block ends up
 * at the 1h tier when `config.injectExtendedCacheTtl` is on.
 *
 * Two intervention paths:
 *
 *   - Nested rewrite: every `cache_control: {type:"ephemeral", ...}` inside
 *     `system[]`, `tools[]`, `messages[].content[]`, or top-level gets its
 *     `ttl` bumped to `"1h"`. This is the path Claude Code traffic hits,
 *     because the client routinely sets per-block cache_control with no
 *     explicit ttl (Anthropic defaults to 5m). Without the rewrite the
 *     headline knob was silently a no-op on real turns — pings landed at
 *     1h, real turns at 5m, and the two never shared a cache entry.
 *
 *   - Top-level injection (legacy): when the body has NO cache_control
 *     anywhere AND at least one of `system`/`tools` is present, add a
 *     top-level `cache_control: {ttl:"1h"}`. Anthropic auto-applies it to
 *     the last cacheable block. Pings and tool-less Haiku turns end up here.
 *
 * The rewrite path can be disabled in config (`rewriteNestedCacheControl:
 * false`) to revert to legacy top-level-only behaviour — operator escape
 * hatch if Anthropic ever regresses on accepting our rewritten payloads.
 * Default is on, since the legacy behaviour was a no-op for the dominant
 * user.
 *
 * Returns `{body, telemetry}`:
 *   - `body`: Buffer of the re-serialized payload to forward upstream, or
 *     null when nothing changed (caller forwards the original bytes).
 *   - `telemetry`: per-turn breakdown so `/_proxy/health` and the session
 *     store can answer "is the 1h knob actually firing on my real turns."
 *       { eligible, topLevelAdded, blocksRewritten, blocksStripped,
 *         alreadyExtended, nonEphemeralSkipped, thinkingPreserved, ttlMode }
 *
 *     `eligible` = injection was attempted on this turn (knob on, body had
 *     something cacheable). `ttlMode` = "1h" iff at least one cached block
 *     ended up at 1h after this function returned; "5m" otherwise.
 *
 * In-place mutation: `parsedBody` may be mutated. Matches the surrounding
 * pattern (stripEphemeral also mutates `parsedBody.system`) and lets
 * downstream fingerprint computation see exactly the bytes Anthropic will.
 */
export function injectIntoBody(parsedBody, config) {
	const telemetry = makeTelemetry();
	if (!parsedBody || typeof parsedBody !== "object") {
		return { body: null, telemetry };
	}
	if (Array.isArray(parsedBody)) return { body: null, telemetry };

	// First pass: count what the client sent us, whether or not we'll
	// mutate. This makes telemetry honest for the
	// `injectExtendedCacheTtl: false` arm — operators can still see "your
	// client manages cache_control directly" via the alreadyExtended count.
	const observed = surveyCacheControl(parsedBody);

	const hasCacheable = parsedBody.system != null || parsedBody.tools != null;
	if (!hasCacheable && observed.total === 0) {
		return { body: null, telemetry };
	}
	telemetry.eligible = true;
	telemetry.alreadyExtended = observed.alreadyExtended;
	telemetry.nonEphemeralSkipped = observed.nonEphemeral;
	if (observed.alreadyExtended > 0) telemetry.ttlMode = "1h";

	// Strip path (mirror of the 1h injection below): when
	// `stripExtendedCacheTtl` is on, downgrade every `ttl:"1h"` ephemeral
	// block back to Anthropic's documented 5m default by deleting the ttl
	// key. This is the tight-loop / anti-regression lever — Claude Code
	// natively breakpoints its system prompt at 1h (undocumented), and the
	// 1h write premium buys nothing when every read lands inside 5m. Strip
	// takes precedence over injection (we return before the inject path), so
	// flipping strip on while inject is still on yields 5m. Same guard as
	// injection: a signed thinking/redacted_thinking block must return
	// byte-identical, so we never touch its ttl.
	if (config?.stripExtendedCacheTtl) {
		visitCacheControlSites(parsedBody, (parent, key) => {
			const cc = parent[key];
			if (!cc || typeof cc !== "object") return;
			if (cc.type !== "ephemeral") return;
			if (cc.ttl !== "1h") return;
			if (parent.type === "thinking" || parent.type === "redacted_thinking") {
				telemetry.thinkingPreserved++;
				return;
			}
			const { ttl, ...next } = cc;
			void ttl;
			parent[key] = next;
			telemetry.blocksStripped++;
		});
		// ttlMode reflects what SURVIVES the strip: any 1h we couldn't touch
		// (a thinking block) keeps the turn at 1h; otherwise it is now 5m.
		const surviving = observed.alreadyExtended - telemetry.blocksStripped;
		telemetry.ttlMode = surviving > 0 ? "1h" : "5m";
		if (telemetry.blocksStripped > 0) {
			return {
				body: Buffer.from(JSON.stringify(parsedBody), "utf8"),
				telemetry,
			};
		}
		return { body: null, telemetry };
	}

	if (!config?.injectExtendedCacheTtl) {
		// Knob off: surface what we saw but don't mutate. ttlMode stays
		// "5m" unless the client themselves put 1h on a block.
		return { body: null, telemetry };
	}

	const rewriteEnabled = config.rewriteNestedCacheControl !== false;

	if (rewriteEnabled) {
		// Walk every site Anthropic accepts cache_control and bump
		// `{type:"ephemeral"}` (with no explicit ttl or ttl=5m) to ttl=1h.
		// Top-level is included so we don't leave a 5m top-level next to a
		// rewritten 1h nested block. alreadyExtended + nonEphemeralSkipped
		// were already accounted for by the survey pass above; this loop
		// only counts what IT changes (blocksRewritten).
		visitCacheControlSites(parsedBody, (parent, key) => {
			const cc = parent[key];
			if (!cc || typeof cc !== "object") return;
			if (cc.type !== "ephemeral") return;
			if (cc.ttl === "1h") return;
			// Never modify a `thinking`/`redacted_thinking` block. When extended
			// thinking + tool use is active, Anthropic requires every thinking
			// block in the latest assistant message to come back byte-for-byte
			// as it was signed; changing anything on it (even bumping its own
			// cache_control ttl) is rejected with `400 ... thinking ... blocks
			// cannot be modified`. Claude Code does breakpoint these blocks, so
			// leave the one block at its original ttl and forgo the 1h bump
			// there — the survey above still counted it, so we won't add a
			// conflicting top-level cache_control either.
			if (parent.type === "thinking" || parent.type === "redacted_thinking") {
				telemetry.thinkingPreserved++;
				return;
			}
			parent[key] = { ...cc, ttl: "1h" };
			telemetry.blocksRewritten++;
		});
	} else {
		// Legacy behaviour: if any nested cache_control exists, skip
		// top-level injection to avoid Anthropic's "target block already
		// has cache_control" 400. The knob does nothing for those turns.
		if (observed.total > 0) {
			return { body: null, telemetry };
		}
	}

	// Top-level injection: only when nothing else carries cache_control.
	// Otherwise Anthropic 400s with "the target block already has
	// cache_control" because the auto-applied top-level lands on a block
	// we just rewrote.
	const cacheControlPresent =
		observed.total > 0 || parsedBody.cache_control !== undefined;
	if (!cacheControlPresent && hasCacheable) {
		parsedBody.cache_control = { ...EXTENDED_TTL };
		telemetry.topLevelAdded = true;
	}

	if (telemetry.blocksRewritten > 0 || telemetry.topLevelAdded) {
		telemetry.ttlMode = "1h";
		return {
			body: Buffer.from(JSON.stringify(parsedBody), "utf8"),
			telemetry,
		};
	}
	return { body: null, telemetry };
}

export function resolvedTtlMode(config) {
	if (config.stripExtendedCacheTtl) return "5m";
	return config.injectExtendedCacheTtl ? "1h" : "5m";
}

/**
 * True if any block inside `system`, `tools`, `messages.content`, or the
 * top-level has its own `cache_control` field. Shallow check by design —
 * Anthropic's API does not nest cache_control beyond one level inside
 * content arrays.
 *
 * Retained for callers that want a yes/no check without the full telemetry
 * survey. Kept identical to the pre-rewrite semantics so existing tests +
 * external imports don't drift.
 */
export function hasNestedCacheControl(parsedBody) {
	if (!parsedBody || typeof parsedBody !== "object") return false;
	if (Array.isArray(parsedBody.system)) {
		for (const block of parsedBody.system) {
			if (
				block &&
				typeof block === "object" &&
				block.cache_control !== undefined
			) {
				return true;
			}
		}
	}
	if (Array.isArray(parsedBody.tools)) {
		for (const tool of parsedBody.tools) {
			if (
				tool &&
				typeof tool === "object" &&
				tool.cache_control !== undefined
			) {
				return true;
			}
		}
	}
	if (Array.isArray(parsedBody.messages)) {
		for (const msg of parsedBody.messages) {
			if (!msg || typeof msg !== "object") continue;
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (
					block &&
					typeof block === "object" &&
					block.cache_control !== undefined
				) {
					return true;
				}
			}
		}
	}
	return false;
}

function makeTelemetry() {
	return {
		eligible: false,
		topLevelAdded: false,
		blocksRewritten: 0,
		// Count of ttl:"1h" blocks downgraded to the 5m default by the strip
		// path (stripExtendedCacheTtl). Mirror of blocksRewritten.
		blocksStripped: 0,
		alreadyExtended: 0,
		nonEphemeralSkipped: 0,
		// Count of thinking/redacted_thinking blocks we declined to rewrite to
		// protect their signature (see the rewrite loop). Lets operators
		// confirm in the field that the 1h knob is firing AND staying off the
		// blocks Anthropic forbids us to touch.
		thinkingPreserved: 0,
		ttlMode: "5m",
	};
}

function visitCacheControlSites(body, fn) {
	if (Array.isArray(body.system)) {
		for (const block of body.system) {
			if (block && typeof block === "object" && "cache_control" in block) {
				fn(block, "cache_control");
			}
		}
	}
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (tool && typeof tool === "object" && "cache_control" in tool) {
				fn(tool, "cache_control");
			}
		}
	}
	if (Array.isArray(body.messages)) {
		for (const msg of body.messages) {
			if (!msg || typeof msg !== "object") continue;
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block && typeof block === "object" && "cache_control" in block) {
					fn(block, "cache_control");
				}
			}
		}
	}
	if ("cache_control" in body) {
		fn(body, "cache_control");
	}
}

function surveyCacheControl(body) {
	const out = { total: 0, alreadyExtended: 0, nonEphemeral: 0 };
	visitCacheControlSites(body, (parent, key) => {
		const cc = parent[key];
		out.total++;
		if (!cc || typeof cc !== "object" || cc.type !== "ephemeral") {
			out.nonEphemeral++;
			return;
		}
		if (cc.ttl === "1h") out.alreadyExtended++;
	});
	return out;
}
