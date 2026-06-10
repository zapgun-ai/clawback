import { spawnSync } from "node:child_process";
import { probeClawback } from "./probe.js";
import { resolveEffectiveStatusline } from "./setup_statusline.js";

/**
 * `clawback doctor` — diagnose why the statusline (or the proxy behind it)
 * isn't working. It reproduces the exact failure that sent an operator's
 * statusline dark on 2026-05-28: a stale, higher-precedence statusLine block
 * whose curl couldn't trust the server's cert, silently swallowed by the
 * baked `|| true`.
 *
 * Three checks, each returning pass/warn/fail with an actionable message:
 *   1. config   — which settings tier Claude Code actually uses, and whether
 *                 a clawback block at another tier shadows it.
 *   2. command  — run that exact statusLine command with a representative
 *                 Claude Code payload on stdin; classify the output.
 *   3. proxy    — independently probe the proxy (probeClawback) to confirm
 *                 it's up, is clawback, and over which transport.
 *
 * Everything that touches the outside world (spawning curl, hitting the
 * network) is injectable so the suite can drive deterministic scenarios
 * without a real server or a real shell.
 */

// A minimal but realistic Claude Code statusLine payload. `current_usage` is
// omitted on purpose: the server's statusline POST treats a payload with no
// current_usage as "fresh" and records no token/cost metrics, so running
// doctor doesn't pollute real session metrics. `used_percentage` still drives
// a visible render, so a healthy proxy returns non-empty output.
export const SAMPLE_PAYLOAD = {
	hook_event_name: "Status",
	session_id: "_clawback_doctor",
	model: { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
	context_window: { used_percentage: 42 },
};

function defaultRunCommand(command, { input, timeoutMs }) {
	const r = spawnSync(command, {
		shell: true,
		input,
		timeout: timeoutMs,
		encoding: "utf8",
	});
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		error: r.error ?? null,
	};
}

