import { validateLabel } from "../src/clawback_id.js";
import {
	assignLabelIndex,
	composeIndexedLabel,
	computeDefaultSessionLabel,
	refreshLabelBranch,
	sanitizeLabelSegment,
} from "../src/session_label.js";

// Build a fake `runGit(args)` keyed by the joined argv, returning null for
// anything not in the map (mirrors the real wrapper's "git failed → null").
function fakeGit(responses) {
	return (args) => {
		const key = args.join(" ");
		return key in responses ? responses[key] : null;
	};
}

const COMMON_ABS = "rev-parse --path-format=absolute --git-common-dir";
const COMMON_REL = "rev-parse --git-common-dir";
const BRANCH = "rev-parse --abbrev-ref HEAD";
const SHORT = "rev-parse --short HEAD";

describe("computeDefaultSessionLabel", () => {
	test("main checkout → <repo>:<branch>", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({
				[COMMON_ABS]: "/home/me/clawback/.git",
				[BRANCH]: "main",
			}),
		});
		expect(label).toBe("clawback:main");
	});

	test("a worktree shares the MAIN repo name, distinguished by its branch", () => {
		// --git-common-dir resolves to the main repo's .git even from a linked
		// worktree, so two worktrees of `clawback` read as clawback:<branch>.
		const main = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({
				[COMMON_ABS]: "/home/me/clawback/.git",
				[BRANCH]: "main",
			}),
		});
		const wt = computeDefaultSessionLabel({
			cwd: "/home/me/clawback/.claude/worktrees/feat",
			runGit: fakeGit({
				[COMMON_ABS]: "/home/me/clawback/.git",
				[BRANCH]: "feat-auth",
			}),
		});
		expect(main).toBe("clawback:main");
		expect(wt).toBe("clawback:feat-auth");
	});

	test("detached HEAD → <repo>:@<short-sha>", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({
				[COMMON_ABS]: "/home/me/clawback/.git",
				[BRANCH]: "HEAD",
				[SHORT]: "a1b2c3d",
			}),
		});
		expect(label).toBe("clawback:@a1b2c3d");
		// The '@' marker must survive the server-side label gate.
		expect(() => validateLabel(label)).not.toThrow();
	});

	test("slashes (and other out-of-charset chars) in a branch become hyphens", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({
				[COMMON_ABS]: "/home/me/clawback/.git",
				[BRANCH]: "feature/JIRA-1",
			}),
		});
		expect(label).toBe("clawback:feature-JIRA-1");
	});

	test("outside a git repo → the launch directory's basename, no branch", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/some-project",
			runGit: fakeGit({}), // every git call fails
		});
		expect(label).toBe("some-project");
	});

	test("older git (no --path-format) → relative --git-common-dir resolved vs cwd", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({ [COMMON_REL]: ".git", [BRANCH]: "main" }),
		});
		expect(label).toBe("clawback:main");
	});

	test("repo resolved but branch unavailable → repo segment only", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({ [COMMON_ABS]: "/home/me/clawback/.git" }),
		});
		expect(label).toBe("clawback");
	});

	test("a very long branch is capped and the result still passes validateLabel", () => {
		const label = computeDefaultSessionLabel({
			cwd: "/home/me/clawback",
			runGit: fakeGit({
				[COMMON_ABS]: "/home/me/clawback/.git",
				[BRANCH]: "feature/an-extremely-long-branch-name-that-exceeds-the-cap",
			}),
		});
		expect(label.startsWith("clawback:")).toBe(true);
		expect(label.length).toBeLessThanOrEqual(64);
		expect(() => validateLabel(label)).not.toThrow();
	});

	test("real git in this repo returns clawback:<branch> (smoke)", () => {
		// No injected runGit → exercises the real spawnSync wrapper against this
		// checkout. Asserts shape, not the exact branch (CI/worktrees vary).
		const label = computeDefaultSessionLabel({ cwd: process.cwd() });
		expect(label).toMatch(/^clawback:.+/);
	});
});

