import crypto from "node:crypto";

/**
 * Mint a fresh clawback session id. 8 hex chars (32 bits of entropy) is
 * long enough to avoid collisions across a single proxy's lifetime — at
 * 64 concurrent sessions, expected first collision is ~2^15 = 32k
 * launches, well beyond any single-proxy session count we care about —
 * and short enough to fit comfortably in URL paths and log lines.
 *
 * PLAN §39 (Phase 1): the id is the canonical session identifier.
 * `bin/clawback.js` mints one per `clawback claude` invocation unless
 * the operator passed `--resume <xyz>`, in which case `<xyz>` becomes
 * the id (so a resumed claude shares its prior clawback metrics).
 */
export function mintClawbackId() {
	return crypto.randomBytes(4).toString("hex");
}

// Max length bumped 32 → 64 (2026-05-28) to leave headroom for the
// `<host>:<label>` origin-host prefix `clawback claude` now prepends
// (see composeSessionLabel + bin/clawback.js). Colon added to the
// allowed subsequent-char set as the host/label separator; it's not
// permitted as the first character so a bare `:foo` can't masquerade
// as a host-prefixed label. At-sign (`@`) is allowed (subsequent only)
// for the auto `<repo>:@<short-sha>` detached-HEAD label minted by
// computeDefaultSessionLabel (see src/session_label.js).
export const LABEL_MAX_LEN = 64;
const LABEL_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._\- :@]{0,63}$/;
const RESERVED_LABELS = new Set(["_default", "_aggregate"]);

/**
 * Validate an operator-supplied --label value. Returns the trimmed label
 * if valid, or throws with an operator-facing message. The constraints:
 *
 *   - 1-64 chars
 *   - first char must be alphanumeric, dot, underscore, or hyphen
 *   - subsequent chars may include space (so "branch foo" is legal) and
 *     colon (the origin-host separator, e.g. "alexmac:branch foo")
 *   - no leading/trailing whitespace
 *   - reserved sentinels (`_default`, `_aggregate`) are rejected — these
 *     are used as placeholder keys in routing and the metrics ring
 *
 * Labels are operator affordances, not load-bearing identifiers. The
 * clawback id is the canonical identifier; labels exist for UI display
 * and operator log readability.
 */
export function validateLabel(raw) {
	if (typeof raw !== "string") {
		throw new TypeError("label must be a string");
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error(`label must be 1-${LABEL_MAX_LEN} characters`);
	}
	if (trimmed.length > LABEL_MAX_LEN) {
		throw new Error(`label must be 1-${LABEL_MAX_LEN} characters`);
	}
	if (!LABEL_PATTERN.test(trimmed)) {
		throw new Error(
			"label may contain letters, digits, dot, underscore, hyphen, colon, at-sign, and (after the first character) space",
		);
	}
	if (RESERVED_LABELS.has(trimmed)) {
		throw new Error(`label "${trimmed}" is reserved`);
	}
	return trimmed;
}

/**
 * Reduce a raw machine hostname (e.g. `os.hostname()`) to a short,
 * label-safe origin tag for the `<host>:<label>` session-label prefix.
 *
 *   - Strips the domain: `Alexs-MacBook-Pro.local` → `Alexs-MacBook-Pro`.
 *   - Drops any char outside the label-safe set (no spaces or colons in
 *     the host segment, so the first colon in a composed label is
 *     unambiguously the host/label separator).
 *   - Trims leading/trailing punctuation and caps at 24 chars so the
 *     composed `host:label` stays well under LABEL_MAX_LEN.
 *
 * Returns null when nothing usable remains (caller then skips the
 * prefix and uses the bare label/id, preserving pre-2026-05-28
 * behavior).
 */
export function sanitizeHostSegment(raw) {
	if (typeof raw !== "string") return null;
	const firstSegment = raw.split(".")[0].trim();
	const cleaned = firstSegment
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._]+|[-._]+$/g, "");
	if (!cleaned) return null;
	return cleaned.slice(0, 24);
}

/**
 * Compose the session-record label as `<host>:<base>`, capped at
 * LABEL_MAX_LEN so the server-side validateLabel always accepts it.
 * `base` is the operator's --label, or the clawback id when no label
 * was given. Both args are expected non-empty (callers guard host via
 * sanitizeHostSegment and always have a clawback id for base).
 */
