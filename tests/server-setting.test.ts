/** The desktop app's server choice: the address rules, the saved file, and the words of its two dialogs. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";

type Typed = { ok: true; origin: string } | { ok: false; error: string };
const { normalizeServerAddress, readServerSetting, writeServerSetting, modeArgument, switchPrompt, unreachablePrompt, FILE } =
	createRequire(import.meta.url)("../electron/server-setting.cjs") as {
		normalizeServerAddress(input: unknown): Typed;
		readServerSetting(dir: string): { origin: string | null; ignored: string | null };
		writeServerSetting(dir: string, origin: string | null): void;
		modeArgument(mode: string): string;
		switchPrompt(next: string | null, title: string): { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
		unreachablePrompt(origin: string, title: string): { message: string; buttons: string[]; defaultId: number; cancelId: number };
		FILE: string;
	};

const PREFIX = "lh-server-setting-";
function scratch(): string {
	return mkdtempSync(join(tmpdir(), PREFIX));
}
/** Removes a folder made by scratch(), and refuses anything else. */
function cleanup(root: string): void {
	assert.ok(dirname(root) === tmpdir() && basename(root).startsWith(PREFIX), `refusing to remove ${root}`);
	rmSync(root, { recursive: true, force: true });
}

describe("typing a server address", () => {
	it("turns what people type into one https origin, dropping everything after the host", () => {
		for (const [typed, origin] of [
			["learn.heythomson.com", "https://learn.heythomson.com"],
			["  https://learn.heythomson.com/chat/new?x=1#top  ", "https://learn.heythomson.com"],
			["LEARN.Example.COM:443", "https://learn.example.com"],
			["https://learn.example.com:8443/", "https://learn.example.com:8443"],
		] as const) assert.deepEqual(normalizeServerAddress(typed), { ok: true, origin }, typed);
	});

	it("allows plain http only for this computer, and assumes it when no scheme is typed", () => {
		for (const [typed, origin] of [
			["localhost:3000", "http://localhost:3000"],
			["127.0.0.1:3001", "http://127.0.0.1:3001"],
			["[::1]:3000", "http://[::1]:3000"],
			["http://localhost:3000/login", "http://localhost:3000"],
			["https://localhost:8443", "https://localhost:8443"],
		] as const) assert.deepEqual(normalizeServerAddress(typed), { ok: true, origin }, typed);
		const plain = normalizeServerAddress("http://learn.heythomson.com");
		assert.equal(plain.ok, false);
		assert.match((plain as { error: string }).error, /https/);
	});

	it("refuses anything that is not a plain web address", () => {
		for (const typed of ["", "   ", null, undefined, 42, "ftp://learn.example.com", "file:///etc/passwd", "javascript:alert(1)", "https://learn.example.com@evil.example",
			"https://user:secret@learn.example.com", "https://learn example.com", "http://"]) {
			assert.equal(normalizeServerAddress(typed).ok, false, String(typed));
		}
	});

	it("what the confirmation shows is the origin that will be used, so a lookalike cannot hide behind a path or a backslash", () => {
		assert.deepEqual(normalizeServerAddress("https://evil.example\\@learn.heythomson.com"), { ok: true, origin: "https://evil.example" });
		assert.deepEqual(normalizeServerAddress("https://learn.heythomson.com.evil.example/learn.heythomson.com"), { ok: true, origin: "https://learn.heythomson.com.evil.example" });
		const lookalike = normalizeServerAddress("https://l\u0435arn.example.com"); // a Cyrillic "\u0435"
		assert.ok(lookalike.ok && /^https:\/\/xn--[a-z0-9-]+\.example\.com$/.test(lookalike.origin), "shown as punycode, never as a look-alike of learn.example.com");
	});
});

