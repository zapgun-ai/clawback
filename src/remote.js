import fs from "node:fs";
import path from "node:path";
import {
	AUTO_DISCOVERED_CONFIG_NAME,
	resolveGlobalConfigPath,
} from "./config.js";
import { parseFrontMatter, stringifyFrontMatter } from "./front_matter.js";
import { normalizeRemoteUrl } from "./launch_claude.js";

/**
 * Operator-facing helper that sets / clears the persistent `remoteUrl`
 * field in a clawback config file. The CLI surface is
 * `clawback remote <url> [--global|--local]` and `clawback remote --clear`.
 *
 * Design notes:
 * - **Default scope is global.** The dominant story is "I have a dev-box
 *   clawback I want my laptop to talk to from any project," which is a
 *   per-machine pref, not a per-repo one. `--local` is supported for
 *   project-specific overrides (e.g. a repo that should always talk to
 *   a staging clawback).
 * - **URL is normalized** with the same routine `clawback claude --remote`
 *   uses (strip trailing slash, validate http/https). A typo at write
 *   time is easier to diagnose than at next launch.
 * - **The file is created if missing.** `clawback init` mints a token and
 *   a doc-block; if the operator wants to skip that and just set a
 *   remoteUrl, we write a minimal stub. We do NOT mint an adminToken
 *   here — the remote already has one, and a stub-without-token is
 *   correct for the "I only talk to a remote" case.
 * - **Other fields are preserved.** Shallow-merge the parsed file with
 *   `{ remoteUrl }` so existing config (port, statusline thresholds,
 *   etc.) survives.
 * - **--clear deletes the key**, returning the file to "no persistent
 *   remote" without disturbing anything else.
 *
 * @returns {{action: "set"|"updated"|"cleared"|"cleared-noop", path: string, remoteUrl: string|null, previous: string|null}}
 *   `action: "set"` = field was absent before; `"updated"` = field
 *   changed; `"cleared"` = field was present and is now gone;
 *   `"cleared-noop"` = --clear on a file that didn't have remoteUrl.
 */
export function setRemoteUrl({
	url = null,
	clear = false,
	global: isGlobal = false,
	local: isLocal = false,
	configPath = null,
	cwd = process.cwd(),
	env = process.env,
} = {}) {
	if (isGlobal && isLocal) {
		throw new Error("--global and --local are mutually exclusive");
	}
	if (clear && url != null) {
		throw new Error("--clear cannot be combined with a URL argument");
	}
	if (!clear && (url == null || url === "")) {
		throw new Error(
			"clawback remote: provide a URL or pass --clear to unset the persistent remote",
		);
	}

	const targetPath = resolveTargetPath({
		global: isGlobal,
		local: isLocal,
		configPath,
		cwd,
		env,
	});

	const { data: existing, body } = readConfigIfExists(targetPath);
	const previous =
		typeof existing.remoteUrl === "string" ? existing.remoteUrl : null;

	if (clear) {
		if (previous == null) {
			// Don't create a file just to "clear" a field it never had.
			return {
				action: "cleared-noop",
				path: targetPath,
				remoteUrl: null,
				previous: null,
			};
		}
		const next = { ...existing };
		// biome-ignore lint/performance/noDelete: removing the key entirely so it is absent from the persisted front matter, not present-as-undefined
		delete next.remoteUrl;
		writeConfig(targetPath, next, body, { preserveMode: true });
		return {
			action: "cleared",
			path: targetPath,
			remoteUrl: null,
			previous,
		};
	}

	// Normalize at write time so the persisted value is the same shape
	// `launchClaude` would produce from the CLI flag. Throws on a bad
	// URL with a clear operator-facing message.
	const normalized = normalizeRemoteUrl(url);
	const next = { ...existing, remoteUrl: normalized };
	writeConfig(targetPath, next, body, { preserveMode: true });
	return {
		action: previous == null ? "set" : "updated",
		path: targetPath,
		remoteUrl: normalized,
		previous,
	};
}

function resolveTargetPath({
	global: isGlobal,
	local: isLocal,
	configPath,
	cwd,
	env,
}) {
	if (configPath) {
		return path.resolve(configPath);
	}
	if (isLocal) {
		return path.resolve(cwd, AUTO_DISCOVERED_CONFIG_NAME);
	}
	// Global is the default scope (see design note above).
	const globalPath = resolveGlobalConfigPath(env);
	if (!globalPath) {
		throw new Error(
			"cannot resolve global config path: HOME / XDG_CONFIG_HOME unset. Pass --local to write to ./CLAWBACK.md instead.",
		);
	}
	return globalPath;
}

// Returns `{ data, body }` so the caller can merge into `data` while
// re-emitting the markdown `body` verbatim. A missing or empty file reads
// as an empty config with no body.
function readConfigIfExists(filePath) {
	if (!fs.existsSync(filePath)) return { data: {}, body: "" };
	const raw = fs.readFileSync(filePath, "utf8");
	if (raw.trim() === "") return { data: {}, body: "" };
	try {
		// parseFrontMatter guarantees a plain-object `data`, or throws if the
		// document is not a clawback config (no fence / malformed) — refuse to
		// merge into it rather than silently overwrite the operator's data.
		return parseFrontMatter(raw);
	} catch (e) {
		throw new Error(
			`failed to parse existing config at ${filePath}: ${e.message}`,
		);
	}
}

function writeConfig(filePath, data, body, { preserveMode = true } = {}) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const serialized = stringifyFrontMatter(data, body);
	const existed = fs.existsSync(filePath);
	let priorMode = null;
	if (existed && preserveMode) {
		try {
			priorMode = fs.statSync(filePath).mode & 0o777;
		} catch {
			priorMode = null;
		}
	}
	fs.writeFileSync(filePath, serialized, "utf8");
	// Preserve a tight existing mode (e.g. 0o600 from `clawback init`)
	// across writes. When the file is new and contains no adminToken,
	// we leave the default mode alone — the secret-protection posture
	// is a concern for files that hold secrets, not the remoteUrl
	// field on its own.
	if (priorMode != null) {
		try {
			fs.chmodSync(filePath, priorMode);
		} catch {
			/* non-POSIX FS */
		}
	}
}
