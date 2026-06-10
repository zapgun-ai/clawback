import { SAMPLE_PAYLOAD, runDoctor } from "../src/doctor.js";

// doctor's three external touch-points are all injectable, so every scenario
// below is driven without a real server, shell, or settings file:
//   - resolveStatusline → the per-tier statusLine picture (config check)
//   - runCommand        → the spawned curl's result      (command check)
//   - probe             → the live proxy probe           (proxy check)
// Each check classifies independently; the suite asserts the classification,
// not the prose.

const baseConfig = { host: "127.0.0.1", port: 8080, adminPathPrefix: "_proxy" };

const okProbe = {
	reachable: true,
	isClawback: true,
	info: {},
	error: null,
	tls: false,
};

// The self-healing local form clawback bakes: both -L (follow the 308) and
// -k (accept the self-signed cert).
const CLAWBACK_CMD = `bash -c 'curl -sf -L -k --data-binary @- "http://127.0.0.1:8080/_proxy/statusline/_default" || true'`;

function entry(
	tier,
	{ present = false, isClawback = false, command = null } = {},
) {
	return {
		tier,
		path: `/fake/${tier}/settings.json`,
		present,
		isClawback,
		block: command ? { type: "command", command } : null,
	};
}

function fakeStatusline({ entries, effective }) {
	return () => ({ entries, effective });
}

function fakeProbe(result, sink) {
	return async (args) => {
		if (sink) sink.push(args);
		return result;
	};
}

// runCommand is called synchronously (not awaited); return a plain object and
// record the invocation so tests can assert payload plumbing / non-invocation.
function fakeRun(result, calls) {
	return (command, opts) => {
		calls.push({ command, input: opts?.input, timeoutMs: opts?.timeoutMs });
		return { status: 0, stdout: "", stderr: "", error: null, ...result };
	};
}

function findCheck(report, name) {
	return report.checks.find((c) => c.name === name);
}

test("all healthy → ok, with config/command/proxy all passing", async () => {
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const calls = [];
	const probeCalls = [];
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ stdout: "clawback ctx 42%" }, calls),
		probe: fakeProbe(okProbe, probeCalls),
	});

	expect(report.ok).toBe(true);
	expect(findCheck(report, "config").status).toBe("pass");
	expect(findCheck(report, "command").status).toBe("pass");
	expect(findCheck(report, "proxy").status).toBe("pass");

	// The probe is driven from config and starts on HTTP so it can self-heal
	// up to HTTPS via clawback's 308 (https can't downgrade).
	expect(probeCalls[0]).toMatchObject({
		host: "127.0.0.1",
		port: 8080,
		adminPathPrefix: "_proxy",
		tls: false,
	});
	// The command check feeds Claude Code's representative payload on stdin.
	expect(JSON.parse(calls[0].input)).toMatchObject({
		hook_event_name: "Status",
	});
});

test("no statusLine anywhere → config fail, command skipped, runCommand untouched", async () => {
	const calls = [];
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({
			entries: [entry("user"), entry("project"), entry("project-local")],
			effective: null,
		}),
		runCommand: fakeRun({ stdout: "should not run" }, calls),
		probe: fakeProbe(okProbe),
	});

	expect(report.ok).toBe(false);
	const config = findCheck(report, "config");
	expect(config.status).toBe("fail");
	expect(config.message).toMatch(/setup claude/);
	expect(findCheck(report, "command").status).toBe("skip");
	expect(calls).toHaveLength(0);
});

test("active block is non-clawback but a lower tier holds clawback's → config fail names the shadowed tier", async () => {
	const userE = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const projectE = entry("project", {
		present: true,
		isClawback: false,
		command: "echo hi",
	});
	const calls = [];
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({
			entries: [userE, projectE],
			effective: projectE,
		}),
		runCommand: fakeRun({ stdout: "x" }, calls),
		probe: fakeProbe(okProbe),
	});

	expect(report.ok).toBe(false);
	const config = findCheck(report, "config");
	expect(config.status).toBe("fail");
	expect(config.message).toMatch(/shadows/);
	expect(config.message).toMatch(/user/);
	// Active block isn't clawback's → nothing to run.
	expect(findCheck(report, "command").status).toBe("skip");
	expect(calls).toHaveLength(0);
});

test("clawback active but a redundant lower clawback block exists → config warn, still ok", async () => {
	const userE = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const localE = entry("project-local", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const calls = [];
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({
			entries: [userE, localE],
			effective: localE,
		}),
		runCommand: fakeRun({ stdout: "clawback ctx 42%" }, calls),
		probe: fakeProbe(okProbe),
	});

	// A warning must not flip the overall verdict to failure.
	expect(report.ok).toBe(true);
	const config = findCheck(report, "config");
	expect(config.status).toBe("warn");
	expect(config.message).toMatch(/[Rr]edundant/);
	expect(config.message).toMatch(/user/);
	expect(findCheck(report, "command").status).toBe("pass");
});

