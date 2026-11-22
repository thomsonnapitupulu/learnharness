/**
 * The server command (scripts/access.ts), run for real against a scratch
 * sign-in file: a bad password gets a plain sentence, not a stack trace.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const run = (args: string[], input = "") => {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-access-cli-"));
	const result = spawnSync("npx", ["tsx", "scripts/access.ts", ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, LH_AUTH_FILE: path.join(dir, "auth.json"), LH_DATA_DIR: path.join(dir, "data") },
	});
	return { ...result, file: path.join(dir, "access.json") };
};

describe("npm run access -- set-password --stdin", () => {
	it("refuses a password that is too short or too long with one plain sentence", () => {
		for (const [password, message] of [["short", /at least 16 characters/], ["x".repeat(2000), /too long/]] as const) {
			const result = run(["set-password", "--stdin"], `${password}\n`);
			assert.equal(result.status, 1);
			assert.match(result.stderr, message);
			assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
			assert.equal(existsSync(result.file), false, "nothing was written");
		}
	});

	it("sets a password it is given, without printing it", () => {
		const result = run(["set-password", "--stdin"], "a long enough password\n");
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Password set\. Every device is signed out\./);
		assert.doesNotMatch(result.stdout, /a long enough password/);
		assert.doesNotMatch(readFileSync(result.file, "utf8"), /a long enough password/);
	});
});
