import fs from "node:fs";
import path from "node:path";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

// A run id (the subdir name) or a chart filename. Letters, digits, dot,
// underscore, dash only — no slash and no "..", so a crafted `?run=` or
// chart segment can't escape the report dir. This is the first of two
// guards; resolveInside is the belt to this suspenders.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// First path segment under /<prefix>/report/ that names a dynamic route
// rather than a static asset. Everything else falls through to the
// in-memory asset map (report.js / report.css / index.html).
const RESERVED = new Set(["runs", "data", "chart", "csv"]);

// The only files inside a run dir the viewer will ever serve. A run dir
// also holds proxy.*.log and raw turns.*.ndjson — those are NOT in this
// allowlist and so are unreachable, which matters because the endpoint is
// served fully public (no token). Path-traversal guards are defense in
// depth on top of this allowlist, not the primary control.
const SERVE_SUMMARY = "summary.json";
const SERVE_MANIFEST = "manifest.json";
const SERVE_REPORT_MD = "report.md";
const SERVE_CSV = "report.csv";
const CHARTS_SUBDIR = "charts";

function isSafeName(name) {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name !== "." &&
		name !== ".." &&
		SAFE_NAME.test(name)
	);
}

// Resolve rootAbs/<segs...> and confirm the result stays inside rootAbs.
// Returns the absolute path, or null if it would escape. rootAbs must
// already be absolute. Even if SAFE_NAME is ever loosened, a path that
// resolves outside the run root is rejected here.
function resolveInside(rootAbs, ...segs) {
	const p = path.resolve(rootAbs, ...segs);
	if (p !== rootAbs && !p.startsWith(rootAbs + path.sep)) return null;
	return p;
}

function readJson(fp) {
	try {
		return JSON.parse(fs.readFileSync(fp, "utf8"));
	} catch {
		return null;
	}
}

function readText(fp) {
	try {
		return fs.readFileSync(fp, "utf8");
	} catch {
		return null;
	}
}

function readBuffer(fp) {
	try {
		return fs.readFileSync(fp);
	} catch {
		return null;
	}
}

// Enumerate completed runs newest-first. A subdir counts as a run only if
// it holds a parseable summary.json (so half-written or aborted runs are
// skipped). Sort key is the analyzer's generatedAt when present, else the
// summary file mtime — both monotonic with run completion.
function listRuns(rootAbs, logger) {
	let entries;
	try {
		entries = fs.readdirSync(rootAbs, { withFileTypes: true });
	} catch (e) {
		logger?.debug?.(`report: reportDir unreadable (${rootAbs}): ${e.message}`);
		return [];
	}
	const runs = [];
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		if (!isSafeName(ent.name)) continue;
		const dir = path.join(rootAbs, ent.name);
		const summaryPath = path.join(dir, SERVE_SUMMARY);
		const summary = readJson(summaryPath);
		if (!summary) continue;
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(summaryPath).mtimeMs;
		} catch {}
		runs.push({
			id: ent.name,
			generatedAt: summary.generatedAt ?? null,
			nTurns: summary.nTurns ?? null,
			nPings: summary.nPings ?? null,
			pricingHash: summary.pricingHash ?? null,
			clawbackVersions: summary.clawbackVersions ?? [],
			mtimeMs,
		});
	}
	runs.sort((a, b) => {
		const ta = Date.parse(a.generatedAt ?? "") || a.mtimeMs;
		const tb = Date.parse(b.generatedAt ?? "") || b.mtimeMs;
		return tb - ta;
	});
	return runs;
}

function listCharts(dir) {
	const chartsDir = path.join(dir, CHARTS_SUBDIR);
	let entries;
	try {
		entries = fs.readdirSync(chartsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".svg") && isSafeName(e.name))
		.map((e) => e.name)
		.sort();
}

/**
 * The /<adminPathPrefix>/report saved-run viewer. A read-only, fully-public
 * (no-token) GUI that renders completed benchmark runs written by
 * benchmark/bin/analyze.js + plot.js into config.reportDir. It never
 * computes cost — it renders what the analyzer already priced.
 *
 * Mounted by handleAdmin, which strips the `/<prefix>/report` prefix and
 * passes the remaining segments as `sub`. The dynamic prefix is injected
 * into index.html as `__BASE__` at serve time, so the page is independent
 * of whatever admin-path the operator chose (no hardcoded "/_proxy/").
 */
