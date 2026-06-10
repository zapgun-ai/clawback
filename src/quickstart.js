import fs from "node:fs";
import { parseFrontMatter, stringifyFrontMatter } from "./front_matter.js";
import { generateAdminToken, initConfig } from "./init.js";
import { setupStatusline } from "./setup_statusline.js";

/**
 * `clawback quickstart` — one-command setup. Chains:
 *   1. `clawback init --local`         (create ./CLAWBACK.md if absent)
 *   2. overlay default-good knobs      (host=127.0.0.1, keepAliveModeExtended=true;
 *                                       lan=true swaps in host=0.0.0.0 + selfSign)
 *   3. `clawback setup claude`         (wire the Claude Code statusline)
 *
 * The caller (bin/clawback.js) handles step 4 (`clawback claude`) by
 * re-exec'ing itself after this returns, so this function stays
 * stdio-free and testable.
 *
 * Idempotent: existing CLAWBACK.md and settings.json are left alone
 * unless `force: true`.
 *
 * Returns:
 *   {
 *     init: { action: "created"|"overwrote"|"skipped"|"defaults-overlaid", targetPath, overlaidKeys: string[] },
 *     setup: { action: "created"|"overwrote"|"skipped", targetPath, reason?, command? },
 *     gitignore: { action: "created"|"added"|"already-present", added: string[] },
 *   }
 */
export function runQuickstart({
	force = false,
	project = false,
	lan = false,
	cwd = process.cwd(),
	env = process.env,
	loadConfigFn,
	host,
	port,
	adminPathPrefix,
	tls = false,
} = {}) {
	const initRaw = initConfig({
		global: false,
		local: true,
		force,
		configPath: null,
		cwd,
		env,
		// quickstart always pre-ignores the adminToken-bearing CLAWBACK.md
		// (and data/, logs/), creating .gitignore even when the directory
		// isn't a git repo yet — so the secret can't be accidentally
		// committed once it becomes one.
		forceGitignore: true,
	});

	const overlay = applyDefaultGoodOverlay(initRaw.targetPath, { lan });

	const peeked =
		typeof loadConfigFn === "function" ? loadConfigFn().config : null;
	const setupHost = host ?? peeked?.host ?? "127.0.0.1";
	const setupPort = port ?? peeked?.port ?? 8080;
	const setupAdminPrefix =
		adminPathPrefix ?? peeked?.adminPathPrefix ?? "_proxy";
	const setupTls = tls || peeked?.tls === true;

	const setupResult = setupStatusline({
		settingsPath: null,
		project,
		force,
		host: setupHost,
		port: setupPort,
		adminPathPrefix: setupAdminPrefix,
		tls: setupTls,
		remoteUrl: null,
		cwd,
		env,
	});

	return {
		init: {
			action:
				initRaw.action === "skipped" && overlay.overlaidKeys.length > 0
					? "defaults-overlaid"
					: initRaw.action,
			targetPath: initRaw.targetPath,
			overlaidKeys: overlay.overlaidKeys,
			// True when a fresh adminToken was minted on this run — either
			// by initConfig (file created/overwritten) or by the overlay
			// step (file existed but lacked a token, so the LAN-bind gate
			// would have refused host=0.0.0.0). Caller (bin/clawback.js)
			// uses this to nudge the operator about the gitignore
			// implication.
			adminTokenMinted: initRaw.adminToken != null || overlay.adminTokenMinted,
		},
		setup: setupResult,
		// What `forceGitignore` did to ./.gitignore (created/added/
		// already-present). The caller surfaces created/added so the
		// operator knows the secret-bearing CLAWBACK.md is now ignored.
		gitignore: initRaw.gitignore,
	};
}