function previewLine(s, max = 80) {
	const firstLine = String(s).split("\n")[0] ?? "";
	// Strip ANSI so the preview reads cleanly in any terminal.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR
	const noAnsi = firstLine.replace(/\[[0-9;]*m/g, "");
	return noAnsi.length > max ? `${noAnsi.slice(0, max - 1)}…` : noAnsi;
}

export async function runDoctor({
	cwd = process.cwd(),
	env = process.env,
	config = {},
	runCommand = defaultRunCommand,
	probe = probeClawback,
	resolveStatusline = resolveEffectiveStatusline,
	payload = SAMPLE_PAYLOAD,
	commandTimeoutMs = 5000,
} = {}) {
	const checks = [];
	const push = (name, status, message, detail) =>
		checks.push(
			detail ? { name, status, message, detail } : { name, status, message },
		);

	const host = config.host ?? "127.0.0.1";
	const port = config.port ?? 8080;
	const adminPathPrefix = config.adminPathPrefix ?? "_proxy";

	// Probe up front so the command check can explain a silent (|| true)
	// failure using the live transport state. tls:false is deliberate:
	// clawback's single-port dispatcher answers plain HTTP with a 308 to
	// https, so an HTTP probe self-heals UP to https; starting from https
	// can't downgrade, so http-first is the robust default.
	const probeResult = await probe({ host, port, adminPathPrefix, tls: false });

	// ---- Check 1: configuration / tier resolution ----
	const { entries, effective } = resolveStatusline({ cwd, env });
	const clawbackTiers = entries.filter((e) => e.isClawback);
	if (!effective) {
		push(
			"config",
			"fail",
			"No statusLine is configured in Claude Code's settings (user / project / project-local). Run `clawback setup claude`.",
		);
	} else if (!effective.isClawback) {
		if (clawbackTiers.length > 0) {
			const shadowed = clawbackTiers
				.map((e) => `${e.tier} (${e.path})`)
				.join(", ");
			push(
				"config",
				"fail",
				`The active statusLine at the ${effective.tier} tier is NOT clawback's, and it shadows clawback's block at: ${shadowed}. Remove the ${effective.tier} block, or re-run \`clawback setup claude\` targeting a higher-precedence tier.`,
			);
		} else {
			push(
				"config",
				"warn",
				`The active statusLine at the ${effective.tier} tier is not clawback-managed. If you meant to use clawback, run \`clawback setup claude\`.`,
			);
		}
	} else {
		const shadowed = clawbackTiers.filter((e) => e.tier !== effective.tier);
		if (shadowed.length > 0) {
			const where = shadowed.map((e) => e.tier).join(", ");
			push(
				"config",
				"warn",
				`clawback statusLine is active at the ${effective.tier} tier (${effective.path}). Redundant clawback blocks also exist at: ${where} — harmless now, but they'll shadow this one if they ever diverge. Consider \`clawback uninstall claude\` on the lower tiers.`,
			);
		} else {
			push(
				"config",
				"pass",
				`clawback statusLine is active at the ${effective.tier} tier (${effective.path}).`,
			);
		}
	}

	// ---- Check 2: command execution ----
	const command = effective?.isClawback ? effective.block?.command : null;
	if (!command) {
		push(
			"command",
			"skip",
			"Skipped — no clawback statusLine command to run (see config check).",
		);
	} else {
		const res = runCommand(command, {
			input: JSON.stringify(payload),
			timeoutMs: commandTimeoutMs,
		});
		const stdout = (res.stdout ?? "").trim();
		const looksLikeRedirect =
			/\bredirect(ing)?\b|moved permanently|<html|<!doctype/i.test(
				res.stdout ?? "",
			);
		if (res.error) {
			push(
				"command",
				"fail",
				`Could not execute the statusLine command: ${res.error.message ?? res.error}.`,
			);
		} else if (looksLikeRedirect) {
			push(
				"command",
				"fail",
				"The command emitted an unfollowed HTTP redirect — curl is missing `-L`, so it won't follow clawback's 308 http→https upgrade. Re-run `clawback setup claude --force`.",
			);
		} else if (stdout.length > 0) {
			push(
				"command",
				"pass",
				`Command rendered a statusline: "${previewLine(stdout)}"`,
			);
		} else {
			// Empty output. The baked `|| true` masks curl's real exit, so use
			// the live probe + the command's own flags to name the likely cause.
			const hasK = command.includes(" -k ") || command.includes(" -k'");
			const hasL = command.includes(" -L ") || command.includes(" -L'");
			if (!probeResult.reachable) {
				push(
					"command",
					"fail",
					`The command produced no output and clawback is not reachable at ${host}:${port}. Is the proxy running? Start it with \`clawback\` (or \`clawback claude\`).`,
				);
			} else if (probeResult.tls && !hasK) {
				push(
					"command",
					"fail",
					"The command produced no output: clawback is serving HTTPS with a self-signed cert but the command lacks `-k`, so curl rejects it (silently, via `|| true`). Re-run `clawback setup claude --force`.",
				);
			} else if (probeResult.tls && !hasL) {
				push(
					"command",
					"fail",
					"The command produced no output: clawback upgraded to HTTPS (308) but the command lacks `-L`, so curl won't follow it. Re-run `clawback setup claude --force`.",
				);
			} else {
				push(
					"command",
					"fail",
					"The command produced no output even though clawback is reachable. The `|| true` is masking a curl error — run the curl by hand (without `|| true`) to see it.",
				);
			}
		}
	}

	// ---- Check 3: proxy reachability ----
	const scheme = probeResult.tls ? "https" : "http";
	if (!probeResult.reachable) {
		push(
			"proxy",
			"fail",
			`clawback is not reachable at ${scheme}://${host}:${port}/${adminPathPrefix}/health (${probeResult.error ?? "no response"}). Is it running?`,
		);
	} else if (!probeResult.isClawback) {
		push(
			"proxy",
			"warn",
			`Something is listening at ${host}:${port}, but it doesn't look like clawback (${probeResult.error ?? "unexpected response"}).`,
		);
	} else {
		push(
			"proxy",
			"pass",
			`clawback is up at ${scheme}://${host}:${port} (transport: ${scheme}).`,
		);
	}

	const ok = checks.every((c) => c.status !== "fail");
	return { ok, checks, effective, probe: probeResult };
}
