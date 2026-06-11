import crypto from "node:crypto";
import {
	overlayAccountQuota,
	recordQuotaObservation,
} from "./account_quota.js";
import {
	activeInputLabel,
	activeRemoteRegistration,
	clearRemoteInput,
	hasActiveInput,
	registerRemoteInput,
	writeInput,
} from "./claude_input.js";
import { validateLabel } from "./clawback_id.js";
import { appendEvent, listEvents } from "./events_log.js";
import {
	MAX_SAMPLES_PER_SESSION,
	appendSample,
	clearSamples,
	listSamples,
	listSessionSummaries,
} from "./metrics_log.js";
import {
	formatDuration,
	parseRateLimit,
	tokensResetIso,
} from "./rate_limit.js";
import { buildContext, evaluate } from "./suggestions.js";
import { CLAWBACK_VERSION } from "./version.js";

export async function handleAdmin(
	req,
	res,
	{ store, scheduler, config, logger, uiServer, reportServer },
) {
	const url = new URL(req.url, "http://localhost");
	const parts = url.pathname.split("/").filter(Boolean);

	const respond = (status, body) => {
		if (res.headersSent) return;
		// Surface admin-surface traffic in the access log — on an open-network
		// bind these endpoints are reachable but were otherwise invisible,
		// including rejected auth. Auth rejections (401/403) and 5xx warn;
		// mutations log at info; reads and the high-frequency statusline
		// metrics write stay at debug so they don't drown the log.
		const isWrite = req.method !== "GET" && req.method !== "HEAD";
		const lvl =
			status === 401 || status === 403 || status >= 500
				? "warn"
				: parts[1] === "statusline"
					? "debug"
					: isWrite
						? "info"
						: "debug";
		logger?.[lvl]?.(`admin ${req.method} ${url.pathname} → ${status}`);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
		});
		res.end(JSON.stringify(body, null, 2));
	};

	const prefix = config?.adminPathPrefix ?? "_proxy";
	if (parts[0] !== prefix) return respond(404, { error: "not_found" });

	// Always-on CSRF + DNS-rebinding hardening. Runs on every admin call
	// regardless of `adminToken` — a malicious page in the operator's
	// browser can still fire same-origin POSTs without auth, and DNS
	// rebinding can reach a loopback-bound proxy from any webpage. See
	// assertOriginSafe for the specific checks (Host vs accepting
	// interface, Origin match, Content-Type on writes).
	//
	// Exemption: the statusline POST is called from the operator's claude
	// statusLine command (already-installed `curl` line in
	// ~/.claude/settings.json). Tightening it would break every
	// pre-existing operator's statusline until they re-ran
	// `clawback setup claude --force`. The endpoint only writes to the
	// metrics ring — no state mutation, no PTY access.
	//
	// Exemption: the /report saved-run viewer is read-only and deliberately
	// fully public (no token) so a saved run can be opened and linked from a
	// browser. Origin/Host hardening would break cross-origin embedding and
	// direct navigation, and there's nothing to protect — it serves only the
	// analyzer's already-priced benchmark outputs (no secrets, no mutation).
	// Only the read (non-write) methods are exempt; a write to /report still
	// hits the gate (and the report server only answers GETs anyway).
	const reportRead = parts[1] === "report" && !isWriteMethod(req.method);
	if (!(parts[1] === "statusline" || reportRead)) {
		const csrfReject = assertOriginSafe(req, config);
		if (csrfReject) return respond(csrfReject.status, csrfReject.body);
	}

	// Admin bearer-token check. Only enforced when `config.adminToken` is set;
	// otherwise behaviour is unchanged (back-compat with the historical
	// loopback-only deployment). Enforced on mutating methods only — GETs
	// stay open so the UI page and `curl` reads keep working unchanged.
	// Loopback is exempt so a same-host operator can click the UI control
	// buttons without typing a token anywhere.
	if (config?.adminToken && isWriteMethod(req.method) && !isLoopback(req)) {
		const provided = parseBearer(req.headers.authorization);
		if (!provided || !tokenMatches(provided, config.adminToken)) {
			return respond(401, {
				error: "unauthorized",
				message:
					"this endpoint requires Authorization: Bearer <token> (admin token is set on this proxy)",
			});
		}
	}

	if (parts[1] === "ui" && uiServer) {
		logger?.debug?.(`admin ${req.method} ${url.pathname} → ui`);
		const subPath = parts.slice(2).join("/");
		return uiServer.handle(req, res, subPath);
	}

	if (parts[1] === "report" && reportServer) {
		logger?.debug?.(`admin ${req.method} ${url.pathname} → report`);
		return reportServer.handle(req, res, parts.slice(2), { config });
	}

	if (parts[1] === "events" && req.method === "GET") {
		const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
		return respond(200, {
			events: listEvents({ limit: Number.isNaN(limit) ? 200 : limit }),
		});
	}

	if (parts[1] === "statusline") {
		// PLAN §29: plain-text endpoint for Claude Code's statusLine command.
		// GET returns clawback state only (simple `curl` integration). POST
		// accepts the JSON session data Claude Code passes on stdin and
		// merges claude-reported fields (model, context %, cost) into the line.
		//
		// PLAN §39 (Phase 1): per-session routing. The optional path suffix
		// /_proxy/statusline/<id> identifies which clawback session this
		// render is for; the rendered text uses that session's hit/tps/ttft
		// and the per-session metrics ring receives the sample. The legacy
		// /_proxy/statusline (no id, or id == "_default") falls back to the
		// mostRecentSession-style aggregate render.
		if (req.method !== "GET" && req.method !== "POST") {
			return respond(405, {
				error: "method_not_allowed",
				allow: ["GET", "POST"],
			});
		}
		const requestedSessionId =
			parts[2] && parts[2] !== "_default" ? parts[2] : null;
		const clawbackSession =
			requestedSessionId != null ? store.get(requestedSessionId) : null;
		const sessionLabel =
			clawbackSession?.label ??
			(requestedSessionId != null ? requestedSessionId : null);

		let claudeSession = null;
		if (req.method === "POST") {
			try {
				const body = await readJsonBody(req, 64 * 1024);
				claudeSession = body && typeof body === "object" ? body : null;
			} catch {
				// Malformed body: don't break the operator's statusline. Fall
				// through to clawback-only render.
				claudeSession = null;
			}
		}
		// Plan-quota windows (five_hour/seven_day) are account-global, not
		// per-session (PLAN §12.2): record this POST's quota into the shared
		// store, then render EVERY session from that freshest value so an idle
		// session no longer shows a stale, too-low quota. `accountGlobalQuota`
		// off restores strict per-session rendering (the multi-account escape
		// hatch — see §23). Recording is POST-only (a GET carries no payload);
		// the overlay is a no-op until something has been recorded, so the
		// pure-render tests that bypass this handler are unaffected.
		const accountGlobal = config.accountGlobalQuota !== false;
		if (accountGlobal && req.method === "POST") {
			recordQuotaObservation(claudeSession?.rate_limits);
		}
		const effectiveSession = accountGlobal
			? overlayAccountQuota(claudeSession)
			: claudeSession;
		const text = renderStatusline({
			config,
			store,
			claudeSession: effectiveSession,
			clawbackSession,
			sessionLabel,
			requestedSessionId,
			// The statusline is rendered by Claude Code's ANSI-capable TUI,
			// not by this server's stdout. The server runs headless (a
			// background daemon), so resolving color off its own
			// process.stdout.isTTY would wrongly strip color from a sink
			// that supports it (operator-flagged 2026-05-28). Resolve as
			// isatty:true; explicit statuslineColor "off" and NO_COLOR
			// (operator kill-switch) still win inside resolveStatuslineColor.
			colorEnabled: resolveStatuslineColor({ config, isatty: true }),
		});
		// PLAN §33: also feed the metrics ring so the web UI can plot
		// the values that just got rendered. Only do this on POST —
		// plain GETs have no claude attached and the chart would just
		// see noise from whatever clawback session happens to be
		// freshest.
		if (req.method === "POST") {
			try {
				// Mirror renderStatusline's scoping: a scoped request whose
				// session isn't in the store yet must not borrow a sibling's
				// tps/ttft into the chart sample (it's keyed by this session's
				// id below). Only the legacy no-id path uses mostRecentSession.
				const recentSession =
					clawbackSession ??
					(requestedSessionId != null ? null : mostRecentSession(store));
				const claudeAttached =
					effectiveSession != null &&
					typeof effectiveSession === "object" &&
					!Array.isArray(effectiveSession);
				const claudeIsFresh =
					claudeAttached &&
					effectiveSession.context_window?.current_usage == null;
				const sample = extractMetricsSample({
					claudeSession: effectiveSession,
					recentSession,
					claudeIsFresh,
					claudeAttached,
				});
				appendSample({
					source: "statusline",
					sessionKey: requestedSessionId ?? undefined,
					label: sessionLabel,
					...sample,
					mode: sampleModeSnapshot(config),
				});
			} catch (e) {
				logger?.warn?.(`statusline metrics append failed: ${e.message}`);
			}
		}
		if (res.headersSent) return;
		res.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-cache",
		});
		res.end(text);
		return;
	}

	if (parts[1] === "claude" && parts[2] === "input") {
		if (req.method === "GET") {
			return respond(200, {
				active: hasActiveInput(),
				label: activeInputLabel(),
				remote: activeRemoteRegistration(),
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (!body || typeof body.text !== "string") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {text: string}",
				});
			}
			const result = await writeInput(body.text);
			if (result.written) return respond(200, result);
			return respond(503, result);
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	// Reverse channel for cross-process attach. A `clawback claude` launcher
	// that attached to this proxy POSTs here with its loopback callback
	// URL + token; writeInput() then routes input back to that launcher's
	// PTY. DELETE clears the registration (called on launcher exit).
	if (parts[1] === "claude" && parts[2] === "register") {
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (!body || typeof body.url !== "string") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {url: string, token?: string, label?: string}",
				});
			}
			try {
				registerRemoteInput({
					url: body.url,
					token: typeof body.token === "string" ? body.token : null,
					label: typeof body.label === "string" ? body.label : undefined,
				});
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			logger?.info?.(
				`claude PTY remote input registered (${body.url}, label=${body.label ?? "claude-remote"})`,
			);
			return respond(200, {
				registered: true,
				remote: activeRemoteRegistration(),
			});
		}
		if (req.method === "DELETE") {
			clearRemoteInput();
			logger?.info?.("claude PTY remote input cleared");
			return respond(200, { cleared: true });
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["POST", "DELETE"],
		});
	}

	if (parts[1] === "passthrough") {
		if (req.method === "GET") {
			return respond(200, passthroughStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			const enabled = resolvePassthroughToggle(body, config);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyPassthrough(enabled, { config, scheduler, logger });
			return respond(200, passthroughStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "keep-alive") {
		if (req.method === "GET") {
			return respond(200, {
				keepAliveEnabled: Boolean(config.keepAliveEnabled),
				passthrough: Boolean(config.passthrough),
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			// PLAN §33: while passthrough is on, this knob is force-pinned
			// off (loadConfig's post-merge override). Re-enabling keep-alive
			// mid-baseline would corrupt the experiment — refuse with 409
			// rather than silently letting it through.
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling keep-alive",
				});
			}
			const enabled = resolveFlagToggle(body, config.keepAliveEnabled);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyKeepAlive(enabled, { config, scheduler, logger });
			return respond(200, {
				keepAliveEnabled: Boolean(config.keepAliveEnabled),
				passthrough: Boolean(config.passthrough),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "strip-ephemeral") {
		if (req.method === "GET") {
			return respond(200, {
				stripEphemeralFromSystem: Boolean(config.stripEphemeralFromSystem),
				passthrough: Boolean(config.passthrough),
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling strip-ephemeral",
				});
			}
			const enabled = resolveFlagToggle(body, config.stripEphemeralFromSystem);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyStripEphemeral(enabled, { config, logger });
			return respond(200, {
				stripEphemeralFromSystem: Boolean(config.stripEphemeralFromSystem),
				passthrough: Boolean(config.passthrough),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "extend-cache-ttl") {
		if (req.method === "GET") {
			return respond(200, extendCacheTtlStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling extend-cache-ttl",
				});
			}
			const enabled = resolveFlagToggle(body, config.injectExtendedCacheTtl);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyExtendCacheTtl(enabled, { config, logger });
			return respond(200, extendCacheTtlStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "strip-extended-cache-ttl") {
		if (req.method === "GET") {
			return respond(200, stripExtendCacheTtlStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling strip-extended-cache-ttl",
				});
			}
			const enabled = resolveFlagToggle(body, config.stripExtendedCacheTtl);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyStripExtendCacheTtl(enabled, { config, logger });
			return respond(200, stripExtendCacheTtlStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "mobile") {
		if (req.method === "GET") {
			return respond(200, mobileStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			const enabled = resolveFlagToggle(body, config.mobile);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyMobile(enabled, { config, logger });
			return respond(200, mobileStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "keep-alive-extended") {
		if (req.method === "GET") {
			return respond(200, keepAliveExtendedStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling keep-alive-extended",
				});
			}
			const enabled = resolveFlagToggle(body, config.keepAliveModeExtended);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyKeepAliveExtended(enabled, { config, logger });
			return respond(200, keepAliveExtendedStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "auto-continue") {
		if (req.method === "GET") {
			return respond(200, autoContinueStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			// While passthrough is on, this knob is force-pinned off so
			// the baseline arm is honest. A mid-window flip would itself
			// be a toggle event in the measurement; refuse with 409 and
			// let the operator exit passthrough first. Mirrors the
			// guard on keep-alive / strip-ephemeral / extend-cache-ttl.
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling auto-continue",
				});
			}
			const enabled = resolveFlagToggle(body, config.autoContinue);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyAutoContinue(enabled, { config, logger });
			return respond(200, autoContinueStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "stack") {
		// Composite apply target for the suggestion engine's long-session
		// stack rules (stack-cold-suggest-all, stack-partial-completion).
		// Flips keep-alive + 1h TTL + extended cadence together so one
		// click takes the operator from cold to the full §3.4/§5.1/§5.2
		// stack. Not exposed as a UI toggle — there's no 8th knob — but
		// the apply endpoint exists so the suggestion cards' button works.
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before applying the stack",
				});
			}
			const action =
				typeof body?.action === "string" ? body.action.toLowerCase() : null;
			const enabled =
				typeof body?.enabled === "boolean"
					? body.enabled
					: action === "on" || action === "enable"
						? true
						: action === "off" || action === "disable"
							? false
							: null;
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'on'|'off'|'enable'|'disable'}",
				});
			}
			applyKeepAlive(enabled, { config, scheduler, logger });
			applyExtendCacheTtl(enabled, { config, logger });
			applyKeepAliveExtended(enabled, { config, logger });
			return respond(200, {
				keepAliveEnabled: Boolean(config.keepAliveEnabled),
				injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
				keepAliveModeExtended: Boolean(config.keepAliveModeExtended),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["POST"],
		});
	}

	if (parts[1] === "tight-loop") {
		// Composite apply target for the strip-1h-tight-loop suggestion.
		// "on" forces the documented 5m TTL (strips the native 1h headers
		// Claude Code writes) AND drops keep-alive back to the fast 1-4 min
		// cadence that matches a 5m cache — the two halves of the tight-loop
		// fix. Unlike `stack` it applies fixed polarities, not one uniform
		// boolean: strip ON but extended-cadence OFF. "off" only lifts the
		// strip; it leaves the cadence where the operator left it (symmetric
		// with strip-extended-cache-ttl, which doesn't presume to restore 1h
		// inject on disable). Not a UI knob — the apply endpoint exists so
		// the suggestion card's one-click button works.
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before applying the tight-loop fix",
				});
			}
			const action =
				typeof body?.action === "string" ? body.action.toLowerCase() : null;
			const enabled =
				typeof body?.enabled === "boolean"
					? body.enabled
					: action === "on" || action === "enable"
						? true
						: action === "off" || action === "disable"
							? false
							: null;
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'on'|'off'|'enable'|'disable'}",
				});
			}
			applyStripExtendCacheTtl(enabled, { config, logger });
			if (enabled) applyKeepAliveExtended(false, { config, logger });
			return respond(200, {
				stripExtendedCacheTtl: Boolean(config.stripExtendedCacheTtl),
				injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
				keepAliveModeExtended: Boolean(config.keepAliveModeExtended),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["POST"],
		});
	}

	if (parts[1] === "capture-baseline") {
		if (req.method === "GET") {
			return respond(200, captureBaselineStatus(config));
		}
		if (req.method === "POST") {
			let body = {};
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			// Optional per-capture overrides. `shadow` opts into the ~2x-cost
			// turn-matched capture that keeps the armed knobs live; `turns`
			// overrides the window length for this run only.
			const shadow =
				typeof body?.shadow === "boolean" ? body.shadow : undefined;
			const turns =
				Number.isFinite(body?.turns) && body.turns > 0
					? Math.floor(body.turns)
					: undefined;
			startBaselineCapture(config, {
				store,
				scheduler,
				logger,
				shadow,
				turns,
			});
			return respond(200, captureBaselineStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "suggestions" && req.method === "GET") {
		const context = buildContext({
			config,
			store,
			samples: listSamples({ limit: MAX_SAMPLES_PER_SESSION }),
			turnLogFile: config?.turnLogFile ?? null,
		});
		const suggestions = evaluate(context);
		return respond(200, { suggestions });
	}

	if (parts[1] === "metrics") {
		if (req.method === "GET") {
			const sinceParam = url.searchParams.get("since");
			const limitParam = url.searchParams.get("limit");
			// PLAN §39 (Phase 1): optional ?session=<id> filter restricts
			// the returned samples to a single session's ring. Omitted
			// query → merged samples across all rings (chronological).
			const sessionParam = url.searchParams.get("session");
			const limit =
				limitParam != null && Number.isFinite(Number(limitParam))
					? Math.max(0, Math.floor(Number(limitParam)))
					: MAX_SAMPLES_PER_SESSION;
			const samples = listSamples({
				session: sessionParam || null,
				since: sinceParam || null,
				limit,
			});
			return respond(200, {
				samples,
				capacity: MAX_SAMPLES_PER_SESSION,
				returned: samples.length,
				session: sessionParam || null,
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			const action =
				typeof body?.action === "string" ? body.action.toLowerCase() : null;
			if (action !== "clear") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {action: 'clear'}",
				});
			}
			// PLAN §39 (Phase 1): optional {session: "<id>"} in the body
			// clears just that ring; omitted clears every ring (legacy
			// behaviour, the UI's "clear history" button).
			const sessionArg =
				typeof body?.session === "string" && body.session.length > 0
					? body.session
					: null;
			const cleared = clearSamples({ session: sessionArg });
			appendEvent({
				type: "metrics-cleared",
				text: sessionArg
					? `metrics ring cleared for session=${sessionArg} (${cleared} samples)`
					: `metrics ring cleared (${cleared} samples)`,
			});
			return respond(200, {
				cleared: true,
				count: cleared,
				session: sessionArg,
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "ui" && uiServer) {
		const subPath = parts.slice(2).join("/");
		return uiServer.handle(req, res, subPath);
	}

	if (parts[1] === "report" && reportServer) {
		logger?.debug?.(`admin ${req.method} ${url.pathname} → report`);
		return reportServer.handle(req, res, parts.slice(2), { config });
	}

	if (parts[1] === "events" && req.method === "GET") {
		const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
		return respond(200, {
			events: listEvents({ limit: Number.isNaN(limit) ? 200 : limit }),
		});
	}

	if (parts[1] === "statusline") {
		// PLAN §29: plain-text endpoint for Claude Code's statusLine command.
		// GET returns clawback state only (simple `curl` integration). POST
		// accepts the JSON session data Claude Code passes on stdin and
		// merges claude-reported fields (model, context %, cost) into the line.
		//
		// PLAN §39 (Phase 1): per-session routing. The optional path suffix
		// /_proxy/statusline/<id> identifies which clawback session this
		// render is for; the rendered text uses that session's hit/tps/ttft
		// and the per-session metrics ring receives the sample. The legacy
		// /_proxy/statusline (no id, or id == "_default") falls back to the
		// mostRecentSession-style aggregate render.
		if (req.method !== "GET" && req.method !== "POST") {
			return respond(405, {
				error: "method_not_allowed",
				allow: ["GET", "POST"],
			});
		}
		const requestedSessionId =
			parts[2] && parts[2] !== "_default" ? parts[2] : null;
		const clawbackSession =
			requestedSessionId != null ? store.get(requestedSessionId) : null;
		const sessionLabel =
			clawbackSession?.label ??
			(requestedSessionId != null ? requestedSessionId : null);

		let claudeSession = null;
		if (req.method === "POST") {
			try {
				const body = await readJsonBody(req, 64 * 1024);
				claudeSession = body && typeof body === "object" ? body : null;
			} catch {
				// Malformed body: don't break the operator's statusline. Fall
				// through to clawback-only render.
				claudeSession = null;
			}
		}
		// Plan-quota windows (five_hour/seven_day) are account-global, not
		// per-session (PLAN §12.2): record this POST's quota into the shared
		// store, then render EVERY session from that freshest value so an idle
		// session no longer shows a stale, too-low quota. `accountGlobalQuota`
		// off restores strict per-session rendering (the multi-account escape
		// hatch — see §23). Recording is POST-only (a GET carries no payload);
		// the overlay is a no-op until something has been recorded, so the
		// pure-render tests that bypass this handler are unaffected.
		const accountGlobal = config.accountGlobalQuota !== false;
		if (accountGlobal && req.method === "POST") {
			recordQuotaObservation(claudeSession?.rate_limits);
		}
		const effectiveSession = accountGlobal
			? overlayAccountQuota(claudeSession)
			: claudeSession;
		const text = renderStatusline({
			config,
			store,
			claudeSession: effectiveSession,
			clawbackSession,
			sessionLabel,
			requestedSessionId,
			// The statusline is rendered by Claude Code's ANSI-capable TUI,
			// not by this server's stdout. The server runs headless (a
			// background daemon), so resolving color off its own
			// process.stdout.isTTY would wrongly strip color from a sink
			// that supports it (operator-flagged 2026-05-28). Resolve as
			// isatty:true; explicit statuslineColor "off" and NO_COLOR
			// (operator kill-switch) still win inside resolveStatuslineColor.
			colorEnabled: resolveStatuslineColor({ config, isatty: true }),
		});
		// PLAN §33: also feed the metrics ring so the web UI can plot
		// the values that just got rendered. Only do this on POST —
		// plain GETs have no claude attached and the chart would just
		// see noise from whatever clawback session happens to be
		// freshest.
		if (req.method === "POST") {
			try {
				// Mirror renderStatusline's scoping: a scoped request whose
				// session isn't in the store yet must not borrow a sibling's
				// tps/ttft into the chart sample (it's keyed by this session's
				// id below). Only the legacy no-id path uses mostRecentSession.
				const recentSession =
					clawbackSession ??
					(requestedSessionId != null ? null : mostRecentSession(store));
				const claudeAttached =
					effectiveSession != null &&
					typeof effectiveSession === "object" &&
					!Array.isArray(effectiveSession);
				const claudeIsFresh =
					claudeAttached &&
					effectiveSession.context_window?.current_usage == null;
				const sample = extractMetricsSample({
					claudeSession: effectiveSession,
					recentSession,
					claudeIsFresh,
					claudeAttached,
				});
				appendSample({
					source: "statusline",
					sessionKey: requestedSessionId ?? undefined,
					label: sessionLabel,
					...sample,
					mode: sampleModeSnapshot(config),
				});
			} catch (e) {
				logger?.warn?.(`statusline metrics append failed: ${e.message}`);
			}
		}
		if (res.headersSent) return;
		res.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-cache",
		});
		res.end(text);
		return;
	}

	if (parts[1] === "claude" && parts[2] === "input") {
		if (req.method === "GET") {
			return respond(200, {
				active: hasActiveInput(),
				label: activeInputLabel(),
				remote: activeRemoteRegistration(),
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (!body || typeof body.text !== "string") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {text: string}",
				});
			}
			const result = await writeInput(body.text);
			if (result.written) return respond(200, result);
			return respond(503, result);
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	// Reverse channel for cross-process attach. A `clawback claude` launcher
	// that attached to this proxy POSTs here with its loopback callback
	// URL + token; writeInput() then routes input back to that launcher's
	// PTY. DELETE clears the registration (called on launcher exit).
	if (parts[1] === "claude" && parts[2] === "register") {
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (!body || typeof body.url !== "string") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {url: string, token?: string, label?: string}",
				});
			}
			try {
				registerRemoteInput({
					url: body.url,
					token: typeof body.token === "string" ? body.token : null,
					label: typeof body.label === "string" ? body.label : undefined,
				});
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			logger?.info?.(
				`claude PTY remote input registered (${body.url}, label=${body.label ?? "claude-remote"})`,
			);
			return respond(200, {
				registered: true,
				remote: activeRemoteRegistration(),
			});
		}
		if (req.method === "DELETE") {
			clearRemoteInput();
			logger?.info?.("claude PTY remote input cleared");
			return respond(200, { cleared: true });
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["POST", "DELETE"],
		});
	}

	if (parts[1] === "passthrough") {
		if (req.method === "GET") {
			return respond(200, passthroughStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			const enabled = resolvePassthroughToggle(body, config);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyPassthrough(enabled, { config, scheduler, logger });
			return respond(200, passthroughStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "keep-alive") {
		if (req.method === "GET") {
			return respond(200, {
				keepAliveEnabled: Boolean(config.keepAliveEnabled),
				passthrough: Boolean(config.passthrough),
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			// PLAN §33: while passthrough is on, this knob is force-pinned
			// off (loadConfig's post-merge override). Re-enabling keep-alive
			// mid-baseline would corrupt the experiment — refuse with 409
			// rather than silently letting it through.
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling keep-alive",
				});
			}
			const enabled = resolveFlagToggle(body, config.keepAliveEnabled);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyKeepAlive(enabled, { config, scheduler, logger });
			return respond(200, {
				keepAliveEnabled: Boolean(config.keepAliveEnabled),
				passthrough: Boolean(config.passthrough),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "strip-ephemeral") {
		if (req.method === "GET") {
			return respond(200, {
				stripEphemeralFromSystem: Boolean(config.stripEphemeralFromSystem),
				passthrough: Boolean(config.passthrough),
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling strip-ephemeral",
				});
			}
			const enabled = resolveFlagToggle(body, config.stripEphemeralFromSystem);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyStripEphemeral(enabled, { config, logger });
			return respond(200, {
				stripEphemeralFromSystem: Boolean(config.stripEphemeralFromSystem),
				passthrough: Boolean(config.passthrough),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "extend-cache-ttl") {
		if (req.method === "GET") {
			return respond(200, extendCacheTtlStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling extend-cache-ttl",
				});
			}
			const enabled = resolveFlagToggle(body, config.injectExtendedCacheTtl);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyExtendCacheTtl(enabled, { config, logger });
			return respond(200, extendCacheTtlStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "strip-extended-cache-ttl") {
		if (req.method === "GET") {
			return respond(200, stripExtendCacheTtlStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling strip-extended-cache-ttl",
				});
			}
			const enabled = resolveFlagToggle(body, config.stripExtendedCacheTtl);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyStripExtendCacheTtl(enabled, { config, logger });
			return respond(200, stripExtendCacheTtlStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "mobile") {
		if (req.method === "GET") {
			return respond(200, mobileStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			const enabled = resolveFlagToggle(body, config.mobile);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyMobile(enabled, { config, logger });
			return respond(200, mobileStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "keep-alive-extended") {
		if (req.method === "GET") {
			return respond(200, keepAliveExtendedStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling keep-alive-extended",
				});
			}
			const enabled = resolveFlagToggle(body, config.keepAliveModeExtended);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyKeepAliveExtended(enabled, { config, logger });
			return respond(200, keepAliveExtendedStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "auto-continue") {
		if (req.method === "GET") {
			return respond(200, autoContinueStatus(config));
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			// While passthrough is on, this knob is force-pinned off so
			// the baseline arm is honest. A mid-window flip would itself
			// be a toggle event in the measurement; refuse with 409 and
			// let the operator exit passthrough first. Mirrors the
			// guard on keep-alive / strip-ephemeral / extend-cache-ttl.
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before toggling auto-continue",
				});
			}
			const enabled = resolveFlagToggle(body, config.autoContinue);
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'toggle'|'on'|'off'}",
				});
			}
			applyAutoContinue(enabled, { config, logger });
			return respond(200, autoContinueStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "stack") {
		// Composite apply target for the suggestion engine's long-session
		// stack rules (stack-cold-suggest-all, stack-partial-completion).
		// Flips keep-alive + 1h TTL + extended cadence together so one
		// click takes the operator from cold to the full §3.4/§5.1/§5.2
		// stack. Not exposed as a UI toggle — there's no 8th knob — but
		// the apply endpoint exists so the suggestion cards' button works.
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before applying the stack",
				});
			}
			const action =
				typeof body?.action === "string" ? body.action.toLowerCase() : null;
			const enabled =
				typeof body?.enabled === "boolean"
					? body.enabled
					: action === "on" || action === "enable"
						? true
						: action === "off" || action === "disable"
							? false
							: null;
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'on'|'off'|'enable'|'disable'}",
				});
			}
			applyKeepAlive(enabled, { config, scheduler, logger });
			applyExtendCacheTtl(enabled, { config, logger });
			applyKeepAliveExtended(enabled, { config, logger });
			return respond(200, {
				keepAliveEnabled: Boolean(config.keepAliveEnabled),
				injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
				keepAliveModeExtended: Boolean(config.keepAliveModeExtended),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["POST"],
		});
	}

	if (parts[1] === "tight-loop") {
		// Composite apply target for the strip-1h-tight-loop suggestion.
		// "on" forces the documented 5m TTL (strips the native 1h headers
		// Claude Code writes) AND drops keep-alive back to the fast 1-4 min
		// cadence that matches a 5m cache — the two halves of the tight-loop
		// fix. Unlike `stack` it applies fixed polarities, not one uniform
		// boolean: strip ON but extended-cadence OFF. "off" only lifts the
		// strip; it leaves the cadence where the operator left it (symmetric
		// with strip-extended-cache-ttl, which doesn't presume to restore 1h
		// inject on disable). Not a UI knob — the apply endpoint exists so
		// the suggestion card's one-click button works.
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (config.passthrough) {
				return respond(409, {
					error: "conflict",
					message:
						"passthrough is enabled; exit passthrough before applying the tight-loop fix",
				});
			}
			const action =
				typeof body?.action === "string" ? body.action.toLowerCase() : null;
			const enabled =
				typeof body?.enabled === "boolean"
					? body.enabled
					: action === "on" || action === "enable"
						? true
						: action === "off" || action === "disable"
							? false
							: null;
			if (typeof enabled !== "boolean") {
				return respond(400, {
					error: "bad_request",
					message:
						"body must be {enabled: bool} or {action: 'on'|'off'|'enable'|'disable'}",
				});
			}
			applyStripExtendCacheTtl(enabled, { config, logger });
			if (enabled) applyKeepAliveExtended(false, { config, logger });
			return respond(200, {
				stripExtendedCacheTtl: Boolean(config.stripExtendedCacheTtl),
				injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
				keepAliveModeExtended: Boolean(config.keepAliveModeExtended),
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["POST"],
		});
	}

	if (parts[1] === "capture-baseline") {
		if (req.method === "GET") {
			return respond(200, captureBaselineStatus(config));
		}
		if (req.method === "POST") {
			let body = {};
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			// Optional per-capture overrides. `shadow` opts into the ~2x-cost
			// turn-matched capture that keeps the armed knobs live; `turns`
			// overrides the window length for this run only.
			const shadow =
				typeof body?.shadow === "boolean" ? body.shadow : undefined;
			const turns =
				Number.isFinite(body?.turns) && body.turns > 0
					? Math.floor(body.turns)
					: undefined;
			startBaselineCapture(config, {
				store,
				scheduler,
				logger,
				shadow,
				turns,
			});
			return respond(200, captureBaselineStatus(config));
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "suggestions" && req.method === "GET") {
		const context = buildContext({
			config,
			store,
			samples: listSamples({ limit: MAX_SAMPLES_PER_SESSION }),
			turnLogFile: config?.turnLogFile ?? null,
		});
		const suggestions = evaluate(context);
		return respond(200, { suggestions });
	}

	if (parts[1] === "metrics") {
		if (req.method === "GET") {
			const sinceParam = url.searchParams.get("since");
			const limitParam = url.searchParams.get("limit");
			// PLAN §39 (Phase 1): optional ?session=<id> filter restricts
			// the returned samples to a single session's ring. Omitted
			// query → merged samples across all rings (chronological).
			const sessionParam = url.searchParams.get("session");
			const limit =
				limitParam != null && Number.isFinite(Number(limitParam))
					? Math.max(0, Math.floor(Number(limitParam)))
					: MAX_SAMPLES_PER_SESSION;
			const samples = listSamples({
				session: sessionParam || null,
				since: sinceParam || null,
				limit,
			});
			return respond(200, {
				samples,
				capacity: MAX_SAMPLES_PER_SESSION,
				returned: samples.length,
				session: sessionParam || null,
			});
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			const action =
				typeof body?.action === "string" ? body.action.toLowerCase() : null;
			if (action !== "clear") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {action: 'clear'}",
				});
			}
			// PLAN §39 (Phase 1): optional {session: "<id>"} in the body
			// clears just that ring; omitted clears every ring (legacy
			// behaviour, the UI's "clear history" button).
			const sessionArg =
				typeof body?.session === "string" && body.session.length > 0
					? body.session
					: null;
			const cleared = clearSamples({ session: sessionArg });
			appendEvent({
				type: "metrics-cleared",
				text: sessionArg
					? `metrics ring cleared for session=${sessionArg} (${cleared} samples)`
					: `metrics ring cleared (${cleared} samples)`,
			});
			return respond(200, {
				cleared: true,
				count: cleared,
				session: sessionArg,
			});
		}
		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST"],
		});
	}

	if (parts[1] === "health" && req.method === "GET" && parts.length === 2) {
		return respond(200, {
			status: "ok",
			version: CLAWBACK_VERSION,
			uptimeSeconds: Math.floor(process.uptime()),
			sessions: store.keys().length,
			config: publicConfig(config),
			// Projected keep-alive token spend between now and the next
			// quota reset across all live sessions. Operators should keep
			// at least this many tokens free in their 5-hour bucket so
			// pings don't starve real turns. Returns zeros when
			// keep-alive is off (or passthrough is on).
			keepAliveReserve: projectKeepAliveReserve(store, config),
			// Aggregate cache_control injection counters across every live
			// session. Lets the operator answer "is the 1h cache TTL knob
			// actually firing on my real turns" without paging through
			// every session record. Per-session breakdown is on each
			// `/_proxy/sessions/<id>` payload (cacheControlInjection).
			cacheControlInjection: aggregateInjectionCounters(store),
		});
	}

	if (parts[1] === "version" && req.method === "GET" && parts.length === 2) {
		return respond(200, { version: CLAWBACK_VERSION });
	}

	if (parts[1] === "sessions") {
		const sessionId = parts[2];

		if (req.method === "GET" && !sessionId) {
			// PLAN §39 (Phase 1): merge the per-session metrics-ring
			// summaries onto the publicSession rows so the Phase 2 UI can
			// hydrate session filter buttons (label + colour + recency)
			// without a second round-trip. Sessions that exist in the
			// metrics ring but NOT in the store (e.g. label-POST stub
			// created before any /v1/messages traffic, or session
			// evicted from the store) get a thin row built from the
			// summary alone.
			const summaries = listSessionSummaries();
			const summaryByKey = new Map(summaries.map((s) => [s.sessionKey, s]));
			const storeRows = store.all().map(publicSession);
			const storeKeys = new Set(storeRows.map((r) => r.key));
			const enriched = storeRows.map((row) => {
				const sum = summaryByKey.get(row.key);
				return {
					...row,
					sampleCount: sum?.sampleCount ?? 0,
					lastSampleTs: sum?.lastTs ?? null,
				};
			});
			for (const sum of summaries) {
				if (storeKeys.has(sum.sessionKey)) continue;
				if (sum.sessionKey === "_aggregate") continue;
				enriched.push({
					key: sum.sessionKey,
					label: sum.label ?? sum.sessionKey,
					labelSource: "auto",
					mode: "metrics-only",
					sampleCount: sum.sampleCount,
					lastSampleTs: sum.lastTs,
				});
			}
			return respond(200, {
				count: enriched.length,
				sessions: enriched,
			});
		}

		if (req.method === "GET" && sessionId) {
			const s = store.get(sessionId);
			if (!s) return respond(404, { error: "not_found", id: sessionId });
			return respond(200, publicSession(s));
		}

		// PLAN §39 (Phase 1): POST /_proxy/sessions/<id> with {label} sets
		// the operator-supplied label on a session record. Accept-and-create
		// — if the record doesn't exist yet (the spawned claude hasn't made
		// its first /v1/messages call), we create a stub carrying only the
		// label, and the first real request fills in the rest via the
		// existing path-mode upsert.
		if (req.method === "POST" && sessionId) {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (e) {
				return respond(400, { error: "bad_request", message: e.message });
			}
			if (!body || typeof body.label !== "string") {
				return respond(400, {
					error: "bad_request",
					message: "body must be {label: string}",
				});
			}
			let label;
			try {
				label = validateLabel(body.label);
			} catch (e) {
				return respond(400, {
					error: "bad_request",
					message: e.message,
				});
			}
			store.upsert(sessionId, (prev) => {
				const base = prev ?? {
					key: sessionId,
					mode: "path",
					createdAt: new Date().toISOString(),
				};
				return { ...base, label, labelSource: "operator" };
			});
			return respond(200, publicSession(store.get(sessionId)));
		}

		if (req.method === "DELETE" && sessionId) {
			const existed = store.get(sessionId);
			if (!existed) return respond(404, { error: "not_found", id: sessionId });
			store.delete(sessionId);
			scheduler.cancelSession(sessionId);
			return respond(200, { deleted: sessionId });
		}

		if (req.method === "DELETE" && !sessionId) {
			const keys = store.keys();
			for (const k of keys) scheduler.cancelSession(k);
			const n = store.purgeAll();
			return respond(200, { purged: n });
		}

		return respond(405, {
			error: "method_not_allowed",
			allow: ["GET", "POST", "DELETE"],
		});
	}

	return respond(404, { error: "not_found" });
}