export function createReportServer({ logger, config } = {}) {
	const uiDir = new URL("./report_ui/", import.meta.url);
	const assets = new Map();

	function loadRecursive(dir, base = "") {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			logger?.warn?.(`report ui asset load failed: ${e.message}`);
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
				assets.set(rel, { content: fs.readFileSync(full), contentType });
			}
		}
	}

	loadRecursive(uiDir);

	return {
		assetCount: assets.size,
		handle(req, res, sub, ctx = {}) {
			const cfg = ctx.config ?? config ?? {};
			const reportDirAbs = path.resolve(cfg.reportDir ?? "runs");
			const prefix = cfg.adminPathPrefix ?? "_proxy";
			const base = `/${prefix}/report`;
			const segs = (Array.isArray(sub) ? sub : []).filter((s) => s.length > 0);
			const head = segs[0];

			const json = (status, body) => {
				if (res.headersSent) return;
				res.writeHead(status, {
					"content-type": MIME[".json"],
					"cache-control": "no-cache",
				});
				res.end(JSON.stringify(body, null, 2));
			};
			const notFound = (msg = "not_found") => json(404, { error: msg });

			// Dynamic routes first; their first segment is reserved so a run
			// can never be named "runs"/"data"/"chart"/"csv" and shadow them.
			if (head === "runs") {
				return json(200, { runs: listRuns(reportDirAbs, logger) });
			}

			if (head === "data") {
				const id = new URL(req.url, "http://localhost").searchParams.get("run");
				if (!isSafeName(id)) return json(400, { error: "bad_run_id" });
				const dir = resolveInside(reportDirAbs, id);
				if (!dir) return json(400, { error: "bad_run_id" });
				const summary = readJson(path.join(dir, SERVE_SUMMARY));
				if (!summary) return notFound("run_not_found");
				let csvBytes = null;
				try {
					csvBytes = fs.statSync(path.join(dir, SERVE_CSV)).size;
				} catch {}
				return json(200, {
					id,
					summary,
					manifest: readJson(path.join(dir, SERVE_MANIFEST)),
					reportMarkdown: readText(path.join(dir, SERVE_REPORT_MD)),
					charts: listCharts(dir),
					csvBytes,
				});
			}

			if (head === "chart") {
				const id = segs[1];
				const file = segs[2];
				if (!isSafeName(id) || !isSafeName(file) || !file.endsWith(".svg")) {
					return notFound();
				}
				const fp = resolveInside(reportDirAbs, id, CHARTS_SUBDIR, file);
				if (!fp) return notFound();
				const buf = readBuffer(fp);
				if (!buf) return notFound("chart_not_found");
				res.writeHead(200, {
					"content-type": MIME[".svg"],
					"cache-control": "no-cache",
				});
				return res.end(buf);
			}

			if (head === "csv") {
				const id = segs[1];
				if (!isSafeName(id)) return notFound();
				const fp = resolveInside(reportDirAbs, id, SERVE_CSV);
				if (!fp) return notFound();
				const buf = readBuffer(fp);
				if (!buf) return notFound("csv_not_found");
				res.writeHead(200, {
					"content-type": "text/csv; charset=utf-8",
					"cache-control": "no-cache",
					"content-disposition": `attachment; filename="${id}-report.csv"`,
				});
				return res.end(buf);
			}

			// A reserved word with no valid trailing segments fell through
			// above (already 4xx'd); anything else is a static asset request.
			// The empty path serves index.html with the dynamic base injected.
			if (segs.length === 0) {
				const asset = assets.get("index.html");
				if (!asset) {
					res.writeHead(404, { "content-type": "text/plain" });
					return res.end("report UI not installed");
				}
				const html = asset.content
					.toString("utf8")
					.replaceAll("__BASE__", base);
				res.writeHead(200, {
					"content-type": MIME[".html"],
					"cache-control": "no-cache",
				});
				return res.end(html);
			}

			const key = segs.join("/");
			const asset = assets.get(key);
			if (asset) {
				let body = asset.content;
				if (key.endsWith(".html")) {
					body = Buffer.from(
						asset.content.toString("utf8").replaceAll("__BASE__", base),
					);
				}
				res.writeHead(200, {
					"content-type": asset.contentType,
					"cache-control": "no-cache",
				});
				return res.end(body);
			}

			return notFound();
		},
	};
}
