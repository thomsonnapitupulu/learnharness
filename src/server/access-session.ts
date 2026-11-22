/**
 * Sign-in for the hosted server (mobile epic, story 1; design in
 * docs/mobile/login.md). One owner, one password.
 *
 *  - ACCESS_FILE (access.json, mode 0600, beside auth.json) holds the scrypt
 *    hash of the password, the key that signs session cookies and the lock
 *    state. It never holds the password.
 *  - A session is a signed cookie, not a record: `{ i: issuedAt, s: seenAt }`.
 *    It ends 30 days after sign-in and after 7 idle days. Replacing the key
 *    (sign out of all devices, a new password) ends every session at once.
 *  - Next compiles proxy.ts and each route into separate bundles, so a module
 *    variable is not shared between them. Every reader therefore reads the
 *    file, which is tiny. Only the per-address backoff is kept in memory, and
 *    only the login route uses it.
 */

import { createHmac, randomBytes, randomInt, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACCESS_FILE } from "../../config.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Over HTTPS the `__Host-` prefix makes the browser insist on Secure, Path=/
 * and no Domain. Plain http only happens on this machine (development). */
export const SESSION_COOKIE = "__Host-lh_session";
export const LOCAL_SESSION_COOKIE = "lh_session";
export const MIN_PASSWORD = 16;
export const SESSION_MAX_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
/** The cookie is re-issued at most this often, which slides the idle window. */
export const SESSION_REFRESH_MS = 60 * MINUTE;
const PER_CLIENT_FREE_TRIES = 5;
const PER_CLIENT_MAX_WAIT_MS = 15 * MINUTE;
export const LOCK_FAILURES = 20;
const LOCK_WINDOW_MS = 60 * MINUTE;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// ── stored state ──────────────────────────────────────────────────────

export interface AccessState {
	version: 1;
	password: { salt: string; hash: string } | null;
	/** Hex. Signs the session cookies. */
	sessionKey: string;
	locked: boolean;
	lockedAt: number | null;
	/** The newest LOCK_FAILURES wrong passwords. */
	failures: { at: number; client: string }[];
	lastSignIn: { at: number; client: string } | null;
}

function emptyState(): AccessState {
	return { version: 1, password: null, sessionKey: randomBytes(32).toString("hex"), locked: false, lockedAt: null, failures: [], lastSignIn: null };
}

function normalize(raw: unknown): AccessState {
	const state = emptyState();
	if (!raw || typeof raw !== "object") return state;
	const record = raw as Record<string, unknown>;
	const password = record.password as { salt?: unknown; hash?: unknown } | null | undefined;
	if (password && typeof password.salt === "string" && typeof password.hash === "string") state.password = { salt: password.salt, hash: password.hash };
	if (typeof record.sessionKey === "string" && record.sessionKey.length >= 64) state.sessionKey = record.sessionKey;
	state.locked = record.locked === true;
	state.lockedAt = typeof record.lockedAt === "number" ? record.lockedAt : null;
	if (Array.isArray(record.failures)) {
		state.failures = record.failures
			.filter((f): f is { at: number; client: string } => !!f && typeof f.at === "number" && typeof f.client === "string")
			.slice(-LOCK_FAILURES);
	}
	const last = record.lastSignIn as { at?: unknown; client?: unknown } | null | undefined;
	if (last && typeof last.at === "number" && typeof last.client === "string") state.lastSignIn = { at: last.at, client: last.client };
	return state;
}

/** The current state. A missing or unreadable file means "no password", which
 * the gate treats as closed to everything but this machine. */
export function readAccessState(file: string = ACCESS_FILE): AccessState {
	try {
		return normalize(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")));
	} catch {
		return emptyState();
	}
}

export function writeAccessState(state: AccessState, file: string = ACCESS_FILE): void {
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, JSON.stringify(state, null, "\t"), { mode: 0o600 });
}

// ── passwords ─────────────────────────────────────────────────────────

function scrypt(password: string, salt: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		nodeScrypt(password, Buffer.from(salt, "hex"), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (error, key) => {
			if (error) reject(error);
			else resolve(key);
		});
	});
}

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
	const salt = randomBytes(16).toString("hex");
	return { salt, hash: (await scrypt(password, salt)).toString("hex") };
}

export async function verifyPassword(password: unknown, stored: { salt: string; hash: string } | null): Promise<boolean> {
	if (!stored || typeof password !== "string" || password.length === 0 || password.length > 1024) return false;
	const actual = await scrypt(password, stored.salt);
	const wanted = Buffer.from(stored.hash, "hex");
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** 24 characters from a 31-letter alphabet (about 119 bits), in groups of
 * four so it can be typed from a password manager. */
export function generatePassword(): string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	let out = "";
	for (let i = 0; i < 24; i++) {
		if (i > 0 && i % 4 === 0) out += "-";
		out += alphabet[randomInt(alphabet.length)];
	}
	return out;
}