export function publicSession(s) {
	return {
		key: s.key,
		// PLAN §39 (Phase 1): operator-supplied or auto label and its
		// source. `label` falls back to `key` so the UI never has to
		// special-case missing values.
		label: s.label ?? s.key,
		labelSource: s.labelSource ?? "auto",
		mode: s.mode,
		model: s.model ?? null,
		ttlMode: s.ttlMode ?? null,
		createdAt: s.createdAt ?? null,
		lastActivity: s.lastActivity ?? null,
		targetTtl: s.targetTtl ?? null,
		nextKeepAliveAt: s.nextKeepAliveAt ?? null,
		lastKeepAliveAt: s.lastKeepAliveAt ?? null,
		lastKeepAliveStatus: s.lastKeepAliveStatus ?? null,
		lastKeepAliveError: s.lastKeepAliveError ?? null,
		authStale: s.authStale === true,
		keepAliveCount: s.keepAliveCount ?? 0,
		keepAliveFailures: s.keepAliveFailures ?? 0,
		keepAliveTokensUsed: s.keepAliveTokensUsed ?? 0,
		lastRateLimit: s.lastRateLimit ?? null,
		cacheCreationTokens: s.cacheCreationTokens ?? 0,
		cacheReadTokens: s.cacheReadTokens ?? 0,
		cacheMissTokens: s.cacheMissTokens ?? 0,
		lastCacheSampleAt: s.lastCacheSampleAt ?? null,
		cacheControlInjection: s.cacheControlInjection ?? null,
		systemBytes: byteSize(s.system),
		toolsBytes: byteSize(s.tools),
		toolsKey: s.toolsKey ?? null,
		systemStableKey: s.systemStableKey ?? null,
		// strippedSystemPreview intentionally NOT exposed: it carries the
		// sampled text matched by the strip-ephemeral regexes (dates,
		// <env> block contents, workdir-derived paths). The GET endpoint
		// is unauthenticated even when adminToken is set, so leaving this
		// in the public payload leaks operator-environment hints.
		// Diagnostic access lives on the in-memory session record.
	};
}

