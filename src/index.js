import fs from "node:fs";
import { startBaselineCapture } from "./admin.js";
import { loadConfig } from "./config.js";
import { initCert, resolveDefaultCertPaths } from "./init_cert.js";
import { KeepAliveScheduler } from "./keepalive.js";
import { createLogger } from "./logger.js";
import { migrateStoredSessions } from "./migrate.js";
import { createReportServer } from "./report.js";
import { detectSelfLoop } from "./self_loop.js";
import { createServer } from "./server.js";
import { SessionStore } from "./store.js";
import { createTurnLog } from "./turn_log.js";
import { createUiServer } from "./ui_server.js";

/**
 * Pre-flight the TLS material before we try to stand up an https server.
 * Called from start() once config is loaded. No-op when tls is off or the
 * cert+key already exist on disk. When they're missing:
 *
 *   - `selfSign: true`  → mint a fresh self-signed pair at the default
 *     cert dir (where `clawback init-cert` writes), repoint config at it,
 *     and log loudly — including the NODE_EXTRA_CA_CERTS hint a bare
 *     client on another host needs to trust it.
 *   - `selfSign: false` → throw an actionable error. The message names
 *     *why* TLS is on (operator's choice vs. the open-network auto-enable
 *     in loadConfig) and the three ways forward: `clawback init-cert`,
 *     `--self-sign`, or `--tls off` (when TLS is terminated upstream).
 *
 * `initCertFn` is injected for tests so they don't shell out to openssl.
 * `env` is injected so tests can pin the default cert dir to a tmp HOME.
 */
export function provisionTlsCert(
	config,
	{ logger = null, env = process.env, initCertFn = initCert } = {},
) {
	if (!config.tls) return;
	const certOk =
		Boolean(config.tlsCertFile) && fs.existsSync(config.tlsCertFile);
	const keyOk = Boolean(config.tlsKeyFile) && fs.existsSync(config.tlsKeyFile);
	if (certOk && keyOk) return;

	const why = config._tlsAutoEnabled
		? `TLS auto-enabled because host=${config.host} is not loopback (open-network bind)`
		: "tls is on";

	if (config.selfSign) {
		const { cert, key } = resolveDefaultCertPaths(env);
		// force:true so a half-present pair (one of cert/key missing) is
		// regenerated as a consistent set rather than left broken. We
		// only reach here when at least one file is absent, so this never
		// clobbers a complete, working pair.
		const result = initCertFn({ env, force: true });
		config.tlsCertFile = cert;
		config.tlsKeyFile = key;
		logger?.warn?.(
			`${why}; --self-sign ${result.action} a self-signed cert at ${cert}. Node clients must trust it: export NODE_EXTRA_CA_CERTS=${cert} (clawback claude wires this automatically; a bare client elsewhere does not). Browsers will show "not secure" until the cert is trusted by the OS — on macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${cert} (or use mkcert for a locally-trusted cert).`,
		);
		return;
	}

	const missing = !certOk ? config.tlsCertFile : config.tlsKeyFile;
	throw new Error(
		`${why}; no TLS cert found at ${missing}. Run \`clawback init-cert\` to generate one, pass \`--self-sign\` to mint it now, or \`--tls off\` if TLS is terminated by an upstream proxy.`,
	);
}

export async function start({
	cliOverrides = {},
	configPath = null,
	cwd = process.cwd(),
	installSignalHandlers = true,
} = {}) {
	const { config, sources, warnings } = loadConfig({
		configPath,
		cliOverrides,
		cwd,
	});
	const logger = createLogger(config.logLevel, {
		file: config.logFile,
		sessionLogDir: config.sessionLogDir,
	});
	for (const src of sources) {
		logger.info(`config ${src.tier} loaded from ${src.path}`);
	}
	// Surfaced from loadConfig (e.g. adminToken in a world-readable config
	// file). These are correctness-but-not-fatal issues — log loud, keep
	// going.
	for (const w of warnings ?? []) logger.warn(w);
	// Pre-flight TLS material before anything else binds. Either mints a
	// self-signed pair (--self-sign) or throws an actionable error when
	// tls is on but the cert is missing — including the open-network
	// auto-enable path where the operator never asked for TLS explicitly.
	provisionTlsCert(config, { logger });
	const store = new SessionStore({ filePath: config.stateFile, logger });
	migrateStoredSessions({ store, config, logger });
	const turnLog = createTurnLog({ filePath: config.turnLogFile, logger });
	const scheduler = new KeepAliveScheduler({ config, store, logger, turnLog });
	scheduler.start();

	const uiServer = createUiServer({ logger });
	const reportServer = createReportServer({ logger, config });
	const server = createServer({
		config,
		store,
		scheduler,
		logger,
		turnLog,
		uiServer,
		reportServer,
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const bound = server.address();
	if (detectSelfLoop({ upstream: config.upstream, bound })) {
		const msg = `upstream points at clawback itself (${config.upstream}). This would loop. Either unset ANTHROPIC_BASE_URL before starting, pass --upstream <url> explicitly, or set 'upstream' in CLAWBACK.md.`;
		logger.error(msg);
		try {
			server.close();
		} catch {}
		throw new Error(msg);
	}

	const scheme = config.tls ? "https" : "http";
	logger.info(
		`clawback listening on ${scheme}://${config.host}:${config.port}`,
	);
	if (config.tls) {
		logger.info(
			`tls: ${config.tlsCertFile} (HTTP requests on this port get 308-redirected to https://)`,
		);
	}
	logger.info(`upstream: ${config.upstream} | state: ${config.stateFile}`);
	const resumed = store.all().length;
	if (resumed) logger.info(`resumed ${resumed} session(s) from state file`);

	// New-install detection: an empty store at boot means this is a
	// fresh clawback (no `--resume` of an existing state file), so
	// auto-arm a baseline capture. The first few real /v1/messages
	// will run in passthrough; clawback then flips its interventions
	// back on, having recorded clean measurements. Skipped when
	// resuming (existing sessions present) — operators on existing
	// state get to choose when to recapture via the UI button or the
	// suggestion that fires after the 6h gate.
	if (!resumed) {
		startBaselineCapture(config, { store, scheduler, logger });
		logger.info(
			`baseline capture armed for first ${config._baselineCapture?.targetTurns ?? 5} turn(s) on this fresh proxy`,
		);
	}

	let shuttingDown = false;
	let shutdownPromise = null;
	const shutdown = (sig, exitCode = 0) => {
		if (shuttingDown) return shutdownPromise;
		shuttingDown = true;
		logger.info(`${sig} received, shutting down`);
		scheduler.stop();
		try {
			store.flushNow();
		} catch (e) {
			logger.warn(`final flush failed: ${e.message}`);
		}
		turnLog.close();
		shutdownPromise = new Promise((resolve) => {
			server.close(async () => {
				try {
					await logger.close();
				} catch {}
				resolve();
				process.exit(exitCode);
			});
			setTimeout(async () => {
				logger.warn("force-exit after 5s");
				try {
					await logger.close();
				} catch {}
				resolve();
				process.exit(1);
			}, 5000).unref?.();
		});
		return shutdownPromise;
	};
	if (installSignalHandlers) {
		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	}

	return { server, store, scheduler, config, logger, shutdown };
}
