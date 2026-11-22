/**
 * The hosted sign-in's building blocks (src/server/access-session.ts): the
 * password hash, signed session cookies, the per-address backoff and the lock.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isSensitivePath } from "../src/agent/tools/fs-shared.ts";
import {
	LOCK_FAILURES,
	LOCAL_SESSION_COOKIE,
	MIN_PASSWORD,
	SESSION_COOKIE,
	SESSION_IDLE_MS,
	SESSION_MAX_MS,
	clearedSessionCookie,
	cookieValue,
	createLimiter,
	generatePassword,
	hashPassword,
	issueSession,
	readAccessState,
	readSession,
	recordFailure,
	recordSignIn,
	sessionCookie,
	setPassword,
	signOutEverywhere,
	unlockSignIn,
	verifyPassword,
	writeAccessState,
} from "../src/server/access-session.ts";

const DAY = 24 * 60 * 60 * 1000;
const key = "ab".repeat(32);
const scratch = () => path.join(mkdtempSync(path.join(tmpdir(), "lh-access-")), "access.json");

describe("passwords", () => {
	it("verify only the password that was hashed", async () => {
		const stored = await hashPassword("correct horse battery");
		assert.equal(await verifyPassword("correct horse battery", stored), true);
		assert.equal(await verifyPassword("correct horse batterz", stored), false);
		assert.equal(await verifyPassword("", stored), false);
		assert.equal(await verifyPassword(undefined, stored), false);
		assert.equal(await verifyPassword("x".repeat(1025), stored), false);
		assert.equal(await verifyPassword("anything", null), false);
	});

	it("are salted, so equal passwords store differently", async () => {
		const [a, b] = await Promise.all([hashPassword("same password here"), hashPassword("same password here")]);
		assert.notEqual(a.salt, b.salt);
		assert.notEqual(a.hash, b.hash);
	});

	it("are generated in groups of four from an unambiguous alphabet", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const password = generatePassword();
			assert.match(password, /^([a-hjkmnp-z2-9]{4}-){5}[a-hjkmnp-z2-9]{4}$/);
			seen.add(password);
		}
		assert.equal(seen.size, 50);
	});
});

describe("the stored state", () => {
	it("reads as 'no password' when the file is missing, empty or not JSON", () => {
		const file = scratch();
		assert.equal(readAccessState(file).password, null);
		writeFileSync(file, "");
		assert.equal(readAccessState(file).password, null);
		writeFileSync(file, "{not json");
		assert.equal(readAccessState(file).password, null);
		writeFileSync(file, JSON.stringify({ password: { salt: 1, hash: 2 } }));
		assert.equal(readAccessState(file).password, null);
	});

	it("sets a password: private file, no password text, every old session ended", async () => {
		const file = scratch();
		await setPassword("a long enough password", file);
		const first = readAccessState(file);
		assert.ok(first.password);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.ok(!readFileSync(file, "utf8").includes("a long enough password"));
		const token = issueSession(first.sessionKey, Date.now(), Date.now());
		await setPassword("another long password", file);
		const second = readAccessState(file);
		assert.notEqual(second.sessionKey, first.sessionKey);
		assert.equal(readSession(second.sessionKey, token, Date.now()), null);
	});

	it("refuses a short password", async () => {
		await assert.rejects(setPassword("x".repeat(MIN_PASSWORD - 1), scratch()), /at least 16/);
	});

	it("signs out everywhere with a new key, and keeps the password", async () => {
		const file = scratch();
		await setPassword("a long enough password", file);
		const before = readAccessState(file).sessionKey;
		assert.equal(readAccessState(file).sessionKey, before);
		signOutEverywhere(file);
		const after = readAccessState(file).sessionKey;
		assert.notEqual(after, before);
		assert.equal(after.length, before.length);
		assert.ok(readAccessState(file).password, "the password survives");
	});
});

describe("the agent's file tools", () => {
	it("refuse access.json, and the temp file a crashed write could leave beside it", (t) => {
		const file = scratch();
		const home = path.join(tmpdir(), "lh-not-this-home");
		const authFile = path.join(path.dirname(file), "auth.json");
		assert.equal(isSensitivePath(file, home, authFile), true);
		assert.equal(isSensitivePath(path.join(path.dirname(file), "notes.json"), home, authFile), false, "an ordinary file beside it is not caught");
		let temp = "";
		const rename = fs.renameSync;
		t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
			temp = String(args[0]);
			return rename(...args);
		});
		writeAccessState(readAccessState(file), file);
		assert.match(path.basename(temp), /^access\.json\.tmp-[0-9a-f-]{36}$/, "this is the name the real writer uses");
		assert.equal(isSensitivePath(temp, home, authFile), true);
	});
});

describe("session cookies", () => {
	const now = Date.UTC(2026, 10, 22);

	it("round-trip", () => {
		assert.deepEqual(readSession(key, issueSession(key, now, now + 5), now + 5), { issuedAt: now, seenAt: now + 5 });
	});

	it("are refused when altered, signed with another key, or malformed", () => {
		const token = issueSession(key, now, now);
		const [payload, signature] = token.split(".") as [string, string];
		const forged = Buffer.from(JSON.stringify({ i: now, s: now + 1 })).toString("base64url");
		for (const bad of [
			`${forged}.${signature}`,
			`${payload}.${signature.slice(0, -2)}AA`,
			issueSession("cd".repeat(32), now, now),
			payload,
			".",
			"",
			"a.b.c",
			`${payload}.`,
			"x".repeat(600),
		]) assert.equal(readSession(key, bad, now), null, bad.slice(0, 40));
		assert.equal(readSession(key, undefined, now), null);
	});

	it("end 30 days after sign-in, or after 7 idle days", () => {
		const token = issueSession(key, now, now);
		assert.ok(readSession(key, token, now + SESSION_IDLE_MS - 1));
		assert.equal(readSession(key, token, now + SESSION_IDLE_MS), null);
		const kept = issueSession(key, now, now + 6 * DAY);
		assert.ok(readSession(key, kept, now + 12 * DAY), "being seen slides the idle window");
		const old = issueSession(key, now, now + 29 * DAY);
		assert.ok(readSession(key, old, now + 30 * DAY - 1));
		assert.equal(readSession(key, old, now + SESSION_MAX_MS), null, "but never past 30 days");
	});

	it("are refused when dated in the future or seen before they were issued", () => {
		assert.equal(readSession(key, issueSession(key, now + DAY, now + DAY), now), null);
		assert.equal(readSession(key, issueSession(key, now, now - 1), now), null);
	});

	it("go out as Secure __Host- cookies over HTTPS and plain ones on this machine", () => {
		const secure = sessionCookie("tok", now, now, true);
		assert.match(secure, new RegExp(`^${SESSION_COOKIE}=tok; Path=/; Max-Age=${7 * 24 * 3600}; Secure; HttpOnly; SameSite=Strict$`));
		const local = sessionCookie("tok", now, now, false);
		assert.match(local, new RegExp(`^${LOCAL_SESSION_COOKIE}=tok; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Strict$`));
		assert.ok(!local.includes("Secure"));
		assert.match(clearedSessionCookie(true), /^__Host-lh_session=; Path=\/; Max-Age=0; Secure;/);
	});

	it("never outlive the 30 days: Max-Age shrinks near the end", () => {
		const issued = now;
		const cookie = sessionCookie("tok", issued, issued + 29 * DAY + DAY / 2, true);
		assert.match(cookie, new RegExp(`Max-Age=${Math.floor(DAY / 2 / 1000)};`));
	});

	it("are found by name in a Cookie header", () => {
		const header = "a=1; lh_session=abc.def; b=2";
		assert.equal(cookieValue(header, "lh_session"), "abc.def");
		assert.equal(cookieValue(header, "__Host-lh_session"), undefined);
		assert.equal(cookieValue(null, "a"), undefined);
		assert.equal(cookieValue("x_lh_session=1", "lh_session"), undefined);
	});
});

describe("the backoff", () => {
	it("gives 5 free tries, then waits 30 s, 60 s, 2 min … capped at 15 min, per address", () => {
		const limiter = createLimiter();
		const t = 1_000_000;
		for (let i = 0; i < 5; i++) {
			assert.equal(limiter.waitMs("a", t), 0);
			limiter.attempt("a", t);
		}
		assert.equal(limiter.waitMs("a", t), 30_000);
		limiter.attempt("a", t);
		assert.equal(limiter.waitMs("a", t), 60_000);
		limiter.attempt("a", t);
		assert.equal(limiter.waitMs("a", t), 120_000);
		for (let i = 0; i < 10; i++) limiter.attempt("a", t);
		assert.equal(limiter.waitMs("a", t), 15 * 60_000);
		assert.equal(limiter.waitMs("a", t + 15 * 60_000), 0);
		assert.equal(limiter.waitMs("b", t), 0, "another address is unaffected");
		limiter.succeed("a");
		assert.equal(limiter.waitMs("a", t), 0);
	});
});

describe("the lock", () => {
	it("closes sign-in after 20 wrong passwords within an hour, and unlock reopens it", async () => {
		const file = scratch();
		await setPassword("a long enough password", file);
		const t = Date.UTC(2026, 10, 22);
		for (let i = 0; i < LOCK_FAILURES - 1; i++) assert.equal(recordFailure(`c${i}`, t + i, file).locked, false);
		assert.equal(recordFailure("last", t + 30, file).locked, true);
		assert.equal(readAccessState(file).locked, true);
		assert.equal(readAccessState(file).lockedAt, t + 30);
		unlockSignIn(file);
		assert.equal(readAccessState(file).locked, false);
		assert.deepEqual(readAccessState(file).failures, []);
	});

	it("does not close when the failures are spread over more than an hour", async () => {
		const file = scratch();
		await setPassword("a long enough password", file);
		const t = Date.UTC(2026, 10, 22);
		for (let i = 0; i < 30; i++) assert.equal(recordFailure("slow", t + i * 4 * 60_000, file).locked, false, `failure ${i}`);
	});

	it("keeps only the newest failures and the last sign-in", async () => {
		const file = scratch();
		await setPassword("a long enough password", file);
		for (let i = 0; i < 25; i++) recordFailure("x", 1000 + i * 3 * 60 * 60_000, file);
		assert.equal(readAccessState(file).failures.length, LOCK_FAILURES);
		recordSignIn("203.0.113.9", 42, file);
		assert.deepEqual(readAccessState(file).lastSignIn, { at: 42, client: "203.0.113.9" });
	});

	it("survives the state being written back as read", async () => {
		const file = scratch();
		await setPassword("a long enough password", file);
		const state = readAccessState(file);
		writeAccessState(state, file);
		assert.deepEqual(readAccessState(file), state);
	});
});