function publicConfig(c) {
	return {
		upstream: c.upstream,
		keepAliveMinMs: c.keepAliveMinMs,
		keepAliveMaxMs: c.keepAliveMaxMs,
		keepAliveMinMsExtended: c.keepAliveMinMsExtended,
		keepAliveMaxMsExtended: c.keepAliveMaxMsExtended,
		gracePeriodMs: c.gracePeriodMs,
		injectExtendedCacheTtl: c.injectExtendedCacheTtl,
		keepAliveModeExtended: c.keepAliveModeExtended,
		passthrough: c.passthrough ?? false,
		keepAliveEnabled: c.keepAliveEnabled ?? true,
		stripEphemeralFromSystem: c.stripEphemeralFromSystem ?? true,
		mobile: c.mobile ?? false,
		gzipOutgoing: c.gzipOutgoing ?? false,
		forceNonStreaming: c.forceNonStreaming ?? false,
		autoContinue: c.autoContinue ?? false,
		turnLogFile: c.turnLogFile ?? null,
		adminPathPrefix: c.adminPathPrefix ?? "_proxy",
		tls: c.tls ?? false,
		_clawback: true,
	};
}

function byteSize(v) {
	if (v == null) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(v), "utf8");
	} catch {
		return -1;
	}
}

/**
 * Build the single-line text the host TUI's statusLine command renders.
 * Format:
 *
 *   <prefix>context ████░░░░ XX% · day ████░░░░ XX% · week ████░░░░ XX%
 *     · cache ████░░░░ XX% · turn ████░░░░ XX%
 *     · tps ▁▃▆█▂▅▇▄ N · ttft ▆▅▃▂▁▂▁▁ M
 *
 * Capped at `statuslineMaxChars` with a trailing "…" if truncated.
 *
 * Field layout per metric: `<label> <graphic> <value>` — exactly one
 * space between label and graphic, exactly one space between graphic
 * and value. The graphic (sparkline or progress bar) sits between the
 * label and the value so the eye reads label → trend → number.
 *
 * Every figure is per-session (operator-requested 2026-05-06):
 * the fleet-wide session-count chip is gone. `context`/`turn`/`day`/`week`
 * come from the claude session POSTing the statusline; `hit`/`tps`
 * come from the most-recently-active clawback session — which is
 * the same session the calling claude is hitting in the typical
 * one-claude-per-clawback setup.
 *
 * Field sources:
 * - `context`: claude stdin `context_window.used_percentage`. Rendered
 *   as a fill-up-as-you-go progress bar — context fill is a single
 *   bucket, so trend is meaningless and "how full is it" is what the
 *   operator wants to see (operator-requested 2026-05-06).
 * - `quota`: claude stdin `rate_limits.five_hour.used_percentage`. Rolling
 *   5-hour window quota for Pro/Max plans (Claude Code v1.2.80+).
 *   Progress bar — single bucket, no trend. Labeled `quota` to read
 *   as the operator's current rate-limit quota (operator-renamed
 *   2026-05-17 from `next`; the underlying field is still
 *   `five_hour`).
 * - `week`: claude stdin `rate_limits.seven_day.used_percentage`. Rolling
 *   7-day weekly quota. Progress bar.
 * - `hit`: session-lifetime cache hit rate from accumulated counters
 *   (`cacheRead / (cacheRead + cacheCreation + cacheMiss)`).
 * - `turn`: per-turn cache hit rate from claude's
 *   `context_window.current_usage` (last API call's breakdown).
 * - `tps`: output tokens/second of the most-recent turn. Sparkline
 *   shows the previous SPARK_LEN turns from `session.recentTps`.
 * - `ttft`: time-to-first-token of the most-recent turn (ms). Sparkline
 *   shows the previous SPARK_LEN turns from `session.recentTtftMs`.
 *   Lower is better — a falling trend means the cache is warming.
 *
 * Cost (`cost.total_cost_usd`) is intentionally not surfaced —
 * clawback's pricing table is unreliable; `benchmark/` is the right
 * surface for $.
 *
 * The old `limit` field (per-minute tokens-remaining from upstream
 * response headers, via `session.lastRateLimit`) was removed in favour
 * of the two plan-quota windows above — the per-minute bucket is
 * almost never the bottleneck for the operator's day, the 5h/7d
 * windows are what they actually feel.
 */
