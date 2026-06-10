import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter } from "./front_matter.js";

export const DEFAULTS = {
	// 127.0.0.1, not 0.0.0.0: clawback persists the captured OAuth bearer
	// in state.json and exposes /_proxy/claude/input (writes keystrokes
	// into the operator's PTY-attached claude). A LAN-reachable default
	// would let any peer on the same network drive the operator's claude.
	// Operators who want LAN/remote access must opt in with --host 0.0.0.0
	// AND set an --admin-token; loadConfig refuses the combination of
	// non-loopback host + unset adminToken (see validate).
	host: "127.0.0.1",
	port: 8080,
	upstream: "https://api.anthropic.com",
	stateFile: "data/state.json",
	keepAliveMinMs: 60_000,
	keepAliveMaxMs: 240_000,
	keepAliveMinMsExtended: 15 * 60_000,
	keepAliveMaxMsExtended: 45 * 60_000,
	// Keep-alive-side fragmentation gate (Option A). The scheduler arms one
	// loop per session key; on the L3 paired run that warmed two junk aux
	// contexts (0B/0B and ~1KB/2B side-channel sessions) alongside the real
	// 28KB/81KB conversation. Anthropic refuses to cache a prefix below its
	// minimum cacheable length (≥1024 *tokens*), so a ping on a sub-threshold
	// prefix writes nothing — pure cost. This floor is in *bytes*, and 1024
	// bytes is mathematically under 1024 tokens (a token is ≥1 byte) on every
	// model, so the default only ever skips a provably-uncacheable prefix — it
	// cannot regress a real context. Operators who observe larger junk aux
	// contexts can raise it (e.g. 4096–8192, still far below any real
	// conversation). 0 disables the gate (every session armed, prior behavior).
	keepAliveMinPrefixBytes: 1024,
	// Cold-ping cancellation (Option A++). The byte floor above is a *guess*
	// (bytes ≠ tokens); this is the *proof*. Anthropic's cache minimum is in
	// tokens (≥1024), so a prefix can clear keepAliveMinPrefixBytes yet still be
	// uncacheable — on the L4 paired run a 446-token aux context did exactly
	// that and took 28 cold pings. After this many *consecutive* fully-cold
	// successful pings (cache_read=0 AND cache_creation=0), Anthropic has proven
	// the prefix uncacheable, so the scheduler latches it and stops pinging. A
	// genuinely cacheable prefix writes cache_creation>0 on its first ping, so
	// its streak never reaches the floor — this never cancels a real loop. 2
	// (not 1) tolerates a lone transient cold read before giving up. 0 disables.
	keepAliveColdPingMax: 2,
	gracePeriodMs: 5 * 60 * 60 * 1000,
	// Session lifecycle GC. Inactivity-based expiry covers the gap when
	// the upstream doesn't send `anthropic-ratelimit-tokens-reset`
	// (observed: most production sessions). Without it, abandoned
	// sessions — especially authStale ones whose per-session timers are
	// cancelled — would accumulate in state.json indefinitely.
	sessionMaxIdleMs: 12 * 60 * 60 * 1000,
	// Dead-session fast-path. An authStale session (keep-alive already got a
	// 401 and paused its timer) warms nothing, so it's reaped well before the
	// general sessionMaxIdleMs. 6h ≈ Anthropic's ~5h session rate-limit reset
	// plus a buffer, so a session merely waiting out a limit still has time to
	// resume before it's purged. 0 disables the fast-path.
	deadSessionMaxIdleMs: 6 * 60 * 60 * 1000,
	gcSweepIntervalMs: 5 * 60 * 1000,
	logLevel: "info",
	requestTimeoutMs: 10 * 60 * 1000,
	keepAliveTimeoutMs: 30_000,
	injectExtendedCacheTtl: true,
	// When `injectExtendedCacheTtl` is on, also rewrite per-block
	// `cache_control: {type:"ephemeral"}` inside system/tools/messages to
	// `ttl: "1h"`. Without this, the headline 1h knob is silently a no-op
	// for Claude Code (the dominant client sets per-block cache_control on
	// every turn, so the top-level injection got skipped). Default on;
	// operator escape hatch if Anthropic ever regresses on the rewrite.
	rewriteNestedCacheControl: true,
	// Inverse of injectExtendedCacheTtl: strip the client's own `ttl:"1h"`
	// ephemeral cache_control back to Anthropic's documented 5m default
	// (delete the `ttl` key). Motivated by the finding that Claude Code
	// natively breakpoints its system prompt at 1h (undocumented) — so a
	// Claude Code operator never gets the 5m tier unless something downgrades
	// it. On a TIGHT loop the 1h write premium buys nothing (every read lands
	// inside 5m), and enforcing 5m is also an anti-regression lever: the
	// operator picks the TTL tier deterministically instead of inheriting the
	// client's silent choice. Strip WINS over inject (early return in
	// injectIntoBody) so flipping both on yields 5m. Default off — the 1h
	// region pays back across 5–60min idle gaps, so we don't downgrade by
	// default. thinking/redacted_thinking blocks are never touched (their
	// signature must return byte-identical, same guard as the inject path).
	stripExtendedCacheTtl: false,
	keepAliveModeExtended: false,
	passthrough: false,
	keepAliveEnabled: true,
	turnLogFile: "data/turns.ndjson",
	adminPathPrefix: "_proxy",
	logFile: null,
	sessionLogDir: "logs",
	// Directory the /<adminPathPrefix>/report viewer reads completed
	// benchmark runs from (one subdir per run, each holding summary.json +
	// report.csv + charts/*.svg as written by benchmark/bin/analyze.js +
	// plot.js). Read-only and served fully public (no token) so a saved run
	// can be linked and inspected from a browser — see src/report.js. The
	// viewer never computes cost; it renders what the analyzer already
	// priced. Settable via --report-dir.
	reportDir: "runs",
	stripEphemeralFromSystem: true,
	// Test-harness knob (null = off; never set in normal operation).
	// `captureBodyPath`: dump the first real /v1/messages body (pristine,
	// pre-mutation bytes) to this file, then stop — produces a faithful
	// replay fixture with Claude Code's exact cache_control breakpoints
	// (synthetic hand-authored bodies make 1h-TTL look like a no-op). It is
	// read-only: capture happens BEFORE any mutation and never changes the
	// bytes we forward, so it cannot confound a measurement. Exercised only
	// by the benchmark/ harness (see .skills/capture).
	captureBodyPath: null,
	autoContinue: false,
	// `\r` (carriage return) is what a real Enter keypress sends into
	// a PTY's slave end. Claude Code's interactive TUI reads raw bytes
	// from stdin (no line-canonical translation), so `\n` is treated
	// as just another text character rather than a submit. CR works
	// the way a human pressing Enter would.
	autoContinueText: "continue\r",
	autoContinueCooldownMs: 5 * 60 * 1000,
	upstreamFromEnv: false,
	mobile: false,
	gzipOutgoing: false,
	forceNonStreaming: false,
	statuslinePrefix: "",
	// 160 chars accommodates the worst-case render (every percentage at
	// 100%, tps at 3 digits) with 8-cell progress bars across 5 fields.
	// Earlier 120 was tight when bars were 4 cells; with 8-cell bars +
	// 5 progress fields the worst case is 132 chars.
	statuslineMaxChars: 160,
	statuslineProgressBarLength: 8,
	// Plan-quota windows (five_hour "quota" / seven_day "week") are
	// account-global, not per-session: a session's statusline payload only
	// carries the quota its own last API call saw, so an idle session reports
	// a stale value. When on (default), clawback records every statusline
	// POST's quota into an account-global store and renders every session
	// from that shared, freshest value (PLAN §12.2). Set false to render the
	// strict per-session value instead — the escape hatch for an operator
	// running >1 Anthropic account through one proxy, until multi-account
	// attribution lands (PLAN §23).
	accountGlobalQuota: true,
	// "auto" → resolve at runtime (honor NO_COLOR env, then check
	// process.stdout.isTTY). "on"/"off" force the choice.
	statuslineColor: "auto",
	// Color-ramp thresholds. Three pairs, each expressed as the boundaries
	// of the WARN (yellow) band:
	//   - pct: any percentage field (context/day/week use the high-bad
	//     direction; hit/turn invert). 50/80 puts the operator in green
	//     during normal operation, yellow as quotas tighten, red when
	//     they're about to bite.
	//   - ttft: TTFT in ms, lower = better. This is clawback's clearest
	//     cache-warmth signal — a warm prompt-cache hit returns the first
	//     token fast, a cold miss is slow. The statusline no longer renders
	//     a ttft field (its slot carries the brand chip, operator-requested
	//     2026-06-09); this pair now colors the web UI's ttft chart bands
	//     only (ui/app.js reads it from /_proxy/health). Band: <3000ms
	//     green ("warm"), 3000-5000ms yellow, ≥5000ms red ("cold or
	//     upstream unhappy"). Operator-tuned 2026-06-01 (widened from a
	//     fixed 2000 low so warm Opus sessions stop reading yellow).
	//   - tps: tokens-per-second, higher = better. Post-TTFT decode rate is
	//     mostly a model constant — Opus ~30-60, Sonnet ~80-130, Haiku
	//     ~150-250 — so any single absolute pair paints one model class
	//     all-green and another all-red. We default to RELATIVE calibration
	//     (see statuslineTpsCalibration below), which derives low = peak/6
	//     and high = peak/2 from the session's recentTps ring (3:2:1 band
	//     ratio over the observed range). The absolute pair below is used
	//     when statuslineTpsCalibration === "absolute" and as the bootstrap
	//     fallback before the ring has enough samples. Window 15/40 is
	//     anchored on Opus (~30-60, the common interactive case) so fresh
	//     sessions don't read red before the ring calibrates; raise it for a
	//     faster default model or pin "absolute" with a custom pair.
	//     Operator-tuned 2026-06-01 (was 25/100, which left Opus bootstrap
	//     stuck red).
	// Setting low === high collapses to a binary good/bad split (no
	// yellow band); validate enforces low <= high.
	statuslinePctThresholdLow: 50,
	statuslinePctThresholdHigh: 80,
	statuslineTtftThresholdLowMs: 3000,
	statuslineTtftThresholdHighMs: 5000,
	statuslineTpsThresholdLow: 15,
	statuslineTpsThresholdHigh: 40,
	// "relative" (default) → derive TPS color thresholds from the session's
	// own recentTps ring (low = peak/6, high = peak/2) so colors mean
	// "fast/slow for this model" rather than "fast/slow in absolute terms."
	// Falls back to the absolute pair above when the ring has fewer than
	// 4 finite samples (fresh session bootstrap). "absolute" → always use
	// the statuslineTpsThresholdLow/High pair, ignoring the ring.
	statuslineTpsCalibration: "relative",
	// Optional shared-secret bearer for write requests against /<adminPathPrefix>/*.
	// When non-empty, POST/DELETE/PATCH/PUT must carry `Authorization: Bearer <token>`
	// unless the request originates from loopback (127.0.0.1, ::1, ::ffff:127.0.0.1).
	// GETs stay open. Default null = no auth required (back-compat with the
	// historical loopback-only deployment model).
	//
	// Settable via:
	//   - CLI:    --admin-token <s>
	//   - file:   `adminToken: "<s>"` in CLAWBACK.md front matter (warn: secret in cleartext)
	//   - env:    CLAWBACK_ADMIN_TOKEN=<s> (slots between file and CLI)
	adminToken: null,
	// TLS / HTTPS. When `tls` is true, clawback serves HTTPS on `port`,
	// and same-port HTTP requests are 308-redirected to the https:// URL.
	// `tlsCertFile` / `tlsKeyFile` must point at PEM files; clawback does
	// not auto-mint at runtime (see `clawback init-cert` for the one-shot
	// generator). Default null means "look at the default cert dir";
	// see resolveTlsPaths in src/tls_paths.js.
	tls: false,
	tlsCertFile: null,
	tlsKeyFile: null,
	// When `tls` is on (explicitly or via the open-network auto-enable)
	// but no cert/key exists at the resolved paths, `selfSign: true`
	// makes clawback mint a self-signed pair at startup instead of
	// refusing to launch. Off by default: generating crypto material is
	// a side effect the operator should opt into. Settable via
	// `--self-sign`. Clients still have to trust the self-signed CA
	// (NODE_EXTRA_CA_CERTS); `clawback claude` wires that automatically,
	// but a bare client on another host does not.
	selfSign: false,
	// Optional persistent remote-proxy URL. When set, `clawback claude`
	// and `clawback setup claude` treat it as if the operator had typed
	// `--remote <url>` on every invocation: the local probe + in-process
	// proxy are skipped, the spawned claude is pointed at the remote,
	// and the statusline command's default fallback bakes in the same
	// URL. The CLI `--remote <url>` flag still wins per-invocation; the
	// config layer is for the common case of "I always want my laptop
	// to talk to my dev-box clawback." TLS trust and admin tokens are
	// the operator's problem on the remote path (same constraint as the
	// CLI flag — set NODE_EXTRA_CA_CERTS if the remote uses a self-
	// signed cert; adminToken still flows from the local config / env).
	// Layered like every other knob: DEFAULTS < global < local-auto <
	// local-explicit < CLI. `clawback remote <url>` is the operator-
	// facing shortcut that writes this field into the chosen config.
	remoteUrl: null,
};

