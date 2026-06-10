import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

/**
 * Try to open a URL in the default desktop browser. Cross-platform, no
 * dependencies. Detached so the parent process can keep running.
 *
 * On failure we resolve to `false` rather than throw — the caller
 * almost always wants "best-effort, log if it failed" rather than
 * "crash the quickstart because the browser couldn't be opened."
 *
 * Honors `CLAWBACK_NO_OPEN_BROWSER=1` so headless / scripted invocations
 * can suppress the side effect without disabling the rest of the
 * quickstart flow.
 */
export function openBrowser(
	url,
	{ platform = process.platform, env = process.env } = {},
) {
	if (typeof url !== "string" || url.length === 0) return false;
	if (env.CLAWBACK_NO_OPEN_BROWSER === "1") return false;

	let cmd;
	let args;
	if (platform === "darwin") {
		cmd = "open";
		args = [url];
	} else if (platform === "win32") {
		cmd = "cmd";
		args = ["/c", "start", "", url];
	} else {
		// linux / freebsd / etc.
		cmd = "xdg-open";
		args = [url];
	}

	try {
		const child = spawn(cmd, args, {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			/* swallow — best effort */
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/**
 * Poll the proxy's /_proxy/health endpoint until it responds 200, then
 * resolve true. Resolves false if the deadline passes without success.
 *
 * Used by `clawback quickstart` to wait for the in-process proxy to be
 * listening before opening the browser — otherwise the browser races
 * the spawn and lands on a "connection refused" error page.
 */
export async function waitForUrl(
	url,
	{ timeoutMs = 8000, intervalMs = 150 } = {},
) {
	const started = Date.now();
	const isHttps = url.startsWith("https://");
	while (Date.now() - started < timeoutMs) {
		const ok = await pingOnce(url, isHttps).catch(() => false);
		if (ok) return true;
		await sleep(intervalMs);
	}
	return false;
}

function pingOnce(url, isHttps) {
	return new Promise((resolve) => {
		const lib = isHttps ? https : http;
		try {
			const req = lib.get(url, { rejectUnauthorized: false }, (res) => {
				res.resume();
				resolve(res.statusCode != null && res.statusCode < 500);
			});
			req.on("error", () => resolve(false));
			req.setTimeout(500, () => {
				req.destroy();
				resolve(false);
			});
		} catch {
			resolve(false);
		}
	});
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
