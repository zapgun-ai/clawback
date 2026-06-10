import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AUTO_DISCOVERED_CONFIG_NAME,
	resolveGlobalConfigPath,
} from "../src/config.js";
import { parseFrontMatter, stringifyFrontMatter } from "../src/front_matter.js";
import { setRemoteUrl } from "../src/remote.js";

let tmpDir;
let homeDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-remote-"));
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-remote-home-"));
});

afterEach(() => {
	for (const d of [tmpDir, homeDir]) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function isolatedEnv() {
	return { HOME: homeDir, XDG_CONFIG_HOME: "" };
}

describe("setRemoteUrl (clawback remote subcommand)", () => {
	test("writes remoteUrl to ./CLAWBACK.md under --local", () => {
		const result = setRemoteUrl({
			url: "https://clawback.example.com:8888",
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(result.action).toBe("set");
		expect(result.remoteUrl).toBe("https://clawback.example.com:8888");
		expect(result.path).toBe(path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME));
		const written = parseFrontMatter(fs.readFileSync(result.path, "utf8")).data;
		expect(written.remoteUrl).toBe("https://clawback.example.com:8888");
	});

	test("default scope is global (writes to XDG path)", () => {
		const env = isolatedEnv();
		const result = setRemoteUrl({
			url: "http://dev.box:8080",
			env,
		});
		expect(result.path).toBe(resolveGlobalConfigPath(env));
		const written = parseFrontMatter(fs.readFileSync(result.path, "utf8")).data;
		expect(written.remoteUrl).toBe("http://dev.box:8080");
	});

	test("normalizes the URL (strips trailing slash, drops path)", () => {
		const result = setRemoteUrl({
			url: "https://example.com:8888/some/path/",
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(result.remoteUrl).toBe("https://example.com:8888");
	});

	test("rejects an invalid URL with a clear message", () => {
		expect(() =>
			setRemoteUrl({
				url: "not-a-url",
				local: true,
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/invalid remote URL/);
	});

	test("rejects an ftp:// URL", () => {
		expect(() =>
			setRemoteUrl({
				url: "ftp://example.com",
				local: true,
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/must be http:\/\/ or https:\/\//);
	});

	test("preserves existing fields in the config file (shallow merge)", () => {
		const file = path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(
			file,
			stringifyFrontMatter({
				port: 9999,
				adminToken: "keep-me",
				logLevel: "warn",
			}),
		);
		setRemoteUrl({
			url: "https://example.com:8888",
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		const written = parseFrontMatter(fs.readFileSync(file, "utf8")).data;
		expect(written.port).toBe(9999);
		expect(written.adminToken).toBe("keep-me");
		expect(written.logLevel).toBe("warn");
		expect(written.remoteUrl).toBe("https://example.com:8888");
	});

	test("preserves a tight existing file mode across the rewrite", () => {
		const file = path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(file, stringifyFrontMatter({ adminToken: "tight" }));
		fs.chmodSync(file, 0o600);
		setRemoteUrl({
			url: "https://example.com:8888",
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		const mode = fs.statSync(file).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("reports `updated` and prior value when remoteUrl already set", () => {
		const file = path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(
			file,
			stringifyFrontMatter({ remoteUrl: "https://old.example.com:8888" }),
		);
		const result = setRemoteUrl({
			url: "https://new.example.com:8888",
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(result.action).toBe("updated");
		expect(result.previous).toBe("https://old.example.com:8888");
		expect(result.remoteUrl).toBe("https://new.example.com:8888");
	});

	test("--clear removes the remoteUrl field and reports the previous value", () => {
		const file = path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		fs.writeFileSync(
			file,
			stringifyFrontMatter({
				port: 9999,
				remoteUrl: "https://old.example.com:8888",
			}),
		);
		const result = setRemoteUrl({
			clear: true,
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(result.action).toBe("cleared");
		expect(result.previous).toBe("https://old.example.com:8888");
		const written = parseFrontMatter(fs.readFileSync(file, "utf8")).data;
		expect(written.remoteUrl).toBeUndefined();
		expect(written.port).toBe(9999);
	});

	test("--clear on a file without remoteUrl is a no-op (does NOT create a file)", () => {
		const file = path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		const result = setRemoteUrl({
			clear: true,
			local: true,
			cwd: tmpDir,
			env: isolatedEnv(),
		});
		expect(result.action).toBe("cleared-noop");
		expect(fs.existsSync(file)).toBe(false);
	});

	test("--clear with a URL argument throws", () => {
		expect(() =>
			setRemoteUrl({
				url: "https://example.com",
				clear: true,
				local: true,
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/--clear cannot be combined with a URL argument/);
	});

	test("missing URL without --clear throws", () => {
		expect(() =>
			setRemoteUrl({ local: true, cwd: tmpDir, env: isolatedEnv() }),
		).toThrow(/provide a URL or pass --clear/);
	});

	test("--global and --local together throws", () => {
		expect(() =>
			setRemoteUrl({
				url: "https://example.com",
				global: true,
				local: true,
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/mutually exclusive/);
	});

	test("explicit --config <path> overrides scope", () => {
		const explicitPath = path.join(tmpDir, "alt-config.json");
		const result = setRemoteUrl({
			url: "https://example.com:8888",
			configPath: explicitPath,
			env: isolatedEnv(),
		});
		expect(result.path).toBe(path.resolve(explicitPath));
		expect(fs.existsSync(explicitPath)).toBe(true);
	});

	test("refuses to overwrite an existing file it can't parse", () => {
		const file = path.resolve(tmpDir, AUTO_DISCOVERED_CONFIG_NAME);
		// A fenceless JSON blob is not a clawback config; setRemoteUrl must
		// refuse to clobber it rather than silently overwrite the operator's
		// file with front matter.
		fs.writeFileSync(file, JSON.stringify(["not", "an", "object"]));
		expect(() =>
			setRemoteUrl({
				url: "https://example.com",
				local: true,
				cwd: tmpDir,
				env: isolatedEnv(),
			}),
		).toThrow(/failed to parse existing config/);
	});
});
