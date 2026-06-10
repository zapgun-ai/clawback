/**
 * Singleton mutable handle to the active claude PTY input writer.
 *
 * Two registration modes:
 *
 *   1. Local writer (single-process mode). `clawback claude` spawns the PTY
 *      in the same process as the proxy. It calls `setActiveInput(fn)` with
 *      a function that writes to the PTY master. `writeInput()` invokes the
 *      function synchronously (wrapped in a resolved Promise so the call
 *      shape is uniform).
 *
 *   2. Remote registration (attach mode). `clawback claude` ran against an
 *      already-running proxy in a separate process. The PTY lives in the
 *      launcher process; the proxy's admin endpoint cannot reach it
 *      in-memory. The launcher exposes a tiny loopback HTTP listener
 *      (see `src/pty_callback_server.js`) and POSTs to
 *      `/_proxy/claude/register` so the proxy stores its callback URL +
 *      token. `writeInput()` then POSTs the bytes to the launcher, which
 *      writes them into the PTY.
 *
 * Precedence: a local writer always wins if both are present (in-process
 * is cheaper and avoids a network hop). Practically only one will be set
 * in a given proxy process at a time.
 *
 * `writeInput()` is async. The local path is effectively synchronous
 * (one microtask) but the remote path performs a fetch.
 */

let activeWriter = null;
let activeLabel = null;
let remoteRegistration = null;

const MAX_INPUT_BYTES = 4 * 1024;
const REMOTE_CALL_TIMEOUT_MS = 5000;

export function setActiveInput(writer, { label = "claude" } = {}) {
	if (typeof writer !== "function") {
		throw new TypeError("setActiveInput: writer must be a function");
	}
	activeWriter = writer;
	activeLabel = label;
}

export function clearActiveInput() {
	activeWriter = null;
	activeLabel = null;
}

export function hasActiveInput() {
	return activeWriter != null || remoteRegistration != null;
}

export function activeInputLabel() {
	if (activeWriter) return activeLabel;
	if (remoteRegistration) return remoteRegistration.label;
	return null;
}

/**
 * Register a remote PTY writer. Used when `clawback claude` is attached to
 * a separate proxy process — it stands up a small loopback listener and
 * tells the proxy how to reach it. `url` is the base (e.g.
 * `http://127.0.0.1:54321`); `writeInput()` appends `/write`. The
 * registration is rejected if `url` doesn't resolve to a loopback host —
 * a defensive check so a misconfigured client cannot trick the proxy into
 * POSTing arbitrary bytes to a non-local address.
 *
 * Throws on invalid input (caller-side bug). Replaces any previous
 * registration silently — the most recent `clawback claude` to attach
 * wins.
 */
export function registerRemoteInput({
	url,
	token = null,
	label = "claude-remote",
} = {}) {
	if (typeof url !== "string" || url.trim() === "") {
		throw new TypeError("registerRemoteInput: url must be a non-empty string");
	}
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`registerRemoteInput: invalid url ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`registerRemoteInput: url must be http:// or https://, got ${parsed.protocol}`,
		);
	}
	if (!isLoopbackHost(parsed.hostname)) {
		throw new Error(
			`registerRemoteInput: callback url must be loopback, got ${parsed.hostname}`,
		);
	}
	if (token != null && typeof token !== "string") {
		throw new TypeError(
			"registerRemoteInput: token must be a string when provided",
		);
	}
	const normalizedUrl = `${parsed.protocol}//${parsed.host}`;
	remoteRegistration = {
		url: normalizedUrl,
		token,
		label,
		registeredAt: new Date().toISOString(),
	};
}

export function clearRemoteInput() {
	remoteRegistration = null;
}

export function activeRemoteRegistration() {
	if (!remoteRegistration) return null;
	const { url, label, registeredAt } = remoteRegistration;
	return { url, label, registeredAt };
}

export async function writeInput(text) {
	if (typeof text !== "string") {
		return {
			written: false,
			reason: "input must be a string",
		};
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_INPUT_BYTES) {
		return {
			written: false,
			reason: `input exceeds ${MAX_INPUT_BYTES} bytes (got ${bytes})`,
		};
	}
	if (activeWriter) {
		try {
			activeWriter(text);
			return { written: true, bytes, label: activeLabel, mode: "local" };
		} catch (e) {
			return {
				written: false,
				reason: `writer threw: ${e.message}`,
			};
		}
	}
	if (remoteRegistration) {
		return await writeViaRemote(text, bytes);
	}
	return {
		written: false,
		reason:
			"no active claude session — start via `clawback claude` and ensure node-pty is installed",
	};
}

async function writeViaRemote(text, bytes) {
	const reg = remoteRegistration;
	const headers = { "content-type": "application/json" };
	if (reg.token) headers.authorization = `Bearer ${reg.token}`;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("timeout")),
		REMOTE_CALL_TIMEOUT_MS,
	);
	try {
		const r = await fetch(`${reg.url}/write`, {
			method: "POST",
			headers,
			body: JSON.stringify({ text }),
			signal: controller.signal,
		});
		if (!r.ok) {
			const detail = await r.text().catch(() => "");
			return {
				written: false,
				reason: `remote callback returned ${r.status}${detail ? `: ${detail}` : ""}`,
			};
		}
		return { written: true, bytes, label: reg.label, mode: "remote" };
	} catch (e) {
		const msg = e.name === "AbortError" ? "timeout" : e.message;
		return {
			written: false,
			reason: `remote callback failed: ${msg}`,
		};
	} finally {
		clearTimeout(timer);
	}
}

function isLoopbackHost(host) {
	if (host === "127.0.0.1" || host === "::1" || host === "localhost")
		return true;
	// 127.0.0.0/8 is all loopback per RFC 1122, not just 127.0.0.1.
	if (host.startsWith("127.")) return true;
	return false;
}
