/**
 * Files sent from a browser to the server's disk (mobile epic, story 3).
 *
 * The agent's file tools read the server's disk, not the visitor's phone, so a
 * picked file is copied here first. It is saved as <data>/uploads/<id>/<name>,
 * the message carries that path, and the agent reads it as it reads any
 * attached path. Nothing serves an upload back.
 *
 * An upload belongs to the sessions whose records mention its id. Deleting a
 * session removes the uploads it mentions (chats.ts). An upload no session
 * ever mentioned (a draft that was never sent, a transfer cut off midway) is
 * removed after a week by sweepUploads.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PATHS } from "../../config.ts";
import { MAX_UPLOAD_BYTES, uploadTooLargeMessage } from "../../lib/upload-limits.ts";

/** up_<time in base 36>_<12 hex>. The time lets the sweep age an upload without
 * reading the disk; only an id of exactly this shape is ever turned into a path. */
const ID_SHAPE = "up_([0-9a-z]{6,12})_[0-9a-f]{12}";
const ID = new RegExp(`^${ID_SHAPE}$`);
const ID_IN_TEXT = new RegExp(`\\b${ID_SHAPE}\\b`, "g");

/** How long an upload that no session mentions is kept. */
export const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export class UploadError extends Error {
	constructor(readonly status: 400 | 413 | 500, message: string) {
		super(message);
	}
}

export interface SavedUpload {
	id: string;
	name: string;
	size: number;
	/** Absolute path on the server: what goes into the message. */
	path: string;
}

export function newUploadId(now: number = Date.now()): string {
	return `up_${now.toString(36)}_${randomBytes(6).toString("hex")}`;
}

function uploadIdTime(id: string): number | null {
	const match = ID.exec(id);
	return match ? Number.parseInt(match[1]!, 36) : null;
}

/** What is worth keeping of a file name: no folders, no control characters,
 * not a bare dot, and short enough for a file system (the end is kept, since
 * that is where the extension is). */
export function safeUploadName(raw: string | null | undefined): string {
	const last = (raw ?? "").slice(-512).split(/[\\/]/).at(-1) ?? "";
	const chars = Array.from(last.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "_").trim());
	while (Buffer.byteLength(chars.join("")) > 200) chars.shift();
	const name = chars.join("");
	return name === "" || /^\.+$/.test(name) ? "file" : name;
}

/** Streams a request body to <root>/<id>/<name>, counting the bytes actually
 * received (a Content-Length can lie). Nothing is left behind on a failure. */
export async function saveUpload(
	body: ReadableStream<Uint8Array> | null,
	rawName: string | null,
	{ root = PATHS.uploads, max = MAX_UPLOAD_BYTES, now = Date.now() }: { root?: string; max?: number; now?: number } = {},
): Promise<SavedUpload> {
	const name = safeUploadName(rawName);
	const id = newUploadId(now);
	const dir = path.join(root, id);
	const file = path.join(dir, name);
	let size = 0;
	const counted = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			size += chunk.length;
			done(size > max ? new UploadError(413, uploadTooLargeMessage(name)) : null, chunk);
		},
	});
	try {
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
		await pipeline(
			body ? Readable.fromWeb(body as never) : Readable.from([]),
			counted,
			fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
		);
	} catch (error) {
		await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
		if (error instanceof UploadError) throw error;
		console.warn(`[uploads] could not save an upload: ${error instanceof Error ? error.message : String(error)}`);
		throw new UploadError(500, "The file could not be saved on the server.");
	}
	return { id, name, size, path: file };
}

/** The upload ids a text mentions (a session record, as JSON). */
export function uploadIdsIn(text: string): string[] {
	return Array.from(new Set(text.match(ID_IN_TEXT) ?? []));
}

/** Removes these uploads. Anything that is not an upload id is ignored, so a
 * crafted string in a session cannot name another folder. */
export function removeUploads(ids: Iterable<string>, root: string = PATHS.uploads): number {
	let removed = 0;
	for (const id of ids) {
		if (!ID.test(id)) continue;
		try {
			fs.rmSync(path.join(root, id), { recursive: true, force: true });
			removed++;
		} catch (error) {
			console.warn(`[uploads] could not remove ${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return removed;
}

/** Removes uploads older than a week that no session mentions. It reads every
 * session record, and if one cannot be read it removes nothing: that record
 * might be the one that mentions an upload. Returns how many it removed. */
export async function sweepUploads(
	{ root = PATHS.uploads, chats = PATHS.chats, now = Date.now(), olderThanMs = ORPHAN_AFTER_MS }:
		{ root?: string; chats?: string; now?: number; olderThanMs?: number } = {},
): Promise<number> {
	let entries: string[];
	try { entries = await fsp.readdir(root); } catch { return 0; }
	const stale = new Set(entries.filter((id) => {
		const made = uploadIdTime(id);
		return made !== null && now - made >= olderThanMs;
	}));
	if (stale.size === 0) return 0;
	let records: string[];
	try { records = await fsp.readdir(chats); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return 0;
		records = [];
	}
	// Leftovers of a crashed write (<id>.json.tmp-…) hold a record's newest bytes: read them too.
	for (const record of records.filter((name) => name.includes(".json"))) {
		if (stale.size === 0) break;
		let text: string;
		try { text = await fsp.readFile(path.join(chats, record), "utf8"); } catch { return 0; }
		for (const id of uploadIdsIn(text)) stale.delete(id);
	}
	return removeUploads(stale, root);
}
