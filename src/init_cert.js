import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the default cert/key paths. We park them next to `state.json` rather
 * than in `~/.config/clawback/` because (a) they're runtime artifacts, not
 * user-edited config, and (b) keeping the private key colocated with the
 * other state file means the operator's filesystem permissions already cover
 * it. The path uses the same XDG convention as `resolveGlobalConfigPath`,
 * falling back to `~/.local/share/clawback/`.
 */
export function resolveDefaultCertDir(env = process.env) {
	const xdg = env.XDG_DATA_HOME;
	const base = xdg?.length ? xdg : path.join(env.HOME ?? "", ".local", "share");
	if (!base) {
		throw new Error(
			"cannot resolve default cert dir: HOME / XDG_DATA_HOME unset",
		);
	}
	return path.join(base, "clawback");
}

export function resolveDefaultCertPaths(env = process.env) {
	const dir = resolveDefaultCertDir(env);
	return {
		dir,
		cert: path.join(dir, "cert.pem"),
		key: path.join(dir, "key.pem"),
	};
}

/**
 * Probe for a usable mkcert install. `clawback quickstart --lan` uses this to
 * decide whether it can mint a *browser-trusted* cert (mkcert) instead of a
 * self-signed one that trips the "Not secure" warning.
 *
 * Two distinct facts matter and are reported separately:
 *   - `available`       — the `mkcert` binary is on PATH (we can run it at all).
 *   - `caRootInstalled` — `mkcert -install` has already added the local CA to
 *                         the system/browser trust stores. mkcert can ISSUE a
 *                         leaf without this, but browsers won't TRUST it until
 *                         the CA root is installed — so the caller echoes the
 *                         one-time `mkcert -install` hint when this is false.
 *
 * We never run `mkcert -install` ourselves (it mutates the system trust store
 * and may prompt for a password). `exec` is injectable so tests can drive the
 * available / ENOENT / not-yet-installed branches without a real mkcert.
 *
 * @returns {{ available: boolean, caRoot: string|null, caRootInstalled: boolean }}
 */
export function detectMkcert({
	env = process.env,
	exec = execFileSync,
	mkcertBin = "mkcert",
} = {}) {
	let caRoot;
	try {
		caRoot = String(
			exec(mkcertBin, ["-CAROOT"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				env,
			}),
		).trim();
	} catch {
		// ENOENT (not on PATH) or any other spawn/exit failure — treat mkcert
		// as unavailable and let the caller fall back to self-signed.
		return { available: false, caRoot: null, caRootInstalled: false };
	}
	const rootCa = caRoot ? path.join(caRoot, "rootCA.pem") : null;
	return {
		available: true,
		caRoot: caRoot || null,
		caRootInstalled: rootCa ? fs.existsSync(rootCa) : false,
	};
}

/**
 * Generate a self-signed TLS cert + key via the system `openssl`. We shell
 * out rather than vendor a JS X.509 builder because openssl is universally
 * available on macOS/Linux and produces standards-compliant output without
 * us re-implementing ASN.1 encoding.
 *
 * The cert's Subject Alternative Names cover `localhost`, loopback
 * (`127.0.0.1`, `::1`), the host's `os.hostname()`, and every non-internal IP
 * the box advertises (see `defaultCertHostnames` / `defaultCertIps`). The LAN
 * addresses matter once TLS auto-enables on an open-network bind, so a client
 * dialing the box by hostname or LAN IP sees a matching SAN. Without SAN,
 * modern browsers and Node's https.Agent both reject the cert regardless of CN.
 *
 * `mkcert: true` swaps the openssl self-signed mint for `mkcert`, which issues
 * the leaf from a locally-installed CA. The practical difference is trust:
 * openssl's cert is self-signed and browsers flag it "Not secure" until the
 * operator trusts it by hand; mkcert's cert chains to a CA that
 * `mkcert -install` has already added to the system + browser trust stores, so
 * Chrome shows a clean padlock with no per-cert trusting. We do NOT run
 * `mkcert -install` here — that mutates the system trust store and may prompt
 * for a password, so it stays an explicit one-time operator step.
 *
 * `exec` is injectable so tests can assert the spawned command without a real
 * openssl/mkcert on PATH (mkcert in particular is rarely present in CI).
 *
 * @returns {{ certPath: string, keyPath: string, action: "created"|"overwrote"|"skipped", tool: "openssl"|"mkcert" }}
 */
