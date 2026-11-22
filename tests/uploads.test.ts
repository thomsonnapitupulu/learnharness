/**
 * Uploads (src/server/uploads.ts and upload-http.ts): the file names, the
 * streaming save and its limit, the route behind the sign-in gate, and what
 * deleting a session or the sweep removes. The data location and the sign-in
 * file are scratch folders, set before anything reads config.ts.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "lh-uploads-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
process.env.LH_ALLOWED_HOSTS = "learn.example.com";

const { PATHS } = await import("../config.ts");
const uploads = await import("../src/server/uploads.ts");
const { createUploadRoute } = await import("../src/server/upload-http.ts");
const session = await import("../src/server/access-session.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { quoteFilePath } = await import("../src/core/file-paths.ts");
const { MAX_UPLOAD_BYTES } = await import("../lib/upload-limits.ts");
await session.setPassword("a long enough password");

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_ALLOWED_HOSTS;
});

const DAY = 24 * 60 * 60 * 1000;
let folders = 0;
/** A new empty folder inside the scratch one. */
const scratch = () => {
	const made = path.join(dir, `folder-${folders++}`);
	fs.mkdirSync(made);
	return made;
};
const stream = (...chunks: Buffer[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });

describe("file names", () => {
	it("keep the name and drop any folders", () => {
		assert.equal(uploads.safeUploadName("notes.pdf"), "notes.pdf");
		assert.equal(uploads.safeUploadName("IMG 0042 (1).HEIC"), "IMG 0042 (1).HEIC");
		assert.equal(uploads.safeUploadName("../../etc/passwd"), "passwd");
		assert.equal(uploads.safeUploadName("C:\\Users\\me\\a b.txt"), "a b.txt");
		assert.equal(uploads.safeUploadName("図表 ✓.png"), "図表 ✓.png");
	});

	it("never come out empty, all dots, or with a control character", () => {
		for (const raw of [null, undefined, "", " ", ".", "..", "...", "a/", "/", "\\"]) assert.equal(uploads.safeUploadName(raw), "file", String(raw));
		assert.equal(uploads.safeUploadName("a\nb\u0000c.txt"), "a_b_c.txt");
	});

	it("are shortened from the front, so the extension survives", () => {
		for (const stem of ["x".repeat(400), "図".repeat(300)]) {
			const name = uploads.safeUploadName(`${stem}.pdf`);
			assert.ok(Buffer.byteLength(name) <= 200, `${Buffer.byteLength(name)} bytes`);
			assert.ok(name.endsWith(".pdf"));
		}
	});

	it("can always be quoted into a message as a path", () => {
		for (const raw of ["a`b.txt", "``", "x\ny.txt", " lead.txt", "-rf", "a\u2028b"]) {
			quoteFilePath(path.join("/srv/lh/data/uploads/up_x", uploads.safeUploadName(raw))); // would throw if it could not
		}
	});
});

