import fs from "node:fs";
import path from "node:path";

const LEVELS = ["debug", "info", "warn", "error", "silent"];
const SESSION_FILENAME_MAX_CHARS = 128;

/**
 * Create a logger.
 *
 * @param {string} level   one of debug|info|warn|error|silent
 * @param {Object} [opts]
 * @param {string|null} [opts.file]  if set, log lines are appended to this
 *   file instead of being written to stdout/stderr. Parent dirs are created.
 * @param {string|null} [opts.sessionLogDir]  if set, calls to
 *   `logger.forSession(sessionKey)` will tee log lines into
 *   `<sessionLogDir>/<sanitized-key>.log.txt` in addition to the main sink.
 *   Per-session files are opened lazily on first write and closed via
 *   `logger.close()`.
 */
export function createLogger(
	level = "info",
	{ file = null, sessionLogDir = null } = {},
) {
	const threshold = LEVELS.indexOf(level);

	let stream = null;
	if (file) {
		fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
		// 0600 on new-file create. `mode` only applies when the underlying
		// open(2) creates the file; an existing log keeps its perms unless
		// we chmod explicitly. Chmod-after handles the upgrade case from
		// pre-0600 logs and is best-effort (some filesystems ignore it).
		stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			/* best-effort */
		}
	}

	let sessionDirEnsured = false;
	const sessionStreams = new Map();

	function getSessionStream(sessionKey) {
		if (!sessionLogDir) return null;
		const safe = sanitizeSessionFilename(sessionKey);
		if (!safe) return null;
		const existing = sessionStreams.get(safe);
		if (existing) return existing;
		try {
			if (!sessionDirEnsured) {
				fs.mkdirSync(path.resolve(sessionLogDir), { recursive: true });
				sessionDirEnsured = true;
			}
			const filePath = path.resolve(sessionLogDir, `${safe}.log.txt`);
			// Per-session logs can include captured headers in error
			// messages and full upstream error bodies; same 0600 posture
			// as the main log file.
			const s = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 });
			try {
				fs.chmodSync(filePath, 0o600);
			} catch {
				/* best-effort */
			}
			s.on("error", () => {
				// Disable this stream on write failure; main log still works.
				sessionStreams.delete(safe);
			});
			sessionStreams.set(safe, s);
			return s;
		} catch {
			return null;
		}
	}

	function emit(lvl, sessionKey, args) {
		if (LEVELS.indexOf(lvl) < threshold) return;
		const ts = new Date().toISOString();
		const formatted = args
			.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
			.join(" ");
		const line = `${ts} [${lvl}] ${formatted}\n`;

		if (stream) {
			stream.write(line);
		} else {
			const fn =
				lvl === "error" || lvl === "warn" ? console.error : console.log;
			fn(`${ts} [${lvl}]`, ...args);
		}

		if (sessionKey) {
			const sStream = getSessionStream(sessionKey);
			if (sStream) sStream.write(line);
		}
	}

	const api = {
		debug: (...a) => emit("debug", null, a),
		info: (...a) => emit("info", null, a),
		warn: (...a) => emit("warn", null, a),
		error: (...a) => emit("error", null, a),
		child(_prefix) {
			return this;
		},
		forSession(sessionKey) {
			if (!sessionKey) return api;
			return {
				debug: (...a) => emit("debug", sessionKey, a),
				info: (...a) => emit("info", sessionKey, a),
				warn: (...a) => emit("warn", sessionKey, a),
				error: (...a) => emit("error", sessionKey, a),
				child(_prefix) {
					return this;
				},
				forSession(other) {
					return api.forSession(other ?? sessionKey);
				},
				close() {
					/* per-session loggers share the parent's streams */
				},
			};
		},
		close() {
			const pending = [];
			const finishStream = (s) => {
				if (!s) return;
				pending.push(
					new Promise((resolve) => {
						try {
							s.end(() => resolve());
						} catch {
							resolve();
						}
					}),
				);
			};
			finishStream(stream);
			for (const s of sessionStreams.values()) finishStream(s);
			sessionStreams.clear();
			return Promise.all(pending);
		},
	};
	return api;
}

/**
 * Make a session key safe to use as a filename component on common
 * filesystems. Allows letters, digits, dot, dash, underscore; everything
 * else (slash, colon, whitespace, control chars) becomes underscore.
 * Truncates to SESSION_FILENAME_MAX_CHARS so we don't blow filesystem
 * filename limits with long path-mode agentIds.
 */
export function sanitizeSessionFilename(sessionKey) {
	if (sessionKey == null) return null;
	const s = String(sessionKey)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, SESSION_FILENAME_MAX_CHARS);
	return s.length ? s : null;
}
