import fs from "node:fs";
import path from "node:path";

/**
 * `clawback clean` core. Decides what counts as clawback-generated data
 * in a given cwd, then either previews or removes it.
 *
 * What counts as data:
 *   - `stateFile`      sessions + captured OAuth bearer
 *   - `turnLogFile`    per-turn NDJSON log
 *   - `logFile`        proxy log file (null by default; honored if set)
 *   - `sessionLogDir`  per-session log directory
 *
 * Notably NOT touched: `CLAWBACK.md` (operator config + adminToken),
 * `.gitignore` (operator-managed), TLS cert/key (out under
 * $XDG_DATA_HOME/clawback, not relative to cwd). Removing the config
 * file would force the operator to re-mint a token and re-edit any
 * customizations on the next run — a much more destructive operation
 * than what "clean the generated data" implies.
 */
export function resolveCleanTargets({ config, cwd = process.cwd() }) {
	const candidates = [
		config.stateFile,
		config.turnLogFile,
		config.logFile,
		config.sessionLogDir,
	];
	const resolved = [];
	for (const p of candidates) {
		if (!p) continue;
		const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
		if (!resolved.includes(abs)) resolved.push(abs);
	}
	return resolved;
}

/**
 * For each candidate path, classify it as "file", "dir", or null (does
 * not exist). Used both for the dry-run preview and for the removal
 * pass — so the preview and the action see the same disk state.
 */
export function inspectTargets(targets) {
	const out = [];
	for (const target of targets) {
		let kind = null;
		try {
			const stat = fs.lstatSync(target);
			kind = stat.isDirectory() ? "dir" : "file";
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}
		out.push({ path: target, kind });
	}
	return out;
}

/**
 * Remove every existing target. Files are unlinked; directories are
 * recursively removed. After the deletions, any parent dirs that were
 * emptied (commonly `data/` and `logs/`) are best-effort rmdir'd so a
 * fresh clean leaves no residue. Parents with leftover operator files
 * stay put — rmdir on a non-empty dir is a no-op here.
 *
 * Returns the list of paths that were actually removed (existing
 * targets only; missing ones are silently skipped).
 */
export function removeTargets(targets) {
	const removed = [];
	for (const t of inspectTargets(targets)) {
		if (t.kind == null) continue;
		if (t.kind === "dir") {
			fs.rmSync(t.path, { recursive: true, force: true });
		} else {
			fs.rmSync(t.path, { force: true });
		}
		removed.push(t.path);
	}
	const parents = new Set(removed.map((p) => path.dirname(p)));
	for (const dir of parents) {
		try {
			fs.rmdirSync(dir);
		} catch {
			/* parent not empty (operator has other files there) or already gone */
		}
	}
	return removed;
}