describe("the saved server", () => {
	it("is none when nothing was ever saved", () => {
		const dir = scratch();
		assert.deepEqual(readServerSetting(dir), { origin: null, ignored: null });
		assert.deepEqual(readServerSetting(join(dir, "missing")), { origin: null, ignored: null });
		cleanup(dir);
	});

	it("round-trips an address as a small file that only its owner can read", () => {
		const dir = scratch();
		writeServerSetting(dir, "https://learn.heythomson.com/anything");
		assert.deepEqual(JSON.parse(readFileSync(join(dir, FILE), "utf8")), { address: "https://learn.heythomson.com" });
		assert.deepEqual(readServerSetting(dir), { origin: "https://learn.heythomson.com", ignored: null });
		if (process.platform !== "win32") assert.equal(statSync(join(dir, FILE)).mode & 0o777, 0o600);
		writeServerSetting(dir, "http://localhost:3000");
		assert.deepEqual(readServerSetting(dir), { origin: "http://localhost:3000", ignored: null });
		assert.deepEqual(readdirSync(dir), [FILE], "no temporary file is left behind");
		cleanup(dir);
	});

	it("creates the data folder if it is not there yet", () => {
		const root = scratch();
		const dir = join(root, "not", "yet");
		writeServerSetting(dir, "https://learn.example.com");
		assert.equal(readServerSetting(dir).origin, "https://learn.example.com");
		cleanup(root);
	});

	it("null clears it, and clearing nothing is fine", () => {
		const dir = scratch();
		writeServerSetting(dir, "https://learn.example.com");
		writeServerSetting(dir, null);
		assert.equal(existsSync(join(dir, FILE)), false);
		assert.deepEqual(readServerSetting(dir), { origin: null, ignored: null });
		assert.doesNotThrow(() => writeServerSetting(dir, null));
		cleanup(dir);
	});

	it("refuses to save an address it would refuse to open, and leaves the old choice alone", () => {
		const dir = scratch();
		writeServerSetting(dir, "https://learn.example.com");
		assert.throws(() => writeServerSetting(dir, "http://learn.example.com"), /https/);
		assert.throws(() => writeServerSetting(dir, ""), /address/);
		assert.equal(readServerSetting(dir).origin, "https://learn.example.com");
		assert.deepEqual(readdirSync(dir), [FILE]);
		cleanup(dir);
	});

	it("an unusable file never stops the app from starting: it is ignored, and says why", () => {
		const dir = scratch();
		for (const [text, why] of [
			["{not json", /not valid JSON/],
			[JSON.stringify({ address: "http://learn.example.com" }), /https/],
			[JSON.stringify({ address: "" }), /address/],
			[JSON.stringify({}), /address/],
			["null", /address/],
		] as const) {
			writeFileSync(join(dir, FILE), text);
			const read = readServerSetting(dir);
			assert.equal(read.origin, null, text);
			assert.match(read.ignored ?? "", why, text);
		}
		rmSync(join(dir, FILE));
		mkdirSync(join(dir, FILE)); // a folder where the file should be: not "absent", but unreadable
		assert.match(readServerSetting(dir).ignored ?? "", /could not read/);
		cleanup(dir);
	});
});

describe("the words", () => {
	it("the window argument names the mode", () => {
		assert.equal(modeArgument("remote"), "--lh-server=remote");
		assert.equal(modeArgument("local"), "--lh-server=local");
	});

	it("switching asks first, names the server, says nothing is copied, and Cancel is the default", () => {
		const toServer = switchPrompt("https://learn.example.com", "LearnHarness");
		assert.match(toServer.message, /https:\/\/learn\.example\.com/);
		assert.match(toServer.detail, /restart/i);
		assert.match(toServer.detail, /Nothing is copied/);
		const toComputer = switchPrompt(null, "LearnHarness");
		assert.match(toComputer.message, /this computer/i);
		assert.match(toComputer.detail, /left alone/);
		for (const prompt of [toServer, toComputer]) {
			assert.equal(prompt.buttons.length, 2);
			assert.equal(prompt.buttons[1], "Cancel");
			assert.equal(prompt.defaultId, 1, "a stray Enter changes nothing");
			assert.equal(prompt.cancelId, 1);
			assert.notEqual(prompt.buttons[0], "Cancel");
		}
	});

	it("an unreachable server offers: try again, this computer, quit (and Try Again is the default)", () => {
		const prompt = unreachablePrompt("https://learn.example.com", "LearnHarness");
		assert.match(prompt.message, /https:\/\/learn\.example\.com/);
		assert.deepEqual(prompt.buttons, ["Try Again", "Use This Computer", "Quit"]);
		assert.equal(prompt.defaultId, 0);
		assert.equal(prompt.cancelId, 2);
	});
});
