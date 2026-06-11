import fs from "node:fs";
import path from "node:path";

/**
 * `clawback setup statusline` — write a statusLine block into the
 * operator's Claude Code settings so the statusline pulls clawback's
 * `/_proxy/statusline` endpoint with claude's session data POSTed.
 *
 * Settings file shape per Claude Code docs:
 *   { "statusLine": { "type": "command", "command": "..." } }
 *
 * Default settings path is `~/.claude/settings.json` (user-level).
 * `--project` switches to `<cwd>/.claude/settings.json` (project-level)
 * or the explicit `--settings <path>` wins over both.
 *
 * Existing keys in settings.json are preserved (we merge, not
 * overwrite). If `statusLine` is already present, we refuse unless
 * `--force` is passed — same opt-in safety as `clawback init`.
 */
export function setupStatusline({
	settingsPath = null,
	project = false,
	force = false,
	host = "127.0.0.1",
	port = 8080,
	adminPathPrefix = "_proxy",
	remoteUrl = null,
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	const targetPath = resolveSettingsPath({
		settingsPath,
		project,
		cwd,
		env,
	});
	const follow = "-L ";
	// The statusline command is baked once into settings.json but must keep
	// working as the server's transport changes underneath it. clawback's TLS
	// dispatcher 308-redirects plain HTTP to https://, so the baked command
	// always passes `-L` (follow the upgrade). Local always targets an http://
	// base and adds `-k`: if the proxy is plain HTTP the redirect never fires;
	// if it's HTTPS curl follows the 308 and accepts the self-signed cert. One
	// command self-heals both directions, so no `tls` knob is needed here.
	// For a remote we respect the operator's pasted scheme and only add `-k`
	// for an https remote (those commonly carry a self-signed cert on a
	// homelab/VPS); an http remote gets neither. Loopback admin auth is exempt
	// (PLAN §35), so no bearer header is needed for the curl line.
	const insecure = remoteUrl ? (isHttpsRemote(remoteUrl) ? "-k " : "") : "-k ";
	// PLAN §39 (Phase 1): per-session statusline routing.
	// The command reads CLAWBACK_PROXY_URL / CLAWBACK_SESSION_ID at runtime
	// (set in the spawned claude's env by `clawback claude`). When claude
	// is launched WITHOUT `clawback claude` (env vars unset), the fallbacks
	// kick in and the command hits the baked default — typically the local
	// proxy, or the operator-supplied `--remote <url>` when this command
	// was run with that flag. So the same statusLine block works whether
	// claude was launched via `clawback claude`, `clawback claude --remote`,
	// or bare with a stale ANTHROPIC_BASE_URL elsewhere.
	const defaultBase = remoteUrl
		? stripTrailingSlash(remoteUrl)
		: `http://${normalizeHost(host)}:${port}`;
	const defaultPath = `/${adminPathPrefix}/statusline`;
	// Shell expansion: ${CLAWBACK_PROXY_URL:-<default>} expands to the env
	// var if set, else the literal default. Same for the session id —
	// _default is a router-reserved sentinel that routes to the legacy
	// no-id path on the server side.
	const command = `bash -c 'curl -sf ${follow}${insecure}--data-binary @- "\${CLAWBACK_PROXY_URL:-${defaultBase}}${defaultPath}/\${CLAWBACK_SESSION_ID:-_default}" || true'`;
	const block = { type: "command", command };

	let existing = {};
	let exists = false;
	if (fs.existsSync(targetPath)) {
		exists = true;
		const raw = fs.readFileSync(targetPath, "utf8");
		try {
			existing = raw.trim().length === 0 ? {} : JSON.parse(raw);
		} catch (e) {
			throw new Error(
				`${targetPath} exists but is not valid JSON: ${e.message}`,
			);
		}
		if (existing && typeof existing !== "object") {
			throw new Error(`${targetPath} top-level is not a JSON object`);
		}
	}

	const hadStatusLine =
		existing && typeof existing === "object" && existing.statusLine != null;
	if (hadStatusLine && !force) {
		return {
			targetPath,
			action: "skipped",
			reason: "statusLine already present; pass --force to overwrite",
			previous: existing.statusLine ?? null,
		};
	}

	const previous = hadStatusLine ? existing.statusLine : null;
	const next = { ...existing, statusLine: block };
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

	let action;
	if (!exists) action = "created";
	else if (hadStatusLine) action = "overwrote";
	else action = "merged";
	// `previous` is the statusLine block we displaced — the block on an
	// `overwrote`, null on `created`/`merged`. Mirrors the skip-path return
	// so a forcing caller (e.g. quickstart) can surface what it replaced.
	return { targetPath, action, command, previous };
}

/**
 * `clawback uninstall` — inverse of `clawback setup claude`. Strips the
 * `statusLine` block from the same Claude Code settings file the setup
 * step wrote it to, leaving every other key untouched.
 *
 * Path resolution mirrors `setupStatusline`: default is
 * `~/.claude/settings.json`; `--project` switches to
 * `<cwd>/.claude/settings.json`; explicit `--settings <path>` wins.
 *
 * Return shape:
 *   - { targetPath, action: "missing" }            — no settings file
 *   - { targetPath, action: "no-statusline" }      — file exists but no statusLine
 *   - { targetPath, action: "removed", previous }  — statusLine stripped (previous is the removed block)
 *   - { targetPath, action: "removed-file" }       — statusLine was the only key, file deleted
 *
 * Throws when the file exists but isn't a JSON object (same shape as
 * setupStatusline so the operator sees a single style of error).
 */
export function uninstallStatusline({
	settingsPath = null,
	project = false,
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	const targetPath = resolveSettingsPath({
		settingsPath,
		project,
		cwd,
		env,
	});

	if (!fs.existsSync(targetPath)) {
		return { targetPath, action: "missing" };
	}

	const raw = fs.readFileSync(targetPath, "utf8");
	let existing;
	try {
		existing = raw.trim().length === 0 ? {} : JSON.parse(raw);
	} catch (e) {
		throw new Error(`${targetPath} exists but is not valid JSON: ${e.message}`);
	}
	if (
		existing == null ||
		typeof existing !== "object" ||
		Array.isArray(existing)
	) {
		throw new Error(`${targetPath} top-level is not a JSON object`);
	}

	if (existing.statusLine == null) {
		return { targetPath, action: "no-statusline" };
	}

	const previous = existing.statusLine;
	const { statusLine: _removed, ...rest } = existing;
	void _removed;

	// If statusLine was the only key, delete the whole file so the
	// uninstall is a true reverse of `clawback setup --force` on a
	// fresh machine. The .claude directory is left in place — it may
	// hold other state (history, etc.) that clawback didn't create.
	if (Object.keys(rest).length === 0) {
		fs.rmSync(targetPath);
		return { targetPath, action: "removed-file", previous };
	}

	fs.writeFileSync(targetPath, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
	return { targetPath, action: "removed", previous };
}

// Claude Code resolves settings from several files, higher precedence last:
//   user (~/.claude/settings.json)
//     < project (<cwd>/.claude/settings.json)
//       < project-local (<cwd>/.claude/settings.local.json)
// (enterprise policy and CLI flags sit above these but aren't files we
// scan.) A clawback statusLine written to a lower tier is silently
// shadowed by a clawback — or any — statusLine at a higher tier. That
// exact drift (a stale project block shadowing a fresh user block) is what
// sent an operator's statusline dark on 2026-05-28, so `setup` now scans
// the *other* tiers after writing and reports any clawback-managed block it
// finds.
const TIER_RANK = { user: 1, project: 2, "project-local": 3 };

function standardTierPaths({ cwd, env }) {
	const home = env.HOME;
	return {
		user: home ? path.join(home, ".claude", "settings.json") : null,
		project: path.resolve(cwd, ".claude", "settings.json"),
		"project-local": path.resolve(cwd, ".claude", "settings.local.json"),
	};
}

function readStatuslineBlock(p) {
	// Advisory read: a missing or malformed file is simply "no block here".
	// We never throw from the scan — it must not turn a successful setup
	// into a failure.
	if (!p || !fs.existsSync(p)) return null;
	try {
		const raw = fs.readFileSync(p, "utf8");
		if (raw.trim().length === 0) return null;
		const obj = JSON.parse(raw);
		if (obj && typeof obj === "object" && !Array.isArray(obj)) {
			return obj.statusLine ?? null;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Is this statusLine block one clawback wrote? Detected by the curl target,
 * which every generated command carries regardless of flag drift:
 * `/_proxy/statusline` in the URL or the `CLAWBACK_PROXY_URL` env expansion.
 */
export function isClawbackStatusline(block) {
	if (!block || typeof block !== "object") return false;
	const cmd = block.command;
	if (typeof cmd !== "string") return false;
	return (
		cmd.includes("/_proxy/statusline") || cmd.includes("CLAWBACK_PROXY_URL")
	);
}

/**
 * After writing a statusLine to `targetPath`, scan the *other* standard
 * Claude Code settings tiers for a clawback-managed statusLine block.
 *
 * Returns `{ writtenTier, conflicts }`:
 *   - `writtenTier`: which standard tier `targetPath` is, or null when it's
 *     an explicit `--settings <path>` that matches no standard location.
 *   - `conflicts`: one entry per other tier that holds a clawback statusLine:
 *       `{ tier, path, shadows }` where `shadows` is
 *         true  — that tier outranks the write (Claude Code uses it instead),
 *         false — the write outranks it (that block is now redundant),
 *         null  — precedence unknown (write went to an explicit path).
 */
export function detectStatuslineTierConflicts({
	targetPath,
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	const tiers = standardTierPaths({ cwd, env });
	const resolvedTarget = path.resolve(targetPath);

	let writtenTier = null;
	for (const [tier, p] of Object.entries(tiers)) {
		if (p && path.resolve(p) === resolvedTarget) {
			writtenTier = tier;
			break;
		}
	}

	const conflicts = [];
	for (const [tier, p] of Object.entries(tiers)) {
		if (!p || path.resolve(p) === resolvedTarget) continue;
		if (!isClawbackStatusline(readStatuslineBlock(p))) continue;
		const shadows =
			writtenTier != null ? TIER_RANK[tier] > TIER_RANK[writtenTier] : null;
		conflicts.push({ tier, path: p, shadows });
	}
	return { writtenTier, conflicts };
}

/**
 * Resolve which statusLine block Claude Code actually uses, and surface the
 * full per-tier picture so `clawback doctor` can explain shadowing.
 *
 * Claude Code resolves settings with project-local > project > user
 * precedence (TIER_RANK). The *effective* block is the one at the
 * highest-rank tier that defines a `statusLine` at all — that's what the TUI
 * runs; lower tiers are shadowed.
 *
 * Returns `{ entries, effective }`:
 *   - `entries`: one per standard tier in user→project→project-local order,
 *       `{ tier, path, present, isClawback, block }`. `present:false` /
 *       `block:null` when the file is missing, empty, malformed, or has no
 *       statusLine (readStatuslineBlock is advisory and never throws).
 *   - `effective`: the highest-rank present entry, or null when no tier
 *     defines a statusLine.
 */
export function resolveEffectiveStatusline({
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	const tiers = standardTierPaths({ cwd, env });
	const entries = Object.entries(tiers).map(([tier, p]) => {
		const block = readStatuslineBlock(p);
		return {
			tier,
			path: p,
			present: block != null,
			isClawback: isClawbackStatusline(block),
			block,
		};
	});
	let effective = null;
	for (const e of entries) {
		if (!e.present) continue;
		if (effective == null || TIER_RANK[e.tier] > TIER_RANK[effective.tier]) {
			effective = e;
		}
	}
	return { entries, effective };
}

export function resolveSettingsPath({
	settingsPath = null,
	project = false,
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	if (settingsPath) return path.resolve(settingsPath);
	if (project) return path.resolve(cwd, ".claude", "settings.json");
	const home = env.HOME;
	if (!home) {
		throw new Error(
			"cannot resolve user settings path: $HOME is unset (pass --settings <path>)",
		);
	}
	return path.join(home, ".claude", "settings.json");
}

function normalizeHost(host) {
	// `0.0.0.0` and `::` are bind-only addresses — a client can't dial them.
	// Rewrite to loopback so the curl in the operator's settings actually works.
	if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
	return host;
}

function stripTrailingSlash(url) {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isHttpsRemote(url) {
	if (!url) return false;
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}