describe("refreshLabelBranch", () => {
	test("swaps the branch segment of a repo:branch label", () => {
		expect(refreshLabelBranch("clawback:main", "feat-x")).toBe(
			"clawback:feat-x",
		);
	});

	test("preserves a host:repo prefix, swapping only the last segment", () => {
		expect(refreshLabelBranch("alexmac:clawback:main", "hotfix")).toBe(
			"alexmac:clawback:hotfix",
		);
	});

	test("sanitizes the incoming branch (slashes → hyphens)", () => {
		expect(refreshLabelBranch("clawback:main", "feature/JIRA-1")).toBe(
			"clawback:feature-JIRA-1",
		);
	});

	test("preserves a detached-HEAD @<sha> marker", () => {
		expect(refreshLabelBranch("clawback:main", "@a1b2c3d")).toBe(
			"clawback:@a1b2c3d",
		);
	});

	test("returns null when the stored label has no branch segment (no colon)", () => {
		// A non-git launch label (bare dir name) has nothing to swap.
		expect(refreshLabelBranch("clawback", "main")).toBeNull();
	});

	test("returns null for an empty or sanitizes-to-empty branch", () => {
		expect(refreshLabelBranch("clawback:main", "")).toBeNull();
		expect(refreshLabelBranch("clawback:main", "///")).toBeNull();
	});
});

describe("composeIndexedLabel", () => {
	test("appends the index as a final colon-segment", () => {
		expect(composeIndexedLabel("clawback:main", 0)).toBe("clawback:main:0");
		expect(composeIndexedLabel("clawback:main", 7)).toBe("clawback:main:7");
		expect(composeIndexedLabel("myproject", 2)).toBe("myproject:2");
	});

	test("trims the base (never the index) when the total would exceed the cap", () => {
		const base = "a".repeat(64);
		const out = composeIndexedLabel(base, 11);
		expect(out.length).toBeLessThanOrEqual(64);
		expect(out.endsWith(":11")).toBe(true);
		expect(() => validateLabel(out)).not.toThrow();
	});

	test("rejects a bad base or a negative / non-integer index", () => {
		expect(composeIndexedLabel("", 0)).toBeNull();
		expect(composeIndexedLabel("clawback:main", -1)).toBeNull();
		expect(composeIndexedLabel("clawback:main", 1.5)).toBeNull();
	});
});

describe("assignLabelIndex", () => {
	const auto = (key, labelBase, labelIndex) => ({
		key,
		labelBase,
		labelIndex,
		labelSource: "auto",
	});

	test("a fresh base yields 0", () => {
		expect(assignLabelIndex([], "self", "clawback:main")).toBe(0);
		expect(
			assignLabelIndex([auto("x", "other:branch", 0)], "self", "clawback:main"),
		).toBe(0);
	});

	test("increments past indices already taken on the same base", () => {
		const sessions = [
			auto("a", "clawback:main", 0),
			auto("b", "clawback:main", 1),
		];
		expect(assignLabelIndex(sessions, "self", "clawback:main")).toBe(2);
	});

	test("reuses the smallest freed index (a gap in the middle)", () => {
		const sessions = [
			auto("a", "clawback:main", 0),
			auto("c", "clawback:main", 2),
		];
		expect(assignLabelIndex(sessions, "self", "clawback:main")).toBe(1);
	});

	test("excludes the session's own record so it keeps its slot", () => {
		const sessions = [auto("self", "clawback:main", 3)];
		expect(assignLabelIndex(sessions, "self", "clawback:main")).toBe(0);
	});

	test("operator-labeled sessions don't reserve an index", () => {
		const sessions = [
			{ key: "op", label: "clawback:main", labelSource: "operator" },
		];
		expect(assignLabelIndex(sessions, "self", "clawback:main")).toBe(0);
	});
});

describe("sanitizeLabelSegment", () => {
	test("keeps the label-safe charset and maps the rest to hyphens", () => {
		expect(sanitizeLabelSegment("feature/JIRA-1")).toBe("feature-JIRA-1");
		expect(sanitizeLabelSegment("v1.2.3")).toBe("v1.2.3");
		expect(sanitizeLabelSegment("--trim--")).toBe("trim");
		expect(sanitizeLabelSegment("a@b#c")).toBe("a-b-c");
	});
});
