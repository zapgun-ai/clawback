import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AUTO_DISCOVERED_CONFIG_NAME,
	GLOBAL_CONFIG_SUBPATH,
	loadConfig,
	resolveGlobalConfigPath,
} from "../src/config.js";
import { stringifyFrontMatter } from "../src/front_matter.js";

let tmpDir;
let homeDir;
let xdgDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-config-"));
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-home-"));
	xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-xdg-"));
});

afterEach(() => {
	for (const d of [tmpDir, homeDir, xdgDir]) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function isolatedEnv(extra = {}) {
	return { HOME: homeDir, XDG_CONFIG_HOME: "", ...extra };
}

function writeGlobal(env, contents) {
	const p = resolveGlobalConfigPath(env);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, stringifyFrontMatter(contents));
	return p;
}

describe("canonical config filename (CLAWBACK.md)", () => {
	test("AUTO_DISCOVERED_CONFIG_NAME is the canonical uppercase CLAWBACK.md", () => {
		expect(AUTO_DISCOVERED_CONFIG_NAME).toBe("CLAWBACK.md");
	});

	test("GLOBAL_CONFIG_SUBPATH is CLAWBACK.md under the lowercase clawback dir", () => {
		expect(GLOBAL_CONFIG_SUBPATH).toBe(path.join("clawback", "CLAWBACK.md"));
		expect(path.basename(GLOBAL_CONFIG_SUBPATH)).toBe("CLAWBACK.md");
		expect(path.dirname(GLOBAL_CONFIG_SUBPATH)).toBe("clawback");
	});
});

describe("CLAWBACK.md local auto-discovery", () => {
	test("loads CLAWBACK.md from cwd when present and no --config given", () => {
		const file = path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(
			file,
			stringifyFrontMatter({ port: 9999, logLevel: "warn" }),
		);
		const { config, sources } = loadConfig({
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.port).toBe(9999);
		expect(config.logLevel).toBe("warn");
		expect(sources).toEqual([{ tier: "local-auto", path: file }]);
	});

	test("absent CLAWBACK.md is silent (no error, no sources)", () => {
		const { config, sources } = loadConfig({
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.port).toBe(8080);
		expect(sources).toEqual([]);
	});

	test("explicit --config path takes precedence over cwd auto-discovery", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ port: 1111 }),
		);
		const explicit = path.join(tmpDir, "alt.md");
		fs.writeFileSync(explicit, stringifyFrontMatter({ port: 2222 }));
		const { config, sources } = loadConfig({
			configPath: explicit,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.port).toBe(2222);
		expect(sources).toEqual([
			{ tier: "local-explicit", path: path.resolve(explicit) },
		]);
	});

	test("CLI overrides win over auto-discovered file", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ port: 3333, logLevel: "debug" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			cliOverrides: { port: 4444 },
			env: isolatedEnv(),
		});
		expect(config.port).toBe(4444);
		expect(config.logLevel).toBe("debug");
	});

	test("malformed CLAWBACK.md raises on auto-discovery (loud failure)", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			"{ not valid json",
		);
		expect(() => loadConfig({ cwd: tmpDir, env: isolatedEnv() })).toThrow();
	});

	test("explicit --config to missing file raises (unchanged behavior)", () => {
		expect(() =>
			loadConfig({
				configPath: path.join(tmpDir, "missing.md"),
				env: isolatedEnv(),
			}),
		).toThrow();
	});

	test("passthrough flag still cascades when set in CLAWBACK.md", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ passthrough: true }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);
		expect(config.keepAliveEnabled).toBe(false);
	});
});

describe("global config (~/.config/clawback/CLAWBACK.md)", () => {
	test("resolveGlobalConfigPath honors XDG_CONFIG_HOME first", () => {
		const env = { HOME: homeDir, XDG_CONFIG_HOME: xdgDir };
		expect(resolveGlobalConfigPath(env)).toBe(
			path.join(xdgDir, GLOBAL_CONFIG_SUBPATH),
		);
	});

	test("resolveGlobalConfigPath falls back to $HOME/.config", () => {
		const env = { HOME: homeDir, XDG_CONFIG_HOME: "" };
		expect(resolveGlobalConfigPath(env)).toBe(
			path.join(homeDir, ".config", GLOBAL_CONFIG_SUBPATH),
		);
	});

	test("global config is loaded under local config", () => {
		const env = isolatedEnv();
		const globalPath = writeGlobal(env, {
			port: 5555,
			logLevel: "warn",
			keepAliveModeExtended: true,
		});
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ port: 7777 }),
		);
		const { config, sources } = loadConfig({ cwd: tmpDir, env });
		expect(config.port).toBe(7777);
		expect(config.logLevel).toBe("warn");
		expect(config.keepAliveModeExtended).toBe(true);
		expect(sources.map((s) => s.tier)).toEqual(["global", "local-auto"]);
		expect(sources[0].path).toBe(globalPath);
	});

	test("CLI overrides win over local which wins over global which wins over defaults", () => {
		const env = isolatedEnv();
		// adminToken is set at the global tier so the non-loopback host
		// values below pass the start-time safety check (which refuses to
		// bind beyond loopback without an admin token, see C2 in the
		// security audit). The precedence semantics being verified are
		// unchanged.
		writeGlobal(env, {
			port: 1111,
			logLevel: "debug",
			host: "0.0.0.0",
			adminToken: "test-token",
		});
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ port: 2222, host: "10.0.0.1" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env,
			cliOverrides: { port: 3333 },
		});
		expect(config.port).toBe(3333);
		expect(config.host).toBe("10.0.0.1");
		expect(config.logLevel).toBe("debug");
	});

	test("explicit --config still loads global beneath it", () => {
		const env = isolatedEnv();
		writeGlobal(env, { logLevel: "debug" });
		const explicit = path.join(tmpDir, "alt.md");
		fs.writeFileSync(explicit, stringifyFrontMatter({ port: 4040 }));
		const { config, sources } = loadConfig({
			configPath: explicit,
			env,
		});
		expect(config.port).toBe(4040);
		expect(config.logLevel).toBe("debug");
		expect(sources.map((s) => s.tier)).toEqual(["global", "local-explicit"]);
	});

	test("missing global config is silent", () => {
		const env = isolatedEnv();
		const { config, sources } = loadConfig({ cwd: tmpDir, env });
		expect(config.port).toBe(8080);
		expect(sources).toEqual([]);
	});

	test("malformed global config raises (loud failure)", () => {
		const env = isolatedEnv();
		const p = resolveGlobalConfigPath(env);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "not json {{");
		expect(() => loadConfig({ cwd: tmpDir, env })).toThrow();
	});
});