describe("saving an upload", () => {
	it("streams the body to <root>/<id>/<name> and says where", async () => {
		const root = scratch();
		const saved = await uploads.saveUpload(stream(Buffer.from("hello "), Buffer.from("world")), "folder/hello.txt", { root });
		assert.equal(saved.name, "hello.txt");
		assert.equal(saved.size, 11);
		assert.match(saved.id, /^up_[0-9a-z]+_[0-9a-f]{12}$/);
		assert.equal(saved.path, path.join(root, saved.id, "hello.txt"));
		assert.equal(fs.readFileSync(saved.path, "utf8"), "hello world");
		assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600, "private to the service user");
		assert.equal(fs.statSync(path.dirname(saved.path)).mode & 0o777, 0o700);
	});

	it("saves an empty file, with or without a body", async () => {
		const root = scratch();
		for (const body of [null, stream()]) {
			const saved = await uploads.saveUpload(body, "empty.txt", { root });
			assert.equal(saved.size, 0);
			assert.equal(fs.readFileSync(saved.path, "utf8"), "");
		}
	});

	it("keeps two files of the same name apart", async () => {
		const root = scratch();
		const [a, b] = await Promise.all([uploads.saveUpload(stream(Buffer.from("a")), "same.txt", { root }), uploads.saveUpload(stream(Buffer.from("b")), "same.txt", { root })]);
		assert.notEqual(a.path, b.path);
		assert.equal(fs.readFileSync(a.path, "utf8") + fs.readFileSync(b.path, "utf8"), "ab");
	});

	it("takes exactly the limit and refuses one byte more, counting what arrives, and leaves nothing behind", async () => {
		const root = scratch();
		await uploads.saveUpload(stream(Buffer.alloc(600), Buffer.alloc(400)), "fits.bin", { root, max: 1000 });
		assert.equal(fs.readdirSync(root).length, 1);
		await assert.rejects(
			uploads.saveUpload(stream(Buffer.alloc(600), Buffer.alloc(401)), "big.bin", { root, max: 1000 }),
			(error: unknown) => error instanceof uploads.UploadError && error.status === 413 && /big\.bin is larger than 64 MiB/.test(error.message),
		);
		assert.equal(fs.readdirSync(root).length, 1, "only the file that fit is there");
	});

	it("leaves nothing behind when the transfer breaks off", async (t) => {
		t.mock.method(console, "warn", () => {});
		const root = scratch();
		const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.alloc(10)); controller.error(new Error("socket hang up")); } });
		await assert.rejects(uploads.saveUpload(broken, "cut.bin", { root }), (error: unknown) => error instanceof uploads.UploadError && error.status === 500);
		assert.deepEqual(fs.readdirSync(root), []);
	});

	it("says nothing of the disk to the visitor when it cannot write", async (t) => {
		t.mock.method(console, "warn", () => {});
		const blocked = path.join(scratch(), "a-file");
		fs.writeFileSync(blocked, "not a folder");
		await assert.rejects(uploads.saveUpload(stream(Buffer.from("x")), "x.txt", { root: blocked }), (error: unknown) => error instanceof uploads.UploadError && error.status === 500 && error.message === "The file could not be saved on the server.");
	});
});

describe("upload ids", () => {
	it("are found in session text, once each, and nowhere else", () => {
		const a = uploads.newUploadId();
		const b = uploads.newUploadId();
		const text = JSON.stringify([{ content: `read \`/srv/lh/data/uploads/${a}/photo.jpg\` and ${b}` }, "up_short_0123456789ab", "xup_abc123_0123456789ab", a]);
		assert.deepEqual(uploads.uploadIdsIn(text).sort(), [a, b].sort());
		assert.deepEqual(uploads.uploadIdsIn("no uploads here"), []);
	});

	it("are removed by exact id only: anything else in a session's text names no folder", () => {
		const root = scratch();
		const outside = path.join(path.dirname(root), "outside");
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, "keep"), "x");
		const id = uploads.newUploadId();
		fs.mkdirSync(path.join(root, id));
		assert.equal(uploads.removeUploads(["../outside", "..", ".", "", `${id}/..`, "up_a_b", `../${path.basename(root)}`, id], root), 1);
		assert.ok(fs.existsSync(path.join(outside, "keep")));
		assert.ok(fs.existsSync(root));
		assert.equal(fs.existsSync(path.join(root, id)), false);
	});
});