export function renderStatusline({
	config,
	store,
	claudeSession = null,
	// PLAN §39 (Phase 1): when the request hits the per-session endpoint
	// /_proxy/statusline/<id>, the caller pre-resolves the in-store session
	// record (and its display label) and passes them here. When omitted,
	// we fall back to mostRecentSession + "context" — the legacy aggregate
	// behavior that keeps `/_proxy/statusline` (no id) rendering unchanged.
	clawbackSession = null,
	sessionLabel = null,
	// The raw id from /_proxy/statusline/<id> (null for the legacy no-id /
	// _default path). Distinguishes "this render is scoped to a specific
	// session" from "render the aggregate". When scoped but the session has
	// no store entry yet, we must NOT borrow mostRecentSession — see the
	// recentSession derivation below.
	requestedSessionId = null,
	// Optional override decided by the caller, which knows its consumer.
	// The production caller (the /_proxy/statusline endpoint) passes an
	// explicit value resolved as isatty:true, because the statusline is
	// always rendered by Claude Code's ANSI-capable TUI — not by the
	// clawback server's own (headless) stdout. When omitted, falls back to
	// resolveStatuslineColor({config}) (server env / stdout TTY); tests
	// pass true/false directly to drive both branches deterministically.
	colorEnabled = null,
}) {
	const prefix = config.statuslinePrefix ?? "clawback: ";
	const max = config.statuslineMaxChars ?? 120;
	// Progress-bar cell count is configurable (default 8) so the operator
	// can trade horizontal width for finer resolution. Sparklines stay at
	// SPARK_LEN — they're a different visualization with different needs.
	const barLen = config.statuslineProgressBarLength ?? 8;

	// A scoped per-session request renders THAT session's own hit/tps/ttft.
	// When the session has no store entry yet (claude just launched, or no
	// /v1/messages forwarded since boot), fall back to the *waiting
	// placeholder* below — NOT mostRecentSession, which would borrow a
	// sibling session's numbers and make every idle session's statusline
	// look identical ("same across sessions; ttft always green",
	// operator-flagged 2026-06-02). The mostRecentSession aggregate is the
	// right answer ONLY for the legacy no-id (`_default`) endpoint, where
	// there is no specific session to scope to.
	const sessionScoped = requestedSessionId != null;
	const recentSession = sessionScoped
		? (clawbackSession ?? null)
		: (clawbackSession ?? mostRecentSession(store));
	const ctxLabelText = sessionLabel != null ? sessionLabel : "context";
	// "Claude is fresh" = claudeSession is a real object but its
	// context_window has no current_usage yet, i.e. claude hasn't completed
	// its first API call. In that state, hit/tps/ttft pulled from the
	// most-recently-active store session are misleading — they almost
	// certainly belong to a different claude (a long-lived clawback
	// attached via probe-then-decide, see PLAN §30.5). Render the
	// placeholder shape instead so the operator can see "nothing has
	// happened yet" rather than a stale stranger's numbers.
	const claudeAttached =
		claudeSession != null &&
		typeof claudeSession === "object" &&
		!Array.isArray(claudeSession);
	const claudeIsFresh =
		claudeAttached && claudeSession.context_window?.current_usage == null;
	// Render the "waiting" placeholder for the per-session metric columns
	// (hit/tps/ttft) when either: claude is provably pre-first-call
	// (claudeIsFresh), OR this is a scoped request for a session with no
	// store entry yet. Both mean "no observations for THIS session" — reserve
	// the column with `na`/0% rather than omitting it (no reflow) and, crucially,
	// rather than rendering a sibling session's data. The formatters treat this
	// flag as their placeholder trigger.
	const metricsWaiting =
		claudeIsFresh || (sessionScoped && clawbackSession == null);

	// Pull the threshold knobs from config once and bundle them so each
	// formatter gets one options-bag entry instead of three. The `tps` and
	// `ttft` pairs are the *effective* ones — resolveTpsThresholds /
	// resolveTtftThresholds derive them from the session ring when that
	// metric's calibration is "relative", or pass the static config pair
	// through when "absolute" (or when the ring is too short to calibrate).
	const thresholds = {
		pct: {
			low: config.statuslinePctThresholdLow,
			high: config.statuslinePctThresholdHigh,
		},
		ttft: resolveTtftThresholds(recentSession, config),
		tps: resolveTpsThresholds(recentSession, config),
	};

	// Progressive truncation: each field gets a drop-priority. When the
	// rendered line would exceed `max`, drop fields in priority order
	// (lowest first) and rebuild — never slice mid-field. `context`
	// always stays; if even context-only doesn't fit, fall back to a
	// character slice as a last resort. Operator-tuned 2026-05-17
	// (renderStatusline used to slice the joined ANSI string and
	// sometimes chopped fields mid-glyph).
	//
	// Drop order (lowest priority leaves first):
	//   week (10) → quota (20) → ttft (30) → tps (40) → turn (60) →
	//   cache (70) → context (99 — never).
	//
	// Field order (render left-to-right) is independent of drop order:
	// context anchors the line.
	const fieldSpecs = [
		{
			key: "context",
			priority: 99,
			build: (color) =>
				formatCtxField(claudeSession, barLen, {
					color,
					thresholds,
					labelText: ctxLabelText,
				}),
		},
		{
			key: "quota",
			priority: 20,
			build: (color) =>
				formatRateLimitField(claudeSession, "five_hour", "quota", barLen, {
					color,
					thresholds,
				}),
		},
		{
			key: "week",
			priority: 10,
			build: (color) =>
				formatRateLimitField(claudeSession, "seven_day", "week", barLen, {
					color,
					thresholds,
				}),
		},
		{
			key: "hit",
			priority: 70,
			build: (color) =>
				formatHitField(recentSession, barLen, {
					claudeIsFresh: metricsWaiting,
					claudeAttached,
					color,
					thresholds,
				}),
		},
		{
			key: "turn",
			priority: 60,
			build: (color) =>
				formatTurnField(claudeSession, barLen, { color, thresholds }),
		},
		{
			key: "tps",
			priority: 40,
			build: (color) =>
				formatTpsField(recentSession, {
					claudeIsFresh: metricsWaiting,
					color,
					thresholds,
				}),
		},
		{
			key: "ttft",
			priority: 30,
			build: (color) =>
				formatTtftField(recentSession, {
					claudeIsFresh: metricsWaiting,
					color,
					thresholds,
				}),
		},
	];

	const dropOrder = fieldSpecs
		.filter((f) => f.key !== "context")
		.slice()
		.sort((a, b) => a.priority - b.priority)
		.map((f) => f.key);

	const assemble = (color, excluded) =>
		fieldSpecs
			.filter((f) => !excluded.has(f.key))
			.map((f) => f.build(color))
			.filter((p) => p != null && p.length > 0)
			.join(" · ");

	// Build the plain version first to check truncation against visible
	// length. ANSI escape codes have zero visual width but inflate
	// String#length, so we measure the plain version and re-render with
	// the same excluded set once we know what fits.
	const excluded = new Set();
	let plainFull = `${prefix}${assemble(false, excluded)}`.replace(/\s+$/, "");
	for (const key of dropOrder) {
		if (plainFull.length <= max) break;
		excluded.add(key);
		plainFull = `${prefix}${assemble(false, excluded)}`.replace(/\s+$/, "");
	}
	if (plainFull.length > max) {
		// Even with only context left, the line is too long. Slice as a
		// final fallback.
		return `${plainFull.slice(0, Math.max(0, max - 1))}…`;
	}

	const colors =
		colorEnabled != null ? colorEnabled : resolveStatuslineColor({ config });
	if (!colors) return plainFull;

	return `${prefix}${assemble(true, excluded)}`.replace(/\s+$/, "");
}

// Matches TPS_RING_LEN in server.js — keep them in sync if either changes.
// 8 is the operator-set width as of 2026-05-06 (matches the default
// progress-bar width); the only real sparkline left is `tps`, so this
// is effectively just the tps history window.
const SPARK_LEN = 8;

// ANSI 8-color escape sequences. Operator-requested 2026-05-07: only the
// bar's filled cells pick up color; labels, values, and waiting
// placeholders (▒) stay terminal-default. 8-color is the most-compatible
// palette — it maps to whatever theme the operator's terminal is set to,
// rather than imposing a specific RGB triple that may clash.
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

// "Higher percent = worse" (context fills up; rate-limit windows burn
// down). Below `low` is green, [low, high) is yellow, ≥high is red.
// Thresholds are configurable via statuslinePctThresholdLow/High;
// validate enforces 0 <= low <= high <= 100.
function colorByPctHigh(pct, { low, high } = { low: 50, high: 80 }) {
	if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
	const p = Math.max(0, Math.min(100, pct));
	if (p < low) return ANSI_GREEN;
	if (p < high) return ANSI_YELLOW;
	return ANSI_RED;
}

// "Higher percent = better" (cache hit rate, per-turn hit rate). Direction
// inverted from colorByPctHigh — same threshold pair, opposite color
// assignment. Below `low` is red, [low, high) is yellow, ≥high is green.
function colorByPctLow(pct, { low, high } = { low: 50, high: 80 }) {
	if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
	const p = Math.max(0, Math.min(100, pct));
	if (p < low) return ANSI_RED;
	if (p < high) return ANSI_YELLOW;
	return ANSI_GREEN;
}

// TTFT (ms), lower = better. Below `low` is green (warm cache), [low,
// high) is yellow, ≥high is red (cold cache or upstream slow). Used
// per-cell on the ttft sparkline so a warming pattern visibly transitions
// red → yellow → green left-to-right.
function colorByTtft(ms, { low, high } = { low: 500, high: 2000 }) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
	if (ms < low) return ANSI_GREEN;
	if (ms < high) return ANSI_YELLOW;
	return ANSI_RED;
}

// TPS, higher = better. Mirrors colorByTtft's mechanism but inverts the
// direction (operator-confirmed 2026-05-07). Below `low` is red (slow,
// bad), [low, high) is yellow, ≥high is green (fast, good). The
// {low, high} pair is the *effective* one resolved by
// resolveTpsThresholds — either static config values ("absolute") or
// derived from the session ring ("relative", default).
function colorByTps(tps, { low, high } = { low: 30, high: 80 }) {
	if (typeof tps !== "number" || !Number.isFinite(tps)) return null;
	if (tps < low) return ANSI_RED;
	if (tps < high) return ANSI_YELLOW;
	return ANSI_GREEN;
}

// Minimum finite-and-positive ring samples needed before "relative"
// calibration kicks in. Below this we fall back to the static absolute
// pair — picking a peak from 1-2 samples would lock the bands to
// whatever the first turns happened to produce, which is exactly the
// noise we're trying to filter out.
const TPS_RELATIVE_MIN_SAMPLES = 4;

// Resolve the effective {low, high} TPS color thresholds for this
// render. Returns the static config pair when:
//   - calibration is "absolute", OR
//   - the session has no ring or the ring has < TPS_RELATIVE_MIN_SAMPLES
//     finite-and-positive samples (bootstrap window).
// Otherwise computes low = peak / 6, high = peak / 2 — the 3:2:1 band
// ratio (red : yellow : green) over the observed [0, peak] range. This
// makes color carry information across model classes: an "average" turn
// for *this* session sits in the upper half (green), a meaningfully
// degraded turn drops to yellow, and a turn at < ⅙ of the session's
// observed best lands in red.
function resolveTpsThresholds(session, config) {
	const absolute = {
		low: config.statuslineTpsThresholdLow,
		high: config.statuslineTpsThresholdHigh,
	};
	if (config.statuslineTpsCalibration !== "relative") return absolute;
	if (!session || typeof session !== "object" || Array.isArray(session)) {
		return absolute;
	}
	const ring = Array.isArray(session.recentTps) ? session.recentTps : [];
	const finite = ring.filter((v) => Number.isFinite(v) && v > 0);
	if (finite.length < TPS_RELATIVE_MIN_SAMPLES) return absolute;
	let peak = 0;
	for (const v of finite) {
		if (v > peak) peak = v;
	}
	if (!Number.isFinite(peak) || peak <= 0) return absolute;
	return { low: peak / 6, high: peak / 2 };
}

// Minimum finite-and-positive ring samples before "relative" TTFT
// calibration kicks in. Lower than the TPS gate: the recentTtftMs ring
// is shorter (TTFT_RING_LEN=8) and every turn feeds it (no min-token
// filter), so 3 turns is enough signal to leave the bootstrap window
// quickly — which is the whole point, since the absolute fallback is the
// wide band we're trying to escape.
const TTFT_RELATIVE_MIN_SAMPLES = 3;

