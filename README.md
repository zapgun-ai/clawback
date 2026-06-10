# clawback.md

`clawback.md` is a tokenmaxxer — a transparent local proxy in front of
the Anthropic API that (1) shows you exactly how your tokens are being
spent and (2) gives you a curated set of one-click optimization knobs
to make them go further. Same plan, same quota, more agentic work.

* [Why](#why)
* [Quickstart](#quickstart)
* [The Seven Knobs](#the-seven-knobs)
* [The Dashboard](#the-dashboard)
* [Verify It Yourself](#verify-it-yourself)
* [Configuration](#configuration)
* [Privacy & Security](#privacy--security)
* [License](#license)

## Why

Anthropic's prompt cache is the difference between cheap turns and
expensive ones: cache reads bill at 12–20× less than cache writes
(tier-dependent). But the cache evicts silently —

* after **5 idle minutes** (the default ephemeral TTL),
* at **midnight**, when the date Claude Code injects into your system
  prompt changes the bytes and therefore the cache key,
* whenever a **per-request billing token** (`cch=<hex>`) rotates and
  fragments the key.

Every eviction means your next turn pays write rates to rebuild a
prefix you already paid for. clawback.md sits in front of Anthropic,
captures your `system` + `tools` prefix, and keeps it warm:

* **keep-alive** — synthetic pings every 1–4 minutes (or 15–45 in
  extended cadence) bridge idle gaps.
* **1h cache TTL** — injects `cache_control: ttl=1h` so eligible
  sessions use Anthropic's extended cache tier instead of the
  5-minute default.
* **strip-ephemeral** — normalizes the volatile fragments (dates,
  `<env>` blocks, rotating billing tokens) before forwarding, so the
  bytes Anthropic hashes stay stable.

Bottom line: expensive cache writes become cheap cache reads. Longer
sessions, fewer cold starts, more work out of the same cap

## Quickstart

git clone <this repo>
cd clawback
npm install
npm link        # makes the `clawback` command available
clawback quickstart

## Description

```
`clawback quickstart` writes `./CLAWBACK.md` with sensible defaults,
wires Claude Code's statusline to the proxy, starts clawback.md if it
isn't already running, and launches `claude` with
`ANTHROPIC_BASE_URL` pointed at it. It binds the dashboard to your
LAN (`host: "0.0.0.0"`) and mints a fresh `adminToken` alongside, so
that bind is safe out of the box. The command is idempotent —
re-running it leaves existing files alone unless `--force` is set.
Pass `--project` to keep settings in `<cwd>/.claude/` instead of
`~/.claude/`, or `--no-launch` to stop before launching claude.

Prefer the pieces separately?

```bash
clawback init --local             # create ./CLAWBACK.md
clawback setup claude             # wire Claude Code's statusline
clawback claude                   # launch claude against clawback
```

Or bare metal:

```bash
clawback &
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

To undo: `clawback uninstall claude` strips the statusline wiring from
`~/.claude/settings.json` (or `<cwd>/.claude/settings.json` with
`--project`) and leaves every other setting untouched.

## The Seven Knobs

| Toggle | What it does | Why you'd flip it |
|--------|--------------|-------------------|
| **passthrough** | Turns every clawback.md intervention off (baseline arm) | Measure clawback.md's effect — quick A/B against doing nothing |
| **keep-alive** | Synthetic pings keep the prompt cache warm | Avoid 5-minute cache expiry between turns |
| **1h cache TTL** | Use Anthropic's extended cache tier | Make the cache survive long idle gaps |
| **strip-ephemeral** | Normalize dates / env / billing tokens in system prompts | Prevent silent cache invalidation across days |
| **extended cadence** | 15–45 min ping cadence (pairs with 1h TTL) | Cut keep-alive spend ~6–12× |
| **mobile** | gzip outgoing + non-streaming responses | Cut radio-on time on tethered/slow links |
| **auto-continue** | Resume claude after a rate-limit cap clears | Overnight runs finish without babysitting |

Flip any of them from the dashboard (hotkeys 1–7) or via the admin
endpoints:

```bash
curl -XPOST -H 'content-type: application/json' \
  -d '{"action":"toggle"}' \
  http://localhost:8080/_proxy/extend-cache-ttl
```

## The Dashboard

Open `http://localhost:8080/_proxy/ui/`:

* **Toggles** for all seven knobs.
* **Live time-series charts** — context %, quota (5-hour and weekly
  windows), cache hit rate, turn %, tokens/sec, and time-to-first-token,
  with one line per session plus aggregates.
* **Mode-change markers** — a vertical line at every toggle flip, so
  you can see how each metric responds to each intervention.
* **Suggestions** — clawback.md watches your traffic and recommends a
  knob when the stats imply you'd benefit (e.g. low cache hit rate →
  strip-ephemeral; rate-limit walls → auto-continue). Apply is one
  click; Dismiss persists.
* **Session filter bar** to focus on a single claude session.

`clawback claude` mints a per-session id, so each claude instance gets
its own metrics, statusline, and session record. `--label <name>`
names it in the UI, `--resume <id>` re-attaches a resumed claude to
its history, and `--remote <url>` points claude at a clawback.md
running on another host.

## Verify It Yourself

clawback.md ships with the harness that measures its own claim.
`scripts/ab_block.sh` runs a counterbalanced A/B block — passthrough
baseline vs. treatment stack — then analyzes and charts the result
with bootstrap 95% confidence intervals. Below 30 turns per arm the
analyzer reports `insufficient` rather than print a number it can't
defend.

```bash
# headline profile (5–30 min idle gaps), ≥200 turns/arm for a reportable %:
scripts/ab_block.sh --profile L2 --turns 200 --driver pty \
  --model claude-haiku-4-5-20251001 --out runs/L2
```

The win is conditional on your idle-gap distribution: tight loops
roughly tie the baseline, and the gain grows as gaps cross the
5-minute, 1-hour, and midnight eviction boundaries. `TEST.md` has the
full methodology; the harness lives in the git repo, not the npm
package. Note that the `pty` driver drives the real `claude` binary
and spends real tokens — keep plumbing runs small and on a cheap
model.

## Configuration

Layered merge, lowest precedence first:

1. **Defaults** — `src/config.js`.
2. **Global** — `${XDG_CONFIG_HOME:-$HOME/.config}/clawback/CLAWBACK.md`.
3. **Local** — `./CLAWBACK.md` (auto-discovered), or `--config <path>`.
4. **CLI flags** — `clawback --help` for the full list.

`passthrough` is a hard bundle: when on, it forces every intervention
off regardless of layer. Common flags:

```
--host <host>                Bind host (default 127.0.0.1)
--port <port>                Bind port (default 8080)
--upstream <url>             Upstream Anthropic URL
--passthrough                Transparent byte-forwarding proxy
--keep-alive <on|off>        Ping scheduler (default on)
--inject-extended-cache-ttl <on|off>   ttl=1h injection (default on)
--keep-alive-mode-extended <on|off>    15–45 min cadence (default off)
--strip-ephemeral-from-system <on|off> Normalize system prompt (default on)
--mobile                     gzip + non-streaming bundle
--auto-continue              Auto-resume claude after cap clears
--admin-token <secret>       Bearer token for mutating admin endpoints
```

### Observer mode (non-Anthropic upstreams)

The cache interventions are Anthropic-specific, but the telemetry
isn't. Point clawback.md at an OpenAI-compatible upstream in
`--passthrough` mode and you keep the dashboard, statusline, and
per-session metrics, with no Anthropic-shaped payloads sent to the
wrong API:

```bash
clawback --upstream https://api.x.ai --passthrough --port 8081
```

## Privacy & Security

clawback.md runs entirely on your machine and phones home to nobody —
there is no product telemetry. By default it binds to loopback. On a
LAN bind, the auto-minted `adminToken` gates mutating admin endpoints;
read endpoints (health, sessions, metrics, the UI) stay open and
expose stats but never prompt content, API keys, or the token itself.
Don't expose it to the public internet — tunnel with Tailscale,
WireGuard, or an SSH port-forward instead. For HTTPS on a trusted
LAN, `clawback init-cert` mints a self-signed cert and `--tls on`
serves it.

## Testing

```bash
npm test       # jest
npm run lint   # biome
npm run check  # biome lint + format check (CI gate)
```

## Contact

hi@clawback.md

## License

See LICENSE.
