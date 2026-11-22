/** The real Electron main process (electron/main.cjs), booted in a VM with a fake Electron, in each server mode. No display needed. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);
const PREFIX = "lh-server-mode-";
const REMOTE = "https://learn.example.com";

type Frame = { url: string };
type Contents = EventEmitter & { id: number; mainFrame: Frame };
type Win = EventEmitter & { webContents: Contents; loaded: string[]; options: { webPreferences: { additionalArguments?: string[] } } };
type Prompt = { message: string; buttons: string[]; defaultId: number };
type MenuItem = { label?: string; click?: () => void; submenu?: MenuItem[] };
type Handler = (event: unknown, ...args: unknown[]) => unknown;
type HeaderHook = (details: unknown, callback: (result: { requestHeaders: Record<string, string> }) => void) => void;

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), PREFIX));
}
/** Removes a folder made by tempDir(), and refuses anything else. */
function cleanup(root: string): void {
	assert.ok(dirname(root) === tmpdir() && basename(root).startsWith(PREFIX), `refusing to remove ${root}`);
	rmSync(root, { recursive: true, force: true });
}
const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
/** Values made by the VM's code come from another realm, so deepEqual would not see them as equal to ours. */
const plain = <T,>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/** Boot main() against a user-data folder that holds `setting` as server.json (a string is written as it is). */
function boot(options: { setting?: unknown; env?: Record<string, string>; probes?: (Error | null)[]; answers?: number[]; failSave?: boolean } = {}) {
	const userData = tempDir();
	if (options.setting !== undefined) writeFileSync(join(userData, "server.json"), typeof options.setting === "string" ? options.setting : JSON.stringify(options.setting));
	const windows: Win[] = [], logs: string[] = [], probes: { url: string }[] = [], dialogs: unknown[][] = [], errorBoxes: unknown[][] = [];
	const spawned: unknown[][] = [], handlers = new Map<string, Handler>();
	const counts = { quit: 0, relaunch: 0, exits: 0, chatgpt: 0, subscriptions: 0 };
	let headerHook: HeaderHook | null = null, menu: MenuItem[] = [];
	let gate: Promise<void> | null = null, saveFails = options.failSave ?? false;
	const answers = [...(options.answers ?? [])], probeResults = [...(options.probes ?? [])];

	const app = Object.assign(new EventEmitter(), {
		setName() {}, getPath: (name: string) => (name === "userData" ? userData : `/fixture/${name}`), setPath() {}, requestSingleInstanceLock: () => false,
		quit() { counts.quit++; }, relaunch() { counts.relaunch++; }, whenReady: async () => {}, exit() { counts.exits++; }, isPackaged: false,
	});
	class FakeWindow extends EventEmitter {
		loaded: string[] = [];
		webContents: Contents;
		constructor(public options: Win["options"]) {
			super();
			windows.push(this as unknown as Win);
			this.webContents = Object.assign(new EventEmitter(), {
				id: windows.length, mainFrame: { url: "" }, send() {}, getZoomFactor: () => 1, setWindowOpenHandler() {},
				isDestroyed: () => false, isLoadingMainFrame: () => false,
			});
		}
		loadURL(url: string) { this.loaded.push(url); this.webContents.mainFrame.url = `${url}/`; }
		isDestroyed() { return false; } isMinimized() { return false; } show() {} focus() {} restore() {}
		setBackgroundColor() {} setTitleBarOverlay() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
		static fromWebContents(contents: unknown) { return windows.find((w) => w.webContents === contents) ?? null; }
		static getAllWindows() { return windows; }
	}
	const electron = {
		app, BrowserWindow: FakeWindow, nativeTheme: { themeSource: "system" }, shell: { openExternal() {} },
		ipcMain: { handle: (channel: string, fn: Handler) => { handlers.set(channel, fn); }, on: (channel: string, fn: Handler) => { handlers.set(channel, fn); } },
		Menu: { buildFromTemplate: (template: MenuItem[]) => { menu = template; return {}; }, setApplicationMenu() {} },
		dialog: {
			showMessageBox: async (...args: unknown[]) => { dialogs.push(args); if (gate) await gate; return { response: answers.shift() ?? 1 }; },
			showErrorBox: (...args: unknown[]) => { errorBoxes.push(args); },
		},
		session: {
			defaultSession: {
				setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
				webRequest: { onBeforeSendHeaders: (_filter: unknown, listener: HeaderHook) => { headerHook = listener; } },
			},
		},
	};
	const fakeChild = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true, send() {}, kill() {} });
	const context = {
		require: (id: string) => {
			switch (id) {
				case "electron": return electron;
				case "node:fs": return { mkdirSync() {}, appendFileSync() {}, existsSync: () => false };
				case "node:child_process": return { spawn: (...args: unknown[]) => { spawned.push(args); return fakeChild(); } };
				case "node:http": return { get: (_url: string, callback: (res: { statusCode: number; resume(): void }) => void) => { callback({ statusCode: 200, resume() {} }); return new EventEmitter(); } };
				case "./appearance-chrome.cjs": return { ...mainRequire(id), readAppearance: () => ({ mode: "dark", background: "#141414" }) };
				case "./chatgpt.cjs": return { ...mainRequire(id), createChatGPT: () => { counts.chatgpt++; return { pause() {}, resume() {}, close() {} }; }, fileStore: () => ({}) };
				case "./subscriptions.cjs": return { ...mainRequire(id), createSubscriptions: () => { counts.subscriptions++; return { ready: Promise.resolve(), pause() {}, resume() {}, close() {} }; } };
				case "./server-setting.cjs": {
					// The real module, except that saving can be made to fail (a data folder that cannot be written).
					const real = mainRequire(id);
					return { ...real, writeServerSetting: (...args: unknown[]) => { if (saveFails) throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }); return real.writeServerSetting(...args); } };
				}
				case "./dev-server-readiness.cjs": return { waitForDevServer: async (url: string) => { probes.push({ url }); const failure = probeResults.shift(); if (failure) throw failure; } };
				default: return mainRequire(id);
			}
		},
		process: Object.assign(new EventEmitter(), { platform: "darwin", argv: [], env: options.env ?? {}, execPath: "/fixture/electron", resourcesPath: "/fixture/resources" }),
		__dirname: dirname(mainFile), URL, AbortController, Buffer, setImmediate, setTimeout, clearTimeout, setInterval, clearInterval,
		console: { log: (line: string) => logs.push(line) },
	};
	runInNewContext(mainSource, context, { filename: mainFile });
	counts.quit = 0; // the lock check at load calls quit() once
	const done = runInNewContext("main()", context) as Promise<void>;

	const win = () => windows[0]!;
	return {
		userData, windows, logs, probes, dialogs, errorBoxes, spawned, counts, handlers, done, win,
		menu: () => menu,
		headerHook: () => headerHook!,
		failSaves: (on = true) => { saveFails = on; },
		hold: () => { let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; }); return () => { gate = null; release(); }; },
		/** An IPC event from the app's own page (or from a page that is not its main frame). */
		fromPage: (): unknown => ({ sender: win().webContents, senderFrame: win().webContents.mainFrame }),
		fromElsewhere: (): unknown => ({ sender: win().webContents, senderFrame: { url: win().webContents.mainFrame.url } }),
		call: async (channel: string, event: unknown, ...args: unknown[]) => plain(await handlers.get(channel)!(event, ...args)),
		saved: () => (existsSync(join(userData, "server.json")) ? (JSON.parse(readFileSync(join(userData, "server.json"), "utf8")) as { address: string }).address : null),
		/** What the network layer does to a request made by the app's page, as the hook sees it. */
		requestHeaders: (url: string, headers: Record<string, string>) => new Promise<Record<string, string>>((resolve) => {
			const contents = win().webContents;
			headerHook!({ url, webContentsId: contents.id, webContents: contents, frame: contents.mainFrame, initiatorOrigin: new URL(url).origin, requestHeaders: headers }, (result) => resolve(result.requestHeaders));
		}),
		finish: () => cleanup(userData),
	};
}