describe("adminPathPrefix configuration", () => {
	test("default is _proxy", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.adminPathPrefix).toBe("_proxy");
	});

	test("settable via CLI override", () => {
		const { config } = loadConfig({
			cliOverrides: { adminPathPrefix: "_admin" },
			env: isolatedEnv(),
		});
		expect(config.adminPathPrefix).toBe("_admin");
	});

	test("settable via local CLAWBACK.md", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ adminPathPrefix: "_ctrl" }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.adminPathPrefix).toBe("_ctrl");
	});

	test("settable via global CLAWBACK.md", () => {
		const env = isolatedEnv();
		writeGlobal(env, { adminPathPrefix: "_ops" });
		const { config } = loadConfig({ env });
		expect(config.adminPathPrefix).toBe("_ops");
	});

	test("CLI > local > global precedence holds for adminPathPrefix", () => {
		const env = isolatedEnv();
		writeGlobal(env, { adminPathPrefix: "_global" });
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ adminPathPrefix: "_local" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env,
			cliOverrides: { adminPathPrefix: "_cli" },
		});
		expect(config.adminPathPrefix).toBe("_cli");
	});

	test("rejects empty prefix", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { adminPathPrefix: "" },
				env: isolatedEnv(),
			}),
		).toThrow(/adminPathPrefix/);
	});

	test("rejects prefix containing slash", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { adminPathPrefix: "_proxy/x" },
				env: isolatedEnv(),
			}),
		).toThrow(/adminPathPrefix/);
	});

	test("rejects prefix v1 (would shadow upstream path)", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { adminPathPrefix: "v1" },
				env: isolatedEnv(),
			}),
		).toThrow(/adminPathPrefix/);
	});
});

describe("reportDir configuration", () => {
	test("default is runs", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.reportDir).toBe("runs");
	});

	test("settable via CLI override", () => {
		const { config } = loadConfig({
			cliOverrides: { reportDir: "bench-out" },
			env: isolatedEnv(),
		});
		expect(config.reportDir).toBe("bench-out");
	});

	test("CLI > local > global precedence holds for reportDir", () => {
		const env = isolatedEnv();
		writeGlobal(env, { reportDir: "global-runs" });
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ reportDir: "local-runs" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env,
			cliOverrides: { reportDir: "cli-runs" },
		});
		expect(config.reportDir).toBe("cli-runs");
	});

	test("rejects empty reportDir", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { reportDir: "  " },
				env: isolatedEnv(),
			}),
		).toThrow(/reportDir/);
	});
});

describe("turnLogFile configuration", () => {
	test("defaults on at data/turns.ndjson", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.turnLogFile).toBe("data/turns.ndjson");
	});

	test("CLI override sets a custom path", () => {
		const { config } = loadConfig({
			cliOverrides: { turnLogFile: "/tmp/custom-turns.ndjson" },
			env: isolatedEnv(),
		});
		expect(config.turnLogFile).toBe("/tmp/custom-turns.ndjson");
	});

	test("CLI override of null disables (mirrors --no-turn-log)", () => {
		const { config } = loadConfig({
			cliOverrides: { turnLogFile: null },
			env: isolatedEnv(),
		});
		expect(config.turnLogFile).toBeNull();
	});

	test("local CLAWBACK.md can disable by setting null", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ turnLogFile: null }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.turnLogFile).toBeNull();
	});

	test("local CLAWBACK.md can relocate the path", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ turnLogFile: "logs/clawback-turns.ndjson" }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.turnLogFile).toBe("logs/clawback-turns.ndjson");
	});
});

