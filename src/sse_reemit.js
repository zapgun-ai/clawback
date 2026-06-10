/**
 * Re-emit Anthropic's non-streamed `/v1/messages` JSON response as the
 * SSE event sequence Claude Code expects when it set `"stream": true`.
 *
 * Mobile mode (PLAN §24 sub-feature) rewrites `stream: true` → `false`
 * on the way out so Anthropic returns a single JSON payload — better
 * for radio battery and gzip compression. The client (Claude Code)
 * still asked for SSE though, so we translate back here.
 *
 * Event order mirrors what Anthropic sends in real streamed responses:
 *
 *   message_start
 *   for each content block in order:
 *     content_block_start
 *     content_block_delta   (one delta containing the full block payload)
 *     content_block_stop
 *   message_delta            (carries top-level usage + stop_reason)
 *   message_stop
 *
 * Kept text-only and tool_use-aware for v1; thinking blocks and other
 * shapes pass through as-is in the `content_block_start` payload, with
 * an empty delta — claude renders the start payload directly in that
 * case, so we don't need to fabricate delta shapes we can't validate.
 */

export function jsonToSseEvents(message) {
	if (!message || typeof message !== "object") {
		throw new Error("jsonToSseEvents: message must be an object");
	}

	const lines = [];
	const push = (event, data) => {
		lines.push(`event: ${event}`);
		lines.push(`data: ${JSON.stringify(data)}`);
		lines.push("");
		lines.push("");
	};

	// message_start: a copy of the message with `content: []` and a
	// trimmed `usage` (real streams emit usage at start with input
	// tokens, then again at end with output).
	const startUsage = message.usage
		? {
				input_tokens: message.usage.input_tokens ?? 0,
				cache_creation_input_tokens:
					message.usage.cache_creation_input_tokens ?? 0,
				cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
				output_tokens: 0,
			}
		: undefined;
	const startMessage = {
		id: message.id,
		type: message.type ?? "message",
		role: message.role ?? "assistant",
		model: message.model,
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: startUsage,
	};
	push("message_start", { type: "message_start", message: startMessage });

	const contentBlocks = Array.isArray(message.content) ? message.content : [];
	for (let i = 0; i < contentBlocks.length; i++) {
		const block = contentBlocks[i];
		emitBlock(push, i, block);
	}

	// message_delta: carries stop_reason, stop_sequence, and the final
	// usage delta (output_tokens).
	push("message_delta", {
		type: "message_delta",
		delta: {
			stop_reason: message.stop_reason ?? "end_turn",
			stop_sequence: message.stop_sequence ?? null,
		},
		usage: { output_tokens: message.usage?.output_tokens ?? 0 },
	});

	push("message_stop", { type: "message_stop" });

	return lines.join("\n");
}

function emitBlock(push, index, block) {
	if (!block || typeof block !== "object") return;

	if (block.type === "text") {
		push("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { type: "text", text: "" },
		});
		push("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: { type: "text_delta", text: block.text ?? "" },
		});
		push("content_block_stop", { type: "content_block_stop", index });
		return;
	}

	if (block.type === "tool_use") {
		push("content_block_start", {
			type: "content_block_start",
			index,
			content_block: {
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: {},
			},
		});
		push("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: {
				type: "input_json_delta",
				partial_json: JSON.stringify(block.input ?? {}),
			},
		});
		push("content_block_stop", { type: "content_block_stop", index });
		return;
	}

	// Unknown block shape (thinking, server_tool_use, etc.). Emit it
	// whole in content_block_start so the client can at least parse it,
	// then a no-op delta + stop. Avoids fabricating a delta shape we
	// don't have a fixture for.
	push("content_block_start", {
		type: "content_block_start",
		index,
		content_block: block,
	});
	push("content_block_stop", { type: "content_block_stop", index });
}