export function composeSessionLabel(host, base) {
	const composed = `${host}:${base}`;
	return composed.length > LABEL_MAX_LEN
		? composed.slice(0, LABEL_MAX_LEN)
		: composed;
}

/**
 * Pull clawback-specific flags out of the `clawback claude` args:
 *
 *   --label <name>          intercepted; not forwarded to claude.
 *   --remote <url>          intercepted; not forwarded to claude. When set,
 *                           `clawback claude` skips probe + local proxy
 *                           startup and points the spawned claude at the
 *                           remote clawback URL via ANTHROPIC_BASE_URL.
 *                           See bin/clawback.js for the launcher side.
 *   --resume <xyz>          observed (not consumed); used as the canonical
 *                           clawback id so a resumed session shares its
 *                           prior clawback metrics ring.
 *
 * Anything else passes through verbatim. Returns:
 *   { passthrough, clawbackId, clawbackLabel, clawbackIdSource, remoteUrl }
 *
 * `clawbackIdSource` is "resume" (from --resume) or "minted" (no --resume).
 * `remoteUrl` is null when `--remote` wasn't supplied.
 *
 * `mintFn` is injected for testing — production callers omit it and get
 * the real RNG via `mintClawbackId()`.
 */
export function extractClawbackArgs(rawArgs, { mintFn = mintClawbackId } = {}) {
	const passthrough = [];
	let clawbackLabel = null;
	let clawbackId = null;
	let clawbackIdSource = "minted";
	let remoteUrl = null;

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		// Once we hit the `--` separator, the rest is verbatim claude args
		// — don't peek inside them for our flags.
		if (arg === "--") {
			passthrough.push(...rawArgs.slice(i));
			break;
		}
		if (arg === "--label") {
			const value = rawArgs[i + 1];
			if (value == null || value.startsWith("--")) {
				throw new Error("--label requires a value");
			}
			clawbackLabel = validateLabel(value);
			i++; // consume the value
			continue;
		}
		if (arg.startsWith("--label=")) {
			clawbackLabel = validateLabel(arg.slice("--label=".length));
			continue;
		}
		if (arg === "--remote") {
			const value = rawArgs[i + 1];
			if (value == null || value.startsWith("-")) {
				throw new Error("--remote requires a URL");
			}
			remoteUrl = value;
			i++; // consume the value
			continue;
		}
		if (arg.startsWith("--remote=")) {
			remoteUrl = arg.slice("--remote=".length);
			if (remoteUrl === "") {
				throw new Error("--remote requires a URL");
			}
			continue;
		}
		if (arg === "--resume" || arg === "-r") {
			// Observe but DO forward — claude needs it.
			passthrough.push(arg);
			const value = rawArgs[i + 1];
			if (value != null && !value.startsWith("-")) {
				clawbackId = validateClawbackId(value);
				clawbackIdSource = "resume";
				passthrough.push(value);
				i++;
			}
			continue;
		}
		if (arg.startsWith("--resume=")) {
			passthrough.push(arg);
			clawbackId = validateClawbackId(arg.slice("--resume=".length));
			clawbackIdSource = "resume";
			continue;
		}
		passthrough.push(arg);
	}

	if (clawbackId == null) {
		clawbackId = mintFn();
	}
	return {
		passthrough,
		clawbackId,
		clawbackLabel,
		clawbackIdSource,
		remoteUrl,
	};
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Validate an operator-supplied clawback id (typically from `--resume
 * <xyz>` where `<xyz>` came from claude's own session-id generator,
 * which uses UUIDs). The pattern accepts UUIDs as well as our minted
 * 8-hex ids and most reasonable user-typed values. The path-routing
 * surface in `src/router.js:20` already rejects ids starting with `_`
 * and reserved tokens like `v1` and `_proxy`; we replicate the no-
 * leading-underscore rule here to fail fast at launch instead of
 * silently routing to hash-mode.
 */
export function validateClawbackId(raw) {
	if (typeof raw !== "string") {
		throw new TypeError("clawback id must be a string");
	}
	if (!ID_PATTERN.test(raw)) {
		throw new Error(
			"clawback id may be 1-64 chars of letters, digits, dot, underscore, hyphen; the first character may not be an underscore",
		);
	}
	if (raw === "v1" || raw === "_proxy") {
		throw new Error(`clawback id "${raw}" collides with a reserved path`);
	}
	return raw;
}
