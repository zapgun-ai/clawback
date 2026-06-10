import crypto from "node:crypto";
import { canonicalize } from "./canonicalize.js";
import { appendEvent } from "./events_log.js";
import { stripEphemeral } from "./fingerprint.js";

/**
 * PLAN §9 load-time migration.
 *
 * Re-runs `stripEphemeral` over every session in the store and recomputes
 * the hash-mode SESSION KEY. Sessions whose stored `system` had ephemeral
 * content that the *current* STRIP_PATTERNS would catch get re-keyed; if
 * the new key matches another session (i.e., they were fragments of the
 * same logical session), the fragments are merged — counters summed, the
 * record with the most recent `lastActivity` kept as the base.
 *
 * Idempotent. No-op when `config.stripEphemeralFromSystem` is false (the
 * operator's escape hatch). Path-mode sessions are unaffected because
 * their key is the URL agentId, not a hash of `system`.
 *
 * Returns a small report so `start()` can log how much was collapsed.
 */
export function migrateStoredSessions({ store, config, logger }) {
	if (!config.stripEphemeralFromSystem) {
		return { in: store.all().length, out: store.all().length, merged: 0 };
	}

	const sessions = store.all();
	const byNewKey = new Map();
	let mergedCount = 0;
	let rekeyedCount = 0;

	for (const sess of sessions) {
		if (sess.mode !== "hash") {
			// Path-mode key is independent of system bytes; nothing to do.
			byNewKey.set(sess.key, sess);
			continue;
		}

		const { stripped } = stripEphemeral(sess.system);
		const hashInput = canonicalize({
			system: stripped,
			tools: sess.tools ?? null,
		});
		const newKey = crypto.createHash("sha256").update(hashInput).digest("hex");

		if (newKey === sess.key) {
			// Already canonical under the current STRIP_PATTERNS.
			byNewKey.set(newKey, sess);
			continue;
		}

		rekeyedCount++;
		const migrated = { ...sess, key: newKey, system: stripped };
		const existing = byNewKey.get(newKey);
		if (!existing) {
			byNewKey.set(newKey, migrated);
		} else {
			byNewKey.set(newKey, mergeSessions(existing, migrated));
			mergedCount++;
		}
	}

	if (rekeyedCount === 0 && mergedCount === 0) {
		return { in: sessions.length, out: sessions.length, merged: 0 };
	}

	store.purgeAll();
	for (const sess of byNewKey.values()) {
		store.upsert(sess.key, () => sess);
	}

	if (logger?.info && (rekeyedCount > 0 || mergedCount > 0)) {
		logger.info(
			`PLAN §9 migration: ${sessions.length} sessions in, ${byNewKey.size} after re-strip ` +
				`(${rekeyedCount} re-keyed, ${mergedCount} merged with siblings)`,
		);
		appendEvent({
			type: "fragmentation-collapse",
			text: `boot migration collapsed ${sessions.length} sessions → ${byNewKey.size} (${mergedCount} fragments merged)`,
		});
	}

	return { in: sessions.length, out: byNewKey.size, merged: mergedCount };
}

function mergeSessions(a, b) {
	const aTime = a.lastActivity ?? "";
	const bTime = b.lastActivity ?? "";
	const [keep, drop] = aTime >= bTime ? [a, b] : [b, a];
	return {
		...keep,
		keepAliveCount: (keep.keepAliveCount ?? 0) + (drop.keepAliveCount ?? 0),
		keepAliveTokensUsed:
			(keep.keepAliveTokensUsed ?? 0) + (drop.keepAliveTokensUsed ?? 0),
		keepAliveFailures:
			(keep.keepAliveFailures ?? 0) + (drop.keepAliveFailures ?? 0),
		cacheCreationTokens:
			(keep.cacheCreationTokens ?? 0) + (drop.cacheCreationTokens ?? 0),
		cacheReadTokens: (keep.cacheReadTokens ?? 0) + (drop.cacheReadTokens ?? 0),
		cacheMissTokens: (keep.cacheMissTokens ?? 0) + (drop.cacheMissTokens ?? 0),
	};
}
