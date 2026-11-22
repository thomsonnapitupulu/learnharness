/**
 * Manage the hosted server's sign-in from its shell (docs/mobile/login.md).
 *
 *   npm run access -- set-password [--stdin]   new password (generated, or one line from stdin); signs every device out
 *   npm run access -- sign-out-all             end every session
 *   npm run access -- unlock                   clear a lockout after too many wrong passwords
 *   npm run access -- status
 *   npm run access -- test-email               send a test email the way the unlock link is sent
 *
 * It reads and writes the access.json the server uses, which sits beside
 * LH_AUTH_FILE: run it as the service user with the service's environment
 * (LH_ACCESS_EMAIL, LH_ALLOWED_HOSTS and AWS_REGION matter to the email).
 */
import { ACCESS_FILE } from "../config.ts";
import { mailConfig, maskEmail, sendMail } from "../src/server/access-mail.ts";
import { generatePassword, MIN_PASSWORD, readAccessState, setPassword, signOutEverywhere, unlockSignIn } from "../src/server/access-session.ts";

const USAGE = "Usage: npm run access -- set-password [--stdin] | sign-out-all | unlock | status | test-email";
const NO_EMAIL = "No unlock email address: set LH_ACCESS_EMAIL (and LH_ALLOWED_HOSTS, whose first name is the sender's domain) in this shell, as the service has them.";

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
			if (fromStdin && password.length < MIN_PASSWORD) {
				console.error(`The password needs at least ${MIN_PASSWORD} characters.`);
				return 1;
			}
			await setPassword(password);
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
			const mail = mailConfig();
			console.log(`Unlock email:    ${mail ? `to ${maskEmail(mail.to)}, from ${mail.from}` : "not set up (needs LH_ACCESS_EMAIL and LH_ALLOWED_HOSTS in this shell)"}`);
			console.log(`Last email sent: ${when(state.mailedAt)}`);
			return 0;
		}
		case "test-email": {
			const mail = mailConfig();
			if (!mail) {
				console.error(NO_EMAIL);
				return 1;
			}
			try {
				await sendMail({ ...mail, subject: "LearnHarness test email", text: "This is a test of the unlock email. Nothing else to do.\n" });
			} catch (error) {
				console.error(`Could not send: ${error instanceof Error ? error.message : String(error)}`);
				return 1;
			}
			console.log(`Sent a test email to ${maskEmail(mail.to)} from ${mail.from}.`);
			return 0;
		}
		default:
			console.error(USAGE);
			return 1;
	}
}

process.exitCode = await main();
