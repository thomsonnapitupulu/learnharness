/**
 * The hosted sign-in end to end, below the browser: the gate (which requests
 * need a session), the proxy that applies it, and the login, logout and
 * access routes. The data location is a scratch folder, set before anything
 * reads config.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "lh-gate-"));
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
process.env.LH_ALLOWED_HOSTS = "learn.example.com";

const { proxy } = await import("../proxy.ts");
const session = await import("../src/server/access-session.ts");
const { accessGate, clientAddress, isLocalRequest, loginOn, PUBLIC_FILES, safeNext } = await import("../src/server/access-gate.ts");
const http = await import("../src/server/access-http.ts");
const pages = await import("../src/server/access-pages.ts");
const { eventsResponse } = await import("../src/server/events-stream.ts");

const PASSWORD = "a long enough password";
const NO_PASSWORD_FILE = path.join(dir, "never-written.json");
await session.setPassword(PASSWORD);

const proxiedHeaders = (extra: Record<string, string> = {}) => ({
	host: "learn.example.com",
	"x-forwarded-for": "203.0.113.7",
	"x-forwarded-proto": "https",
	"x-forwarded-host": "learn.example.com",
	...extra,
});
/** A request as Caddy forwards it. */
const viaCaddy = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
	new NextRequest(`http://learn.example.com${p}`, { ...init, headers: proxiedHeaders(init.headers) });
/** A request to the server from the server itself, as Next hands it over: it
 * fills the X-Forwarded-* headers from the socket when no proxy did. */
const onServer = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
	new NextRequest(`http://localhost:3000${p}`, {
		...init,
		headers: { host: "localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http", "x-forwarded-host": "localhost:3000", ...init.headers },
	});

const token = (at = Date.now(), seen = at) => session.issueSession(session.readAccessState().sessionKey, at, seen);
const secureCookie = (value = token()) => ({ cookie: `${session.SESSION_COOKIE}=${value}` });
const localCookie = (value = token()) => ({ cookie: `${session.LOCAL_SESSION_COOKIE}=${value}` });
const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" };
const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

after(() => {
	delete process.env.LH_ALLOWED_HOSTS;
});