function medianOf(values) {
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// TTFT analog of resolveTpsThresholds (lower = better). Returns the
// static config pair when calibration is "absolute" or the ring is too
// short. Otherwise derives low = median*1.5, high = median*3 from the
// session's recentTtftMs ring: a turn within 1.5x the session's typical
// first-token latency is green, 1.5-3x is yellow, >3x is red. Anchored on
// the MEDIAN (not the min, the mirror of tps's peak) so one ultra-fast
// cached request can't drag the green cutoff below the session's
// realistic floor and paint every normal turn yellow.
function resolveTtftThresholds(session, config) {
	const absolute = {
		low: config.statuslineTtftThresholdLowMs,
		high: config.statuslineTtftThresholdHighMs,
	};
	if (config.statuslineTtftCalibration !== "relative") return absolute;
	if (!session || typeof session !== "object" || Array.isArray(session)) {
		return absolute;
	}
	const ring = Array.isArray(session.recentTtftMs) ? session.recentTtftMs : [];
	const finite = ring.filter((v) => Number.isFinite(v) && v > 0);
	if (finite.length < TTFT_RELATIVE_MIN_SAMPLES) return absolute;
	const med = medianOf(finite);
	if (!Number.isFinite(med) || med <= 0) return absolute;
	return { low: med * 1.5, high: med * 3 };
}

/**
 * Resolve the runtime color setting to a boolean.
 *
 * Precedence:
 *   1. config.statuslineColor === "off"   → false
 *   2. config.statuslineColor === "on"    → true
 *   3. NO_COLOR env var set to a non-empty string → false
 *      (https://no-color.org de facto standard)
 *   4. process.stdout.isTTY is falsy (clawback running headless or piped)
 *      → false
 *   5. otherwise → true
 *
 * Both `env` and `isatty` are injectable so tests can drive the resolution
 * without touching real process state.
 */
export function resolveStatuslineColor({
	config,
	env = process.env,
	isatty = process.stdout?.isTTY,
} = {}) {
	const setting = config?.statuslineColor ?? "auto";
	if (setting === "off") return false;
	if (setting === "on") return true;
	if (typeof env?.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
	if (!isatty) return false;
	return true;
}

// Fixed-width column shapes for the numeric tail of each field. Operator-
// requested 2026-05-07: as values populate ("0%" → "42%" → "100%", "1" →
// "999"), the column boundaries should not shift. Right-align with leading
// spaces so the field's right edge is stable; ttft caps at 4 digits
// (9999 ms) which covers the realistic Claude TTFT range — extreme cold-
// cache turns occasionally exceed it and will jitter that one column.
const PCT_WIDTH = 4; // "  0%" to "100%" or " na%"
const TPS_WIDTH = 3; // "  0" to "999" or " na"
// 5 chars covers up to 99999 ms (99 s). Production cold-cache TTFTs
// occasionally exceed 9999 ms (10 s+) on first-turn cache misses, so the
// extra column saves a one-time reflow when that lands. Operator-confirmed
// 2026-05-07.
const TTFT_WIDTH = 5; // "    0" to "99999" or "   na"

function formatPctValue(pct) {
	if (pct == null || !Number.isFinite(pct)) return "na%".padStart(PCT_WIDTH);
	return `${Math.round(pct)}%`.padStart(PCT_WIDTH);
}

function formatTpsValue(value) {
	if (value == null || !Number.isFinite(value)) return "na".padStart(TPS_WIDTH);
	return String(Math.max(0, Math.round(value))).padStart(TPS_WIDTH);
}

function formatTtftValue(value) {
	if (value == null || !Number.isFinite(value))
		return "na".padStart(TTFT_WIDTH);
	return String(Math.max(0, Math.round(value))).padStart(TTFT_WIDTH);
}

function formatCtxField(
	session,
	barLen = SPARK_LEN,
	{ color = false, thresholds = null, labelText = "context" } = {},
) {
	if (!session || typeof session !== "object" || Array.isArray(session)) {
		return null;
	}
	const ctxPct = session.context_window?.used_percentage;
	// Operator-requested 2026-05-07: context defaults to a real 0% (with
	// the empty track `░░░░░░░░`) rather than the waiting glyph, because
	// a fresh context window genuinely starts near zero. Real values
	// override once claude reports them. Width is fixed via formatPctValue
	// so the line doesn't reflow as the value grows.
	const pct =
		typeof ctxPct === "number" && Number.isFinite(ctxPct)
			? Math.max(0, Math.min(100, Math.round(ctxPct)))
			: 0;
	const colorCode = color ? colorByPctHigh(pct, thresholds?.pct) : null;
	// PLAN §39 (Phase 1): per-session statuslines use the session label as
	// the leading field name instead of the literal word "context". When
	// labelText is left at its default "context", the legacy aggregate
	// statusline renders unchanged.
	return `${labelText} ${progressBarFromPct(pct, barLen, { colorCode })} ${formatPctValue(pct)}`;
}

function mostRecentSession(store) {
	if (!store || typeof store.all !== "function") return null;
	const sessions = store.all();
	if (sessions.length === 0) return null;
	let best = null;
	let bestTs = "";
	for (const s of sessions) {
		const ts = s.lastActivity ?? "";
		if (!best || ts > bestTs) {
			best = s;
			bestTs = ts;
		}
	}
	return best;
}

/**
 * Pull the seven statusline numeric values out of the same inputs
 * `renderStatusline` consumes, but as raw numbers (no formatting,
 * no padding, no ANSI). The web UI uses these as time-series points
 * on a shared normalized chart (PLAN §33).
 *
 * The semantics intentionally match what the terminal statusline
 * *displays*, not what's "technically available":
 *
 * - `context` defaults to 0 when claudeSession is attached but the
 *   percentage field is missing. The statusline renders the same
 *   real-0% shape there (operator preference, 2026-05-07).
 * - `hit` returns 0 when fresh or when counters are all-zero, for
 *   the same reason (§32, option B).
 * - `tps`/`ttft` return null when fresh or the ring is empty — the
 *   statusline renders a waiting placeholder, the chart skips the
 *   point.
 *
 * Caller can read the returned object directly into appendSample({...}).
 */
export function extractMetricsSample({
	claudeSession = null,
	recentSession = null,
	claudeIsFresh = false,
	// Optional override. When omitted we recompute from claudeSession, so
	// the helper stays useful for callers that don't already have the bool.
	claudeAttached = null,
} = {}) {
	const out = {
		context: null,
		next: null,
		week: null,
		hit: null,
		turn: null,
		tps: null,
		ttft: null,
	};

	const attached =
		claudeAttached != null
			? Boolean(claudeAttached)
			: claudeSession != null &&
				typeof claudeSession === "object" &&
				!Array.isArray(claudeSession);

	if (attached) {
		const ctxPct = claudeSession.context_window?.used_percentage;
		out.context =
			typeof ctxPct === "number" && Number.isFinite(ctxPct)
				? Math.max(0, Math.min(100, ctxPct))
				: 0;

		const nextPct = claudeSession.rate_limits?.five_hour?.used_percentage;
		if (typeof nextPct === "number" && Number.isFinite(nextPct)) {
			out.next = Math.max(0, Math.min(100, nextPct));
		}

		const weekPct = claudeSession.rate_limits?.seven_day?.used_percentage;
		if (typeof weekPct === "number" && Number.isFinite(weekPct)) {
			out.week = Math.max(0, Math.min(100, weekPct));
		}

		const cu = claudeSession.context_window?.current_usage;
		if (cu && typeof cu === "object") {
			const turnRate = computeHitRate({
				read: cu.cache_read_input_tokens ?? 0,
				create: cu.cache_creation_input_tokens ?? 0,
				miss: cu.input_tokens ?? 0,
			});
			if (turnRate != null) out.turn = turnRate * 100;
		}
	}

	if (claudeIsFresh) {
		// Fresh-claude convention from formatHitField: hit defaults to 0%
		// rather than a stranger session's actual rate.
		out.hit = 0;
	} else if (recentSession) {
		const rate = computeHitRate({
			read: recentSession.cacheReadTokens ?? 0,
			create: recentSession.cacheCreationTokens ?? 0,
			miss: recentSession.cacheMissTokens ?? 0,
		});
		// Counters-all-zero → 0% (option B convention, 2026-05-07).
		out.hit = rate == null ? 0 : rate * 100;

		const tpsRing = Array.isArray(recentSession.recentTps)
			? recentSession.recentTps
			: [];
		const latestTps = tpsRing.length > 0 ? tpsRing[tpsRing.length - 1] : null;
		if (typeof latestTps === "number" && Number.isFinite(latestTps)) {
			out.tps = latestTps;
		}

		const ttftRing = Array.isArray(recentSession.recentTtftMs)
			? recentSession.recentTtftMs
			: [];
		const latestTtft =
			ttftRing.length > 0 ? ttftRing[ttftRing.length - 1] : null;
		if (typeof latestTtft === "number" && Number.isFinite(latestTtft)) {
			out.ttft = latestTtft;
		}
	} else if (attached) {
		// Operator-flagged 2026-05-12: claude is attached but clawback
		// hasn't seen any traffic for it yet. Emit a 0% hit point so the
		// chart series doesn't gap when the terminal statusline shows 0%.
		out.hit = 0;
	}

	return out;
}

/**
 * Session-lifetime cache hit rate from accumulated counters on the
 * most-recently-active session. Returns null when nothing has been
 * observed yet (counters at zero — first turn pre-usage).
 *
 * Rendered as a progress bar (matches context/day/week) rather than a
 * constant-block fake sparkline: hit rate is a percentage, not a time
 * series, and the old "▁▁▁▁ at 0%" looked like a stuck baseline
 * (operator-flagged 2026-05-06).
 */
function formatHitField(
	session,
	barLen = SPARK_LEN,
	{
		claudeIsFresh = false,
		claudeAttached = false,
		color = false,
		thresholds = null,
	} = {},
) {
	if (claudeIsFresh) {
		// Operator-confirmed 2026-05-07: a fresh claude is guaranteed to
		// miss its first turn (cold cache), so 0% is the correct
		// projected default — and crucially NOT a stale store session's
		// hit rate from a different claude. Render the same "real 0%"
		// shape context uses (empty track ░, real 0% value).
		return `cache ${progressBarFromPct(0, barLen)} ${formatPctValue(0)}`;
	}
	if (!session) {
		// Operator-flagged 2026-05-12: when a claudeSession is attached
		// but no clawback session exists in the store, the hit column
		// was disappearing even though turn was rendering. Symmetry with
		// the other "claude is here but clawback has no observations
		// yet" cases (fresh + zero-counter): reserve the column with
		// the real-0% shape. Plain-GET callers (no claudeSession) still
		// get null — nothing to render against.
		if (claudeAttached) {
			return `cache ${progressBarFromPct(0, barLen)} ${formatPctValue(0)}`;
		}
		return null;
	}
	const rate = computeHitRate({
		read: session.cacheReadTokens ?? 0,
		create: session.cacheCreationTokens ?? 0,
		miss: session.cacheMissTokens ?? 0,
	});
	if (rate == null) {
		// Counters all at zero — either a brand-new session that hasn't
		// completed a turn yet, or (more commonly) mostRecentSession
		// picked up a freshly-ticked but empty session that isn't the
		// one the posting claude belongs to. Either way: a vacuous 0%
		// hit rate is honest (no observations means no hits) and keeps
		// the column reserved so the line doesn't reflow when a real
		// observation lands. Operator-confirmed 2026-05-07 (option B,
		// matches the fresh-claude shape rather than a `na%` placeholder).
		return `cache ${progressBarFromPct(0, barLen)} ${formatPctValue(0)}`;
	}
	const pct = Math.round(rate * 100);
	const colorCode = color ? colorByPctLow(pct, thresholds?.pct) : null;
	return `cache ${progressBarFromPct(pct, barLen, { colorCode })} ${formatPctValue(pct)}`;
}

/**
 * Per-turn cache hit rate from claude's `context_window.current_usage`
 * (the most recent API call's token breakdown). Progress bar, same
 * reasoning as `hit`.
 *
 * When claudeSession is connected but `current_usage` is missing
 * (claude hasn't made its first API call yet — claude reports null in
 * that state), render the same waiting placeholder day/week use so the
 * column is reserved. Plain GETs without a claudeSession skip the
 * field entirely (no data source to render against).
 */
function formatTurnField(
	claudeSession,
	barLen = SPARK_LEN,
	{ color = false, thresholds = null } = {},
) {
	if (
		!claudeSession ||
		typeof claudeSession !== "object" ||
		Array.isArray(claudeSession)
	) {
		return null;
	}
	const cu = claudeSession.context_window?.current_usage;
	if (!cu || typeof cu !== "object") {
		// Pre-first-API-call: render the waiting bar plus ` na%` so the
		// numeric column matches the percentage fields' fixed width.
		// The placeholder bar ▒ is intentionally not colored.
		return `turn ${"▒".repeat(barLen)} ${formatPctValue(null)}`;
	}
	const rate = computeHitRate({
		read: cu.cache_read_input_tokens ?? 0,
		create: cu.cache_creation_input_tokens ?? 0,
		miss: cu.input_tokens ?? 0,
	});
	if (rate == null) {
		return `turn ${"▒".repeat(barLen)} ${formatPctValue(null)}`;
	}
	const pct = Math.round(rate * 100);
	const colorCode = color ? colorByPctLow(pct, thresholds?.pct) : null;
	return `turn ${progressBarFromPct(pct, barLen, { colorCode })} ${formatPctValue(pct)}`;
}

/**
 * Plan-quota progress bar from claude's stdin `rate_limits.<window>.used_percentage`
 * (Claude Code v1.2.80+ surfaces this on every statusLine update). `window` is
 * `five_hour` or `seven_day`; `label` is the short tag we render ("quota" / "week").
 *
 * When `claudeSession` is missing entirely we return null (no claude connected,
 * nothing to show). When claudeSession exists but `rate_limits` hasn't been
 * populated yet — per the docs, the field "appears only for Claude.ai
 * subscribers (Pro/Max) after the first API response" — we render a *waiting*
 * placeholder so the field's column is reserved and doesn't snap in on the
 * second request (operator-flagged 2026-05-06). The placeholder is medium-shade
 * `▒` × barLen with no numeric value (no `…` either — operator preference);
 * visually distinct from both `░░░░░░░░ 0%` (real zero, empty track) and
 * `████████ 100%` (saturation).
 *
 * Source: https://code.claude.com/docs/en/statusline (rate_limits schema).
 */
function formatRateLimitField(
	claudeSession,
	window,
	label,
	barLen = SPARK_LEN,
	{ color = false, thresholds = null } = {},
) {
	if (!claudeSession || typeof claudeSession !== "object") return null;
	const block = claudeSession.rate_limits?.[window];
	const raw = block?.used_percentage;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		// Plan-quota windows haven't loaded yet (per docs, rate_limits
		// appears only after the first API response on Pro/Max plans).
		// Operator-requested 2026-05-07: render ` na%` rather than
		// dropping the value entirely so the column width matches a
		// real percentage and the line doesn't shift on first response.
		return `${label} ${"▒".repeat(barLen)} ${formatPctValue(null)}`;
	}
	const pct = Math.round(raw);
	const colorCode = color ? colorByPctHigh(pct, thresholds?.pct) : null;
	return `${label} ${progressBarFromPct(pct, barLen, { colorCode })} ${formatPctValue(pct)}`;
}

/**
 * Tokens-per-second of the most-recent turn, with a sparkline of the
 * previous SPARK_LEN turns. Driven by `session.recentTps` ring buffer
 * populated in server.js after each upstream response (output_tokens /
 * wallSeconds).
 *
 * When `claudeIsFresh`, override any ring contents with the `na`
 * waiting placeholder. The most-recent clawback session in the store
 * is from a different claude in that case (see renderStatusline) and
 * displaying its tps would mislead the operator into thinking their
 * fresh claude has already completed a turn.
 *
 * When a session is attached but the ring is empty or has no finite
 * value, render the same `▒▒▒▒▒▒▒▒  na` placeholder. The ring fills
 * only on turns whose `output_tokens >= TPS_MIN_OUTPUT_TOKENS` (server.js
 * filter that drops tool-call-only turns whose tps reading would be
 * meaningless), so a session can have ttft samples without any tps
 * samples — the operator should see a reserved column rather than the
 * field disappearing (operator-flagged 2026-05-07; mirrors ttft's
 * placeholder behaviour and preserves the no-reflow guarantee).
 *
 * When no session exists at all (plain-GET with empty store), return
 * null and omit the field — same as ttft.
 */
function formatTpsField(
	session,
	{ claudeIsFresh = false, color = false, thresholds = null } = {},
) {
	if (claudeIsFresh) {
		return `tps ${"▒".repeat(SPARK_LEN)} ${formatTpsValue(null)}`;
	}
	if (!session) return null;
	const ring = Array.isArray(session.recentTps) ? session.recentTps : [];
	const latest = ring.length > 0 ? ring[ring.length - 1] : null;
	if (!Number.isFinite(latest)) {
		return `tps ${"▒".repeat(SPARK_LEN)} ${formatTpsValue(null)}`;
	}
	const window = ring.slice(-SPARK_LEN);
	// Color each cell by its absolute tps, mirroring ttft's per-cell
	// approach but with the direction inverted (higher = better, so a
	// trending-up sparkline reads as red → yellow → green). Operator-
	// added 2026-05-07. Thresholds default by model class, configurable
	// via statuslineTpsThresholdLow/High.
	const colorFor = color ? (v) => colorByTps(v, thresholds?.tps) : null;
	return `tps ${sparklineFromValues(window, SPARK_LEN, { colorFor })} ${formatTpsValue(latest)}`;
}

/**
 * Time-to-first-token for the most-recent turn (ms), with a sparkline
 * of the previous SPARK_LEN turns. Driven by `session.recentTtftMs`
 * ring buffer populated in server.js (the `ttftMs` returned from
 * `proxyRequest`). The cleanest cache-warmth signal we have: warm
 * cache shows ~100-500ms, cold ~1000-3000ms. Lower is better, which
 * means a *falling* sparkline trend is good — opposite of the tps
 * field.
 *
 * When there's no history yet (fresh boot, or session captured before
 * we started recording the ring), we render a waiting placeholder
 * `▒▒▒▒▒▒▒▒ na` — same shading as the day/week placeholders so the
 * "no data yet" state is visually uniform across the line. Reserves
 * the column so the sparkline doesn't snap in on the second turn
 * (operator-flagged 2026-05-06).
 */
function formatTtftField(
	session,
	{ claudeIsFresh = false, color = false, thresholds = null } = {},
) {
	// Same gate as tps: when claude is provably pre-first-call, the
	// ring contents belong to some other claude. Show " na" rather than
	// a stranger's last-turn ttft.
	if (claudeIsFresh) {
		return `ttft ${"▒".repeat(SPARK_LEN)} ${formatTtftValue(null)}`;
	}
	if (!session) return null;
	const ring = Array.isArray(session.recentTtftMs) ? session.recentTtftMs : [];
	const latest = ring.length > 0 ? ring[ring.length - 1] : null;
	if (!Number.isFinite(latest)) {
		return `ttft ${"▒".repeat(SPARK_LEN)} ${formatTtftValue(null)}`;
	}
	const window = ring.slice(-SPARK_LEN);
	// Color each cell by its absolute ms value, not the relative
	// position in the window. A warming pattern (red ms → green ms)
	// reads as a clear color gradient.
	const colorFor = color ? (v) => colorByTtft(v, thresholds?.ttft) : null;
	return `ttft ${sparklineFromValues(window, SPARK_LEN, { colorFor })} ${formatTtftValue(latest)}`;
}

/**
 * Robust scaling domain for a series, via Tukey fences
 * (Q1 - 1.5·IQR, Q3 + 1.5·IQR) clamped to the observed range. tps/ttft
 * series are dominated by occasional lone spikes (a cold-cache TTFT, a
 * near-zero-denominator tps); scaling to the raw min/max lets one such
 * spike collapse every other cell to the floor block. Fences instead
 * pin the domain to the bulk of the distribution so normal variation
 * keeps its dynamic range, while the outlier saturates the top cell.
 * The exact magnitude isn't lost — callers print the latest value
 * numerically beside the graphic. Falls back to plain min/max for
 * windows too short (<4) to estimate quartiles.
 */
function robustExtent(values) {
	const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
	const n = xs.length;
	if (n === 0) return null;
	if (n < 4) return { lo: xs[0], hi: xs[n - 1] };
	const q = (p) => {
		const idx = p * (n - 1);
		const lo = Math.floor(idx);
		const hi = Math.ceil(idx);
		return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
	};
	const q1 = q(0.25);
	const q3 = q(0.75);
	const iqr = q3 - q1;
	return {
		lo: Math.max(xs[0], q1 - 1.5 * iqr),
		hi: Math.min(xs[n - 1], q3 + 1.5 * iqr),
	};
}

/**
 * Real historical sparkline from an array of arbitrary numeric values,
 * scaled to a robust min/max (see `robustExtent`) so even small swings
 * are visible and a lone outlier saturates the top cell instead of
 * flattening the rest. Right-aligned (most-recent value at the right
 * edge); left-padded with the lowest block when the array is shorter
 * than `length`.
 */
function sparklineFromValues(
	values,
	length = SPARK_LEN,
	{ colorFor = null } = {},
) {
	const blocks = "▁▂▃▄▅▆▇█";
	const window = values.slice(-length);
	if (window.length === 0) return "";
	const extent = robustExtent(window);
	if (!extent) return "";
	const { lo: min, hi: max } = extent;
	const span = max - min;
	// `colorFor(value)` returns an ANSI escape (or null) keyed on the
	// absolute value of each cell, NOT its relative position in the
	// window. That lets the ttft sparkline visualize cache-warming as
	// an obvious color gradient (red → yellow → green) — independent of
	// the cell-height encoding which scales relative to min/max.
	const cells = window.map((v) => {
		if (!Number.isFinite(v)) return blocks[0];
		let glyph;
		if (span <= 0) glyph = blocks[Math.floor(blocks.length / 2)];
		else {
			// Clamp into the robust domain so out-of-fence outliers
			// saturate the top/bottom cell rather than rescaling all of it.
			const cv = Math.max(min, Math.min(max, v));
			const idx = Math.floor(((cv - min) / span) * (blocks.length - 1));
			glyph = blocks[Math.max(0, Math.min(blocks.length - 1, idx))];
		}
		if (colorFor) {
			const code = colorFor(v);
			if (code) return `${code}${glyph}${ANSI_RESET}`;
		}
		return glyph;
	});
	while (cells.length < length) cells.unshift(blocks[0]);
	return cells.join("");
}

/**
 * Fill-up-as-you-go progress bar for a 0-100 percent value. Each cell
 * is either a full block ('█', filled) or a light-shade track ('░',
 * empty) — never a partial-fill eighths character. Resolution is
 * 100/`length` percent per cell.
 *
 * The full track ('░' × `length`) is always visible underneath the
 * fill, so the operator can see where 100% would be at any percentage
 * (operator-requested 2026-05-06). Earlier versions used eighths-of-
 * a-block partial fills (▏▎▍▌▋▊▉) for finer resolution, but the empty
 * portion of those cells shows the bare terminal background — which
 * reads as a gap between the fill and the trailing track when the
 * partial cell is mostly empty (e.g. ██▏░ at 54%). The numeric value
 * alongside the bar carries the precise %; the bar's job is at-a-
 * glance level, not 1% precision.
 */
function progressBarFromPct(
	pct,
	length = SPARK_LEN,
	{ colorCode = null } = {},
) {
	if (typeof pct !== "number" || !Number.isFinite(pct)) return "";
	const clamped = Math.max(0, Math.min(100, pct));
	const fullCells = Math.round((clamped / 100) * length);
	const empty = length - fullCells;
	const fill = "█".repeat(fullCells);
	const track = "░".repeat(empty);
	// Only color the filled portion (operator-requested 2026-05-07: bars
	// only). Skip the wrap entirely when there's nothing to color (0%).
	if (colorCode && fullCells > 0) {
		return `${colorCode}${fill}${ANSI_RESET}${track}`;
	}
	return fill + track;
}

function computeHitRate({ read, create, miss }) {
	const total = read + create + miss;
	if (total <= 0) return null;
	return read / total;
}

function passthroughStatus(config) {
	return {
		passthrough: Boolean(config.passthrough),
		injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
		stripEphemeralFromSystem: Boolean(config.stripEphemeralFromSystem),
		keepAliveEnabled: Boolean(config.keepAliveEnabled),
		baselineSnapshot: config._baselineSnapshot ?? null,
	};
}

/**
 * Full mode snapshot for the metrics ring. Both the upstream sample
 * path (src/server.js) and the statusline POST path (above) write this
 * shape so the UI's chart-marker comparison (renderModeMarkers in
 * src/ui/app.js) never sees a field present in one sample and absent
 * in the other — a missing field compared against a defined boolean
 * used to trigger a phantom flip marker on the charts. All 7 MVP
 * toggles are captured here.
 */
export function sampleModeSnapshot(config) {
	return {
		passthrough: Boolean(config.passthrough),
		keepAliveEnabled: Boolean(config.keepAliveEnabled),
		injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
		stripEphemeralFromSystem: Boolean(config.stripEphemeralFromSystem),
		mobile: Boolean(config.mobile),
		keepAliveModeExtended: Boolean(config.keepAliveModeExtended),
		autoContinue: Boolean(config.autoContinue),
	};
}

function resolvePassthroughToggle(body, config) {
	if (body && typeof body.enabled === "boolean") return body.enabled;
	if (body && typeof body.action === "string") {
		const a = body.action.toLowerCase();
		if (a === "on" || a === "enable") return true;
		if (a === "off" || a === "disable") return false;
		if (a === "toggle") return !config.passthrough;
	}
	return null;
}

/**
 * Generic flag-toggle resolver shared by /keep-alive and
 * /strip-ephemeral. Same body grammar as resolvePassthroughToggle
 * (`{enabled: bool}` or `{action: "toggle"|"on"|"off"|"enable"|"disable"}`)
 * but the toggle pivot is whatever current state the caller passes in,
 * not a fixed config field.
 */
function resolveFlagToggle(body, currentState) {
	if (body && typeof body.enabled === "boolean") return body.enabled;
	if (body && typeof body.action === "string") {
		const a = body.action.toLowerCase();
		if (a === "on" || a === "enable") return true;
		if (a === "off" || a === "disable") return false;
		if (a === "toggle") return !currentState;
	}
	return null;
}

/**
 * Flip the keep-alive scheduler on/off live. Refused while
 * passthrough is on (the caller checks before reaching this).
 * Same audit-trail pattern as applyPassthrough: log + appendEvent.
 */
function applyKeepAlive(enabled, { config, scheduler, logger }) {
	const prev = Boolean(config.keepAliveEnabled);
	config.keepAliveEnabled = enabled;
	try {
		if (enabled) {
			scheduler?.start?.();
		} else {
			scheduler?.stop?.();
		}
	} catch (e) {
		logger?.warn?.(
			`scheduler ${enabled ? "start" : "stop"} failed during keep-alive toggle: ${e.message}`,
		);
	}
	logger?.info?.(`runtime mode toggled: keepAliveEnabled ${prev} → ${enabled}`);
	appendEvent({
		type: "keep-alive-toggle",
		text: `keep-alive ${enabled ? "ON" : "OFF"}`,
		meta: { keepAliveEnabled: enabled },
	});
}

/**
 * Flip the system-prompt strip-ephemeral feature on/off live. No
 * scheduler side effect — the change takes effect on the next
 * /v1/messages request (stripEphemeral is consulted per-request
 * in src/server.js). Refused while passthrough is on.
 */
function applyStripEphemeral(enabled, { config, logger }) {
	const prev = Boolean(config.stripEphemeralFromSystem);
	config.stripEphemeralFromSystem = enabled;
	logger?.info?.(
		`runtime mode toggled: stripEphemeralFromSystem ${prev} → ${enabled}`,
	);
	appendEvent({
		type: "strip-ephemeral-toggle",
		text: `strip-ephemeral ${enabled ? "ON" : "OFF"}`,
		meta: { stripEphemeralFromSystem: enabled },
	});
}

function extendCacheTtlStatus(config) {
	return {
		injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
		passthrough: Boolean(config.passthrough),
	};
}

function applyExtendCacheTtl(enabled, { config, logger }) {
	const prev = Boolean(config.injectExtendedCacheTtl);
	config.injectExtendedCacheTtl = enabled;
	logger?.info?.(
		`runtime mode toggled: injectExtendedCacheTtl ${prev} → ${enabled}`,
	);
	appendEvent({
		type: "extend-cache-ttl-toggle",
		text: `extend-cache-ttl ${enabled ? "ON" : "OFF"}`,
		meta: { injectExtendedCacheTtl: enabled },
	});
}

function stripExtendCacheTtlStatus(config) {
	return {
		stripExtendedCacheTtl: Boolean(config.stripExtendedCacheTtl),
		injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
		passthrough: Boolean(config.passthrough),
	};
}

/**
 * strip-extended-cache-ttl and inject-extended-cache-ttl are mutually
 * exclusive intentions (force 5m vs force 1h). The transform already lets
 * strip win at runtime (early return in injectIntoBody), but turning strip
 * ON while inject is still ON would leave the operator's status surface
 * showing both lit — incoherent. So enabling strip also clears inject, and
 * the event log records the paired flip. Disabling strip leaves inject as-is
 * (we don't presume the operator wants 1h back; they can flip it explicitly).
 */
function applyStripExtendCacheTtl(enabled, { config, logger }) {
	const prevStrip = Boolean(config.stripExtendedCacheTtl);
	const prevInject = Boolean(config.injectExtendedCacheTtl);
	config.stripExtendedCacheTtl = enabled;
	if (enabled) config.injectExtendedCacheTtl = false;
	logger?.info?.(
		`runtime mode toggled: stripExtendedCacheTtl ${prevStrip} → ${enabled}${
			enabled && prevInject
				? ` (injectExtendedCacheTtl ${prevInject} → false: strip and inject are mutually exclusive)`
				: ""
		}`,
	);
	appendEvent({
		type: "strip-extended-cache-ttl-toggle",
		text: `strip-extended-cache-ttl ${enabled ? "ON" : "OFF"}`,
		meta: {
			stripExtendedCacheTtl: enabled,
			injectExtendedCacheTtl: Boolean(config.injectExtendedCacheTtl),
		},
	});
}

function mobileStatus(config) {
	return {
		mobile: Boolean(config.mobile),
		gzipOutgoing: Boolean(config.gzipOutgoing),
		forceNonStreaming: Boolean(config.forceNonStreaming),
	};
}

/**
 * Mobile is a UI-level bundle: ON forces both sub-knobs on; OFF
 * forces both off. Operators who want individual control can use
 * the sub-knob endpoints (Advanced reveal in the UI).
 */
function applyMobile(enabled, { config, logger }) {
	const prev = Boolean(config.mobile);
	config.mobile = enabled;
	config.gzipOutgoing = enabled;
	config.forceNonStreaming = enabled;
	logger?.info?.(
		`runtime mode toggled: mobile ${prev} → ${enabled} ` +
			`(gzip=${config.gzipOutgoing}, force-non-streaming=${config.forceNonStreaming})`,
	);
	appendEvent({
		type: "mobile-toggle",
		text: `mobile ${enabled ? "ON" : "OFF"}`,
		meta: {
			mobile: enabled,
			gzipOutgoing: config.gzipOutgoing,
			forceNonStreaming: config.forceNonStreaming,
		},
	});
}

function keepAliveExtendedStatus(config) {
	return {
		keepAliveModeExtended: Boolean(config.keepAliveModeExtended),
		passthrough: Boolean(config.passthrough),
	};
}

function applyKeepAliveExtended(enabled, { config, logger }) {
	const prev = Boolean(config.keepAliveModeExtended);
	config.keepAliveModeExtended = enabled;
	logger?.info?.(
		`runtime mode toggled: keepAliveModeExtended ${prev} → ${enabled}`,
	);
	appendEvent({
		type: "keep-alive-extended-toggle",
		text: `keep-alive-extended ${enabled ? "ON" : "OFF"}`,
		meta: { keepAliveModeExtended: enabled },
	});
}

function autoContinueStatus(config) {
	return {
		autoContinue: Boolean(config.autoContinue),
	};
}

function applyAutoContinue(enabled, { config, logger }) {
	const prev = Boolean(config.autoContinue);
	config.autoContinue = enabled;
	logger?.info?.(`runtime mode toggled: autoContinue ${prev} → ${enabled}`);
	appendEvent({
		type: "auto-continue-toggle",
		text: `auto-continue ${enabled ? "ON" : "OFF"}`,
		meta: { autoContinue: enabled },
	});
}

const BASELINE_CAPTURE_DEFAULT_TURNS = 5;
// Default capture mode. `false` = the classic capture: flip passthrough on
// for the window, forfeiting the optimization while we measure. `true` =
// shadow capture: keep the armed knobs on the live/primary path AND fan a
// passthrough copy of each turn out to capture the baseline at the same
// time — at ~2x token cost for the window. Default stays off precisely
// because shadow doubles spend against the user's live quota; the operator
// opts in per capture (UI toggle) or persistently via config.
const BASELINE_CAPTURE_DEFAULT_SHADOW = false;

/**
 * Project the total token cost keep-alive pings will incur from now
 * until the operator's 5-hour quota window resets. The operator can
 * read this off /_proxy/health to see how much of their quota will be
 * consumed by clawback's pings — i.e. the budget they need to leave on
 * the table, on top of whatever Claude Code's statusline reports.
 *
 * Algorithm: for each session with a tracked targetTtl (the upstream
 * `anthropic-ratelimit-tokens-reset` timestamp), estimate
 *   pingsRemaining = msToReset / medianCadenceMs
 * and multiply by the session's observed per-ping token cost. When
 * keepAliveCount > 0 we use the real average; otherwise we fall back
 * to a conservative default (cached prompts dominate ping cost).
 *
 * Returns:
 *   {tokens, pings} per-session aggregate plus a `bySession` map keyed
 *   by session key. tokens=0/pings=0 when keep-alive is off or no
 *   session has a known reset window.
 */
export function projectKeepAliveReserve(
	store,
	config,
	{ now = Date.now() } = {},
) {
	const out = { tokens: 0, pings: 0, bySession: {} };
	if (!config?.keepAliveEnabled || config?.passthrough) return out;
	const extended = Boolean(config.keepAliveModeExtended);
	const minMs = extended
		? (config.keepAliveMinMsExtended ?? 15 * 60_000)
		: (config.keepAliveMinMs ?? 60_000);
	const maxMs = extended
		? (config.keepAliveMaxMsExtended ?? 45 * 60_000)
		: (config.keepAliveMaxMs ?? 240_000);
	const cadenceMs = (minMs + maxMs) / 2;
	if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) return out;
	const sessions = store?.all?.() ?? [];
	for (const s of sessions) {
		if (s.authStale) continue;
		const resetMs = s.targetTtl ? Date.parse(s.targetTtl) : Number.NaN;
		if (!Number.isFinite(resetMs)) continue;
		const msRemaining = resetMs - now;
		if (msRemaining <= 0) continue;
		const pingsRemaining = Math.floor(msRemaining / cadenceMs);
		if (pingsRemaining <= 0) continue;
		// Per-ping cost: cache_read dominates (the ping re-reads the
		// session's cached system+tools). Use observed total cache_read
		// divided by observed ping count when available, otherwise an
		// 8k-token default — typical for a Claude Code system+tools
		// snapshot.
		const observedPings = s.keepAliveCount ?? 0;
		let perPingTokens = 8000;
		if (observedPings > 0) {
			const observedRead = s.cacheReadTokens ?? 0;
			if (observedRead > 0) {
				perPingTokens = Math.max(500, observedRead / observedPings);
			}
		}
		const tokens = Math.round(pingsRemaining * perPingTokens);
		out.bySession[s.key] = { tokens, pings: pingsRemaining, perPingTokens };
		out.tokens += tokens;
		out.pings += pingsRemaining;
	}
	return out;
}

