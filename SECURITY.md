# Security

## Reporting a vulnerability

Please report privately via [hello@clawback.md](mailto:hello@clawback.md) rather
than opening a public issue. Reports get a response within a few days; please
leave time for a fix before public disclosure. Only the latest release is
supported for security fixes.

## What clawback is, threat-model-wise

clawback sits between Claude Code and `api.anthropic.com` as a local
forwarding proxy, or gateway. Everything Claude Code sends — full prompt
content, OAuth bearer, response stream — passes through it in the clear. Run it
only on machines and networks you'd trust with the conversation itself.

## Credential handling

- **The OAuth bearer is captured per session** (along with the
  `anthropic-*` and client-fingerprint headers) so keep-alive pings can
  re-authenticate. It lives in memory and in `data/state.json`, which
  is written mode `0600`.
- **`x-api-key` is never relayed or stored.** clawback is an
  OAuth-bearer proxy; an Anthropic API key sent by a
  client is stripped at the door on every path (forward, keep-alive
  store, shadow baseline).
- **`adminToken` lives in `CLAWBACK.md`**, created mode `0600` and
  gitignored by `clawback init` / `quickstart`. `GET /_proxy/health`
  filters it from config readouts.

## What lands on disk

| File | Mode | Contents |
| --- | --- | --- |
| `CLAWBACK.md` | `0600` | config + `adminToken` (shared secret) |
| `data/state.json` | `0600` | session state incl. captured OAuth bearer |
| `data/turns.ndjson` | `0600` | per-turn metrics (session key, model, token counts, timestamps) — no prompt content |
| `logs/` | `0600` | proxy/session logs — no prompt content |

The one deliberate exception: `--capture-body <path>` dumps a single
pristine `/v1/messages` request body — i.e. a full prompt, system
blocks and all — for benchmark-fixture minting. Treat that file as
sensitive and delete (or sanitize) it when you're done.

## Network exposure model

- **Default bind is loopback** (`127.0.0.1`). Nothing is reachable off
  the machine; no token or TLS is required.
- **A non-loopback bind requires an `adminToken`** — config validation
  refuses to start without one — and auto-enables TLS.
- **Mutating admin endpoints** (POST/PUT/PATCH/DELETE under
  `/_proxy/...`) require the bearer, except from loopback callers, so
  the local UI works tokenless.
- **Cross-origin hardening:** non-loopback-safe requests must pass
  Host/Origin checks (anti-DNS-rebinding). The checks are skipped only
  when the request *presents* a valid bearer — a token merely being
  configured does not relax write protection. Statusline **writes**
  reject any request carrying an `Origin` header (browsers always send
  one on cross-origin POSTs; the `claude` statusline curl never does).
- **The read surface is intentionally open even with a token set.**
  `GET /_proxy/health`, `/_proxy/sessions`, the dashboard, and the
  metrics ring return without auth. They expose session keys, hit
  rates, throughput, system byte sizes, and toggle state — no prompt
  content, no API keys, no `adminToken`. Anyone who can reach the bind
  can read those.

For exposure beyond a trusted LAN, the recommended posture is
**don't**: keep the bind on loopback and tunnel via Tailscale,
WireGuard, or an SSH port-forward. The token model was designed for
`homelab.local` on your own Wi-Fi, not for a public IP. See
"Privacy & Security" in the README.