describe("test-harness knob (captureBodyPath)", () => {
	test("defaults off (null)", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.captureBodyPath).toBeNull();
	});

	test("CLI override sets capture path", () => {
		const { config } = loadConfig({
			cliOverrides: {
				captureBodyPath: "/tmp/fixture.json",
			},
			env: isolatedEnv(),
		});
		expect(config.captureBodyPath).toBe("/tmp/fixture.json");
	});

	test("local CLAWBACK.md can set it", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ captureBodyPath: "cap.json" }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.captureBodyPath).toBe("cap.json");
	});
});

describe("sessionLogDir configuration", () => {
	test("defaults on at logs/", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.sessionLogDir).toBe("logs");
	});

	test("CLI override sets a custom path", () => {
		const { config } = loadConfig({
			cliOverrides: { sessionLogDir: "/tmp/custom-session-logs" },
			env: isolatedEnv(),
		});
		expect(config.sessionLogDir).toBe("/tmp/custom-session-logs");
	});

	test("CLI override of null disables (mirrors --no-session-log-dir)", () => {
		const { config } = loadConfig({
			cliOverrides: { sessionLogDir: null },
			env: isolatedEnv(),
		});
		expect(config.sessionLogDir).toBeNull();
	});

	test("local CLAWBACK.md can disable by setting null", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ sessionLogDir: null }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.sessionLogDir).toBeNull();
	});

	test("global CLAWBACK.md can relocate the directory", () => {
		const env = isolatedEnv();
		writeGlobal(env, { sessionLogDir: "/var/log/clawback-sessions" });
		const { config } = loadConfig({ env });
		expect(config.sessionLogDir).toBe("/var/log/clawback-sessions");
	});

	test("CLI > local > global precedence holds", () => {
		const env = isolatedEnv();
		writeGlobal(env, { sessionLogDir: "g" });
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ sessionLogDir: "l" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env,
			cliOverrides: { sessionLogDir: "c" },
		});
		expect(config.sessionLogDir).toBe("c");
	});
});

describe("stripEphemeralFromSystem configuration", () => {
	test("defaults on (PLAN §9 fragmentation fix)", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.stripEphemeralFromSystem).toBe(true);
	});

	test("CLI override can disable", () => {
		const { config } = loadConfig({
			cliOverrides: { stripEphemeralFromSystem: false },
			env: isolatedEnv(),
		});
		expect(config.stripEphemeralFromSystem).toBe(false);
	});

	test("local CLAWBACK.md can disable", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ stripEphemeralFromSystem: false }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.stripEphemeralFromSystem).toBe(false);
	});
});

describe("stripExtendedCacheTtl configuration", () => {
	test("defaults off (1h pays back across idle gaps; don't downgrade by default)", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.stripExtendedCacheTtl).toBe(false);
	});

	test("CLI override can enable", () => {
		const { config } = loadConfig({
			cliOverrides: { stripExtendedCacheTtl: true },
			env: isolatedEnv(),
		});
		expect(config.stripExtendedCacheTtl).toBe(true);
	});

	test("local CLAWBACK.md can enable", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ stripExtendedCacheTtl: true }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.stripExtendedCacheTtl).toBe(true);
	});

	test("passthrough forces it off even when the operator enabled it", () => {
		const { config } = loadConfig({
			cliOverrides: { stripExtendedCacheTtl: true, passthrough: true },
			env: isolatedEnv(),
		});
		expect(config.passthrough).toBe(true);
		expect(config.stripExtendedCacheTtl).toBe(false);
	});

	test("baseline snapshot records the operator's intent for passthrough restore", () => {
		const { config } = loadConfig({
			cliOverrides: { stripExtendedCacheTtl: true },
			env: isolatedEnv(),
		});
		expect(config._baselineSnapshot.stripExtendedCacheTtl).toBe(true);
	});
});

describe("keepAliveEnabled configuration", () => {
	test("defaults on", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.keepAliveEnabled).toBe(true);
	});

	test("CLI override can disable (granular --keep-alive off)", () => {
		const { config } = loadConfig({
			cliOverrides: { keepAliveEnabled: false },
			env: isolatedEnv(),
		});
		expect(config.keepAliveEnabled).toBe(false);
		// strip + injection still on — that's the whole point of the granular knob.
		expect(config.stripEphemeralFromSystem).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(true);
	});

	test("local CLAWBACK.md can disable", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ keepAliveEnabled: false }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.keepAliveEnabled).toBe(false);
	});
});

describe("accountGlobalQuota configuration", () => {
	test("defaults on", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.accountGlobalQuota).toBe(true);
	});

	test("CLI override can disable (--account-global-quota off, the multi-account escape hatch)", () => {
		const { config } = loadConfig({
			cliOverrides: { accountGlobalQuota: false },
			env: isolatedEnv(),
		});
		expect(config.accountGlobalQuota).toBe(false);
	});

	test("local CLAWBACK.md can disable", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ accountGlobalQuota: false }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.accountGlobalQuota).toBe(false);
	});
});

