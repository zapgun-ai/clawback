// Saved-run viewer client. Served under /<adminPathPrefix>/report/ with a
// <base href> injected by the server, so every fetch below is relative and
// prefix-independent. Everything rendered here comes from the report dir (run
// ids, summary fields) and is treated as untrusted: text goes in via
// textContent, the share card loads as a sandboxed <img> built from a self-
// contained data: URL (no inline SVG, no innerHTML with data).
//
// One story, on purpose: how many full-rate ("billable") input tokens clawback
// keeps off your bill vs passthrough. The page centerpiece is the share card
// itself — the same 1200×630 image you'd post — rendered as a clickable image.
// Clicking it is the deliberate opt-in gesture: it opens the consent chooser
// (the default posture is silent — nothing leaves the machine until you pick a
// tier), then downloads only, or publishes to the share host and posts to X. The
// card bakes its own honest context (the signed reclaim gloss, as a framed
// callout) and the cumulative-token graph behind the text, so there's no
// separate on-page caption to drift from it: what you see is exactly what you'd
// share.

import {
	OG_ENDPOINT,
	bragText,
	bskyIntentUrl,
	buildSharePayload,
	cardFilename,
	cardPageUrl,
	deriveHeroModel,
	extractBgShapes,
	shareCardSvg,
	svgToPngBlob,
	telegramIntentUrl,
	whatsappIntentUrl,
	xIntentUrl,
} from "./share_card.js";

const $ = (id) => document.getElementById(id);
const runSelect = $("runSelect");
const reportMain = $("reportMain");
const emptyState = $("emptyState");

function show(node, visible) {
	node.classList.toggle("hidden", !visible);
}

async function fetchJson(path) {
	const res = await fetch(path, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`${path} → ${res.status}`);
	return res.json();
}

