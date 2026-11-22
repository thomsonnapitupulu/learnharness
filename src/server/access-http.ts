/**
 * HTTP handlers for the hosted sign-in (mobile epic, story 1): the sign-in
 * page, sign-out, and the access status Settings reads. The app/ routes are
 * one-line wrappers, as for the other *-http modules. They run behind the
 * proxy, which has already vetted host and HTTPS (access-gate.ts).
 */

import { clientAddress, loginOn, overHttps, safeNext } from "./access-gate.ts";
import { html, loginPage, notSetUpPage, readForm, redirect, signedOutPage } from "./access-pages.ts";
import {
	clearedSessionCookie,
	cookieValue,
	createLimiter,
	issueSession,
	readAccessState,
	readSession,
	recordFailure,
	recordSignIn,
	sessionCookie,
	sessionCookieName,
	signOutEverywhere,
	verifyPassword,
} from "./access-session.ts";
import { crossSiteWrite } from "./desktop-access.ts";

// Per-address backoff, in memory: only the sign-in handler uses it.
const limiter = createLimiter();

const NO_STORE = { "Cache-Control": "no-store" };
const LOCKED_TEXT = "Sign-in is locked after too many wrong passwords. To unlock it, run on the server: npm run access -- unlock";

function waitText(ms: number): string {
	const minutes = Math.ceil(ms / 60_000);
	return minutes <= 1 ? "Too many wrong passwords. Try again in a minute." : `Too many wrong passwords. Try again in ${minutes} minutes.`;
}

/** GET /login */
export function accessSignInPage(request: Request): Response {
	const state = readAccessState();
	if (!state.password) return html(200, notSetUpPage());
	const next = safeNext(new URL(request.url).searchParams.get("next"));
	const token = cookieValue(request.headers.get("cookie"), sessionCookieName(overHttps(request)));
	if (readSession(state.sessionKey, token, Date.now())) return redirect(next);
	return html(200, loginPage({ next, locked: state.locked, message: state.locked ? LOCKED_TEXT : "" }));
}

/** POST /login */
export async function accessSignIn(request: Request): Promise<Response> {
	if (crossSiteWrite(request)) return html(403, loginPage({ message: "This sign-in came from another site and was refused." }));
	const form = await readForm(request);
	const next = safeNext(form?.get("next"));
	const state = readAccessState();
	if (!state.password) return html(409, notSetUpPage());
	if (state.locked) return html(423, loginPage({ next, locked: true, message: LOCKED_TEXT }));

	const client = clientAddress(request);
	const wait = limiter.waitMs(client, Date.now());
	if (wait > 0) return html(429, loginPage({ next, message: waitText(wait) }), { "Retry-After": String(Math.ceil(wait / 1000)) });
	// Count the try now, in the same breath as the check above: the password
	// check below takes a moment, and tries sent at once must not all pass.
	limiter.attempt(client, Date.now());

	let ok = false;
	try {
		ok = await verifyPassword(form?.get("password"), state.password);
	} catch {
		ok = false;
	}
	const now = Date.now();
	if (!ok) {
		const after = recordFailure(client, now);
		console.warn(`[access] wrong password from ${client}${after.locked ? " (sign-in is now locked)" : ""}`);
		if (after.locked) return html(423, loginPage({ next, locked: true, message: LOCKED_TEXT }));
		const delay = limiter.waitMs(client, now);
		return html(401, loginPage({ next, message: delay > 0 ? waitText(delay) : "That password is not right." }));
	}
	limiter.succeed(client);
	recordSignIn(client, now);
	console.info(`[access] signed in from ${client}`);
	return redirect(next, { "Set-Cookie": sessionCookie(issueSession(state.sessionKey, now, now), now, now, overHttps(request)) });
}

/** GET /logout: a button, because a link or a prefetch must not sign anyone out. */
export function accessSignOutPage(): Response {
	return html(200, signedOutPage());
}

/** POST /logout */
export function accessSignOut(request: Request): Response {
	if (crossSiteWrite(request)) return html(403, signedOutPage("That request came from another site and was refused."));
	return redirect("/login", { "Set-Cookie": clearedSessionCookie(overHttps(request)) });
}

/** GET /api/access: whether the sign-in is on, so Settings knows to show its buttons. */
export function accessStatus(): Response {
	return Response.json({ enabled: loginOn() }, { headers: NO_STORE });
}

/** POST /api/access { "action": "sign-out-all" }: every session ends, this one
 * included. The proxy has already required a session and a same-origin request. */
export async function accessSignOutAll(request: Request): Promise<Response> {
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action !== "sign-out-all") return Response.json({ error: "Unsupported access action." }, { status: 400, headers: NO_STORE });
	if (!loginOn()) return Response.json({ error: "Sign-in is not turned on." }, { status: 409, headers: NO_STORE });
	signOutEverywhere();
	return Response.json({ ok: true }, { headers: { ...NO_STORE, "Set-Cookie": clearedSessionCookie(overHttps(request)) } });
}
