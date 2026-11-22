/**
 * The unlock email (mobile epic, story 2; design in docs/mobile/login.md).
 * When sign-in locks, the owner gets one email with a link that unlocks it
 * once, within 15 minutes. The locked sign-in page can ask for another.
 *
 *  - The address is LH_ACCESS_EMAIL, set only in the server's environment and
 *    never in the repository. Without it nothing is sent, and the locked page
 *    says to run `npm run access -- unlock` on the server.
 *  - The mail goes out through Amazon SES by the AWS CLI (`aws sesv2
 *    send-email`), which signs with the EC2 instance's role: no keys, and no
 *    SDK in the app. The sender is no-reply@ the first LH_ALLOWED_HOSTS name,
 *    which must be a verified SES identity, and the link points at that same
 *    name over https, never at whatever Host a request used.
 *  - Limit, kept in access.json: one email per 15 minutes.
 */

import { execFile } from "node:child_process";
import { issueUnlockToken, mailWaitMs, recordMail } from "./access-session.ts";

export interface Mail {
	to: string;
	from: string;
	subject: string;
	text: string;
}
export type MailSender = (mail: Mail) => Promise<void>;
export interface MailConfig {
	to: string;
	from: string;
	/** The site's own name, for the link in the email. */
	host: string;
}
type Env = Record<string, string | undefined>;

/** One plain address: no name part, no list, nothing a header could be split on. */
const ADDRESS = /^[^\s@<>",;()[\]\\]+@[A-Za-z0-9.-]+$/;
const HOST = /^[a-z0-9.-]+$/;

/** Where to send and from, or null when the server has no address set. */
export function mailConfig(env: Env = process.env): MailConfig | null {
	const to = env.LH_ACCESS_EMAIL?.trim();
	const host = (env.LH_ALLOWED_HOSTS ?? "").split(",")[0]?.trim().toLowerCase();
	if (!to || !ADDRESS.test(to) || !host || !HOST.test(host)) return null;
	return { to, from: `LearnHarness <no-reply@${host}>`, host };
}

/** t***@example.com, for the server's own terminal. */
export function maskEmail(address: string): string {
	return address.replace(/^(.).*(@.*)$/, "$1***$2");
}

function sendWithAwsCli(mail: Mail): Promise<void> {
	const input = JSON.stringify({
		FromEmailAddress: mail.from,
		Destination: { ToAddresses: [mail.to] },
		Content: { Simple: { Subject: { Data: mail.subject, Charset: "UTF-8" }, Body: { Text: { Data: mail.text, Charset: "UTF-8" } } } },
	});
	return new Promise((resolve, reject) => {
		execFile(
			"aws",
			["sesv2", "send-email", "--no-cli-pager", "--cli-input-json", input],
			{ timeout: 15_000, maxBuffer: 64 * 1024 },
			(error, _stdout, stderr) => {
				if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 500)));
				else resolve();
			},
		);
	});
}

let sender: MailSender = sendWithAwsCli;
/** For tests: a stand-in for the AWS CLI. No argument restores it. */
export function setMailSender(next?: MailSender): void {
	sender = next ?? sendWithAwsCli;
}
export function sendMail(mail: Mail): Promise<void> {
	return sender(mail);
}

export function unlockMailText(reason: string, link: string): string {
	return [
		reason,
		"",
		"To unlock it, open this link and press Unlock. It works once, for 15 minutes:",
		"",
		link,
		"",
		"If this was not you, you can ignore this email. Nobody can sign in without the password, and sign-in stays locked until someone uses the link.",
		"You can also unlock it on the server with: npm run access -- unlock",
		"",
	].join("\n");
}

export type UnlockMail = "sent" | "failed" | "not-configured" | { waitMs: number };

/** What the CLI said, without the address: an SES rejection can name it. */
function withoutAddress(text: string, address: string): string {
	return text.split(address).join("(address)").replace(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "(address)");
}

/** Emails a fresh unlock link when an address is set and the 15-minute gap
 * allows, and says how that went. A failure is also logged, with what the CLI
 * said but never the address or the link. */
export async function emailUnlockLink(
	reason: string,
	{ env = process.env, now = Date.now(), file }: { env?: Env; now?: number; file?: string } = {},
): Promise<UnlockMail> {
	const config = mailConfig(env);
	if (!config) return "not-configured";
	const waitMs = mailWaitMs(now, file);
	if (waitMs > 0) return { waitMs };
	recordMail(now, file);
	const link = `https://${config.host}/unlock?token=${issueUnlockToken(now, file)}`;
	try {
		await sender({ to: config.to, from: config.from, subject: "LearnHarness sign-in is locked", text: unlockMailText(reason, link) });
		console.info("[access] unlock link emailed");
		return "sent";
	} catch (error) {
		const said = error instanceof Error ? error.message : String(error);
		console.error(`[access] could not email the unlock link: ${withoutAddress(said, config.to)}`);
		return "failed";
	}
}