export const AUTO_DISCOVERED_CONFIG_NAME = "CLAWBACK.md";
export const GLOBAL_CONFIG_SUBPATH = path.join("clawback", "CLAWBACK.md");

/**
 * Resolve config file sources in precedence order.
 *
 * Precedence (lowest → highest):
 *   1. DEFAULTS
 *   2. Global config:   ${XDG_CONFIG_HOME:-$HOME/.config}/clawback/CLAWBACK.md
 *   3. Local config:    ./CLAWBACK.md (auto-discovered) OR explicit --config <path>
 *   4. CLI overrides
 *
 * Explicit --config <path> replaces the local-auto slot but does not suppress
 * the global file. Each layer that exists on disk merges over the one below.
 *
 * Returns: { config, sources }
 *   sources: [{ tier, path }, ...] in the order they were merged.
 *     tier ∈ "global" | "local-auto" | "local-explicit"
 */
export function loadConfig({
	configPath = null,
	cliOverrides = {},
	cwd = null,
	env = null,
	logger = null,
} = {}) {
	const resolvedEnv = env ?? process.env;
	const sources = [];
	const layers = [];
	const warnings = [];

	const globalPath = resolveGlobalConfigPath(resolvedEnv);
	if (globalPath && fs.existsSync(globalPath)) {
		const parsed = parseFrontMatter(fs.readFileSync(globalPath, "utf8")).data;
		layers.push(parsed);
		sources.push({ tier: "global", path: globalPath });
		if (parsed && typeof parsed === "object" && parsed.adminToken) {
			const w = warnIfWorldReadable(globalPath, "global");
			if (w) warnings.push(w);
		}
	}

	if (configPath) {
		const abs = path.resolve(configPath);
		const parsed = parseFrontMatter(fs.readFileSync(abs, "utf8")).data;
		layers.push(parsed);
		sources.push({ tier: "local-explicit", path: abs });
		if (parsed && typeof parsed === "object" && parsed.adminToken) {
			const w = warnIfWorldReadable(abs, "local-explicit");
			if (w) warnings.push(w);
		}
	} else if (cwd) {
		const candidate = path.join(cwd, AUTO_DISCOVERED_CONFIG_NAME);
		if (fs.existsSync(candidate)) {
			const parsed = parseFrontMatter(fs.readFileSync(candidate, "utf8")).data;
			layers.push(parsed);
			sources.push({ tier: "local-auto", path: candidate });
			if (parsed && typeof parsed === "object" && parsed.adminToken) {
				const w = warnIfWorldReadable(candidate, "local-auto");
				if (w) warnings.push(w);
			}
		}
	}

	// Layer order:
	//   DEFAULTS < (global, local) < bundles (mobile soft-expansion) <
	//   cliOverrides < passthrough hard-override.
	//
	// Bundles (mobile, passthrough) sit between layered config and CLI so
	// that `--mobile --gzip-outgoing off` lets the operator override a
	// sub-knob the bundle would otherwise turn on. passthrough is the
	// exception: it's a *hard* bundle ("force everything off"), applied
	// after CLI so it wins.
	const layered = Object.assign({}, DEFAULTS, ...layers);

	// Opt-in env capture happens at the layered level so file/global config
	// can also enable it. CLI `--upstream` still wins below.
	const wantsEnvCapture =
		cliOverrides.upstreamFromEnv === true || layered.upstreamFromEnv === true;
	const envUrl = resolvedEnv?.ANTHROPIC_BASE_URL;
	if (
		wantsEnvCapture &&
		envUrl &&
		envUrl.length > 0 &&
		!cliOverrides.upstream
	) {
		layered.upstream = envUrl;
		sources.push({ tier: "env", path: "ANTHROPIC_BASE_URL" });
	}

	// Admin-token env var. Always-on (no opt-in flag) because the natural
	// idiom for secrets is `CLAWBACK_ADMIN_TOKEN=… clawback`. Env beats
	// file but CLI still wins.
	const envToken = resolvedEnv?.CLAWBACK_ADMIN_TOKEN;
	if (envToken && envToken.length > 0 && !cliOverrides.adminToken) {
		layered.adminToken = envToken;
		sources.push({ tier: "env", path: "CLAWBACK_ADMIN_TOKEN" });
	}

	// Soft bundle: mobile expands its sub-knobs at the layered level if
	// neither layered nor CLI explicitly set them. This means `--mobile`
	// alone turns both on, but `--mobile --gzip-outgoing off` respects the
	// CLI off because cliOverrides is merged after.
	const effectiveMobile =
		cliOverrides.mobile === true || layered.mobile === true;
	if (effectiveMobile) {
		if (layered.gzipOutgoing === false) layered.gzipOutgoing = true;
		if (layered.forceNonStreaming === false) layered.forceNonStreaming = true;
	}

	const merged = Object.assign({}, layered, cliOverrides);

	// Open-network default: a non-loopback bind faces a wire where the
	// admin bearer token AND the captured OAuth credentials would
	// otherwise cross in cleartext. If the operator never explicitly
	// chose a `tls` setting (in any config layer or on the CLI), default
	// it on. An explicit `--tls off` / `"tls": false` still escapes —
	// the legitimate case is TLS terminated by an upstream load balancer
	// or reverse proxy. This mirrors the bind-safety gate in validate():
	// wide binds get safer defaults, not hard mandates. `_tlsAutoEnabled`
	// lets start() explain *why* TLS came on (and shapes the missing-cert
	// error in provisionTlsCert).
	const tlsExplicit =
		Object.hasOwn(cliOverrides, "tls") ||
		layers.some((l) => l && typeof l === "object" && Object.hasOwn(l, "tls"));
	if (!tlsExplicit && merged.tls !== true && !isLoopbackBind(merged.host)) {
		merged.tls = true;
		merged._tlsAutoEnabled = true;
	}

	// When TLS is on but the operator hasn't pointed at a cert/key explicitly,
	// fall back to the default-cert dir (where `clawback init-cert` writes).
	// Done after CLI merge (and after the open-network auto-enable above) so
	// any layer (file, CLI) — or the auto-enable — can opt into TLS and still
	// pick up the default paths without restating them.
	if (merged.tls === true && (!merged.tlsCertFile || !merged.tlsKeyFile)) {
		const { cert, key } = resolveDefaultTlsPaths(resolvedEnv);
		if (!merged.tlsCertFile) merged.tlsCertFile = cert;
		if (!merged.tlsKeyFile) merged.tlsKeyFile = key;
	}

	// Snapshot post-merge but pre-passthrough state so the runtime
	// passthrough toggle (admin endpoint + UI button) can restore the
	// operator's intent when flipped back off mid-session.
	merged._baselineSnapshot = {
		injectExtendedCacheTtl: merged.injectExtendedCacheTtl,
		rewriteNestedCacheControl: merged.rewriteNestedCacheControl,
		stripExtendedCacheTtl: merged.stripExtendedCacheTtl,
		stripEphemeralFromSystem: merged.stripEphemeralFromSystem,
		keepAliveEnabled: merged.keepAliveEnabled,
		gzipOutgoing: merged.gzipOutgoing,
		forceNonStreaming: merged.forceNonStreaming,
		autoContinue: merged.autoContinue,
	};

	// Hard bundle: passthrough forces every clawback intervention off so
	// the baseline arm is honest. Mirrors the design: anyone who can flip
	// passthrough can flip the sub-knobs too. `rewriteNestedCacheControl`
	// is a no-op when `injectExtendedCacheTtl` is off so technically we
	// don't have to clear it — but doing so keeps the snapshot/restore
	// symmetry simple. `autoContinue` is also forced off: an auto-resume
	// firing inside the baseline window would distort the measurement
	// (extra traffic, extra cache reads), and the operator-visible card
	// that used to suggest manually toggling it was self-defeating — the
	// toggle itself counted as activity in the window. Better to park it
	// silently and restore from the snapshot when exiting passthrough.
	if (merged.passthrough) {
		merged.injectExtendedCacheTtl = false;
		merged.rewriteNestedCacheControl = false;
		merged.stripExtendedCacheTtl = false;
		merged.stripEphemeralFromSystem = false;
		merged.keepAliveEnabled = false;
		merged.autoContinue = false;
	}
	validate(merged);
	if (logger && warnings.length) {
		for (const w of warnings) logger.warn?.(w);
	}
	return { config: merged, sources, warnings };
}

