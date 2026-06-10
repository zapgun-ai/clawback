import http from "node:http";
import {
	activeInputLabel,
	activeRemoteRegistration,
	clearActiveInput,
	clearRemoteInput,
	hasActiveInput,
	registerRemoteInput,
	setActiveInput,
	writeInput,
} from "../src/claude_input.js";
import { DEFAULTS } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import * as ptyCallbackServer from "../src/pty_callback_server.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

afterEach(() => {
	clearActiveInput();
	clearRemoteInput();
});

describe("claude_input registry", () => {
	test("starts empty", async () => {
		expect(hasActiveInput()).toBe(false);
		expect(activeInputLabel()).toBeNull();
		const r = await writeInput("hello");
		expect(r.written).toBe(false);
		expect(r.reason).toMatch(/no active claude session/);
	});

	test("setActiveInput registers a writer; writeInput delivers bytes", async () => {
		const calls = [];
		setActiveInput((text) => calls.push(text), { label: "test-pty" });
		expect(hasActiveInput()).toBe(true);
		expect(activeInputLabel()).toBe("test-pty");
		const r = await writeInput("hello\n");
		expect(r.written).toBe(true);
		expect(r.bytes).toBe(6);
		expect(r.label).toBe("test-pty");
		expect(r.mode).toBe("local");
		expect(calls).toEqual(["hello\n"]);
	});

	test("clearActiveInput unregisters", async () => {
		setActiveInput(() => {});
		clearActiveInput();
		expect(hasActiveInput()).toBe(false);
		expect((await writeInput("x")).written).toBe(false);
	});

	test("non-string input returns a structured error rather than throwing", async () => {
		setActiveInput(() => {});
		const r = await writeInput(42);
		expect(r.written).toBe(false);
		expect(r.reason).toMatch(/string/);
	});

	test("input above 4KB is rejected", async () => {
		setActiveInput(() => {});
		const huge = "x".repeat(5000);
		const r = await writeInput(huge);
		expect(r.written).toBe(false);
		expect(r.reason).toMatch(/exceeds/);
	});

	test("setActiveInput rejects a non-function writer", () => {
		expect(() => setActiveInput("not a function")).toThrow(
			/must be a function/,
		);
	});

	test("a throwing writer returns a structured error rather than crashing", async () => {
		setActiveInput(() => {
			throw new Error("pty exploded");
		});
		const r = await writeInput("hi");
		expect(r.written).toBe(false);
		expect(r.reason).toMatch(/pty exploded/);
	});
});

describe("registerRemoteInput", () => {
	test("rejects non-loopback urls", () => {
		expect(() => registerRemoteInput({ url: "http://10.0.0.5:1234" })).toThrow(
			/loopback/,
		);
	});

	test("rejects non-http(s) urls", () => {
		expect(() => registerRemoteInput({ url: "file:///tmp/x" })).toThrow(
			/http:\/\/|https:\/\//,
		);
	});

	test("accepts a loopback url and normalizes it", () => {
		registerRemoteInput({
			url: "http://127.0.0.1:54321/some/path",
			token: "abc",
		});
		const reg = activeRemoteRegistration();
		expect(reg.url).toBe("http://127.0.0.1:54321");
		expect(reg.label).toBe("claude-remote");
		expect(typeof reg.registeredAt).toBe("string");
	});

	test("writeInput routes to a remote callback when no local writer is set", async () => {
		const calls = [];
		const cb = await ptyCallbackServer.start({
			writer: (text) => calls.push(text),
			token: "test-token",
		});
		registerRemoteInput({
			url: cb.url,
			token: "test-token",
			label: "claude-remote-test",
		});
		try {
			const r = await writeInput("hello via remote\n");
			expect(r.written).toBe(true);
			expect(r.bytes).toBe(17);
			expect(r.label).toBe("claude-remote-test");
			expect(r.mode).toBe("remote");
			expect(calls).toEqual(["hello via remote\n"]);
		} finally {
			await cb.close();
		}
	});

	test("local writer wins over remote when both are present", async () => {
		const localCalls = [];
		const remoteCalls = [];
		const cb = await ptyCallbackServer.start({
			writer: (text) => remoteCalls.push(text),
			token: "tok",
		});
		registerRemoteInput({ url: cb.url, token: "tok" });
		setActiveInput((text) => localCalls.push(text), { label: "local" });
		try {
			const r = await writeInput("which path?\n");
			expect(r.written).toBe(true);
			expect(r.mode).toBe("local");
			expect(r.label).toBe("local");
			expect(localCalls).toEqual(["which path?\n"]);
			expect(remoteCalls).toEqual([]);
		} finally {
			await cb.close();
		}
	});

	test("a 503-equivalent reason when the remote is gone", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		const deadUrl = cb.url;
		await cb.close();
		registerRemoteInput({ url: deadUrl, token: "tok" });
		const r = await writeInput("hi");
		expect(r.written).toBe(false);
		expect(r.reason).toMatch(/remote callback failed/);
	});

	test("wrong token from the proxy side ⇒ remote rejects with 401-shaped reason", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "correct-token",
		});
		registerRemoteInput({ url: cb.url, token: "wrong-token" });
		try {
			const r = await writeInput("hi");
			expect(r.written).toBe(false);
			expect(r.reason).toMatch(/401/);
		} finally {
			await cb.close();
		}
	});
});

