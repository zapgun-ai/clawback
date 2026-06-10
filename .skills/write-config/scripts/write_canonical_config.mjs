#!/usr/bin/env node
// Write the canonical CLAWBACK.md config: every option at its DEFAULT value,
// except the two a LAN-reachable bind needs set — host=0.0.0.0 and tls=true.
// adminToken is required for that bind but is left as a null placeholder for
// you to set; followed by the documentation body in
// .skills/write-config/assets/canonical_config_body.md.
//
// Why a script (not a hand-written file): the front matter is generated from
// the live DEFAULTS export in src/config.js, so it can never drift out of sync
// with the code as options are added or their defaults change. The adminToken
// is a secret that fronts live Anthropic credentials, so this script never
// mints one: it leaves a null placeholder by default, PRESERVES a real existing
// token (or an explicit CLAWBACK_CANONICAL_TOKEN), and NEVER prints a token's
// value — only whether one is present and its length.
//
// Usage:
//   node .skills/write-config/scripts/write_canonical_config.mjs [target ...]
// With no targets it writes BOTH the local ./CLAWBACK.md and the global
// ${XDG_CONFIG_HOME:-$HOME/.config}/clawback/CLAWBACK.md, sharing one token so
// the two files agree. Override the shared token with CLAWBACK_CANONICAL_TOKEN.
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, resolveGlobalConfigPath } from "../../../src/config.js";
import {
	parseFrontMatter,
	stringifyFrontMatter,
} from "../../../src/front_matter.js";

const CONFIG_NAME = "CLAWBACK.md";
const BODY_PATH = path.join(
	import.meta.dirname,
	"..",
	"assets",
	"canonical_config_body.md",
);

// The only forced deviations from DEFAULTS: host (operator wants a LAN bind)
// and tls (forced true because writing the default `false` would suppress the
// open-network TLS auto-enable and serve secrets in cleartext on the LAN).
// adminToken is resolved separately and defaults to a null placeholder.
const OVERRIDES = { host: "0.0.0.0", tls: true };

function defaultTargets(env) {
	const targets = [path.resolve(process.cwd(), CONFIG_NAME)];
	const globalPath = resolveGlobalConfigPath(env);
	if (globalPath) {
		targets.push(path.join(path.dirname(globalPath), CONFIG_NAME));
	}
	return targets;
}

// Read an existing target's REAL adminToken, or null if the file is absent,
// unparseable, or tokenless. A null / empty adminToken (e.g. the placeholder
// this script writes) counts as tokenless, so it is never preserved — it gets
// overwritten on the next run. Never throws.
function existingToken(file) {
	try {
		const { data } = parseFrontMatter(fs.readFileSync(file, "utf8"));
		const t = data?.adminToken;
		return typeof t === "string" && t.length > 0 ? t : null;
	} catch {
		return null;
	}
}

function resolveSharedToken(targets, env) {
	const fromEnv = env.CLAWBACK_CANONICAL_TOKEN;
	if (typeof fromEnv === "string" && fromEnv.length > 0) {
		return { token: fromEnv, origin: "env (CLAWBACK_CANONICAL_TOKEN)" };
	}
	for (const file of targets) {
		const t = existingToken(file);
		if (t) return { token: t, origin: `preserved from ${file}` };
	}
	return {
		token: null,
		origin: "placeholder (set a real token before a non-loopback bind)",
	};
}

function main() {
	const env = process.env;
	const targets =
		process.argv.length > 2
			? process.argv.slice(2).map((p) => path.resolve(p))
			: defaultTargets(env);

	const body = fs.readFileSync(BODY_PATH, "utf8");
	const { token, origin } = resolveSharedToken(targets, env);
	const config = { ...DEFAULTS, ...OVERRIDES, adminToken: token };
	const doc = stringifyFrontMatter(config, body);

	for (const file of targets) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, doc, { mode: 0o600 });
		fs.chmodSync(file, 0o600); // enforce even if the file pre-existed
		const mode = (fs.statSync(file).mode & 0o777).toString(8).padStart(3, "0");
		console.log(`wrote ${file}  (mode ${mode}, ${doc.length} bytes)`);
	}

	const keys = Object.keys(config).length;
	if (token === null) {
		console.log(
			`\n${keys} options written. host=${config.host} tls=${config.tls} ` +
				`adminToken: ${origin}.`,
		);
		console.log(
			"adminToken is a null placeholder — set a real one (edit the file, " +
				"--admin-token, or CLAWBACK_ADMIN_TOKEN) before binding non-loopback.",
		);
	} else {
		console.log(
			`\n${keys} options written. host=${config.host} tls=${config.tls} ` +
				`adminToken: present (${token.length} chars, ${origin}).`,
		);
		console.log("Value of adminToken intentionally not printed.");
	}
}

main();
