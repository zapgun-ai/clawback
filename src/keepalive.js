import http from "node:http";
import https from "node:https";
import { processObservation } from "./auto_continue.js";
import { injectIntoBody, resolvedTtlMode } from "./cache_control.js";
import { writeInput } from "./claude_input.js";
import { appendEvent } from "./events_log.js";
import {
	formatDuration,
	parseRateLimit,
	tokensResetIso,
} from "./rate_limit.js";
import { CLAWBACK_VERSION } from "./version.js";

export class KeepAliveScheduler {
	constructor({
		config,
		store,
		logger,
		turnLog = null,
		now = () => Date.now(),
		random = Math.random,
		fetchImpl = null,
	}) {
		this.config = config;
		this.store = store;
		this.logger = logger;
		this.turnLog = turnLog;
		this._now = now;
		this._random = random;
		this._fetch = fetchImpl;
		this.timers = new Map();
		this._stopped = false;
		this._gcTimer = null;
	}

	start() {
		this._stopped = false;
		// Run the GC sweep before arming per-session timers so abandoned
		// sessions left over from a previous boot don't spend a cycle
		// pinging before being collected. The sweep runs unconditionally
		// (even with keep-alive disabled) because it's a state-hygiene
		// concern, not a ping concern — authStale sessions don't ping
		// either, but they still need GC.
		this._gcSweep();
		if (this.config.gcSweepIntervalMs > 0) {
			this._gcTimer = setInterval(() => {
				try {
					this._gcSweep();
				} catch (err) {
					this.logger.warn(`gc sweep crashed: ${err.stack ?? err.message}`);
				}
			}, this.config.gcSweepIntervalMs);
			this._gcTimer.unref?.();
		}
		if (this.config.keepAliveEnabled === false) return;
		for (const session of this.store.all()) {
			this.ensureScheduled(session.key);
		}
	}

	stop() {
		this._stopped = true;
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		if (this._gcTimer) {
			clearInterval(this._gcTimer);
			this._gcTimer = null;
		}
	}

	_gcSweep() {
		// Iterate over a snapshot of keys: store.delete mutates the
		// underlying map and a live iterator would be undefined behaviour.
		// Sessions are GC'd whether or not they have an armed per-session
		// timer — that's the whole point. authStale sessions in
		// particular have no timer, so the per-tick _shouldExpire check
		// never fires for them; this sweep is their only path out.
		for (const key of this.store.keys()) {
			const session = this.store.get(key);
			if (!session) continue;
			const reason = this._shouldExpire(session);
			if (!reason) continue;
			this.cancelSession(key);
			this.store.delete(key);
			const sLog = this._sessionLogger(key);
			sLog.info(
				`session ${shortKey(key)} abandoned (${reason}); purging via gc sweep`,
			);
		}
	}

	ensureScheduled(sessionKey) {
		if (this._stopped) return;
		if (this.config.keepAliveEnabled === false) return;
		if (this.timers.has(sessionKey)) return;
		if (!this.store.has(sessionKey)) return;
		// PLAN §22: skip auth-stale sessions. They sit dormant until a
		// real request lands and `captureSessionState` clears the flag
		// + re-arms the timer.
		const session = this.store.get(sessionKey);
		if (session?.authStale) return;
		// Option A++ (observe, don't guess): a session whose pings already
		// proved uncacheable (keepAliveColdPingMax consecutive fully-cold
		// pings — see _tick) stays dead. Latched so the per-boot re-arm sweep
		// and every later real turn skip it instead of restarting the phantom
		// loop. In hash mode the session key is sha256(canonical(system,tools)),
		// so a prefix that later grows is a *different* key and gets a fresh
		// evaluation; this flag only pins the exact prefix we measured.
		if (session?.keepAliveUncacheable) return;
		// Option A (keep-alive-side fragmentation): don't arm a loop for a
		// cacheable prefix too small for Anthropic to cache. Below its minimum
		// cacheable length a ping writes nothing — pure cost, zero reclaim — so
		// warming junk aux contexts (the 0B/1KB side-channel sessions seen on
		// the L3 paired run, alongside the real conversation) is wasted. floor=0
		// disables the gate; the default (config.js) is a byte count safely
		// under the smallest model minimum, so it only ever skips a
		// provably-uncacheable prefix. A session that later grows past the floor
		// re-arms naturally: ensureScheduled runs again on its next real turn.
		const floor = this.config.keepAliveMinPrefixBytes ?? 0;
		if (floor > 0 && cacheablePrefixBytes(session) < floor) return;
		this._scheduleNext(sessionKey);
	}