const headerNames = (headers: Record<string, string>) => Object.keys(headers).map((name) => name.toLowerCase());
const appMenu = (f: { menu(): MenuItem[] }) => f.menu()[0]!.submenu!;
const USE_COMPUTER = "Use This Computer Instead of the Server…";

describe("the desktop app with a server saved in Settings", () => {
	it("opens that address in its window and starts nothing of its own", async () => {
		const f = boot({ setting: { address: REMOTE } });
		await f.done;
		assert.deepEqual(f.probes, [{ url: REMOTE }]);
		assert.deepEqual(f.win().loaded, [REMOTE]);
		assert.deepEqual(plain(f.win().options.webPreferences.additionalArguments), ["--lh-server=remote"]);
		assert.equal(f.spawned.length, 0, "no child server");
		assert.equal(f.counts.chatgpt, 0);
		assert.equal(f.counts.subscriptions, 0);
		assert.ok(appMenu(f).some((item) => item.label === USE_COMPUTER), "the way back is in the app menu");
		f.finish();
	});

	it("never sends the desktop secret: a forged header is stripped and none is added, for the server and for anyone else", async () => {
		const f = boot({ setting: { address: REMOTE } });
		await f.done;
		for (const url of [`${REMOTE}/api/chats`, `${REMOTE}/chat/new`, "https://elsewhere.example/api/chats"]) {
			const headers = await f.requestHeaders(url, { Accept: "application/json", "X-LearnHarness-Desktop": "forged" });
			assert.equal(headerNames(headers).includes("x-learnharness-desktop"), false, url);
			assert.equal(headers.Accept, "application/json");
		}
		f.finish();
	});

	it("on this computer the same request does get the real secret, and a forged one is replaced (the rule is unchanged)", async () => {
		const f = boot();
		await f.done;
		const origin = f.win().loaded[0]!;
		const headers = await f.requestHeaders(`${origin}/api/chats`, { "X-LearnHarness-Desktop": "forged" });
		assert.match(headers["x-learnharness-desktop"] ?? "", /^[0-9a-f]{64}$/);
		assert.equal(headerNames(headers).filter((name) => name === "x-learnharness-desktop").length, 1);
		const elsewhere = await f.requestHeaders("https://elsewhere.example/api/chats", { "X-LearnHarness-Desktop": "forged" });
		assert.equal(headerNames(elsewhere).includes("x-learnharness-desktop"), false);
		f.finish();
	});

	it("answers no folder-picker request, and says the ChatGPT and subscription bridges are unavailable", async () => {
		const f = boot({ setting: { address: REMOTE } });
		await f.done;
		assert.equal(f.handlers.has("lh:attachment:pick"), false, "with a server nothing handles the folder picker");
		const chatgpt = (await f.call("lh:chatgpt:control", f.fromPage(), { op: "status" })) as { available: boolean };
		assert.equal(chatgpt.available, false);
		assert.deepEqual(await f.call("lh:subscriptions:control", f.fromPage(), { op: "status" }), []);
		f.finish();
	});

	it("tells the page which server it is on, but only the app's own main frame", async () => {
		const f = boot({ setting: { address: REMOTE } });
		await f.done;
		assert.deepEqual(await f.call("lh:server:get", f.fromPage()), { mode: "remote", address: REMOTE });
		await assert.rejects(async () => f.call("lh:server:get", f.fromElsewhere()), /Untrusted/);
		await assert.rejects(async () => f.call("lh:server:set", f.fromElsewhere(), null), /Untrusted/);
		assert.equal(f.dialogs.length, 0);
		f.finish();
	});

	it("refuses a page that has navigated away from the server, even in the main frame", async () => {
		const f = boot({ setting: { address: REMOTE }, answers: [0] });
		await f.done;
		f.win().webContents.mainFrame.url = "https://evil.example/login";
		await assert.rejects(async () => f.call("lh:server:get", f.fromPage()), /Untrusted/);
		await assert.rejects(async () => f.call("lh:server:set", f.fromPage(), null), /Untrusted/);
		assert.equal(f.dialogs.length, 0);
		f.finish();
	});

	it("goes back to this computer after a confirmation: saves nothing but removes the address, then restarts", async () => {
		const f = boot({ setting: { address: REMOTE }, answers: [0] });
		await f.done;
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), null), { ok: true });
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), "other.example.com"), { ok: false, cancelled: true }, "no second question while the app is restarting");
		assert.equal(f.dialogs.length, 1);
		const prompt = f.dialogs[0]![1] as Prompt; // [window, prompt]
		assert.match(prompt.message, /this computer/i);
		assert.equal(prompt.defaultId, 1, "Cancel is the default button");
		await settle();
		assert.equal(f.saved(), null, "the address is gone");
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [1, 1]);
		f.finish();
	});

	it("starts again on this computer when the server does not answer and that is chosen", async () => {
		const f = boot({ setting: { address: REMOTE }, probes: [new Error("did not respond")], answers: [1] });
		await f.done;
		const prompt = f.dialogs[0]![0] as Prompt; // no window yet: [prompt]
		assert.deepEqual(prompt.buttons, ["Try Again", "Use This Computer", "Quit"]);
		assert.match(prompt.message, new RegExp(REMOTE));
		assert.equal(f.windows.length, 0, "no empty window");
		assert.equal(f.saved(), null);
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [1, 1]);
		assert.ok(f.logs.some((line) => /server not reachable: did not respond/.test(line)));
		f.finish();
	});

	it("when the server does not answer and the choice cannot be saved, it says so and asks again (no app left without a window)", async () => {
		const f = boot({ setting: { address: REMOTE }, probes: [new Error("down"), new Error("still down")], answers: [1, 2], failSave: true });
		await f.done;
		assert.equal(f.dialogs.length, 2, "asked again after the failed save");
		assert.equal(f.errorBoxes.length, 1);
		assert.match(String(f.errorBoxes[0]![1]), /could not be saved/);
		assert.equal(f.saved(), REMOTE);
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [0, 1], "it ends by the person's own choice (Quit)");
		const g = boot({ setting: { address: REMOTE }, probes: [new Error("down"), null], answers: [1], failSave: true });
		await g.done;
		assert.deepEqual(g.win().loaded, [REMOTE], "and when the server answers the next time, the window opens");
		g.finish();
		f.finish();
	});

	it("tries the server again when asked, and opens the window once it answers", async () => {
		const f = boot({ setting: { address: REMOTE }, probes: [new Error("down"), new Error("still down"), null], answers: [0, 0] });
		await f.done;
		assert.equal(f.probes.length, 3);
		assert.equal(f.dialogs.length, 2);
		assert.deepEqual(f.win().loaded, [REMOTE]);
		assert.equal(f.saved(), REMOTE, "the choice is kept");
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [0, 0]);
		f.finish();
	});

	it("quits, and keeps the choice, when the server does not answer and Quit is pressed", async () => {
		const f = boot({ setting: { address: REMOTE }, probes: [new Error("down")], answers: [2] });
		await f.done;
		assert.equal(f.windows.length, 0);
		assert.equal(f.saved(), REMOTE);
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [0, 1]);
		f.finish();
	});

	it("the menu item asks the same question as Settings does", async () => {
		const f = boot({ setting: { address: REMOTE }, answers: [0] });
		await f.done;
		appMenu(f).find((item) => item.label === USE_COMPUTER)!.click!();
		await settle();
		assert.equal(f.dialogs.length, 1);
		assert.equal(f.saved(), null);
		assert.equal(f.counts.relaunch, 1);
		f.finish();
	});
});

