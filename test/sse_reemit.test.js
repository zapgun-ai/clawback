import { jsonToSseEvents } from "../src/sse_reemit.js";

function parseSse(text) {
	const events = [];
	const blocks = text.split("\n\n");
	for (const block of blocks) {
		if (!block.trim()) continue;
		const lines = block.split("\n");
		const event = lines
			.find((l) => l.startsWith("event: "))
			?.slice("event: ".length);
		const dataLine = lines.find((l) => l.startsWith("data: "));
		if (!event || !dataLine) continue;
		events.push({
			event,
			data: JSON.parse(dataLine.slice("data: ".length)),
		});
	}
	return events;
}

describe("jsonToSseEvents", () => {
	test("text-only response produces the canonical event sequence", () => {
		const message = {
			id: "msg_01",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-5",
			content: [{ type: "text", text: "Hello, world." }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		};
		const events = parseSse(jsonToSseEvents(message));
		expect(events.map((e) => e.event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		expect(events[0].data.message.id).toBe("msg_01");
		expect(events[0].data.message.usage.output_tokens).toBe(0);
		expect(events[1].data.content_block).toEqual({ type: "text", text: "" });
		expect(events[2].data.delta).toEqual({
			type: "text_delta",
			text: "Hello, world.",
		});
		expect(events[4].data.usage).toEqual({ output_tokens: 5 });
		expect(events[4].data.delta.stop_reason).toBe("end_turn");
	});

	test("tool_use block is re-emitted with input_json_delta", () => {
		const message = {
			id: "msg_02",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-5",
			content: [
				{
					type: "tool_use",
					id: "toolu_01",
					name: "Bash",
					input: { command: "ls -la" },
				},
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 100, output_tokens: 8 },
		};
		const events = parseSse(jsonToSseEvents(message));
		const start = events.find((e) => e.event === "content_block_start");
		const delta = events.find((e) => e.event === "content_block_delta");
		expect(start.data.content_block).toEqual({
			type: "tool_use",
			id: "toolu_01",
			name: "Bash",
			input: {},
		});
		expect(delta.data.delta.type).toBe("input_json_delta");
		expect(delta.data.delta.partial_json).toBe('{"command":"ls -la"}');
	});

	test("multiple content blocks are emitted in order with correct indices", () => {
		const message = {
			id: "msg_03",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-5",
			content: [
				{ type: "text", text: "I'll help. First, " },
				{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 50, output_tokens: 12 },
		};
		const events = parseSse(jsonToSseEvents(message));
		const starts = events.filter((e) => e.event === "content_block_start");
		expect(starts.map((e) => e.data.index)).toEqual([0, 1]);
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops.map((e) => e.data.index)).toEqual([0, 1]);
	});

	test("trailing message_stop is always present even on empty content", () => {
		const message = {
			id: "msg_04",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-5",
			content: [],
			stop_reason: "end_turn",
			usage: { input_tokens: 5, output_tokens: 0 },
		};
		const events = parseSse(jsonToSseEvents(message));
		expect(events[events.length - 1].event).toBe("message_stop");
	});

	test("message_start usage carries cache fields when present", () => {
		const message = {
			id: "msg_05",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-5",
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage: {
				input_tokens: 5,
				cache_creation_input_tokens: 1000,
				cache_read_input_tokens: 9000,
				output_tokens: 2,
			},
		};
		const events = parseSse(jsonToSseEvents(message));
		expect(events[0].data.message.usage).toEqual({
			input_tokens: 5,
			cache_creation_input_tokens: 1000,
			cache_read_input_tokens: 9000,
			output_tokens: 0,
		});
	});

	test("malformed input throws", () => {
		expect(() => jsonToSseEvents(null)).toThrow();
		expect(() => jsonToSseEvents("string")).toThrow();
	});
});