	cancelSession(sessionKey) {
		const t = this.timers.get(sessionKey);
		if (t) {
			clearTimeout(t);
			this.timers.delete(sessionKey);
		}
	}

	_nextDelayMs() {
		const min = this.config.keepAliveModeExtended
			? this.config.keepAliveMinMsExtended
			: this.config.keepAliveMinMs;
		const max = this.config.keepAliveModeExtended
			? this.config.keepAliveMaxMsExtended
			: this.config.keepAliveMaxMs;
		const span = Math.max(0, max - min);
		return Math.floor(min + this._random() * span);
	}

	_scheduleNext(sessionKey, minDelayMs = 0) {
		if (this._stopped) return;
		// Enforce ≤1 live timer per session at the single creation choke point.
		// _tick deletes the map entry before its async ping, so a real turn's
		// ensureScheduled can arm a timer mid-ping that _tick's tail then
		// re-arms over — orphaning the first off-book (the live-proxy hot loop).
		// Clearing here covers every caller: ensureScheduled, the tail re-arm,
		// and the crash-recovery path.
		const existing = this.timers.get(sessionKey);
		if (existing) clearTimeout(existing);
		const delay = this._nextDelayMs();
		const nextAt = new Date(this._now() + delay).toISOString();
		this.store.upsert(sessionKey, (prev) =>
			prev ? { ...prev, nextKeepAliveAt: nextAt } : prev,
		);

		const t = setTimeout(() => {
			this.timers.delete(sessionKey);
			this._tick(sessionKey).catch((err) => {
				this._sessionLogger(sessionKey).warn(
					`keep-alive tick crashed for ${shortKey(sessionKey)}: ${err.stack ?? err.message}`,
				);
				if (!this._stopped && this.store.has(sessionKey))
					this._scheduleNext(sessionKey);
			});
		}, delay);
		t.unref?.();
		this.timers.set(sessionKey, t);
	}

	_sessionLogger(sessionKey) {
		return typeof this.logger.forSession === "function"
			? this.logger.forSession(sessionKey)
			: this.logger;
	}