describe("the sweep of uploads no session mentions", () => {
	const now = Date.UTC(2026, 10, 22);
	function setup() {
		const root = scratch();
		const chats = scratch();
		const make = (age: number) => {
			const id = uploads.newUploadId(now - age);
			fs.mkdirSync(path.join(root, id));
			fs.writeFileSync(path.join(root, id, "f.txt"), "x");
			return id;
		};
		return { root, chats, make, left: () => fs.readdirSync(root).sort() };
	}

	it("removes uploads older than a week that no session mentions, and keeps the rest", async () => {
		const { root, chats, make, left } = setup();
		const orphan = make(8 * DAY);
		const mentioned = make(30 * DAY);
		const fresh = make(2 * DAY);
		const inLeftover = make(9 * DAY);
		fs.writeFileSync(path.join(chats, "chat_1.json"), JSON.stringify({ messages: [{ content: `see ${root}/${mentioned}/f.txt` }] }));
		fs.writeFileSync(path.join(chats, "chat_2.json.tmp-crash"), `the newest bytes of a record mention ${inLeftover}`);
		fs.writeFileSync(path.join(chats, "notes.txt"), `${orphan} in a file that is not a session record does not count`);
		assert.equal(await uploads.sweepUploads({ root, chats, now }), 1);
		assert.deepEqual(left(), [fresh, inLeftover, mentioned].sort());
	});

	it("removes nothing when a session record cannot be read: it may be the one that mentions an upload", async () => {
		const { root, chats, make, left } = setup();
		const old = make(9 * DAY);
		fs.mkdirSync(path.join(chats, "unreadable.json")); // reading a folder as a file fails
		assert.equal(await uploads.sweepUploads({ root, chats, now }), 0);
		assert.deepEqual(left(), [old]);
	});

	it("with no sessions at all, every stale upload goes; with no uploads, nothing happens", async () => {
		const { root, make, left } = setup();
		make(9 * DAY);
		make(1 * DAY);
		assert.equal(await uploads.sweepUploads({ root, chats: path.join(dir, "no-such-sessions"), now }), 1);
		assert.equal(left().length, 1);
		assert.equal(await uploads.sweepUploads({ root: path.join(dir, "no-such-uploads"), chats: scratch(), now }), 0);
	});

	it("leaves folders that are not uploads alone", async () => {
		const { root, chats, left } = setup();
		fs.mkdirSync(path.join(root, "up_notanid"));
		fs.mkdirSync(path.join(root, "random"));
		assert.equal(await uploads.sweepUploads({ root, chats, now }), 0);
		assert.deepEqual(left(), ["random", "up_notanid"]);
	});
});

describe("the route", () => {
	const root = scratch();
	let sweeps = 0;
	const route = createUploadRoute({
		save: (body, name) => uploads.saveUpload(body, name, { root, max: 1000 }),
		sweep: async () => { sweeps++; return 0; },
	});
	const headers = (extra: Record<string, string> = {}) => ({ host: "learn.example.com", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https", "x-forwarded-host": "learn.example.com", ...extra });
	const signedIn = () => ({ cookie: `${session.SESSION_COOKIE}=${session.issueSession(session.readAccessState().sessionKey, Date.now(), Date.now())}` });
	const ask = (method: string, p: string, extra: Record<string, string> = {}, body: BodyInit | null = null) =>
		new Request(`http://learn.example.com${p}`, { method, headers: headers(extra), ...(body === null ? {} : { body, duplex: "half" }) } as RequestInit);
	const saved = () => fs.readdirSync(root).length;
	/** A body that must never be read. */
	const unreadable = () => new ReadableStream<Uint8Array>({ pull() { throw new Error("the body was read"); } });

	it("saves the body and answers with where it went", async () => {
		const response = await route.POST(ask("POST", "/api/uploads?name=week%203.pdf", signedIn(), Buffer.from("%PDF-1.4 text")));
		assert.equal(response.status, 201);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const body = (await response.json()) as { id: string; name: string; size: number; path: string };
		assert.equal(body.name, "week 3.pdf");
		assert.equal(body.size, 13);
		assert.equal(body.path, path.join(root, body.id, "week 3.pdf"));
		assert.equal(fs.readFileSync(body.path, "utf8"), "%PDF-1.4 text");
	});

	it("needs a session: without one nothing is read or saved", async () => {
		const before = saved();
		const response = await route.POST(ask("POST", "/api/uploads?name=a.txt", {}, unreadable()));
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "Sign in to LearnHarness first.", signIn: "/login" });
		const forged = await route.POST(ask("POST", "/api/uploads?name=a.txt", { cookie: `${session.SESSION_COOKIE}=${session.issueSession("cd".repeat(32), Date.now(), Date.now())}` }, unreadable()));
		assert.equal(forged.status, 401);
		assert.equal(saved(), before);
	});

	it("refuses a cross-site write and a host name that is not allowed, before reading anything", async () => {
		const before = saved();
		const refused: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }, { host: "evil.example.com", "x-forwarded-host": "evil.example.com" }];
		for (const extra of refused) {
			const response = await route.POST(ask("POST", "/api/uploads?name=a.txt", { ...signedIn(), ...extra }, unreadable()));
			assert.equal(response.status, 403, JSON.stringify(extra));
		}
		assert.equal(saved(), before);
	});

	it("refuses a declared size over the limit without reading the body", async () => {
		const before = saved();
		const response = await route.POST(ask("POST", "/api/uploads?name=film.mov", { ...signedIn(), "content-length": String(MAX_UPLOAD_BYTES + 1) }, unreadable()));
		assert.equal(response.status, 413);
		assert.match(((await response.json()) as { error: string }).error, /film\.mov is larger than 64 MiB/);
		assert.equal(saved(), before);
	});

	it("counts the bytes that arrive when the declared length lies, and keeps nothing", async () => {
		const before = saved();
		const response = await route.POST(ask("POST", "/api/uploads?name=big.bin", { ...signedIn(), "content-length": "10" }, Buffer.alloc(1001)));
		assert.equal(response.status, 413);
		assert.equal(saved(), before);
	});

	it("answers only POST (and OPTIONS), after the gate", async () => {
		for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"] as const) {
			const open = await route[method](ask(method, "/api/uploads", signedIn()));
			assert.equal(open.status, 405, method);
			assert.equal(open.headers.get("allow"), "OPTIONS, POST");
			assert.equal((await route[method](ask(method, "/api/uploads"))).status, 401, `${method} without a session`);
		}
		const options = route.OPTIONS(ask("OPTIONS", "/api/uploads", signedIn()));
		assert.equal(options.status, 204);
		assert.equal(options.headers.get("allow"), "OPTIONS, POST");
		assert.equal(route.OPTIONS(ask("OPTIONS", "/api/uploads"))?.status, 401);
	});

	it("tidies up in the background, at most once in six hours", async () => {
		sweeps = 0;
		const fresh = createUploadRoute({ save: (body, name) => uploads.saveUpload(body, name, { root, max: 1000 }), sweep: async () => { sweeps++; return 0; } });
		for (let i = 0; i < 3; i++) assert.equal((await fresh.POST(ask("POST", "/api/uploads?name=a.txt", signedIn(), Buffer.from("x")))).status, 201);
		assert.equal(sweeps, 1);
		const refused = createUploadRoute({ save: async () => { throw new Error("not reached"); }, sweep: async () => { sweeps++; return 0; } });
		await refused.POST(ask("POST", "/api/uploads?name=a.txt", {}, Buffer.from("x")));
		assert.equal(sweeps, 1, "a refused upload does not start a sweep");
	});
});