/** Sets the password and, because the key changes, signs every device out. */
export async function setPassword(password: string, file: string = ACCESS_FILE): Promise<void> {
	if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
	if (password.length > 1024) throw new Error("That password is too long.");
	const state = readAccessState(file);
	writeAccessState({ ...state, password: await hashPassword(password), sessionKey: randomBytes(32).toString("hex"), locked: false, lockedAt: null, failures: [] }, file);
}

/** Every cookie ever issued stops working. */
export function signOutEverywhere(file: string = ACCESS_FILE): void {
	writeAccessState({ ...readAccessState(file), sessionKey: randomBytes(32).toString("hex") }, file);
}

export function unlockSignIn(file: string = ACCESS_FILE): void {
	writeAccessState({ ...readAccessState(file), locked: false, lockedAt: null, failures: [] }, file);
}

// ── sessions ──────────────────────────────────────────────────────────

function sign(key: string, payload: string): string {
	return createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest("base64url");
}

export function issueSession(key: string, issuedAt: number, seenAt: number): string {
	const payload = Buffer.from(JSON.stringify({ i: issuedAt, s: seenAt })).toString("base64url");
	return `${payload}.${sign(key, payload)}`;
}

/** { issuedAt, seenAt } for a genuine, unexpired token, else null. */
export function readSession(key: string, token: string | undefined, now: number): { issuedAt: number; seenAt: number } | null {
	if (typeof token !== "string" || token.length > 512) return null;
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const payload = token.slice(0, dot);
	const supplied = Buffer.from(token.slice(dot + 1));
	const wanted = Buffer.from(sign(key, payload));
	if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
	let data: { i?: unknown; s?: unknown };
	try {
		data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	const { i: issuedAt, s: seenAt } = data ?? {};
	if (typeof issuedAt !== "number" || typeof seenAt !== "number" || seenAt < issuedAt) return null;
	if (issuedAt > now + MINUTE || now - issuedAt >= SESSION_MAX_MS || now - seenAt >= SESSION_IDLE_MS) return null;
	return { issuedAt, seenAt };
}

export function sessionCookieName(secure: boolean): string {
	return secure ? SESSION_COOKIE : LOCAL_SESSION_COOKIE;
}

/** Set-Cookie value. Max-Age is whichever ends first: the 30 days or the
 * idle window from now. */
export function sessionCookie(token: string, issuedAt: number, now: number, secure: boolean): string {
	const maxAge = Math.max(0, Math.floor(Math.min(SESSION_MAX_MS - (now - issuedAt), SESSION_IDLE_MS) / 1000));
	return `${sessionCookieName(secure)}=${token}; Path=/; Max-Age=${maxAge}; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`;
}

export function clearedSessionCookie(secure: boolean): string {
	return `${sessionCookieName(secure)}=; Path=/; Max-Age=0; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict`;
}

export function cookieValue(header: string | null | undefined, name: string): string | undefined {
	if (typeof header !== "string") return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

// ── the login limiter ─────────────────────────────────────────────────

/** Per-address backoff, in memory: 5 free tries, then each try doubles the
 * wait from 30 seconds up to 15 minutes. A try is counted when it starts, not
 * when its slow password check ends, or tries sent at once would all get in.
 * A right password clears the count. The lock itself is persisted. */
export function createLimiter() {
	const clients = new Map<string, { count: number; until: number }>();
	return {
		waitMs(client: string, now: number): number {
			const entry = clients.get(client);
			return entry ? Math.max(0, entry.until - now) : 0;
		},
		attempt(client: string, now: number): void {
			const entry = clients.get(client) ?? { count: 0, until: 0 };
			entry.count += 1;
			const over = entry.count - PER_CLIENT_FREE_TRIES;
			entry.until = over >= 0 ? now + Math.min(PER_CLIENT_MAX_WAIT_MS, 30_000 * 2 ** over) : 0;
			clients.set(client, entry);
			if (clients.size > 10_000) clients.delete(clients.keys().next().value as string);
		},
		succeed(client: string): void {
			clients.delete(client);
		},
	};
}

/** Records a wrong password, and locks sign-in after LOCK_FAILURES of them
 * within an hour. Reads the file now, not earlier: the check that led here
 * awaited a slow hash. */
export function recordFailure(client: string, now: number, file: string = ACCESS_FILE): AccessState {
	const state = readAccessState(file);
	const failures = [...state.failures, { at: now, client }].slice(-LOCK_FAILURES);
	const recent = failures.filter((f) => now - f.at < LOCK_WINDOW_MS).length;
	const lock = !state.locked && recent >= LOCK_FAILURES;
	const next = { ...state, failures, locked: state.locked || lock, lockedAt: lock ? now : state.lockedAt };
	writeAccessState(next, file);
	return next;
}

export function recordSignIn(client: string, now: number, file: string = ACCESS_FILE): void {
	writeAccessState({ ...readAccessState(file), lastSignIn: { at: now, client } }, file);
}