describe("mobile bundle (soft expansion of gzipOutgoing + forceNonStreaming)", () => {
	test("mobile=false leaves both sub-knobs at default off", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.mobile).toBe(false);
		expect(config.gzipOutgoing).toBe(false);
		expect(config.forceNonStreaming).toBe(false);
	});

	test("mobile=true (CLI) expands both sub-knobs to on", () => {
		const { config } = loadConfig({
			cliOverrides: { mobile: true },
			env: isolatedEnv(),
		});
		expect(config.mobile).toBe(true);
		expect(config.gzipOutgoing).toBe(true);
		expect(config.forceNonStreaming).toBe(true);
	});

	test("mobile=true (file config) expands both sub-knobs", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ mobile: true }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.mobile).toBe(true);
		expect(config.gzipOutgoing).toBe(true);
		expect(config.forceNonStreaming).toBe(true);
	});

	test("CLI sub-knob OFF wins over mobile bundle ON (soft bundle)", () => {
		const { config } = loadConfig({
			cliOverrides: { mobile: true, gzipOutgoing: false },
			env: isolatedEnv(),
		});
		expect(config.mobile).toBe(true);
		expect(config.gzipOutgoing).toBe(false);
		expect(config.forceNonStreaming).toBe(true);
	});

	test("baseline snapshot captures the post-mobile expansion state", () => {
		const { config } = loadConfig({
			cliOverrides: { mobile: true },
			env: isolatedEnv(),
		});
		expect(config._baselineSnapshot.gzipOutgoing).toBe(true);
		expect(config._baselineSnapshot.forceNonStreaming).toBe(true);
	});
});

describe("upstreamFromEnv (--upstream-from-env) capture", () => {
	test("default off — env is ignored", () => {
		const env = isolatedEnv({
			ANTHROPIC_BASE_URL: "https://my-corp-proxy.example.com",
		});
		const { config, sources } = loadConfig({ env });
		expect(config.upstream).toBe("https://api.anthropic.com");
		expect(sources.find((s) => s.tier === "env")).toBeUndefined();
	});

	test("on + env set → env wins over default", () => {
		const env = isolatedEnv({
			ANTHROPIC_BASE_URL: "https://my-corp-proxy.example.com",
		});
		const { config, sources } = loadConfig({
			cliOverrides: { upstreamFromEnv: true },
			env,
		});
		expect(config.upstream).toBe("https://my-corp-proxy.example.com");
		expect(sources.find((s) => s.tier === "env")).toEqual({
			tier: "env",
			path: "ANTHROPIC_BASE_URL",
		});
	});

	test("on + env set + CLI --upstream → CLI wins", () => {
		const env = isolatedEnv({
			ANTHROPIC_BASE_URL: "https://env-pointed-here.example.com",
		});
		const { config } = loadConfig({
			cliOverrides: {
				upstreamFromEnv: true,
				upstream: "https://cli-wins.example.com",
			},
			env,
		});
		expect(config.upstream).toBe("https://cli-wins.example.com");
	});

	test("on + env unset → default unchanged", () => {
		const env = isolatedEnv();
		const { config } = loadConfig({
			cliOverrides: { upstreamFromEnv: true },
			env,
		});
		expect(config.upstream).toBe("https://api.anthropic.com");
	});

	test("on + invalid env URL → throws via existing upstream validate", () => {
		const env = isolatedEnv({ ANTHROPIC_BASE_URL: "not a url at all" });
		expect(() =>
			loadConfig({ cliOverrides: { upstreamFromEnv: true }, env }),
		).toThrow(/invalid upstream URL/);
	});
});

describe("statuslineProgressBarLength configuration", () => {
	test("defaults to 8 cells", () => {
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.statuslineProgressBarLength).toBe(8);
	});

	test("CLI override sets a custom length", () => {
		const { config } = loadConfig({
			cliOverrides: { statuslineProgressBarLength: 16 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.statuslineProgressBarLength).toBe(16);
	});

	test("local CLAWBACK.md can set the length", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ statuslineProgressBarLength: 12 }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.statuslineProgressBarLength).toBe(12);
	});

	test("non-positive or non-integer values throw via validate()", () => {
		for (const bad of [0, -1, 4.5, "8", null]) {
			expect(() =>
				loadConfig({
					cliOverrides: { statuslineProgressBarLength: bad },
					cwd: tmpDir,
					env: isolatedEnv(),
				}),
			).toThrow(/statuslineProgressBarLength/);
		}
	});
});

