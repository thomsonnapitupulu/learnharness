/**
 * The unlock email (mobile epic, story 2): the one-time token and the send
 * limits, the AWS CLI sender, and the pages and routes around them. The data
 * location is a scratch folder, set before anything reads config.ts. The
 * address is an `.invalid` one: the real one never appears in this repository.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import type { Mail } from "../src/server/access-mail.ts";
import type { AccessState } from "../src/server/access-session.ts";

const dir = mkdtempSync(path.join(tmpdir(), "lh-unlock-"));
const ACCESS_FILE = path.join(dir, "access.json");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
delete process.env.LH_AWS_CLI;
process.env.LH_ALLOWED_HOSTS = "learn.example.com,second.example.com";
const OWNER = "owner@example.invalid";
process.env.LH_ACCESS_EMAIL = OWNER;

const { proxy } = await import("../proxy.ts");
const session = await import("../src/server/access-session.ts");
const mail = await import("../src/server/access-mail.ts");
const { accessGate, safeNext } = await import("../src/server/access-gate.ts");
const http = await import("../src/server/access-http.ts");

const PASSWORD = "a long enough password";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
await session.setPassword(PASSWORD);

const sent: Mail[] = [];
const scratch = () => path.join(mkdtempSync(path.join(tmpdir(), "lh-unlock-file-")), "access.json");
const tokenOf = (text: string) => /\/unlock\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" };

/** A request as Caddy forwards it. */
const viaCaddy = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
	new NextRequest(`http://learn.example.com${p}`, {
		...init,
		headers: { host: "learn.example.com", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https", "x-forwarded-host": "learn.example.com", ...init.headers },
	});
const signIn = (password: string, ip: string) =>
	http.accessSignIn(viaCaddy("/login", { method: "POST", headers: { ...FORM, origin: "https://learn.example.com", "x-forwarded-for": ip }, body: form({ password }) }));
const getLogin = () => http.accessSignInPage(viaCaddy("/login", { headers: navigate }));
const getUnlock = (token?: string) => http.accessUnlockPage(viaCaddy(`/unlock${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`, { headers: navigate }));
const postUnlock = (fields: Record<string, string> = {}, headers: Record<string, string> = {}) =>
	http.accessUnlock(viaCaddy("/unlock", { method: "POST", headers: { ...FORM, origin: "https://learn.example.com", ...headers }, body: form(fields) }));

const state = () => session.readAccessState(ACCESS_FILE);
const change = (patch: Partial<AccessState>) => session.writeAccessState({ ...state(), ...patch }, ACCESS_FILE);
const lockNow = () => change({ locked: true, lockedAt: Date.now() });

beforeEach(() => {
	sent.length = 0;
	mail.setMailSender(async (message) => {
		sent.push(message);
	});
	process.env.LH_ACCESS_EMAIL = OWNER;
	change({ locked: false, lockedAt: null, failures: [], unlock: null, mailed: [] });
});

after(() => {
	mail.setMailSender();
	delete process.env.LH_ALLOWED_HOSTS;
	delete process.env.LH_ACCESS_EMAIL;
	delete process.env.LH_AWS_CLI;
});

describe("the unlock token", () => {
	const lockedFile = () => {
		const file = scratch();
		session.writeAccessState({ ...session.readAccessState(file), locked: true, lockedAt: 1, failures: [{ at: 1, client: "x" }] }, file);
		return file;
	};

	it("works once, and unlocks sign-in and clears the wrong-password count", () => {
		const file = lockedFile();
		const token = session.issueUnlockToken(1_000, file);
		assert.equal(session.unlockTokenValid(token, 2_000, file), true, "checking spends nothing");
		assert.equal(session.redeemUnlockToken(token, 2_000, file), true);
		const after = session.readAccessState(file);
		assert.equal(after.locked, false);
		assert.deepEqual(after.failures, []);
		assert.equal(after.unlock, null);
		assert.equal(session.redeemUnlockToken(token, 3_000, file), false, "the second use finds nothing");
	});

	it("is stored only as a hash", () => {
		const file = scratch();
		const token = session.issueUnlockToken(1_000, file);
		assert.equal(token.length, 43);
		assert.match(session.readAccessState(file).unlock!.hash, /^[0-9a-f]{64}$/);
		assert.ok(!readFileSync(file, "utf8").includes(token));
	});

	it("lasts 15 minutes", () => {
		const file = lockedFile();
		const token = session.issueUnlockToken(1_000, file);
		assert.equal(session.unlockTokenValid(token, 1_000 + 15 * MINUTE - 1, file), true);
		assert.equal(session.unlockTokenValid(token, 1_000 + 15 * MINUTE, file), false);
		assert.equal(session.redeemUnlockToken(token, 1_000 + 16 * MINUTE, file), false);
		assert.equal(session.readAccessState(file).locked, true, "an expired link unlocks nothing");
	});

	it("is replaced by a newer one", () => {
		const file = lockedFile();
		const first = session.issueUnlockToken(1_000, file);
		const second = session.issueUnlockToken(2_000, file);
		assert.equal(session.unlockTokenValid(first, 3_000, file), false);
		assert.equal(session.unlockTokenValid(second, 3_000, file), true);
	});

	it("refuses anything that is not the token", () => {
		const file = lockedFile();
		const token = session.issueUnlockToken(1_000, file);
		for (const wrong of ["", "x", `${token}x`, token.slice(1), token.toUpperCase(), "a".repeat(5000), undefined, null, 42, {}]) {
			assert.equal(session.unlockTokenValid(wrong, 2_000, file), false, String(wrong));
		}
		assert.equal(session.unlockTokenValid(token, 2_000, scratch()), false, "another file has no link");
	});

	it("is dropped by the server command's unlock and by a new password", async () => {
		const file = lockedFile();
		const first = session.issueUnlockToken(1_000, file);
		session.unlockSignIn(file);
		assert.equal(session.unlockTokenValid(first, 2_000, file), false);
		const second = session.issueUnlockToken(1_000, file);
		await session.setPassword("another long enough password", file);
		assert.equal(session.unlockTokenValid(second, 2_000, file), false);
	});
});

describe("the send limits", () => {
	const t0 = Date.UTC(2026, 10, 22, 12);

	it("allow one email per 15 minutes", () => {
		const file = scratch();
		assert.equal(session.mailWaitMs(t0, file), 0);
		session.recordMail(t0, file);
		assert.equal(session.mailWaitMs(t0 + MINUTE, file), 14 * MINUTE);
		assert.equal(session.mailWaitMs(t0 + 15 * MINUTE, file), 0);
	});

	it("allow five a day, counted over a rolling 24 hours", () => {
		const file = scratch();
		for (const minutes of [0, 15, 30, 45, 60]) session.recordMail(t0 + minutes * MINUTE, file);
		assert.equal(session.mailWaitMs(t0 + 76 * MINUTE, file), 24 * HOUR - 76 * MINUTE, "a sixth waits until the first rolls off");
		assert.equal(session.mailWaitMs(t0 + 24 * HOUR, file), 0);
	});

	it("keep only the newest five, and count a send that then failed", () => {
		const file = scratch();
		for (let i = 0; i < 8; i++) session.recordMail(t0 + i, file);
		assert.equal(session.readAccessState(file).mailed.length, 5);
	});
});

describe("where the email goes", () => {
	it("needs one plain address and an allowed host, and sends from no-reply@ the first host", () => {
		assert.deepEqual(mail.mailConfig({ LH_ACCESS_EMAIL: OWNER, LH_ALLOWED_HOSTS: "Learn.Example.com, other.example.com" }), { to: OWNER, from: "LearnHarness <no-reply@learn.example.com>" });
		assert.equal(mail.mailConfig({ LH_ALLOWED_HOSTS: "learn.example.com" }), null, "no address");
		assert.equal(mail.mailConfig({ LH_ACCESS_EMAIL: OWNER }), null, "no host to send from");
		assert.equal(mail.mailConfig({ LH_ACCESS_EMAIL: OWNER, LH_ALLOWED_HOSTS: "bad host" }), null);
	});

	it("refuses a list, a name part or anything a header could be split on", () => {
		for (const address of ["a@example.invalid, b@example.invalid", "Owner <a@example.invalid>", "a b@example.invalid", "a@example.invalid\nBcc: x@example.invalid", "a@@example.invalid", "plain", "@example.invalid", '"a"@example.invalid']) {
			assert.equal(mail.mailConfig({ LH_ACCESS_EMAIL: address, LH_ALLOWED_HOSTS: "learn.example.com" }), null, JSON.stringify(address));
		}
	});

	it("shows the server's own terminal only the first letter", () => {
		assert.equal(mail.maskEmail(OWNER), "o***@example.invalid");
	});
});

describe("sending through the AWS CLI", { skip: process.platform === "win32" }, () => {
	const fakeAws = (script: string) => {
		const bin = path.join(mkdtempSync(path.join(tmpdir(), "lh-aws-")), "aws");
		writeFileSync(bin, `#!/bin/sh\n${script}\n`);
		chmodSync(bin, 0o755);
		return bin;
	};

	it("runs `aws sesv2 send-email` with the whole message as one JSON argument, through no shell", async () => {
		const out = path.join(dir, "aws-args.txt");
		process.env.LH_AWS_CLI = fakeAws(`printf '%s\\n' "$@" > '${out}'`);
		mail.setMailSender();
		const text = "Line one\n\"quoted\" 'single' $(not run) `nor this` é\nhttps://learn.example.com/unlock?token=abc";
		await mail.sendMail({ to: OWNER, from: "LearnHarness <no-reply@learn.example.com>", subject: "Subject $(x)", text });
		const args = readFileSync(out, "utf8").split("\n");
		assert.deepEqual(args.slice(0, 4), ["sesv2", "send-email", "--no-cli-pager", "--cli-input-json"]);
		assert.deepEqual(JSON.parse(args[4]!), {
			FromEmailAddress: "LearnHarness <no-reply@learn.example.com>",
			Destination: { ToAddresses: [OWNER] },
			Content: { Simple: { Subject: { Data: "Subject $(x)", Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } },
		});
		assert.equal(args.length, 6, "five arguments and the final newline");
	});

	it("reports what the CLI said when it fails", async () => {
		process.env.LH_AWS_CLI = fakeAws("echo 'An error occurred (MessageRejected): Email address is not verified.' >&2; exit 254");
		mail.setMailSender();
		await assert.rejects(mail.sendMail({ to: OWNER, from: "x@example.invalid", subject: "s", text: "t" }), /Email address is not verified/);
	});

	it("reports a CLI that is not installed", async () => {
		process.env.LH_AWS_CLI = path.join(dir, "no-such-aws");
		mail.setMailSender();
		await assert.rejects(mail.sendMail({ to: OWNER, from: "x@example.invalid", subject: "s", text: "t" }), /ENOENT/);
	});

	after(() => {
		delete process.env.LH_AWS_CLI;
	});
});

describe("when sign-in locks", () => {
	it("emails one link at the moment of the lock, and the page says so", async () => {
		let last: Response | undefined;
		for (let i = 1; i <= 20; i++) last = await signIn("wrong password here", `198.51.100.${i}`);
		assert.equal(last!.status, 423);
		const page = await last!.text();
		assert.match(page, /An unlock link was emailed to you\. It works for 15 minutes/);
		assert.ok(page.includes('action="/unlock"'), "a button to ask again");
		assert.ok(!page.includes('type="password"'), "and no form to type in");
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.to, OWNER);
		assert.equal(sent[0]!.from, "LearnHarness <no-reply@learn.example.com>");
		assert.match(sent[0]!.text, /^Sign-in was locked after 20 wrong passwords within an hour, the latest from 198\.51\.100\.20\./);
		assert.match(sent[0]!.text, /https:\/\/learn\.example\.com\/unlock\?token=[A-Za-z0-9_-]{43}\n/);
		assert.equal(session.unlockTokenValid(tokenOf(sent[0]!.text), Date.now(), ACCESS_FILE), true);
		assert.equal(state().mailed.length, 1);
	});

	it("does not email again for a sign-in that arrives while it is locked", async () => {
		lockNow();
		assert.equal((await signIn(PASSWORD, "198.51.100.99")).status, 423);
		assert.equal(sent.length, 0);
	});

	it("says how to unlock on the server when there is no address to write to, and offers no button", async () => {
		delete process.env.LH_ACCESS_EMAIL;
		lockNow();
		for (const page of [await getLogin().text(), await (await postUnlock()).text(), await (await signIn(PASSWORD, "198.51.100.98")).text()]) {
			assert.match(page, /npm run access -- unlock/);
			assert.ok(!page.includes('action="/unlock"'));
		}
		assert.equal(sent.length, 0);
	});

	it("tells the truth when the email could not be sent, and still counts it", async (t) => {
		const logged: string[] = [];
		for (const level of ["info", "warn", "error"] as const) t.mock.method(console, level, (...args: unknown[]) => void logged.push(args.join(" ")));
		mail.setMailSender(async () => {
			throw new Error("Email address is not verified.");
		});
		lockNow();
		const page = await (await postUnlock()).text();
		assert.match(page, /could not be sent/);
		assert.match(page, /npm run access -- unlock/);
		assert.ok(logged.some((line) => line.includes("could not email the unlock link: Email address is not verified.")));
		assert.equal(state().mailed.length, 1, "a broken setup cannot be retried in a loop");
	});

	it("keeps the address and the link out of the log, and the link out of the file", async (t) => {
		const logged: string[] = [];
		for (const level of ["log", "info", "warn", "error"] as const) t.mock.method(console, level, (...args: unknown[]) => void logged.push(args.join(" ")));
		lockNow();
		await postUnlock();
		const token = tokenOf(sent[0]!.text);
		assert.ok(logged.some((line) => line.includes("unlock link emailed")));
		assert.ok(!logged.join("\n").includes(OWNER));
		assert.ok(!logged.join("\n").includes(token));
		assert.ok(!readFileSync(ACCESS_FILE, "utf8").includes(token));
		assert.ok(!readFileSync(ACCESS_FILE, "utf8").includes(OWNER));
	});
});

describe("the Email me an unlock link button", () => {
	it("is on the locked page and sends a link", async () => {
		lockNow();
		const login = await getLogin().text();
		assert.match(login, /<form method="post" action="\/unlock"><button type="submit">Email me an unlock link<\/button><\/form>/);
		assert.match(login, /Use the link emailed to you, or ask for a new one below/);
		const answer = await postUnlock();
		assert.equal(answer.status, 200);
		assert.match(await answer.text(), /An unlock link was emailed to you/);
		assert.equal(sent.length, 1);
		assert.match(sent[0]!.text, /^You asked for an unlock link \(from 203\.0\.113\.7\)\./);
	});

	it("does nothing, and sends nothing, when sign-in is not locked", async () => {
		const answer = await postUnlock();
		assert.equal(answer.status, 303);
		assert.equal(answer.headers.get("location"), "/login");
		assert.equal(sent.length, 0);
	});

	it("waits 15 minutes between emails, and a new link replaces the old", async () => {
		lockNow();
		await postUnlock();
		const first = tokenOf(sent[0]!.text);
		assert.match(await (await postUnlock()).text(), /emailed a little while ago\. You can ask for another in 15 minutes/);
		assert.equal(sent.length, 1);
		change({ mailed: state().mailed.map((at) => at - 16 * MINUTE) });
		assert.match(await (await postUnlock()).text(), /An unlock link was emailed to you/);
		assert.equal(sent.length, 2);
		assert.equal(session.unlockTokenValid(first, Date.now(), ACCESS_FILE), false);
		assert.equal(session.unlockTokenValid(tokenOf(sent[1]!.text), Date.now(), ACCESS_FILE), true);
	});

	it("stops at five a day, and says when to try again", async () => {
		lockNow();
		const now = Date.now();
		change({ mailed: [now - 12 * HOUR, now - 9 * HOUR, now - 6 * HOUR, now - 3 * HOUR, now - 20 * MINUTE] });
		assert.match(await (await postUnlock()).text(), /ask for another in 12 hours/);
		assert.equal(sent.length, 0);
	});
});

describe("the emailed link", () => {
	/** Locks, asks for a link, and returns its token. */
	const linkFor = async () => {
		lockNow();
		await postUnlock();
		return tokenOf(sent.at(-1)!.text);
	};

	it("opens a page that asks first, so a mail scanner's preview unlocks nothing", async () => {
		const token = await linkFor();
		for (let preview = 0; preview < 2; preview++) {
			const response = getUnlock(token);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
			const page = await response.text();
			assert.match(page, new RegExp(`<form method="post" action="/unlock"><input type="hidden" name="token" value="${token}"><button type="submit">Unlock</button></form>`));
			assert.ok(!/<script/i.test(page));
		}
		assert.equal(state().locked, true);
		assert.equal(session.unlockTokenValid(token, Date.now(), ACCESS_FILE), true);
	});

	it("unlocks when Unlock is pressed, once, and sign-in works again", async () => {
		const token = await linkFor();
		const done = await postUnlock({ token });
		assert.equal(done.status, 200);
		assert.match(await done.text(), /Sign-in is unlocked/);
		assert.equal(state().locked, false);
		assert.equal((await signIn(PASSWORD, "198.51.100.50")).status, 303);
		const replay = await postUnlock({ token });
		assert.equal(replay.status, 410);
		assert.match(await replay.text(), /expired or was already used/);
		assert.equal(getUnlock(token).status, 410);
	});

	it("does not unlock once it has expired, and says so on both pages", async () => {
		const token = await linkFor();
		change({ unlock: { ...state().unlock!, expiresAt: Date.now() - 1 } });
		assert.equal(getUnlock(token).status, 410);
		assert.equal((await postUnlock({ token })).status, 410);
		assert.equal(state().locked, true);
	});

	it("refuses a missing, wrong or damaged token", async () => {
		const token = await linkFor();
		for (const wrong of [undefined, "", "nope", `${token}x`, token.slice(0, 10), "a".repeat(300)]) {
			assert.equal(getUnlock(wrong).status, 410, String(wrong));
			assert.equal((await postUnlock({ token: wrong ?? "" })).status, 410, String(wrong));
		}
		assert.equal(state().locked, true);
	});

	it("escapes whatever is in the address, so it cannot break out of the page", async () => {
		await linkFor();
		const page = await getUnlock('"><script>alert(1)</script>').text();
		assert.ok(!page.includes("<script>"));
	});

	it("refuses an unlock that another site sent", async () => {
		const token = await linkFor();
		for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
			assert.equal((await postUnlock({ token }, headers)).status, 403, JSON.stringify(headers));
		}
		assert.equal((await postUnlock({}, { origin: "https://evil.example" })).status, 403, "and the button too");
		assert.equal(state().locked, true);
		assert.equal(sent.length, 1);
	});
});

describe("the gate", () => {
	it("lets /unlock through without a session, like /login, and never sends anyone on to it", () => {
		assert.deepEqual(accessGate(viaCaddy("/unlock?token=abc", { headers: navigate })), {});
		assert.equal(proxy(viaCaddy("/unlock?token=abc", { headers: navigate })).headers.get("x-middleware-next"), "1");
		assert.equal(safeNext("/unlock?token=abc"), "/");
	});

	it("still needs a session for everything else", () => {
		assert.equal(accessGate(viaCaddy("/api/chats")).refusal?.status, 401);
		assert.equal(accessGate(viaCaddy("/unlocked")).refusal?.status, 401, "only /unlock itself is open");
	});

	it("answers /unlock before a password exists with the not-set-up page", async () => {
		const before = state();
		change({ password: null });
		try {
			assert.match(await getUnlock("abc").text(), /not set up/);
			assert.equal((await postUnlock({ token: "abc" })).status, 409);
		} finally {
			change({ password: before.password });
		}
	});
});
