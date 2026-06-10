import * as ptyCallbackServer from "../src/pty_callback_server.js";

async function postJson(url, body, headers = {}) {
	return await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: body == null ? undefined : JSON.stringify(body),
	});
}

describe("pty_callback_server", () => {
	test("start mints a token, binds 127.0.0.1, accepts /write with the token", async () => {
		const calls = [];
		const cb = await ptyCallbackServer.start({
			writer: (text) => calls.push(text),
		});
		try {
			expect(cb.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(typeof cb.token).toBe("string");
			expect(cb.token.length).toBeGreaterThan(16);

			const r = await postJson(
				`${cb.url}/write`,
				{ text: "hello\r" },
				{ authorization: `Bearer ${cb.token}` },
			);
			expect(r.status).toBe(200);
			const body = await r.json();
			expect(body.written).toBe(true);
			expect(body.bytes).toBe(6);
			expect(calls).toEqual(["hello\r"]);
		} finally {
			await cb.close();
		}
	});

	test("rejects requests without a token", async () => {
		const cb = await ptyCallbackServer.start({ writer: () => {} });
		try {
			const r = await postJson(`${cb.url}/write`, { text: "x" });
			expect(r.status).toBe(401);
		} finally {
			await cb.close();
		}
	});

	test("rejects requests with the wrong token", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "right",
		});
		try {
			const r = await postJson(
				`${cb.url}/write`,
				{ text: "x" },
				{ authorization: "Bearer wrong" },
			);
			expect(r.status).toBe(401);
		} finally {
			await cb.close();
		}
	});

	test("rejects non-/write paths with 404", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			const r = await postJson(
				`${cb.url}/notreal`,
				{ text: "x" },
				{ authorization: "Bearer tok" },
			);
			expect(r.status).toBe(404);
		} finally {
			await cb.close();
		}
	});

	test("rejects non-POST methods with 404", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			const r = await fetch(`${cb.url}/write`, {
				method: "PUT",
				headers: { authorization: "Bearer tok" },
			});
			expect(r.status).toBe(404);
		} finally {
			await cb.close();
		}
	});

	test("/health is unauthenticated and reports ok", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			const r = await fetch(`${cb.url}/health`);
			expect(r.status).toBe(200);
			const body = await r.json();
			expect(body.ok).toBe(true);
		} finally {
			await cb.close();
		}
	});

	test("rejects malformed JSON body with 400", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			const r = await fetch(`${cb.url}/write`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer tok",
				},
				body: "{not json",
			});
			expect(r.status).toBe(400);
		} finally {
			await cb.close();
		}
	});

	test("rejects oversized bodies with 400", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		try {
			const huge = "x".repeat(10_000);
			const r = await postJson(
				`${cb.url}/write`,
				{ text: huge },
				{ authorization: "Bearer tok" },
			);
			expect(r.status).toBe(400);
		} finally {
			await cb.close();
		}
	});

	test("a writer that throws returns 500", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {
				throw new Error("pty exploded");
			},
			token: "tok",
		});
		try {
			const r = await postJson(
				`${cb.url}/write`,
				{ text: "x" },
				{ authorization: "Bearer tok" },
			);
			expect(r.status).toBe(500);
			const body = await r.json();
			expect(body.error).toBe("writer_threw");
			expect(body.message).toMatch(/pty exploded/);
		} finally {
			await cb.close();
		}
	});

	test("start throws if writer is not a function", async () => {
		await expect(ptyCallbackServer.start({ writer: "nope" })).rejects.toThrow(
			/function/,
		);
	});

	test("close stops accepting connections", async () => {
		const cb = await ptyCallbackServer.start({
			writer: () => {},
			token: "tok",
		});
		const url = cb.url;
		await cb.close();
		await expect(
			fetch(`${url}/health`).then((r) => r.text()),
		).rejects.toThrow();
	});
});
