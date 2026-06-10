import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	AUTO_DISCOVERED_CONFIG_NAME,
	resolveGlobalConfigPath,
} from "./config.js";
import { stringifyFrontMatter } from "./front_matter.js";

// 32 random bytes → 256 bits of entropy → 43-char base64url string.
// base64url avoids `/` and `+` so the token copy-pastes cleanly into
// `Authorization: Bearer …` headers and `--admin-token` CLI flags
// without URL-encoding.
const ADMIN_TOKEN_BYTES = 32;

// Paths clawback generates relative to the launch cwd. Kept in sync
// with DEFAULTS in src/config.js: `stateFile` and `turnLogFile` live
// under `data/`; `sessionLogDir` is `logs/`. `CLAWBACK.md` is the
// local-auto config itself (and carries a shared secret). It is NOT a
// dotfile, so a blanket `.*` gitignore rule would miss it — hence the
// explicit entry. Cert/key go under $XDG_DATA_HOME — outside cwd — so
// they're not listed here.
export const GITIGNORE_MANAGED_ENTRIES = Object.freeze([
	"CLAWBACK.md",
	"data/",
	"logs/",
]);

export const GITIGNORE_BLOCK_HEADER = "# Added by `clawback init`";

export function generateAdminToken() {
	return crypto.randomBytes(ADMIN_TOKEN_BYTES).toString("base64url");
}

/**
 * Resolve the target file path for `clawback init` given a scope flag set.
 *
 * @param {Object} opts
 * @param {boolean} [opts.global]   Write to the global XDG path.
 * @param {boolean} [opts.local]    Write to ./CLAWBACK.md (default).
 * @param {string|null} [opts.configPath] Explicit override; wins over scope.
 * @param {string} [opts.cwd]       Working directory for the local target.
 * @param {Object} [opts.env]       Environment for resolving the global path.
 * @returns {string} absolute path
 */