describe("statusline color thresholds", () => {
	test("defaults match the documented bands", () => {
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.statuslinePctThresholdLow).toBe(50);
		expect(config.statuslinePctThresholdHigh).toBe(80);
		expect(config.statuslineTtftThresholdLowMs).toBe(3000);
		expect(config.statuslineTtftThresholdHighMs).toBe(5000);
		expect(config.statuslineTpsThresholdLow).toBe(15);
		expect(config.statuslineTpsThresholdHigh).toBe(40);
		expect(config.statuslineTpsCalibration).toBe("relative");
		// ttft defaults to ABSOLUTE: it's clawback's cache-warmth signal, and
		// relative calibration masks a consistently-cold cache (flipped
		// relative→absolute 2026-06-02). tps stays relative (decode rate is a
		// model/hardware constant, not the product signal).
		expect(config.statuslineTtftCalibration).toBe("absolute");
	});

	test("CLI override propagates each knob", () => {
		const { config } = loadConfig({
			cliOverrides: {
				statuslinePctThresholdLow: 60,
				statuslinePctThresholdHigh: 90,
				statuslineTtftThresholdLowMs: 300,
				statuslineTtftThresholdHighMs: 1500,
				statuslineTpsThresholdLow: 100,
				statuslineTpsThresholdHigh: 250,
			},
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.statuslinePctThresholdLow).toBe(60);
		expect(config.statuslinePctThresholdHigh).toBe(90);
		expect(config.statuslineTtftThresholdLowMs).toBe(300);
		expect(config.statuslineTtftThresholdHighMs).toBe(1500);
		expect(config.statuslineTpsThresholdLow).toBe(100);
		expect(config.statuslineTpsThresholdHigh).toBe(250);
	});

	test("pct out-of-range or non-numeric values throw", () => {
		for (const bad of [
			-1,
			101,
			"50",
			null,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(() =>
				loadConfig({
					cliOverrides: { statuslinePctThresholdLow: bad },
					cwd: tmpDir,
					env: isolatedEnv(),
				}),
			).toThrow(/statuslinePctThresholdLow/);
		}
	});

	test("low > high is rejected for each pair", () => {
		expect(() =>
			loadConfig({
				cliOverrides: {
					statuslinePctThresholdLow: 80,
					statuslinePctThresholdHigh: 50,
				},
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/statuslinePctThresholdLow.*<=.*statuslinePctThresholdHigh/);
		expect(() =>
			loadConfig({
				cliOverrides: {
					statuslineTtftThresholdLowMs: 2000,
					statuslineTtftThresholdHighMs: 500,
				},
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(
			/statuslineTtftThresholdLowMs.*<=.*statuslineTtftThresholdHighMs/,
		);
		expect(() =>
			loadConfig({
				cliOverrides: {
					statuslineTpsThresholdLow: 100,
					statuslineTpsThresholdHigh: 30,
				},
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/statuslineTpsThresholdLow.*<=.*statuslineTpsThresholdHigh/);
	});

	test("low === high is allowed (degenerate binary good/bad split)", () => {
		const { config } = loadConfig({
			cliOverrides: {
				statuslinePctThresholdLow: 70,
				statuslinePctThresholdHigh: 70,
				statuslineTtftThresholdLowMs: 1000,
				statuslineTtftThresholdHighMs: 1000,
				statuslineTpsThresholdLow: 50,
				statuslineTpsThresholdHigh: 50,
			},
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.statuslinePctThresholdLow).toBe(70);
		expect(config.statuslineTtftThresholdHighMs).toBe(1000);
		expect(config.statuslineTpsThresholdHigh).toBe(50);
	});

	test("local CLAWBACK.md can set thresholds", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({
				statuslinePctThresholdLow: 60,
				statuslineTpsThresholdHigh: 200,
			}),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.statuslinePctThresholdLow).toBe(60);
		expect(config.statuslineTpsThresholdHigh).toBe(200);
		// Defaults preserved for fields not in the file.
		expect(config.statuslinePctThresholdHigh).toBe(80);
		expect(config.statuslineTpsThresholdLow).toBe(15);
	});

	test("statuslineTpsCalibration accepts 'relative' or 'absolute'", () => {
		const { config: relative } = loadConfig({
			cliOverrides: { statuslineTpsCalibration: "relative" },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(relative.statuslineTpsCalibration).toBe("relative");
		const { config: absolute } = loadConfig({
			cliOverrides: { statuslineTpsCalibration: "absolute" },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(absolute.statuslineTpsCalibration).toBe("absolute");
	});

	test("statuslineTpsCalibration rejects bogus values", () => {
		for (const bad of ["RELATIVE", "auto", "", null, 1, true]) {
			expect(() =>
				loadConfig({
					cliOverrides: { statuslineTpsCalibration: bad },
					cwd: tmpDir,
					env: isolatedEnv(),
				}),
			).toThrow(/statuslineTpsCalibration/);
		}
	});

	test("statuslineTtftCalibration accepts 'relative' or 'absolute'", () => {
		const { config: relative } = loadConfig({
			cliOverrides: { statuslineTtftCalibration: "relative" },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(relative.statuslineTtftCalibration).toBe("relative");
		const { config: absolute } = loadConfig({
			cliOverrides: { statuslineTtftCalibration: "absolute" },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(absolute.statuslineTtftCalibration).toBe("absolute");
	});

	test("statuslineTtftCalibration rejects bogus values", () => {
		for (const bad of ["RELATIVE", "auto", "", null, 1, true]) {
			expect(() =>
				loadConfig({
					cliOverrides: { statuslineTtftCalibration: bad },
					cwd: tmpDir,
					env: isolatedEnv(),
				}),
			).toThrow(/statuslineTtftCalibration/);
		}
	});
});

describe("session GC defaults (sessionMaxIdleMs, deadSessionMaxIdleMs, gcSweepIntervalMs)", () => {
	test("defaults are 12h idle / 6h dead / 5min sweep", () => {
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.sessionMaxIdleMs).toBe(12 * 60 * 60 * 1000);
		expect(config.deadSessionMaxIdleMs).toBe(6 * 60 * 60 * 1000);
		expect(config.gcSweepIntervalMs).toBe(5 * 60 * 1000);
	});

	test("CLI override overrides global override overrides default", () => {
		writeGlobal(isolatedEnv(), {
			sessionMaxIdleMs: 6 * 3_600_000,
			gcSweepIntervalMs: 60_000,
		});
		const { config } = loadConfig({
			cliOverrides: { sessionMaxIdleMs: 3 * 3_600_000 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.sessionMaxIdleMs).toBe(3 * 3_600_000);
		// gcSweepIntervalMs not on CLI here, so global wins.
		expect(config.gcSweepIntervalMs).toBe(60_000);
	});

	test("negative sessionMaxIdleMs throws via validate()", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { sessionMaxIdleMs: -1 },
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/sessionMaxIdleMs/);
	});

	test("gcSweepIntervalMs=0 is allowed (disables periodic sweep)", () => {
		const { config } = loadConfig({
			cliOverrides: { gcSweepIntervalMs: 0 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.gcSweepIntervalMs).toBe(0);
	});

	test("deadSessionMaxIdleMs CLI override beats global beats default", () => {
		writeGlobal(isolatedEnv(), { deadSessionMaxIdleMs: 4 * 3_600_000 });
		const { config } = loadConfig({
			cliOverrides: { deadSessionMaxIdleMs: 2 * 3_600_000 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.deadSessionMaxIdleMs).toBe(2 * 3_600_000);
	});

	test("negative deadSessionMaxIdleMs throws via validate()", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { deadSessionMaxIdleMs: -1 },
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/deadSessionMaxIdleMs/);
	});

	test("deadSessionMaxIdleMs=0 is allowed (disables the fast-path)", () => {
		const { config } = loadConfig({
			cliOverrides: { deadSessionMaxIdleMs: 0 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.deadSessionMaxIdleMs).toBe(0);
	});
});

describe("passthrough / --baseline forces the full intervention bundle off", () => {
	test("passthrough disables injection, strip, and keep-alives together", () => {
		const { config } = loadConfig({
			cliOverrides: { passthrough: true },
			env: isolatedEnv(),
		});
		expect(config.passthrough).toBe(true);
		expect(config.injectExtendedCacheTtl).toBe(false);
		expect(config.rewriteNestedCacheControl).toBe(false);
		expect(config.stripEphemeralFromSystem).toBe(false);
		expect(config.keepAliveEnabled).toBe(false);
	});

	test("rewriteNestedCacheControl defaults to true and lives in the baseline snapshot", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.rewriteNestedCacheControl).toBe(true);
		expect(config._baselineSnapshot.rewriteNestedCacheControl).toBe(true);
	});

	test("CLI --rewrite-nested-cache-control off survives the merge", () => {
		const { config } = loadConfig({
			cliOverrides: { rewriteNestedCacheControl: false },
			env: isolatedEnv(),
		});
		expect(config.rewriteNestedCacheControl).toBe(false);
		// Should not have been forced off by passthrough (which is unset).
		expect(config.injectExtendedCacheTtl).toBe(true);
	});

	test("passthrough wins even when other knobs are explicitly set on", () => {
		// Operator's CLAWBACK.md says everything should be on.
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({
				injectExtendedCacheTtl: true,
				stripEphemeralFromSystem: true,
				keepAliveEnabled: true,
			}),
		);
		// CLI then turns on passthrough — bundle override beats explicit local opts.
		const { config } = loadConfig({
			cliOverrides: { passthrough: true },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.injectExtendedCacheTtl).toBe(false);
		expect(config.stripEphemeralFromSystem).toBe(false);
		expect(config.keepAliveEnabled).toBe(false);
	});

	test("passthrough also forces autoContinue off and snapshots it", () => {
		// Operator's CLAWBACK.md turns autoContinue on alongside the
		// rest of the cache stack.
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ autoContinue: true }),
		);
		const { config } = loadConfig({
			cliOverrides: { passthrough: true },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		// Park autoContinue for the baseline window so an auto-resume
		// fire doesn't pollute the measurement.
		expect(config.autoContinue).toBe(false);
		// Snapshot preserves operator intent so exiting passthrough at
		// runtime restores it (see applyPassthrough in src/admin.js).
		expect(config._baselineSnapshot.autoContinue).toBe(true);
	});

	test("snapshot autoContinue defaults to false when operator never set it", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.autoContinue).toBe(false);
		expect(config._baselineSnapshot.autoContinue).toBe(false);
	});
});

describe("adminToken layering", () => {
	test("default is null (no auth required)", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.adminToken).toBeNull();
	});

	test("CLAWBACK_ADMIN_TOKEN env var is captured", () => {
		const { config, sources } = loadConfig({
			env: isolatedEnv({ CLAWBACK_ADMIN_TOKEN: "from-env" }),
		});
		expect(config.adminToken).toBe("from-env");
		expect(sources).toEqual([{ tier: "env", path: "CLAWBACK_ADMIN_TOKEN" }]);
	});

	test("CLI --admin-token wins over env", () => {
		const { config } = loadConfig({
			cliOverrides: { adminToken: "from-cli" },
			env: isolatedEnv({ CLAWBACK_ADMIN_TOKEN: "from-env" }),
		});
		expect(config.adminToken).toBe("from-cli");
	});

	test("env wins over file (env slots between layered config and CLI)", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ adminToken: "from-file" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env: isolatedEnv({ CLAWBACK_ADMIN_TOKEN: "from-env" }),
		});
		expect(config.adminToken).toBe("from-env");
	});

	test("empty env var does not overwrite", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ adminToken: "from-file" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env: isolatedEnv({ CLAWBACK_ADMIN_TOKEN: "" }),
		});
		expect(config.adminToken).toBe("from-file");
	});
});

// Audit C2: clawback persists captured OAuth bearers and exposes the
// PTY-input write endpoint. A LAN-reachable bind without auth would let
// any peer drive the operator's claude. validate() refuses the dangerous
// combination.
describe("host bind safety (LAN bind requires adminToken)", () => {
	test("default host is loopback", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.host).toBe("127.0.0.1");
	});

	test("0.0.0.0 without adminToken is rejected", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { host: "0.0.0.0" },
				env: isolatedEnv(),
			}),
		).toThrow(/binds beyond loopback but adminToken is unset/);
	});

	test("non-loopback IP without adminToken is rejected", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { host: "10.0.0.5" },
				env: isolatedEnv(),
			}),
		).toThrow(/binds beyond loopback but adminToken is unset/);
	});

	test("0.0.0.0 with adminToken is allowed", () => {
		const { config } = loadConfig({
			cliOverrides: { host: "0.0.0.0", adminToken: "t" },
			env: isolatedEnv(),
		});
		expect(config.host).toBe("0.0.0.0");
	});

	test("127.x.x.x loopback range needs no token", () => {
		const { config } = loadConfig({
			cliOverrides: { host: "127.0.0.2" },
			env: isolatedEnv(),
		});
		expect(config.host).toBe("127.0.0.2");
	});

	test("::1 and localhost are treated as loopback", () => {
		const a = loadConfig({
			cliOverrides: { host: "::1" },
			env: isolatedEnv(),
		});
		const b = loadConfig({
			cliOverrides: { host: "localhost" },
			env: isolatedEnv(),
		});
		expect(a.config.host).toBe("::1");
		expect(b.config.host).toBe("localhost");
	});
});