test("empty output + proxy down → command fail and proxy fail", async () => {
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const downProbe = {
		reachable: false,
		isClawback: false,
		info: null,
		error: "ECONNREFUSED",
		tls: false,
	};
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ stdout: "" }, []),
		probe: fakeProbe(downProbe),
	});

	expect(report.ok).toBe(false);
	const command = findCheck(report, "command");
	expect(command.status).toBe("fail");
	expect(command.message).toMatch(/not reachable/);
	const proxy = findCheck(report, "proxy");
	expect(proxy.status).toBe("fail");
	expect(proxy.message).toMatch(/not reachable/);
	expect(proxy.message).toMatch(/ECONNREFUSED/);
});

test("empty output + HTTPS proxy + command missing -k → command fail names -k", async () => {
	const cmdNoK = `bash -c 'curl -sf -L --data-binary @- "https://127.0.0.1:8080/_proxy/statusline/_default" || true'`;
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: cmdNoK,
	});
	const httpsProbe = { ...okProbe, tls: true };
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ stdout: "" }, []),
		probe: fakeProbe(httpsProbe),
	});

	expect(report.ok).toBe(false);
	const command = findCheck(report, "command");
	expect(command.status).toBe("fail");
	expect(command.message).toMatch(/-k/);
	// Proxy itself is healthy over HTTPS — the fault is the baked command.
	expect(findCheck(report, "proxy").status).toBe("pass");
});

test("empty output + HTTPS proxy + command missing -L → command fail names -L", async () => {
	const cmdNoL = `bash -c 'curl -sf -k --data-binary @- "https://127.0.0.1:8080/_proxy/statusline/_default" || true'`;
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: cmdNoL,
	});
	const httpsProbe = { ...okProbe, tls: true };
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ stdout: "" }, []),
		probe: fakeProbe(httpsProbe),
	});

	const command = findCheck(report, "command");
	expect(command.status).toBe("fail");
	expect(command.message).toMatch(/-L/);
});

test("command emits an unfollowed redirect → command fail names -L (even with non-empty output)", async () => {
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun(
			{ stdout: "Redirecting to https://127.0.0.1:8080/_proxy/statusline" },
			[],
		),
		probe: fakeProbe(okProbe),
	});

	const command = findCheck(report, "command");
	expect(command.status).toBe("fail");
	expect(command.message).toMatch(/redirect/i);
	expect(command.message).toMatch(/-L/);
});

test("proxy reachable but not clawback → proxy warn, overall still ok", async () => {
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const notClawbackProbe = {
		reachable: true,
		isClawback: false,
		info: null,
		error: "response shape does not look like clawback /health",
		tls: false,
	};
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ stdout: "clawback ctx 42%" }, []),
		probe: fakeProbe(notClawbackProbe),
	});

	expect(report.ok).toBe(true);
	const proxy = findCheck(report, "proxy");
	expect(proxy.status).toBe("warn");
	expect(proxy.message).toMatch(/doesn't look like clawback/);
});

test("command spawn error → command fail reports the underlying error", async () => {
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ error: new Error("spawn bash ENOENT") }, []),
		probe: fakeProbe(okProbe),
	});

	expect(report.ok).toBe(false);
	const command = findCheck(report, "command");
	expect(command.status).toBe("fail");
	expect(command.message).toMatch(/Could not execute/);
	expect(command.message).toMatch(/ENOENT/);
});

test("ANSI escape codes are stripped from the rendered-statusline preview", async () => {
	const e = entry("user", {
		present: true,
		isClawback: true,
		command: CLAWBACK_CMD,
	});
	const report = await runDoctor({
		config: baseConfig,
		resolveStatusline: fakeStatusline({ entries: [e], effective: e }),
		runCommand: fakeRun({ stdout: "[32m≡ 42%[0m" }, []),
		probe: fakeProbe(okProbe),
	});

	const command = findCheck(report, "command");
	expect(command.status).toBe("pass");
	expect(command.message).toContain("42%");
	// No raw ESC byte and no leftover SGR sequence in the preview.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the preview contains no raw ESC control char
	expect(command.message).not.toMatch(//);
	expect(command.message).not.toContain("[32m");
});

test("SAMPLE_PAYLOAD omits current_usage so running doctor records no real metrics", () => {
	// The server treats a statusline POST with no current_usage as "fresh" and
	// records no token/cost sample — so doctor's probe can't pollute live
	// session metrics. Guard that contract here.
	expect(SAMPLE_PAYLOAD.hook_event_name).toBe("Status");
	expect(SAMPLE_PAYLOAD).not.toHaveProperty("current_usage");
});