export function resolveInitTarget({
	global: isGlobal = false,
	local: isLocal = false,
	configPath = null,
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	if (isGlobal && isLocal) {
		throw new Error("--global and --local are mutually exclusive");
	}
	if (configPath) {
		return path.resolve(configPath);
	}
	if (isGlobal) {
		const xdg = env.XDG_CONFIG_HOME;
		const home = env.HOME;
		if (!xdg?.length && !home?.length) {
			throw new Error(
				"cannot resolve global config path: HOME / XDG_CONFIG_HOME unset",
			);
		}
		return resolveGlobalConfigPath(env);
	}
	return path.resolve(cwd, AUTO_DISCOVERED_CONFIG_NAME);
}

/**
 * Create a config stub at the target path. Idempotent unless the file
 * already exists, in which case `force: true` is required to overwrite.
 *
 * The stub includes a freshly-minted `adminToken`. This is a convenience:
 * a tokened proxy is the only safe posture for a non-loopback bind (see
 * `validate` in src/config.js), and asking every operator to come up
 * with a high-entropy secret on first use is friction. The file is
 * chmod'd 0o600 immediately because it now carries a shared secret.
 *
 * @param {object}  opts
 * @param {string}  [opts.adminToken]  Test seam — pass a fixed token to
 *   make assertions deterministic. Production callers always omit this
 *   and let init mint a fresh one.
 * @returns {{ targetPath: string, action: "created"|"overwrote"|"skipped", adminToken: string|null, gitignore: {action: "created"|"added"|"already-present"|"skipped-no-repo", added: string[]}|null }}
 *   `adminToken` is the minted (or supplied) token on created/overwrote,
 *   and null on skipped (the existing file's token, if any, is the
 *   operator's secret and not ours to surface).
 *   `gitignore` reports what `ensureGitignored` did for the local case
 *   (cwd `.gitignore` next to `./CLAWBACK.md`), or null when the
 *   target is not the local-auto path (global or explicit --config).
 *   The `added` array lists which managed entries were actually written
 *   on this call (empty for already-present / skipped-no-repo).
 */
export function initConfig({
	global: isGlobal = false,
	local: isLocal = false,
	force = false,
	configPath = null,
	cwd = process.cwd(),
	env = process.env,
	adminToken = null,
	forceGitignore = false,
} = {}) {
	const targetPath = resolveInitTarget({
		global: isGlobal,
		local: isLocal,
		configPath,
		cwd,
		env,
	});

	// Only wire `.gitignore` when the target IS the cwd's local-auto
	// path. Global (XDG) and explicit --config paths are out of scope:
	// the gitignore concern lives next to the file we're trying to
	// hide, and "I passed --config" means the operator chose where it
	// goes — surprising them with a sibling .gitignore mutation would
	// be rude.
	const localAutoPath = path.resolve(cwd, AUTO_DISCOVERED_CONFIG_NAME);
	const isLocalAuto = targetPath === localAutoPath;

	const exists = fs.existsSync(targetPath);
	if (exists && !force) {
		const gitignore = isLocalAuto
			? ensureGitignored(cwd, { force: forceGitignore })
			: null;
		return { targetPath, action: "skipped", adminToken: null, gitignore };
	}

	const token = adminToken ?? generateAdminToken();
	const data = { ...stubSettings(), adminToken: token };

	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	// Owner-only mode because the file holds a shared secret. The mode is
	// passed to the create itself (not chmod'd after) so the token never
	// sits world-readable, however briefly. mode only applies on CREATE —
	// an existing file keeps its mode — so the chmod below covers the
	// overwrite path. Mirrors `clawback init-cert`'s posture for key.pem.
	fs.writeFileSync(targetPath, stringifyFrontMatter(data, STUB_BODY_DOC), {
		encoding: "utf8",
		mode: 0o600,
	});

	// Overwrite path + best-effort: non-POSIX filesystems (Windows, some
	// network mounts) silently ignore chmod; loadConfig's
	// warnIfWorldReadable will emit a runtime warning if the mode ends up
	// loose at use time.
	try {
		fs.chmodSync(targetPath, 0o600);
	} catch {
		/* non-POSIX FS or insufficient perms */
	}

	const gitignore = isLocalAuto
		? ensureGitignored(cwd, { force: forceGitignore })
		: null;

	return {
		targetPath,
		action: exists ? "overwrote" : "created",
		adminToken: token,
		gitignore,
	};
}

/**
 * Ensure the cwd's `.gitignore` lists every path clawback generates
 * (see GITIGNORE_MANAGED_ENTRIES), grouped under a `# Added by
 * \`clawback init\`` comment so the operator can see at a glance which
 * lines we own. README scopes the recommendation to "if you check the
 * repo in" — so by default we no-op when there's no `.git/` to be checked
 * in. Pass `{ force: true }` to write (and create) `.gitignore` regardless;
 * `clawback quickstart` does this so the adminToken-bearing CLAWBACK.md is
 * pre-ignored before the directory ever becomes a repo.
 *
 * Dedupe is strict per entry: a managed entry counts as already-listed
 * only when an existing line, trimmed, equals it exactly. Broader globs
 * (e.g. `clawback*`, `data`) will get a redundant exact entry —
 * acceptable, since interpreting gitignore syntax to do better is far
 * heavier than one extra line. The block header is written only with
 * the entries we actually add.
 *
 * @param {string} cwd
 * @param {{force?: boolean}} [opts]  force=true skips the `.git/` guard so a
 *   `.gitignore` is created even outside a repository.
 * @returns {{action: "created"|"added"|"already-present"|"skipped-no-repo", added: string[]}}
 */
export function ensureGitignored(cwd, { force = false } = {}) {
	if (!force && !fs.existsSync(path.join(cwd, ".git"))) {
		return { action: "skipped-no-repo", added: [] };
	}
	const gitignorePath = path.join(cwd, ".gitignore");
	const existed = fs.existsSync(gitignorePath);
	const current = existed ? fs.readFileSync(gitignorePath, "utf8") : "";
	const present = new Set(
		current
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	);
	const missing = GITIGNORE_MANAGED_ENTRIES.filter((e) => !present.has(e));
	if (missing.length === 0) {
		return { action: "already-present", added: [] };
	}
	const block = `${GITIGNORE_BLOCK_HEADER}\n${missing.join("\n")}\n`;
	if (!existed) {
		fs.writeFileSync(gitignorePath, block, "utf8");
		return { action: "created", added: missing };
	}
	const prefix = current.endsWith("\n") ? "" : "\n";
	fs.appendFileSync(gitignorePath, `${prefix}${block}`, "utf8");
	return { action: "added", added: missing };
}

/**
 * The front-matter *settings* of a fresh `clawback init` stub.
 *
 * Intentionally empty — every key in DEFAULTS is left at its default so
 * future changes to those defaults propagate. The minted `adminToken` is
 * added by the caller; the human-readable discovery text lives in the
 * markdown body (`STUB_BODY_DOC`), not in a front-matter key.
 */
export function stubSettings() {
	return {};
}

/**
 * The markdown body of a fresh `clawback init` stub: everything after the
 * front-matter fence. Documents the notable knobs so the operator doesn't
 * have to run `clawback --help` to discover what's available. `loadConfig`
 * reads only the front matter, so this prose is inert — edit or delete it
 * freely.
 */
export const STUB_BODY_DOC = `# clawback config

The YAML front matter above is clawback's config. Every flag from
\`clawback --help\` is also a config key; only the ones you change need to
appear. Notable defaults:

- \`turnLogFile: "data/turns.ndjson"\` — per-turn NDJSON log (set to \`null\` to disable)
- \`keepAliveModeExtended: false\` — 15–45 min keep-alive cadence; pairs with \`injectExtendedCacheTtl\`
- \`injectExtendedCacheTtl: true\` — forwards a 1h \`cache_control\` on \`/v1/messages\`
- \`passthrough: false\` — set \`true\` for a measurement-baseline arm

\`adminToken\` is a freshly-minted shared secret. Keep this file gitignored,
or move it to \`$XDG_CONFIG_HOME/clawback/CLAWBACK.md\` before checking the
repo in. Everything below the front matter is yours — edit freely.`;
