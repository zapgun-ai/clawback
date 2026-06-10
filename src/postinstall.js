// Runs from package.json "postinstall". node-pty's prebuilt spawn-helper
// can land without its execute bit, which would make the first
// `clawback claude` fail with "posix_spawnp failed." We restore it here at
// install time; src/launch_claude.js also does it at runtime, so a skipped
// install script (--ignore-scripts) is not fatal.
//
// Must never fail the install: node-pty is optional, and the filesystem may
// be read-only. Everything is best-effort and we always exit 0.
try {
	const { ensurePtySpawnHelperExecutable } = await import(
		"./pty_helper_perms.js"
	);
	const fixed = ensurePtySpawnHelperExecutable();
	if (fixed.length > 0) {
		process.stdout.write(
			`clawback: marked node-pty spawn-helper executable (${fixed.length} file${
				fixed.length === 1 ? "" : "s"
			})\n`,
		);
	}
} catch {
	/* never break an install over a best-effort permission tweak */
}
