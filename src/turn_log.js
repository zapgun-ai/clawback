import fs from "node:fs";
import path from "node:path";

export class TurnLog {
	constructor({ filePath, logger } = {}) {
		this.filePath = filePath || null;
		this.logger = logger;
		this.enabled = Boolean(this.filePath);
		this.stream = null;
		this.writeCount = 0;
		if (this.enabled) this._ensureDir();
	}

	_ensureDir() {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		} catch (e) {
			this.logger?.warn(`turn-log mkdir failed: ${e.message}`);
			this.enabled = false;
		}
	}

	_ensureStream() {
		if (this.stream || !this.enabled) return;
		try {
			// 0600: turn-log is a per-request fingerprint trail (sessionKey,
			// model, token counts, timestamps). Not as sensitive as the
			// auth bearer in state.json, but it's enough to profile what
			// the operator is doing with claude and when — keep the same
			// owner-only posture.
			this.stream = fs.createWriteStream(this.filePath, {
				flags: "a",
				mode: 0o600,
			});
			try {
				fs.chmodSync(this.filePath, 0o600);
			} catch {
				/* best-effort */
			}
			this.stream.on("error", (err) => {
				this.logger?.warn(`turn-log stream error: ${err.message}`);
				this.enabled = false;
				this.stream = null;
			});
		} catch (e) {
			this.logger?.warn(`turn-log open failed: ${e.message}`);
			this.enabled = false;
		}
	}

	write(record) {
		if (!this.enabled) return;
		this._ensureStream();
		if (!this.stream) return;
		try {
			this.stream.write(`${JSON.stringify(record)}\n`);
			this.writeCount++;
		} catch (e) {
			this.logger?.warn(`turn-log write failed: ${e.message}`);
		}
	}

	close() {
		if (!this.stream) return;
		try {
			this.stream.end();
		} catch {
			/* best effort */
		}
		this.stream = null;
	}
}

export function createTurnLog({ filePath, logger } = {}) {
	return new TurnLog({ filePath, logger });
}