/**
 * Roll the per-session cacheControlInjection counters into a single
 * snapshot. Used by GET /_proxy/health so operators see "is the 1h
 * cache TTL knob actually firing on my real turns" at a glance,
 * without paging through every session.
 *
 * Returns the same shape as the per-session record plus a derived
 * `coverage` ratio (turnsAt1hTier / eligibleTurns) — useful for the
 * deferred `ttl-1h-client-already-cached` suggestion rule once it
 * lands. `coverage` is null when there have been zero eligible turns
 * (avoids a misleading 0% on a fresh proxy).
 */
export function aggregateInjectionCounters(store) {
	const out = {
		eligibleTurns: 0,
		topLevelTurns: 0,
		rewriteTurns: 0,
		alreadyExtendedTurns: 0,
		blocksRewritten: 0,
		nonEphemeralSkipped: 0,
	};
	if (!store || typeof store.all !== "function")
		return { ...out, coverage: null };
	for (const s of store.all()) {
		const inj = s.cacheControlInjection;
		if (!inj) continue;
		out.eligibleTurns += inj.eligibleTurns ?? 0;
		out.topLevelTurns += inj.topLevelTurns ?? 0;
		out.rewriteTurns += inj.rewriteTurns ?? 0;
		out.alreadyExtendedTurns += inj.alreadyExtendedTurns ?? 0;
		out.blocksRewritten += inj.blocksRewritten ?? 0;
		out.nonEphemeralSkipped += inj.nonEphemeralSkipped ?? 0;
	}
	const turnsAt1hTier =
		out.topLevelTurns + out.rewriteTurns + out.alreadyExtendedTurns;
	const coverage =
		out.eligibleTurns > 0 ? turnsAt1hTier / out.eligibleTurns : null;
	return { ...out, turnsAt1hTier, coverage };
}