describe("a choice that cannot be saved", () => {
	it("is told to the Settings row, restarts nothing, and the next try is not blocked", async () => {
		const f = boot({ answers: [0, 0] });
		await f.done;
		f.failSaves();
		const failed = (await f.call("lh:server:set", f.fromPage(), "learn.example.com")) as { ok: boolean; error?: string };
		assert.equal(failed.ok, false);
		assert.match(failed.error ?? "", /could not be saved/);
		await settle();
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [0, 0]);
		assert.equal(f.errorBoxes.length, 0, "the row shows it, not a second box");
		f.failSaves(false);
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), "learn.example.com"), { ok: true }, "not stuck on 'a question is open'");
		await settle();
		assert.equal(f.saved(), REMOTE);
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [1, 1]);
		f.finish();
	});

	it("is told by the menu item in a box, because the menu has no row", async () => {
		const f = boot({ setting: { address: REMOTE }, answers: [0], failSave: true });
		await f.done;
		appMenu(f).find((item) => item.label === USE_COMPUTER)!.click!();
		await settle();
		assert.equal(f.errorBoxes.length, 1);
		assert.match(String(f.errorBoxes[0]![1]), /could not be saved/);
		assert.equal(f.counts.relaunch, 0);
		f.finish();
	});
});

describe("the desktop app on this computer (nothing saved)", () => {
	it("starts its own server and has no way-back item in the menu", async () => {
		const f = boot();
		await f.done;
		assert.equal(f.spawned.length, 1);
		assert.equal(f.counts.chatgpt, 1);
		assert.equal(f.counts.subscriptions, 1);
		assert.equal(f.probes.length, 0, "the remote probe is not used");
		assert.deepEqual(plain(f.win().options.webPreferences.additionalArguments), ["--lh-server=local"]);
		assert.match(f.win().loaded[0]!, /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.equal(appMenu(f).some((item) => item.label === USE_COMPUTER), false);
		assert.equal(f.handlers.has("lh:attachment:pick"), true, "the folder picker is still answered on this computer");
		assert.deepEqual(await f.call("lh:server:get", f.fromPage()), { mode: "local", address: null });
		f.finish();
	});

	it("switches to a server only after a typed address is checked, confirmed and saved as one origin", async () => {
		const f = boot({ answers: [0] });
		await f.done;
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), "http://learn.example.com"), { ok: false, error: "Use an https:// address. Plain http is only for this computer." });
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), ""), { ok: false, error: "Enter the server's address." });
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), undefined), { ok: false, error: "Enter the server's address." });
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), null), { ok: false, error: "The app already uses this computer." });
		assert.equal(f.dialogs.length, 0, "nothing was asked, nothing saved");
		assert.equal(f.saved(), null);
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), "Learn.Example.com/chat/new"), { ok: true });
		assert.match((f.dialogs[0]![1] as Prompt).message, /https:\/\/learn\.example\.com\?$/);
		await settle();
		assert.equal(f.saved(), REMOTE);
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [1, 1]);
		f.finish();
	});

	it("Cancel changes nothing, and a second request while the question is open does not ask twice", async () => {
		const f = boot({ answers: [1] });
		await f.done;
		const release = f.hold();
		const first = f.call("lh:server:set", f.fromPage(), "learn.example.com");
		await settle();
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), "other.example.com"), { ok: false, cancelled: true });
		assert.equal(f.dialogs.length, 1);
		release();
		assert.deepEqual(await first, { ok: false, cancelled: true });
		await settle();
		assert.equal(f.saved(), null);
		assert.deepEqual([f.counts.relaunch, f.counts.quit], [0, 0]);
		f.finish();
	});

	it("a server file it cannot use is ignored with a log line, and the app starts on this computer", async () => {
		const f = boot({ setting: "{ not json" });
		await f.done;
		assert.equal(f.spawned.length, 1);
		assert.ok(f.logs.some((line) => /server setting ignored: server\.json is not valid JSON/.test(line)));
		f.finish();
	});
});

describe("the development shell", () => {
	it("keeps using LH_DEV_URL and ignores a saved server", async () => {
		const f = boot({ setting: { address: REMOTE }, env: { LH_DEV_URL: "http://localhost:3000" } });
		await f.done;
		assert.deepEqual(f.probes, [{ url: "http://localhost:3000" }]);
		assert.deepEqual(f.win().loaded, ["http://localhost:3000"]);
		assert.deepEqual(plain(f.win().options.webPreferences.additionalArguments), ["--lh-web-subscriptions"]);
		assert.deepEqual(await f.call("lh:server:get", f.fromPage()), { mode: "dev", address: null });
		assert.deepEqual(await f.call("lh:server:set", f.fromPage(), "learn.example.com"), { ok: false, error: "The development shell always uses its own server." });
		assert.equal(f.dialogs.length, 0);
		f.finish();
	});
});
