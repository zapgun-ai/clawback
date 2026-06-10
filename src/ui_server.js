import fs from "node:fs";
import path from "node:path";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

export function createUiServer({ logger } = {}) {
	const uiDir = new URL("./ui/", import.meta.url);
	const assets = new Map();

	function loadRecursive(dir, base = "") {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			logger?.warn(`ui asset load failed: ${e.message}`);
			return;
		}
		for (const entry of entries) {
			const rel = base + entry.name;
			const full = new URL(
				`./${entry.name}${entry.isDirectory() ? "/" : ""}`,
				dir,
			);
			if (entry.isDirectory()) {
				loadRecursive(full, `${rel}/`);
			} else {
				const ext = path.extname(entry.name).toLowerCase();
				const contentType = MIME[ext] ?? "application/octet-stream";
				const content = fs.readFileSync(full);
				assets.set(rel, { content, contentType });
			}
		}
	}

	loadRecursive(uiDir);

	return {
		assetCount: assets.size,
		handle(req, res, subPath) {
			let key = subPath || "index.html";
			if (key.endsWith("/")) key += "index.html";
			if (!assets.has(key)) key = "index.html";
			const asset = assets.get(key);
			if (!asset) {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("UI assets not installed");
				return;
			}
			res.writeHead(200, {
				"content-type": asset.contentType,
				"cache-control": "no-cache",
			});
			res.end(asset.content);
		},
	};
}
