#!/usr/bin/env node
// Config doctor: load the merged config exactly as the proxy would and print a
// secret-free summary. Exits non-zero if the canonical CLAWBACK.md did not take
// effect (host not 0.0.0.0, tls not on, or adminToken missing) so a bad parse
// fails loudly instead of silently falling back to loopback defaults.
//
// Usage: node .skills/verify-config/scripts/verify_config_parse.mjs [cwd]
import { loadConfig } from "../../../src/config.js";

const cwd = process.argv[2] ? process.argv[2] : process.cwd();
const { config, sources, warnings } = loadConfig({ cwd, env: process.env });

console.log("sources (merge order):");
if (sources.length === 0) console.log("  (none — only DEFAULTS)");
for (const s of sources) console.log(`  - ${s.tier}: ${s.path}`);

console.log("\nresolved:");
console.log(`  host                = ${config.host}`);
console.log(`  port                = ${config.port}`);
console.log(`  tls                 = ${config.tls}`);
console.log(`  tlsCertFile         = ${config.tlsCertFile}`);
console.log(`  tlsKeyFile          = ${config.tlsKeyFile}`);
console.log(`  selfSign            = ${config.selfSign}`);
console.log(
	`  adminToken          = ${config.adminToken ? `present (${config.adminToken.length} chars)` : "MISSING"}`,
);
console.log(`  passthrough         = ${config.passthrough}`);
console.log(`  keepAliveEnabled    = ${config.keepAliveEnabled}`);
console.log(`  injectExtCacheTtl   = ${config.injectExtendedCacheTtl}`);
console.log(`  adminPathPrefix     = ${config.adminPathPrefix}`);

if (warnings.length) {
	console.log("\nwarnings:");
	for (const w of warnings) console.log(`  ! ${w}`);
}

const problems = [];
if (config.host !== "0.0.0.0")
	problems.push(
		`host is ${config.host}, expected 0.0.0.0 — CLAWBACK.md was NOT picked up`,
	);
if (config.tls !== true) problems.push(`tls is ${config.tls}, expected true`);
if (!config.adminToken)
	problems.push("adminToken missing — non-loopback bind would have thrown");

if (problems.length) {
	console.error("\nFAIL:");
	for (const p of problems) console.error(`  ✗ ${p}`);
	process.exit(1);
}
console.log(
	"\nOK: canonical CLAWBACK.md parsed and merged; validate() passed.",
);
