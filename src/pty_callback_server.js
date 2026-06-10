import crypto from "node:crypto";
import http from "node:http";

/**
 * The reverse channel that lets a proxy in one process write into a PTY
 * owned by a different `clawback claude` launcher process.
 *
 * Topology when `clawback claude` attaches to an already-running proxy:
 *
 *   proxy process                       launcher process
 *   ┌─────────────────────────┐         ┌──────────────────────────┐
 *   │ POST /_proxy/claude/    │ (1)     │ start() returns          │
 *   │      input              │ <─────  │ {url, token, close}      │
 *   │   ↓                     │         │   ↑                      │
 *   │ writeInput()            │ (2)     │ http server bound to     │
 *   │   ↓ remote registered?  │ ─────>  │ 127.0.0.1:<rand>         │
 *   │ POST <url>/write        │         │ POST /write → pty.write()│
 *   └─────────────────────────┘         └──────────────────────────┘
 *
 * (1) Launcher calls start(), then POSTs the returned {url, token} to
 *     /_proxy/claude/register. The proxy's registerRemoteInput()
 *     validates and stores it.
 * (2) When auto-continue (or the UI continue button) hits the proxy's
 *     /_proxy/claude/input, writeInput() finds the remote and POSTs to
 *     it. The callback server here writes the bytes into the PTY.
 *
 * Security: bound to 127.0.0.1 only, bearer-token authenticated, and
 * the proxy refuses to register non-loopback callback URLs. A malicious
 * process on the same machine still has line-of-sight to the loopback
 * port — but it would also have line-of-sight to the PTY itself, so
 * the threat model isn't meaningfully worse than the existing in-process
 * design.
 */

const MAX_BODY_BYTES = 4 * 1024;

/**
 * Start a callback server that writes incoming bytes into the local PTY.
 *
 * @param {object} opts
 * @param {(text: string) => void} opts.writer - callback invoked with the
 *   text from each successful POST /write
 * @param {string} [opts.host="127.0.0.1"] - bind host (loopback by default)
 * @param {string} [opts.token] - bearer token; one is minted if omitted
 * @param {(msg: string) => void} [opts.onError] - optional error sink
 * @returns {Promise<{url:string, token:string, port:number, close:() => Promise<void>}>}
 */
export async function start({
	writer,
	host = "127.0.0.1",
	token = null,
	onError = null,
} = {}) {
	if (typeof writer !== "function") {
		throw new TypeError("pty_callback_server.start: writer must be a function");
	}
	const realToken = token ?? crypto.randomBytes(24).toString("hex");
	const server = http.createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (req.method !== "POST" || req.url !== "/write") {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "not_found" }));
				return;
			}
			const provided = parseBearer(req.headers.authorization);
			if (!provided || !tokenMatches(provided, realToken)) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch (e) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "bad_request", message: e.message }));
				return;
			}
			if (!body || typeof body.text !== "string") {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: "bad_request",
						message: "body must be {text: string}",
					}),
				);
				return;
			}
			try {
				writer(body.text);
			} catch (e) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: "writer_threw",
						message: e.message,
					}),
				);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					written: true,
					bytes: Buffer.byteLength(body.text, "utf8"),
				}),
			);
		} catch (e) {
			onError?.(`pty callback handler crashed: ${e.message}`);
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "internal" }));
			}
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const addr = server.address();
	const port = typeof addr === "object" ? addr.port : 0;
	const url = `http://${host}:${port}`;

	const close = () =>
		new Promise((resolve) => {
			server.close(() => resolve());
		});

	return { url, token: realToken, port, close };
}

function parseBearer(authHeader) {
	if (typeof authHeader !== "string") return null;
	const m = authHeader.match(/^Bearer\s+(.+)$/i);
	return m ? m[1].trim() : null;
}

function tokenMatches(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length) return false;
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	return crypto.timingSafeEqual(aBuf, bBuf);
}

async function readBody(req) {
	return new Promise((resolve, reject) => {
		let bytes = 0;
		let settled = false;
		const chunks = [];
		const settle = (kind, value) => {
			if (settled) return;
			settled = true;
			if (kind === "ok") resolve(value);
			else reject(value);
		};
		req.on("data", (chunk) => {
			if (settled) return;
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				// Don't destroy the socket — that races the response write.
				// Settle the promise so the handler responds 400; further
				// chunks are dropped on the floor here. The kernel absorbs
				// them until the client's request body finishes.
				settle("err", new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) {
				settle("ok", null);
				return;
			}
			try {
				settle("ok", JSON.parse(raw));
			} catch (e) {
				settle("err", new Error(`invalid JSON: ${e.message}`));
			}
		});
		req.on("error", (e) => settle("err", e));
	});
}
