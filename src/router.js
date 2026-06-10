import crypto from "node:crypto";
import { canonicalize } from "./canonicalize.js";

const DEFAULT_ADMIN_PATH_PREFIX = "_proxy";

export function identifySession({
	url,
	body,
	adminPathPrefix = DEFAULT_ADMIN_PATH_PREFIX,
}) {
	const reserved = new Set(["v1", adminPathPrefix]);
	const parsed = new URL(url, "http://localhost");
	const pathname = parsed.pathname;
	const search = parsed.search;

	const pathMatch = pathname.match(/^\/([^/]+)(\/v1\/.+)$/);
	if (pathMatch) {
		const agentId = pathMatch[1];
		const rest = pathMatch[2];
		if (!reserved.has(agentId) && !agentId.startsWith("_")) {
			return {
				mode: "path",
				key: agentId,
				forwardPath: rest + search,
			};
		}
	}

	if (pathname === "/v1/messages" && body && typeof body === "object") {
		const system = body.system ?? null;
		const tools = body.tools ?? null;
		const hashInput = canonicalize({ system, tools });
		const key = crypto.createHash("sha256").update(hashInput).digest("hex");
		return {
			mode: "hash",
			key,
			forwardPath: pathname + search,
		};
	}

	return null;
}