describe("deleting a session", () => {
	const user = (text: string) => ({ id: "u1", role: "user", content: text, timestamp: Date.now() }) as never;
	const make = (id: string) => {
		fs.mkdirSync(path.join(PATHS.uploads, id), { recursive: true });
		fs.writeFileSync(path.join(PATHS.uploads, id, "a.txt"), "x");
	};

	it("removes the uploads its messages mention, and no others", async () => {
		const mine = uploads.newUploadId();
		const alsoMine = uploads.newUploadId();
		const someoneElses = uploads.newUploadId();
		for (const id of [mine, alsoMine, someoneElses]) make(id);
		const chat = chatStore.createChat("with uploads");
		chatStore.saveMessages(chat.id, [user(`read ${quoteFilePath(path.join(PATHS.uploads, mine, "a.txt"))} and ${quoteFilePath(path.join(PATHS.uploads, alsoMine, "a.txt"))}`)]);
		const other = chatStore.createChat("another session");
		chatStore.saveMessages(other.id, [user(`read ${quoteFilePath(path.join(PATHS.uploads, someoneElses, "a.txt"))}`)]);

		const outcome = await deleteChatSession(chat.id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(path.join(PATHS.uploads, mine)), false);
		assert.equal(fs.existsSync(path.join(PATHS.uploads, alsoMine)), false);
		assert.equal(fs.existsSync(path.join(PATHS.uploads, someoneElses)), true, "the other session keeps its upload");
		assert.equal(chatStore.getChat(chat.id), null);
		assert.ok(chatStore.getChat(other.id));
	});

	it("keeps the uploads of a session that does not exist", async () => {
		const id = uploads.newUploadId();
		make(id);
		const missing = await deleteChatSession("chat_nope", "preserve-graph");
		assert.equal(missing.ok, false);
		assert.equal(fs.existsSync(path.join(PATHS.uploads, id)), true);
	});

	it("deletes a session without uploads exactly as before", async () => {
		const chat = chatStore.createChat("plain");
		chatStore.saveMessages(chat.id, [user("just talk")]);
		assert.equal((await deleteChatSession(chat.id, "preserve-graph")).ok, true);
		assert.equal(chatStore.getChat(chat.id), null);
	});
});
