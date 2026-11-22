/**
 * Manage the hosted server's sign-in from its shell (docs/mobile/login.md).
 *
 *   npm run access -- set-password [--stdin]   new password (generated, or one line from stdin); signs every device out
 *   npm run access -- sign-out-all             end every session
 *   npm run access -- unlock                   clear a lockout after too many wrong passwords
 *   npm run access -- status
 *
 * It reads and writes the access.json the server uses, which sits beside
 * LH_AUTH_FILE: run it as the service user with the service's environment.
 */
import { ACCESS_FILE } from "../config.ts";
import { generatePassword, readAccessState, setPassword, signOutEverywhere, unlockSignIn } from "../src/server/access-session.ts";

const USAGE = "Usage: npm run access -- set-password [--stdin] | sign-out-all | unlock | status";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function when(at: number | null): string {
	return at === null ? "never" : new Date(at).toISOString();
}

async function main(): Promise<number> {
	const [command, ...flags] = process.argv.slice(2);
	if (process.getuid?.() === 0 && command !== "status") {
		console.warn("Warning: running as root. The server runs as another user and may not be able to read the file this writes. Use: sudo -u <service user> …\n");
	}
	switch (command) {
		case "set-password": {
			const fromStdin = flags.includes("--stdin");
			const password = fromStdin ? await readStdin() : generatePassword();
			try {
				await setPassword(password);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				return 1;
			}
			console.log("Password set. Every device is signed out.");
			if (!fromStdin) console.log(`\n  ${password}\n\nSave it in your password manager now. It is not stored and cannot be shown again.`);
			return 0;
		}
		case "sign-out-all":
			signOutEverywhere();
			console.log("Every device is signed out.");
			return 0;
		case "unlock":
			unlockSignIn();
			console.log("Sign-in is unlocked.");
			return 0;
		case "status": {
			const state = readAccessState();
			console.log(`File:            ${ACCESS_FILE}`);
			console.log(`Sign-in:         ${state.password ? "on" : "off (no password yet; the server only answers on itself)"}`);
			console.log(`Locked:          ${state.locked ? `yes, since ${when(state.lockedAt)}` : "no"}`);
			console.log(`Last sign-in:    ${state.lastSignIn ? `${when(state.lastSignIn.at)} from ${state.lastSignIn.client}` : "never"}`);
			console.log(`Wrong passwords: ${state.failures.length} recent${state.failures.length ? `, latest ${when(state.failures.at(-1)!.at)} from ${state.failures.at(-1)!.client}` : ""}`);
			return 0;
		}
		default:
			console.error(USAGE);
			return 1;
	}
}

process.exitCode = await main();