// Open-network bind defaults TLS on (the admin token + captured OAuth
// creds would otherwise cross the wire in cleartext). Soft default:
// an explicit `--tls off` / `"tls": false` still escapes. Keyed purely
// on the bind being non-loopback, so the loopback default is untouched.
describe("open-network bind defaults TLS on", () => {
	test("non-loopback host auto-enables tls and marks _tlsAutoEnabled", () => {
		const { config } = loadConfig({
			cliOverrides: { host: "0.0.0.0", adminToken: "t" },
			env: isolatedEnv(),
		});
		expect(config.tls).toBe(true);
		expect(config._tlsAutoEnabled).toBe(true);
		// Default cert paths get resolved by the existing TLS-path block.
		expect(typeof config.tlsCertFile).toBe("string");
		expect(typeof config.tlsKeyFile).toBe("string");
	});

	test("loopback host stays HTTP (no auto-enable)", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.host).toBe("127.0.0.1");
		expect(config.tls).toBe(false);
		expect(config._tlsAutoEnabled).toBeUndefined();
	});

	test("explicit --tls off escapes on a wide bind (upstream-terminated TLS)", () => {
		const { config } = loadConfig({
			cliOverrides: { host: "0.0.0.0", adminToken: "t", tls: false },
			env: isolatedEnv(),
		});
		expect(config.tls).toBe(false);
		// Explicit choice → not an auto-enable.
		expect(config._tlsAutoEnabled).toBeUndefined();
	});

	test('explicit "tls": false in a config file also escapes', () => {
		const env = isolatedEnv();
		writeGlobal(env, { host: "0.0.0.0", adminToken: "t", tls: false });
		const { config } = loadConfig({ cwd: tmpDir, env });
		expect(config.tls).toBe(false);
		expect(config._tlsAutoEnabled).toBeUndefined();
	});

	test("explicit tls:true on a wide bind is honored (not treated as auto)", () => {
		const { config } = loadConfig({
			cliOverrides: { host: "0.0.0.0", adminToken: "t", tls: true },
			env: isolatedEnv(),
		});
		expect(config.tls).toBe(true);
		// Operator asked for it explicitly, so the auto marker stays off —
		// shapes the missing-cert error wording in provisionTlsCert.
		expect(config._tlsAutoEnabled).toBeUndefined();
	});

	test("selfSign defaults to false", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.selfSign).toBe(false);
	});
});

