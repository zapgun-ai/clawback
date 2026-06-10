import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionTlsCert } from "../src/index.js";
import { resolveDefaultCertPaths } from "../src/init_cert.js";

let tmpDir;
let homeDir;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-provtls-"));
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawback-provtls-home-"));
});

afterEach(() => {
	for (const d of [tmpDir, homeDir]) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function fakeLogger() {
	const warnings = [];
	return {
		warnings,
		warn: (m) => warnings.push(m),
		info: () => {},
		debug: () => {},
		error: () => {},
	};
}

describe("provisionTlsCert", () => {
	test("no-op when tls is off", () => {
		let called = false;
		provisionTlsCert(
			{ tls: false },
			{
				logger: fakeLogger(),
				env: { HOME: homeDir },
				initCertFn: () => {
					called = true;
					return { action: "created" };
				},
			},
		);
		expect(called).toBe(false);
	});

	test("no-op when cert + key already exist", () => {
		const certPath = path.join(tmpDir, "cert.pem");
		const keyPath = path.join(tmpDir, "key.pem");
		fs.writeFileSync(certPath, "cert");
		fs.writeFileSync(keyPath, "key");
		let called = false;
		provisionTlsCert(
			{ tls: true, tlsCertFile: certPath, tlsKeyFile: keyPath },
			{
				logger: fakeLogger(),
				env: { HOME: homeDir },
				initCertFn: () => {
					called = true;
					return { action: "created" };
				},
			},
		);
		expect(called).toBe(false);
	});

	test("selfSign mints a cert and repoints config at the default paths", () => {
		const { cert, key } = resolveDefaultCertPaths({ HOME: homeDir });
		const config = {
			tls: true,
			selfSign: true,
			host: "0.0.0.0",
			_tlsAutoEnabled: true,
			tlsCertFile: cert,
			tlsKeyFile: key,
		};
		const calls = [];
		const logger = fakeLogger();
		provisionTlsCert(config, {
			logger,
			env: { HOME: homeDir },
			initCertFn: (opts) => {
				calls.push(opts);
				return { action: "created" };
			},
		});
		expect(calls).toHaveLength(1);
		// force:true so a half-present pair is regenerated consistently.
		expect(calls[0].force).toBe(true);
		expect(config.tlsCertFile).toBe(cert);
		expect(config.tlsKeyFile).toBe(key);
		// Loud log includes the NODE_EXTRA_CA_CERTS hint a remote client needs.
		expect(logger.warnings.join("\n")).toMatch(/NODE_EXTRA_CA_CERTS=/);
		expect(logger.warnings.join("\n")).toMatch(/open-network bind/);
	});

	test("missing cert without selfSign throws the actionable auto-enable error", () => {
		const config = {
			tls: true,
			selfSign: false,
			host: "0.0.0.0",
			_tlsAutoEnabled: true,
			tlsCertFile: path.join(tmpDir, "nope-cert.pem"),
			tlsKeyFile: path.join(tmpDir, "nope-key.pem"),
		};
		let threw;
		try {
			provisionTlsCert(config, {
				logger: fakeLogger(),
				env: { HOME: homeDir },
				initCertFn: () => {
					throw new Error("should not mint");
				},
			});
		} catch (e) {
			threw = e;
		}
		expect(threw).toBeDefined();
		// Explains *why* TLS is on (auto-enable) and all three remedies.
		expect(threw.message).toMatch(/open-network bind/);
		expect(threw.message).toMatch(/clawback init-cert/);
		expect(threw.message).toMatch(/--self-sign/);
		expect(threw.message).toMatch(/--tls off/);
	});

	test("missing cert with explicit tls (not auto) uses the 'tls is on' wording", () => {
		const config = {
			tls: true,
			selfSign: false,
			host: "0.0.0.0",
			// no _tlsAutoEnabled — operator turned tls on explicitly
			tlsCertFile: path.join(tmpDir, "nope-cert.pem"),
			tlsKeyFile: path.join(tmpDir, "nope-key.pem"),
		};
		expect(() =>
			provisionTlsCert(config, {
				logger: fakeLogger(),
				env: { HOME: homeDir },
				initCertFn: () => ({ action: "created" }),
			}),
		).toThrow(/tls is on; no TLS cert found/);
	});
});
