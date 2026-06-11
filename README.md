# clawback

`clawback` is a tokenmaxxer — a transparent local gateway to Anthropic (and [other
providers](#observer-mode-good-for-non-anthropic-upstreams)) that:

1. shows you exactly where your tokens are going,
2. gives you a curated set of one-click optimization knobs
to make them go further,
3. gives you a HUD inside `claude` that lets you know where you are in your token burn.

Your same plan, your same quota, just way more efficient.

`clawback` is not an agent and works with any
[agent harness (see below)](#direct-api-access-and-agent-setup).

## Quickstart

To start `clawback` with a default-secure config; run Claude Code; and open the dashboard in your browser:

```bash
npx @zapgun/clawback quickstart
```

## Contents

* [Why](#why)
* [Description](#description)
* [Direct API Access (and Agent Setup)](#direct-api-access-and-agent-setup)
* [The Seven Knobs](#the-seven-knobs)
* [The Dashboard](#the-dashboard)
* [DIY Verify](#diy-verify)
* [Configuration](#configuration)
* [Privacy & Security](#privacy--security)
* [Testing](#testing)
* [Contact](#contact)
* [License](#license)

## Why

Anthropic's API has a bunch of optimizations to help us use it more efficiently, but using them effectively is tricky. `clawback` handles that complexity for you.

The big optimization is using the prompt cache. This turns expensive calls into cheap ones, immediately. Cache reads bill at 12–20× less than cache writes
(tier-dependent). But the cache evicts silently —

* after **5 idle minutes** (the default unspecified TTL),
* after **60 idle minutes** (the default specified TTL),
* at **midnight**, when the date Claude Code injects into your system prompt changes, causing cache key rotation,
* whenever your system or tools prompts change, etc.

Every eviction means your next turn rebuilds context you already paid for with expensive "write" tokens instead of cheap "read" tokens. `clawback` sits in front of Anthropic and applies our optimizations to keep you in-cache:

* **keep-alive** — synthetic pings every 1–4 minutes (or 15–45 in
  extended cadence) to bridge idle gaps.
* **1h cache TTL** — injects `cache_control: ttl=1h` so eligible sessions use Anthropic's premium cache tier.
* **5m cache TTL** - _removes_ `cache_control: ttl=1h` to drop you down to cheaper writes if you don't need the premium tier.
* **strip-ephemeral** — normalizes volatile prompt fragments (dates,
  `<env>` blocks, rotating billing tokens) before forwarding, so your prompt cache stays stable.

**Bottom line:** `clawback` keeps you in-cache so that  expensive cache writes become cheap cache reads. This means longer sessions, fewer cold starts, and more work, all out of the same quota.

`clawback` also gives you manual knobs for other optimizations, like traffic shaping; and gives you a `passthrough` mode so you can see baseline `claude` use with no protections applied.

## Description

`clawback quickstart` writes `./CLAWBACK.md` with sensible defaults, wires Claude Code's statusline with the `clawback` HUD, starts `clawback` in server mode (if it isn't already running), and launches `claude` with `ANTHROPIC_BASE_URL` pointed at `clawback`.

It binds the dashboard to loopback (`host: "127.0.0.1"`) and mints a fresh `adminToken` alongside, so the setup is safe out of the box, and then
opens the local dashboard in your browser of choice. (Pass `--lan` to bind `0.0.0.0` with TLS for phone/remote access.)

Run each piece:

```bash
clawback init --local   # create ./CLAWBACK.md
clawback setup claude   # wire the HUD into Claude Code's statusline.
clawback claude         # launch `claude` connected to `clawback` (launch server if necessary).
```

Launch the server separately:

```bash
clawback &
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

### Attach more `claude` sessions:

**Once you're running a `clawback` server, run `clawback claude` in a new terminal to connect another session.**

### Uninstall

`clawback uninstall claude` strips the statusline HUD from `~/.claude/settings.json` (or `<cwd>/.claude/settings.json` with `--project`), and leaves every other setting untouched.

## Direct API Access (and Agent Setup)

To use `clawback` as a gateway to the Anthropic API, or to use it with an agent,
or another tool _like the Claude Desktop app_:

```bash
clawback &
export ANTHROPIC_BASE_URL=http://localhost:8080
open /Applications/Claude.app
```

Point any tool that needs the Anthropic API at a `clawback` server using `ANTHROPIC_BASE_URL` (or other configuration setting).

## The Seven Knobs

| Toggle | What it does | Why you'd flip it |
|--------|--------------|-------------------|
| **passthrough** | Turns off every `clawback` intervention (baseline). | Measure `clawback` versus baseline. |
| **keep-alive** | Synthetic pings keep the prompt cache warm. | Avoid cache expiry between turns. |
| **1h cache TTL** | Use Anthropic's premium extended cache tier. | Make the cache survive long idle gaps. |
| **strip-ephemeral** | Normalize dates / env / billing tokens in system prompts. | Prevent silent cache invalidation across days. |
| **extended cadence** | 15–45 min ping cadence (pairs with 1h TTL). | Cut keep-alive spend ~6–12×. |
| **mobile** | `gzip` outgoing + non-streaming responses. | Save battery on tethered links. |
| **auto-continue** | Resume sessions automatically after hitting a rate-limit. | Finish overnight jobs without babysitting. |

Flip any of them from the dashboard (hotkeys 1–7) or via the admin endpoints:

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"action":"toggle"}' \
  http://localhost:8080/_proxy/extend-cache-ttl
```

If you're calling from another machine (any non-loopback client), remember to also send the `adminToken` as a bearer token.

## The Dashboard

Open `http://localhost:8080/_proxy/ui/` to see:

* **Manual toggles** for all optimization knobs.
* **Live time-series charts** — context %, quota (5-hour and weekly windows), cache hit rate, turn %, tokens/sec, and time-to-first-token, with one line per session plus aggregates and baselines.
* **Mode-change markers** — a vertical line at every toggle flip, so you can see how each metric responds to each intervention.
* **Suggestions** — clawback watches your traffic and recommends a knob when your stats imply you'd benefit (e.g. low cache hit rate → strip-ephemeral; rate-limit walls → auto-continue). Enable with one click.
* **Session filter bar** to drill into a single `claude` session. `clawback claude` mints a per-session id, so each claude instance gets
its own metrics, statusline, and session record. `--label <name>`
names it in the UI, `--resume <id>` re-attaches a resumed claude to
its history.

`--remote <url>` points `clawback` to an instance running on another host. This is useful for monitoring efficiency gains across a fleet of `claude` instances.

## DIY Verify

The A/B harness we use for statistical validation lives in the repo — under
`.skills/` and `benchmark/`, which aren't bundled into the npm package — so clone
the repo to run it:

```bash
git clone https://github.com/zapgun-ai/clawback && cd clawback
```

`.skills/ab/scripts/ab_block.sh` runs a counterbalanced A/B block — passthrough
baseline vs. treatment stack — then analyzes and charts the result with confidence intervals. You can use this to generate statistically precise efficiency reports.

Here's an example of how to validate `haiku` (more capable models show even larger gains):

```bash
# headline profile (5–30 min idle gaps), ≥200 turns/arm for a reportable %:
bash .skills/ab/scripts/ab_block.sh --profile L2 --turns 200 --driver pty \
  --model claude-haiku-4-5-20251001 --out runs/L2
```

**The efficiency win grows as turns cross the 5-minute, 1-hour, and midnight eviction boundaries,** in addition to other optimizations.

## Configuration

`clawback` uses a layered configuration file system with CLI overrides. In
order of increasing priority, settings are pulled from:

1. **Defaults** — `src/config.js`.
2. **Global** — `${XDG_CONFIG_HOME:-$HOME/.config}/clawback/CLAWBACK.md`. For
example: `~/.config/clawback/CLAWBACK.md`.
3. **Local** — `./CLAWBACK.md` (auto-discovered), or `--config <path>`.
4. **CLI flags** — `clawback --help` for the full list.

If `--passthrough` is set all interventions are disabled and `clawback` becomes
a byte-transparent gateway to the API.

**See [the example config](https://github.com/zapgun-ai/clawback/blob/main/CLAWBACK.example.with.defaults.md)** for complete default settings and documentation.

Here are some common flags:

```
--host <host>                Bind host (default 127.0.0.1)
--port <port>                Bind port (default 8080)
--upstream <url>             Upstream Anthropic URL
--passthrough                Transparent byte-forwarding gateway
--keep-alive <on|off>        Ping scheduler (default on)
--inject-extended-cache-ttl <on|off>   ttl=1h injection (default on)
--keep-alive-mode-extended <on|off>    15–45 min cadence (default off)
--strip-ephemeral-from-system <on|off> Normalize system prompt (default on)
--mobile                     gzip + non-streaming bundle
--auto-continue              Auto-resume claude after cap clears
--admin-token <secret>       Bearer token for mutating admin endpoints
```

### Observer mode (good for non-Anthropic upstreams)

Our cache interventions are Anthropic-specific, but the telemetry isn't. Point `clawback` at an OpenAI-compatible upstream in `--passthrough` mode and you keep the dashboard, statusline, and per-session metrics:

```bash
clawback --upstream https://api.x.ai --passthrough --port 8081
```

## Privacy & Security

By default `clawback` runs entirely on your machine. There is no product telemetry yet. By
default it binds to loopback. On a LAN bind, the auto-minted `adminToken` gates
mutating admin endpoints; read endpoints (health, sessions, metrics, the UI)
stay open and expose stats but never prompt content, API keys, or the
`adminToken`.

**Expose `clawback` to the public internet at your own risk.** We typically tunnel
it through Tailscale, WireGuard, or an SSH port-forward instead. For HTTPS on
a trusted LAN, `clawback init-cert` mints a self-signed cert and `--tls on`
serves it.

## Testing

These should all pass and run clean:

```bash
npm test       # jest
npm run lint   # biome
npm run check  # biome lint + format check (CI gate)
```

## Contact

<hello@clawback.md>

## License

See LICENSE.
