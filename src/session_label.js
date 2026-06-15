import { spawnSync } from "node:child_process";
import path from "node:path";
import { LABEL_MAX_LEN, validateLabel } from "./clawback_id.js";

/**
 * Default display label for a `clawback claude` session, derived from the
 * launch directory's git context: `<repo>:<branch>` (e.g. `clawback:main`).
 *
 * The session's canonical id (the minted clawback key) is unchanged — this is
 * purely the human-facing label shown on the statusline and in the dashboard
 * sessions table when the operator didn't pass an explicit `--label`.
 *
 * Worktree-aware: `--git-common-dir` resolves to the MAIN repo for every
 * linked worktree, so all worktrees of one repo share the `<repo>` segment and
 * the branch is the distinguisher (`clawback:main`, `clawback:feat-x`). Since a
 * worktree is pinned to its branch, the label stays correct for its lifetime.
 *
 *   - detached HEAD → `<repo>:@<short-sha>`
 *   - not a git repo / git missing → the launch directory's basename (no branch)
 *   - nothing usable → null (caller leaves the label unset → the key is shown)
 *
 * `runGit(args) => string|null` is injectable for tests; production uses a
 * `spawnSync` wrapper bound to `cwd`/`env`.
 */
export function computeDefaultSessionLabel({
	cwd = process.cwd(),
	env = process.env,
	runGit,
} = {}) {
	const git =
		typeof runGit === "function"
			? runGit
			: (args) => defaultRunGit(args, cwd, env);

	const repo = resolveRepoName(git, cwd);
	if (!repo) {
		// Not a git repo (or git unavailable): fall back to the directory name.
		return finalizeLabel(sanitizeLabelSegment(path.basename(cwd)));
	}
	const repoSeg = sanitizeLabelSegment(repo);
	if (!repoSeg) return null;

	const branchSeg = resolveBranchSegment(git);
	if (!branchSeg) return finalizeLabel(repoSeg);
	return finalizeLabel(`${repoSeg}:${branchSeg}`);
}

/**
 * Recompose a stored `[host:]repo:branch` label with a fresh branch — used by
 * the statusline endpoint so the line tracks a mid-session `git checkout`.
 * Replaces the final colon-segment (the branch) with the sanitized fresh
 * branch, preserving any `host:`/`repo:` prefix. `rawBranch` may carry a
 * leading `@` (the detached-HEAD marker), which is preserved.
 *
 * Returns the new validated label, or null when the stored label has no branch
 * segment (no colon) or the result wouldn't pass validateLabel.
 */
export function refreshLabelBranch(storedLabel, rawBranch) {
	if (typeof storedLabel !== "string" || !storedLabel.includes(":")) {
		return null;
	}
	if (typeof rawBranch !== "string" || rawBranch.length === 0) return null;
	const detached = rawBranch.startsWith("@");
	const clean = sanitizeLabelSegment(detached ? rawBranch.slice(1) : rawBranch);
	if (!clean) return null;
	const branchSeg = detached ? `@${clean}` : clean;
	const next = storedLabel.replace(/:[^:]*$/, `:${branchSeg}`);
	try {
		return validateLabel(next);
	} catch {
		return null;
	}
}

/**
 * Compose an auto label as `<base>:<index>` (e.g. `clawback:main:0`). The
 * index is the per-base uniqueness differentiator so concurrent sessions in the
 * same repo/worktree/branch are distinguishable. If the composed string would
 * exceed LABEL_MAX_LEN, the base is trimmed (never the index — that's the part
 * that must stay unique). Returns the validated label, or null if nothing valid
 * remains.
 */
export function composeIndexedLabel(base, index) {
	if (typeof base !== "string" || base.length === 0) return null;
	if (!Number.isInteger(index) || index < 0) return null;
	const suffix = `:${index}`;
	let head = base;
	if (head.length + suffix.length > LABEL_MAX_LEN) {
		head = head
			.slice(0, LABEL_MAX_LEN - suffix.length)
			.replace(/[-._ :@]+$/, "");
	}
	if (!head) return null;
	try {
		return validateLabel(`${head}${suffix}`);
	} catch {
		return null;
	}
}

/**
 * Pick the uniqueness index for a new auto session whose label base (the
 * `[host:]repo:branch` part, no trailing `:N`) is `base`. The index is the
 * smallest non-negative integer not already taken by ANOTHER auto session
 * sharing the same base — so a fresh base yields 0, the next concurrent session
 * 1, and a closed session's index is reused. Server-side only: the proxy's
 * session store is the sole place that can see every concurrent session.
 *
 * `sessions` is an iterable of records shaped `{ key, labelBase, labelIndex,
 * labelSource }` (the proxy store's values). `selfKey` is excluded so a session
 * re-resolving its own label keeps its slot.
 */
export function assignLabelIndex(sessions, selfKey, base) {
	const taken = new Set();
	for (const s of sessions) {
		if (!s || s.key === selfKey) continue;
		if (s.labelSource === "operator") continue;
		if (s.labelBase !== base) continue;
		if (Number.isInteger(s.labelIndex) && s.labelIndex >= 0) {
			taken.add(s.labelIndex);
		}
	}
	let i = 0;
	while (taken.has(i)) i++;
	return i;
}

function defaultRunGit(args, cwd, env) {
	try {
		const r = spawnSync("git", args, {
			cwd,
			env,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (r.status === 0 && typeof r.stdout === "string") {
			const out = r.stdout.trim();
			return out.length > 0 ? out : null;
		}
	} catch {
		/* git missing / spawn failure → null */
	}
	return null;
}

// The MAIN repo's name, shared by every linked worktree. `--git-common-dir`
// points at the shared `.git` dir; its parent directory is the repo root.
function resolveRepoName(git, cwd) {
	let commonDir = git([
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!commonDir) {
		// Older git without --path-format: resolve a possibly-relative path
		// against the launch dir.
		const rel = git(["rev-parse", "--git-common-dir"]);
		if (!rel) return null;
		commonDir = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
	}
	const repoRoot = path.dirname(commonDir);
	const name = path.basename(repoRoot);
	return name && name !== "." && name !== path.sep ? name : null;
}

function resolveBranchSegment(git) {
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch) return null;
	if (branch !== "HEAD") return sanitizeLabelSegment(branch);
	// Detached HEAD: mark with @<short-sha> so it doesn't read as a branch.
	const sha = git(["rev-parse", "--short", "HEAD"]);
	const cleanSha = sanitizeLabelSegment(sha ?? "");
	return cleanSha ? `@${cleanSha}` : null;
}

const SEGMENT_MAX = 28;

// Map a raw repo/branch segment into the label-safe charset: keep letters,
// digits, dot, underscore, hyphen, and space; everything else (slash in
// `feature/foo`, etc.) becomes a hyphen. Collapse repeats, trim edge
// punctuation, and cap the length so `repo:branch` stays under LABEL_MAX_LEN.
// Exported so the statusline endpoint sanitizes the live branch the same way.
export function sanitizeLabelSegment(raw) {
	if (typeof raw !== "string") return "";
	return raw
		.replace(/[^A-Za-z0-9._ -]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._ ]+|[-._ ]+$/g, "")
		.slice(0, SEGMENT_MAX)
		.trim();
}

// Guarantee the result passes the server's validateLabel (so postSessionLabel
// always lands). Returns the validated label, or null if nothing valid remains.
function finalizeLabel(candidate) {
	if (!candidate) return null;
	try {
		return validateLabel(candidate);
	} catch {
		return null;
	}
}
