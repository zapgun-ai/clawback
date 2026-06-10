import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { ensurePtySpawnHelperExecutable } from "./pty_helper_perms.js";

/**
 * Build the ANTHROPIC_BASE_URL value a client should use to reach a clawback
 * instance bound to the given config. 0.0.0.0 is rewritten to 127.0.0.1 since
 * the wildcard address is a bind-only target, not something a client dials.
 * Emits `https://` when `config.tls` is on; clients that don't trust
 * clawback's self-signed cert will fail unless `NODE_EXTRA_CA_CERTS` is set
 * to the cert path (which `launchClaude` does automatically for the spawned
 * claude child).
 *
 * `clawbackId` (PLAN §39, optional) appends a path component so the spawned
 * claude's requests carry the URL-path session id `src/router.js` uses to
 * identify the session. When omitted, the URL is the bare proxy address —
 * back-compat for callers that pre-date per-session routing (probe, legacy
 * `clawback claude` paths in tests).
 */
export function buildBaseUrl(config, clawbackId = null) {
	const host =
		config.host === "0.0.0.0" || config.host === "::"
			? "127.0.0.1"
			: config.host;
	const scheme = config.tls ? "https" : "http";
	const base = `${scheme}://${host}:${config.port}`;
	return clawbackId ? `${base}/${clawbackId}` : base;
}

/**
 * Normalize an operator-supplied remote URL: strip trailing slash, throw
 * with a clear message on invalid input. Accepts http:// and https:// only.
 * Returns the cleaned URL (no trailing slash) — callers append `/<id>` for
 * the per-session ANTHROPIC_BASE_URL, or `/<adminPathPrefix>/...` for admin
 * round-trips. Any path/query/hash the operator pasted is dropped so a
 * trailing slash can't silently double up when we concatenate.
 */
export function normalizeRemoteUrl(raw) {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error("remote URL is empty");
	}
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`invalid remote URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`remote URL must be http:// or https://, got: ${parsed.protocol}`,
		);
	}
	const port = parsed.port ? `:${parsed.port}` : "";
	return `${parsed.protocol}//${parsed.hostname}${port}`;
}

/**
 * Launch `claude` with ANTHROPIC_BASE_URL pointed at a clawback instance.
 *
 * If `config` is provided, its host/port are used directly (typical when the
 * caller has already started the proxy and wants the child to talk to it). If
 * not, the same config layers as `clawback` itself are loaded fresh
 * (DEFAULTS < global < local-auto).
 *
 * Pass-through args are forwarded verbatim.
 *
 * **PTY mode (preferred when conditions are met):** when stdin and stdout are
 * both TTYs *and* the optional `node-pty` dependency is installed *and* the
 * caller did not override `spawnFn`, claude is launched inside a PTY whose
 * master clawback owns. This unlocks PLAN §24 — clawback can write to the
 * master FD to inject keystrokes (e.g. "continue\n" on cap-clear). Returns
 * `{ ptyProcess, baseUrl, config, sources, mode: "pty" }`.
 *
 * **Pass-through mode (fallback):** plain `child_process.spawn` with
 * `stdio: "inherit"`. Returns `{ child, baseUrl, config, sources, mode: "spawn" }`.
 * Pass-through is the only sensible behaviour when stdio isn't a TTY (e.g. a
 * non-interactive shell), node-pty failed to compile, or a test injects a
 * fake `spawnFn`.
 */
