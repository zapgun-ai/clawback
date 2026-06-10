/**
 * Submit one turn into a Claude Code PTY and confirm it actually landed.
 *
 * THE BUG THIS DEFENDS AGAINST
 * ----------------------------
 * The naive way to drive the PTY is `pty.write(`${prompt}\r`)` — prompt text
 * and the Enter carriage-return in a SINGLE write. Empirically (Haiku L2 run,
 * 2026-05-30) that submits only ~2 of 8 turns: Claude Code boots with
 * bracketed-paste (`ESC[?2004h`) and the enhanced keyboard protocol
 * (`ESC[>1u`), and a bulk write ending in CR gets coalesced through the paste
 * path — the trailing `\r` lands INSIDE the input box as a newline instead of
 * registering as Enter. The box then sits at "turn 0%" and the driver's
 * settle-on-silence heuristic cannot tell "claude finished" from "claude never
 * started."
 *
 * THE FIX
 * -------
 * 1. Type the prompt text with NO trailing Enter.
 * 2. Pause, so claude processes the text as typed input (not a paste blob).
 * 3. Send Enter as its OWN keystroke.
 * 4. CONFIRM the turn landed before moving on — escalate the Enter encoding
 *    (`\r` → `\n` → `\r\n`) and retry only if confirmation never arrives.
 *
 * `\r` is the byte a real Enter keypress sends into a PTY slave in raw mode,
 * so it is tried FIRST; `\n` and `\r\n` are fallbacks for TUI builds that read
 * Enter differently. We do not hard-code a winner — the confirmation signal
 * decides, and the run logs which encoding worked.
 *
 * PURITY / TESTABILITY
 * --------------------
 * All I/O is injected (`write`, `confirm`, `sleep`), so this is unit-testable
 * with fakes and never touches a real PTY or proxy. The driver
 * (benchmark/bin/drive_pty.js) supplies the real implementations; `confirm`
 * there adjudicates on the proxy's --turn-log (authoritative: a new non-ping
 * /v1/messages record) OR sustained PTY output (claude visibly started),
 * escalating only when BOTH stay silent — the exact signature of a no-op
 * Enter.
 */

// Enter encodings tried in order. `\r` (real keypress byte) first; `\n` and
// `\r\n` are fallbacks. Frozen so callers can read but not mutate the order.
export const ENTER_ENCODINGS = Object.freeze(["\r", "\n", "\r\n"]);

/**
 * @typedef {Object} SubmitResult
 * @property {boolean} confirmed  whether the turn was confirmed landed
 * @property {string|null} encoding  the Enter encoding that worked (or null)
 * @property {string|null} how  confirmation source the driver reported
 *   (e.g. "turnlog" | "pty"), or null if never confirmed
 * @property {number} attempts  how many Enter keystrokes were sent
 */

/**
 * Type a prompt and submit it, confirming the turn landed.
 *
 * @param {Object} a
 * @param {(s: string) => void} a.write  write bytes into the PTY master
 * @param {() => Promise<string|null>} a.confirm  resolve a truthy source label
 *   if the turn landed within the driver's confirmation window, else null
 *   (→ escalate). MUST NOT resolve truthy unless claude genuinely reacted —
 *   a false positive here means a real submit failure goes unretried.
 * @param {(ms: number) => Promise<void>} a.sleep  async sleep (injected)
 * @param {string} a.text  the prompt text (NO trailing Enter)
 * @param {Object} [a.opts]
 * @param {number} [a.opts.typePauseMs=250]  pause after text before first Enter
 * @param {number} [a.opts.interEnterMs=0]  pause between escalation keystrokes
 * @param {number} [a.opts.maxRounds=2]  times to cycle the whole encoding list
 * @param {readonly string[]} [a.opts.encodings=ENTER_ENCODINGS]  Enter bytes
 * @param {(s: string) => void} [a.opts.log]  progress logger
 * @returns {Promise<SubmitResult>}
 */
export async function submitTurn({ write, confirm, sleep, text, opts = {} }) {
	if (typeof write !== "function")
		throw new TypeError("write must be a function");
	if (typeof confirm !== "function")
		throw new TypeError("confirm must be a function");
	if (typeof sleep !== "function")
		throw new TypeError("sleep must be a function");
	if (typeof text !== "string") throw new TypeError("text must be a string");

	const {
		typePauseMs = 250,
		interEnterMs = 0,
		maxRounds = 2,
		encodings = ENTER_ENCODINGS,
		log = () => {},
	} = opts;

	if (!Array.isArray(encodings) || encodings.length === 0)
		throw new Error("encodings must be a non-empty array");

	// 1. Type the prompt WITHOUT an Enter. Separating text from the submit
	//    keystroke is the whole fix — a combined `${text}\r` write gets
	//    coalesced and the CR never registers as Enter.
	write(text);
	await sleep(typePauseMs);

	// 2. Send Enter as its own keystroke and CONFIRM. Escalate the encoding
	//    only when confirmation never arrives (a genuine no-op Enter).
	let attempts = 0;
	for (let round = 0; round < maxRounds; round++) {
		for (const enc of encodings) {
			attempts++;
			if (attempts > 1 && interEnterMs > 0) await sleep(interEnterMs);
			write(enc);
			log(`enter#${attempts} ${JSON.stringify(enc)}`);
			const how = await confirm();
			if (how) return { confirmed: true, encoding: enc, how, attempts };
		}
	}
	return { confirmed: false, encoding: null, how: null, attempts };
}
