/**
 * The sign-in gate for the hosted server (mobile epic, story 1). proxy.ts
 * calls it for every page and API request; the streamed document route,
 * which bypasses the proxy, calls it itself.
 *
 *  - Desktop mode (the per-launch secret) has no sign-in: unchanged.
 *  - No password set: this machine only. A fresh server is never open.
 *  - A password set: every request needs a session, this machine included.
 *    Requests that came through a proxy must also name an allowed host and
 *    arrive over HTTPS (X-Forwarded-Proto), or the password would cross the
 *    network in the clear.
 *
 * "This machine" means a loopback Host and a loopback visitor. Next fills
 * X-Forwarded-For from the socket when nothing upstream set it, and Caddy sets
 * it to the visitor's address, so a proxied request never passes for local.
 *
 * That rests on one assumption: Next listens on loopback only (`npm start` is
 * `next start -H localhost`) and the proxy is the only way in. Next does not
 * show the proxy the socket's address, so a client that reached Next directly
 * could send its own Host and X-Forwarded-For and pass for local. With a
 * password set it still needs a session; without one it would be let in. So
 * never bind the server to another interface, and open only the proxy's ports.
 */

import { isIP } from "node:net";
import {
	cookieValue,
	issueSession,
	readAccessState,
	readSession,
	sessionCookie,
	sessionCookieName,
	SESSION_REFRESH_MS,
} from "./access-session.ts";
import { browserHostAllowed, browserOnlyMode, requestProtocol } from "./desktop-access.ts";

/** Reachable without a session. The sign-in and sign-out pages are
 * self-contained, so nothing of the app loads before sign-in. */
export const PUBLIC_PATHS: readonly string[] = ["/login", "/logout"];

export interface GateOptions {
	env?: Record<string, string | undefined>;
	now?: number;
	file?: string;
}

export interface GateResult {
	/** Answer with this instead of the app. */
	refusal?: Response;
	/** Add to the response: a re-issued session cookie. */
	refreshCookie?: string;
}

const NO_STORE = { "Cache-Control": "no-store" };
export const NO_PASSWORD_TEXT =
	"LearnHarness has no password yet, so it only answers on the server itself. On the server, run: npm run access -- set-password";

export function hostOf(request: Request): string {
	return request.headers.get("host") ?? new URL(request.url).host;
}

export function overHttps(request: Request): boolean {
	return requestProtocol(request) === "https:";
}

function isLoopbackAddress(address: string): boolean {
	const bare = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return bare === "::1" || (isIP(bare) === 4 && bare.startsWith("127.")) || /^::ffff:127\./.test(bare);
}

/** A loopback Host, from a loopback visitor. Next sets X-Forwarded-For to the
 * socket's address when no proxy did, so a direct connection from this machine
 * shows 127.0.0.1 or ::1, while one Caddy forwarded shows the visitor's own
 * address (a chain counts if any hop is not loopback). */
export function isLocalRequest(request: Request): boolean {
	let hostname: string;
	try {
		hostname = new URL(`http://${hostOf(request)}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	if (!(hostname === "localhost" || isLoopbackAddress(hostname))) return false;
	const forwarded = request.headers.get("x-forwarded-for");
	return !forwarded || forwarded.split(",").every(isLoopbackAddress);
}

/** The visitor's address as the proxy reports it. Only the last entry is the
 * proxy's own; earlier ones are whatever the visitor sent. For backoff and logs. */
export function clientAddress(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-for");
	return forwarded ? forwarded.split(",").at(-1)!.trim().slice(0, 64) : "local";
}

/** A browser navigation (sent to the sign-in page) as opposed to a fetch. */
export function wantsPage(request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const mode = request.headers.get("sec-fetch-mode");
	if (mode) return mode === "navigate";
	return (request.headers.get("accept") ?? "").includes("text/html");
}

/** Only same-site paths: "//host" and "/\host" would leave the site. Printable
 * ASCII only, which is what a URL's path and query already are, so the value is
 * safe in a Location header. */
export function safeNext(value: unknown): string {
	if (typeof value !== "string" || !/^\/[\x21-\x7e]*$/.test(value) || value.startsWith("//") || value.startsWith("/\\")) return "/";
	if (PUBLIC_PATHS.some((path) => value === path || value.startsWith(`${path}/`) || value.startsWith(`${path}?`))) return "/";
	return value.slice(0, 2048);
}

function refuse(request: Request, status: number, error: string): Response {
	if (wantsPage(request)) return new Response(error, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
	return Response.json({ error }, { status, headers: NO_STORE });
}

/** True when the sign-in is on, which is when the Settings buttons show. */
export function loginOn(options: GateOptions = {}): boolean {
	return browserOnlyMode(options.env ?? process.env) && readAccessState(options.file).password !== null;
}

export function accessGate(request: Request, { env = process.env, now = Date.now(), file }: GateOptions = {}): GateResult {
	if (!browserOnlyMode(env)) return {};
	const state = readAccessState(file);
	const local = isLocalRequest(request);
	if (!state.password) return local ? {} : { refusal: refuse(request, 403, NO_PASSWORD_TEXT) };

	if (!local) {
		if (!browserHostAllowed(hostOf(request), env)) {
			return { refusal: refuse(request, 403, "This host name is not allowed. Add it to LH_ALLOWED_HOSTS on the server.") };
		}
		if (!overHttps(request)) return { refusal: refuse(request, 403, "LearnHarness only answers over HTTPS.") };
	}

	const url = new URL(request.url);
	if (PUBLIC_PATHS.includes(url.pathname)) return {};

	const secure = overHttps(request);
	const session = readSession(state.sessionKey, cookieValue(request.headers.get("cookie"), sessionCookieName(secure)), now);
	if (!session) {
		if (wantsPage(request)) {
			// Absolute, because Next's proxy adapter parses Location as a URL. The
			// host was vetted above (allowed host, or loopback) and the scheme is
			// the one the browser used, so this is the address it already has.
			const next = encodeURIComponent(url.pathname + url.search);
			return { refusal: new Response(null, { status: 303, headers: { ...NO_STORE, Location: `${requestProtocol(request)}//${hostOf(request)}/login?next=${next}` } }) };
		}
		return { refusal: Response.json({ error: "Sign in to LearnHarness first.", signIn: "/login" }, { status: 401, headers: NO_STORE }) };
	}
	if (now - session.seenAt < SESSION_REFRESH_MS) return {};
	return { refreshCookie: sessionCookie(issueSession(state.sessionKey, session.issuedAt, now), session.issuedAt, now, secure) };
}
