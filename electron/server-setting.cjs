"use strict";
/**
 * Which server the desktop app uses (docs/mobile/desktop-server.md).
 *
 * Settings → General → Server: "this computer" (the app starts its own server,
 * as it always did) or the address of a server you host, in which case the app
 * starts nothing and opens that address in its window. The choice is one small
 * file in the app's data folder, read once at launch; changing it restarts the
 * app, because the window, the preload bridge and the child server all depend on it.
 *
 * Pure on purpose (no Electron import): tests load this file directly.
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE = "server.json";
/** The window argument main passes and preload.cjs reads (preload cannot import
 *  this file, so it repeats the name: tests/server-mode-preload.test.ts runs both). */
const MODE_ARGUMENT = "--lh-server=";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A host name a person could really have typed: letters, digits and hyphens in dot-separated labels of 1 to 63, at most
 *  253 in all, with at least one dot (a bare "https" or "learn" is a slip, and a server on the internet has a dotted name).
 *  This computer's names and address literals are fine as they are. */
function plausibleHost(hostname) {
	if (LOOPBACK.has(hostname) || hostname.startsWith("[")) return true;
	const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
	return name.length <= 253 && name.includes(".") && name.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/** What a person types in the Server box, as the one origin the app will open.
 *  https is required; plain http only for this computer (for trying things out).
 *  The path, query and fragment are dropped: the app always starts at the root. */
function normalizeServerAddress(input) {
	if (typeof input !== "string" || !input.trim()) return { ok: false, error: "Enter the server's address." };
	const typed = input.trim();
	// A space is never part of an address, and the URL parser would drop a line break without a word.
	if (/[\s\u0000-\u001f\u007f]/.test(typed)) return { ok: false, error: "An address has no spaces or line breaks." };
	// "name:" and then a slash is a scheme, typed right or not: "http:/x" must not become the host "http".
	const scheme = /^([a-z][a-z0-9+.-]*):[/\\]/i.exec(typed)?.[1].toLowerCase();
	if (scheme && !/^https?:\/\//i.test(typed)) return { ok: false, error: "Use an https:// address." };
	let url;
	try {
		url = new URL(scheme ? typed : `https://${typed}`);
	} catch {
		return { ok: false, error: "That doesn't look like a web address." };
	}
	if (url.port === "0") return { ok: false, error: "That port number is not valid." };
	if (!plausibleHost(url.hostname)) return { ok: false, error: "That doesn't look like a server's address. Use the whole name, like learn.example.com." };
	// "localhost:3000" with no scheme means this computer's plain-http server.
	if (!scheme && LOOPBACK.has(url.hostname)) url.protocol = "http:";
	if (url.username || url.password) return { ok: false, error: "Leave the user name and password out of the address." };
	if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return { ok: false, error: "Use an https:// address. Plain http is only for this computer." };
	return { ok: true, origin: url.origin };
}

/** The saved server, or none. A file that is there but unusable is ignored (the
 *  app must still start) and says why, so main can log it. */
function readServerSetting(dir, io = fs) {
	let text;
	try {
		text = io.readFileSync(path.join(dir, FILE), "utf8").replace(/^\uFEFF/, ""); // Windows Notepad adds a byte-order mark
	} catch (error) {
		return { origin: null, ignored: error?.code === "ENOENT" ? null : `could not read ${FILE}` };
	}
	try {
		const typed = normalizeServerAddress(JSON.parse(text)?.address);
		return typed.ok ? { origin: typed.origin, ignored: null } : { origin: null, ignored: `${FILE}: ${typed.error}` };
	} catch {
		return { origin: null, ignored: `${FILE} is not valid JSON` };
	}
}

/** Save the choice (an origin) or clear it (null = this computer). Written
 *  beside its final name and renamed, so a crash never leaves half a file. */
function writeServerSetting(dir, origin, io = fs) {
	const file = path.join(dir, FILE);
	if (origin === null) {
		try {
			io.unlinkSync(file);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		return;
	}
	const typed = normalizeServerAddress(origin);
	if (!typed.ok) throw new Error(typed.error);
	io.mkdirSync(dir, { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	try {
		io.writeFileSync(temp, `${JSON.stringify({ address: typed.origin })}\n`, { mode: 0o600 });
		io.renameSync(temp, file);
	} catch (error) {
		try {
			io.unlinkSync(temp);
		} catch { /* it may not exist */ }
		throw error;
	}
}

/** "local" | "remote" as a window argument. */
function modeArgument(mode) {
	return `${MODE_ARGUMENT}${mode}`;
}

/** The native "are you sure" for a change. Plain words: it restarts the app and
 *  does not copy anything. Cancel is the default button, so a stray Enter (or a
 *  page that asks without the person's say-so) changes nothing. */
function switchPrompt(next, title) {
	return next
		? {
			type: "question", title, noLink: true, buttons: ["Switch and Restart", "Cancel"], defaultId: 1, cancelId: 1,
			message: `Use the server at ${next}?`,
			detail: "LearnHarness restarts and opens that server. You sign in there, and you see the sessions stored on it. Nothing is copied: the sessions on this computer stay where they are.",
		}
		: {
			type: "question", title, noLink: true, buttons: ["Use This Computer and Restart", "Cancel"], defaultId: 1, cancelId: 1,
			message: "Use this computer instead of the server?",
			detail: "LearnHarness restarts with the sessions stored on this computer. The ones on the server are left alone.",
		};
}

/** Shown when the saved server does not answer at launch. */
function unreachablePrompt(origin, title) {
	return {
		type: "warning", title, noLink: true, buttons: ["Try Again", "Use This Computer", "Quit"], defaultId: 0, cancelId: 2,
		message: `Can't reach ${origin}`,
		detail: "Check your internet connection and that the server is running. \"Use This Computer\" restarts the app with the sessions stored on this computer.",
	};
}

module.exports = { normalizeServerAddress, readServerSetting, writeServerSetting, modeArgument, switchPrompt, unreachablePrompt, MODE_ARGUMENT, FILE };