/**
 * Sum cache token counters across every session in the store. Used to
 * snapshot totals at baseline-capture start/end so the delta gives us
 * the hit rate measured *during* the baseline window — not all-time.
 * Returns {read, create, miss} (zeros if store missing or empty).
 */
function aggregateCacheTokens(store) {
	const out = { read: 0, create: 0, miss: 0 };
	if (!store || typeof store.all !== "function") return out;
	for (const s of store.all()) {
		out.read += s.cacheReadTokens ?? 0;
		out.create += s.cacheCreationTokens ?? 0;
		out.miss += s.cacheMissTokens ?? 0;
	}
	return out;
}

/**
 * Snapshot of the current baseline-capture state for the GUI poll
 * loop. `targetTurns` is constant for an active capture; `turnsRemaining`
 * decrements as the server forwards real /v1/messages requests.
 */
export function captureBaselineStatus(config) {
	const cap = config._baselineCapture ?? {
		active: false,
		turnsRemaining: 0,
		targetTurns: 0,
		startedAt: null,
	};
	return {
		active: Boolean(cap.active),
		turnsRemaining: cap.turnsRemaining | 0,
		targetTurns: cap.targetTurns | 0,
		startedAt: cap.startedAt ?? null,
		// Mode of the ACTIVE capture (false when none is running).
		shadow: Boolean(cap.shadow),
		defaultTurns: config.baselineCaptureTurns ?? BASELINE_CAPTURE_DEFAULT_TURNS,
		// Default the UI toggle should reflect when no capture is running.
		defaultShadow:
			config.baselineCaptureShadow ?? BASELINE_CAPTURE_DEFAULT_SHADOW,
	};
}

/**
 * Begin a baseline-capture run: flip passthrough on and arm a turn
 * counter. Each forwarded /v1/messages (see server.js) decrements
 * `turnsRemaining`; when it hits zero, completeBaselineCapture flips
 * passthrough back off and appends a `baseline-captured` event.
 *
 * Idempotent in spirit — calling it during an active capture restarts
 * the counter (operator can re-arm if their workflow changed).
 */
export function startBaselineCapture(
	config,
	{ store = null, scheduler, logger, shadow, turns } = {},
) {
	const target =
		Number.isFinite(turns) && turns > 0
			? Math.floor(turns)
			: (config.baselineCaptureTurns ?? BASELINE_CAPTURE_DEFAULT_TURNS);
	// Shadow capture keeps the armed knobs ON the live path and fans a
	// passthrough copy of each turn out to capture the baseline in parallel
	// (server.js owns the fan-out). The classic capture instead flips
	// passthrough on for the window. Default follows config, then the
	// constant; an explicit per-capture `shadow` arg wins.
	const useShadow =
		typeof shadow === "boolean"
			? shadow
			: (config.baselineCaptureShadow ?? BASELINE_CAPTURE_DEFAULT_SHADOW);
	// Snapshot pre-baseline cache totals so completeBaselineCapture can
	// compute the delta hit rate over just the baseline window. Stored
	// on the capture record so it survives across multiple ticks even
	// if the store is mutated by other paths. In shadow mode this delta
	// is the ARMED hit rate (the primary path stayed armed); the baseline
	// comes from shadowTotals instead.
	const startTotals = aggregateCacheTokens(store);
	// Record whether THIS capture imposes passthrough. Shadow mode never
	// imposes it (that is the whole point — stay armed). For the classic
	// capture: when the operator already started in passthrough (e.g.
	// `clawback --passthrough`, or the A0 baseline arm), passthrough is THEIR
	// choice, not ours, so we must not turn it off when the window ends.
	// completeBaselineCapture reads this to undo only what we actually did.
	// (CLAUDE.md: passthrough is "not configurable away.")
	const imposedPassthrough = !useShadow && !config.passthrough;
	config._baselineCapture = {
		active: true,
		turnsRemaining: target,
		targetTurns: target,
		startedAt: new Date().toISOString(),
		startTotals,
		imposedPassthrough,
		shadow: useShadow,
		// Per-turn pairSeq counter (shadow only) so the primary + shadow
		// turn-log records share a key the analyzer can pair on.
		pairSeq: 0,
		// Accumulator for the shadow (passthrough-baseline) arm's usage,
		// summed by server.js as each shadow turn completes. Shadow only.
		shadowTotals: useShadow ? { read: 0, create: 0, miss: 0 } : null,
	};
	if (imposedPassthrough) {
		applyPassthrough(true, { config, scheduler, logger });
	}
	appendEvent({
		type: "baseline-capture-start",
		text: `${useShadow ? "shadow " : ""}baseline capture armed — ${target} turn${target === 1 ? "" : "s"}${useShadow ? " (~2x token cost)" : ""}`,
		meta: { turns: target, shadow: useShadow },
	});
}

/**
 * End the active capture: emit a `baseline-captured` event (the
 * suggestion engine reads its timestamp for the 6h cooldown rule)
 * and flip passthrough off so the operator's interventions resume.
 */
