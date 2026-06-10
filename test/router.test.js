import { identifySession } from "../src/router.js";

test("path mode: agentId stripped, forward path preserved", () => {
	const r = identifySession({ url: "/alex/v1/messages", body: {} });
	expect(r).toEqual({ mode: "path", key: "alex", forwardPath: "/v1/messages" });
});

test("path mode: preserves query string and deeper paths", () => {
	const r = identifySession({
		url: "/agent-1/v1/messages/count_tokens?foo=bar",
		body: {},
	});
	expect(r.mode).toBe("path");
	expect(r.key).toBe("agent-1");
	expect(r.forwardPath).toBe("/v1/messages/count_tokens?foo=bar");
});

test("path mode: rejects reserved agent names", () => {
	const r = identifySession({ url: "/_proxy/v1/messages", body: {} });
	expect(r).toBeNull();
});

test("path mode: rejects bare /v1/messages as path mode", () => {
	const r = identifySession({ url: "/v1/messages", body: { system: "hi" } });
	expect(r.mode).toBe("hash");
});

test("hash mode: stable hash from system + tools", () => {
	const a = identifySession({
		url: "/v1/messages",
		body: { system: "hello", tools: [] },
	});
	const b = identifySession({
		url: "/v1/messages",
		body: { system: "hello", tools: [] },
	});
	expect(a.mode).toBe("hash");
	expect(a.key).toBe(b.key);
	expect(a.key).toMatch(/^[0-9a-f]{64}$/);
});

test("hash mode: different system produces different hash", () => {
	const a = identifySession({ url: "/v1/messages", body: { system: "a" } });
	const b = identifySession({ url: "/v1/messages", body: { system: "b" } });
	expect(a.key).not.toBe(b.key);
});

test("hash mode: key-order invariant for system object", () => {
	const a = identifySession({
		url: "/v1/messages",
		body: {
			system: [
				{ type: "text", text: "x", cache_control: { type: "ephemeral" } },
			],
		},
	});
	const b = identifySession({
		url: "/v1/messages",
		body: {
			system: [
				{ cache_control: { type: "ephemeral" }, text: "x", type: "text" },
			],
		},
	});
	expect(a.key).toBe(b.key);
});

test("returns null for non-messages endpoints", () => {
	expect(identifySession({ url: "/v1/complete", body: {} })).toBeNull();
});

test("returns null for /v1/messages without body", () => {
	expect(identifySession({ url: "/v1/messages", body: null })).toBeNull();
});

test("path mode: rejects custom adminPathPrefix as agentId", () => {
	const r = identifySession({
		url: "/_admin/v1/messages",
		body: {},
		adminPathPrefix: "_admin",
	});
	expect(r).toBeNull();
});

test("path mode: still rejects default _proxy when custom prefix is set", () => {
	const r = identifySession({
		url: "/_proxy/v1/messages",
		body: {},
		adminPathPrefix: "_admin",
	});
	expect(r).toBeNull();
});

test("path mode: a non-underscore prefix is also reserved", () => {
	const r = identifySession({
		url: "/admin/v1/messages",
		body: {},
		adminPathPrefix: "admin",
	});
	expect(r).toBeNull();
});
