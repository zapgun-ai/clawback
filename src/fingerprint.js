import crypto from "node:crypto";
import { canonicalize } from "./canonicalize.js";

export const STRIP_PATTERNS = [
	{
		name: "today-date-sentence",
		regex: /Today['’]s date is[^.\n<]*/g,
		replacement: "Today's date is <DATE>",
	},
	{
		name: "iso-date",
		regex: /\b\d{4}-\d{2}-\d{2}\b/g,
		replacement: "<DATE>",
	},
	{
		name: "env-block",
		regex: /<env>[\s\S]*?<\/env>/g,
		replacement: "<env><STRIPPED></env>",
	},
	{
		// Claude Code injects a `x-anthropic-billing-header` line as the first
		// `system` block, of the form
		//     x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=<hex>;
		// where `cch` rotates per request. cc_version / cc_entrypoint are
		// stable for one operator's setup so we leave them alone — they're
		// load-bearing for "different Claude Code versions are different
		// caches." Only `cch` is the per-request token that fragments
		// SESSION KEY and ANTHROPIC KEY.
		name: "billing-cch",
		regex: /cch=[0-9a-f]+/gi,
		replacement: "cch=<CCH>",
	},
];

export function computeFingerprints({ system, tools }) {
	const toolsCanonical = canonicalize(tools ?? null);
	const toolsKey = sha256(toolsCanonical);

	const { stripped, removed } = stripEphemeral(system);
	const stableCanonical = canonicalize({
		system: stripped,
		tools: tools ?? null,
	});
	const systemStableKey = sha256(stableCanonical);

	return {
		toolsKey,
		systemStableKey,
		strippedSystemPreview: summarizeRemoved(removed),
	};
}

export function stripEphemeral(system) {
	if (system == null) return { stripped: null, removed: [] };
	if (typeof system === "string") return stripString(system);

	if (Array.isArray(system)) {
		const removedAll = [];
		const stripped = system.map((block) => {
			if (
				block &&
				typeof block === "object" &&
				typeof block.text === "string"
			) {
				const { stripped: text, removed } = stripString(block.text);
				removedAll.push(...removed);
				return { ...block, text };
			}
			return block;
		});
		return { stripped, removed: removedAll };
	}

	return { stripped: system, removed: [] };
}

function stripString(text) {
	const removed = [];
	let out = text;
	for (const pattern of STRIP_PATTERNS) {
		out = out.replace(pattern.regex, (match) => {
			removed.push({ pattern: pattern.name, value: match });
			return pattern.replacement;
		});
	}
	return { stripped: out, removed };
}

function summarizeRemoved(removed) {
	const counts = {};
	const samples = {};
	for (const r of removed) {
		counts[r.pattern] = (counts[r.pattern] ?? 0) + 1;
		if (!samples[r.pattern]) {
			samples[r.pattern] =
				r.value.length > 120 ? `${r.value.slice(0, 117)}...` : r.value;
		}
	}
	return Object.keys(counts)
		.sort()
		.map((name) => ({
			pattern: name,
			count: counts[name],
			sample: samples[name],
		}));
}

function sha256(s) {
	return crypto.createHash("sha256").update(s).digest("hex");
}