export function initCert({
	outDir = null,
	force = false,
	env = process.env,
	hostnames = defaultCertHostnames(),
	ips = defaultCertIps(),
	days = 365,
	openssl = "openssl",
	mkcert = false,
	mkcertBin = "mkcert",
	exec = execFileSync,
} = {}) {
	const tool = mkcert ? "mkcert" : "openssl";
	const dir = outDir ? path.resolve(outDir) : resolveDefaultCertDir(env);
	const certPath = path.join(dir, "cert.pem");
	const keyPath = path.join(dir, "key.pem");

	const existed = fs.existsSync(certPath) || fs.existsSync(keyPath);
	if (existed && !force) {
		return { certPath, keyPath, action: "skipped", tool };
	}

	fs.mkdirSync(dir, { recursive: true });

	if (mkcert) {
		// mkcert takes DNS names and IP literals as positional args and sorts
		// them into the right SAN type itself, so we hand it the same hostname
		// + IP set openssl gets. stderr is piped (not shown) so mkcert's own
		// chatter doesn't muddy clawback's output; on failure it's surfaced in
		// the thrown error, mirroring the openssl branch below.
		const names = [...hostnames, ...ips];
		try {
			exec(
				mkcertBin,
				["-cert-file", certPath, "-key-file", keyPath, ...names],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
		} catch (e) {
			const stderr = e.stderr ? e.stderr.toString().trim() : "";
			const hint =
				e.code === "ENOENT"
					? " (mkcert not found on PATH — install it: `brew install mkcert` on macOS, or see https://github.com/FiloSottile/mkcert, then run `mkcert -install` once)"
					: "";
			throw new Error(
				`mkcert failed to generate cert: ${e.message}${stderr ? ` -- ${stderr}` : ""}${hint}`,
			);
		}
		try {
			fs.chmodSync(keyPath, 0o600);
		} catch {
			/* best-effort; non-fatal */
		}
		return {
			certPath,
			keyPath,
			action: existed ? "overwrote" : "created",
			tool,
		};
	}

	const sanParts = [
		...hostnames.map((h) => `DNS:${h}`),
		...ips.map((ip) => `IP:${ip}`),
	];
	const subjectAltName = sanParts.join(",");

	// `-nodes` writes the key unencrypted (no passphrase). The operator's
	// filesystem permissions are the only thing protecting the key — same
	// posture as `~/.ssh/id_rsa` without a passphrase, which is a known
	// trade-off for ergonomic local TLS.
	const args = [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		keyPath,
		"-out",
		certPath,
		"-days",
		String(days),
		"-subj",
		`/CN=${hostnames[0] ?? "localhost"}`,
		"-addext",
		`subjectAltName=${subjectAltName}`,
	];

	try {
		exec(openssl, args, { stdio: ["ignore", "ignore", "pipe"] });
	} catch (e) {
		const stderr = e.stderr ? e.stderr.toString().trim() : "";
		const hint =
			stderr.includes("-addext") || stderr.includes("Unknown option")
				? " (your openssl may be too old for -addext; install openssl 1.1.1+ via Homebrew, or use mkcert)"
				: "";
		throw new Error(
			`openssl failed to generate cert: ${e.message}${stderr ? ` -- ${stderr}` : ""}${hint}`,
		);
	}

	// Tighten perms on the private key — defense in depth even though the
	// file lives in a user-only directory by default.
	try {
		fs.chmodSync(keyPath, 0o600);
	} catch {
		/* best-effort; non-fatal */
	}

	return {
		certPath,
		keyPath,
		action: existed ? "overwrote" : "created",
		tool,
	};
}

/**
 * Default DNS SANs: always `localhost`, plus the machine's `os.hostname()`
 * when it's a syntactically safe DNS name. The hostname matters once TLS
 * auto-enables on an open-network bind — a browser dialing the box by name
 * (e.g. https://devbox.local:8080) needs a matching SAN or it rejects the
 * cert independent of trust. Anything with characters openssl wouldn't accept
 * in a DNS SAN is skipped rather than risk a malformed -addext.
 */
export function defaultCertHostnames() {
	const names = ["localhost"];
	const h = os.hostname();
	if (typeof h === "string" && /^[A-Za-z0-9.-]+$/.test(h)) names.push(h);
	return [...new Set(names)];
}

/**
 * Default IP SANs: loopback (v4 + v6) plus every non-internal address the host
 * advertises, so a client dialing the box by its LAN IP over the auto-enabled
 * TLS port sees a matching SAN. Scoped/link-local forms that `net.isIP`
 * rejects are skipped so openssl never sees a malformed entry.
 */
export function defaultCertIps() {
	const ips = ["127.0.0.1", "::1"];
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (!a.internal && a.address && net.isIP(a.address) !== 0) {
				ips.push(a.address);
			}
		}
	}
	return [...new Set(ips)];
}