// Audit M2: a CLAWBACK.md containing adminToken at world-readable
// perms leaks the shared secret to any local user. loadConfig surfaces
// this as a `warnings` entry so start() can log it loudly.
describe("warns when adminToken lives in a world-readable config", () => {
	test("0644 local config with adminToken emits a warning", () => {
		const file = path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(file, stringifyFrontMatter({ adminToken: "leaky" }));
		fs.chmodSync(file, 0o644);
		const { warnings } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		const w = (warnings ?? []).find((s) => s.includes(file));
		expect(w).toBeDefined();
		expect(w).toMatch(/contains adminToken but is mode 644/);
	});

	test("0600 local config with adminToken emits no warning", () => {
		const file = path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(file, stringifyFrontMatter({ adminToken: "tight" }));
		fs.chmodSync(file, 0o600);
		const { warnings } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect((warnings ?? []).filter((s) => s.includes(file))).toEqual([]);
	});

	test("0644 local config without adminToken emits no warning", () => {
		const file = path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(file, stringifyFrontMatter({ port: 9999 }));
		fs.chmodSync(file, 0o644);
		const { warnings } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(warnings ?? []).toEqual([]);
	});
});

// `remoteUrl` is the persistent counterpart to `clawback claude --remote`.
// CLI flag still wins per-invocation (asserted by clawback_claude_attach
// + the in-line tests below where applicable); these tests cover the
// layering + validation surface.
describe("remoteUrl configuration", () => {
	test("default is null (no persistent remote)", () => {
		const { config } = loadConfig({ env: isolatedEnv() });
		expect(config.remoteUrl).toBeNull();
	});

	test("local CLAWBACK.md sets remoteUrl through the normal layering", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ remoteUrl: "https://clawback.example.com:8888" }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.remoteUrl).toBe("https://clawback.example.com:8888");
	});

	test("global config sets remoteUrl when no local CLAWBACK.md present", () => {
		const env = isolatedEnv();
		writeGlobal(env, { remoteUrl: "http://dev.box:8080" });
		const { config } = loadConfig({ cwd: tmpDir, env });
		expect(config.remoteUrl).toBe("http://dev.box:8080");
	});

	test("local CLAWBACK.md overrides global per the usual layering", () => {
		const env = isolatedEnv();
		writeGlobal(env, { remoteUrl: "http://global.example:8080" });
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ remoteUrl: "http://local.example:8080" }),
		);
		const { config } = loadConfig({ cwd: tmpDir, env });
		expect(config.remoteUrl).toBe("http://local.example:8080");
	});

	test("CLI override wins over file layers", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ remoteUrl: "http://from-file:8080" }),
		);
		const { config } = loadConfig({
			cwd: tmpDir,
			env: isolatedEnv(),
			cliOverrides: { remoteUrl: "http://from-cli:8080" },
		});
		expect(config.remoteUrl).toBe("http://from-cli:8080");
	});

	test("malformed remoteUrl is rejected with a clear message", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ remoteUrl: "not-a-url" }),
		);
		expect(() => loadConfig({ cwd: tmpDir, env: isolatedEnv() })).toThrow(
			/invalid remoteUrl/,
		);
	});

	test("non-http(s) scheme is rejected", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ remoteUrl: "ftp://example.com" }),
		);
		expect(() => loadConfig({ cwd: tmpDir, env: isolatedEnv() })).toThrow(
			/remoteUrl must be http:\/\/ or https:\/\//,
		);
	});

	test("empty-string remoteUrl is rejected (null is the only off state)", () => {
		fs.writeFileSync(
			path.join(tmpDir, AUTO_DISCOVERED_CONFIG_NAME),
			stringifyFrontMatter({ remoteUrl: "" }),
		);
		expect(() => loadConfig({ cwd: tmpDir, env: isolatedEnv() })).toThrow(
			/remoteUrl must be a non-empty string or null/,
		);
	});
});