export function completeBaselineCapture(
	config,
	{ store = null, scheduler, logger } = {},
) {
	const startedAt = config._baselineCapture?.startedAt ?? null;
	const turns = config._baselineCapture?.targetTurns ?? 0;
	const startTotals = config._baselineCapture?.startTotals ?? null;
	const shadow = Boolean(config._baselineCapture?.shadow);
	const shadowTotals = config._baselineCapture?.shadowTotals ?? null;
	// Only undo passthrough if THIS capture imposed it. An operator who
	// started in passthrough keeps it. Default true preserves the historical
	// restore for any capture armed before this field existed.
	const imposedPassthrough =
		config._baselineCapture?.imposedPassthrough ?? true;
	// Store delta over the window. In CLASSIC mode the primary path was
	// passthrough, so this IS the baseline hit rate. In SHADOW mode the
	// primary stayed armed, so this is the ARMED hit rate; the baseline
	// instead comes from the shadow arm's accumulator. Null when no traffic
	// flowed — the denominator is zero.
	const rate = (read, create, miss) => {
		const total = read + create + miss;
		return total > 0 ? read / total : null;
	};
	let storeHitRate = null;
	if (startTotals) {
		const end = aggregateCacheTokens(store);
		storeHitRate = rate(
			Math.max(0, end.read - startTotals.read),
			Math.max(0, end.create - startTotals.create),
			Math.max(0, end.miss - startTotals.miss),
		);
	}
	const shadowHitRate = shadowTotals
		? rate(shadowTotals.read, shadowTotals.create, shadowTotals.miss)
		: null;
	// Contract preserved for every downstream consumer (suggestion rules:
	// post-baseline-enable-s, regression-vs-baseline, stack-not-helping):
	// meta.hitRate is ALWAYS the no-clawback baseline. armedHitRate is the
	// bonus shadow mode buys — the armed hit rate over the same turns.
	const hitRate = shadow ? shadowHitRate : storeHitRate;
	const armedHitRate = shadow ? storeHitRate : null;
	config._baselineCapture = {
		active: false,
		turnsRemaining: 0,
		targetTurns: 0,
		startedAt: null,
	};
	if (imposedPassthrough && config.passthrough) {
		applyPassthrough(false, { config, scheduler, logger });
	}
	appendEvent({
		type: "baseline-captured",
		text: `${shadow ? "shadow " : ""}baseline captured (${turns} turn${turns === 1 ? "" : "s"})`,
		meta: { startedAt, turns, hitRate, shadow, armedHitRate },
	});
}

/**
 * Decrement-on-turn hook called by server.js after each forwarded
 * /v1/messages. Returns true when the call completed the capture
 * (so the caller can log the transition); false otherwise.
 */
export function tickBaselineCapture(
	config,
	{ store = null, scheduler, logger } = {},
) {
	const cap = config._baselineCapture;
	if (!cap || !cap.active) return false;
	cap.turnsRemaining = Math.max(0, (cap.turnsRemaining | 0) - 1);
	if (cap.turnsRemaining === 0) {
		completeBaselineCapture(config, { store, scheduler, logger });
		return true;
	}
	return false;
}

/**
 * Live mutation of the in-memory config + scheduler to flip passthrough on/off
 * mid-session without restarting the proxy. Used by the admin endpoint and the
 * UI toggle button (PLAN: support an interactive demo flow). Mirrors the
 * boot-time post-merge override in `loadConfig`, but restores the operator's
 * pre-passthrough intent from `_baselineSnapshot` when toggling off.
 */
function applyPassthrough(enabled, { config, scheduler, logger }) {
	config.passthrough = enabled;
	if (enabled) {
		config.injectExtendedCacheTtl = false;
		config.rewriteNestedCacheControl = false;
		config.stripExtendedCacheTtl = false;
		config.stripEphemeralFromSystem = false;
		config.keepAliveEnabled = false;
		// Park auto-continue for the baseline window. An auto-resume
		// fire during the measurement would distort it; restoring from
		// the snapshot on exit gets the operator back to their intent.
		config.autoContinue = false;
		try {
			scheduler?.stop?.();
		} catch (e) {
			logger?.warn?.(
				`scheduler.stop failed during passthrough toggle: ${e.message}`,
			);
		}
	} else {
		const snap = config._baselineSnapshot ?? {};
		config.injectExtendedCacheTtl = snap.injectExtendedCacheTtl ?? true;
		config.rewriteNestedCacheControl = snap.rewriteNestedCacheControl ?? true;
		// Default-false: stripExtendedCacheTtl's DEFAULTS is false, so an
		// absent snapshot field means "operator never turned it on."
		config.stripExtendedCacheTtl = snap.stripExtendedCacheTtl ?? false;
		config.stripEphemeralFromSystem = snap.stripEphemeralFromSystem ?? true;
		config.keepAliveEnabled = snap.keepAliveEnabled ?? true;
		// Default-false (not true) because autoContinue's DEFAULTS is
		// also false; an absent snapshot field means "operator never
		// turned it on," which restores to off rather than on.
		config.autoContinue = snap.autoContinue ?? false;
		if (config.keepAliveEnabled) {
			try {
				scheduler?.start?.();
			} catch (e) {
				logger?.warn?.(
					`scheduler.start failed during passthrough toggle: ${e.message}`,
				);
			}
		}
	}
	logger?.info?.(
		`runtime mode toggled: passthrough=${enabled} ` +
			`(inject=${config.injectExtendedCacheTtl}, strip=${config.stripEphemeralFromSystem}, keepAlive=${config.keepAliveEnabled}, autoContinue=${config.autoContinue})`,
	);
	appendEvent({
		type: "passthrough-toggle",
		text: `passthrough ${enabled ? "ON (baseline)" : "OFF (treatment)"}`,
		meta: {
			injectExtendedCacheTtl: config.injectExtendedCacheTtl,
			stripEphemeralFromSystem: config.stripEphemeralFromSystem,
			keepAliveEnabled: config.keepAliveEnabled,
			autoContinue: config.autoContinue,
		},
	});
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes) throw new Error("body too large");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	return JSON.parse(text);
}

function isWriteMethod(method) {
	return (
		method === "POST" ||
		method === "DELETE" ||
		method === "PATCH" ||
		method === "PUT"
	);
}

// Treat IPv4 loopback, IPv4-mapped-in-IPv6 loopback, and IPv6 loopback as
// "this host." Anything else is on the LAN / WAN and must present the token.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLoopback(req) {
	const addr = req.socket?.remoteAddress;
	return typeof addr === "string" && LOOPBACK_ADDRESSES.has(addr);
}

function parseBearer(authHeader) {
	if (typeof authHeader !== "string") return null;
	const m = authHeader.match(/^Bearer\s+(.+)$/i);
	return m ? m[1].trim() : null;
}

/**
 * CSRF + DNS-rebinding hardening, runs in front of every (non-statusline)
 * admin call. The checks are deliberately layered:
 *
 *   1. Content-Type on write methods must be application/json. Without
 *      this, a browser can fire a cross-origin POST with text/plain
 *      (a CORS "simple request") that skips the preflight entirely.
 *      DELETE is exempt because it carries no body. Always enforced.
 *
 *   2. Host header (when present) must match the network interface the
 *      connection actually came in on. DNS rebinding works by setting up
 *      `attacker.evil` with TTL=0 pointing at a real IP, then re-resolving
 *      to 127.0.0.1 — the browser connects to 127.0.0.1 (so
 *      localAddress=127.0.0.1) but still sends `Host: attacker.evil`.
 *      Comparing Host to localAddress catches this without an allowlist.
 *      Skipped when adminToken is set: the operator has opted into
 *      auth-based security, the token gates writes (cross-origin browsers
 *      can't add a Bearer header without preflight), and remote operators
 *      legitimately need to dial in by hostname (`--remote homelab.local`).
 *
 *   3. Origin header (when present) must match the same allowlist. Same
 *      adminToken-skip rationale as Host.
 *
 * Returns null on success, or {status, body} to respond with on failure.
 */
function assertOriginSafe(req, config) {
	// (1) Content-Type. Run first because it's the cheapest fail and
	// applies regardless of auth posture.
	if (isWriteMethod(req.method) && req.method !== "DELETE") {
		const ct = (req.headers["content-type"] ?? "").toLowerCase();
		if (!ct.startsWith("application/json")) {
			return {
				status: 415,
				body: {
					error: "unsupported_media_type",
					message:
						"write methods require Content-Type: application/json " +
						"(text/plain bodies are rejected to defeat cross-origin " +
						"CSRF that bypasses the CORS preflight)",
				},
			};
		}
	}

	// Token-protected proxies use the bearer as their auth boundary;
	// Host/Origin checks would just break `--remote homelab.local` setups
	// without adding meaningful protection (cross-origin browsers can't
	// add a Bearer header without preflight, and DNS-rebinding has no
	// path to obtain the token).
	if (config?.adminToken) return null;

	const localAddr = normalizeAddr(req.socket?.localAddress);

	// (2) Host header.
	const rawHost = req.headers.host;
	if (rawHost) {
		const host = hostnameOnly(rawHost);
		if (!isAllowedHost(host, localAddr)) {
			return {
				status: 421,
				body: {
					error: "misdirected_request",
					message:
						"Host header does not match the listening interface " +
						"(DNS rebinding suspected). If you're a legitimate caller, " +
						"send a Host header matching the bind address.",
				},
			};
		}
	}

	// (3) Origin header.
	const originHeader = req.headers.origin;
	if (originHeader && originHeader !== "null") {
		let originHost;
		try {
			originHost = new URL(originHeader).hostname.toLowerCase();
		} catch {
			return {
				status: 403,
				body: { error: "forbidden", message: "invalid Origin header" },
			};
		}
		if (!isAllowedHost(originHost, localAddr)) {
			return {
				status: 403,
				body: {
					error: "forbidden",
					message: "cross-origin request rejected",
				},
			};
		}
	}

	return null;
}

function isAllowedHost(host, localAddr) {
	if (!host) return false;
	// Loopback names + 127/8 are always allowed: the "bind to 127.0.0.1
	// but browser hits localhost" case is the dominant operator flow, and
	// these names cannot be reached over the network.
	if (host === "localhost" || host === "127.0.0.1" || host === "::1")
		return true;
	if (host.startsWith("127.")) return true;
	// Match the actual interface address the kernel routed this connection
	// to. Works for the wildcard-bind case too: a request that came in on
	// 192.168.1.5 has localAddress=192.168.1.5, so Host: 192.168.1.5:8080
	// matches. A DNS-rebound request that came in on 127.0.0.1 won't match
	// Host: attacker.evil.
	if (localAddr && host === localAddr) return true;
	return false;
}

function hostnameOnly(rawHost) {
	if (typeof rawHost !== "string") return "";
	const h = rawHost.trim().toLowerCase();
	// IPv6 in brackets: [::1]:8080 → ::1
	if (h.startsWith("[")) {
		const close = h.indexOf("]");
		if (close > 0) return h.slice(1, close);
	}
	// Strip trailing :port (only the last colon — IPv6 without brackets
	// shouldn't appear in a Host header, but if it does we leave it
	// alone and let isAllowedHost reject).
	const lastColon = h.lastIndexOf(":");
	if (lastColon > 0 && h.indexOf(":") === lastColon) {
		return h.slice(0, lastColon);
	}
	return h;
}

function normalizeAddr(addr) {
	if (typeof addr !== "string" || addr.length === 0) return null;
	let a = addr.toLowerCase();
	if (a.startsWith("::ffff:")) a = a.slice(7); // IPv4-mapped IPv6
	const zone = a.indexOf("%"); // IPv6 zone id
	if (zone >= 0) a = a.slice(0, zone);
	return a;
}

// Constant-time compare. Buffer.from is required because timingSafeEqual
// throws on length mismatch; we short-circuit on different lengths so the
// caller doesn't have to handle the exception. The length itself is not
// considered sensitive — a bearer token's length is not a meaningful secret.
function tokenMatches(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string")
		return false;
	const a = Buffer.from(provided, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

// PLAN §37: contract block for cache-aware session-file rewriters (Cozempic
// et al.). Pure-function helper so the shape is unit-testable in isolation.
// The contract is observation-only — clawback exposes the warm-prefix
// high-water mark; the consumer does the file-mutation logic.
function buildCozempicContract(config) {
	const ttlMode = resolvedTtlMode(config);
	const ttlMs = ttlMode === "1h" ? 60 * 60 * 1000 : 5 * 60 * 1000;
	return {
		version: 1,
		ttlMode,
		ttlMs,
		warmUntilFormula:
			"warmUntil ≈ lastObservedAt + ttlMs (upper bound; Anthropic does not " +
			"report true expiry, and cache entries can be LRU-evicted earlier under " +
			"pressure). Apply your own safety buffer before mutating.",
		safePrefixSemantics:
			"safePrefixAssistantMessageId is the msg_id of the most recent turn " +
			"for which Anthropic returned non-zero cache tokens. Records at or " +
			"before that message in the session JSONL are inside the warm prefix " +
			"and MUST NOT be mutated while the cache may still be live. Records " +
			"after that boundary are safe to rewrite (subject to your own " +
			"semantic concerns).",
		uncertaintyNote:
			"PLAN §25 (ping → next-real-request hit stratum) is not yet measured. " +
			"Keep-alive pings may or may not extend the warm window in practice; " +
			"if you have hard guarantees you need, treat this contract as a " +
			"best-effort hint rather than a deadline.",
		stripPatterns: STRIP_PATTERNS.map((p) => p.name),
		stripNote:
			"PLAN §9: when stripEphemeralFromSystem is enabled (default-on), " +
			"clawback applies these regex replacements to the request `system` " +
			"block before forwarding — so the bytes Anthropic hashes for the " +
			"prompt cache do NOT contain volatile per-request tokens (today's " +
			"date, <env>, the rotating billing-cch). A consumer of this " +
			"contract should keep its own session-file rewriting consistent " +
			"with these patterns: if you regenerate any of this content, the " +
			"new bytes need to survive the same strip pass for the cache key " +
			"to remain stable.",
		stripEphemeralEnabled: config?.stripEphemeralFromSystem !== false,
	};
}

function trafficExplanation(turnLogConfigured) {
	const base =
		"Forwarded /v1/messages requests bucketed by classifier 'kind' (PLAN §21). " +
		"'normal' is the default bucket — a large 'normal' share means we still have " +
		"classifying work to do. Confidence is per-rule: 'exact' (URL/structure), " +
		"'heuristic' (pattern), 'stub' (placeholder, currently never matches). " +
		"Keep-alive pings appear as kind='keep-alive'.";
	return turnLogConfigured
		? base
		: `${base} (No --turn-log configured; classification only lands in turn-log records, so this view is empty.)`;
}

function readTurnLogRecords(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return [];
	let raw;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			/* skip malformed line */
		}
	}
	return out;
}
