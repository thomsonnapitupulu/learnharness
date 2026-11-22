import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { RowMenuButton } from "../components/row-menu-button.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { SidebarFolderRow } from "../components/sidebar-folders.tsx";
import type { ChatListItem } from "../src/core/index.ts";

// Mobile epic, story 6: the actions a mouse reaches with a right click (rename, export, delete a session or a
// folder; delete a graph node) have a visible way in on a touch screen, and the small controls on the graph and
// in the delete dialogs are big enough to hit.

const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
const classes = (html: string, tag = "button") => (html.match(new RegExp(`<${tag}\\b[^>]*\\bclass="([^"]*)"`))?.[1] ?? "").split(/\s+/);

const chat = (overrides: Partial<ChatListItem> = {}): ChatListItem => ({
	id: "c1", title: "Test session", kind: "teach", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
	messageCount: 4, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, ...overrides,
});
const folder = { id: "f1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" };
const folderRow = (props: Partial<React.ComponentProps<typeof SidebarFolderRow>> = {}) => renderToStaticMarkup(
	<SidebarFolderRow folder={folder} depth={0} open={false} dropActive={false} renaming={false} draggable
		onToggle={() => {}} onContextMenu={() => {}} onRename={async () => {}} onRenameDone={() => {}} {...props} />,
);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** Mounts an element in a linkedom window; the globals React needs are put back afterwards. */
async function mount(element: React.ReactElement) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event })) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	await act(async () => { root.render(element); });
	return { doc, win };
}

describe("the ⋯ button on a sidebar row", () => {
	const button = (open = false) => renderToStaticMarkup(<RowMenuButton label="Actions for Physics" open={open} testId="row-menu" onClick={() => {}} />);

	it("is a named button: closed until its menu is open", () => {
		const html = button();
		assert.match(html, /^<button\b[^>]*\btype="button"/);
		assert.match(html, /aria-label="Actions for Physics"/);
		assert.match(html, /data-testid="row-menu"/);
		assert.match(html, /aria-expanded="false"/);
		assert.match(button(true), /aria-expanded="true"/);
		assert.match(html, /<svg[^>]*aria-hidden="true"/, "the dots are decoration; the name is the label");
	});

	it("shows only when the pointer is a finger: hidden for a mouse, flex for touch", () => {
		const cls = classes(button());
		assert.ok(cls.includes("hidden"), "no button at all on a mouse");
		assert.ok(cls.includes("pointer-coarse:flex"), "a button on touch");
	});

	it("covers the right end of the row, 44px wide, as tall as the row", () => {
		const cls = classes(button());
		for (const c of ["absolute", "inset-y-0", "right-0", "w-11"]) assert.ok(cls.includes(c), c);
	});

	it("draws a ring when a keyboard has focus, because the app draws no outline anywhere else", () => {
		const cls = classes(button());
		for (const c of ["focus-visible:ring-2", "focus-visible:ring-inset", "focus-visible:ring-ring/50"]) assert.ok(cls.includes(c), c);
		assert.match(read("app/globals.css"), /\*:focus-visible\s*\{\s*outline:\s*none;/, "the reset that makes the ring necessary");
	});

	it("hands the click to the row's code with itself as the anchor", async () => {
		const seen: Array<{ anchor: unknown; testid: string | null }> = [];
		const { doc, win } = await mount(<RowMenuButton label="Actions" open={false} testId="row-menu" onClick={(e) => { seen.push({ anchor: e.currentTarget, testid: e.currentTarget.getAttribute("data-testid") }); }} />);
		const btn = doc.querySelector('[data-testid="row-menu"]')!;
		await act(async () => { btn.dispatchEvent(new win.Event("click", { bubbles: true })); });
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.anchor, btn, "the menu is anchored to the button, which is on screen at the row's right end");
	});
});

describe("session and folder rows leave room for the button", () => {
	it("a session row with a menu keeps 48px free at its right end on touch, and 12px otherwise", () => {
		const withMenu = classes(renderToStaticMarkup(<SessionRow chat={chat()} active={false} onOpen={() => {}} onContextMenu={() => {}} />));
		assert.ok(withMenu.includes("pr-3"));
		assert.ok(withMenu.includes("pointer-coarse:pr-12"));
		const without = classes(renderToStaticMarkup(<SessionRow chat={chat()} active={false} onOpen={() => {}} />));
		assert.ok(!without.includes("pointer-coarse:pr-12"), "no menu, no gap");
	});

	it("a folder row's own button keeps 48px free too", () => {
		const cls = classes(folderRow());
		assert.ok(cls.includes("pr-3") && cls.includes("pointer-coarse:pr-12"));
	});
});

