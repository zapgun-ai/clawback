---
host: "0.0.0.0"
port: 8080
upstream: "https://api.anthropic.com"
stateFile: "data/state.json"
keepAliveMinMs: 60000
keepAliveMaxMs: 240000
keepAliveMinMsExtended: 900000
keepAliveMaxMsExtended: 2700000
keepAliveMinPrefixBytes: 1024
gracePeriodMs: 18000000
sessionMaxIdleMs: 43200000
deadSessionMaxIdleMs: 21600000
gcSweepIntervalMs: 300000
logLevel: "info"
requestTimeoutMs: 600000
keepAliveTimeoutMs: 30000
injectExtendedCacheTtl: true
rewriteNestedCacheControl: true
stripExtendedCacheTtl: false
keepAliveModeExtended: false
passthrough: false
keepAliveEnabled: true
turnLogFile: "data/turns.ndjson"
adminPathPrefix: "_proxy"
logFile: null
sessionLogDir: "logs"
reportDir: "runs"
stripEphemeralFromSystem: true
captureBodyPath: null
autoContinue: false
autoContinueText: "continue\r"
autoContinueCooldownMs: 300000
upstreamFromEnv: false
mobile: false
gzipOutgoing: false
forceNonStreaming: false
statuslinePrefix: ""
statuslineMaxChars: 160
statuslineProgressBarLength: 8
accountGlobalQuota: true
statuslineColor: "auto"
statuslinePctThresholdLow: 50
statuslinePctThresholdHigh: 80
statuslineTtftThresholdLowMs: 3000
statuslineTtftThresholdHighMs: 5000
statuslineTpsThresholdLow: 15
statuslineTpsThresholdHigh: 40
statuslineTpsCalibration: "relative"
adminToken: null
tls: true
tlsCertFile: null
tlsKeyFile: null
selfSign: false
remoteUrl: null
---

# CLAWBACK.md — configuration reference

This file is a clawback config. clawback reads **only the YAML front matter**
above (the `--- … ---` block); everything below is documentation for you and is
ignored by the proxy.

Front matter is a **flat map of scalars** — string, number, boolean, or null.
No nesting, no arrays. Strings are emitted double-quoted; `null` means "unset".

**Layering (lowest → highest precedence):**
`DEFAULTS` (src/config.js) < global `~/.config/clawback/CLAWBACK.md` <
local-auto `./CLAWBACK.md` < `--config <path>` < CLI flags. Each layer is a
shallow merge over the one below; the last writer of a given key wins.

This file lists **every** option at its default value, except three set for a
LAN-reachable bind: `host`, `adminToken`, and `tls` (see the security note).

---

## Security note: this file holds a secret

`adminToken` is a shared secret that fronts your live Anthropic credentials.
Keep this file **mode 0600** (owner-only) and **git-ignored**. clawback warns at
startup if it finds an `adminToken` in a group/other-readable file.

Binding `host` beyond loopback (e.g. `0.0.0.0`) exposes write endpoints like
`/_proxy/claude/input` (which types into your attached `claude`). clawback
therefore **refuses** a non-loopback bind unless `adminToken` is set, and (unless
you set `tls` explicitly) **auto-enables TLS** so the bearer token and captured
OAuth credentials don't cross the wire in cleartext. Writing `tls: false` here
would *suppress* that auto-enable — hence `tls: true` is set explicitly rather
than left at its package default of `false` (which assumes a loopback bind).

---

## Network & bind

- **host** (default `"127.0.0.1"`; here `"0.0.0.0"`) — interface to bind.
  `"127.0.0.1"` / `"::1"` / `"localhost"` / any `127.0.0.0/8` = loopback only.
  `"0.0.0.0"` = all IPv4 interfaces (LAN/remote-reachable). Non-loopback
  **requires** `adminToken` and auto-enables `tls`.
- **port** (default `8080`) — TCP port. Integer in `1..65535`.
- **upstream** (default `"https://api.anthropic.com"`) — Anthropic API base.
  Must be an `http://` or `https://` URL, and must not point back at clawback
  (self-loop guard).
- **remoteUrl** (default `null`) — persistent remote clawback URL. When set,
  `clawback claude` / `clawback setup claude` behave as if `--remote <url>` were
  passed every time. `null` = stock local proxy. Must be `null` or an http(s) URL.