describe("keepAliveMinPrefixBytes (Option A gate)", () => {
	test("defaults to 1024 bytes", () => {
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.keepAliveMinPrefixBytes).toBe(1024);
	});

	test("CLI override beats default", () => {
		const { config } = loadConfig({
			cliOverrides: { keepAliveMinPrefixBytes: 4096 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.keepAliveMinPrefixBytes).toBe(4096);
	});

	test("0 is allowed (disables the gate)", () => {
		const { config } = loadConfig({
			cliOverrides: { keepAliveMinPrefixBytes: 0 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.keepAliveMinPrefixBytes).toBe(0);
	});

	test("negative value throws via validate()", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { keepAliveMinPrefixBytes: -1 },
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/keepAliveMinPrefixBytes/);
	});

	test("passthrough leaves the gate value intact (keep-alive is off anyway)", () => {
		// passthrough forces keepAliveEnabled=false, so the gate never runs;
		// the value need not be cleared. Guard against an accidental hard-clear.
		const { config } = loadConfig({
			cliOverrides: { passthrough: true },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.keepAliveEnabled).toBe(false);
		expect(config.keepAliveMinPrefixBytes).toBe(1024);
	});
});

describe("keepAliveColdPingMax (Option A++ cold-ping cancellation)", () => {
	test("defaults to 2", () => {
		const { config } = loadConfig({ cwd: tmpDir, env: isolatedEnv() });
		expect(config.keepAliveColdPingMax).toBe(2);
	});

	test("CLI override beats default", () => {
		const { config } = loadConfig({
			cliOverrides: { keepAliveColdPingMax: 5 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.keepAliveColdPingMax).toBe(5);
	});

	test("0 is allowed (disables the cancellation)", () => {
		const { config } = loadConfig({
			cliOverrides: { keepAliveColdPingMax: 0 },
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(config.keepAliveColdPingMax).toBe(0);
	});

	test("negative value throws via validate()", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { keepAliveColdPingMax: -1 },
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/keepAliveColdPingMax/);
	});

	test("non-integer value throws via validate()", () => {
		expect(() =>
			loadConfig({
				cliOverrides: { keepAliveColdPingMax: 1.5 },
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/keepAliveColdPingMax/);
	});
});