describe("the folder row's ⋯ button", () => {
	it("is a sibling of the row's button, named after the folder", () => {
		const html = folderRow({ onMenuButton: () => {}, menuOpen: false });
		assert.match(html, /data-testid="sidebar-folder-menu-f1"/);
		assert.match(html, /aria-label="Actions for folder Physics"/);
		assert.equal((html.match(/<button\b/g) ?? []).length, 2, "the folder button and the ⋯ button");
		const dots = html.indexOf('data-testid="sidebar-folder-menu-f1"');
		const rowButton = html.indexOf('data-testid="sidebar-folder-f1"');
		const rowEnd = html.indexOf("</button>", rowButton);
		assert.ok(rowButton >= 0 && rowEnd >= 0 && dots > rowEnd, "after the row's button closed, not inside it (a button in a button is not valid)");
	});

	it("says whether its menu is open", () => {
		assert.match(folderRow({ onMenuButton: () => {}, menuOpen: true }), /data-testid="sidebar-folder-menu-f1"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*data-testid="sidebar-folder-menu-f1"/);
	});

	it("is not there when the caller gave no handler, nor while the folder is being renamed", () => {
		assert.doesNotMatch(folderRow(), /sidebar-folder-menu-f1/);
		assert.doesNotMatch(folderRow({ onMenuButton: () => {}, renaming: true }), /sidebar-folder-menu-f1/);
	});

	it("a tap runs the handler with the button as the anchor", async () => {
		const seen: unknown[] = [];
		const { doc, win } = await mount(<SidebarFolderRow folder={folder} depth={0} open={false} dropActive={false} renaming={false} draggable
			onToggle={() => { seen.push("toggled"); }} onContextMenu={() => {}} onRename={async () => {}} onRenameDone={() => {}}
			onMenuButton={(e) => { seen.push(e.currentTarget.getAttribute("data-testid")); }} />);
		await act(async () => { doc.querySelector('[data-testid="sidebar-folder-menu-f1"]')!.dispatchEvent(new win.Event("click", { bubbles: true })); });
		assert.deepEqual(seen, ["sidebar-folder-menu-f1"], "the menu opens; the folder does not also open or close");
	});
});

