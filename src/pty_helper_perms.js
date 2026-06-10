import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Resolve the on-disk root of the installed `node-pty` package, or null
 * when it isn't installed (it's an optional dependency).
 *
 * Tries the package.json subpath first — the cheapest reliable anchor —
 * then falls back to resolving the main entry and walking up to the dir
 * that actually declares `name: "node-pty"`. The fallback guards against a
 * future node-pty shipping an `exports` map that blocks the
 * `node-pty/package.json` subpath.
 */
function resolveNodePtyRoot() {
	try {
		return path.dirname(require.resolve("node-pty/package.json"));
	} catch {
		/* exports-restricted or not installed; try the main entry next */
	}
	try {
		let p = require.resolve("node-pty");
		for (let i = 0; i < 6; i++) {
			p = path.dirname(p);
			try {
				const pj = JSON.parse(
					fs.readFileSync(path.join(p, "package.json"), "utf8"),
				);
				if (pj.name === "node-pty") return p;
			} catch {
				/* keep walking up */
			}
		}
	} catch {
		/* node-pty not resolvable */
	}
	return null;
}

/**
 * Ensure node-pty's `spawn-helper` binary is executable.
 *
 * node-pty's native addon launches the child process inside the PTY by
 * `posix_spawn`-ing a small prebuilt `spawn-helper` executable. When
 * node-pty is installed from a packed tarball (the normal npm / npx path)
 * that binary frequently arrives WITHOUT its execute bit, and `pty.fork`
 * then throws `Error: posix_spawnp failed.` synchronously the first time
 * clawback tries to launch claude in PTY mode.
 *
 * A naive `chmod` in a postinstall misses it because npm hoists node-pty
 * to the top-level `node_modules/node-pty`, out of reach of a path
 * relative to clawback's own package dir. So we resolve node-pty wherever
 * it actually landed and restore the bit at the exact paths node-pty's
 * `loadNativeModule` searches (`build/Release`, `build/Debug`,
 * `prebuilds/<platform>-<arch>`) — guaranteeing the file we fix is the one
 * node-pty will exec.
 *
 * Windows has no spawn-helper (it uses conpty), so this is a no-op there.
 *
 * Fully best-effort: a missing node-pty, a read-only filesystem, or a
 * non-POSIX `chmod` are all swallowed. Returns the list of paths actually
 * made executable (for logging/visibility) and never throws.
 *
 * @param {Object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.arch=process.arch]
 * @param {string|null} [opts.pkgRoot]  override node-pty's package root
 *   (test seam; defaults to resolving the installed node-pty).
 * @returns {string[]} paths whose execute bit was added on this call
 */
export function ensurePtySpawnHelperExecutable({
	platform = process.platform,
	arch = process.arch,
	pkgRoot = null,
} = {}) {
	// conpty-based; no spawn-helper to fix.
	if (platform === "win32") return [];

	const root = pkgRoot ?? resolveNodePtyRoot();
	if (!root) return [];

	const candidates = [
		path.join(root, "build", "Release", "spawn-helper"),
		path.join(root, "build", "Debug", "spawn-helper"),
		path.join(root, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
	];

	const fixed = [];
	for (const helper of candidates) {
		try {
			const st = fs.statSync(helper);
			// Already executable by someone — leave it as the operator/install
			// set it.
			if ((st.mode & 0o111) !== 0) continue;
			// `chmod +x`: add execute for user/group/other, preserve the rest.
			fs.chmodSync(helper, st.mode | 0o111);
			fixed.push(helper);
		} catch {
			// Not present in this layout, or chmod refused — try the next.
		}
	}
	return fixed;
}
