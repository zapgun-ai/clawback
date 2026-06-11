import fs from "node:fs";
import path from "node:path";
import { parseFrontMatter, stringifyFrontMatter } from "./front_matter.js";
import { generateAdminToken, initConfig } from "./init.js";
import {
	resolveEffectiveStatusline,
	resolveSettingsPath,
	setupStatusline,
} from "./setup_statusline.js";

/**
 * `clawback quickstart` — one-command setup. Chains:
 *   1. `clawback init --local`         (create ./CLAWBACK.md if absent)
 *   2. overlay default-good knobs      (keepAliveModeExtended=true)
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
 *   }
 */
export function runQuickstart({
	force = false,
	project = false,
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
	});

	const overlay = applyDefaultGoodOverlay(initRaw.targetPath);

	const peeked =
		typeof loadConfigFn === "function" ? loadConfigFn().config : null;
	const setupHost = host ?? peeked?.host ?? "127.0.0.1";
	const setupPort = port ?? peeked?.port ?? 8080;
	const setupAdminPrefix =
		adminPathPrefix ?? peeked?.adminPathPrefix ?? "_proxy";
	const setupTls = tls || peeked?.tls === true;

	// "Setup hasn't been run yet" — in the sense that matters — means
	// clawback's statusline is NOT the block Claude Code will actually
	// render. setupStatusline on its own refuses to overwrite ANY
	// pre-existing statusLine without force, so a machine that already
	// carries a custom (or stale/shadowed) statusLine would sail through
	// quickstart with clawback's metrics statusline silently unwired.
	// Detect the effective block up front and force the wire whenever it
	// isn't already clawback's; an explicit --force still forces regardless.
	const setupTargetPath = resolveSettingsPath({ project, cwd, env });
	const effectiveBefore = resolveEffectiveStatusline({ cwd, env });
	const targetEntryBefore = effectiveBefore.entries.find(
		(e) => e.path && path.resolve(e.path) === path.resolve(setupTargetPath),
	);
	const targetWasForeign =
		targetEntryBefore?.present === true &&
		targetEntryBefore.isClawback === false;
	const clawbackEffectiveBefore =
		effectiveBefore.effective?.isClawback === true;
	const setupForce = force || !clawbackEffectiveBefore;

	const setupResult = setupStatusline({
		settingsPath: null,
		project,
		force: setupForce,
		host: setupHost,
		port: setupPort,
		adminPathPrefix: setupAdminPrefix,
		tls: setupTls,
		remoteUrl: null,
		cwd,
		env,
	});

	// After the wire, is clawback finally the effective block? If a foreign
	// block at a HIGHER-precedence tier still shadows what we wrote, the
	// wire took no visible effect — report that rather than claim success.
	// (Writing one tier can't dislodge a shadow at another, and silently
	// removing the operator's block at a tier we didn't target would be
	// overreach — so we surface it for the operator to resolve.)
	const effectiveAfter = resolveEffectiveStatusline({ cwd, env });
	const shadowEntry =
		setupResult.action !== "skipped" &&
		effectiveAfter.effective?.isClawback !== true
			? (effectiveAfter.effective ?? null)
			: null;

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
		setup: {
			...setupResult,
			// We wired clawback because it wasn't already the effective
			// block — i.e. setup "hadn't been run yet" (or --force).
			rerun: !clawbackEffectiveBefore && setupResult.action !== "skipped",
			// The wire displaced a non-clawback statusLine the operator had
			// at the target tier (setupResult.previous holds the old block).
			replacedForeign: setupResult.action === "overwrote" && targetWasForeign,
			// A higher-precedence foreign block still shadows the wire; the
			// statusline won't show clawback until that block is removed.
			shadowedBy: shadowEntry
				? { tier: shadowEntry.tier, path: shadowEntry.path }
				: null,
		},
	};
}

/**
 * Overlay the default-good knobs onto an existing CLAWBACK.md. Each
 * key is written only when absent — so the operator's prior choices
 * are preserved. The markdown body (everything after the front-matter
 * fence) is read and re-emitted verbatim, so the init doc-block survives.
 *
 * Current default-good overlay:
 *   - `host: "0.0.0.0"` — quickstart binds for the laptop-runs-clawback /
 *     phone-views-dashboard flow; loopback would block that. The LAN
 *     bind is safe only with a shared secret, so the overlay also mints
 *     an `adminToken` when the file lacks one (loadConfig.validate
 *     refuses non-loopback bind + no token). Standalone `clawback
 *     claude` (no config) still defaults to 127.0.0.1 via DEFAULTS, so
 *     the safety boundary remains for non-quickstart paths.
 *   - `selfSign: true` — the 0.0.0.0 bind triggers loadConfig's
 *     open-network TLS auto-enable, so the proxy needs a cert. selfSign
 *     lets `start()` mint a self-signed pair on first launch instead of
 *     refusing to boot, keeping quickstart a true one-command flow. The
 *     locally-spawned claude trusts it automatically via
 *     NODE_EXTRA_CA_CERTS; a phone/other-host client must trust the
 *     self-signed CA out of band (or the operator swaps in a real cert
 *     and drops this flag).
 *   - `keepAliveModeExtended: true` — pairs with the 1h cache TTL
 *     that's already on by default.
 * The other MVP knobs are already defaulted correctly in DEFAULTS.
 *
 * @returns {{overlaidKeys: string[], adminTokenMinted: boolean}}
 */
export function applyDefaultGoodOverlay(targetPath) {
	const overlaidKeys = [];
	const wantedDefaults = {
		host: "0.0.0.0",
		selfSign: true,
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
		fs.writeFileSync(targetPath, stringifyFrontMatter(parsed, body));
		// Re-tighten perms: the file now (always) carries a shared secret.
		// initConfig set 0o600 on creation, but a pre-existing operator
		// file may be mode 644; the overlay just wrote a token into it.
		try {
			fs.chmodSync(targetPath, 0o600);
		} catch {
			/* non-POSIX FS or insufficient perms */
		}
	}
	return { overlaidKeys, adminTokenMinted };
}
