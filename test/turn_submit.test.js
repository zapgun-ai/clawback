import { ENTER_ENCODINGS, submitTurn } from "../benchmark/lib/turn_submit.js";

// Build a submitTurn harness with recording fakes. `confirmPlan` is the
// sequence of values `confirm()` returns on successive calls (a label =
// landed, null = no-op Enter → escalate).
function harness(confirmPlan) {
	const writes = [];
	const sleeps = [];
	let confirmCalls = 0;
	const write = (s) => writes.push(s);
	const sleep = (ms) => {
		sleeps.push(ms);
		return Promise.resolve();
	};
	const confirm = () => {
		const v = confirmPlan[confirmCalls] ?? null;
		confirmCalls++;
		return Promise.resolve(v);
	};
	return { writes, sleeps, write, sleep, confirm, calls: () => confirmCalls };
}

describe("submitTurn — separates text from the Enter keystroke", () => {
	// THE REGRESSION: the bug was `pty.write(`${prompt}\r`)` — text and CR in
	// one chunk, which Claude Code's paste coalescing swallows. This asserts
	// the fix: the prompt text is written on its own, and no single write ever
	// concatenates the text with a trailing Enter byte.
	test("never writes the prompt text glued to an Enter byte", async () => {
		const h = harness(["turnlog"]);
		const text = "Summarize what this project does in two sentences.";
		await submitTurn({ ...h, text });

		// The text is its own write...
		expect(h.writes[0]).toBe(text);
		// ...and the Enter byte is a separate, subsequent write.
		expect(h.writes[1]).toBe("\r");
		// The buggy single-chunk pattern must appear in NO write.
		for (const w of h.writes) {
			expect(w).not.toBe(`${text}\r`);
			expect(w).not.toBe(`${text}\n`);
			// no write both contains the prompt AND ends in an Enter byte
			expect(w === text || !/[\r\n]$/.test(w) || !w.includes(text)).toBe(true);
		}
	});

	test("pauses after typing text, before the first Enter", async () => {
		const h = harness(["pty"]);
		await submitTurn({ ...h, text: "hello", opts: { typePauseMs: 250 } });
		// First write is the text; first sleep (the type-pause) happens before
		// the Enter write at index 1.
		expect(h.writes[0]).toBe("hello");
		expect(h.sleeps[0]).toBe(250);
		expect(h.writes[1]).toBe("\r");
	});

	test("tries \\r first and stops on the first confirmation", async () => {
		const h = harness(["turnlog"]); // confirms immediately
		const res = await submitTurn({ ...h, text: "hi" });
		expect(res).toEqual({
			confirmed: true,
			encoding: "\r",
			how: "turnlog",
			attempts: 1,
		});
		// Only the text + one Enter (\r) were written — no \n / \r\n leaked.
		expect(h.writes).toEqual(["hi", "\r"]);
		expect(h.calls()).toBe(1);
	});

	test("escalates \\r → \\n → \\r\\n when confirmation keeps failing", async () => {
		// \r fails, \n fails, \r\n lands.
		const h = harness([null, null, "pty"]);
		const res = await submitTurn({ ...h, text: "go" });
		expect(res.confirmed).toBe(true);
		expect(res.encoding).toBe("\r\n");
		expect(res.attempts).toBe(3);
		// Writes: text, then each encoding in order.
		expect(h.writes).toEqual(["go", "\r", "\n", "\r\n"]);
	});

	test("cycles encodings across rounds, then gives up unconfirmed", async () => {
		// Never confirms: 2 rounds × 3 encodings = 6 Enter attempts.
		const h = harness([]); // confirm always null
		const res = await submitTurn({
			...h,
			text: "x",
			opts: { maxRounds: 2 },
		});
		expect(res).toEqual({
			confirmed: false,
			encoding: null,
			how: null,
			attempts: 6,
		});
		// text + 6 Enter keystrokes (\r,\n,\r\n,\r,\n,\r\n).
		expect(h.writes).toEqual(["x", "\r", "\n", "\r\n", "\r", "\n", "\r\n"]);
	});

	test("ENTER_ENCODINGS is the documented escalation order and frozen", () => {
		expect(ENTER_ENCODINGS).toEqual(["\r", "\n", "\r\n"]);
		expect(Object.isFrozen(ENTER_ENCODINGS)).toBe(true);
	});

	test("rejects a non-string prompt (caller bug, fail loud)", async () => {
		const h = harness(["turnlog"]);
		await expect(submitTurn({ ...h, text: undefined })).rejects.toThrow(
			/text must be a string/,
		);
	});
});
