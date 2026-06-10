import fs from "node:fs";
import path from "node:path";

export class SessionStore {
	constructor({ filePath, logger }) {
		this.filePath = filePath;
		this.logger = logger;
		this.data = { version: 1, sessions: {} };
		this._flushTimer = null;
		this._load();
	}

	_load() {
		try {
			const raw = fs.readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw);
			this.data = {
				version: parsed.version ?? 1,
				sessions: parsed.sessions ?? {},
			};
		} catch (e) {
			if (e.code !== "ENOENT") {
				this.logger?.warn(
					`state file read failed (${e.code ?? e.message}); starting fresh`,
				);
			}
		}
	}

	_scheduleFlush() {
		if (this._flushTimer) return;
		this._flushTimer = setTimeout(() => {
			this._flushTimer = null;
			try {
				this.flushNow();
			} catch (e) {
				this.logger?.warn(`state flush failed: ${e.message}`);
			}
		}, 250);
		this._flushTimer.unref?.();
	}

	flushNow() {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		// 0600: state.json holds the captured OAuth bearer (session.authHeaders).
		// `mode` on writeFileSync only takes effect on CREATE — `rename` preserves
		// the tmp's perms, so the live file ends up at 0600 on a fresh write.
		// For the in-place upgrade case (a pre-existing world-readable state.json
		// from before this guard landed), we chmod after rename too.
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, this.filePath);
		try {
			fs.chmodSync(this.filePath, 0o600);
		} catch {
			/* best-effort: chmod can fail on filesystems that don't track POSIX
			   modes (e.g. exFAT). The contents are still owner-restricted by the
			   tmp's mode in the common path; this is a defense-in-depth pass. */
		}
	}

	get(key) {
		return this.data.sessions[key] ?? null;
	}

	has(key) {
		return Object.prototype.hasOwnProperty.call(this.data.sessions, key);
	}

	all() {
		return Object.values(this.data.sessions);
	}

	keys() {
		return Object.keys(this.data.sessions);
	}

	upsert(key, updater) {
		const prev = this.data.sessions[key] ?? null;
		const next = updater(prev);
		if (next == null) return prev;
		this.data.sessions[key] = next;
		this._scheduleFlush();
		return next;
	}

	delete(key) {
		if (!this.has(key)) return false;
		delete this.data.sessions[key];
		// Synchronous flush, not debounced: operator-initiated deletes are
		// rare and the operator's mental model is "deleted = gone." A
		// process crash inside the 250ms debounce window would resurrect
		// the session on next boot, which would be a nasty surprise. The
		// throughput cost is one ~few-KB JSON write per delete; not an
		// issue at human cadences.
		this.flushNow();
		return true;
	}

	purgeAll() {
		const n = this.keys().length;
		this.data.sessions = {};
		// Same rationale as delete() — purgeAll is a deliberate operator
		// action and must be durable before we return.
		this.flushNow();
		return n;
	}
}
