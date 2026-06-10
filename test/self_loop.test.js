import { detectSelfLoop } from "../src/self_loop.js";

describe("detectSelfLoop", () => {
	test("returns false when upstream points elsewhere", () => {
		expect(
			detectSelfLoop({
				upstream: "https://api.anthropic.com",
				bound: { address: "127.0.0.1", port: 8080 },
			}),
		).toBe(false);
	});

	test("detects 127.0.0.1 loopback on same port", () => {
		expect(
			detectSelfLoop({
				upstream: "http://127.0.0.1:8080",
				bound: { address: "127.0.0.1", port: 8080 },
			}),
		).toBe(true);
	});

	test("detects localhost loopback on same port", () => {
		expect(
			detectSelfLoop({
				upstream: "http://localhost:8080",
				bound: { address: "127.0.0.1", port: 8080 },
			}),
		).toBe(true);
	});

	test("detects ::1 loopback on same port", () => {
		expect(
			detectSelfLoop({
				upstream: "http://[::1]:8080",
				bound: { address: "::", port: 8080 },
			}),
		).toBe(true);
	});

	test("ignores loopback on a different port (legitimate proxy chain)", () => {
		expect(
			detectSelfLoop({
				upstream: "http://127.0.0.1:9999",
				bound: { address: "127.0.0.1", port: 8080 },
			}),
		).toBe(false);
	});

	test("detects same non-loopback IP + same port (operator bound to LAN IP)", () => {
		expect(
			detectSelfLoop({
				upstream: "http://10.0.0.5:8080",
				bound: { address: "10.0.0.5", port: 8080 },
			}),
		).toBe(true);
	});

	test("malformed upstream URL returns false (don't false-positive on broken input)", () => {
		expect(
			detectSelfLoop({
				upstream: "not a url",
				bound: { address: "127.0.0.1", port: 8080 },
			}),
		).toBe(false);
	});

	test("missing inputs return false", () => {
		expect(detectSelfLoop({})).toBe(false);
		expect(detectSelfLoop({ upstream: "http://x", bound: null })).toBe(false);
		expect(detectSelfLoop({ upstream: null, bound: { port: 80 } })).toBe(false);
	});

	test("https default port 443 with no explicit port — only matches when bound on 443", () => {
		expect(
			detectSelfLoop({
				upstream: "https://localhost",
				bound: { address: "127.0.0.1", port: 443 },
			}),
		).toBe(true);
		expect(
			detectSelfLoop({
				upstream: "https://localhost",
				bound: { address: "127.0.0.1", port: 8080 },
			}),
		).toBe(false);
	});
});