	async _tick(sessionKey) {
		const session = this.store.get(sessionKey);
		if (!session) return;

		const sLog = this._sessionLogger(sessionKey);
		const reason = this._shouldExpire(session);
		if (reason) {
			sLog.info(`session ${shortKey(sessionKey)} expired (${reason}); purging`);
			this.store.delete(sessionKey);
			return;
		}

		const tickStart = this._now();
		const sinceLastMs = session.lastKeepAliveAt
			? tickStart - new Date(session.lastKeepAliveAt).getTime()
			: null;

		const result = await this._sendKeepAlive(session);
		const pingEnd = this._now();

		this._writeTurnLogRecord({ session, result, tickStart, pingEnd });

		const usedAfter =
			(session.keepAliveTokensUsed ?? 0) +
			(result.ok ? (result.outputTokens ?? 1) : 0);

		const resetIso = result.tokensReset ?? session.targetTtl ?? null;
		const resetMs = resetIso ? new Date(resetIso).getTime() - tickStart : null;
		const rl = result.rateLimit ?? {};
		const remaining =
			rl.tokens_remaining ??
			rl.input_tokens_remaining ??
			rl.output_tokens_remaining ??
			session.lastRateLimit?.tokens_remaining ??
			null;
		const parts = [
			`keep-alive ${shortKey(sessionKey)} → ${result.status}`,
			`ping ${usedAfter}`,
		];
		if (sinceLastMs != null)
			parts.push(`elapsed=${formatDuration(sinceLastMs)}`);
		if (remaining != null) parts.push(`remaining=${remaining}`);
		if (resetMs != null) parts.push(`resets_in=${formatDuration(resetMs)}`);
		if (!result.ok) {
			const msg = extractErrorMessage(result.error);
			if (msg) parts.push(`err="${truncate(msg, 100)}"`);
			if (rl.retry_after_seconds != null)
				parts.push(
					`retry_after=${formatDuration(rl.retry_after_seconds * 1000)}`,
				);
		}
		(result.ok ? sLog.info : sLog.warn).call(sLog, parts.join(" "));

		this.store.upsert(sessionKey, (prev) => {
			if (!prev) return prev;
			const nextPrev = {
				...prev,
				lastKeepAliveAt: new Date(tickStart).toISOString(),
				lastKeepAliveStatus: result.status ?? "error",
			};
			if (result.ok) {
				nextPrev.keepAliveCount = (prev.keepAliveCount ?? 0) + 1;
				nextPrev.keepAliveTokensUsed =
					(prev.keepAliveTokensUsed ?? 0) + (result.outputTokens ?? 1);
				// Track consecutive fully-cold pings (no cache write, no read)
				// to detect a prefix Anthropic won't cache — the token-minimum
				// dead zone the byte floor can't see. A warm ping resets the
				// streak; absent usage leaves it unchanged (errs toward keeping
				// the loop). Mirrors the `cacheTouched` test in src/server.js.
				const cold = isFullyColdPing(result.usage);
				if (cold === true) {
					nextPrev.keepAliveColdStreak = (prev.keepAliveColdStreak ?? 0) + 1;
				} else if (cold === false) {
					nextPrev.keepAliveColdStreak = 0;
				}
			} else {
				nextPrev.keepAliveFailures = (prev.keepAliveFailures ?? 0) + 1;
				nextPrev.lastKeepAliveError = truncate(
					result.error ?? "unknown error",
					400,
				);
			}
			if (result.tokensReset) nextPrev.targetTtl = result.tokensReset;
			if (result.rateLimit && Object.keys(result.rateLimit).length)
				nextPrev.lastRateLimit = result.rateLimit;
			return nextPrev;
		});

		if (result.needsAuthRefresh) {
			// PLAN §22: pause this session until a real client request
			// rehydrates `session.authHeaders` with a fresh bearer.
			// Captured `system`/`tools`/fingerprints/counters are
			// preserved — losing them on bearer rotation was the
			// production failure this fix addresses.
			this.store.upsert(sessionKey, (prev) =>
				prev
					? {
							...prev,
							authStale: true,
							lastKeepAliveAt: new Date(this._now()).toISOString(),
							lastKeepAliveStatus: result.status ?? "error",
							lastKeepAliveError: truncate(
								result.error ?? "auth refresh required",
								400,
							),
						}
					: prev,
			);
			sLog.warn(
				`auth-stale for ${shortKey(sessionKey)} (HTTP ${result.status}); pausing keep-alive until next real request refreshes authHeaders`,
			);
			appendEvent({
				type: "auth-stale",
				text: `session paused (HTTP ${result.status}); waiting for next real request to refresh auth`,
				sessionKey,
			});
			this.cancelSession(sessionKey);
			return;
		}

		// Option A++ (observe, don't guess): once a session has logged
		// keepAliveColdPingMax consecutive fully-cold pings, Anthropic has
		// *proven* the prefix is below its token-cache minimum — every further
		// ping is pure cost, zero reclaim (the L4 phantom took 28 of them).
		// Latch it uncacheable and stop. A genuinely cacheable prefix writes
		// cache_creation>0 on ping 1, so its streak never reaches the floor;
		// this never cancels a real one. 0 disables the gate.
		const coldMax = this.config.keepAliveColdPingMax ?? 0;
		if (
			coldMax > 0 &&
			(this.store.get(sessionKey)?.keepAliveColdStreak ?? 0) >= coldMax
		) {
			this.store.upsert(sessionKey, (prev) =>
				prev ? { ...prev, keepAliveUncacheable: true } : prev,
			);
			sLog.info(
				`session ${shortKey(sessionKey)} keep-alive cancelled: ${coldMax} consecutive cold pings (cache_read=0 cache_creation=0) → prefix below cacheable minimum`,
			);
			appendEvent({
				type: "keepalive-uncacheable",
				text: `keep-alive cancelled after ${coldMax} cold pings (prefix below Anthropic's token-cache minimum)`,
				sessionKey,
			});
			this.cancelSession(sessionKey);
			return;
		}

		// Fire-and-forget: see equivalent comment in src/server.js's
		// onUpstreamHeaders. The ping path must not block on the
		// (possibly remote) writeInput call inside this helper.
		this._maybeFireAutoContinue(sessionKey, result).catch((e) => {
			this._sessionLogger(sessionKey).warn(
				`_maybeFireAutoContinue crashed: ${e.message}`,
			);
		});

		if (!this._stopped && this.store.has(sessionKey)) {
			this._scheduleNext(sessionKey);
		}
	}