/**
 * Overlay the default-good knobs onto an existing CLAWBACK.md. Each
 * key is written only when absent — so the operator's prior choices
 * are preserved. The markdown body (everything after the front-matter
 * fence) is read and re-emitted verbatim, so the init doc-block survives.
 *
 * Default overlay (loopback, `lan=false`):
 *   - `host: "127.0.0.1"` — serve locally and securely by default. A
 *     loopback bind never leaves the machine, so no TLS/cert is needed:
 *     the dashboard opens over plain http:// with no browser warning,
 *     and the statusline curl is a trivial plain-HTTP request. This is
 *     the same host DEFAULTS already uses; we write it explicitly so the
 *     intent (and the safety boundary) is recorded in the file.
 *   - `keepAliveModeExtended: true` — pairs with the 1h cache TTL
 *     that's already on by default.
 *
 * LAN overlay (`lan=true`, i.e. `clawback quickstart --lan`):
 *   - `host: "0.0.0.0"` — binds for the laptop-runs-clawback /
 *     phone-views-dashboard flow. The LAN bind is safe only with a
 *     shared secret, so initConfig's auto-minted `adminToken` covers
 *     loadConfig.validate's non-loopback gate.
 *   - `selfSign: true` — the 0.0.0.0 bind triggers loadConfig's
 *     open-network TLS auto-enable, so the proxy needs a cert. selfSign
 *     lets `start()` mint a self-signed pair on first launch as a
 *     fallback; the CLI prefers a browser-trusted mkcert cert when
 *     mkcert is available (see bin/clawback.js).
 *   - `keepAliveModeExtended: true` — as above.
 *
 * In both modes the auto-minted `adminToken` (written by initConfig on
 * create) is preserved. The other MVP knobs are already defaulted
 * correctly in DEFAULTS.
 *
 * @param {string} targetPath
 * @param {{lan?: boolean}} [opts]  lan=true selects the 0.0.0.0 + selfSign overlay.
 * @returns {{overlaidKeys: string[], adminTokenMinted: boolean}}
 */
export function applyDefaultGoodOverlay(targetPath, { lan = false } = {}) {
	const overlaidKeys = [];
	const wantedDefaults = lan
		? {
				host: "0.0.0.0",
				selfSign: true,
				keepAliveModeExtended: true,
			}
		: {
				host: "127.0.0.1",
				keepAliveModeExtended: true,
			};

	let raw = "";
	try {
		raw = fs.readFileSync(targetPath, "utf8");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
		raw = "";
	}
	// parseFrontMatter guarantees a plain-object `data` (or throws on a
	// malformed document); re-emit `body` verbatim so the init doc-block
	// after the fence survives the overlay write.
	const { data: parsed, body } =
		raw.trim().length > 0 ? parseFrontMatter(raw) : { data: {}, body: "" };

	// Mint an adminToken when missing so the host=0.0.0.0 overlay can land
	// without tripping loadConfig.validate's LAN-bind safety gate. On a
	// fresh quickstart, initConfig already wrote the token; this branch
	// covers the pre-existing tokenless config case where initConfig
	// returned `skipped`. The token is appended to the existing file,
	// preserving every other key the operator set.
	let mutated = false;
	let adminTokenMinted = false;
	const hasFileAdminToken =
		typeof parsed.adminToken === "string" && parsed.adminToken.length > 0;
	if (!hasFileAdminToken) {
		parsed.adminToken = generateAdminToken();
		adminTokenMinted = true;
		mutated = true;
	}

	for (const [k, v] of Object.entries(wantedDefaults)) {
		if (parsed[k] === undefined) {
			parsed[k] = v;
			overlaidKeys.push(k);
			mutated = true;
		}
	}
	if (mutated) {
		// Tighten perms BEFORE writing the token in: initConfig set 0o600
		// on creation, but a pre-existing operator file may be mode 644,
		// and chmod-after would leave the freshly written secret
		// world-readable for the window between write and chmod.
		try {
			fs.chmodSync(targetPath, 0o600);
		} catch {
			/* non-POSIX FS or insufficient perms */
		}
		fs.writeFileSync(targetPath, stringifyFrontMatter(parsed, body), {
			mode: 0o600,
		});
	}
	return { overlaidKeys, adminTokenMinted };
}