describe("who counts as this machine", () => {
	const ask = (host: string, headers: Record<string, string> = {}) => isLocalRequest(new Request(`http://${host}/`, { headers: { host, ...headers } }));

	it("is a loopback Host from a loopback visitor, with or without Next's own X-Forwarded-For", () => {
		for (const host of ["localhost:3000", "LOCALHOST", "127.0.0.1:3000", "127.3.4.5", "[::1]:3000"]) {
			assert.equal(ask(host), true, host);
			for (const visitor of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.9.9.9"]) assert.equal(ask(host, { "x-forwarded-for": visitor }), true, `${host} from ${visitor}`);
		}
	});

	it("is not another Host, whoever the visitor is", () => {
		for (const host of ["192.168.1.20:3000", "learn.example.com", "localhost.evil.example", "app.localhost:3000", "127.0.0.1.nip.io", "10.0.0.5"]) {
			assert.equal(ask(host), false, host);
			assert.equal(ask(host, { "x-forwarded-for": "127.0.0.1" }), false, host);
		}
	});

	it("is not a visitor from anywhere else, even one whose Host says localhost", () => {
		for (const visitor of ["203.0.113.7", "192.168.1.9", "::ffff:10.0.0.1", "2001:db8::1", "203.0.113.5, 127.0.0.1", "127.0.0.1, 203.0.113.5", "garbage"]) {
			assert.equal(ask("localhost:3000", { "x-forwarded-for": visitor }), false, visitor);
		}
	});

	it("reports the visitor's address from the proxy's own entry", () => {
		assert.equal(clientAddress(new Request("http://x/", { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.7" } })), "203.0.113.7");
		assert.equal(clientAddress(new Request("http://x/")), "local");
	});
});

describe("with no password set", () => {
	const opts = { file: NO_PASSWORD_FILE };

	it("answers this machine as before", () => {
		assert.deepEqual(accessGate(onServer("/"), opts), {});
		assert.deepEqual(accessGate(onServer("/api/chats"), opts), {});
		assert.equal(loginOn(opts), false);
	});

	it("refuses everything that came through the proxy, saying how to set a password", async () => {
		for (const request of [viaCaddy("/", { headers: navigate }), viaCaddy("/api/chats"), viaCaddy("/login", { headers: navigate })]) {
			const { refusal } = accessGate(request, opts);
			assert.equal(refusal?.status, 403);
			assert.match(await refusal!.text(), /npm run access -- set-password/);
		}
	});

	it("refuses a LAN address too", () => {
		const request = new NextRequest("http://192.168.1.20:3000/", { headers: { host: "192.168.1.20:3000" } });
		assert.equal(accessGate(request, opts).refusal?.status, 403);
	});

	it("leaves the desktop app alone, password or not", () => {
		const env = { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "a".repeat(64) };
		assert.deepEqual(accessGate(viaCaddy("/"), { ...opts, env }), {});
		assert.deepEqual(accessGate(viaCaddy("/"), { env }), {});
		assert.equal(loginOn({ env }), false);
	});
});

describe("with a password set", () => {
	it("sends a signed-out page request to the sign-in page and remembers where it was going", () => {
		const { refusal } = accessGate(viaCaddy("/chat/abc?x=1", { headers: navigate }));
		assert.equal(refusal?.status, 303);
		assert.equal(refusal?.headers.get("location"), "https://learn.example.com/login?next=%2Fchat%2Fabc%3Fx%3D1", "the address the browser used, scheme included");
		assert.equal(refusal?.headers.get("cache-control"), "no-store");
		assert.equal(accessGate(onServer("/", { headers: navigate })).refusal?.headers.get("location"), "http://localhost:3000/login?next=%2F");
	});

	it("answers a signed-out API call with 401 JSON, not a redirect", async () => {
		for (const request of [viaCaddy("/api/chats"), viaCaddy("/api/chat", { method: "POST", headers: { origin: "https://learn.example.com" } })]) {
			const { refusal } = accessGate(request);
			assert.equal(refusal?.status, 401);
			assert.match(refusal?.headers.get("content-type") ?? "", /json/);
			assert.deepEqual(await refusal!.json(), { error: "Sign in to LearnHarness first.", signIn: "/login" });
		}
	});

	it("lets a signed-in request through, over HTTPS with the __Host- cookie", () => {
		assert.deepEqual(accessGate(viaCaddy("/api/chats", { headers: secureCookie() })), {});
		assert.deepEqual(accessGate(viaCaddy("/", { headers: { ...navigate, ...secureCookie() } })), {});
	});

	it("asks for a session on this machine too, with the plain cookie over http", () => {
		assert.equal(accessGate(onServer("/", { headers: navigate })).refusal?.status, 303);
		assert.equal(accessGate(onServer("/api/chats")).refusal?.status, 401);
		assert.deepEqual(accessGate(onServer("/api/chats", { headers: localCookie() })), {});
	});

	it("does not take one transport's cookie for the other's", () => {
		assert.equal(accessGate(viaCaddy("/api/chats", { headers: localCookie() })).refusal?.status, 401, "over HTTPS only the __Host- name counts");
		assert.equal(accessGate(onServer("/api/chats", { headers: secureCookie() })).refusal?.status, 401, "on plain http only the plain name counts");
	});

	it("refuses forged, expired, idle and signed-out sessions", () => {
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		const wrongKey = session.issueSession("cd".repeat(32), now, now);
		const state = session.readAccessState();
		const tampered = (() => {
			const [, signature] = token().split(".") as [string, string];
			return `${Buffer.from(JSON.stringify({ i: now - 40 * day, s: now })).toString("base64url")}.${signature}`;
		})();
		for (const value of [wrongKey, tampered, "garbage", token(now - 31 * day, now - 31 * day), token(now - 10 * day, now - 8 * day)]) {
			assert.equal(accessGate(viaCaddy("/api/chats", { headers: secureCookie(value) })).refusal?.status, 401, value.slice(0, 30));
		}
		const valid = token();
		assert.deepEqual(accessGate(viaCaddy("/api/chats", { headers: secureCookie(valid) })), {});
		assert.ok(state.sessionKey);
	});

	it("re-issues the cookie once an hour, keeping the original sign-in time", () => {
		const now = Date.now();
		const issuedAt = now - 5 * 24 * 60 * 60 * 1000;
		const fresh = accessGate(viaCaddy("/api/chats", { headers: secureCookie(token(issuedAt, now - 10 * 60_000)) }), { now });
		assert.equal(fresh.refreshCookie, undefined, "seen ten minutes ago");
		const stale = accessGate(viaCaddy("/api/chats", { headers: secureCookie(token(issuedAt, now - 2 * 60 * 60_000)) }), { now });
		assert.ok(stale.refreshCookie?.startsWith(`${session.SESSION_COOKIE}=`));
		assert.match(stale.refreshCookie!, /; Secure; HttpOnly; SameSite=Strict$/);
		const reissued = stale.refreshCookie!.split(";")[0]!.split("=")[1]!;
		assert.deepEqual(session.readSession(session.readAccessState().sessionKey, reissued, now), { issuedAt, seenAt: now });
	});

	it("lets the sign-in and sign-out pages through without a session", () => {
		assert.deepEqual(accessGate(viaCaddy("/login", { headers: navigate })), {});
		assert.deepEqual(accessGate(viaCaddy("/logout", { method: "POST" })), {});
		assert.deepEqual(accessGate(onServer("/login")), {});
		assert.equal(accessGate(viaCaddy("/loginx", { headers: navigate })).refusal?.status, 303);
		assert.equal(accessGate(viaCaddy("/login/../api/chats")).refusal?.status, 401);
	});

	it("lets the home-screen files through without a session: browsers fetch the manifest and icon without cookies", () => {
		assert.deepEqual([...PUBLIC_FILES].sort(), [
			"/icons/apple-touch-icon.png",
			"/icons/icon-192.png",
			"/icons/icon-512.png",
			"/icons/icon-maskable-512.png",
			"/manifest.webmanifest",
		]);
		for (const file of PUBLIC_FILES) {
			assert.deepEqual(accessGate(viaCaddy(file)), {}, file);
			assert.deepEqual(accessGate(viaCaddy(`${file}?v=2`)), {}, `${file} with a query`);
			assert.deepEqual(accessGate(onServer(file)), {}, `${file} on the server itself`);
		}
	});

	it("opens the home-screen files for reading only: a POST, PUT, PATCH, DELETE or OPTIONS still needs a session", () => {
		for (const file of PUBLIC_FILES) {
			assert.deepEqual(accessGate(viaCaddy(file, { method: "HEAD" })), {}, `${file} HEAD`);
			for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
				const init = method === "OPTIONS" || method === "DELETE" ? { method } : { method, body: "x" };
				assert.equal(accessGate(viaCaddy(file, init)).refusal?.status, 401, `${file} ${method}`);
				assert.equal(accessGate(onServer(file, init)).refusal?.status, 401, `${file} ${method} on the server itself`);
			}
			// Signed in, the gate has no say about the method: the file handler answers.
			assert.equal(accessGate(viaCaddy(file, { method: "POST", body: "x", headers: secureCookie() })).refusal, undefined, `${file} POST with a session`);
		}
	});

	it("links the same manifest and icons from the sign-in page", () => {
		const page = pages.loginPage();
		assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest">/);
		assert.match(page, /<link rel="icon" href="\/icons\/icon-192\.png" type="image\/png">/);
		assert.match(page, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
		for (const href of page.match(/<link rel="[^"]+" href="([^"]+)"/g)!.map((tag) => tag.match(/href="([^"]+)"/)![1]!)) {
			assert.ok(PUBLIC_FILES.includes(href), `${href} is linked from the sign-in page, so it must be open without a session`);
		}
	});

	it("opens only those files: anything beside them, or reached through them, still needs a session", () => {
		for (const other of [
			"/icons/icon-192.png.bak", "/icons/secret.png", "/icons/", "/icons", "/manifest.webmanifest/x", "/Manifest.webmanifest",
			"/icons/icon-192.png/../../api/chats", "/icons/%2e%2e/api/chats", "/api/chats", "/favicon.ico",
		]) {
			assert.equal(accessGate(viaCaddy(other)).refusal?.status, 401, other);
			assert.equal(accessGate(viaCaddy(other, { headers: navigate })).refusal?.status, 303, `${other} as a page`);
		}
	});

	it("still asks an allowed host and HTTPS for the home-screen files", () => {
		const plainHttp = { "x-forwarded-proto": "http" };
		const stranger = { host: "evil.example", "x-forwarded-host": "evil.example" };
		for (const file of PUBLIC_FILES) {
			assert.equal(accessGate(viaCaddy(file, { headers: plainHttp })).refusal?.status, 403, `${file} over http`);
			assert.equal(accessGate(viaCaddy(file, { headers: stranger })).refusal?.status, 403, `${file} on another host`);
		}
	});

	it("with no password yet, serves the home-screen files to this machine only, like everything else", () => {
		for (const file of PUBLIC_FILES) {
			assert.deepEqual(accessGate(onServer(file), { file: NO_PASSWORD_FILE }), {}, file);
			assert.equal(accessGate(viaCaddy(file), { file: NO_PASSWORD_FILE }).refusal?.status, 403, `${file} through the proxy`);
		}
	});

	it("insists on HTTPS and an allowed host for anything that came through the proxy", async () => {
		const http = accessGate(viaCaddy("/login", { headers: { ...navigate, "x-forwarded-proto": "http" } })).refusal;
		assert.equal(http?.status, 403);
		assert.match(await http!.text(), /HTTPS/);
		const stranger = accessGate(viaCaddy("/login", { headers: { ...navigate, host: "evil.example", "x-forwarded-host": "evil.example" } })).refusal;
		assert.equal(stranger?.status, 403);
		assert.match(await stranger!.text(), /LH_ALLOWED_HOSTS/);
		assert.equal(accessGate(viaCaddy("/api/chats", { headers: { ...secureCookie(), "x-forwarded-proto": "http" } })).refusal?.status, 403, "a valid cookie does not excuse plain http");
	});
});

describe("redirect targets", () => {
	it("stay on this site and never loop back to the sign-in pages", () => {
		for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "login", "", undefined, null, 5, "/login", "/login?x=1", "/logout", "/login/x"]) {
			assert.equal(safeNext(bad), "/", String(bad));
		}
		for (const bad of ["/a\r\nSet-Cookie: x=1", "/a b", "/\u5b57", "/a\u0000", "/a\u007f"]) assert.equal(safeNext(bad), "/", JSON.stringify(bad));
		assert.equal(safeNext("/chat/abc?x=1#y"), "/chat/abc?x=1#y");
		assert.equal(safeNext("/chat/%E5%AD%97?q=a%20b"), "/chat/%E5%AD%97?q=a%20b");
		assert.equal(safeNext("/loginx"), "/loginx");
	});
});

describe("the proxy", () => {
	it("runs the existing API policy first, then the gate", async () => {
		const csrf = proxy(viaCaddy("/api/chats", { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", ...secureCookie() } }));
		assert.equal(csrf.status, 403);
		assert.match((await csrf.json()).error, /Cross-site/);
		const rebind = proxy(viaCaddy("/api/chats", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } }));
		assert.equal(rebind.status, 403);
		assert.equal(proxy(viaCaddy("/api/chats")).status, 401);
	});

	it("accepts a same-origin HTTPS write behind Caddy, which compares https with the forwarded scheme", () => {
		const ok = proxy(viaCaddy("/api/chats", { method: "POST", headers: { origin: "https://learn.example.com", "sec-fetch-site": "same-origin", ...secureCookie() } }));
		assert.ok(passes(ok));
		const http = proxy(viaCaddy("/api/chats", { method: "POST", headers: { origin: "http://learn.example.com", ...secureCookie() } }));
		assert.equal(http.status, 403, "an http origin is not this site's");
	});

	it("gates pages, and adds the refreshed cookie to the response that carries on", () => {
		assert.equal(proxy(viaCaddy("/", { headers: navigate })).status, 303);
		assert.ok(passes(proxy(viaCaddy("/", { headers: { ...navigate, ...secureCookie() } }))));
		const now = Date.now();
		const stale = proxy(viaCaddy("/api/chats", { headers: secureCookie(token(now - 3 * 60 * 60_000, now - 2 * 60 * 60_000)) }));
		assert.ok(passes(stale));
		assert.match(stale.headers.get("set-cookie") ?? "", /^__Host-lh_session=/);
	});

	it("lets the desktop app's pages and APIs follow the capability alone", () => {
		const secret = "a".repeat(64);
		const before = { server: process.env.LH_DESKTOP_SERVER, secret: process.env.LH_DESKTOP_API_SECRET };
		process.env.LH_DESKTOP_SERVER = "1";
		process.env.LH_DESKTOP_API_SECRET = secret;
		try {
			assert.ok(passes(proxy(onServer("/chat/new"))), "pages: no sign-in in desktop mode");
			assert.ok(passes(proxy(onServer("/api/chats", { headers: { "x-learnharness-desktop": secret } }))));
			assert.equal(proxy(onServer("/api/chats")).status, 403);
		} finally {
			for (const [name, value] of [["LH_DESKTOP_SERVER", before.server], ["LH_DESKTOP_API_SECRET", before.secret]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

describe("signing in", () => {
	let n = 0;
	/** Each test gets its own visitor: the backoff is per address. */
	const visitor = () => `198.51.100.${++n}`;
	const post = (fields: Record<string, string>, ip = visitor(), extra: Record<string, string> = {}) =>
		http.accessSignIn(viaCaddy("/login", { method: "POST", headers: { ...FORM, origin: "https://learn.example.com", "x-forwarded-for": ip, ...extra }, body: form(fields) }));

	beforeEach(() => {
		session.unlockSignIn();
	});

	it("shows a form that posts to /login, carrying where to go next, and nothing from the app", async () => {
		const response = http.accessSignInPage(viaCaddy("/login?next=/chat/abc", { headers: navigate }));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.equal(response.headers.get("referrer-policy"), "same-origin", "no-referrer would make the browser post Origin: null, and the sign-in would refuse itself");
		const page = await response.text();
		assert.match(page, /<form method="post" action="\/login">/);
		assert.match(page, /type="password" name="password"/);
		assert.match(page, /name="next" value="\/chat\/abc"/);
		assert.ok(!/<script/i.test(page));
	});

	it("escapes the target, so it cannot break out of the page", async () => {
		const page = await http.accessSignInPage(viaCaddy(`/login?next=${encodeURIComponent('/x"><script>alert(1)</script>')}`, { headers: navigate })).text();
		assert.ok(!page.includes("<script>"));
		assert.match(page, /&quot;&gt;&lt;script&gt;/);
	});

	it("signs in with the right password: 303 to the target and a session that checks out", async () => {
		const response = await post({ password: PASSWORD, next: "/chat/abc" });
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/chat/abc");
		const cookie = response.headers.get("set-cookie")!;
		assert.match(cookie, /^__Host-lh_session=[^;]+; Path=\/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict$/);
		const value = cookie.split(";")[0]!.split("=")[1]!;
		assert.ok(session.readSession(session.readAccessState().sessionKey, value, Date.now()));
		assert.deepEqual(accessGate(viaCaddy("/api/chats", { headers: secureCookie(value) })), {});
		assert.equal(session.readAccessState().lastSignIn?.client.startsWith("198.51.100."), true);
	});

	it("sets the plain cookie, without Secure, for a sign-in on this machine", async () => {
		const response = await http.accessSignIn(onServer("/login", { method: "POST", headers: { ...FORM, origin: "http://localhost:3000" }, body: form({ password: PASSWORD }) }));
		assert.equal(response.status, 303);
		assert.match(response.headers.get("set-cookie")!, /^lh_session=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
	});

	it("refuses a wrong password, says so, and counts it", async () => {
		const before = session.readAccessState().failures.length;
		const response = await post({ password: "wrong password here" });
		assert.equal(response.status, 401);
		assert.equal(response.headers.get("set-cookie"), null);
		assert.match(await response.text(), /That password is not right/);
		assert.equal(session.readAccessState().failures.length, before + 1);
	});

	it("treats a missing or oversized password as wrong, not as an error", async () => {
		assert.equal((await post({})).status, 401);
		assert.equal((await post({ password: "x".repeat(5000) })).status, 401);
	});

	it("never sends a signed-in visitor to a page outside this site", async () => {
		for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
			const response = await post({ password: PASSWORD, next });
			assert.equal(response.headers.get("location"), "/", next);
		}
	});

	it("counts tries sent at once, so a burst cannot get past the backoff", async () => {
		const ip = visitor();
		const answers = await Promise.all(Array.from({ length: 30 }, () => post({ password: "wrong password here" }, ip)));
		const statuses = answers.map((response) => response.status);
		assert.equal(statuses.filter((status) => status === 401).length, 5, "only five get their password checked");
		assert.equal(statuses.filter((status) => status === 429).length, 25, "the rest wait");
		assert.equal(session.readAccessState().failures.filter((failure) => failure.client === ip).length, 5);
	});

	it("makes one address wait after five wrong passwords, and only that address", async () => {
		const ip = visitor();
		for (let i = 0; i < 4; i++) assert.match(await (await post({ password: "wrong password here" }, ip)).text(), /not right/);
		const fifth = await post({ password: "wrong password here" }, ip);
		assert.equal(fifth.status, 401, "the fifth wrong password is still answered, and starts the wait");
		assert.match(await fifth.text(), /Try again in a minute/);
		const waiting = await post({ password: PASSWORD }, ip);
		assert.equal(waiting.status, 429, "even the right password waits");
		assert.equal(waiting.headers.get("retry-after"), "30");
		assert.equal((await post({ password: PASSWORD })).status, 303, "another address signs in");
	});

	it("locks sign-in after 20 wrong passwords in an hour, and the right one then fails too", async () => {
		for (let i = 0; i < 19; i++) assert.equal((await post({ password: "wrong password here" })).status, 401, `wrong ${i}`);
		const locking = await post({ password: "wrong password here" });
		assert.equal(locking.status, 423);
		assert.match(await locking.text(), /npm run access -- unlock/);
		assert.equal(session.readAccessState().locked, true);
		const afterwards = await post({ password: PASSWORD });
		assert.equal(afterwards.status, 423);
		assert.equal(afterwards.headers.get("set-cookie"), null);
		const page = await http.accessSignInPage(viaCaddy("/login", { headers: navigate })).text();
		assert.ok(!page.includes('type="password"'), "the locked page has no form");
		session.unlockSignIn();
		assert.equal((await post({ password: PASSWORD })).status, 303);
	});

	it("refuses a sign-in that another site sent", async () => {
		for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
			const response = await http.accessSignIn(viaCaddy("/login", { method: "POST", headers: { ...FORM, ...headers }, body: form({ password: PASSWORD }) }));
			assert.equal(response.status, 403, JSON.stringify(headers));
			assert.equal(response.headers.get("set-cookie"), null);
		}
	});

	it("sends someone who is already signed in straight on", () => {
		const response = http.accessSignInPage(viaCaddy("/login?next=/chat/abc", { headers: { ...navigate, ...secureCookie() } }));
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/chat/abc");
	});
});

describe("signing out", () => {
	it("asks first on GET, since a link or prefetch must not sign anyone out", async () => {
		const response = http.accessSignOutPage();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("set-cookie"), null);
		assert.match(await response.text(), /<form method="post" action="\/logout">/);
	});

	it("clears the cookie on POST and returns to the sign-in page", () => {
		const response = http.accessSignOut(viaCaddy("/logout", { method: "POST", headers: { origin: "https://learn.example.com", ...secureCookie() } }));
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/login");
		assert.match(response.headers.get("set-cookie")!, /^__Host-lh_session=; Path=\/; Max-Age=0; Secure;/);
	});

	it("refuses a sign-out another site sent", () => {
		assert.equal(http.accessSignOut(viaCaddy("/logout", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
	});
});

describe("the access route behind Settings", () => {
	it("reports whether the sign-in is on", async () => {
		assert.deepEqual(await http.accessStatus().json(), { enabled: true });
	});

	it("signs every device out, this one included", async () => {
		const old = token();
		const response = await http.accessSignOutAll(viaCaddy("/api/access", { method: "POST", headers: { "content-type": "application/json", origin: "https://learn.example.com", ...secureCookie(old) }, body: JSON.stringify({ action: "sign-out-all" }) }));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("set-cookie")!, /^__Host-lh_session=; .*Max-Age=0/);
		assert.equal(accessGate(viaCaddy("/api/chats", { headers: secureCookie(old) })).refusal?.status, 401, "the old cookie no longer works");
		assert.ok(session.readAccessState().password, "the password is kept");
	});

	it("ends a live event stream when every session ends, rather than telling a signed-out phone what the app is doing", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const reader = eventsResponse().body!.getReader();
		t.mock.timers.tick(25_000);
		assert.equal(new TextDecoder().decode((await reader.read()).value), ": ping\n\n", "while the sessions stand, the stream keeps pinging");
		session.signOutEverywhere();
		t.mock.timers.tick(25_000);
		assert.equal((await reader.read()).done, true, "the next heartbeat finds the key changed and closes it");
	});

	it("refuses anything else", async () => {
		for (const body of ["", "{}", JSON.stringify({ action: "set-password" })]) {
			const response = await http.accessSignOutAll(viaCaddy("/api/access", { method: "POST", headers: { "content-type": "application/json" }, body }));
			assert.equal(response.status, 400, body);
		}
	});
});
