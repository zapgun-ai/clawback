/**
 * Self-loop detection for the upstream URL.
 *
 * Catches the case where `config.upstream` resolves to the same address
 * clawback is bound on — most commonly when the operator already
 * exported `ANTHROPIC_BASE_URL=http://127.0.0.1:8080` (pointing at
 * clawback) and then started clawback with `--upstream-from-env`,
 * which would silently capture clawback's own address as upstream and
 * forward every request to itself in an infinite loop.
 *
 * Returns true if `upstream` points at clawback's own bound address
 * (any loopback host on the same port). Returns false otherwise. Never
 * throws — caller decides what to do on a loop.
 */

const LOOPBACK_HOSTS = new Set([
	"127.0.0.1",
	"localhost",
	"::1",
	"[::1]",
	"0.0.0.0", // wildcard bind reachable as loopback
	"::",
]);

export function detectSelfLoop({ upstream, bound }) {
	if (!upstream || !bound) return false;
	let url;
	try {
		url = new URL(upstream);
	} catch {
		return false;
	}

	const upstreamPort = Number.parseInt(
		url.port || (url.protocol === "https:" ? "443" : "80"),
		10,
	);
	if (!Number.isInteger(upstreamPort)) return false;
	if (upstreamPort !== bound.port) return false;

	const upstreamHost = url.hostname.toLowerCase();
	if (LOOPBACK_HOSTS.has(upstreamHost)) return true;
	// `bound.address` may be the literal we're listening on. If clawback
	// bound to a specific non-loopback IP and upstream points at the
	// same IP+port, that's also a loop.
	if (bound.address && upstreamHost === String(bound.address).toLowerCase()) {
		return true;
	}
	return false;
}
