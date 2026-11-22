/** What the desktop preload bridge offers in each server mode. Runs the real preload.cjs in a VM, as file-path-preload.test.ts does. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const { modeArgument } = createRequire(import.meta.url)("../electron/server-setting.cjs") as { modeArgument(mode: string): string };

type Bridge = Record<string, unknown> & { server?: { get(): Promise<unknown>; set(address: string | null): Promise<unknown> } };

function preload(...windowArguments: string[]) {
	let bridge!: Bridge;
	const invoked: unknown[][] = [];
	const sent: unknown[][] = [];
	const electron = {
		contextBridge: { exposeInMainWorld(_name: string, surface: Bridge) { bridge = surface; } },
		webUtils: { getPathForFile: () => "/some/path" },
		ipcRenderer: {
			on() {}, removeListener() {},
			send: (...args: unknown[]) => { sent.push(args); },
			invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve("reply"); },
		},
	};
	runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
		process: { platform: "darwin", argv: ["/app/electron", "--no-sandbox", ...windowArguments] },
		require: (name: string) => { assert.equal(name, "electron"); return electron; },
	});
	return { bridge, invoked, sent, keys: Object.keys(bridge).sort() };
}

const EVERY_MODE = [
	"checkForUpdates", "dismissStartupMessage", "expandWindow", "getUpdateState", "getZoom", "installUpdate", "onOpenSettings",
	"onUpdateStatus", "onZoom", "platform", "setAppearance", "takeStartupMessage",
];
const ON_THIS_COMPUTER = ["chatgpt", "chooseAttachmentFolder", "getPathForFile", "subscriptions"];

describe("the preload bridge in each server mode", () => {
	it("without a server mode (the browser-like case and the dev shell) it is exactly what it was, with no server member", () => {
		assert.deepEqual(preload().keys, [...EVERY_MODE, ...ON_THIS_COMPUTER].sort());
		const dev = preload("--lh-web-subscriptions");
		assert.deepEqual(dev.keys, [...EVERY_MODE, ...ON_THIS_COMPUTER, "openSubscriptionBrowser", "subscriptionTransport"].sort());
		assert.equal(dev.bridge.server, undefined);
	});

	it("on this computer it is the full desktop surface plus the server member", () => {
		const f = preload(modeArgument("local"));
		assert.deepEqual(f.keys, [...EVERY_MODE, ...ON_THIS_COMPUTER, "server"].sort());
		assert.deepEqual(Object.keys(f.bridge.server!).sort(), ["get", "set"]);
		assert.deepEqual(f.invoked, [], "nothing is asked of the main process at load");
		assert.deepEqual(f.sent, []);
	});

	it("with a server it leaves out everything that assumes the server is on this computer", () => {
		const f = preload(modeArgument("remote"));
		assert.deepEqual(f.keys, [...EVERY_MODE, "server"].sort());
		for (const gone of ON_THIS_COMPUTER) assert.equal(gone in f.bridge, false, `${gone} must not be exposed`);
		assert.deepEqual(f.invoked, []);
		assert.deepEqual(f.sent, []);
	});

	it("the server member only forwards: get and set go to their own channels, with the address untouched", async () => {
		for (const mode of ["local", "remote"]) {
			const f = preload(modeArgument(mode));
			assert.equal(await f.bridge.server!.get(), "reply");
			assert.equal(await f.bridge.server!.set("learn.example.com"), "reply");
			assert.equal(await f.bridge.server!.set(null), "reply");
			assert.deepEqual(f.invoked, [["lh:server:get"], ["lh:server:set", "learn.example.com"], ["lh:server:set", null]]);
		}
	});

	it("the window argument main passes is the one the preload reads (the two files repeat the name)", () => {
		assert.equal(modeArgument("remote"), "--lh-server=remote");
		assert.equal("server" in preload("--lh-server=remote").bridge, true);
		assert.equal("getPathForFile" in preload("--lh-server=remote").bridge, false);
		assert.equal("getPathForFile" in preload("--lh-server=local").bridge, true);
	});
});
