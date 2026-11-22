import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { FilePathDropZone } from "../components/file-path-drop-zone.tsx";
import { useDictationTarget } from "../components/dictation.tsx";
import { PathInput } from "../components/path-input.tsx";
import { readPathInput, restorePathSelection } from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";
import { MAX_UPLOAD_BYTES } from "../lib/upload-limits.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** No native DataTransfer/Selection in linkedom. These shims exercise React's
 * real bubbling handlers and the editor's logical caret contract, not OS drag. */
async function fixture({ desktop = true, claimed = true, onContentRoot }: {
	desktop?: boolean;
	claimed?: boolean;
	onContentRoot?: (element: HTMLElement | null) => void;
} = {}) {
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
	const resolved: File[] = [];
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
		aborted = false;
		open(_method: string, url: string) { this.url = url; }
		send() { requests.push(this); }
		abort() { this.aborted = true; this.onabort?.(); }
	}
	const requests: FakeXHR[] = [];
	const backingPaths = new Map<File, string | Error>();
	const appends: string[] = [];
	let byteReads = 0;
	let uploads = 0;
	let submits = 0;
	let keys = 0;
	let value = "readthis";
	const bridge = desktop ? { getPathForFile(file: File) {
		resolved.push(file);
		const result = backingPaths.get(file);
		if (result instanceof Error) throw result;
		return result ?? "";
	} } : undefined;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: () => { uploads++; throw new Error("No network expected for file drops"); },
		XMLHttpRequest: FakeXHR,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const oldBridge = Object.getOwnPropertyDescriptor(win, "lh");
	Object.defineProperty(win, "lh", { configurable: true, value: bridge });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	function Harness() {
		useDictationTarget((text) => appends.push(text), claimed);
		return <>
			<aside data-testid="sidebar">Sidebar</aside>
			<FilePathDropZone onContentRoot={onContentRoot}>
				<form onSubmit={(event) => { event.preventDefault(); submits++; }}>
					<PathInput data-testid="editor" value={value} onValueChange={(next) => { value = next; draw(); }} onKeyDown={() => { keys++; }} />
					<button type="button" data-testid="elsewhere">Elsewhere</button>
					<div data-testid="content">Content away from the input</div>
				</form>
			</FilePathDropZone>
		</>;
	}
	function draw() { root.render(<Harness />); }
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		if (oldBridge) Object.defineProperty(win, "lh", oldBridge);
		else delete (win as unknown as Record<string, unknown>).lh;
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>('[data-testid="editor"]')!;
	function file(name: string, path?: string | Error) {
		const result = new File(["synthetic bytes must never be read"], name, { type: "application/pdf" });
		for (const method of ["text", "arrayBuffer", "stream"] as const) {
			Object.defineProperty(result, method, { value: () => { byteReads++; throw new Error("No file content reads"); } });
		}
		if (path !== undefined) backingPaths.set(result, path);
		return result;
	}
	function transfer(files: File[], directories: number[] = [], types = ["Files"]) {
		return {
			types,
			files: Object.assign([...files], { item: (index: number) => files[index] ?? null }),
			items: files.map((file, index) => ({ kind: "file", type: file.type, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: directories.includes(index), isFile: !directories.includes(index) }) })),
			dropEffect: "none",
		};
	}
	async function event(type: string, dataTransfer = transfer([]), target: Element = doc.querySelector('[data-testid="content"]')!) {
		const event = Object.assign(new win.Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	}
	return {
		doc, editor, appends, resolved, file, transfer, event, requests,
		async progress(index: number, loaded: number, total: number) { await act(async () => { requests[index]!.upload.onprogress?.({ lengthComputable: true, loaded, total }); }); },
		async respond(index: number, status: number, body: unknown) {
			await act(async () => { Object.assign(requests[index]!, { status, response: body }); requests[index]!.onload?.(); });
		},
		async leave() { await cleanup?.(); cleanup = undefined; },
		get value() { return value; },
		get status() { return doc.querySelector('[role="status"]')?.textContent ?? ""; },
		focusEditor(offset: number) {
			editor.focus();
			restorePathSelection(editor, { anchor: offset, focus: offset });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		assertPathOnly() { assert.equal(byteReads, 0); assert.equal(uploads, 0); assert.equal(submits, 0); assert.equal(keys, 0); },
	};
}

test("desktop drop inserts quoted paths at the focused editor caret instead of the dictation claimant", async () => {
	const f = await fixture();
	f.focusEditor(4);
	const paths = ["/actual/course notes.pdf", "C:\\course\\chapter`one.pdf", "\\\\host\\share\\図.png"];
	const files = paths.map((path, index) => f.file(`display-name-${index}.pdf`, path));
	const dropped = await f.event("drop", f.transfer(files));
	assert.equal(dropped.defaultPrevented, true);
	assert.equal(f.value, `read ${paths.map(quoteFilePath).join(" ")} this`);
	assert.equal(readPathInput(f.editor), f.value);
	assert.equal(f.doc.activeElement, f.editor);
	assert.deepEqual(f.appends, [], "focused editor wins over the registered question field");
	assert.deepEqual(f.resolved, files, "only Electron's full path, never File.name, enters the draft");
	assert.equal(f.status, "", "successful file attachment is silent");
	f.assertPathOnly();
});

test("a successful drop clears an earlier failure without replacing it with a confirmation bubble", async () => {
	const f = await fixture();
	await f.event("drop", f.transfer([f.file("virtual.pdf")]));
	assert.match(f.status, /No local file paths were available/);
	await f.event("drop", f.transfer([f.file("valid.pdf", "/existing/valid.pdf")]));
	assert.deepEqual(f.appends, ["`/existing/valid.pdf`"]);
	assert.equal(f.doc.querySelector('[role="status"]'), null);
	f.assertPathOnly();
});

test("unfocused drop uses the dictation target registry, not the last focused editor", async () => {
	const f = await fixture();
	f.focusEditor(4);
	f.doc.querySelector<HTMLElement>('[data-testid="elsewhere"]')!.focus();
	const paths = ["~/notes one.pdf", "/tmp/notes`final`"];
	await f.event("drop", f.transfer(paths.map((path) => f.file("not-a-physical-path.pdf", path))));
	assert.deepEqual(f.appends, [paths.map(quoteFilePath).join(" ")]);
	assert.equal(f.value, "readthis", "saved editor caret must not override current default target");
	f.assertPathOnly();
});

test("browser drop prevents navigation, uploads each file, and puts the paths the server saved in the draft", async () => {
	const f = await fixture({ desktop: false });
	f.focusEditor(4);
	const transfer = f.transfer([f.file("week 3.pdf"), f.file("board.jpg")]);
	const enter = await f.event("dragenter", transfer);
	assert.equal(enter.defaultPrevented, true);
	assert.match(f.doc.querySelector('[data-testid="file-path-drop-indicator"]')!.textContent!, /Drop to attach files/);
	const over = await f.event("dragover", transfer);
	assert.equal(over.defaultPrevented, true);
	assert.equal(transfer.dropEffect, "copy");
	const drop = await f.event("drop", transfer);
	assert.equal(drop.defaultPrevented, true);
	assert.equal(f.doc.querySelector('[data-testid="file-path-drop-indicator"]'), null);
	assert.deepEqual(f.requests.map((request) => request.url), ["/api/uploads?name=week%203.pdf"], "one at a time, by File.name");
	assert.equal(f.status, "Uploading file 1 of 2… 0%");
	await f.progress(0, 5, 10);
	assert.equal(f.status, "Uploading file 1 of 2… 50%");
	await f.respond(0, 201, { path: "/srv/lh/data/uploads/up_a_000000000001/week 3.pdf" });
	assert.equal(f.status, "Uploading file 2 of 2… 0%");
	assert.equal(f.value, "readthis", "nothing enters the draft until they are all up");
	await f.respond(1, 201, { path: "/srv/lh/data/uploads/up_b_000000000002/board.jpg" });
	assert.equal(f.value, `read ${["/srv/lh/data/uploads/up_a_000000000001/week 3.pdf", "/srv/lh/data/uploads/up_b_000000000002/board.jpg"].map(quoteFilePath).join(" ")} this`);
	assert.equal(f.status, "", "success is silent, as on the desktop");
	assert.deepEqual(f.appends, []);
	assert.deepEqual(f.resolved, [], "no desktop bridge, so no local path is ever asked for");
	f.assertPathOnly();
});

test("a single browser upload names the file; with no editor focused the path goes to the page's own input", async () => {
	const f = await fixture({ desktop: false });
	await f.event("drop", f.transfer([f.file("notes.pdf")]));
	assert.equal(f.status, "Uploading notes.pdf… 0%");
	await f.respond(0, 201, { path: "/srv/lh/data/uploads/up_a_000000000001/notes.pdf" });
	assert.deepEqual(f.appends, ["`/srv/lh/data/uploads/up_a_000000000001/notes.pdf`"]);
	assert.equal(f.status, "");
	f.assertPathOnly();
});

test("a browser upload that fails says why and leaves the draft alone; with nowhere to put the path it says so", async () => {
	const f = await fixture({ desktop: false, claimed: false });
	await f.event("drop", f.transfer([f.file("a.pdf")]));
	await f.respond(0, 500, { error: "The file could not be saved on the server." });
	assert.equal(f.status, "The file could not be saved on the server.");
	assert.equal(f.value, "readthis");
	await f.event("drop", f.transfer([f.file("b.pdf")]));
	await f.respond(1, 201, { path: "/srv/lh/data/uploads/up_a_000000000001/b.pdf" });
	assert.match(f.status, /Open a chat to attach file paths/);
	assert.deepEqual(f.appends, []);
	f.assertPathOnly();
});

test("browser drop never uploads folders: they are named in a notice, and the files beside them still go", async () => {
	const f = await fixture({ desktop: false });
	await f.event("drop", f.transfer([f.file("a folder")], [0]));
	assert.equal(f.requests.length, 0);
	assert.equal(f.status, "Folders cannot be uploaded. Drop files instead.");
	await f.event("drop", f.transfer([f.file("a folder"), f.file("notes.pdf")], [0]));
	assert.deepEqual(f.requests.map((request) => request.url), ["/api/uploads?name=notes.pdf"]);
	await f.respond(0, 201, { path: "/srv/lh/data/uploads/up_a_000000000001/notes.pdf" });
	assert.deepEqual(f.appends, ["`/srv/lh/data/uploads/up_a_000000000001/notes.pdf`"]);
	assert.equal(f.status, "Folders cannot be uploaded, so only the files were attached.");
	f.assertPathOnly();
});

test("browser drop refuses a file over 64 MiB without sending it", async () => {
	const f = await fixture({ desktop: false });
	const big = f.file("film.mov");
	Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
	await f.event("drop", f.transfer([big]));
	assert.equal(f.requests.length, 0);
	assert.match(f.status, /film\.mov is larger than 64 MiB/);
	f.assertPathOnly();
});

test("leaving the page mid-upload stops the transfer and attaches nothing", async () => {
	const f = await fixture({ desktop: false });
	f.focusEditor(4);
	await f.event("drop", f.transfer([f.file("a.pdf"), f.file("b.pdf")]));
	await f.leave();
	assert.equal(f.requests[0]!.aborted, true);
	assert.equal(f.requests.length, 1, "the second file never starts");
	assert.equal(f.value, "readthis");
});

test("mixed files and directories retain one original path each in drop order; invalid paths are skipped", async () => {
	const f = await fixture();
	const files = [
		f.file("virtual.pdf"), f.file("bad.pdf", "relative.pdf"), f.file("broken.pdf", new Error("not backed")),
		f.file("folder", "/directory"), f.file("valid.pdf", "/existing/valid.pdf"),
		f.file("multiline.pdf", "/a\nb.pdf"), f.file("NUL.pdf", "/a\0b.pdf"), f.file("url.pdf", "file:///a.pdf"),
	];
	await f.event("drop", f.transfer(files, [3]));
	assert.deepEqual(f.appends, ["`/directory/` `/existing/valid.pdf`"]);
	assert.equal(f.resolved.includes(files[3]!), true, "a directory resolves through the same OS backing-path bridge");
	assert.match(f.status, /Some dropped items had no available file path/);
	f.assertPathOnly();
});

test("an empty folder attaches once with durable directory syntax, without enumerating descendants", async () => {
	const f = await fixture();
	f.focusEditor(4);
	const folder = f.file("empty folder", "/course/empty folder");
	const transfer = f.transfer([folder], [0]);
	transfer.items[0]!.webkitGetAsEntry = () => ({ isDirectory: true, isFile: false, createReader() { throw new Error("Must not traverse entries"); } });
	await f.event("drop", transfer);
	assert.equal(f.value, "read `/course/empty folder/` this");
	assert.deepEqual(f.resolved, [folder]);
	assert.equal(f.editor.querySelectorAll("[data-file-path-source]").length, 1);
	f.assertPathOnly();
});

test("only known directories gain markers: extensionless files and unavailable metadata are never guessed", async () => {
	const f = await fixture();
	const files = [f.file("README", "/course/README"), f.file("folder.pdf", "/course/folder.pdf"), f.file("unknown", "/course/unknown")];
	const transfer = f.transfer(files, [1]);
	transfer.items[2]!.webkitGetAsEntry = () => { throw new Error("No metadata"); };
	await f.event("drop", transfer);
	assert.deepEqual(f.appends, ["`/course/README` `/course/folder.pdf/` `/course/unknown`"]);
	f.assertPathOnly();
});

test("a drop with no backing paths or no destination has a truthful notice and stages nothing", async () => {
	const f = await fixture({ claimed: false });
	const missing = await f.event("drop", f.transfer([f.file("virtual.pdf")]));
	assert.equal(missing.defaultPrevented, true);
	assert.match(f.status, /No local file paths were available/);
	await f.event("drop", f.transfer([f.file("valid.pdf", "/existing/valid.pdf")]));
	assert.match(f.status, /Open a chat to attach file paths/);
	assert.deepEqual(f.appends, []);
	assert.equal(f.value, "readthis");
	f.assertPathOnly();
});

test("non-file drags stay native; sidebar file drops prevent navigation without attaching", async () => {
	const f = await fixture();
	const plain = f.transfer([], [], ["text/plain"]);
	for (const type of ["dragenter", "dragover", "drop"]) {
		assert.equal((await f.event(type, plain)).defaultPrevented, false);
	}
	const sidebar = f.doc.querySelector('[data-testid="sidebar"]')!;
	assert.equal((await f.event("drop", f.transfer([f.file("notes.pdf", "/existing/notes.pdf")]), sidebar)).defaultPrevented, true);
	assert.deepEqual(f.resolved, []);
	assert.deepEqual(f.appends, []);
	assert.equal(f.status, "");
	f.assertPathOnly();
});

test("nested enter/leave depth keeps the drop overlay until the zone is left; notice is dismissible", async () => {
	const f = await fixture({ desktop: false });
	const transfer = f.transfer([f.file("notes.pdf")]);
	await f.event("dragenter", transfer);
	await f.event("dragenter", transfer);
	await f.event("dragleave", transfer);
	assert.ok(f.doc.querySelector('[data-testid="file-path-drop-indicator"]'));
	await f.event("dragleave", transfer);
	assert.equal(f.doc.querySelector('[data-testid="file-path-drop-indicator"]'), null);
	await f.event("drop", transfer);
	assert.equal(f.status, "Uploading notes.pdf… 0%");
	await act(async () => { f.doc.querySelector<HTMLElement>('[aria-label="Dismiss attachment notice"]')!.click(); });
	assert.equal(f.status, "");
	f.assertPathOnly();
});

test("the host content root reports the real main column and clears on unmount", async () => {
	const seen: (HTMLElement | null)[] = [];
	const f = await fixture({ onContentRoot: (element) => { seen.push(element); } });
	const main = f.doc.querySelector<HTMLElement>("main")!;
	assert.equal(seen.length, 1);
	assert.equal(seen[0], main);
	assert.equal(main.contains(f.doc.querySelector('[data-testid="sidebar"]')), false);
	await cleanup!();
	cleanup = undefined;
	assert.deepEqual(seen, [main, null]);
});

test("production AppShell places the sidebar outside its content-only drop zone", () => {
	const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
	const shell = source.slice(source.indexOf("export function AppShell("));
	assert.match(shell, /<SessionsSidebar\s*\/>\s*<FilePathDropZone\b[^>]*>\{children\}<\/FilePathDropZone>/);
	assert.doesNotMatch(shell, /<FilePathDropZone\b[^>]*>[\s\S]*<SessionsSidebar/);
});