## TLS / HTTPS

- **tls** (default `false`; here `true`) — serve HTTPS on `port`; same-port HTTP
  is 308-redirected to `https://`. Auto-enabled for a non-loopback `host` unless
  set explicitly in any layer.
- **tlsCertFile** (default `null`) — PEM certificate path. `null` + `tls: true`
  → default `${XDG_DATA_HOME:-$HOME/.local/share}/clawback/cert.pem`.
- **tlsKeyFile** (default `null`) — PEM private-key path. `null` + `tls: true`
  → default `…/clawback/key.pem`.
- **selfSign** (default `false`) — when `tls` is on and no cert/key exists at the
  resolved paths, mint a self-signed pair at startup instead of refusing to
  launch. Off = opt in to that side effect. (`clawback init-cert` is the explicit
  one-shot generator.)
- **adminToken** (default `null`; here set) — shared-secret bearer required on
  write requests (POST/DELETE/PATCH/PUT) to `/<adminPathPrefix>/*`, except from
  loopback. GETs stay open. Required for a non-loopback bind. Also settable via
  `--admin-token <s>` or `CLAWBACK_ADMIN_TOKEN=<s>` (env beats file; CLI beats env).

## State & files

- **stateFile** (default `"data/state.json"`) — session store; persists the
  captured OAuth bearer. Path relative to the launch dir.
- **turnLogFile** (default `"data/turns.ndjson"`) — append-only per-turn usage log.
- **sessionLogDir** (default `"logs"`) — per-session raw request/response logs.
- **reportDir** (default `"runs"`) — directory the `/<adminPathPrefix>/report`
  viewer reads completed benchmark runs from. Must be a non-empty path.
- **logFile** (default `null`) — mirror logs to this file. `null` = stdout only.
- **logLevel** (default `"info"`) — verbosity. Conventionally `debug` / `info` /
  `warn` / `error` (not enum-validated).
- **captureBodyPath** (default `null`) — **test-harness only.** Dumps the first
  pristine `/v1/messages` body to this path, then stops capturing. Leave `null`
  in normal operation.

## Keep-alive (prompt-cache warming)

- **keepAliveEnabled** (default `true`) — master switch for the background pings
  that keep your `system` + `tools` prefix warm in Anthropic's prompt cache.
- **keepAliveMinMs** (default `60000` = 60s) — minimum gap between pings
  (standard mode). Must be `≤ keepAliveMaxMs`.
- **keepAliveMaxMs** (default `240000` = 4m) — maximum gap (standard mode).
- **keepAliveModeExtended** (default `false`) — use the extended (longer) interval
  band below instead of the standard band above.
- **keepAliveMinMsExtended** (default `900000` = 15m) — min gap (extended mode).
  Must be `≤ keepAliveMaxMsExtended`.
- **keepAliveMaxMsExtended** (default `2700000` = 45m) — max gap (extended mode).
- **keepAliveMinPrefixBytes** (default `1024`) — skip warming a session whose
  cacheable prefix is below this many bytes (a prefix under ~1024 *tokens* is
  un-cacheable, so the ping would write nothing). `0` disables the gate; raise to
  `4096`–`8192` if you observe junk auxiliary contexts. Must be `≥ 0`.
- **keepAliveTimeoutMs** (default `30000` = 30s) — per-ping request timeout.

## Session lifecycle & GC

- **gracePeriodMs** (default `18000000` = 5h) — extra time kept past a session's
  signaled rate-limit reset (`targetTtl`) before GC expires it.
- **sessionMaxIdleMs** (default `43200000` = 12h) — inactivity expiry for any
  session. Must be `≥ 0`.