/**
 * Return a warning string if `filePath` contains an `adminToken` and is
 * group- or world-readable (mode bits beyond owner). Caller decides
 * whether to log/throw — we just produce the message so loadConfig can
 * be called from contexts (tests) where logger is absent.
 *
 * Skipped on Windows: NTFS permissions don't map cleanly to POSIX bits,
 * and Node's reported mode there is mostly cosmetic.
 */
function warnIfWorldReadable(filePath, tier) {
	if (process.platform === "win32") return null;
	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return null;
	}
	const mode = stat.mode & 0o777;
	// Any group or other read/write/execute bit makes the file readable
	// by another local user (or another process running as a different
	// uid). Strict 0600 / 0400 (owner-only) is the only safe posture for
	// a file containing the admin shared secret.
	if (mode & 0o077) {
		const octal = mode.toString(8).padStart(3, "0");
		return `${tier} config at ${filePath} contains adminToken but is mode ${octal}; any process on this host can read the secret. Run \`chmod 600 ${filePath}\` to lock it down.`;
	}
	return null;
}

export function resolveGlobalConfigPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const base = xdg?.length ? xdg : path.join(env.HOME ?? "", ".config");
	if (!base) return null;
	return path.join(base, GLOBAL_CONFIG_SUBPATH);
}

