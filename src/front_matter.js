// Minimal YAML front matter for clawback's config file (CLAWBACK.md).
//
// clawback carries ZERO runtime dependencies on purpose — it fronts the
// operator's live Anthropic credentials, so every dependency is attack
// surface. The config it persists is a flat map of scalars (string / number /
// boolean / null), no nesting and no arrays, so rather than pull in a YAML
// library we hand-roll exactly that subset here. Output is valid YAML (a
// document with a double-quoted-scalar mapping), so external tooling can still
// read CLAWBACK.md's front matter; anything richer than a flat scalar is
// intentionally unsupported and throws rather than silently mis-parsing a
// value. The adminToken is a secret string that can contain ':', '#', quotes,
// or backslashes, so strings are always emitted double-quoted-and-escaped (via
// JSON.stringify, whose escapes are a subset of YAML's double-quoted escapes)
// and parsed back losslessly.

const FENCE = "---";
const BOM = 0xfeff;

/**
 * Parse a CLAWBACK.md document: a `---` fenced YAML front-matter block followed
 * by an optional markdown body. Returns `{ data, body }` where `data` is the
 * flat config object and `body` is everything after the closing fence.
 *
 * Throws if the document does not open with a fence, if the fence is never
 * closed, or if a value cannot be parsed as a flat scalar — malformed config
 * fails loudly rather than silently dropping a key (a silently-ignored
 * `adminToken` would be a security footgun).
 */
export function parseFrontMatter(text) {
	if (typeof text !== "string") {
		throw new TypeError("front matter source must be a string");
	}
	// Tolerate a leading BOM, then split on either newline style.
	const src = text.charCodeAt(0) === BOM ? text.slice(1) : text;
	const lines = src.split(/\r?\n/);
	if (lines[0]?.trim() !== FENCE) {
		throw new Error(
			"clawback config must open with a YAML front-matter fence ('---' on the first line)",
		);
	}
	const data = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === FENCE) {
			// Closing fence — the remainder is the (ignored) markdown body.
			return { data, body: lines.slice(i + 1).join("\n") };
		}
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue; // blank / comment
		const idx = line.indexOf(":");
		if (idx === -1) {
			throw new Error(
				`malformed front-matter line (expected "key: value"): ${JSON.stringify(line)}`,
			);
		}
		const key = line.slice(0, idx).trim();
		if (key === "") {
			throw new Error(
				`malformed front-matter line (empty key): ${JSON.stringify(line)}`,
			);
		}
		data[key] = parseScalar(line.slice(idx + 1).trim(), key);
	}
	throw new Error("unterminated YAML front matter (missing closing '---')");
}

function parseScalar(raw, key) {
	if (raw === "") return null; // `key:` with no value reads as null
	const first = raw[0];
	if (first === '"') {
		// Double-quoted: our serializer emits JSON-compatible escapes, which are
		// a subset of YAML's, so JSON.parse round-trips them losslessly.
		let v;
		try {
			v = JSON.parse(raw);
		} catch (e) {
			throw new Error(
				`invalid double-quoted string for "${key}": ${raw} (${e.message})`,
			);
		}
		if (typeof v !== "string") {
			throw new Error(`invalid double-quoted string for "${key}": ${raw}`);
		}
		return v;
	}
	if (first === "'") {
		// Single-quoted YAML scalar: the only escape is a doubled '' for a literal
		// quote. Accept it for hand-edited files (we never emit single quotes).
		if (raw.length < 2 || !raw.endsWith("'")) {
			throw new Error(`unterminated single-quoted string for "${key}": ${raw}`);
		}
		return raw.slice(1, -1).replaceAll("''", "'");
	}
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null" || raw === "~") return null;
	// Number (int/float, optional sign + exponent). Guard with a finite check so
	// a stray "Infinity"/"NaN" stays a bare string rather than a footgun value.
	if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
		const n = Number(raw);
		if (Number.isFinite(n)) return n;
	}
	// Bare (unquoted) string. We never EMIT these — every string we write is
	// quoted — but accept them so a hand-edited `host: 0.0.0.0` still works.
	return raw;
}

/**
 * Serialize a flat config object to a CLAWBACK.md document: a `---` fenced
 * front-matter mapping, then the optional markdown `body`. Keys with an
 * `undefined` value are skipped; runtime-only keys (those starting with `_`,
 * e.g. `_baselineSnapshot`) are skipped so they are never persisted.
 *
 * Throws on a non-plain-object input or a non-scalar value — front matter is
 * flat scalars only, and failing loudly beats writing a config we can't read
 * back.
 */
export function stringifyFrontMatter(data, body = "") {
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new TypeError("front-matter data must be a plain object");
	}
	const out = [FENCE];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (key.startsWith("_")) continue; // runtime-only, never persisted
		out.push(`${key}: ${serializeScalar(value, key)}`);
	}
	out.push(FENCE);
	const fence = out.join("\n");
	// Always leave a blank line after the closing fence; append the body if any.
	const trailer = body
		? `\n\n${body.replace(/^\n+/, "").replace(/\n*$/, "")}\n`
		: "\n";
	return `${fence}${trailer}`;
}

function serializeScalar(value, key) {
	if (value === null) return "null";
	const t = typeof value;
	if (t === "boolean") return value ? "true" : "false";
	if (t === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(
				`cannot serialize non-finite number for "${key}": ${value}`,
			);
		}
		return String(value);
	}
	if (t === "string") {
		// JSON.stringify produces a valid YAML double-quoted scalar for our
		// charset (escapes ", \, and control chars), and parseScalar reads it
		// back via JSON.parse — so a secret with ':' or '#' round-trips intact.
		return JSON.stringify(value);
	}
	throw new Error(
		`cannot serialize ${t} for "${key}" — clawback front matter is flat scalars only`,
	);
}
