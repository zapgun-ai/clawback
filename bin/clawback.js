#!/usr/bin/env node
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { clearActiveInput, setActiveInput } from "../src/claude_input.js";
import {
	composeSessionLabel,
	extractClawbackArgs,
	sanitizeHostSegment,
} from "../src/clawback_id.js";
import {
	inspectTargets,
	removeTargets,
	resolveCleanTargets,
} from "../src/clean.js";
import { loadConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { start } from "../src/index.js";
import { initConfig } from "../src/init.js";
import { initCert, resolveDefaultCertPaths } from "../src/init_cert.js";
import { buildBaseUrl, launchClaude } from "../src/launch_claude.js";
import { openBrowser, waitForUrl } from "../src/open_browser.js";
import { probeClawback } from "../src/probe.js";
import * as ptyCallbackServer from "../src/pty_callback_server.js";
import { runQuickstart } from "../src/quickstart.js";
import { setRemoteUrl } from "../src/remote.js";
import {
	detectStatuslineTierConflicts,
	setupStatusline,
	uninstallStatusline,
} from "../src/setup_statusline.js";

/**
 * Run a claude child to completion, regardless of whether it was launched in
 * PTY mode or pass-through `spawn` mode. Returns the exit code clawback
 * should propagate.
 */
async function runClaudeChild(result, { logger }) {
	if (result.mode === "pty") return runPtyChild(result.ptyProcess, { logger });
	return runSpawnChild(result.child);
}

/**
 * Best-effort POST to /_proxy/sessions/<id> to register the session label
 * with the proxy. PLAN §39 (Phase 1): the label is a UI affordance, not
 * load-bearing — if the POST fails (proxy busy, network blip), the
 * session record's label simply defaults to the clawback id. We do NOT
 * retry, do NOT throw, and do NOT slow down the spawned claude.
 *
 * Skipped silently when no label was provided. Since 2026-05-28 the
 * caller passes an origin-host-prefixed label (`<host>:<label-or-id>`)
 * for the dashboard, so a POST now happens for essentially every
 * session — but the skip-on-empty guard remains for the hostname-
 * unavailable + no-`--label` edge.
 *
 * `proxyUrl` overrides the config-derived base when set — used by
 * `--remote` so the label POST goes to the remote clawback's admin
 * endpoint, not to the local config's host:port.
 */
async function postSessionLabel(config, clawbackId, label, proxyUrl = null) {
	if (!label) return;
	const baseUrl = proxyUrl ?? buildBaseUrl(config);
	const url = `${baseUrl}/${config.adminPathPrefix}/sessions/${clawbackId}`;
	try {
		const headers = { "content-type": "application/json" };
		if (config.adminToken) {
			headers.authorization = `Bearer ${config.adminToken}`;
		}
		await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ label }),
		});
	} catch {
		/* best-effort — see jsdoc */
	}
}

/**
 * Decide whether the proxy we're attaching to is on this machine. The
 * reverse-channel registration only makes sense for same-host attach;
 * a NAT'd `--remote` proxy can't reach our loopback listener.
 *
 * Accepts the obvious loopback forms plus the wildcard bind addresses
 * (0.0.0.0 / :: imply the proxy is also reachable via 127.0.0.1 / ::1).
 */
function isLoopbackHost(host) {
	if (!host) return false;
	if (host === "127.0.0.1" || host === "::1" || host === "localhost")
		return true;
	if (host === "0.0.0.0" || host === "::") return true;
	if (host.startsWith("127.")) return true;
	return false;
}

/**
 * Register this `clawback claude` launcher's local PTY callback with a
 * running proxy. Returns null on any failure — the caller falls back to
 * the historical "cross-process input not supported" behaviour and the
 * proxy's GUI continue button + auto-continue stay quiet.
 */
async function registerPtyCallback({ config, callbackUrl, token, label }) {
	const adminBase = buildBaseUrl(config);
	const url = `${adminBase}/${config.adminPathPrefix}/claude/register`;
	const headers = { "content-type": "application/json" };
	if (config.adminToken) headers.authorization = `Bearer ${config.adminToken}`;
	try {
		const r = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ url: callbackUrl, token, label }),
		});
		if (!r.ok) {
			const body = await r.text().catch(() => "");
			return { ok: false, status: r.status, body };
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e.message };
	}
}

async function unregisterPtyCallback({ config }) {
	const adminBase = buildBaseUrl(config);
	const url = `${adminBase}/${config.adminPathPrefix}/claude/register`;
	const headers = {};
	if (config.adminToken) headers.authorization = `Bearer ${config.adminToken}`;
	try {
		await fetch(url, { method: "DELETE", headers });
	} catch {
		/* best-effort: proxy may already be gone, or transient network */
	}
}

async function runPtyChild(pty, { logger }) {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const wasRaw = stdin.isRaw;
	try {
		stdin.setRawMode?.(true);
	} catch {
		/* not all environments support setRawMode */
	}
	stdin.resume();
	const onStdin = (chunk) => {
		try {
			pty.write(chunk);
		} catch {}
	};
	stdin.on("data", onStdin);

	const onPtyData = (data) => {
		stdout.write(data);
	};
	pty.onData(onPtyData);

	const onResize = () => {
		try {
			pty.resize(stdout.columns ?? 80, stdout.rows ?? 24);
		} catch {}
	};
	stdout.on("resize", onResize);

	const forwardSignal = (sig) => () => {
		try {
			pty.kill(sig);
		} catch {}
	};
	const sigHandlers = {};
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		sigHandlers[sig] = forwardSignal(sig);
		process.on(sig, sigHandlers[sig]);
	}

	// Register PTY input writer so the admin endpoint
	// (POST /_proxy/claude/input) can deliver bytes for PLAN §24
	// auto-continue and any future GUI input UI.
	setActiveInput((text) => pty.write(text), { label: "claude-pty" });
	logger.info("claude PTY input writer registered for /_proxy/claude/input");

	const exitCode = await new Promise((resolve) => {
		pty.onExit(({ exitCode: code, signal }) => {
			resolve(signal ? 128 : (code ?? 0));
		});
	});

	clearActiveInput();
	stdin.off("data", onStdin);
	stdin.pause();
	stdout.off("resize", onResize);
	for (const sig of Object.keys(sigHandlers)) {
		process.off(sig, sigHandlers[sig]);
	}
	try {
		stdin.setRawMode?.(wasRaw ?? false);
	} catch {}
	return exitCode;
}

async function runSpawnChild(child) {
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => {
			try {
				child.kill(sig);
			} catch {}
		});
	}
	const { code, signal } = await new Promise((resolve) => {
		child.once("error", (e) => {
			const hint =
				e.code === "ENOENT"
					? " (is the claude CLI installed and on PATH?)"
					: "";
			process.stderr.write(
				`clawback claude: failed to spawn claude: ${e.message}${hint}\n`,
			);
			resolve({ code: 127, signal: null });
		});
		child.once("exit", (c, s) => resolve({ code: c, signal: s }));
	});
	return signal ? 128 : (code ?? 0);
}

// CLI alias: `clawback quick` and `clawback up` are shorter spellings for
// `clawback quickstart`. Normalize before any dispatch so the rest of this
// file only has to know about the canonical name — including the
// KNOWN_SUBCOMMANDS fall-through guard and the "unknown subcommand"
// error message.
if (process.argv[2] === "quick" || process.argv[2] === "up") {
	process.argv[2] = "quickstart";
}

