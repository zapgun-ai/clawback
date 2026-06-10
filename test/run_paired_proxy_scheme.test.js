import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// Regression for a silent-stall bug: a paired run fans ONE claude session
// through the tee to TWO clawback proxies. The tee forwards to those proxies
// over PLAIN HTTP (benchmark/bin/tee.js uses http.request). If the proxies come
// up HTTPS — which they do whenever an ambient CLAWBACK.md (local or global)
// sets `tls: true`, since the proxy honors that config layer — the tee's HTTP
// request is 308-redirected into a self-signed TLS handshake that fails. claude
// then surfaces "Self-signed certificate detected" and burns all 10 retries
// with ZERO turns billed, so the whole run produces no data.
//
// The fix: run_paired.sh must PIN both proxies to HTTP with `--tls off` (a CLI
// override beats the inherited tls:true), so the tee<->proxy hop is always
// plaintext regardless of ambient config. These tests lock the contract in.
describe("paired run pins benchmark proxies to HTTP (the tee speaks HTTP)", () => {
	test("the tee forwards to the proxies over plain HTTP, not HTTPS", () => {
		const tee = read("benchmark/bin/tee.js");
		expect(tee).toMatch(/http\.request\(/);
		expect(tee).not.toMatch(/https\.request\(/);
	});

	test("run_paired.sh launches BOTH detached proxies with --tls off", () => {
		// Join shell line-continuations so each launch is a single logical line.
		const sh = read(".skills/scripts/run_paired.sh").replace(/\\\n/g, " ");
		const launches = sh
			.split("\n")
			.filter((l) => l.includes("run_monitor.sh --detach"));
		// Exactly the SHADOW + PRIMARY proxy launches (the --stop cleanup lines
		// use run_monitor.sh without --detach, so they are not matched here).
		expect(launches.length).toBe(2);
		for (const l of launches) expect(l).toMatch(/--tls off/);
	});
});