function clearChildren(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

// The bare chart filename plot.js writes alongside the labeled one: a 1200×630
// SVG with just the two cumulative-token curves and the filled wedge, on the
// same dark field as the card. We splice its shapes behind the card text.
const BG_CHART = "tokens_saved.bg.svg";

// Fetch the bare chart for this run and pull out just its plotted shapes
// (polygon/path) to paint behind the card text. Best-effort: a run with no bare
// chart (charts list omits it, or the fetch fails) just yields "", so the card
// falls back to its solid field. Never throws — a missing graph must not break
// the card.
async function loadBgShapes(runId, charts) {
	if (!Array.isArray(charts) || !charts.includes(BG_CHART)) return "";
	try {
		const res = await fetch(`chart/${encodeURIComponent(runId)}/${BG_CHART}`);
		if (!res.ok) return "";
		return extractBgShapes(await res.text());
	} catch {
		return "";
	}
}

// Paint the share card as the page centerpiece: the exact SVG that rasterizes to
// the shared PNG, shown inline as a clickable <img>. The whole image is the
// share/save control (wired in setupShare to open the consent chooser). A self-
// contained data: URL (never a remote path) keeps the source inert and lets the
// same image rasterize to PNG later without tainting the canvas.
//
// Two accessible-name layers, on purpose: the <img> alt is the brag (so the
// picture has a description when an AT user navigates to it as an image), while
// the button's aria-label leads with the action ("Share or save … — <brag>") so
// focusing the control announces what it DOES, not just what it shows. The
// aria-label shadows the img alt in the button's name computation, so there is no
// double-announcement on focus.
function renderCard(model) {
	const svg = shareCardSvg(model);
	const brag = bragText(model);
	const img = $("shareCardImg");
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	img.alt = brag;
	const link = $("shareCardLink");
	if (link) {
		// Clicking the card is the opt-in gesture: it opens the sharing chooser (or
		// acts on a remembered tier), and "Download only" lives inside it — so the
		// action name leads with "Share or save", not "Download".
		link.setAttribute("aria-label", `Share or save this result — ${brag}`);
	}
}

async function loadRun(id) {
	if (!id) return;
	let data;
	try {
		data = await fetchJson(`data?run=${encodeURIComponent(id)}`);
	} catch (e) {
		emptyState.querySelector("p").textContent =
			`Failed to load run "${id}": ${e.message}`;
		show(emptyState, true);
		show(reportMain, false);
		return;
	}
	const summary = data.summary ?? {};
	const runId = data.id ?? id;
	// Provenance for the public ("full") share tier only — lets a future
	// leaderboard bucket by run shape + clawback version. Never sent on the
	// minimal/local tiers (buildSharePayload drops it).
	currentRun = {
		nTurns: summary.nTurns,
		nPings: summary.nPings,
		clawbackVersions: summary.clawbackVersions,
		pricingHash: summary.pricingHash,
	};
	// deriveHeroModel is the single source of truth for every figure the card
	// shows; we then splice in this run's cumulative-token graph (best-effort) so
	// the downloaded/shared PNG carries the visual story too. currentHero drives
	// both the on-screen card and the share/download path, so they can't drift.
	const model = deriveHeroModel(summary);
	model.bgShapes = await loadBgShapes(runId, data.charts);
	currentHero = model;
	renderCard(currentHero);
	const dl = $("csvDownload");
	dl.href = `csv/${encodeURIComponent(runId)}`;
	dl.setAttribute("download", `${runId}-report.csv`);
	show(dl, data.csvBytes != null);
	show(emptyState, false);
	show(reportMain, true);
	if (location.hash.slice(1) !== `run=${id}`) {
		history.replaceState(null, "", `#run=${encodeURIComponent(id)}`);
	}
}

function selectedFromHash(runs) {
	const m = location.hash.match(/^#run=(.+)$/);
	if (m) {
		const want = decodeURIComponent(m[1]);
		if (runs.some((r) => r.id === want)) return want;
	}
	return runs[0]?.id ?? null;
}

async function loadRuns() {
	let payload;
	try {
		payload = await fetchJson("runs");
	} catch (e) {
		emptyState.querySelector("p").textContent =
			`Failed to list runs: ${e.message}`;
		show(emptyState, true);
		show(reportMain, false);
		return;
	}
	const runs = payload.runs ?? [];
	clearChildren(runSelect);
	for (const r of runs) {
		const opt = document.createElement("option");
		opt.value = r.id;
		const when = r.generatedAt
			? r.generatedAt.replace("T", " ").replace(/\..*$/, "")
			: "";
		opt.textContent = `${r.id}${when ? ` · ${when}` : ""}${r.nTurns != null ? ` · ${r.nTurns} turns` : ""}`;
		runSelect.appendChild(opt);
	}
	if (runs.length === 0) {
		show(emptyState, true);
		show(reportMain, false);
		return;
	}
	const pick = selectedFromHash(runs);
	runSelect.value = pick;
	await loadRun(pick);
}

// ---- share / build-in-public ----
//
// The headline figure is the shareable artifact: a 1200×630 PNG composed
// client-side (see share_card.js) that the operator can download, hand to the
// device share sheet (with the image attached), or post to X / Bluesky as text.
//
// Posting the actual PICTURE (so a tweet unfurls the image) needs a public host:
// the user POSTs structured data to og.clawback.md, which renders + stores the
// card and hands back a URL we put in the post. That egress is OPT-IN by a
// deliberate gesture (clicking the card) and gated behind the consent chooser
// below — default posture is silent, nothing leaves the machine.

// The model behind the on-screen card, kept in sync by loadRun so the share
// image always matches what's displayed.
let currentHero = null;

// This run's provenance (run shape + clawback version), captured by loadRun.
// Sent only on the public ("full") share tier, for leaderboard bucketing.
let currentRun = null;

// Async share/download can fail (or be dismissed); announce the outcome to a
// polite live region rather than failing silently or alert()-ing.
function announceShare(msg) {
	const el = $("shareStatus");
	if (el) el.textContent = msg;
}

// Render the current hero as a PNG Blob (+ a File for the share sheet). Rejects
// if no run is loaded or the browser can't rasterize the card.
async function renderShareImage() {
	if (!currentHero) throw new Error("no run loaded");
	const blob = await svgToPngBlob(shareCardSvg(currentHero));
	const name = cardFilename(currentHero);
	const file =
		typeof File === "function"
			? new File([blob], name, { type: "image/png" })
			: null;
	return { blob, file, name };
}

// `note` lets a fallback caller (e.g. the share host was unreachable) prepend the
// reason, so the final status keeps it instead of being silently overwritten by
// the plain "Saved …" line.
async function onDownloadCard({ note } = {}) {
	announceShare(
		note ? `${note} Saving the PNG instead…` : "Rendering share image…",
	);
	try {
		const { blob, name } = await renderShareImage();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		// Revoke on the next tick so the download has a chance to start first.
		setTimeout(() => URL.revokeObjectURL(url), 0);
		announceShare(note ? `${note} Saved ${name}.` : `Saved ${name}.`);
	} catch (e) {
		announceShare(`Could not render the share image: ${e.message}`);
	}
}

async function onShareNative() {
	announceShare("Preparing to share…");
	try {
		const { file } = await renderShareImage();
		const text = bragText(currentHero);
		const shareData = { text };
		// Attach the PNG only if the device's share sheet accepts files.
		if (file && navigator.canShare?.({ files: [file] })) {
			shareData.files = [file];
		}
		if (typeof navigator.share !== "function") {
			announceShare(
				"This browser can't open the share sheet — use Download, or the X / Bluesky buttons.",
			);
			return;
		}
		await navigator.share(shareData);
		announceShare("Shared.");
	} catch (e) {
		// AbortError = the user dismissed the sheet; that's not a failure.
		if (e?.name === "AbortError") return;
		announceShare(`Share failed: ${e.message}`);
	}
}

function openIntent(url) {
	window.open(url, "_blank", "noopener,noreferrer");
}

// ---- consent chooser + publish to the share host ----
//
// Default posture is SILENT: nothing is uploaded until the user picks a tier.
// Clicking the card (the deliberate opt-in gesture) opens the chooser the first
// time; the pick is remembered so a later click acts directly, and "sharing…"
// reopens it to change or withdraw. "local" only downloads — it never contacts
// the host. We persist the pick in localStorage (a per-browser convenience);
// when og.clawback.md ships, a config-injected default can seed it.

const TIER_KEY = "clawback.share.tier";
const HANDLE_KEY = "clawback.share.handle";

function readStore(key, fallback = null) {
	try {
		return window.localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}
function writeStore(key, val) {
	try {
		if (val) window.localStorage.setItem(key, val);
		else window.localStorage.removeItem(key);
	} catch {
		/* storage disabled (private mode) — just don't remember */
	}
}
function rememberedTier() {
	const t = readStore(TIER_KEY);
	return t === "local" || t === "minimal" || t === "full" ? t : null;
}

// The element focused before the dialog opened, restored on close (WCAG 2.4.3).
let dialogReturnFocus = null;

// Focusable controls inside the dialog, skipping anything in a hidden subtree
// (e.g. the handle row when the tier isn't "full"). offsetParent is unreliable
// under jsdom, so we filter by the .hidden class instead of computed layout.
function dialogFocusables() {
	const root = $("shareDialog");
	if (!root) return [];
	return Array.from(
		root.querySelectorAll(
			'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
		),
	).filter((el) => !el.closest(".hidden"));
}

function selectedTier() {
	const checked = $("shareDialog")?.querySelector(
		'input[name="shareTier"]:checked',
	);
	return checked ? checked.value : null;
}

// The handle field is only meaningful for the public tier; reveal it there.
function syncHandleRow() {
	const row = $("shareHandleRow");
	if (row) show(row, selectedTier() === "full");
}

function openChooser() {
	const backdrop = $("shareDialogBackdrop");
	if (!backdrop) return;
	dialogReturnFocus = document.activeElement;
	// Reflect the remembered choice (or the safe "local" default) so the dialog
	// opens on a conscious selection — but the user must still confirm before
	// anything leaves the machine.
	const tier = rememberedTier() ?? "local";
	const radio = $("shareDialog")?.querySelector(
		`input[name="shareTier"][value="${tier}"]`,
	);
	if (radio) radio.checked = true;
	const handleInput = $("shareHandleInput");
	if (handleInput) handleInput.value = readStore(HANDLE_KEY, "") ?? "";
	syncHandleRow();
	show(backdrop, true);
	dialogFocusables()[0]?.focus();
}

function closeChooser({ restoreFocus = true } = {}) {
	const backdrop = $("shareDialogBackdrop");
	if (!backdrop) return;
	show(backdrop, false);
	if (restoreFocus && typeof dialogReturnFocus?.focus === "function") {
		dialogReturnFocus.focus();
	}
	dialogReturnFocus = null;
}

// Trap Tab within the dialog and let Escape cancel it (WCAG 2.1.2 / 2.4.3).
function onDialogKeydown(e) {
	if (e.key === "Escape") {
		e.preventDefault();
		closeChooser();
		return;
	}
	if (e.key !== "Tab") return;
	const f = dialogFocusables();
	if (f.length === 0) return;
	const first = f[0];
	const last = f[f.length - 1];
	if (e.shiftKey && document.activeElement === first) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && document.activeElement === last) {
		e.preventDefault();
		first.focus();
	}
}

function onChooserConfirm(e) {
	e?.preventDefault();
	const tier = selectedTier() ?? "local";
	writeStore(TIER_KEY, tier);
	if (tier === "full") {
		writeStore(HANDLE_KEY, ($("shareHandleInput")?.value ?? "").trim());
	}
	closeChooser();
	performShare(tier);
}

// Clicking the card: act on a remembered tier, else open the chooser. The
// resting default (no remembered tier) is silent — this gesture is what opts in.
function onCardActivate() {
	const t = rememberedTier();
	if (t) performShare(t);
	else openChooser();
}

function performShare(tier) {
	if (tier === "local") return onDownloadCard();
	return uploadAndShare(tier);
}

// POST the tier-filtered structured data to the share host, then open X carrying
// the brag + the returned public image URL. The host is built/deployed
// elsewhere; if it's unreachable we fall back to a local download so the user
// still gets their card, and say so plainly.
async function uploadAndShare(tier) {
	if (!currentHero) {
		announceShare("No run loaded yet.");
		return;
	}
	const handle = tier === "full" ? (readStore(HANDLE_KEY, "") ?? "") : "";
	const run = tier === "full" ? currentRun : null;
	const payload = buildSharePayload(currentHero, { tier, handle, run });
	if (!payload) {
		announceShare("Nothing to publish.");
		return;
	}
	announceShare("Publishing your card…");
	let resp;
	try {
		// credentials omitted: the post is anonymous — no cookies ride along.
		const r = await fetch(OG_ENDPOINT, {
			method: "POST",
			mode: "cors",
			credentials: "omit",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!r.ok) throw new Error(`share host → ${r.status}`);
		resp = await r.json();
	} catch (e) {
		return onDownloadCard({
			note: `Couldn't reach the share host (${e.message}).`,
		});
	}
	// Post the card's PAGE URL (not the raw image): og.clawback.md serves it with
	// OpenGraph/Twitter-card meta whose og:image points at the rendered PNG, so the
	// social unfurl is a rich, owned funnel surface instead of a bare image hotlink.
	const pageUrl = cardPageUrl(resp, OG_ENDPOINT);
	if (!pageUrl) {
		return onDownloadCard({
			note: "The share host returned no card link.",
		});
	}
	openIntent(xIntentUrl(bragText(currentHero), pageUrl));
	announceShare(
		tier === "full"
			? "Published your public card — opening X to post it."
			: "Published an unlisted card — opening X to post it.",
	);
}

function setupShare() {
	// The native share sheet is mostly mobile; feature-detect and hide the
	// button where it can't work rather than offer a dead control. Download and
	// the X / Bluesky intents are always available.
	const nativeBtn = $("shareNative");
	if (nativeBtn && typeof navigator.share !== "function") {
		nativeBtn.classList.add("hidden");
	}
	nativeBtn?.addEventListener("click", onShareNative);
	$("shareX")?.addEventListener("click", () =>
		openIntent(xIntentUrl(bragText(currentHero))),
	);
	$("shareBsky")?.addEventListener("click", () =>
		openIntent(bskyIntentUrl(bragText(currentHero))),
	);
	$("shareTelegram")?.addEventListener("click", () =>
		openIntent(telegramIntentUrl(bragText(currentHero))),
	);
	$("shareWhatsapp")?.addEventListener("click", () =>
		openIntent(whatsappIntentUrl(bragText(currentHero))),
	);
	$("downloadCard")?.addEventListener("click", onDownloadCard);
	// Clicking the card is the deliberate opt-in gesture: it opens the consent
	// chooser the first time, then acts on the remembered tier. "Download only"
	// lives inside the chooser, so the card no longer downloads unconditionally.
	$("shareCardLink")?.addEventListener("click", (e) => {
		e.preventDefault();
		onCardActivate();
	});
	// "sharing…" reopens the chooser to change the tier or withdraw consent.
	$("shareSettings")?.addEventListener("click", openChooser);
	$("shareDialogForm")?.addEventListener("submit", onChooserConfirm);
	$("shareDialogCancel")?.addEventListener("click", () => closeChooser());
	$("shareDialog")?.addEventListener("keydown", onDialogKeydown);
	// Clicking the backdrop (outside the dialog) cancels, like Escape.
	$("shareDialogBackdrop")?.addEventListener("click", (e) => {
		if (e.target === $("shareDialogBackdrop")) closeChooser();
	});
	// Reveal/hide the handle field as the tier selection changes.
	for (const radio of document.querySelectorAll('input[name="shareTier"]')) {
		radio.addEventListener("change", syncHandleRow);
	}
}

runSelect.addEventListener("change", () => loadRun(runSelect.value));
$("refreshBtn").addEventListener("click", () => loadRuns());
window.addEventListener("hashchange", () => {
	const m = location.hash.match(/^#run=(.+)$/);
	if (m) {
		const want = decodeURIComponent(m[1]);
		if (want !== runSelect.value) {
			runSelect.value = want;
			loadRun(want);
		}
	}
});

setupShare();
loadRuns();
