import http from "node:http";
import https from "node:https";

const DEFAULT_TIMEOUT_MS = 750;

/**
 * Probe a host:port to see whether a clawback proxy is already listening.
 *
 * Issues `GET /<adminPathPrefix>/health` with a short timeout. The response
 * is treated as "this is clawback" only when:
 *   - HTTP 200,
 *   - body parses as JSON,
 *   - body has `status === "ok"` and a `config` object,
 *   - that `config` carries the `_clawback: true` marker plus
 *     clawback-specific keys (`keepAliveMinMs`, `adminPathPrefix`).
 *
 * This guard is what lets `clawback claude` safely auto-attach: if some
 * unrelated service happens to be on the configured port we do NOT silently
 * point claude at it. The caller decides what to do (current behaviour: log
 * the surface and bail rather than start a parallel proxy on a different
 * port — surprising the operator either way).
 *
 * Returns `{reachable, isClawback, info, error, tls}`:
 *   - `reachable: true` iff the TCP+HTTP request completed (any status).
 *   - `isClawback: true` iff the response passes the shape check above.
 *   - `info`: the parsed body when the response was JSON, else null. On
 *     success this carries `config` so callers can react to settings the
 *     running server has (e.g. warn that `autoContinue` is on but won't
 *     fire across processes — see PLAN §30).
 *   - `error`: a short string describing why we decided "not clawback" or
 *     "unreachable" — useful for log lines.
 *   - `tls`: the transport the probe actually used (true=https). When an
 *     HTTP probe follows clawback's 308 upgrade, this reflects the https
 *     re-probe, so callers can self-heal a local config that predates the
 *     server's open-network TLS auto-enable.
 *
 * Never throws; all failure modes (refused connection, timeout, garbage
 * body, wrong shape) are reported through the return shape.
 */
export async function probeClawback({
	host,
	port,
	adminPathPrefix = "_proxy",
	timeoutMs = DEFAULT_TIMEOUT_MS,
	httpModule = null,
	tls = false,
} = {}) {
	const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const path = `/${adminPathPrefix}/health`;
	// Default the transport to the protocol the local config says clawback
	// uses. The probe is same-host (we rewrite wildcard binds to loopback
	// above), so self-signed cert validation is uninteresting — accept any
	// cert. `httpModule` override is retained for tests that want a fake.
	const mod = httpModule ?? (tls ? https : http);

	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		const req = mod.request(
			{
				host: probeHost,
				port,
				path,
				method: "GET",
				timeout: timeoutMs,
				headers: { accept: "application/json" },
				rejectUnauthorized: false,
			},
			(res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					raw += chunk;
					if (raw.length > 64 * 1024) {
						req.destroy();
					}
				});
				res.on("end", () => {
					// clawback's TLS dispatcher answers plain HTTP with a 308 to
					// https:// and tags it `x-clawback-upgrade: https`. When we
					// probed over HTTP (local config resolved tls=false) but the
					// live server is actually serving TLS — the common case where
					// the *server* was started with a non-loopback host (TLS
					// auto-enables) while `clawback claude` runs from a dir whose
					// config has neither — follow that signal once and re-probe
					// over HTTPS. Without this the launcher sees the 308, decides
					// "not clawback", and refuses to attach to a good proxy.
					// Recognized via clawback's upgrade marker or an https:// Location
					// (see isClawbackUpgrade); the 3xx gate keeps a 200/4xx — or a
					// redirect pointing back at http — from triggering a re-probe.
					if (!tls && isClawbackUpgrade(res.statusCode, res.headers)) {
						return finish(
							probeClawback({
								host,
								port,
								adminPathPrefix,
								timeoutMs,
								tls: true,
							}),
						);
					}
					if (res.statusCode !== 200) {
						return finish({
							reachable: true,
							isClawback: false,
							info: null,
							error: `non-200 status ${res.statusCode} from ${path}`,
							tls: mod === https,
						});
					}
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch {
						return finish({
							reachable: true,
							isClawback: false,
							info: null,
							error: "response body is not JSON",
							tls: mod === https,
						});
					}
					if (!isClawbackHealth(parsed)) {
						return finish({
							reachable: true,
							isClawback: false,
							info: parsed,
							error: "response shape does not look like clawback /health",
							tls: mod === https,
						});
					}
					finish({
						reachable: true,
						isClawback: true,
						info: parsed,
						error: null,
						tls: mod === https,
					});
				});
				res.on("error", (e) => {
					finish({
						reachable: true,
						isClawback: false,
						info: null,
						error: `response stream error: ${e.message}`,
						tls: mod === https,
					});
				});
			},
		);

		req.on("timeout", () => {
			req.destroy(new Error("probe timeout"));
		});
		req.on("error", (e) => {
			finish({
				reachable: false,
				isClawback: false,
				info: null,
				error: e.message,
				tls: mod === https,
			});
		});
		req.end();
	});
}

function isClawbackHealth(body) {
	if (!body || typeof body !== "object") return false;
	if (body.status !== "ok") return false;
	const cfg = body.config;
	if (!cfg || typeof cfg !== "object") return false;
	return (
		cfg._clawback === true &&
		typeof cfg.keepAliveMinMs === "number" &&
		typeof cfg.adminPathPrefix === "string"
	);
}

/**
 * Recognize clawback's HTTP→HTTPS upgrade signal. The TLS dispatcher answers
 * plain HTTP with a 3xx redirect to https:// and stamps `x-clawback-upgrade:
 * https`. We treat either marker as the upgrade so the probe can re-issue over
 * TLS. Gated to 3xx so an unrelated service's stray redirect (or a 200/4xx)
 * can't bounce the probe onto a transport the server isn't speaking.
 */
function isClawbackUpgrade(statusCode, headers) {
	if (typeof statusCode !== "number" || statusCode < 300 || statusCode >= 400)
		return false;
	if (headers?.["x-clawback-upgrade"] === "https") return true;
	const loc = headers?.location;
	return typeof loc === "string" && loc.startsWith("https://");
}