describe("the sidebar wires the button to its menus", () => {
	const source = read("components/sidebar.tsx");

	it("a session row has the button, except while it is being renamed, and a second tap closes the menu", () => {
		assert.match(source, /\{renamingId !== c\.id && \(\s*<RowMenuButton\s+label=\{`Actions for \$\{c\.title\}`\}\s+open=\{ctxChatId === c\.id\}\s+testId="session-row-menu"\s+onClick=\{\(e\) => \(ctxChatId === c\.id \? setCtxChatId\(null\) : openContext\(e, c\)\)\}/);
	});

	it("a second tap on the button closes the menu: the button is the anchor, and a press on the anchor is not an outside press", () => {
		// Without these, the second tap's pointerdown closes the menu and its click opens it again, so it never closes.
		assert.match(source, /ctxAnchorRef\.current = e\.currentTarget;/, "a session menu is anchored to what was pressed");
		assert.match(source, /if \(ctxAnchorRef\.current\?\.contains\(target\)\) return;/, "and a press inside the anchor does not dismiss it");
		assert.match(source, /folderAnchorRef\.current = e\.currentTarget;/, "a folder menu is anchored to what was pressed");
		assert.match(source, /if \(folderAnchorRef\.current\?\.contains\(target\)\) return;/, "and a press inside the anchor does not dismiss it");
	});

	it("the rows that hold the button are positioned, so the button sits at the row's right end", () => {
		assert.match(source, /<SourceDragRow key=\{c\.id\} kind="source"[^>]*\sclassName="relative"/, "a session row");
		assert.match(read("components/sidebar-folders.tsx"), /<SourceDragRow kind="folder"[^>]*?className=\{cn\("relative /, "a folder row");
	});

	it("a folder row has it too, and its second tap closes the folder menu", () => {
		assert.match(source, /menuOpen=\{ctxFolderId === folder\.id\}/);
		assert.match(source, /onMenuButton=\{\(e\) => \(ctxFolderId === folder\.id \? setCtxFolderId\(null\) : openFolderContext\(e, folder\.id\)\)\}/);
	});

	it("every item of the session and folder menus is 44px tall on touch (and as before on a mouse)", () => {
		for (const id of ["ctx-rename", "ctx-export-md", "ctx-delete", "folder-ctx-rename", "folder-ctx-new-subfolder", "folder-ctx-delete"]) {
			// the first className after the test id is the button's own
			const own = source.match(new RegExp(`data-testid="${id}"[\\s\\S]*?className="([^"]*)"`))?.[1] ?? "";
			assert.match(own, /\bpy-1\.5\b/, `${id}: found its own class list`);
			assert.match(own, /\bpointer-coarse:min-h-11\b/, id);
		}
		const extract = read("components/extraction-coverage.tsx").match(/data-testid="ctx-extract"[\s\S]*?className="([^"]*)"/)?.[1] ?? "";
		assert.match(extract, /\bpointer-coarse:min-h-11\b/, "and the Extract button below them");
	});
});

describe("the searchable dropdown lists (providers, models, thinking levels, dictation language)", () => {
	it("every option row is at least 44px tall on a touch screen and unchanged with a mouse", () => {
		const model = read("components/settings/model-menu.tsx");
		const rows = [...model.matchAll(/className=\{`flex (?:w-full )?items-center justify-between (?:gap-3 )?rounded-lg px-2 py-1\.5 ([^`]*)`/g)];
		assert.equal(rows.length, 4, "the thinking levels, the provider list and two model lists");
		for (const [, rest] of rows) assert.match(rest!, /^pointer-coarse:min-h-11 /);
		assert.match(read("components/settings/search-menu-list.tsx"), /flex w-full flex-col gap-0\.5 rounded-lg px-2 py-1\.5 pointer-coarse:min-h-11 pointer-coarse:justify-center /);
	});
});

describe("the sign-out buttons in Settings", () => {
	it("both get a 44px touch area (they are the way out on a phone)", () => {
		const src = read("components/settings/access-settings.tsx");
		for (const id of ["sign-out", "sign-out-all"]) {
			const tag = src.match(new RegExp(`<Button[^\\n]*data-testid="${id}"`))?.[0] ?? "";
			assert.match(tag, /className="relative touch-target /, id);
		}
	});
});

describe("the graph on a phone", () => {
	const graph = read("components/graph-view.tsx");

	it("the node card has a Delete button for touch, which opens the same confirm dialog as the right-click menu", () => {
		const m = graph.match(/<button[^>]*data-testid="node-card-delete"[\s\S]*?<\/button>/)?.[0] ?? "";
		assert.ok(m, "the button");
		assert.match(m, /onClick=\{\(\) => setDeletingNode\(\{ id: selected\.node\.id, name: selected\.node\.name \}\)\}/);
		const cls = m.match(/className="([^"]*)"/)![1]!.split(/\s+/);
		for (const c of ["hidden", "pointer-coarse:flex", "min-h-11", "w-full"]) assert.ok(cls.includes(c), c);
		assert.match(graph, /onClick=\{\(\) => \{\s*setDeletingNode\(\{ id: ctxNode\.id, name: ctxNode\.name \}\);/, "the right-click menu still does the same");
	});

	it("the node card is never taller than the graph area and scrolls inside, so Delete node… stays in reach", () => {
		const cls = graph.match(/<div\s+ref=\{cardRef\}[\s\S]*?className="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
		for (const c of ["max-h-[calc(100%-1rem)]", "overflow-y-auto", "w-80", "max-w-[calc(100%-1rem)]"]) assert.ok(cls.includes(c), c);
	});

	it("the Chains and Extract files buttons get a 44px touch area", () => {
		for (const [file, testid] of [["components/graph-view.tsx", "open-chain-table"], ["components/notes-import.tsx", "import-notes"]] as const) {
			const src = read(file);
			const at = src.indexOf(`data-testid="${testid}"`);
			assert.ok(at >= 0, testid);
			assert.match(src.slice(at, at + 400), /className="[^"]*\brelative touch-target\b/, testid);
		}
	});

	it("the chain table's selection bar (Clear, Done, Delete) gets one too", () => {
		const src = read("components/chain-table.tsx");
		for (const id of ["chain-clear", "chain-practice-done", "chain-delete"]) {
			const own = src.match(new RegExp(`data-testid="${id}"[\\s\\S]*?className="([^"]*)"`))?.[1] ?? "";
			assert.match(own, /\brelative touch-target\b/, id);
		}
	});

	it("the Cancel and Delete buttons of the delete dialogs get one too", () => {
		for (const file of ["components/delete-node-dialog.tsx", "components/delete-session-dialog.tsx"]) {
			const buttons = read(file).match(/<button[^>]*data-testid="(?:node-)?delete-(?:cancel|confirm)"[^>]*>/gs) ?? [];
			assert.equal(buttons.length, 2, file);
			for (const b of buttons) assert.match(b, /className="[^"]*\brelative touch-target\b/, file);
		}
	});
});

describe("no zoom on a touch screen", () => {
	it("every text field is 16px there, outside any layer so it wins over the per-field sizes", () => {
		const css = read("app/globals.css");
		const rule = css.match(/@media \(pointer: coarse\) \{\s*(input:not\([^)]*\),\s*textarea,\s*select)\s*\{\s*font-size: 16px;\s*\}\s*\}/);
		assert.ok(rule, "an unlayered @media (pointer: coarse) rule that sets font-size: 16px on input, textarea and select");
		for (const type of ["checkbox", "radio", "range", "file", "color", "button", "submit", "hidden"]) assert.ok(rule[1]!.includes(`[type="${type}"]`), `${type} is not a text field`);
		assert.ok(!css.slice(0, rule.index).includes("@layer"), "it is not inside a layer");
	});
});
