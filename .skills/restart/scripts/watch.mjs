#!/usr/bin/env node
// Debounced run-on-change watcher (zero deps; built-in recursive fs.watch).
//
// Watches one or more directories and runs a command when a source file
// under them changes. Used by `restart.sh --watch` to reboot the proxy
// automatically when another session edits the code.
//
// Usage:
//   node watch.mjs --dir PATH [--dir PATH...] [--debounce MS] [--initial] \
//     -- CMD [ARGS...]
//
//   --dir PATH     directory to watch recursively (repeatable)
//   --debounce MS  coalesce a burst of edits into one run (default 300)
//   --initial      run the command once at startup, before any change
//   -- CMD ARGS    the command to run on change (everything after `--`)
//
// Design notes (the non-obvious bits):
//   * Only the given dirs are watched, so a watcher pointed at src/+bin/
//     never sees the proxy's own writes under data/ — no restart loop.
//   * Runs are SERIALIZED: a change arriving while the command is still
//     running sets a pending flag and triggers exactly one more run after
//     it finishes, so two restarts never race on the pidfile.
//   * The command is spawned DETACHED (its own session). The proxy it
//     starts therefore outlives this watcher: Ctrl-C here stops watching
//     but leaves the proxy running, matching `--detach` semantics.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const dirs = [];
let debounceMs = 300;
let initial = false;
let cmd = null;
let cmdArgs = [];

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--dir") {
		dirs.push(argv[++i]);
	} else if (a === "--debounce") {
		debounceMs = Number(argv[++i]);
	} else if (a === "--initial") {
		initial = true;
	} else if (a === "--") {
		cmd = argv[i + 1] ?? null;
		cmdArgs = argv.slice(i + 2);
		break;
	} else {
		console.error(`watch: unknown argument '${a}'`);
		process.exit(2);
	}
}

if (dirs.length === 0) {
	console.error("watch: at least one --dir is required");
	process.exit(2);
}
if (!cmd) {
	console.error("watch: missing command after `--`");
	process.exit(2);
}
if (!Number.isFinite(debounceMs) || debounceMs < 0) {
	console.error("watch: --debounce must be a non-negative number");
	process.exit(2);
}

// Only code changes matter; ignore editor temp/backup noise and VCS dirs so a
// `:w` in vim (which writes swap files and a `4913` probe) doesn't restart.
const SOURCE_RE = /\.(js|mjs|cjs)$/;
const IGNORE_RE =
	/(^|\/)(node_modules|\.git)(\/|$)|\.swp$|\.swx$|~$|(^|\/)4913$|\.DS_Store$/;

let timer = null;
let running = false;
let pending = false;

function trigger(reason) {
	if (running) {
		pending = true;
		return;
	}
	running = true;
	console.log(`watch: ${reason} → ${cmd} ${cmdArgs.join(" ")}`);
	const child = spawn(cmd, cmdArgs, { detached: true, stdio: "inherit" });
	child.on("exit", (code) => {
		running = false;
		if (code !== 0) {
			console.error(`watch: restart command exited with ${code}`);
		}
		if (pending) {
			pending = false;
			trigger("coalesced changes");
		}
	});
	child.on("error", (err) => {
		running = false;
		console.error(`watch: failed to run command: ${err.message}`);
	});
}

function schedule(label) {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		trigger(`change ${label}`);
	}, debounceMs);
}

function onEvent(dir, filename) {
	if (!filename) return; // some platforms omit the name on some events
	const rel = path.join(dir, filename.toString());
	if (IGNORE_RE.test(rel)) return;
	if (!SOURCE_RE.test(rel)) return;
	schedule(rel);
}

for (const dir of dirs) {
	try {
		watch(dir, { recursive: true }, (_event, filename) =>
			onEvent(dir, filename),
		);
		console.log(`watch: watching ${dir}`);
	} catch (err) {
		console.error(`watch: cannot watch ${dir}: ${err.message}`);
		process.exit(1);
	}
}

process.on("SIGINT", () => {
	console.log("\nwatch: stopped watching (proxy left running).");
	process.exit(0);
});

console.log(
	`watch: ready (debounce ${debounceMs}ms, source files only). Ctrl-C to stop watching.`,
);

if (initial) trigger("initial start");