/**
 * Default cert/key paths used when `tls: true` and no explicit paths are
 * supplied. Mirrors `clawback init-cert`'s output directory. Kept here (not
 * in `src/init_cert.js`) so `loadConfig` doesn't pull in the openssl
 * shell-out module — config validation must stay side-effect-free.
 */
export function resolveDefaultTlsPaths(env = process.env) {
	const xdg = env.XDG_DATA_HOME;
	const base = xdg?.length ? xdg : path.join(env.HOME ?? "", ".local", "share");
	const dir = path.join(base, "clawback");
	return {
		dir,
		cert: path.join(dir, "cert.pem"),
		key: path.join(dir, "key.pem"),
	};
}

// Bind addresses we consider "this host only." Wildcards (0.0.0.0, ::)
// are NOT loopback — they accept connections from any interface.
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackBind(host) {
	if (typeof host !== "string") return false;
	if (LOOPBACK_BIND_HOSTS.has(host)) return true;
	// 127.0.0.0/8 is all loopback per RFC 1122.
	if (host.startsWith("127.")) return true;
	return false;
}

function validate(c) {
	if (!Number.isInteger(c.port) || c.port <= 0 || c.port > 65535) {
		throw new Error(`invalid port: ${c.port}`);
	}
	// LAN/WAN-reachable bind without an admin token would let any peer
	// drive the operator's claude (POST /_proxy/claude/input) and read
	// the captured session data. Force the operator to opt in by setting
	// an admin token at the same time as opening the bind.
	if (!isLoopbackBind(c.host) && !c.adminToken) {
		throw new Error(
			`host=${JSON.stringify(c.host)} binds beyond loopback but adminToken is unset. Either keep host on 127.0.0.1, or set --admin-token <secret> (also accepted via CLAWBACK_ADMIN_TOKEN env). clawback exposes write endpoints (e.g. /_proxy/claude/input) that would otherwise be reachable unauthenticated from your LAN.`,
		);
	}
	if (c.keepAliveMinMs > c.keepAliveMaxMs) {
		throw new Error("keepAliveMinMs must be <= keepAliveMaxMs");
	}
	if (c.keepAliveMinMsExtended > c.keepAliveMaxMsExtended) {
		throw new Error("keepAliveMinMsExtended must be <= keepAliveMaxMsExtended");
	}
	if (c.sessionMaxIdleMs < 0) {
		throw new Error("sessionMaxIdleMs must be >= 0");
	}
	if (c.deadSessionMaxIdleMs < 0) {
		throw new Error("deadSessionMaxIdleMs must be >= 0");
	}
	if (c.gcSweepIntervalMs < 0) {
		throw new Error("gcSweepIntervalMs must be >= 0");
	}
	if (c.keepAliveMinPrefixBytes < 0) {
		throw new Error("keepAliveMinPrefixBytes must be >= 0");
	}
	if (!Number.isInteger(c.keepAliveColdPingMax) || c.keepAliveColdPingMax < 0) {
		throw new Error("keepAliveColdPingMax must be an integer >= 0");
	}
	if (
		!Number.isInteger(c.statuslineProgressBarLength) ||
		c.statuslineProgressBarLength <= 0
	) {
		throw new Error(
			`statuslineProgressBarLength must be a positive integer (got ${c.statuslineProgressBarLength})`,
		);
	}
	if (
		typeof c.statuslineColor !== "string" ||
		!["auto", "on", "off"].includes(c.statuslineColor)
	) {
		throw new Error(
			`invalid statuslineColor: ${JSON.stringify(c.statuslineColor)} (must be "auto" | "on" | "off")`,
		);
	}
	const validatePctThreshold = (name, v) => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
			throw new Error(`${name} must be a number in [0, 100] (got ${v})`);
		}
	};
	const validateNonNegThreshold = (name, v) => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
			throw new Error(`${name} must be a non-negative number (got ${v})`);
		}
	};
	validatePctThreshold(
		"statuslinePctThresholdLow",
		c.statuslinePctThresholdLow,
	);
	validatePctThreshold(
		"statuslinePctThresholdHigh",
		c.statuslinePctThresholdHigh,
	);
	if (c.statuslinePctThresholdLow > c.statuslinePctThresholdHigh) {
		throw new Error(
			`statuslinePctThresholdLow (${c.statuslinePctThresholdLow}) must be <= statuslinePctThresholdHigh (${c.statuslinePctThresholdHigh})`,
		);
	}
	validateNonNegThreshold(
		"statuslineTtftThresholdLowMs",
		c.statuslineTtftThresholdLowMs,
	);
	validateNonNegThreshold(
		"statuslineTtftThresholdHighMs",
		c.statuslineTtftThresholdHighMs,
	);
	if (c.statuslineTtftThresholdLowMs > c.statuslineTtftThresholdHighMs) {
		throw new Error(
			`statuslineTtftThresholdLowMs (${c.statuslineTtftThresholdLowMs}) must be <= statuslineTtftThresholdHighMs (${c.statuslineTtftThresholdHighMs})`,
		);
	}
	validateNonNegThreshold(
		"statuslineTpsThresholdLow",
		c.statuslineTpsThresholdLow,
	);
	validateNonNegThreshold(
		"statuslineTpsThresholdHigh",
		c.statuslineTpsThresholdHigh,
	);
	if (c.statuslineTpsThresholdLow > c.statuslineTpsThresholdHigh) {
		throw new Error(
			`statuslineTpsThresholdLow (${c.statuslineTpsThresholdLow}) must be <= statuslineTpsThresholdHigh (${c.statuslineTpsThresholdHigh})`,
		);
	}
	if (
		typeof c.statuslineTpsCalibration !== "string" ||
		!["relative", "absolute"].includes(c.statuslineTpsCalibration)
	) {
		throw new Error(
			`invalid statuslineTpsCalibration: ${JSON.stringify(c.statuslineTpsCalibration)} (must be "relative" | "absolute")`,
		);
	}
	if (
		typeof c.adminPathPrefix !== "string" ||
		c.adminPathPrefix.length === 0 ||
		c.adminPathPrefix.includes("/") ||
		c.adminPathPrefix === "v1"
	) {
		throw new Error(
			`invalid adminPathPrefix: ${JSON.stringify(c.adminPathPrefix)} (must be non-empty, no slashes, not "v1")`,
		);
	}
	if (typeof c.reportDir !== "string" || c.reportDir.trim() === "") {
		throw new Error(
			`invalid reportDir: ${JSON.stringify(c.reportDir)} (must be a non-empty path)`,
		);
	}
	if (c.tls === true) {
		if (typeof c.tlsCertFile !== "string" || !c.tlsCertFile) {
			throw new Error(
				"tls=true but tlsCertFile is unset. Run `clawback init-cert` or pass --tls-cert <path>.",
			);
		}
		if (typeof c.tlsKeyFile !== "string" || !c.tlsKeyFile) {
			throw new Error(
				"tls=true but tlsKeyFile is unset. Run `clawback init-cert` or pass --tls-key <path>.",
			);
		}
	}
	try {
		const u = new URL(c.upstream);
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			throw new Error(`unsupported upstream protocol: ${u.protocol}`);
		}
	} catch (e) {
		throw new Error(`invalid upstream URL: ${c.upstream} (${e.message})`);
	}
	// `remoteUrl` is optional; null/undefined means "no persistent
	// remote, behave like a stock local proxy install." If set, it has
	// to be a well-formed http(s) URL — same shape we accept for the
	// per-invocation `--remote` flag (see normalizeRemoteUrl in
	// src/launch_claude.js). Validating here catches typos at config
	// load time, before the operator's `clawback claude` invocation
	// tries to spawn a child against a bogus URL.
	if (c.remoteUrl != null) {
		if (typeof c.remoteUrl !== "string" || c.remoteUrl.trim() === "") {
			throw new Error(
				`remoteUrl must be a non-empty string or null (got ${JSON.stringify(c.remoteUrl)})`,
			);
		}
		let parsed;
		try {
			parsed = new URL(c.remoteUrl);
		} catch (e) {
			throw new Error(`invalid remoteUrl: ${c.remoteUrl} (${e.message})`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(
				`remoteUrl must be http:// or https://, got: ${parsed.protocol}`,
			);
		}
	}
}