- **deadSessionMaxIdleMs** (default `21600000` = 6h) — faster reap for an
  `authStale` session (one whose keep-alive already 401'd). `0` disables this
  fast-path. Must be `≥ 0`.
- **gcSweepIntervalMs** (default `300000` = 5m) — how often the GC sweep runs.
  Must be `≥ 0`.
- **requestTimeoutMs** (default `600000` = 10m) — timeout for a proxied upstream
  request.

## Cache-TTL interventions

These rewrite the bytes forwarded to Anthropic; they change the prompt-cache
(ANTHROPIC) key, so treat changes as measurable interventions.

- **injectExtendedCacheTtl** (default `true`) — inject top-level
  `cache_control: { ttl: "1h" }` so the prefix lands in the 1-hour cache tier.
- **rewriteNestedCacheControl** (default `true`) — also rewrite per-block
  `cache_control: {type:"ephemeral"}` inside system/tools/messages to `ttl:"1h"`.
  Required for Claude Code (which sets per-block cache_control every turn), else
  the top-level inject is a silent no-op. No-op when `injectExtendedCacheTtl` is off.
- **stripExtendedCacheTtl** (default `false`) — inverse: strip the client's own
  `ttl:"1h"` back to Anthropic's 5-minute default. **Wins over inject** (both on
  → 5m). Use to pin the 5m tier on a tight loop where the 1h write premium buys
  nothing.
- **stripEphemeralFromSystem** (default `true`) — strip `ephemeral` cache_control
  from `system` blocks; collapses Claude Code's per-request cache fragmentation.
- **passthrough** (default `false`) — **master OFF / honest baseline arm.** Forces
  `injectExtendedCacheTtl`, `rewriteNestedCacheControl`, `stripExtendedCacheTtl`,
  `stripEphemeralFromSystem`, `keepAliveEnabled`, and `autoContinue` all off. Hard
  override applied after CLI, so it always wins.

## Auto-continue (PTY)

- **autoContinue** (default `false`) — auto-resume the attached `claude` when it
  goes idle, by typing into its PTY.
- **autoContinueText** (default `"continue\r"`) — exact bytes written. `\r` is the
  Enter keypress a TUI expects (not `\n`).
- **autoContinueCooldownMs** (default `300000` = 5m) — minimum gap between
  auto-continue fires.

## Mobile & transport

- **mobile** (default `false`) — soft bundle: turns on `gzipOutgoing` and
  `forceNonStreaming` unless you override either explicitly.
- **gzipOutgoing** (default `false`) — gzip request bodies sent upstream.
- **forceNonStreaming** (default `false`) — force non-streaming responses.
- **upstreamFromEnv** (default `false`) — adopt `ANTHROPIC_BASE_URL` as `upstream`
  (CLI `--upstream` still wins).

## Admin endpoint

- **adminPathPrefix** (default `"_proxy"`) — URL path segment for the dashboard /
  admin / report endpoints. Non-empty, no `/`, and not `"v1"`.

## Statusline

- **statuslinePrefix** (default `""`) — text prepended to the statusline.
- **statuslineMaxChars** (default `160`) — truncate the rendered statusline to
  this width.
- **statuslineProgressBarLength** (default `8`) — cells per progress bar. Positive
  integer.
- **statuslineColor** (default `"auto"`) — ANSI color. One of `"auto"` (honor
  `NO_COLOR`, then `isTTY`), `"on"`, `"off"`.
- **accountGlobalQuota** (default `true`) — render plan-quota fields from an
  account-global freshest value (so an idle session isn't stale). `false` =
  strict per-session value (escape hatch for >1 account through one proxy).
- **statuslinePctThresholdLow** (default `50`) — low edge of the WARN (yellow)
  band for percentage fields. Number in `0..100`, `≤` High.
- **statuslinePctThresholdHigh** (default `80`) — high edge. Number in `0..100`.
- **statuslineTtftThresholdLowMs** (default `3000`) — TTFT green→yellow boundary
  (ms; lower is better — it's the cache-warmth signal) for the web UI's TTFT
  chart bands. The statusline itself doesn't show TTFT. `≥ 0`, `≤` High.
- **statuslineTtftThresholdHighMs** (default `5000`) — TTFT yellow→red boundary.
- **statuslineTpsThresholdLow** (default `15`) — tokens/sec low edge (higher is
  better) for `"absolute"` calibration / bootstrap. `≥ 0`, `≤` High.
- **statuslineTpsThresholdHigh** (default `40`) — tokens/sec high edge.
- **statuslineTpsCalibration** (default `"relative"`) — `"relative"` derives TPS
  bands from the session's own peak (low=peak/6, high=peak/2) so color means
  "fast/slow for this model"; `"absolute"` uses the fixed pair above.