	async _maybeFireAutoContinue(sessionKey, result) {
		if (!this.config?.autoContinue) return;
		const session = this.store.get(sessionKey);
		if (!session) return;
		const decision = processObservation({
			session,
			rateLimit: result.rateLimit ?? null,
			httpStatus: result.status ?? null,
			config: this.config,
			now: new Date(this._now()),
		});
		if (decision.updates) {
			this.store.upsert(sessionKey, (prev) =>
				prev ? { ...prev, ...decision.updates } : prev,
			);
		}
		if (decision.fireText) {
			const sLog = this._sessionLogger(sessionKey);
			const wrote = await writeInput(decision.fireText);
			if (wrote.written) {
				sLog.info(
					`auto-continue fired ${wrote.bytes} bytes into ${wrote.label} for ${shortKey(sessionKey)}`,
				);
			} else {
				sLog.warn(
					`auto-continue would have fired but writeInput refused: ${wrote.reason}`,
				);
			}
		}
	}

	_shouldExpire(session) {
		const ttl = session.targetTtl
			? new Date(session.targetTtl).getTime()
			: null;
		if (ttl && !Number.isNaN(ttl)) {
			const cutoff = ttl + this.config.gracePeriodMs;
			if (this._now() > cutoff) return "grace_period_expired";
		}

		// Inactivity expiry. Closes the hole left by the other two
		// reasons: budget needs ~5400 pings to fire, and grace_period
		// needs `targetTtl` set (which Anthropic does not always send).
		// Without this, abandoned sessions — especially `authStale`
		// ones whose per-session timer is cancelled — live forever.
		// `lastActivity` is the timestamp of the last real client
		// request; we fall back to `createdAt` so a session that never
		// saw a follow-up request can still be GC'd.
		const lastIso = session.lastActivity ?? session.createdAt ?? null;
		const lastMs = lastIso ? new Date(lastIso).getTime() : Number.NaN;
		if (!Number.isNaN(lastMs)) {
			const idleMs = this._now() - lastMs;

			// Dead-session fast-path. An authStale session already failed a
			// keep-alive with a 401 and had its per-session timer cancelled,
			// so it warms nothing — there is no cache left to protect by
			// holding it. We still wait deadSessionMaxIdleMs (default 6h ≈
			// Anthropic's ~5h session rate-limit reset + buffer) so a session
			// merely waiting out a limit can resume — a real request refreshes
			// auth and clears authStale. Past that, a broken session is almost
			// certainly abandoned, so reap it ahead of the general idle rule.
			const deadMax = this.config.deadSessionMaxIdleMs;
			if (session.authStale && deadMax > 0 && idleMs > deadMax) {
				return "auth_stale_idle";
			}

			const idleMax = this.config.sessionMaxIdleMs;
			if (idleMax > 0 && idleMs > idleMax) {
				return "idle_too_long";
			}
		}
		return null;
	}

	_writeTurnLogRecord({ session, result, tickStart, pingEnd }) {
		if (!this.turnLog?.enabled) return;
		const model = session.model ?? "claude-opus-4-5";
		const ttlMode = resolvedTtlMode(this.config);
		const usage = result.usage ?? null;
		this.turnLog.write({
			ts: new Date(tickStart).toISOString(),
			sessionKey: session.key,
			mode: "ping",
			model,
			ttlMode,
			arm: "treatment-ping",
			httpStatus: result.status ?? null,
			wallMs: pingEnd - tickStart,
			ttftMs: null,
			usage,
			clawbackVersion: CLAWBACK_VERSION,
			cadenceMode: this.config.keepAliveModeExtended ? "extended" : "default",
			toolsKey: session.toolsKey ?? null,
			systemStableKey: session.systemStableKey ?? null,
		});
	}

	async _sendKeepAlive(session) {
		const body = buildKeepAliveBody(session, this.config);
		const headers = buildHeaders(session, body);

		if (this._fetch) {
			return this._fetch({ session, body, headers, config: this.config });
		}

		const url = new URL("/v1/messages", this.config.upstream);
		const mod = url.protocol === "https:" ? https : http;
		const opts = {
			method: "POST",
			hostname: url.hostname,
			port: url.port || (url.protocol === "https:" ? 443 : 80),
			path: "/v1/messages",
			headers,
		};

		return new Promise((resolve) => {
			const req = mod.request(opts, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					const rl = parseRateLimit(res.headers);
					const tokensReset = tokensResetIso(res.headers);
					const status = res.statusCode ?? 0;
					const ok = status >= 200 && status < 300;
					let outputTokens = 1;
					let usage = null;
					if (ok) {
						try {
							const parsed = JSON.parse(raw);
							usage = parsed.usage ?? null;
							outputTokens = usage?.output_tokens ?? 1;
						} catch {
							/* keep default */
						}
					}

					resolve({
						ok,
						status,
						outputTokens,
						usage,
						rateLimit: rl,
						tokensReset,
						error: ok ? null : `HTTP ${status}: ${truncate(raw, 200)}`,
						// PLAN §22: 401/403 is no longer "fatal". The captured
						// `authorization` bearer probably rotated (Claude Code
						// uses OAuth) and a real client request will refresh it.
						// `_tick` reads this and pauses the session until the
						// next real request rehydrates `session.authHeaders`.
						needsAuthRefresh: status === 401 || status === 403,
					});
				});
			});

