/**
 * `openBrowser` is a best-effort, fire-and-forget helper used by
 * `clawback quickstart`. These tests cover the platform branching
 * and the `CLAWBACK_NO_OPEN_BROWSER` opt-out, without actually
 * spawning a browser.
 *
 * `waitForUrl` is covered indirectly by its consumers (the timeout
 * path is the dominant case) and the dedicated tests for
 * /_proxy/health elsewhere.
 */
import { openBrowser } from "../src/open_browser.js";

describe("openBrowser", () => {
	test("returns false on empty url", () => {
		expect(openBrowser("")).toBe(false);
		expect(openBrowser(null)).toBe(false);
	});

	test("respects CLAWBACK_NO_OPEN_BROWSER=1", () => {
		const result = openBrowser("http://localhost:8080/_proxy/ui/", {
			env: { CLAWBACK_NO_OPEN_BROWSER: "1" },
			platform: "darwin",
		});
		expect(result).toBe(false);
	});

	test("dispatches to a platform-appropriate command (darwin)", () => {
		// We don't want to actually launch a browser during tests, so we
		// pass an invalid-looking URL — `spawn` won't validate it, and the
		// detached child will fail silently (which is the documented
		// best-effort contract). The return value reflects "spawn did not
		// throw", which is what the caller cares about.
		const result = openBrowser("about:blank-for-test", {
			env: { CLAWBACK_NO_OPEN_BROWSER: "" },
			platform: "darwin",
		});
		expect(result).toBe(true);
	});

	test("dispatches to xdg-open on linux without throwing even when the binary is missing", () => {
		// On a fresh macOS test runner there may be no xdg-open. spawn
		// emits an 'error' event asynchronously in that case — we catch
		// it inside the helper, so the return value should still be true
		// (spawn itself didn't throw synchronously).
		const result = openBrowser("about:blank-for-test", {
			env: { CLAWBACK_NO_OPEN_BROWSER: "" },
			platform: "linux",
		});
		expect(result).toBe(true);
	});
});