export async function launchClaude({
	args = [],
	config = null,
	cwd = process.cwd(),
	env = process.env,
	spawnFn = null,
	ptyFactory = null,
	command = "claude",
	stdinIsTty = process.stdin.isTTY,
	stdoutIsTty = process.stdout.isTTY,
	cols = process.stdout.columns,
	rows = process.stdout.rows,
	clawbackId = null,
	label = null,
	remoteUrl = null,
} = {}) {
	let resolvedConfig = config;
	let sources = [];
	if (!resolvedConfig) {
		({ config: resolvedConfig, sources } = loadConfig({ cwd, env }));
	}
	// `remoteUrl` (PLAN: `clawback claude --remote`) overrides the config-derived
	// host/port. The local config is still consulted for adminPathPrefix and
	// TLS-cert paths, but the spawned claude is pointed at the remote.
	const proxyUrl = remoteUrl
		? normalizeRemoteUrl(remoteUrl)
		: buildBaseUrl(resolvedConfig);
	const baseUrl = clawbackId ? `${proxyUrl}/${clawbackId}` : proxyUrl;
	const childEnv = { ...env, ANTHROPIC_BASE_URL: baseUrl };
	// PLAN §39: propagate the per-session id and bare proxy URL to the
	// spawned claude so its statusline command (configured by
	// `clawback setup statusline`) can curl the right per-session
	// endpoint via env-var expansion. Without these, the statusline
	// command falls back to the legacy aggregate `/_proxy/statusline`.
	if (clawbackId) {
		childEnv.CLAWBACK_PROXY_URL = proxyUrl;
		childEnv.CLAWBACK_SESSION_ID = clawbackId;
		if (label) childEnv.CLAWBACK_SESSION_LABEL = label;
	}

	// When clawback is serving TLS with a self-signed cert, point the spawned
	// claude at the cert via NODE_EXTRA_CA_CERTS so its Node-based HTTPS agent
	// trusts it without the operator needing to disable cert validation
	// globally. Preserves any existing value the parent had (rare, but possible
	// when the operator is already trusting another local CA). Skipped when
	// `remoteUrl` is set — the local cert is for the local proxy and means
	// nothing to a remote endpoint; the operator is responsible for any CA
	// trust the remote needs.
	if (!remoteUrl && resolvedConfig.tls && resolvedConfig.tlsCertFile) {
		const existing = env.NODE_EXTRA_CA_CERTS;
		childEnv.NODE_EXTRA_CA_CERTS = existing
			? `${existing}:${resolvedConfig.tlsCertFile}`
			: resolvedConfig.tlsCertFile;
	}

	const allowPty = stdinIsTty && stdoutIsTty && spawnFn == null;
	let ptyError = null;
	if (allowPty) {
		const factory = ptyFactory ?? (await loadDefaultPtyFactory());
		if (factory) {
			try {
				const ptyProcess = factory({
					command,
					args,
					cwd,
					env: childEnv,
					cols: cols ?? 80,
					rows: rows ?? 24,
				});
				return {
					ptyProcess,
					baseUrl,
					proxyUrl,
					clawbackId,
					label,
					config: resolvedConfig,
					sources,
					mode: "pty",
				};
			} catch (e) {
				// node-pty's `pty.fork` throws synchronously when it can't
				// even spawn its own spawn-helper — classically
				// `posix_spawnp failed.` when that prebuilt binary lost its
				// execute bit. ensurePtySpawnHelperExecutable() above is
				// meant to prevent exactly this, but if anything still trips
				// the fork (read-only FS, an unforeseen layout), fall through
				// to plain pass-through spawn so claude still launches —
				// trading away PTY-only keystroke injection (auto-continue)
				// for this session. The caller surfaces the reason via
				// `ptyError`.
				ptyError = e;
			}
		}
	}

	const effectiveSpawn = spawnFn ?? spawn;
	const child = effectiveSpawn(command, args, {
		stdio: "inherit",
		env: childEnv,
		cwd,
	});
	return {
		child,
		baseUrl,
		proxyUrl,
		clawbackId,
		label,
		config: resolvedConfig,
		sources,
		mode: "spawn",
		// Set only when a PTY launch was attempted and threw, so the caller
		// can warn that auto-continue/keystroke-injection is unavailable for
		// this pass-through session.
		ptyError,
	};
}

/**
 * Try to load `node-pty` (an optional dep). Returns a factory that mirrors
 * the shape `launchClaude` uses internally, or null if the dep is missing
 * or fails to load. The dynamic import is wrapped so a missing addon doesn't
 * crash the proxy at startup.
 */
async function loadDefaultPtyFactory() {
	try {
		const nodePty = await import("node-pty");
		// node-pty's prebuilt spawn-helper often ships without its execute
		// bit (packed-tarball install, hoisted under a different
		// node_modules than a postinstall chmod would reach). Restore it
		// before the first `pty.fork`, otherwise that fork throws
		// "posix_spawnp failed." See src/pty_helper_perms.js.
		ensurePtySpawnHelperExecutable();
		return ({ command, args, cwd, env, cols, rows }) =>
			nodePty.spawn(command, args, {
				name: env.TERM ?? "xterm-256color",
				cols,
				rows,
				cwd,
				env,
			});
	} catch {
		return null;
	}
}
