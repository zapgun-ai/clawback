import http from "node:http";
import { DEFAULTS } from "../src/config.js";
import {
	_getRing,
	appendEvent,
	clearEvents,
	listEvents,
} from "../src/events_log.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SessionStore } from "../src/store.js";

const logger = createLogger("silent");

afterEach(() => {
	clearEvents();
});

describe("events_log ring buffer", () => {
	test("starts empty", () => {
		expect(listEvents()).toEqual([]);
		expect(_getRing()).toEqual([]);
	});

	test("appendEvent stores entries with ts/type/text", () => {
		appendEvent({ type: "test", text: "hello" });
		const events = listEvents();
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("test");
		expect(events[0].text).toBe("hello");
		expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("listEvents returns newest first", () => {
		appendEvent({ type: "first", text: "a" });
		appendEvent({ type: "second", text: "b" });
		appendEvent({ type: "third", text: "c" });
		const events = listEvents();
		expect(events.map((e) => e.type)).toEqual(["third", "second", "first"]);
	});

	test("ring caps at 200 entries (oldest fall off)", () => {
		for (let i = 0; i < 250; i++) {
			appendEvent({ type: "spam", text: `event ${i}` });
		}
		const ring = _getRing();
		expect(ring.length).toBe(200);
		expect(ring[0].text).toBe("event 50");
		expect(ring[199].text).toBe("event 249");
	});

	test("limit parameter slices the response", () => {
		for (let i = 0; i < 10; i++) {
			appendEvent({ type: "n", text: `${i}` });
		}
		const events = listEvents({ limit: 3 });
		expect(events.map((e) => e.text)).toEqual(["9", "8", "7"]);
	});

	test("non-string type or text is silently dropped", () => {
		appendEvent({ type: 42, text: "ok" });
		appendEvent({ type: "ok", text: null });
		appendEvent({});
		expect(listEvents()).toEqual([]);
	});

	test("sessionKey and meta are preserved when supplied", () => {
		appendEvent({
			type: "auto-continue-fire",
			text: "fired",
			sessionKey: "abc123",
			meta: { bytes: 9 },
		});
		const event = listEvents()[0];
		expect(event.sessionKey).toBe("abc123");
		expect(event.meta).toEqual({ bytes: 9 });
	});

	test("admin /_proxy/events returns the buffer", async () => {
		appendEvent({ type: "test", text: "from admin endpoint test" });
		const dir = `/tmp/clawback-evt-${process.pid}-${Math.random().toString(36).slice(2)}`;
		const config = {
			...DEFAULTS,
			port: 0,
			host: "127.0.0.1",
			stateFile: `${dir}/state.json`,
			turnLogFile: null,
			sessionLogDir: null,
		};
		const store = new SessionStore({ filePath: config.stateFile, logger });
		const scheduler = {
			start() {},
			stop() {},
			ensureScheduled() {},
			cancelSession() {},
		};
		const server = createServer({ config, store, scheduler, logger });
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		const port = server.address().port;
		try {
			const r = await new Promise((resolve, reject) => {
				const req = http.get(
					{ host: "127.0.0.1", port, path: "/_proxy/events" },
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () =>
							resolve({
								status: res.statusCode,
								body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
							}),
						);
					},
				);
				req.on("error", reject);
			});
			expect(r.status).toBe(200);
			expect(r.body.events.length).toBe(1);
			expect(r.body.events[0].text).toBe("from admin endpoint test");
		} finally {
			server.close();
		}
	});

	test("since filter returns only events after the cutoff", () => {
		appendEvent({ type: "old", text: "before" });
		const cutoff = new Date().toISOString();
		// Tiny delay to guarantee a strictly-greater ts.
		const future = new Date(Date.now() + 10).toISOString();
		// Force-set the next entry's ts manually via direct ring access for
		// a deterministic test.
		appendEvent({ type: "new", text: "after" });
		_getRing()[1].ts = future;
		const events = listEvents({ since: cutoff });
		expect(events.map((e) => e.text)).toEqual(["after"]);
	});
});