			req.setTimeout(this.config.keepAliveTimeoutMs, () => {
				req.destroy(
					new Error(
						`keep-alive timeout after ${this.config.keepAliveTimeoutMs}ms`,
					),
				);
			});

			req.on("error", (err) => {
				resolve({ ok: false, status: 0, error: err.message, fatal: false });
			});

			req.end(body);
		});
	}
}

export function buildKeepAliveBody(session, config) {
	// Anthropic's prompt cache is per-model — Haiku pings would create a
	// separate Haiku cache and let the real-model cache decay. Always
	// use the session's last-seen model so pings hit the same cache the
	// operator's real turns will read.
	void config;
	const model = session.model ?? "claude-opus-4-5";
	const payload = {
		model,
		messages: [{ role: "user", content: "keep-alive" }],
		max_tokens: 1,
		stream: false,
	};
	if (session.system != null) payload.system = session.system;
	if (session.tools != null) payload.tools = session.tools;
	if (session.betas != null) payload.betas = session.betas;
	const { body } = injectIntoBody(payload, config);
	return body ? body.toString("utf8") : JSON.stringify(payload);
}

export function buildHeaders(session, body) {
	const headers = {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		accept: "application/json",
	};
	if (session.authHeaders) {
		for (const [k, v] of Object.entries(session.authHeaders)) {
			headers[k] = v;
		}
	}
	return headers;
}

function truncate(s, n) {
	if (typeof s !== "string") return String(s).slice(0, n);
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function shortKey(k) {
	return k.length > 12 ? `${k.slice(0, 12)}…` : k;
}

// Bytes Anthropic would cache for this session: the UTF-8 size of `system` +
// `tools` (the prefix Claude Code marks cacheable). Anthropic refuses to cache
// a prefix below its minimum length (≥1024 tokens), so a sub-threshold prefix
// yields no cache entry and is not worth a keep-alive ping. Strings are
// measured directly; structured values via their JSON serialization (a faithful
// proxy for the forwarded bytes). Exported for the gate's regression tests.
export function cacheablePrefixBytes(session) {
	let n = 0;
	for (const part of [session?.system, session?.tools]) {
		if (part == null) continue;
		n +=
			typeof part === "string"
				? Buffer.byteLength(part, "utf8")
				: Buffer.byteLength(JSON.stringify(part), "utf8");
	}
	return n;
}

// A successful ping is "fully cold" when Anthropic neither wrote nor read a
// cache entry for it (both cache token counts absent or 0) — the signature of a
// prefix below the token-cache minimum (the byte floor can't see tokens). Mirror
// of src/server.js's `cacheTouched`. Returns:
//   true  — usage present and no cache was touched (count it toward the streak)
//   false — usage present and the cache was written or read (reset the streak)
//   null  — usage absent/unknown (leave the streak unchanged; errs toward
//           keeping the loop rather than cancelling on missing data)
// Exported for the gate's regression tests.
export function isFullyColdPing(usage) {
	if (usage == null) return null;
	const created = usage.cache_creation_input_tokens;
	const read = usage.cache_read_input_tokens;
	const warm =
		(typeof created === "number" && created > 0) ||
		(typeof read === "number" && read > 0);
	return !warm;
}

function extractErrorMessage(raw) {
	if (typeof raw !== "string") return String(raw ?? "");
	const msg = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
	// Anthropic nests the actionable type as the inner error: the envelope is
	// {"type":"error","error":{"type":"authentication_error",…}}. The `_error`
	// suffix skips the outer "type":"error" and grabs the inner one.
	const type = raw.match(/"type"\s*:\s*"([a-z_]+_error)"/)?.[1];
	if (msg && type) return `${type}: ${msg}`;
	return msg ?? raw;
}