function setupServer(overrides = {}) {
	const dir = `/tmp/clawback-input-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const config = {
		...DEFAULTS,
		port: 0,
		host: "127.0.0.1",
		stateFile: `${dir}/state.json`,
		turnLogFile: null,
		sessionLogDir: null,
		...overrides,
	};
	const store = new SessionStore({ filePath: config.stateFile, logger });
	const scheduler = {
		start() {},
		stop() {},
		ensureScheduled() {},
		cancelSession() {},
	};
	const server = createServer({ config, store, scheduler, logger });
	return { config, store, scheduler, server };
}

function listen(server) {
	return new Promise((r) =>
		server.listen(0, "127.0.0.1", () => r(server.address().port)),
	);
}

function jsonReq(port, urlPath, method = "GET", body = null) {
	return new Promise((resolve, reject) => {
		const headers = { "content-type": "application/json" };
		const payload = body == null ? null : JSON.stringify(body);
		if (payload) headers["content-length"] = Buffer.byteLength(payload);
		const req = http.request(
			{ method, host: "127.0.0.1", port, path: urlPath, headers },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
					}),
				);
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

describe("/_proxy/claude/input admin endpoint", () => {
	test("GET reports active=false when no claude session is registered", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/input");
			expect(r.status).toBe(200);
			expect(r.body.active).toBe(false);
			expect(r.body.label).toBeNull();
		} finally {
			ctx.server.close();
		}
	});

	test("POST returns 503 with explanation when no session is registered", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/input", "POST", {
				text: "continue\n",
			});
			expect(r.status).toBe(503);
			expect(r.body.written).toBe(false);
			expect(r.body.reason).toMatch(/no active claude session/);
		} finally {
			ctx.server.close();
		}
	});

	test("POST delivers text to a registered writer and returns 200", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		const calls = [];
		setActiveInput((t) => calls.push(t), { label: "test" });
		try {
			const r = await jsonReq(port, "/_proxy/claude/input", "POST", {
				text: "hello from clawback\n",
			});
			expect(r.status).toBe(200);
			expect(r.body.written).toBe(true);
			expect(r.body.bytes).toBe(20);
			expect(r.body.label).toBe("test");
			expect(calls).toEqual(["hello from clawback\n"]);
		} finally {
			ctx.server.close();
		}
	});

	test("POST rejects malformed body with 400", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/input", "POST", {
				not_text: "oops",
			});
			expect(r.status).toBe(400);
			expect(r.body.error).toBe("bad_request");
		} finally {
			ctx.server.close();
		}
	});

	test("PUT and DELETE return 405", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/input", "DELETE");
			expect(r.status).toBe(405);
		} finally {
			ctx.server.close();
		}
	});
});

describe("/_proxy/claude/register admin endpoint (reverse channel)", () => {
	test("POST registers a remote callback; GET /input then reports it", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			const reg = await jsonReq(port, "/_proxy/claude/register", "POST", {
				url: cb.url,
				token: "tok",
				label: "claude-remote-x",
			});
			expect(reg.status).toBe(200);
			expect(reg.body.registered).toBe(true);
			expect(reg.body.remote.url).toBe(cb.url);
			expect(reg.body.remote.label).toBe("claude-remote-x");

			const probe = await jsonReq(port, "/_proxy/claude/input");
			expect(probe.status).toBe(200);
			expect(probe.body.active).toBe(true);
			expect(probe.body.label).toBe("claude-remote-x");
			expect(probe.body.remote.url).toBe(cb.url);
		} finally {
			await cb.close();
			ctx.server.close();
		}
	});

	test("POST with non-loopback url returns 400", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/register", "POST", {
				url: "http://10.1.2.3:8888",
				token: "tok",
			});
			expect(r.status).toBe(400);
			expect(r.body.error).toBe("bad_request");
			expect(r.body.message).toMatch(/loopback/);
		} finally {
			ctx.server.close();
		}
	});

	test("POST with malformed body returns 400", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/register", "POST", {
				not_url: true,
			});
			expect(r.status).toBe(400);
			expect(r.body.error).toBe("bad_request");
		} finally {
			ctx.server.close();
		}
	});

	test("DELETE clears the registration", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			await jsonReq(port, "/_proxy/claude/register", "POST", {
				url: cb.url,
				token: "tok",
			});
			const del = await jsonReq(port, "/_proxy/claude/register", "DELETE");
			expect(del.status).toBe(200);
			expect(del.body.cleared).toBe(true);
			const probe = await jsonReq(port, "/_proxy/claude/input");
			expect(probe.body.active).toBe(false);
			expect(probe.body.remote).toBeNull();
		} finally {
			await cb.close();
			ctx.server.close();
		}
	});

	test("end-to-end: register, then POST /_proxy/claude/input drives the remote PTY", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		const remoteCalls = [];
		const cb = await ptyCallbackServer.start({
			writer: (text) => remoteCalls.push(text),
			token: "tok",
		});
		try {
			const reg = await jsonReq(port, "/_proxy/claude/register", "POST", {
				url: cb.url,
				token: "tok",
				label: "claude-remote-e2e",
			});
			expect(reg.status).toBe(200);
			const fire = await jsonReq(port, "/_proxy/claude/input", "POST", {
				text: "continue\r",
			});
			expect(fire.status).toBe(200);
			expect(fire.body.written).toBe(true);
			expect(fire.body.mode).toBe("remote");
			expect(fire.body.label).toBe("claude-remote-e2e");
			expect(remoteCalls).toEqual(["continue\r"]);
		} finally {
			await cb.close();
			ctx.server.close();
		}
	});

	test("PUT returns 405", async () => {
		const ctx = setupServer();
		const port = await listen(ctx.server);
		try {
			const r = await jsonReq(port, "/_proxy/claude/register", "GET");
			expect(r.status).toBe(405);
		} finally {
			ctx.server.close();
		}
	});
});
