/**
 * The composer's attach button (issue #285): the picker's twin of a file
 * drop. Picked files become quoted path chips at the caret through the
 * desktop bridge; in a browser they are uploaded and the path the server saved
 * each under is chipped instead (a fake XMLHttpRequest stands in for the
 * server). Same linkedom shims as file-path-drop-zone.test.tsx (no native
 * Selection there).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";
import { attachmentPopupPlacement, pathsForFiles } from "../components/attach-files-button.tsx";
import { restorePathSelection } from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { MAX_UPLOAD_BYTES } from "../lib/upload-limits.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture({ desktop = true } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 200, y: 600, left: 200, right: 240, top: 600, bottom: 640, width: 40, height: 40, toJSON() {} });
	const backingPaths = new Map<File, string>();
	/** The browser's XMLHttpRequest, as far as lib/upload-client.ts uses it. The test plays the server. */
	class FakeXHR {
		upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;
		responseType = "";
		status = 0;
		response: unknown = null;
		url = "";
		sent: unknown;
		aborted = false;
		open(_method: string, url: string) { this.url = url; }
		send(body: unknown) { this.sent = body; requests.push(this); }
		abort() { this.aborted = true; this.onabort?.(); }
	}
	const requests: FakeXHR[] = [];
	let pickerClicks = 0;
	let folderCalls = 0;
	let folderResult: string | null | Error = null;
	let byteReads = 0;
	let sends = 0;
	let value = "readthis";
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1000, innerHeight: 800,
		XMLHttpRequest: FakeXHR,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", {
		configurable: true,
		value: desktop ? {
			getPathForFile: (file: File) => backingPaths.get(file) ?? "",
			chooseAttachmentFolder: async () => { folderCalls++; if (folderResult instanceof Error) throw folderResult; return folderResult; },
		} : undefined,
	});
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	let controller!: InteractionLayersController;
	function Harness() {
		controller = useInteractionLayers();
		return <div data-testid="clipping-dock" data-attachment-composer="" style={{ overflow: "hidden" }}><Composer busy={false} value={value} onChange={(next) => { value = next; draw(); }} onSend={() => { sends++; }} onStop={() => {}} canSend /></div>;
	}
	function draw() { root.render(<InteractionLayersProvider><Harness /></InteractionLayersProvider>); }
	await act(async () => { draw(); });
	const picker = doc.querySelector<HTMLInputElement>('[data-testid="attach-files-input"]')!;
	picker.click = () => { pickerClicks++; };
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>("[data-file-path-input]")!;
	return {
		button: doc.querySelector<HTMLButtonElement>('[data-testid="attach-files"]')!,
		get value() { return value; },
		doc,
		controller,
		get pickerClicks() { return pickerClicks; },
		requests,
		async progress(index: number, loaded: number, total: number) { await act(async () => { requests[index]!.upload.onprogress?.({ lengthComputable: true, loaded, total }); }); },
		async respond(index: number, status: number, body: unknown) {
			await act(async () => { Object.assign(requests[index]!, { status, response: body }); requests[index]!.onload?.(); });
		},
		async fail(index: number) { await act(async () => { requests[index]!.onerror?.(); }); },
		get status() { return doc.querySelector('[role="status"]')?.textContent ?? ""; },
		get bars() { return Array.from(doc.querySelectorAll('[role="progressbar"]')).map((bar) => bar.getAttribute("aria-valuenow")); },
		async leave() { await cleanup?.(); cleanup = undefined; },
		get folderCalls() { return folderCalls; },
		get sends() { return sends; },
		setFolderResult(result: typeof folderResult) { folderResult = result; },
		async choice(label: string) {
			await act(async () => { Array.from(doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === label)!.click(); });
		},
		async resize() { await act(async () => { win.dispatchEvent(new win.Event("resize")); }); },
		async key(key: string) {
			const event = Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key });
			await act(async () => { controller.captureKeyDown(event as KeyboardEvent); doc.activeElement!.dispatchEvent(event); });
			return event;
		},
		get byteReads() { return byteReads; },
		file(name: string, path?: string) {
			const result = new File(["synthetic bytes must never be read"], name, { type: "application/pdf" });
			for (const method of ["text", "arrayBuffer", "stream"] as const) {
				Object.defineProperty(result, method, { value: () => { byteReads++; throw new Error("No file content reads"); } });
			}
			if (path !== undefined) backingPaths.set(result, path);
			return result;
		},
		caret(offset: number) {
			editor.focus();
			restorePathSelection(editor, { anchor: offset, focus: offset });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		async pick(files: File[]) {
			Object.defineProperty(picker, "files", { configurable: true, value: files });
			await act(async () => { picker.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
	};
}

describe("attachment popup placement", () => {
	it("centers content-sized choices over the paperclip and leaves 4px above the entire short/multiline composer", () => {
		for (const top of [540, 420]) {
			const placed = attachmentPopupPlacement({ left: 680, right: 720 }, { top }, 58, { width: 1000, height: 800 });
			assert.equal(placed.left + 58 / 2, 700);
			assert.equal(800 - placed.bottom, top - 4);
		}
	});
	it("contains choices and wider error notices at both viewport edges", () => {
		for (const width of [58, 256]) {
			for (const left of [0, 980]) {
				const placed = attachmentPopupPlacement({ left, right: left + 40 }, { top: 540 }, width, { width: 1000, height: 800 });
				assert.ok(placed.left >= 8 && placed.left + width <= 992);
			}
		}
	});
	it("caps to the room above the composer instead of flipping across it", () => {
		const placed = attachmentPopupPlacement({ left: 120, right: 160 }, { top: 70 }, 58, { width: 300, height: 800 });
		assert.equal(placed.maxHeight, 58);
		assert.equal(placed.bottom, 734);
		assert.equal(placed.maxWidth, 284);
	});
});

describe("composer attach button", () => {
	it("the choice menu owns one Escape; a newer modal covers it without dismissing it or submitting the composer", async () => {
		const f = await fixture();
		await act(async () => f.button.click());
		assert.equal(f.controller.getTopLayer()?.kind, "popup");
		const menu = f.doc.querySelector<HTMLElement>('[role="menu"]')!;
		const modal = f.doc.createElement("div"); f.doc.body.append(modal);
		let closed = 0;
		let retire!: () => void;
		await act(async () => { retire = f.controller.register({ id: "newer-modal", kind: "modal", ownerId: null, rootRef: { current: modal }, onClose: () => { closed++; retire(); return "closed"; } }); });
		assert.equal(f.controller.isElementEligible(menu), false);
		await act(async () => modal.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
		assert.equal(f.doc.querySelector('[role="menu"]') !== null, true, "outside events belonging to a covering modal leave the lower popup intact");
		await f.key("Escape");
		assert.equal(closed, 1);
		assert.equal(f.doc.querySelector('[role="menu"]') !== null, true, "the same Escape cannot close both owners");
		const escape = await f.key("Escape");
		assert.equal(escape.defaultPrevented, true);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.doc.activeElement === f.button, true);
		assert.equal(f.sends, 0);
		modal.remove();
	});

	it("pathsForFiles keeps rooted paths and skips files the bridge can't place", () => {
		const a = new File([""], "a.pdf");
		const b = new File([""], "b.png");
		const c = new File([""], "c.txt");
		const paths = new Map<File, string>([[a, "/notes/a.pdf"], [b, "relative/b.png"]]);
		const result = pathsForFiles([a, b, c], (file) => {
			const path = paths.get(file);
			if (!path) throw new Error("no path");
			return path;
		});
		assert.deepEqual(result, { paths: ["/notes/a.pdf"], skipped: 2 });
	});

	it("server render is the browser case: a working paperclip between the input and Send", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.match(html, /aria-label="Attach files"[^>]*aria-disabled="false"|aria-disabled="false"[^>]*aria-label="Attach files"/);
		assert.ok(!html.includes("aria-haspopup"), "no Files/Folder menu: the button opens the picker");
		const editor = html.indexOf("data-file-path-input");
		const attach = html.indexOf('data-testid="attach-files"');
		const send = html.indexOf('aria-label="Send"');
		assert.ok(editor >= 0 && editor < attach && attach < send, "the paperclip follows the input and precedes Send");
		assert.ok(html.includes('type="file"') && !html.includes("accept="), "any file type");
	});

	it("desktop: the button offers Files/Folder, and Files keeps multi-file any-type chips at the caret", async () => {
		const f = await fixture();
		assert.equal(f.button.getAttribute("aria-disabled"), "false");
		f.caret(4);
		await act(async () => { f.button.click(); });
		assert.equal(f.pickerClicks, 0);
		assert.deepEqual(Array.from(f.doc.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent), ["Files", "Folder"]);
		await f.choice("Files");
		assert.equal(f.pickerClicks, 1);
		const paths = ["/course/week 3.pdf", "/photos/board.jpg"];
		await f.pick([f.file("week 3.pdf", paths[0]), f.file("board.jpg", paths[1]), f.file("virtual.pdf")]);
		assert.equal(f.value, `read ${paths.map(quoteFilePath).join(" ")} this`);
		assert.equal(f.byteReads, 0, "paths only — file contents are never read");
	});

	it("Folder inserts exactly one directory path (including empty folders) at the saved caret, without file selection or submits", async () => {
		const f = await fixture();
		f.caret(4);
		f.setFolderResult("/course/empty folder");
		await act(async () => { f.button.click(); });
		await f.choice("Folder");
		assert.equal(f.value, "read `/course/empty folder/` this");
		assert.ok(f.doc.querySelector(".lucide-folder"));
		assert.equal(f.folderCalls, 1);
		assert.equal(f.pickerClicks, 0);
		assert.equal(f.byteReads, 0);
		assert.equal(f.sends, 0);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.doc.querySelector("[webkitdirectory]"), null);
	});

	for (const result of [null, "relative/folder", new Error("cancel/failure")]) it(`folder cancellation or error preserves the draft (${String(result)})`, async () => {
		const f = await fixture();
		f.caret(4);
		f.setFolderResult(result);
		await act(async () => { f.button.click(); });
		await f.choice("Folder");
		assert.equal(f.value, "readthis");
		assert.equal(f.sends, 0);
		assert.equal(f.pickerClicks, 0);
		assert.equal(f.doc.querySelector('[role="status"]') !== null, result !== null);
	});

	it("choices and errors portal outside the dock's clipping boundary, without removing dock clipping", async () => {
		const f = await fixture();
		const dock = f.doc.querySelector('[data-testid="clipping-dock"]')!;
		await act(async () => { f.button.click(); });
		const menu = f.doc.querySelector<HTMLElement>('[role="menu"]')!;
		assert.equal(menu.parentElement, f.doc.body);
		assert.equal(dock.contains(menu), false);
		assert.equal(menu.style.position, "fixed");
		assert.equal(menu.style.bottom, "204px");
		assert.notEqual(menu.style.visibility, "hidden");
		f.setFolderResult(new Error("fixture failure"));
		await f.choice("Folder");
		const notice = f.doc.querySelector<HTMLElement>('[role="status"]')!;
		assert.equal(notice.parentElement, f.doc.body);
		assert.equal(dock.contains(notice), false);
		assert.equal(notice.style.position, "fixed");
		assert.equal((dock as HTMLElement).style.overflow, "hidden");
		assert.equal(f.value, "readthis");
	});

	it("reanchors above the marked composer when its multiline boundary moves, not above the button", async () => {
		const f = await fixture();
		await act(async () => { f.button.click(); });
		const dock = f.doc.querySelector<HTMLElement>('[data-testid="clipping-dock"]')!;
		dock.getBoundingClientRect = () => ({ x: 100, y: 450, left: 100, right: 800, top: 450, bottom: 650, width: 700, height: 200, toJSON() {} });
		await f.resize();
		assert.equal(f.doc.querySelector<HTMLElement>('[role="menu"]')!.style.bottom, "354px");
	});

	it("paperclip menu focuses choices, supports arrows/Escape, and never submits a draft", async () => {
		const f = await fixture();
		f.caret(4);
		await act(async () => { f.button.click(); });
		assert.equal(f.doc.activeElement!.textContent, "Files");
		assert.equal((await f.key("ArrowDown")).defaultPrevented, true);
		assert.equal(f.doc.activeElement!.textContent, "Folder");
		await f.key("ArrowDown");
		assert.equal(f.doc.activeElement!.textContent, "Files");
		await f.key("End");
		assert.equal(f.doc.activeElement!.textContent, "Folder");
		await f.key("Home");
		assert.equal(f.doc.activeElement!.textContent, "Files");
		assert.equal((await f.key("Escape")).defaultPrevented, true);
		assert.equal(f.doc.activeElement, f.button);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.button.getAttribute("aria-expanded"), "false");
		assert.equal(f.value, "readthis");
		assert.equal(f.sends, 0);
	});

	it("cancelled Files selection preserves draft and opens no folder chooser", async () => {
		const f = await fixture();
		await act(async () => { f.button.click(); });
		await f.choice("Files");
		await f.pick([]);
		assert.equal(f.value, "readthis");
		assert.equal(f.folderCalls, 0);
		assert.equal(f.sends, 0);
	});

	it("browser: the paperclip opens the system picker straight away, with no menu", async () => {
		const f = await fixture({ desktop: false });
		assert.equal(f.button.getAttribute("aria-disabled"), "false");
		await act(async () => { f.button.click(); });
		assert.equal(f.pickerClicks, 1);
		assert.equal(f.doc.querySelector('[role="menu"]'), null);
		assert.equal(f.doc.querySelector('[role="status"]'), null);
		assert.equal(f.requests.length, 0, "picking nothing sends nothing");
		await f.pick([]);
		assert.equal(f.value, "readthis");
	});

	it("browser: picked files go up one after another with progress, then their server paths are chipped at the caret", async () => {
		const f = await fixture({ desktop: false });
		f.caret(4);
		await f.pick([f.file("week 3.pdf"), f.file("board.jpg")]);
		assert.deepEqual(f.requests.map((request) => request.url), ["/api/uploads?name=week%203.pdf"], "one at a time");
		assert.equal(f.requests[0]!.sent instanceof File, true, "the file itself is the body");
		assert.equal(f.requests[0]!.responseType, "json");
		assert.deepEqual(f.bars, ["0", "0"]);
		assert.match(f.status, /week 3\.pdf/);
		assert.equal(f.doc.querySelector<HTMLElement>('[role="status"]')!.parentElement, f.doc.body, "above the composer, outside its clipping dock");
		await f.progress(0, 5, 10);
		assert.deepEqual(f.bars, ["50", "0"]);
		await f.respond(0, 201, { path: "/srv/lh/data/uploads/up_a_000000000001/week 3.pdf" });
		assert.deepEqual(f.requests.map((request) => request.url), ["/api/uploads?name=week%203.pdf", "/api/uploads?name=board.jpg"]);
		assert.equal(f.value, "readthis", "nothing in the draft until the files are all up");
		await f.respond(1, 201, { path: "/srv/lh/data/uploads/up_b_000000000002/board.jpg" });
		assert.equal(f.value, `read ${["/srv/lh/data/uploads/up_a_000000000001/week 3.pdf", "/srv/lh/data/uploads/up_b_000000000002/board.jpg"].map(quoteFilePath).join(" ")} this`);
		assert.equal(f.status, "", "the progress goes away when they are in");
		assert.equal(f.byteReads, 0, "the page never reads the bytes itself; the browser sends the file");
		assert.equal(f.sends, 0);
	});

	it("browser: a file that fails says which and why, the others still attach, and the draft keeps its text", async () => {
		const f = await fixture({ desktop: false });
		f.caret(4);
		await f.pick([f.file("a.pdf"), f.file("b.pdf"), f.file("c.pdf")]);
		await f.respond(0, 201, { path: "/srv/lh/data/uploads/up_a_000000000001/a.pdf" });
		await f.fail(1);
		await f.respond(2, 500, { error: "The file could not be saved on the server." });
		assert.equal(f.value, `read ${quoteFilePath("/srv/lh/data/uploads/up_a_000000000001/a.pdf")} this`);
		assert.match(f.status, /b\.pdf could not be sent\. Check the connection/);
		assert.match(f.status, /The file could not be saved on the server\./);
		assert.equal(f.doc.querySelector('[role="progressbar"]'), null);
		await act(async () => { f.doc.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); });
		assert.equal(f.status, "", "tapping elsewhere dismisses the notice");
	});

	it("browser: a signed-out session and a too-large answer say so in words", async () => {
		const f = await fixture({ desktop: false });
		await f.pick([f.file("a.pdf")]);
		await f.respond(0, 401, { error: "Sign in to LearnHarness first.", signIn: "/login" });
		assert.match(f.status, /You were signed out\. Sign in again, then attach a\.pdf\./);
		await f.pick([f.file("b.pdf")]);
		await f.respond(1, 413, null);
		assert.match(f.status, /b\.pdf is larger than 64 MiB/);
		assert.equal(f.value, "readthis");
	});

	it("browser: every failure names the file, and a transfer that outlasts the server's 5 minutes says so", async () => {
		const f = await fixture({ desktop: false });
		await f.pick([f.file("slow.pdf")]);
		await f.respond(0, 408, null);
		assert.match(f.status, /slow\.pdf took longer than 5 minutes to send, so it was stopped\. Try again on a faster connection, or with a smaller file\./);
		await f.pick([f.file("a.pdf")]);
		await f.respond(1, 403, { error: "Cross-site writes are not allowed." });
		assert.equal(f.status, "a.pdf: Cross-site writes are not allowed.");
		await f.pick([f.file("b.pdf")]);
		await f.respond(2, 500, { error: "The file could not be saved on the server." });
		assert.equal(f.status, "b.pdf: The file could not be saved on the server.");
		await f.pick([f.file("c.pdf")]);
		await f.respond(3, 502, null);
		assert.equal(f.status, "c.pdf could not be attached (error 502).");
	});

	it("browser: the progress panel does not announce every percent to a screen reader", async () => {
		const f = await fixture({ desktop: false });
		await f.pick([f.file("a.pdf")]);
		const panel = f.doc.querySelector<HTMLElement>('[data-testid="attachment-popup"]')!;
		assert.equal(panel.getAttribute("aria-live"), "off", "while sending");
		assert.equal(f.doc.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"), "0", "the bar still carries its value");
		await f.respond(0, 500, { error: "The file could not be saved on the server." });
		const notice = f.doc.querySelector<HTMLElement>('[data-testid="attachment-popup"]')!;
		assert.equal(notice.getAttribute("aria-live"), null, "a failure is announced, as a status is");
	});

	it("browser: a file over 64 MiB is refused here, without a request", async () => {
		const f = await fixture({ desktop: false });
		const big = f.file("film.mov");
		Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
		await f.pick([big]);
		assert.equal(f.requests.length, 0);
		assert.match(f.status, /film\.mov is larger than 64 MiB/);
		const edge = f.file("edge.bin");
		Object.defineProperty(edge, "size", { value: MAX_UPLOAD_BYTES });
		await f.pick([edge]);
		assert.equal(f.requests.length, 1, "exactly 64 MiB is allowed");
	});

	it("browser: a second pick while files are still going up is ignored", async () => {
		const f = await fixture({ desktop: false });
		await f.pick([f.file("a.pdf")]);
		await act(async () => { f.button.click(); });
		assert.equal(f.button.getAttribute("aria-disabled"), "true");
		assert.equal(f.pickerClicks, 0, "the picker does not open on top of a transfer");
		await f.pick([f.file("b.pdf")]);
		assert.equal(f.requests.length, 1);
	});

	it("browser: leaving the page mid-upload stops the transfer and puts nothing in the draft", async () => {
		const f = await fixture({ desktop: false });
		await f.pick([f.file("a.pdf"), f.file("b.pdf")]);
		await f.leave();
		assert.equal(f.requests[0]!.aborted, true);
		assert.equal(f.requests.length, 1, "the second file never starts");
		assert.equal(f.value, "readthis");
	});
});
