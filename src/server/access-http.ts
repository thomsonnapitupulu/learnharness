/**
 * HTTP handlers for the hosted sign-in (mobile epic, stories 1 and 2): the
 * sign-in page, sign-out, the unlock page an emailed link opens, and the
 * access status Settings reads. The app/ routes are one-line wrappers, as for
 * the other *-http modules. They run behind the proxy, which has already
 * vetted host and HTTPS (access-gate.ts).
 */

import { emailUnlockLink, mailConfig, type UnlockMail } from "./access-mail.ts";
import { clientAddress, loginOn, overHttps, safeNext } from "./access-gate.ts";
import { html, loginPage, notSetUpPage, readForm, redirect, signedOutPage, unlockedPage, unlockFailedPage, unlockPage } from "./access-pages.ts";
import {
	clearedSessionCookie,
	cookieValue,
	createLimiter,
	issueSession,
	readAccessState,
	readSession,
	recordFailure,
	recordSignIn,
	redeemUnlockToken,
	sessionCookie,
	sessionCookieName,
	signOutEverywhere,
	unlockTokenValid,
	verifyPassword,
} from "./access-session.ts";
import { crossSiteWrite } from "./desktop-access.ts";

// Per-address backoff, in memory: only the sign-in handler uses it.
const limiter = createLimiter();

const NO_STORE = { "Cache-Control": "no-store" };
const LOCKED = "Sign-in is locked after too many wrong passwords.";

function waitText(ms: number): string {
	const minutes = Math.ceil(ms / 60_000);
	return minutes <= 1 ? "Too many wrong passwords. Try again in a minute." : `Too many wrong passwords. Try again in ${minutes} minutes.`;
}

/** What the locked page says, given what just happened to the unlock email
 * (nothing, for a page opened later: it cannot know how an earlier send went). */
function lockedText(sent?: UnlockMail): string {
	if (sent === "sent") return `${LOCKED} An unlock link was emailed to you. It works for 15 minutes.`;
	if (sent === "failed") return `${LOCKED} The unlock email could not be sent (the server's log says why). To unlock it, run on the server: npm run access -- unlock`;
	if (typeof sent === "object") {
		const minutes = Math.max(1, Math.ceil(sent.waitMs / 60_000));
		return `${LOCKED} A link was emailed a little while ago. You can ask for another in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
	}
	if (mailConfig()) return `${LOCKED} Ask for an unlock link by email below, or run on the server: npm run access -- unlock`;
	return `${LOCKED} To unlock it, run on the server: npm run access -- unlock`;
}

/** GET /login */
export function accessSignInPage(request: Request): Response {
	const state = readAccessState();
	if (!state.password) return html(200, notSetUpPage());
	const next = safeNext(new URL(request.url).searchParams.get("next"));
	const token = cookieValue(request.headers.get("cookie"), sessionCookieName(overHttps(request)));
	if (readSession(state.sessionKey, token, Date.now())) return redirect(next);
	return html(200, loginPage({ next, locked: state.locked, canEmail: mailConfig() !== null, message: state.locked ? lockedText() : "" }));
}

/** POST /login */
export async function accessSignIn(request: Request): Promise<Response> {
	if (crossSiteWrite(request)) return html(403, loginPage({ message: "This sign-in came from another site and was refused." }));
	const form = await readForm(request);
	const next = safeNext(form?.get("next"));
	const state = readAccessState();
	if (!state.password) return html(409, notSetUpPage());
	if (state.locked) return html(423, loginPage({ next, locked: true, canEmail: mailConfig() !== null, message: lockedText() }));

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
		if (after.locked) {
			const sent = await emailUnlockLink(`Sign-in was locked after ${after.failures.length} wrong passwords within an hour, the latest from ${client}.`);
			return html(423, loginPage({ next, locked: true, canEmail: mailConfig() !== null, message: lockedText(sent) }));
		}
		const delay = limiter.waitMs(client, now);
		return html(401, loginPage({ next, message: delay > 0 ? waitText(delay) : "That password is not right." }));
	}
	limiter.succeed(client);
	recordSignIn(client, now);
	console.info(`[access] signed in from ${client}`);
	return redirect(next, { "Set-Cookie": sessionCookie(issueSession(state.sessionKey, now, now), now, now, overHttps(request)) });
}

/** GET /unlock?token=…, the link in the email. It asks first: a mail scanner
 * that previews the link must not unlock anything. */
export function accessUnlockPage(request: Request): Response {
	if (!readAccessState().password) return html(200, notSetUpPage());
	const token = new URL(request.url).searchParams.get("token");
	if (token === null || !unlockTokenValid(token, Date.now())) return html(410, unlockFailedPage());
	return html(200, unlockPage(token));
}

/** POST /unlock. With a `token` it spends the link; without one it is the
 * "Email me an unlock link" button on the locked sign-in page. */
export async function accessUnlock(request: Request): Promise<Response> {
	if (crossSiteWrite(request)) return html(403, unlockFailedPage("That request came from another site and was refused."));
	const form = await readForm(request);
	const state = readAccessState();
	if (!state.password) return html(409, notSetUpPage());
	const token = form?.get("token");
	if (token !== null && token !== undefined) {
		if (!redeemUnlockToken(token, Date.now())) return html(410, unlockFailedPage());
		console.info("[access] sign-in unlocked with an emailed link");
		return html(200, unlockedPage());
	}
	if (!state.locked) return redirect("/login");
	const sent = await emailUnlockLink(`You asked for an unlock link (from ${clientAddress(request)}).`);
	return html(200, loginPage({ locked: true, canEmail: mailConfig() !== null, message: lockedText(sent) }));
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