if (process.argv[2] === "claude") {
	const rawArgs = process.argv.slice(3);
	// PLAN §39 (Phase 1): intercept --label <name> for the per-session
	// label (clawback-only flag; not forwarded to claude). Scan the
	// remaining args for --resume <xyz> to use as the canonical clawback
	// id (claude consumes --resume itself, so we observe but do not
	// remove). If neither is present, mint a fresh 8-hex id.
	let extracted;
	try {
		extracted = extractClawbackArgs(rawArgs);
	} catch (e) {
		process.stderr.write(`clawback claude: ${e.message}\n`);
		process.exit(2);
	}
	const {
		passthrough,
		clawbackId,
		clawbackLabel,
		clawbackIdSource,
		remoteUrl,
	} = extracted;
	if (
		passthrough.length === 1 &&
		(passthrough[0] === "--help" || passthrough[0] === "-h")
	) {
		const first = passthrough[0];
		process.stdout.write(`clawback claude - launch claude pointed at clawback

Usage:
  clawback claude [claude-args...]

Behavior:
  Loads the same config layers as \`clawback\` itself
  (DEFAULTS < global < ./CLAWBACK.md) and probes
  \`GET http://<host>:<port>/<admin-prefix>/health\` to decide:

    - If a clawback is already listening there, attach: launch claude
      with \`ANTHROPIC_BASE_URL=http://<host>:<port>\` and exit when
      claude exits. The running clawback keeps running.
    - If nothing is listening, start an in-process proxy and launch
      claude against it. The proxy shuts down when claude exits.
    - If something other than clawback is on the port, exit 2 rather
      than silently spinning up a second proxy on a different port.

  All arguments after \`claude\` are forwarded verbatim to the claude CLI,
  except for clawback-specific flags:

    --label <name>    Human-readable label for this session, shown in the
                      web UI's session filter. 1-64 chars; letters, digits,
                      dot, underscore, hyphen, internal space. Optional.
                      Default: the clawback id. With --remote (or a
                      configured remoteUrl) the registered label is
                      prefixed with this machine's hostname (e.g.
                      "alexmac:<label-or-id>") so sessions from different
                      machines stay distinguishable in one shared
                      dashboard. A local proxy shows the bare label.
    --remote <url>    Point the spawned claude at a clawback running
                      elsewhere (e.g. http://clawback.example.com:8888).
                      Skips the local probe + in-process proxy entirely:
                      no port is bound, no probe round-trip happens. The
                      URL is used as ANTHROPIC_BASE_URL (with the
                      per-session id appended) and as CLAWBACK_PROXY_URL,
                      so the statusline command — which curl's
                      \${CLAWBACK_PROXY_URL:-...} — automatically POSTs to
                      the remote instead of localhost. Best-effort label
                      registration goes to the remote's admin endpoint;
                      adminPathPrefix and adminToken still come from your
                      local CLAWBACK.md. TLS trust is your problem on
                      the remote path (set NODE_EXTRA_CA_CERTS yourself
                      if the remote uses a self-signed cert).
                      If you set \`remoteUrl\` in CLAWBACK.md (via
                      \`clawback remote <url>\` or by hand), it acts as
                      the persistent default; --remote on the CLI still
                      wins per-invocation.

  The clawback id is taken from \`--resume <xyz>\` if you pass it (so a
  resumed claude shares its prior metrics ring); otherwise a fresh 8-hex
  id is minted. The id appears in \`ANTHROPIC_BASE_URL\` as a path
  component (e.g. http://127.0.0.1:8080/a3f9b2c1), and is exposed to the
  spawned claude via CLAWBACK_SESSION_ID + CLAWBACK_PROXY_URL env vars.
  The statusline command (configured by \`clawback setup statusline\`)
  uses those vars to POST to /_proxy/statusline/<id>.

  Stdio is inherited.

Signals:
  SIGINT / SIGTERM / SIGHUP are forwarded to the claude child. In
  in-process mode the proxy shuts down once claude has exited.

Attach mode + cross-process input:
  When you attach to an already-running clawback on this machine, this
  launcher stands up a tiny loopback HTTP listener (random 127.0.0.1
  port, bearer-token authenticated) and registers it with the proxy
  via POST /_proxy/claude/register. The proxy's auto-continue and the
  GUI "continue" button then reach back through that listener to write
  into this PTY. The registration is cleared on exit.

  The reverse channel is skipped when (a) we didn't get a PTY (node-pty
  unavailable, or stdio isn't a TTY) or (b) the proxy is not on a
  loopback host (e.g. --remote to a different machine), since the
  remote proxy can't dial back into your NAT.

Tip:
  To pass ${first} to claude itself, separate it: \`clawback claude -- ${first}\`.
`);
		process.exit(0);
	}

	let peekedConfig;
	const claudeOverrides = {};
	try {
		const { config: peeked } = loadConfig({ cwd: process.cwd() });
		peekedConfig = peeked;
		if (!peeked.logFile) {
			claudeOverrides.logFile = path.join(
				path.dirname(path.resolve(peeked.stateFile)),
				"clawback.log",
			);
		}
	} catch (e) {
		process.stderr.write(`clawback claude: config error: ${e.message}\n`);
		process.exit(1);
	}

	// `--remote <url>` short-circuits: skip the local probe + in-process
	// proxy entirely and point the spawned claude at the remote clawback.
	// The local config is still consulted for adminPathPrefix and
	// adminToken (used by the best-effort session-label POST), but no
	// local port is bound and no probe round-trip happens. When the
	// CLI flag isn't supplied, fall back to the persistent
	// `remoteUrl` from CLAWBACK.md so an operator with a dev-box
	// proxy doesn't have to re-paste the URL every launch.
	const effectiveRemoteUrl = remoteUrl ?? peekedConfig.remoteUrl ?? null;

	// Origin-host prefix for the session-record label, gated on remote.
	// The prefix (`alexmac:<label-or-id>`) earns its keep only when this
	// machine reports into a clawback that *other* machines also report
	// into — i.e. a `--remote` (or configured remoteUrl) launch — so the
	// shared dashboard can attribute each session to its origin host. For
	// a local proxy the dashboard only ever shows this machine's sessions,
	// so the prefix is pure noise that buries the operator's chosen label;
	// there we record the bare `--label` (and post nothing when it's
	// absent, letting the UI fall back to the clawback id). `recordLabel`
	// feeds postSessionLabel only; the spawned claude's CLAWBACK_SESSION_LABEL
	// env always carries the operator's raw --label regardless of mode.
	let recordLabel;
	if (effectiveRemoteUrl != null) {
		const originHost = sanitizeHostSegment(os.hostname());
		const base = clawbackLabel ?? clawbackId;
		recordLabel = originHost ? composeSessionLabel(originHost, base) : base;
	} else {
		recordLabel = clawbackLabel;
	}

	if (effectiveRemoteUrl != null) {
		let result;
		try {
			result = await launchClaude({
				args: passthrough,
				config: peekedConfig,
				clawbackId,
				label: clawbackLabel,
				remoteUrl: effectiveRemoteUrl,
			});
		} catch (e) {
			process.stderr.write(`clawback claude: ${e.message}\n`);
			process.exit(2);
		}
		const { mode, baseUrl: launchedBaseUrl } = result;
		const remoteSource = remoteUrl != null ? "cli" : "config";
		process.stderr.write(
			`clawback claude: spawned claude (${mode}) -> ${launchedBaseUrl} [session=${clawbackId}${
				clawbackLabel ? `, label=${clawbackLabel}` : ""
			}, source=${clawbackIdSource}, remote=${remoteSource}]\n`,
		);
		await postSessionLabel(
			peekedConfig,
			clawbackId,
			recordLabel,
			result.proxyUrl,
		);
		await postSessionLabel(peekedConfig, clawbackId, clawbackLabel);
		const noopLogger = {
			info: () => {},
			warn: () => {},
			debug: () => {},
			error: () => {},
		};
		const exitCode = await runClaudeChild(result, { logger: noopLogger });
		process.exit(exitCode);
	}

	// PLAN §30.5: probe-then-decide. If a clawback is already listening on
	// the configured host:port, attach instead of trying to bind a second
	// one. If something else is on the port, refuse rather than silently
	// running a parallel proxy on a different port.
	const probe = await probeClawback({
		host: peekedConfig.host,
		port: peekedConfig.port,
		adminPathPrefix: peekedConfig.adminPathPrefix,
		tls: peekedConfig.tls === true,
	});

	if (probe.reachable && !probe.isClawback) {
		process.stderr.write(
			`clawback claude: ${peekedConfig.host}:${peekedConfig.port} is occupied by something that doesn't look like clawback (${probe.error}). Refusing to attach. Stop the other process or pick a different port.\n`,
		);
		process.exit(2);
	}

	if (probe.isClawback) {
		// The probe may have discovered the running proxy is serving TLS even
		// though this launch dir's config doesn't say so — the usual cause is a
		// proxy started on a non-loopback host (TLS auto-enables) while
		// `clawback claude` runs from a dir whose CLAWBACK.md has no tls key.
		// Re-point our view at https so buildBaseUrl emits the right scheme and
		// launchClaude wires NODE_EXTRA_CA_CERTS for the spawned claude. Best
		// effort on the cert: if the default self-signed path is absent we still
		// flip the scheme (the child may already trust the cert by other means).
		const serverTls = probe.tls === true || probe.info?.config?.tls === true;
		if (serverTls && !peekedConfig.tls) {
			peekedConfig.tls = true;
			if (!peekedConfig.tlsCertFile) {
				try {
					const { cert } = resolveDefaultCertPaths(process.env);
					if (fsSync.existsSync(cert)) peekedConfig.tlsCertFile = cert;
				} catch {}
			}
		}
		const baseUrl = buildBaseUrl(peekedConfig);
		process.stderr.write(
			`clawback claude: attached to running clawback at ${baseUrl}\n`,
		);

		let result;
		try {
			result = await launchClaude({
				args: passthrough,
				config: peekedConfig,
				clawbackId,
				label: clawbackLabel,
			});
		} catch (e) {
			process.stderr.write(`clawback claude: ${e.message}\n`);
			process.exit(2);
		}
		const { mode, baseUrl: launchedBaseUrl } = result;
		process.stderr.write(
			`clawback claude: spawned claude (${mode}) -> ${launchedBaseUrl} [session=${clawbackId}${
				clawbackLabel ? `, label=${clawbackLabel}` : ""
			}, source=${clawbackIdSource}]\n`,
		);
		await postSessionLabel(peekedConfig, clawbackId, recordLabel);

		// PLAN §30: reverse channel for cross-process attach. When we
		// got a PTY *and* the proxy is on this machine, stand up a
		// tiny loopback HTTP listener and register it with the proxy
		// so the proxy's auto-continue + GUI continue button can
		// reach back into this launcher's PTY. Skipped (with the
		// historical warning) when we didn't get a PTY (e.g. node-pty
		// unavailable) or the proxy is non-local.
		let callbackServer = null;
		const canReverseChannel =
			mode === "pty" && isLoopbackHost(peekedConfig.host);
		if (canReverseChannel) {
			try {
				callbackServer = await ptyCallbackServer.start({
					writer: (text) => result.ptyProcess.write(text),
					onError: (msg) => process.stderr.write(`clawback claude: ${msg}\n`),
				});
				const reg = await registerPtyCallback({
					config: peekedConfig,
					callbackUrl: callbackServer.url,
					token: callbackServer.token,
					label: clawbackLabel
						? `claude-remote:${clawbackLabel}`
						: `claude-remote:${clawbackId}`,
				});
				if (!reg.ok) {
					process.stderr.write(
						`clawback claude: PTY reverse-channel registration failed (${reg.status ?? reg.error}); auto-continue + GUI continue button will not reach this claude.\n`,
					);
					await callbackServer.close();
					callbackServer = null;
				} else {
					process.stderr.write(
						`clawback claude: PTY reverse-channel registered (${callbackServer.url})\n`,
					);
				}
			} catch (e) {
				process.stderr.write(
					`clawback claude: failed to start PTY reverse-channel: ${e.message}\n`,
				);
				callbackServer = null;
			}
		} else if (probe.info?.config?.autoContinue) {
			const why =
				mode !== "pty"
					? "no PTY (node-pty unavailable)"
					: "proxy is not on a loopback host";
			process.stderr.write(
				`clawback claude: warning: running clawback has --auto-continue on, but reverse-channel input routing is disabled here (${why}). Cap-clear will be observed by the server but no 'continue' will be injected into this claude.\n`,
			);
		}

		const noopLogger = {
			info: () => {},
			warn: () => {},
			debug: () => {},
			error: () => {},
		};
		let exitCode;
		try {
			exitCode = await runClaudeChild(result, { logger: noopLogger });
		} finally {
			if (callbackServer) {
				await unregisterPtyCallback({ config: peekedConfig });
				await callbackServer.close();
			}
		}
		process.exit(exitCode);
	}

	let started;
	try {
		started = await start({
			cliOverrides: claudeOverrides,
			installSignalHandlers: false,
		});
	} catch (e) {
		process.stderr.write(
			`clawback claude: failed to start proxy: ${e.message}\n`,
		);
		process.exit(1);
	}
	const { config, shutdown, logger } = started;
	process.stderr.write(`clawback claude: proxy logs -> ${config.logFile}\n`);

	let result;
	try {
		result = await launchClaude({
			args: passthrough,
			config,
			clawbackId,
			label: clawbackLabel,
		});
	} catch (e) {
		process.stderr.write(`clawback claude: ${e.message}\n`);
		// `shutdown` calls process.exit on its server-close callback,
		// but await it explicitly so we don't fall through to the
		// top-level command parser at the bottom of this file (which
		// would crash with ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL on
		// "claude" before shutdown finishes).
		await shutdown("claude-spawn-error", 2);
		process.exit(2);
	}
	if (result) {
		const { mode, baseUrl } = result;
		logger.info(
			`spawned claude (${mode}) with ANTHROPIC_BASE_URL=${baseUrl} [session=${clawbackId}${
				clawbackLabel ? `, label=${clawbackLabel}` : ""
			}, source=${clawbackIdSource}]`,
		);
		await postSessionLabel(config, clawbackId, recordLabel);

		const exitCode = await runClaudeChild(result, { logger });
		await shutdown(`claude exited (code=${exitCode})`, exitCode);
	}
} else if (process.argv[2] === "init") {
	const initArgs = parseArgs({
		args: process.argv.slice(3),
		options: {
			global: { type: "boolean" },
			local: { type: "boolean" },
			force: { type: "boolean", short: "f" },
			config: { type: "string", short: "c" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	}).values;

	if (initArgs.help) {
		process.stdout.write(`clawback init - create a config stub

Usage:
  clawback init [--global | --local] [--force] [--config <path>]

Options:
      --global         Write to \${XDG_CONFIG_HOME:-\$HOME/.config}/clawback/CLAWBACK.md
      --local          Write to ./CLAWBACK.md (default)
  -c, --config <path>  Write to an explicit path (overrides --global/--local)
  -f, --force          Overwrite an existing file
      --help           Show this help

Notes:
  Without --force, an existing file is left untouched (exits 0, prints "skipped").
  Defaults live in src/config.js. CLAWBACK.md is shallow-merged over them.
`);
		process.exit(0);
	}

	let result;
	try {
		result = initConfig({
			global: initArgs.global ?? false,
			local: initArgs.local ?? false,
			force: initArgs.force ?? false,
			configPath: initArgs.config ?? null,
		});
	} catch (e) {
		process.stderr.write(`clawback init: ${e.message}\n`);
		process.exit(2);
	}

	const giAction = result.gitignore?.action ?? null;
	const giAdded = result.gitignore?.added ?? [];
	const gitignoreLine =
		giAction === "created"
			? `  gitignore: created .gitignore with ${giAdded.join(", ")}\n`
			: giAction === "added"
				? `  gitignore: appended to .gitignore: ${giAdded.join(", ")}\n`
				: "";
	// If the gitignore concern is handled (file mutated or already had
	// every managed entry), drop the trailing reminder. Keep it when
	// the helper didn't run (global init, --config, or no .git dir) —
	// the operator still needs to know.
	const gitignoreHandled =
		giAction === "created" ||
		giAction === "added" ||
		giAction === "already-present";
	const reminder = gitignoreHandled
		? ""
		: "  Reminder: this file now holds a shared secret. Gitignore it, or\n" +
			"  move it to ${XDG_CONFIG_HOME:-$HOME/.config}/clawback/CLAWBACK.md\n" +
			"  if you check the repo in.\n";

	if (result.action === "skipped") {
		process.stdout.write(
			`clawback init: ${result.targetPath} already exists; pass --force to overwrite\n${gitignoreLine}`,
		);
		process.exit(0);
	}
	process.stdout.write(
		`clawback init: ${result.action} ${result.targetPath}\n  adminToken: generated (chmod 0600); see the file to read it.\n${gitignoreLine}${reminder}`,
	);
	process.exit(0);
} else if (process.argv[2] === "setup") {
	const SETUP_TARGETS = ["claude", "copilot"];
	const rawTarget = process.argv[3];
	// argv[3] is the target positional when present and not a flag. If
	// the operator skipped it and jumped straight to a flag (e.g.
	// `clawback setup --force`), `hasTarget` stays false so the
	// enforcement branch below catches it instead of silently treating
	// "--force" as the target name.
	const hasTarget = typeof rawTarget === "string" && !rawTarget.startsWith("-");
	const target = hasTarget ? rawTarget : null;
	const argSlice = hasTarget ? process.argv.slice(4) : process.argv.slice(3);

	let setupArgs;
	try {
		setupArgs = parseArgs({
			args: argSlice,
			options: {
				settings: { type: "string", short: "s" },
				project: { type: "boolean" },
				force: { type: "boolean", short: "f" },
				remote: { type: "string" },
				help: { type: "boolean" },
			},
			allowPositionals: false,
		}).values;
	} catch (e) {
		process.stderr.write(`clawback setup: ${e.message}\n`);
		process.exit(2);
	}

	if (setupArgs.help || target === "help") {
		process.stdout.write(`clawback setup <target> - wire an editor's statusLine
to clawback's /_proxy/statusline endpoint.

Usage:
  clawback setup <claude|copilot> [--settings <path>] [--project]
                                  [--force] [--remote <url>]

Targets:
  claude                 Wire Claude Code's statusLine (~/.claude/settings.json)
  copilot                Reserved — not yet implemented in this MVP

Options:
      --settings <path>  Explicit settings file path (overrides defaults)
      --project          Write to <cwd>/.claude/settings.json instead of
                         the user-level ~/.claude/settings.json
  -f, --force            Overwrite an existing statusLine block (default
                         is to refuse and exit 0 with "skipped"). Requires
                         an explicit target.
      --remote <url>     Bake a remote clawback URL as the default in the
                         statusline curl. Without this, the default is
                         your local host:port from CLAWBACK.md — fine
                         when claude runs alongside a local proxy, but
                         leaves bare claude sessions hitting nothing
                         useful when your clawback lives elsewhere. The
                         shell expansion \${CLAWBACK_PROXY_URL:-<default>}
                         means \`clawback claude --remote URL\` still wins
                         per-invocation; this just changes the fallback.
                         An https:// remote auto-adds curl -k.
                         If --remote isn't passed but \`remoteUrl\` is set
                         in CLAWBACK.md, that value is used as the
                         default instead. \`clawback remote <url>\` is
                         the operator-facing way to set the persistent
                         field.
      --help             Show this help

Notes:
  Other keys in settings.json are preserved (we merge, not overwrite).
  The clawback URL is built from the loaded config (host, port,
  admin-path-prefix), so this should be run with the same flags you'd
  use to launch the proxy.
`);
		process.exit(0);
	}

	// `--force` is destructive (overwrites an existing statusLine block),
	// so we won't accept it without an explicit target — silently
	// defaulting to "claude" here would be a footgun.
	if (setupArgs.force && !hasTarget) {
		process.stderr.write(
			`clawback setup: --force requires an explicit target. Use one of: ${SETUP_TARGETS.join(", ")}.\nExample: clawback setup claude --force\n`,
		);
		process.exit(2);
	}

	// If a target was given, it has to be one of the supported ones.
	// (When no target is given and no --force, fall through to the
	// historical default of "claude" — `clawback setup` keeps working.)
	const resolvedTarget = hasTarget ? target : "claude";
	if (!SETUP_TARGETS.includes(resolvedTarget)) {
		process.stderr.write(
			`clawback setup: unknown target '${resolvedTarget}'. Expected one of: ${SETUP_TARGETS.join(", ")}.\n`,
		);
		process.exit(2);
	}

	if (resolvedTarget === "copilot") {
		process.stderr.write(
			"clawback setup copilot: not yet implemented in this MVP.\n" +
				`Currently only the "claude" target is wired up.\n`,
		);
		process.exit(2);
	}

	let setupResult;
	try {
		const { config: peeked } = loadConfig();
		// CLI --remote wins; otherwise fall through to a persistent
		// `remoteUrl` in CLAWBACK.md. Same fallback chain as
		// `clawback claude`, so a single `clawback remote <url>` makes
		// both consumers point at the same remote without re-pasting.
		const effectiveRemote = setupArgs.remote ?? peeked.remoteUrl ?? null;
		setupResult = setupStatusline({
			settingsPath: setupArgs.settings ?? null,
			project: setupArgs.project ?? false,
			force: setupArgs.force ?? false,
			host: peeked.host,
			port: peeked.port,
			adminPathPrefix: peeked.adminPathPrefix,
			remoteUrl: effectiveRemote,
		});
	} catch (e) {
		process.stderr.write(`clawback setup ${resolvedTarget}: ${e.message}\n`);
		process.exit(2);
	}

	if (setupResult && setupResult.action === "skipped") {
		process.stdout.write(
			`clawback setup ${resolvedTarget}: ${setupResult.targetPath} ${setupResult.reason}\n`,
		);
		process.exit(0);
	}
	if (setupResult) {
		process.stdout.write(
			`clawback setup ${resolvedTarget}: ${setupResult.action} ${setupResult.targetPath}\n` +
				`  command: ${setupResult.command}\n`,
		);
		// Cross-tier drift guard: Claude Code resolves settings.local.json >
		// project settings.json > user settings.json, so a clawback statusLine
		// at a higher tier silently shadows the one just written (the failure
		// that sent a statusline dark on 2026-05-28 — a stale project block
		// overriding a fresh user block). Surface any other clawback block so
		// the operator isn't editing a file Claude Code ignores. Advisory only.
		try {
			const { conflicts } = detectStatuslineTierConflicts({
				targetPath: setupResult.targetPath,
			});
			for (const c of conflicts) {
				if (c.shadows === true) {
					process.stderr.write(
						`  warning: a clawback statusLine also exists at a HIGHER-precedence tier:\n             ${c.path} (${c.tier})\n           Claude Code will use THAT one, not the block just written.\n           Refresh or remove it so this write takes effect.\n`,
					);
				} else if (c.shadows === false) {
					process.stderr.write(
						`  note: a now-redundant clawback statusLine also exists at a lower tier:\n          ${c.path} (${c.tier})\n        The block just written overrides it.\n`,
					);
				} else {
					process.stderr.write(
						`  note: another clawback statusLine also exists at ${c.path} (${c.tier}).\n`,
					);
				}
			}
		} catch {
			/* advisory scan — never fail setup on it */
		}
	}
	process.exit(0);
} else if (process.argv[2] === "uninstall") {
	const target = process.argv[3] || "claude";
	const uninstallArgs = parseArgs({
		args: process.argv.slice(4),
		options: {
			settings: { type: "string", short: "s" },
			project: { type: "boolean" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	}).values;

	if (uninstallArgs.help || target === "help") {
		process.stdout.write(`clawback uninstall claude - inverse of \`clawback setup claude\`.
Strips the statusLine block from Claude Code's settings.

Usage:
  clawback uninstall claude [--settings <path>] [--project]

Options:
      --settings <path>  Explicit settings file path (overrides defaults)
      --project          Remove from <cwd>/.claude/settings.json instead
                         of the user-level ~/.claude/settings.json
      --help             Show this help

Notes:
  Other keys in settings.json are preserved. If statusLine was the
  only key, the file itself is removed. Idempotent — running twice
  with no statusLine present is a no-op.
`);
		process.exit(0);
	}

	let uninstallResult;
	try {
		uninstallResult = uninstallStatusline({
			settingsPath: uninstallArgs.settings ?? null,
			project: uninstallArgs.project ?? false,
		});
	} catch (e) {
		process.stderr.write(`clawback uninstall ${target}: ${e.message}\n`);
		process.exit(2);
	}

	const msg = (() => {
		switch (uninstallResult.action) {
			case "missing":
				return `${uninstallResult.targetPath} not found; nothing to remove`;
			case "no-statusline":
				return `${uninstallResult.targetPath} has no statusLine; nothing to remove`;
			case "removed":
				return `${uninstallResult.action} statusLine from ${uninstallResult.targetPath}`;
			case "removed-file":
				return `removed ${uninstallResult.targetPath} (statusLine was the only key)`;
			default:
				return `${uninstallResult.action} ${uninstallResult.targetPath}`;
		}
	})();
	process.stdout.write(`clawback uninstall ${target}: ${msg}\n`);
	process.exit(0);
} else if (process.argv[2] === "init-cert") {
	const initCertArgs = parseArgs({
		args: process.argv.slice(3),
		options: {
			"out-dir": { type: "string" },
			force: { type: "boolean", short: "f" },
			mkcert: { type: "boolean" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	}).values;

	if (initCertArgs.help) {
		const defaults = resolveDefaultCertPaths();
		process.stdout.write(`clawback init-cert - generate a TLS cert + key

Usage:
  clawback init-cert [--out-dir <path>] [--mkcert] [--force]

Options:
      --out-dir <path>  Directory to write cert.pem and key.pem into
                        (default ${defaults.dir})
      --mkcert          Issue from your local mkcert CA instead of a
                        self-signed cert, so browsers trust it (no warning)
  -f, --force           Overwrite existing files (default: refuse and exit 0)
      --help            Show this help

Notes:
  Default: shells out to \`openssl req -x509\` to mint a 365-day self-signed
  cert with SANs covering localhost, 127.0.0.1, and ::1. The private key is
  written unencrypted (no passphrase) with mode 0600. Self-signed means
  browsers show "Not secure" until you trust the cert by hand.

  --mkcert: shells out to \`mkcert\` to issue the cert from a locally-trusted
  CA, so Chrome/Safari/Firefox show a clean padlock. Requires mkcert
  (\`brew install mkcert\`) and a one-time \`mkcert -install\` to register the
  CA in your trust stores. clawback does not run \`mkcert -install\` for you —
  it mutates system trust and may prompt for a password.

  Either way, \`clawback --tls on\` picks up the cert from the default path
  automatically.
`);
		process.exit(0);
	}

	let certResult;
	try {
		certResult = initCert({
			outDir: initCertArgs["out-dir"] ?? null,
			force: initCertArgs.force ?? false,
			mkcert: initCertArgs.mkcert ?? false,
		});
	} catch (e) {
		process.stderr.write(`clawback init-cert: ${e.message}\n`);
		process.exit(2);
	}

	if (certResult.action === "skipped") {
		process.stdout.write(
			`clawback init-cert: ${certResult.certPath} already exists; pass --force to overwrite\n`,
		);
		process.exit(0);
	}
	let trustNote;
	if (certResult.tool === "mkcert") {
		// mkcert's leaf is only trusted once its CA is in the trust store. We
		// never run `mkcert -install` (system mutation + password prompt), so
		// point the operator at the idempotent one-time step instead.
		trustNote =
			"Issued from your local mkcert CA. If the browser still warns, run\n" +
			"  mkcert -install\n" +
			"once (idempotent) to register the CA, then relaunch the browser.\n";
	} else {
		// Self-signed: browsers warn until trusted. Echo the macOS keychain
		// one-liner (matches the auto-provision hint in src/index.js) and the
		// trusted-CA alternative.
		trustNote = `Self-signed: browsers show "Not secure" until trusted. To trust on macOS:\n  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certResult.certPath}\nor re-run with --mkcert for a locally-trusted CA (no warning).\n`;
	}
	process.stdout.write(
		`clawback init-cert: ${certResult.action} cert + key (${certResult.tool})\n  cert: ${certResult.certPath}\n  key:  ${certResult.keyPath}\nStart clawback with --tls on (or set 'tls: true' in CLAWBACK.md) to use them.\n${trustNote}`,
	);
	process.exit(0);
} else if (process.argv[2] === "doctor") {
	const doctorArgs = parseArgs({
		args: process.argv.slice(3),
		options: {
			help: { type: "boolean" },
		},
		allowPositionals: false,
	}).values;

	if (doctorArgs.help) {
		process.stdout.write(`clawback doctor - diagnose statusline / proxy health

Usage:
  clawback doctor

Runs three checks and prints a pass/warn/fail report:
  config   which Claude Code settings tier supplies the active statusLine,
           and whether a clawback block at another tier shadows it
  command  runs that exact statusLine command with a sample payload and
           classifies the output (catches a missing -k/-L or a down proxy
           hidden by the baked \`|| true\`)
  proxy    independently probes the proxy to confirm it's up and is clawback

Reads host / port / admin-path-prefix from the loaded config, so run it with
the same flags you'd use to launch the proxy. Exits non-zero if any check
fails.
`);
		process.exit(0);
	}

	const { config: doctorConfig } = loadConfig();
	const report = await runDoctor({ config: doctorConfig });

	const LABEL = {
		pass: "[ ok ]",
		warn: "[warn]",
		fail: "[FAIL]",
		skip: "[skip]",
	};
	process.stdout.write("clawback doctor\n");
	for (const c of report.checks) {
		process.stdout.write(
			`  ${LABEL[c.status] ?? "[ ?? ]"} ${c.name}: ${c.message}\n`,
		);
	}
	const failed = report.checks.filter((c) => c.status === "fail").length;
	const warned = report.checks.filter((c) => c.status === "warn").length;
	if (report.ok) {
		process.stdout.write(
			warned > 0
				? `\nNo failures, but ${warned} warning(s) — see above.\n`
				: "\nAll checks passed.\n",
		);
	} else {
		process.stdout.write(`\n${failed} check(s) failed — see above.\n`);
	}
	process.exit(report.ok ? 0 : 1);
} else if (process.argv[2] === "quickstart") {
	const qsArgs = parseArgs({
		args: process.argv.slice(3),
		options: {
			help: { type: "boolean" },
			force: { type: "boolean", short: "f" },
			project: { type: "boolean" },
			"no-launch": { type: "boolean" },
		},
		allowPositionals: false,
	}).values;

	if (qsArgs.help) {
		process.stdout.write(`clawback quickstart - one-command setup + launch

Usage:
  clawback quickstart [--project] [--force] [--no-launch]
  clawback quick      ...   alias for \`clawback quickstart\`
  clawback up         ...   alias for \`clawback quickstart\`

Behavior:
  Sets up clawback with a default-good config and launches claude:
    1. clawback init --local        (creates ./CLAWBACK.md if absent)
    2. overlays default-good knobs  (host=0.0.0.0, keepAliveModeExtended=true)
    3. clawback setup claude        (wires the Claude Code statusline)
    4. clawback claude --label clawback
                                    (launches claude pointed at clawback;
                                     the "clawback" label tags this session
                                     in the dashboard's session filter)
    5. opens the dashboard in your default browser once the proxy is
       reachable (suppress with CLAWBACK_NO_OPEN_BROWSER=1)

  The host=0.0.0.0 overlay also mints an adminToken into the config
  when one is missing, so the LAN bind is always paired with a shared
  secret. Mutating endpoints are bearer-gated; GETs stay open and
  expose session metadata to the LAN — see README "Securing a
  non-loopback bind".

  Step 4 and the browser open are skipped when --no-launch is passed,
  which is useful in scripts and tests.

Options:
      --project    Write the statusline to <cwd>/.claude/settings.json
                   (project scope) instead of ~/.claude/settings.json
  -f, --force      Re-run init + setup even when targets already exist
      --no-launch  Stop after step 3; don't launch claude
      --help       Show this help

Notes:
  Idempotent. Existing CLAWBACK.md / settings.json files are left
  alone unless --force.
`);
		process.exit(0);
	}

	let qsResult;
	try {
		qsResult = runQuickstart({
			force: qsArgs.force ?? false,
			project: qsArgs.project ?? false,
			loadConfigFn: () => loadConfig({ cwd: process.cwd() }),
		});
	} catch (e) {
		process.stderr.write(`clawback quickstart: ${e.message}\n`);
		process.exit(2);
	}

	const initLine =
		qsResult.init.action === "skipped"
			? `clawback quickstart: ${qsResult.init.targetPath} already exists; left alone`
			: qsResult.init.action === "defaults-overlaid"
				? `clawback quickstart: ${qsResult.init.targetPath} kept; added defaults (${qsResult.init.overlaidKeys.join(", ")})`
				: `clawback quickstart: ${qsResult.init.action} ${qsResult.init.targetPath} (with ${qsResult.init.overlaidKeys.join(", ") || "no overlays"})`;
	process.stdout.write(`${initLine}\n`);
	if (qsResult.init.adminTokenMinted) {
		process.stdout.write(
			`clawback quickstart: adminToken generated in ${qsResult.init.targetPath} (chmod 0600). Gitignore that file.\n`,
		);
	}

	const setupLine =
		qsResult.setup.action === "skipped"
			? `clawback quickstart: statusline already wired at ${qsResult.setup.targetPath}; left alone`
			: `clawback quickstart: ${qsResult.setup.action} statusline at ${qsResult.setup.targetPath}`;
	process.stdout.write(`${setupLine}\n`);

	// We force-wired clawback's statusline over a statusLine the operator
	// already had at this tier (because clawback's wasn't the effective
	// block — setup "hadn't been run yet"). Surface what we displaced and
	// how to get it back, so the overwrite isn't a silent surprise.
	if (qsResult.setup.replacedForeign && qsResult.setup.previous) {
		const prev = qsResult.setup.previous;
		const prevDesc =
			typeof prev.command === "string" ? prev.command : JSON.stringify(prev);
		process.stdout.write(
			`clawback quickstart: replaced your existing (non-clawback) statusLine to wire clawback's metrics.\n  previous: ${prevDesc}\n  to restore it, edit ${qsResult.setup.targetPath} (or run \`clawback uninstall\` to drop clawback's).\n`,
		);
	}

	// The wire landed, but a higher-precedence statusLine at another Claude
	// Code settings tier still shadows it — so the statusline stays dark
	// until the operator resolves it. clawback writes one tier and won't
	// silently delete a block at a tier it didn't target.
	if (qsResult.setup.shadowedBy) {
		process.stderr.write(
			`clawback quickstart: warning: a higher-precedence statusLine at ${qsResult.setup.shadowedBy.path} (${qsResult.setup.shadowedBy.tier}) will shadow the block just written.\n  Claude Code renders THAT one. Remove or refresh it, or re-run with the tier it lives in, e.g. \`clawback setup claude --project --force\`.\n`,
		);
	}

	// Resolve the dashboard URL from the loaded config so the print + open
	// match whatever host/port/TLS the quickstart actually started with.
	const qsConfig = loadConfig({ cwd: process.cwd() }).config;
	const qsScheme = qsConfig.tls === true ? "https" : "http";
	const qsHost =
		qsConfig.host === "0.0.0.0" || qsConfig.host === "::"
			? "127.0.0.1"
			: (qsConfig.host ?? "127.0.0.1");
	const qsPort = qsConfig.port ?? 8080;
	const qsAdminPrefix = qsConfig.adminPathPrefix ?? "_proxy";
	const dashboardUrl = `${qsScheme}://${qsHost}:${qsPort}/${qsAdminPrefix}/ui/`;
	const healthUrl = `${qsScheme}://${qsHost}:${qsPort}/${qsAdminPrefix}/health`;
	// Bake the token into the auto-opened URL as a fragment so the UI
	// boots already-authorized for LAN clients (loopback is exempt from
	// the bearer check at `admin.js`, but a phone hitting this same URL
	// over 192.168.x is not, and the UI's DELETE/POST buttons would 401
	// without the token). The fragment is read by `src/ui/app.js`, saved
	// to localStorage, then stripped from the address bar.
	const dashboardUrlWithToken = qsConfig.adminToken
		? `${dashboardUrl}#token=${encodeURIComponent(qsConfig.adminToken)}`
		: dashboardUrl;
	process.stdout.write(
		`clawback quickstart: dashboard will auto-open at ${dashboardUrl}\n`,
	);
	if (qsConfig.adminToken) {
		// Surface the token directly so the operator can (a) authorize the
		// dashboard when loading it on a phone/other host, and (b) attach
		// remote `clawback claude` sessions to this proxy. Printed every
		// run — not just when freshly minted — because a quickstart that
		// reused an existing token still needs to surface it for use.
		process.stdout.write(
			`clawback quickstart: adminToken: ${qsConfig.adminToken}\n`,
		);
		process.stdout.write(
			`clawback quickstart: dashboard (with token):\n  ${dashboardUrlWithToken}\n`,
		);
		// Attach-from-another-machine hint. We deliberately don't try to
		// detect the operator's LAN address — multi-NIC laptops, VPNs,
		// and Docker bridges all conspire to make any "auto-detected" IP
		// wrong some of the time. `<this-host>` is an obvious placeholder
		// the operator substitutes with whatever name resolves on the
		// network they care about (LAN IP, Tailscale name, `.local`).
		const attachHost =
			qsConfig.host === "0.0.0.0" || qsConfig.host === "::"
				? "<this-host>"
				: qsHost;
		process.stdout.write(
			`clawback quickstart: attach another machine with:\n  clawback claude --remote ${qsScheme}://${attachHost}:${qsPort} --admin-token ${qsConfig.adminToken}\n`,
		);
	}
	if (qsConfig.host === "0.0.0.0" || qsConfig.host === "::") {
		process.stdout.write(
			`clawback quickstart: bound to ${qsConfig.host} (LAN-reachable); mutating endpoints gated by adminToken, GETs open.\n`,
		);
	}

	if (qsArgs["no-launch"]) {
		process.stdout.write(
			"clawback quickstart: --no-launch set; skipping claude\n",
		);
		process.exit(0);
	}

	process.stdout.write("clawback quickstart: launching claude...\n");
	// Default label "clawback" so quickstart-launched sessions show a
	// stable, recognizable name in the dashboard's session filter. The
	// operator can override by re-running with their own `clawback claude
	// --label <name>` invocation; this is just the quickstart default.
	const child = spawn(
		process.execPath,
		[process.argv[1], "claude", "--label", "clawback"],
		{ stdio: "inherit" },
	);

	// Wait for the in-process proxy (spawned by `clawback claude`) to be
	// reachable, then open the browser. Best-effort: if the probe times
	// out or the open fails, the operator still saw the URL printed
	// above and can open it themselves. `CLAWBACK_NO_OPEN_BROWSER=1`
	// suppresses the open entirely for headless / CI use.
	//
	// Diagnostics are appended to clawback.log (the proxy's log file) so
	// post-session debugging is possible — by the time the IIFE fires,
	// claude's TUI has hidden any stderr we'd write directly.
	(async () => {
		const reachable = await waitForUrl(healthUrl, { timeoutMs: 15000 });
		const logPath = path.join(
			path.dirname(path.resolve(qsConfig.stateFile ?? "data/state.json")),
			"clawback.log",
		);
		const stamp = () => new Date().toISOString();
		const note = (msg) => {
			try {
				fsSync.appendFileSync(
					logPath,
					`${stamp()} [info] quickstart: ${msg}\n`,
				);
			} catch {
				/* best-effort */
			}
		};
		if (!reachable) {
			note(
				`proxy at ${healthUrl} not reachable in 15s; skipping browser open. Open ${dashboardUrlWithToken} manually.`,
			);
			return;
		}
		// Open the token-bearing URL so the UI is authorized on first
		// paint. On loopback this is no-op extra (the bearer check is
		// skipped there); for the LAN-reach case it's load-bearing.
		const opened = openBrowser(dashboardUrlWithToken);
		note(
			opened
				? `opened dashboard ${dashboardUrl} in default browser`
				: `openBrowser returned false (CLAWBACK_NO_OPEN_BROWSER set, or spawn threw). Open ${dashboardUrlWithToken} manually.`,
		);
	})().catch(() => {
		/* best-effort; swallow */
	});

	// Block until the child exits, then exit with its code. Do NOT fall
	// through: the top-level `clawback` command parser at the bottom of
	// this file calls `parseArgs({ allowPositionals: false })`, which
	// would synchronously throw ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL on
	// "quickstart" — killing the parent before the child can attach to
	// the controlling TTY, and presenting to the operator as a hang.
	const qsExitCode = await new Promise((resolve) => {
		child.on("exit", (code, signal) => resolve(signal ? 128 : (code ?? 0)));
		child.on("error", (e) => {
			process.stderr.write(
				`clawback quickstart: failed to spawn clawback claude: ${e.message}\n`,
			);
			resolve(127);
		});
	});
	process.exit(qsExitCode);
} else if (process.argv[2] === "clean") {
	const cleanArgs = parseArgs({
		args: process.argv.slice(3),
		options: {
			force: { type: "boolean", short: "f" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	}).values;

	if (cleanArgs.help) {
		process.stdout.write(`clawback clean - remove generated data files

Usage:
  clawback clean [--force]

Behavior:
  Removes the files clawback writes under the launch directory:
    - state file        sessions + captured OAuth bearer
    - turn-log file     per-turn NDJSON log
    - log file          proxy log (when --log-file is set)
    - session log dir   per-session logs

  After removal, empty parent dirs (data/, logs/) are tidied. The
  config file (CLAWBACK.md) is NOT touched — your adminToken and
  customizations are preserved. Remove it yourself if you also want
  the config gone.

Options:
  -f, --force   Actually delete. Without --force, clean only previews
                what would be removed and warns to re-run with --force.
      --help    Show this help

Tip:
  After \`clawback clean --force\`, the next \`clawback claude\` or
  \`clawback quickstart\` boots a fresh proxy — which auto-arms a
  baseline-capture window so you can see clawback's effect against
  a clean reference.
`);
		process.exit(0);
	}

	let cleanConfig;
	try {
		cleanConfig = loadConfig({ cwd: process.cwd() }).config;
	} catch (e) {
		process.stderr.write(`clawback clean: config error: ${e.message}\n`);
		process.exit(2);
	}

	const cleanTargets = resolveCleanTargets({
		config: cleanConfig,
		cwd: process.cwd(),
	});
	const cleanInspected = inspectTargets(cleanTargets);
	const cleanExisting = cleanInspected.filter((t) => t.kind != null);

	if (cleanExisting.length === 0) {
		process.stdout.write("clawback clean: nothing to remove\n");
		process.exit(0);
	}

	if (!cleanArgs.force) {
		process.stdout.write(
			"clawback clean: would remove the following (re-run with --force to actually delete):\n",
		);
		for (const t of cleanExisting) {
			const tag = t.kind === "dir" ? "dir " : "file";
			process.stdout.write(`  ${tag} ${t.path}\n`);
		}
		process.exit(0);
	}

	let cleanRemoved;
	try {
		cleanRemoved = removeTargets(cleanTargets);
	} catch (e) {
		process.stderr.write(`clawback clean: ${e.message}\n`);
		process.exit(2);
	}
	const word = cleanRemoved.length === 1 ? "entry" : "entries";
	process.stdout.write(
		`clawback clean: removed ${cleanRemoved.length} ${word}\n`,
	);
	for (const p of cleanRemoved) {
		process.stdout.write(`  ${p}\n`);
	}
	process.exit(0);
} else if (process.argv[2] === "remote") {
	// `clawback remote <url> [--global|--local]` — persist a remote
	// clawback URL into the chosen config file so subsequent
	// `clawback claude` / `clawback setup claude` invocations honor it
	// without re-typing. `clawback remote --clear` removes the field.
	// Default scope is global because "I have a dev-box clawback I
	// want my laptop to use from any project" is a per-machine pref,
	// not a per-repo one. The first positional after `remote` is the
	// URL; everything starting with `-` is parsed as a flag.
	const remoteRaw = process.argv.slice(3);
	let urlArg = null;
	const flagSlice = [];
	for (const arg of remoteRaw) {
		if (arg.startsWith("-")) {
			flagSlice.push(arg);
		} else if (urlArg == null) {
			urlArg = arg;
		} else {
			process.stderr.write(
				`clawback remote: unexpected extra argument '${arg}'. Pass at most one URL.\n`,
			);
			process.exit(2);
		}
	}

	let remoteArgs;
	try {
		remoteArgs = parseArgs({
			args: flagSlice,
			options: {
				global: { type: "boolean" },
				local: { type: "boolean" },
				config: { type: "string", short: "c" },
				clear: { type: "boolean" },
				help: { type: "boolean" },
			},
			allowPositionals: false,
		}).values;
	} catch (e) {
		process.stderr.write(`clawback remote: ${e.message}\n`);
		process.exit(2);
	}

	if (remoteArgs.help) {
		process.stdout.write(`clawback remote - set or clear the persistent remote clawback URL

Usage:
  clawback remote <url> [--global | --local] [--config <path>]
  clawback remote --clear [--global | --local] [--config <path>]

Behavior:
  Writes \`remoteUrl\` into the chosen clawback config file. After this,
  \`clawback claude\` skips the local probe and points the spawned claude
  at <url> on every invocation; \`clawback setup claude\` bakes the same
  URL into the statusline curl's default fallback. The CLI flag
  \`--remote <url>\` still wins per-invocation.

  Default scope is --global (\${XDG_CONFIG_HOME:-\$HOME/.config}/clawback/
  CLAWBACK.md) so one paste makes every project on this machine talk to
  the same dev-box clawback. Pass --local for per-project overrides
  (writes to ./CLAWBACK.md), or --config <path> for an explicit target.

Options:
      --global         Write to the global XDG config (default)
      --local          Write to ./CLAWBACK.md
  -c, --config <path>  Write to an explicit path
      --clear          Remove the remoteUrl field instead of setting it
      --help           Show this help

Notes:
  - The URL is normalized at write time (trailing slash stripped, scheme
    validated). Invalid URLs are rejected with a clear message.
  - The target file is created if missing. Existing fields (port,
    statusline thresholds, adminToken, etc.) are preserved by shallow
    merge — only \`remoteUrl\` is touched.
  - TLS trust is your problem on the remote path (set NODE_EXTRA_CA_CERTS
    if the remote uses a self-signed cert).
  - PTY-mediated features (auto-continue, the UI's "continue" button)
    don't reach the launcher's claude over a remote proxy yet; see
    PLAN §21 for the post-MVP SSE design. Passive observability (the
    UI, the statusline, metrics, suggestions) works today.
`);
		process.exit(0);
	}

	let remoteResult;
	try {
		remoteResult = setRemoteUrl({
			url: urlArg,
			clear: remoteArgs.clear ?? false,
			global: remoteArgs.global ?? false,
			local: remoteArgs.local ?? false,
			configPath: remoteArgs.config ?? null,
		});
	} catch (e) {
		process.stderr.write(`clawback remote: ${e.message}\n`);
		process.exit(2);
	}

	if (remoteResult.action === "cleared-noop") {
		process.stdout.write(
			`clawback remote: ${remoteResult.path} has no remoteUrl set; nothing to clear\n`,
		);
		process.exit(0);
	}
	if (remoteResult.action === "cleared") {
		process.stdout.write(
			`clawback remote: cleared remoteUrl=${remoteResult.previous} from ${remoteResult.path}\n`,
		);
		process.exit(0);
	}
	const verb = remoteResult.action === "set" ? "set" : "updated";
	const fromClause =
		remoteResult.action === "updated" && remoteResult.previous
			? ` (was: ${remoteResult.previous})`
			: "";
	process.stdout.write(
		`clawback remote: ${verb} remoteUrl=${remoteResult.remoteUrl} in ${remoteResult.path}${fromClause}\n  next \`clawback claude\` will point at this URL automatically (CLI --remote still wins).\n`,
	);
	process.exit(0);
} else if (process.argv[2] !== undefined && !process.argv[2].startsWith("-")) {
	process.stderr.write(
		`clawback: unknown subcommand '${process.argv[2]}'. Try 'clawback --help'.\n`,
	);
	process.exit(2);
}

// Guard: subcommands that reach this point mean their dispatcher branch
// above forgot to process.exit. parseArgs below runs with
// allowPositionals:false and would crash on the positional with an
// opaque ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL — presenting as a hang.
const KNOWN_SUBCOMMANDS = new Set([
	"claude",
	"init",
	"setup",
	"uninstall",
	"init-cert",
	"doctor",
	"quickstart",
	"clean",
	"remote",
]);
if (KNOWN_SUBCOMMANDS.has(process.argv[2])) {
	process.stderr.write(
		`clawback: internal error: subcommand '${process.argv[2]}' fell through the dispatcher in bin/clawback.js (its branch did not call process.exit). Please report a bug.\n`,
	);
	process.exit(70);
}

const { values } = parseArgs({
	options: {
		host: { type: "string", short: "h" },
		port: { type: "string", short: "p" },
		config: { type: "string", short: "c" },
		state: { type: "string", short: "s" },
		upstream: { type: "string", short: "u" },
		"grace-hours": { type: "string" },
		"session-max-idle-hours": { type: "string" },
		"dead-session-max-idle-hours": { type: "string" },
		"gc-sweep-interval-sec": { type: "string" },
		"keep-alive-min-sec": { type: "string" },
		"keep-alive-max-sec": { type: "string" },
		"keep-alive-min-sec-extended": { type: "string" },
		"keep-alive-max-sec-extended": { type: "string" },
		"keep-alive-min-prefix-bytes": { type: "string" },
		"keep-alive-cold-ping-max": { type: "string" },
		"inject-extended-cache-ttl": { type: "string" },
		"rewrite-nested-cache-control": { type: "string" },
		"strip-extended-cache-ttl": { type: "string" },
		"keep-alive-mode-extended": { type: "string" },
		"log-level": { type: "string" },
		passthrough: { type: "boolean" },
		baseline: { type: "boolean" },
		"keep-alive": { type: "string" },
		"turn-log": { type: "string" },
		"no-turn-log": { type: "boolean" },
		"admin-path": { type: "string" },
		"report-dir": { type: "string" },
		"log-file": { type: "string" },
		"session-log-dir": { type: "string" },
		"no-session-log-dir": { type: "boolean" },
		"strip-ephemeral-from-system": { type: "string" },
		"capture-body": { type: "string" },
		"auto-continue": { type: "boolean" },
		"auto-continue-text": { type: "string" },
		"auto-continue-cooldown-sec": { type: "string" },
		"upstream-from-env": { type: "boolean" },
		mobile: { type: "boolean" },
		"gzip-outgoing": { type: "string" },
		"force-non-streaming": { type: "string" },
		"account-global-quota": { type: "string" },
		"statusline-prefix": { type: "string" },
		"statusline-max-chars": { type: "string" },
		"statusline-progress-bar-length": { type: "string" },
		"statusline-color": { type: "string" },
		"statusline-pct-threshold-low": { type: "string" },
		"statusline-pct-threshold-high": { type: "string" },
		"statusline-ttft-threshold-low-ms": { type: "string" },
		"statusline-ttft-threshold-high-ms": { type: "string" },
		"statusline-tps-threshold-low": { type: "string" },
		"statusline-tps-threshold-high": { type: "string" },
		"statusline-tps-calibration": { type: "string" },
		"statusline-ttft-calibration": { type: "string" },
		"admin-token": { type: "string" },
		tls: { type: "string" },
		"tls-cert": { type: "string" },
		"tls-key": { type: "string" },
		"self-sign": { type: "boolean" },
		help: { type: "boolean" },
		version: { type: "boolean" },
	},
	allowPositionals: false,
});

if (values.help) {
	process.stdout.write(`clawback - prompt-cache-warming proxy for Claude Code

Usage:
  clawback [options]
  clawback quickstart [--project] [--force]      one-command setup + launch
                                                 (init + setup + claude;
                                                 \`clawback quick\` / \`clawback up\` are aliases)
  clawback clean [--force]                       remove generated data
                                                 (state, turn log, session logs)
  clawback init [--global | --local] [--force]   create a config stub
  clawback init-cert [--mkcert] [--force]        generate a TLS cert + key for
                                                 --tls on (--mkcert = browser-
                                                 trusted via local CA)
  clawback setup claude [--project] [--force]    wire Claude Code's statusLine
                                                 to clawback's /_proxy/statusline
  clawback doctor                                diagnose statusline / proxy
                                                 health (tier conflicts, the
                                                 baked curl, reachability)
  clawback remote <url> [--global | --local]     persist a remote clawback URL
                                                 so \`clawback claude\` skips
                                                 the local probe and points
                                                 at <url> on every launch
                                                 (\`--clear\` to unset)
  clawback claude [claude-args...]               start the proxy and launch
                                                 claude as a child process
                                                 pointed at it

Options:
  -h, --host <host>             Bind host (default 127.0.0.1). Binding
                                beyond loopback (e.g. 0.0.0.0) requires
                                --admin-token to be set; clawback exposes
                                write endpoints (including PTY input
                                injection) and refuses to start with a
                                LAN-reachable bind and no auth.
  -p, --port <port>             Bind port (default 8080)
  -c, --config <path>           Path to JSON config file. If omitted,
                                clawback auto-discovers ./CLAWBACK.md
                                in the launch directory. Explicit --config
                                always wins; CLI flags win over both.
  -s, --state <path>            State file path (default data/state.json)
  -u, --upstream <url>          Upstream base URL (default https://api.anthropic.com)
      --upstream-from-env       Capture ANTHROPIC_BASE_URL from the parent env
                                as the upstream. Lets the operator keep their
                                existing shell setup (corporate proxy, region
                                endpoint, etc.) and just point claude at
                                clawback. CLI --upstream wins over the env
                                if both are present. clawback aborts with a
                                clear error if the env points at clawback's
                                own bind (would self-loop).
      --grace-hours <n>         Hours past rate-limit reset to keep pinging (default 5)
      --session-max-idle-hours <n>
                                Hours since last real client request before a
                                session is considered abandoned and GC'd by the
                                sweep — including authStale sessions whose
                                per-session timer is cancelled (default 12)
      --dead-session-max-idle-hours <n>
                                Shorter idle window for authStale sessions only
                                (keep-alive already 401'd, warming nothing).
                                ~5h rate-limit reset + buffer (default 6).
                                0 disables this fast-path.
      --gc-sweep-interval-sec <n>
                                Seconds between GC sweeps over all sessions
                                (default 300). Set 0 to disable the periodic
                                sweep (the sweep on start() still runs once).
      --keep-alive-min-sec <n>  Keep-alive min interval in seconds (default 60)
      --keep-alive-max-sec <n>  Keep-alive max interval in seconds (default 240)
      --keep-alive-min-sec-extended <n>
                                Extended-mode min interval in seconds (default 900)
      --keep-alive-max-sec-extended <n>
                                Extended-mode max interval in seconds (default 2700)
      --keep-alive-min-prefix-bytes <n>
                                Skip keep-alive for a cacheable prefix (system+tools)
                                smaller than <n> bytes — Anthropic won't cache a
                                sub-minimum prefix, so pinging it writes nothing
                                (default 1024; 0 disables the gate).
      --keep-alive-cold-ping-max <n>
                                Cancel a session's keep-alive after <n> consecutive
                                fully-cold pings (cache_read=0 AND cache_creation=0) —
                                proof the prefix is below Anthropic's token-cache
                                minimum, which the byte gate above can't see
                                (default 2; 0 disables).
      --inject-extended-cache-ttl <on|off>
                                Inject top-level cache_control ttl=1h on forwarded requests and pings (default on)
      --rewrite-nested-cache-control <on|off>
                                Rewrite per-block cache_control to ttl=1h inside system/tools/messages.
                                Without this the 1h knob is silently a no-op for Claude Code traffic
                                (the dominant client sets per-block cache_control on every turn).
                                Default on; only meaningful when --inject-extended-cache-ttl is on too.
      --strip-extended-cache-ttl <on|off>
                                Inverse of --inject-extended-cache-ttl: strip the client's own
                                ttl=1h cache_control back to Anthropic's documented 5m default.
                                Claude Code natively breakpoints its system prompt at 1h
                                (undocumented), so an operator never gets the 5m tier unless
                                this downgrades it. On a TIGHT loop the 1h write premium buys
                                nothing (reads land inside 5m), and forcing 5m is also an
                                anti-regression lever — you pick the tier instead of the client.
                                Strip WINS over inject if both are on. Default off.
      --keep-alive-mode-extended <on|off>
                                Use extended-mode cadence for keep-alive pings (default off)
      --keep-alive <on|off>     Enable/disable the keep-alive ping scheduler
                                (default on). Use this to baseline cache hit/miss
                                with clawback's strip + cache_control injection
                                still active but no ping intervention.
      --passthrough, --baseline Run as a pure byte-forwarding proxy. Forces
                                injectExtendedCacheTtl=false,
                                stripEphemeralFromSystem=false, and
                                keepAliveEnabled=false. Use as the raw baseline
                                arm (no clawback intervention on the wire).
                                --baseline is just a more readable spelling.
      --turn-log <path>         Append one NDJSON record per forwarded /v1/messages
                                request to this file (default data/turns.ndjson —
                                pass --no-turn-log to disable)
      --no-turn-log             Disable the per-turn NDJSON log entirely. Wins
                                over --turn-log if both are passed.
      --log-file <path>         Write proxy logs to this file instead of stdout/stderr.
                                In \`clawback claude\` mode this defaults to
                                <state-dir>/clawback.log so the TUI stays clean.
      --session-log-dir <path>  Directory for per-session log files. Each session
                                with a sessionKey gets its lines tee'd into
                                <dir>/<sanitized-key>.log.txt in addition to the
                                main log. Default: "logs". Pass --no-session-log-dir
                                to disable.
      --no-session-log-dir      Disable per-session log tee. Wins over
                                --session-log-dir if both are passed.
      --admin-path <name>       URL prefix for the admin and UI endpoints
                                (default "_proxy"). No leading slash.
                                Cannot be "v1".
      --report-dir <path>       Directory the /<admin-path>/report viewer reads
                                completed benchmark runs from (one subdir per
                                run, each with summary.json + report.csv +
                                charts/*.svg from the bench/plot tooling).
                                Read-only and served fully public (no token).
                                Default: "runs".
      --strip-ephemeral-from-system <on|off>
                                PLAN §9: strip ISO dates, "Today's date is …",
                                and <env> blocks from the system prompt before
                                computing the SESSION KEY and forwarding bytes.
                                Collapses cross-day fragments of the same
                                logical session. Default ON; pass off to
                                preserve original byte stream.
      --capture-body <path>     TEST harness: write the first real /v1/messages
                                request body (pristine, pre-mutation bytes) to
                                <path> at mode 0600, then stop. Captures Claude
                                Code's exact cache_control breakpoints for use
                                as a faithful replay fixture (benchmark/bin/
                                replay.js). Only a body carrying both system and
                                tools is captured (skips thin continuation
                                turns). Default off.
      --auto-continue           PLAN §24: when a session that was rate-limited
                                clears, write a "continue" prompt into the
                                running claude session. Requires PTY mode
                                (\`clawback claude\` + node-pty). Default OFF.
      --mobile                  Soft bundle for tethered work. Turns on
                                --gzip-outgoing AND --force-non-streaming
                                unless either is explicitly overridden.
      --gzip-outgoing <on|off>  gzip outgoing /v1/messages request bodies
                                with content-encoding: gzip. Cuts upstream
                                bandwidth on tethered links. Default OFF;
                                turned on by --mobile.
      --account-global-quota <on|off>
                                Treat the five_hour (quota) / seven_day (week)
                                plan-quota windows as account-global (default
                                on): record every statusline POST's quota and
                                render all sessions from the freshest shared
                                value, so an idle session no longer shows a
                                stale, too-low quota. Turn off to render the
                                strict per-session value — the escape hatch if
                                you run more than one Anthropic account through
                                a single proxy (multi-account attribution is
                                not yet implemented).
      --statusline-prefix <s>   Prefix for the GET /_proxy/statusline plain-text
                                response (default "clawback: "). The operator's
                                Claude Code statusline_command can curl that
                                endpoint to surface clawback state in claude's UI.
      --statusline-max-chars <n>
                                Hard truncate of the statusline response,
                                including prefix (default 80; ellipsis appended).
      --statusline-progress-bar-length <n>
                                Cell count for the context/day/week progress
                                bars (default 8). Each cell carries 100/N % of
                                the budget; widen for finer resolution at the
                                cost of statusline width. Sparkline fields
                                (hit/turn/tps) are unaffected.
      --statusline-color <auto|on|off>
                                ANSI color for bar cells in the
                                /_proxy/statusline output (default auto: off
                                if NO_COLOR env is set or stdout isn't a
                                TTY, on otherwise). Color is "bars only" —
                                labels and numeric values stay terminal-
                                default. Defaults: 50/80% for percentage
                                fields, 500/2000ms for ttft, 30/80 for tps;
                                tunable via the --statusline-*-threshold-*
                                flags below.
      --statusline-pct-threshold-low <n>
                                Boundary between green and yellow on the
                                percentage ramp (default 50). Applies to
                                context, day, week (high-bad direction)
                                and hit, turn (inverted: above this is
                                yellow, above --high is green).
      --statusline-pct-threshold-high <n>
                                Boundary between yellow and red on the
                                percentage ramp (default 80). Must be >=
                                low. Set low === high to drop the warn
                                band (binary good/bad).
      --statusline-ttft-threshold-low-ms <n>
                                TTFT (ms) below which a turn is "warm"
                                (green) in absolute mode, and the fallback
                                used in relative mode before the per-session
                                ring has enough samples (default 3000).
      --statusline-ttft-threshold-high-ms <n>
                                TTFT (ms) at or above which a turn is
                                "cold" (red) in absolute mode / fallback
                                (default 5000). Must be >= --low-ms.
      --statusline-tps-threshold-low <n>
                                TPS below which a turn is "slow" (red)
                                in absolute mode, and the fallback used
                                in relative mode before the per-session
                                ring has enough samples to calibrate
                                (default 15).
      --statusline-tps-threshold-high <n>
                                TPS at or above which a turn is "fast"
                                (green) in absolute mode / fallback
                                (default 40). Must be >= --low.
      --statusline-tps-calibration <relative|absolute>
                                How to derive TPS color bands. "relative"
                                (default): low = peak/6, high = peak/2
                                computed from the session's recentTps
                                ring (3:2:1 red:yellow:green ratio over
                                the observed range) — colors mean
                                "fast/slow for this model." "absolute":
                                always use --statusline-tps-threshold-low
                                and --high as fixed cutoffs.
      --statusline-ttft-calibration <relative|absolute>
                                How to derive TTFT color bands. "absolute"
                                (default): use --statusline-ttft-threshold-
                                low-ms and --high-ms as a fixed wall-clock
                                budget, so green means a genuinely warm cache.
                                "relative": low = median*1.5, high = median*3
                                from the session's recentTtftMs ring — colors
                                mean "fast/slow for this link." Relative hides
                                a consistently-cold cache (slow reads as
                                "normal"), so absolute is the default for this
                                warmth signal.
      --force-non-streaming <on|off>
                                Rewrite parsedBody.stream from true to false
                                before forwarding, so Anthropic returns a
                                single JSON response instead of an SSE
                                stream. clawback then re-emits the JSON as
                                SSE to the client so claude doesn't notice.
                                Cuts radio-on time on mobile and improves
                                response gzip ratio. Trade-off: first-token
                                latency = full-response latency. Default
                                OFF; turned on by --mobile.
      --auto-continue-text <s>  Override the text written on cap-clear
                                (default "continue\\n"; literal "\\n" in the
                                argument is converted to a newline)
      --auto-continue-cooldown-sec <n>
                                Minimum seconds between auto-continue fires
                                on the same session (default 300). Prevents
                                tight fire→turn→429→fire loops.
      --admin-token <s>         Optional shared-secret bearer for write
                                requests against /<admin-prefix>/*. When set,
                                POST/DELETE/PATCH/PUT must carry
                                \`Authorization: Bearer <token>\` unless the
                                request originates from loopback. GETs stay
                                open (so the UI and curl reads keep working
                                without configuration). Also honored via the
                                CLAWBACK_ADMIN_TOKEN env var; CLI wins on
                                conflict. Default unset = no auth required
                                (the historical loopback-only model).
      --tls <on|off>            Serve HTTPS on \`port\` and 308-redirect same-
                                port HTTP requests to https://. Requires
                                --tls-cert and --tls-key, or a prior
                                \`clawback init-cert\` populating the default
                                location (or --self-sign to mint at startup).
                                Default OFF for a loopback bind, but auto-ON
                                when --host is non-loopback (e.g. 0.0.0.0):
                                an open-network bind would otherwise send the
                                admin token + captured OAuth creds in
                                cleartext. Pass --tls off to force HTTP even
                                on a wide bind (e.g. TLS terminated upstream).
      --self-sign               When --tls is on (explicitly or via the
                                open-network auto-enable) but no cert exists
                                at the resolved path, mint a self-signed
                                cert+key at startup instead of refusing to
                                launch. Off by default. Clients must trust
                                the self-signed CA (NODE_EXTRA_CA_CERTS);
                                \`clawback claude\` wires that automatically,
                                a bare client on another host does not.
      --tls-cert <path>         PEM cert file for --tls. Default: the file
                                written by \`clawback init-cert\`
                                ($XDG_DATA_HOME/clawback/cert.pem or
                                ~/.local/share/clawback/cert.pem).
      --tls-key <path>          PEM key file for --tls. Same defaulting rule
                                as --tls-cert.
      --log-level <level>       debug|info|warn|error|silent (default info)
      --help                    Show this help
      --version                 Print version

Path-mode session IDs:
  If you want explicit session IDs, set ANTHROPIC_BASE_URL=http://localhost:8080/<agentId>.
  Otherwise sessions are keyed by SHA256(system + tools) from the request body.

Admin API (prefix configurable via --admin-path; default "_proxy"):
  GET    /_proxy/health             health + config snapshot
  GET    /_proxy/version            { "version": "<package version>" }
  GET    /_proxy/sessions           list sessions
  GET    /_proxy/sessions/:id       one session
  DELETE /_proxy/sessions/:id       purge one
  DELETE /_proxy/sessions           purge all
  GET    /_proxy/suggestions        applicable optimization rule cards
  GET    /_proxy/ui/                local performance dashboard (HTML)

Setup:
  clawback init [--global|--local] [--force]
                                    write a config stub at the chosen scope
  npm run setup                     run \`npm link\` then create the global config

Quick start:
  clawback quickstart             # one command: create config + wire
                                  # statusline + launch claude
                                  # against the proxy. Idempotent.

  clawback claude                 # one shot: starts the proxy and launches
                                  # claude as a child with ANTHROPIC_BASE_URL
                                  # pointed at it. Proxy shuts down when
                                  # claude exits.

  clawback clean --force          # delete state/turn-log/session logs so
                                  # the next boot is treated as a fresh
                                  # install (auto-arms a baseline capture).

  # Or run them separately:
  clawback &
  ANTHROPIC_BASE_URL=http://localhost:8080 claude
`);
	process.exit(0);
}

if (values.version) {
	const pkgUrl = new URL("../package.json", import.meta.url);
	const pkg = JSON.parse(await fs.readFile(pkgUrl, "utf8"));
	process.stdout.write(`${pkg.version}\n`);
	process.exit(0);
}

const cli = {};
if (values.host) cli.host = values.host;
if (values.port) cli.port = Number.parseInt(values.port, 10);
if (values.state) cli.stateFile = values.state;
if (values.upstream) cli.upstream = values.upstream;
if (values["grace-hours"])
	cli.gracePeriodMs = Math.floor(
		Number.parseFloat(values["grace-hours"]) * 3_600_000,
	);
if (values["session-max-idle-hours"])
	cli.sessionMaxIdleMs = Math.floor(
		Number.parseFloat(values["session-max-idle-hours"]) * 3_600_000,
	);
if (values["dead-session-max-idle-hours"] != null)
	cli.deadSessionMaxIdleMs = Math.floor(
		Number.parseFloat(values["dead-session-max-idle-hours"]) * 3_600_000,
	);
if (values["gc-sweep-interval-sec"] != null)
	cli.gcSweepIntervalMs = Math.floor(
		Number.parseFloat(values["gc-sweep-interval-sec"]) * 1000,
	);
if (values["keep-alive-min-sec"])
	cli.keepAliveMinMs = Math.floor(
		Number.parseFloat(values["keep-alive-min-sec"]) * 1000,
	);
if (values["keep-alive-max-sec"])
	cli.keepAliveMaxMs = Math.floor(
		Number.parseFloat(values["keep-alive-max-sec"]) * 1000,
	);
if (values["keep-alive-min-sec-extended"])
	cli.keepAliveMinMsExtended = Math.floor(
		Number.parseFloat(values["keep-alive-min-sec-extended"]) * 1000,
	);
if (values["keep-alive-max-sec-extended"])
	cli.keepAliveMaxMsExtended = Math.floor(
		Number.parseFloat(values["keep-alive-max-sec-extended"]) * 1000,
	);
if (values["keep-alive-min-prefix-bytes"] != null)
	cli.keepAliveMinPrefixBytes = Math.floor(
		Number.parseFloat(values["keep-alive-min-prefix-bytes"]),
	);
if (values["keep-alive-cold-ping-max"] != null)
	cli.keepAliveColdPingMax = Math.floor(
		Number.parseFloat(values["keep-alive-cold-ping-max"]),
	);
if (values["inject-extended-cache-ttl"])
	cli.injectExtendedCacheTtl = parseBool(values["inject-extended-cache-ttl"]);
if (values["rewrite-nested-cache-control"])
	cli.rewriteNestedCacheControl = parseBool(
		values["rewrite-nested-cache-control"],
	);
if (values["strip-extended-cache-ttl"])
	cli.stripExtendedCacheTtl = parseBool(values["strip-extended-cache-ttl"]);
if (values["keep-alive-mode-extended"])
	cli.keepAliveModeExtended = parseBool(values["keep-alive-mode-extended"]);
if (values.passthrough || values.baseline) cli.passthrough = true;
if (values["keep-alive"])
	cli.keepAliveEnabled = parseBool(values["keep-alive"]);
if (values["turn-log"]) cli.turnLogFile = values["turn-log"];
if (values["no-turn-log"]) cli.turnLogFile = null;
if (values["admin-path"]) cli.adminPathPrefix = values["admin-path"];
if (values["report-dir"]) cli.reportDir = values["report-dir"];
if (values["log-level"]) cli.logLevel = values["log-level"];
if (values["log-file"]) cli.logFile = values["log-file"];
if (values["session-log-dir"]) cli.sessionLogDir = values["session-log-dir"];
if (values["no-session-log-dir"]) cli.sessionLogDir = null;
if (values["strip-ephemeral-from-system"])
	cli.stripEphemeralFromSystem = parseBool(
		values["strip-ephemeral-from-system"],
	);
if (values["capture-body"]) cli.captureBodyPath = values["capture-body"];
if (values["auto-continue"]) cli.autoContinue = true;
if (values["upstream-from-env"]) cli.upstreamFromEnv = true;
if (values.mobile) cli.mobile = true;
if (values["gzip-outgoing"])
	cli.gzipOutgoing = parseBool(values["gzip-outgoing"]);
if (values["force-non-streaming"])
	cli.forceNonStreaming = parseBool(values["force-non-streaming"]);
if (values["account-global-quota"])
	cli.accountGlobalQuota = parseBool(values["account-global-quota"]);
if (values["statusline-prefix"])
	cli.statuslinePrefix = values["statusline-prefix"];
if (values["statusline-max-chars"])
	cli.statuslineMaxChars = Number.parseInt(values["statusline-max-chars"], 10);
if (values["statusline-progress-bar-length"])
	cli.statuslineProgressBarLength = Number.parseInt(
		values["statusline-progress-bar-length"],
		10,
	);
if (values["statusline-color"]) {
	const v = String(values["statusline-color"]).toLowerCase();
	if (v !== "auto" && v !== "on" && v !== "off") {
		process.stderr.write(
			`clawback: invalid --statusline-color: ${values["statusline-color"]} (must be auto|on|off)\n`,
		);
		process.exit(1);
	}
	cli.statuslineColor = v;
}
const parseThresholdNumber = (flagName, raw) => {
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) {
		process.stderr.write(
			`clawback: invalid --${flagName}: ${raw} (expected a number)\n`,
		);
		process.exit(1);
	}
	return n;
};
if (values["statusline-pct-threshold-low"] !== undefined)
	cli.statuslinePctThresholdLow = parseThresholdNumber(
		"statusline-pct-threshold-low",
		values["statusline-pct-threshold-low"],
	);
if (values["statusline-pct-threshold-high"] !== undefined)
	cli.statuslinePctThresholdHigh = parseThresholdNumber(
		"statusline-pct-threshold-high",
		values["statusline-pct-threshold-high"],
	);
if (values["statusline-ttft-threshold-low-ms"] !== undefined)
	cli.statuslineTtftThresholdLowMs = parseThresholdNumber(
		"statusline-ttft-threshold-low-ms",
		values["statusline-ttft-threshold-low-ms"],
	);
if (values["statusline-ttft-threshold-high-ms"] !== undefined)
	cli.statuslineTtftThresholdHighMs = parseThresholdNumber(
		"statusline-ttft-threshold-high-ms",
		values["statusline-ttft-threshold-high-ms"],
	);
if (values["statusline-tps-threshold-low"] !== undefined)
	cli.statuslineTpsThresholdLow = parseThresholdNumber(
		"statusline-tps-threshold-low",
		values["statusline-tps-threshold-low"],
	);
if (values["statusline-tps-threshold-high"] !== undefined)
	cli.statuslineTpsThresholdHigh = parseThresholdNumber(
		"statusline-tps-threshold-high",
		values["statusline-tps-threshold-high"],
	);
if (values["statusline-tps-calibration"] !== undefined) {
	const v = values["statusline-tps-calibration"];
	if (v !== "relative" && v !== "absolute") {
		process.stderr.write(
			`--statusline-tps-calibration must be "relative" or "absolute" (got ${JSON.stringify(v)})\n`,
		);
		process.exit(1);
	}
	cli.statuslineTpsCalibration = v;
}
if (values["statusline-ttft-calibration"] !== undefined) {
	const v = values["statusline-ttft-calibration"];
	if (v !== "relative" && v !== "absolute") {
		process.stderr.write(
			`--statusline-ttft-calibration must be "relative" or "absolute" (got ${JSON.stringify(v)})\n`,
		);
		process.exit(1);
	}
	cli.statuslineTtftCalibration = v;
}
if (values["auto-continue-text"])
	cli.autoContinueText = values["auto-continue-text"].replace(/\\n/g, "\n");
if (values["auto-continue-cooldown-sec"])
	cli.autoContinueCooldownMs = Math.floor(
		Number.parseFloat(values["auto-continue-cooldown-sec"]) * 1000,
	);
if (values["admin-token"]) cli.adminToken = values["admin-token"];
if (values.tls) cli.tls = parseBool(values.tls);
if (values["tls-cert"]) cli.tlsCertFile = values["tls-cert"];
if (values["tls-key"]) cli.tlsKeyFile = values["tls-key"];
if (values["self-sign"]) cli.selfSign = true;

function parseBool(v) {
	const s = String(v).toLowerCase();
	if (s === "on" || s === "true" || s === "1" || s === "yes") return true;
	if (s === "off" || s === "false" || s === "0" || s === "no") return false;
	throw new Error(`expected on|off, got: ${v}`);
}

try {
	await start({ cliOverrides: cli, configPath: values.config ?? null });
} catch (err) {
	process.stderr.write(`clawback: failed to start — ${err.message}\n`);
	process.exit(1);
}
