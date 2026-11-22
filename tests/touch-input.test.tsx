import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { Composer, ChatSessionComposer, nextProblemPlaceholder } from "../components/composer.tsx";
import { DictationMic, DictationNote, DICTATION_KEYLESS, type Dictation } from "../components/dictation.tsx";
import { EnterHint } from "../components/enter-hint.tsx";
import { enterMaySend, onScreenKeyboard, SEND_KEY_INIT, useOnScreenKeyboard } from "../lib/touch-keyboard.ts";
import { MarkdownTable } from "../components/md-blocks.tsx";
import { commentKeyAction } from "../components/citation-comment-editor.tsx";
import { capturePluginQuestionKey, ownPluginQuestionKeys, pluginQuestionKeySuppressed } from "../components/plugin-question-keys.ts";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";

// Mobile epic, story 5a: Enter is a newline on an on-screen keyboard, hover-only
// buttons are visible on a touch screen, small controls get a 44px target, and
// the microphone sits in the composer row on a phone.

const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
let active: Element = document.body;
Object.defineProperty(document, "activeElement", { get: () => active });
const selection = {
	anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
	setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) { Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset }); },
};
Object.assign(document, { getSelection: () => selection, oninput: null });
window.HTMLElement.prototype.focus = function () { active = this; };
Object.assign(globalThis, { window, document, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent });

/** The pointer the "device" has. Queries other than (pointer: coarse) never match. */
function pointer(kind: "coarse" | "fine" | "none") {
	if (kind === "none") { delete (window as unknown as Record<string, unknown>).matchMedia; return; }
	(window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({ media: query, matches: kind === "coarse" && query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
}

const roots: { root: Root; host: HTMLElement }[] = [];
async function mount(element: React.ReactElement) {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}
afterEach(async () => {
	pointer("none");
	for (const { root, host } of roots.splice(0)) { await act(async () => { root.unmount(); }); host.remove(); }
});

function press(target: Element, init: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) {
	const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...init });
	target.dispatchEvent(event);
	return event;
}

const keys = (over: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) => ({ metaKey: false, ctrlKey: false, ...over });
const chatUsesSendKey = /new KeyboardEvent\("keydown", SEND_KEY_INIT\)/.test(fs.readFileSync(path.resolve(import.meta.dirname, "../components/chat.tsx"), "utf8"));

describe("Enter on an on-screen keyboard", () => {
	it("a finger is the main pointer on a phone or tablet, and only then", () => {
		pointer("none"); assert.equal(onScreenKeyboard(), false, "no matchMedia (a server render, an old browser)");
		pointer("fine"); assert.equal(onScreenKeyboard(), false);
		pointer("coarse"); assert.equal(onScreenKeyboard(), true);
	});

	it("Enter may send on a computer; on an on-screen keyboard only with Cmd or Ctrl", () => {
		pointer("fine");
		assert.equal(enterMaySend(keys()), true);
		pointer("coarse");
		assert.equal(enterMaySend(keys()), false, "plain Enter is a newline there");
		assert.equal(enterMaySend(keys({ metaKey: true })), true, "a keyboard attached to a tablet");
		assert.equal(enterMaySend(keys({ ctrlKey: true })), true);
	});

	function composer(sent: string[]) {
		return <ChatSessionComposer busy={false} value="hello" revision={0} onChange={() => {}} onSend={() => { sent.push("send"); }} onStop={() => {}} sendAllowed dictationActive={false} />;
	}
	const editorIn = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-file-path-input]")!;

	it("the session composer: Enter sends on a computer, and Shift+Enter does not", async () => {
		pointer("fine");
		const sent: string[] = [];
		const host = await mount(composer(sent));
		let event!: Event;
		await act(async () => { event = press(editorIn(host), { key: "Enter" }); });
		assert.deepEqual(sent, ["send"]);
		assert.equal(event.defaultPrevented, true);
		await act(async () => { event = press(editorIn(host), { key: "Enter", shiftKey: true }); });
		assert.deepEqual(sent, ["send"], "Shift+Enter is a newline");
		assert.equal(event.defaultPrevented, false);
	});

	it("the session composer: on a touch screen Enter is a newline (the browser's own), the button sends, Cmd+Enter sends", async () => {
		pointer("coarse");
		const sent: string[] = [];
		const host = await mount(composer(sent));
		let event!: Event;
		await act(async () => { event = press(editorIn(host), { key: "Enter" }); });
		assert.deepEqual(sent, [], "nothing is sent");
		assert.equal(event.defaultPrevented, false, "the default stays, so the field inserts its newline");
		await act(async () => { press(editorIn(host), { key: "Enter", metaKey: true }); });
		assert.deepEqual(sent, ["send"], "Cmd+Enter");
		const form = host.querySelector("form")!;
		await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
		assert.deepEqual(sent, ["send", "send"], "the send button's form submit");
	});

	it("every file that handles the Enter key is classified: fields that send on Enter ask first, the rest are listed", () => {
		const root = path.resolve(import.meta.dirname, "..");
		// Fields where Enter sends or acts (a new line is wanted on an on-screen keyboard): file -> calls of enterMaySend(.
		const asksFirst: Record<string, number> = {
			"components/composer.tsx": 1, "components/home.tsx": 1, "components/practice-dock.tsx": 1,
			"components/question-dock.tsx": 2, "components/side-thread.tsx": 1, "components/plugin-question-dock.tsx": 1,
			"components/reading-thinking.tsx": 1, "components/plugin-question-keys.ts": 1,
			"components/citation-comment-editor.tsx": 1, // through commentKeyAction
		};
		// Single-line fields, menus and window-level listeners that skip typing surfaces: Enter there is not "send".
		const elsewhere = [
			"components/chat.tsx", "components/dictation-language.tsx", "components/enter-submits.ts", "components/session-find.tsx",
			"components/settings/agent-section.tsx", "components/settings/controls.tsx", "components/settings/keys-section.tsx",
			"components/settings/model-menu.tsx", "components/settings/search-menu-list.tsx", "components/setup-dialog.tsx",
			"components/sidebar.tsx", "components/source-folder-tree.tsx", "src/core/plugin-questions.ts",
			"lib/touch-keyboard.ts", // the helper itself, and the synthetic Ctrl+Enter
		];
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
				const rel = `${dir}/${entry.name}`;
				if (entry.isDirectory()) walk(rel);
				else if (/\.tsx?$/.test(entry.name) && /["']Enter["']/.test(fs.readFileSync(path.join(root, rel), "utf8"))) found.push(rel);
			}
		};
		for (const dir of ["components", "lib", "src"]) walk(dir);
		const known = new Set([...Object.keys(asksFirst), ...elsewhere]);
		assert.deepEqual(found.filter((file) => !known.has(file)), [], "a file that handles Enter must ask enterMaySend first (add it to asksFirst) or be listed in elsewhere");
		assert.deepEqual([...known].filter((file) => !found.includes(file)), [], "a listed file no longer handles Enter: remove it from the lists");
		for (const [file, count] of Object.entries(asksFirst)) {
			const source = fs.readFileSync(path.join(root, file), "utf8");
			assert.equal(source.split("enterMaySend(").length - 1, count, `${file}: enterMaySend( calls`);
			assert.match(source, /touch-keyboard(\.ts)?"/, `${file} imports the helper`);
		}
	});

	it("the synthetic key the citation popover uses to send into a field is Ctrl+Enter, which sends on both kinds of keyboard", () => {
		for (const kind of ["fine", "coarse"] as const) {
			pointer(kind);
			assert.equal(enterMaySend(SEND_KEY_INIT), true, kind);
		}
		assert.equal(SEND_KEY_INIT.key, "Enter");
		assert.equal(chatUsesSendKey, true, "chat.tsx dispatches it");
	});

	it("a plugin editor's host default: Enter submits on a computer, is the editor's own new line on a touch screen, Cmd/Ctrl+Enter submits on both", () => {
		let submits = 0;
		const off = ownPluginQuestionKeys({ eligible: () => true, contains: () => true, key: () => "pass", cycle() {}, submit() { submits++; } });
		const key = (extra = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, target: null, defaultPrevented: false, preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }, ...extra }) as unknown as KeyboardEvent;
		try {
			pointer("fine");
			const computer = key(); capturePluginQuestionKey(computer);
			assert.equal(submits, 1); assert.equal(computer.defaultPrevented, true);
			pointer("coarse");
			const touch = key(); capturePluginQuestionKey(touch);
			assert.equal(submits, 1, "nothing is submitted"); assert.equal(touch.defaultPrevented, false, "the editor keeps its own newline"); assert.equal(pluginQuestionKeySuppressed(touch), false);
			capturePluginQuestionKey(key({ ctrlKey: true })); assert.equal(submits, 2, "Ctrl+Enter");
			capturePluginQuestionKey(key({ metaKey: true })); assert.equal(submits, 3, "Cmd+Enter");
		} finally { off(); }
	});

	it("the citation comment editor: Enter saves on a computer and is a new line on a touch screen; Cmd/Ctrl+Enter saves and sends on both", () => {
		const enter = (extra = {}) => ({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...extra });
		pointer("fine");
		assert.equal(commentKeyAction(enter()), "save");
		assert.equal(commentKeyAction(enter({ ctrlKey: true })), "save-send");
		pointer("coarse");
		assert.equal(commentKeyAction(enter()), null, "the native new line");
		assert.equal(commentKeyAction(enter({ ctrlKey: true })), "save-send");
		assert.equal(commentKeyAction(enter({ metaKey: true })), "save-send");
		assert.equal(commentKeyAction({ ...enter(), key: "Escape" }), "cancel");
	});

	it("the reading-thinking field: Enter opens the waiting check on a computer and is a new line on a touch screen; Cmd+Enter opens it on both", async () => {
		let opened = 0;
		const host = await mount(<ReadingThinkingField value="" revision={0} onChange={() => {}} claim={false} onOpen={() => { opened++; }} />);
		const editor = editorIn(host);
		pointer("fine");
		await act(async () => { press(editor, { key: "Enter" }); });
		assert.equal(opened, 1);
		pointer("coarse");
		let event!: Event;
		await act(async () => { event = press(editor, { key: "Enter" }); });
		assert.equal(opened, 1, "nothing opens");
		assert.equal(event.defaultPrevented, false, "the field keeps its newline");
		await act(async () => { press(editor, { key: "Enter", metaKey: true }); });
		assert.equal(opened, 2, "Cmd+Enter");
	});

	it("the line beside Submit says what Enter does for both kinds of keyboard", () => {
		const html = renderToStaticMarkup(<EnterHint />);
		assert.match(html, /<span class="pointer-coarse:hidden">↵ submits · ⇧↵ newline<\/span>/);
		assert.match(html, /<span class="hidden pointer-coarse:inline">↵ new line<\/span>/);
		const busy = renderToStaticMarkup(<EnterHint compacting />);
		assert.match(busy, /compacting session…/);
		assert.doesNotMatch(busy, /new line|submits/, "while compacting the line says only that");
	});
});

describe("the microphone on a phone", () => {
	function fake(over: Partial<Dictation> = {}): Dictation & { calls: string[] } {
		const calls: string[] = [];
		return Object.assign({
			phase: "idle", error: null, active: false, blocked: false, levelRef: { current: 0 },
			toggle() { calls.push("toggle"); }, clearError() { calls.push("clearError"); }, cancel() {}, stop() {}, finish: async () => {},
		} as unknown as Dictation, over, { calls });
	}

	it("is one 44px icon button that shows only below 768px", () => {
		const html = renderToStaticMarkup(<DictationMic dictation={fake()} />);
		assert.match(html, /data-testid="dictation-mic"/);
		assert.match(html, /class="[^"]*\bhidden\b[^"]*\bsize-11\b[^"]*\bphone:flex\b/);
		assert.match(html, /aria-label="Start dictation"/);
		assert.match(html, /aria-pressed="false"/);
	});

	it("why it failed shows as a line above the composer on a phone, because the strip that says so is hidden there", () => {
		assert.equal(renderToStaticMarkup(<DictationNote dictation={fake()} />), "", "nothing when there is no error");
		const html = renderToStaticMarkup(<DictationNote dictation={fake({ error: "Microphone permission was denied." })} className="px-3" />);
		assert.match(html, /role="alert"/);
		assert.match(html, /class="[^"]*\bhidden\b[^"]*\bphone:block\b/, "shown only on a phone");
		assert.match(html, /Microphone permission was denied\./);
	});

	it("says when it is recording, stopping, failed or unavailable", () => {
		assert.match(renderToStaticMarkup(<DictationMic dictation={fake({ active: true, phase: "recording" })} />), /aria-label="Stop dictation"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Stop dictation"/);
		assert.match(renderToStaticMarkup(<DictationMic dictation={fake({ active: true, phase: "recording" })} />), /animate-pulse/);
		assert.match(renderToStaticMarkup(<DictationMic dictation={fake({ phase: "stopping", active: true })} />), /disabled=""/);
		assert.match(renderToStaticMarkup(<DictationMic dictation={fake({ error: "Mic blocked" })} />), /aria-label="Dictation failed: Mic blocked"/);
		assert.match(renderToStaticMarkup(<DictationMic dictation={fake({ blocked: true })} />), /disabled=""/);
		assert.match(renderToStaticMarkup(<DictationMic dictation={fake()} disabled />), /disabled=""/);
	});

	it("a tap starts or stops dictation; with no Deepgram key it clears the error and goes to Settings instead", async () => {
		const plain = fake();
		let host = await mount(<DictationMic dictation={plain} />);
		await act(async () => { host.querySelector("button")!.click(); });
		assert.deepEqual(plain.calls, ["toggle"]);
		const keyless = fake({ error: DICTATION_KEYLESS });
		host = await mount(<DictationMic dictation={keyless} />);
		await act(async () => { host.querySelector("button")!.click(); });
		assert.deepEqual(keyless.calls, ["clearError"], "not a retry");
	});

	it("sits in the composer row beside Attach, when the page passes it, and nowhere else", async () => {
		const mic = fake();
		const withMic = await mount(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} dictation={mic} />);
		const form = withMic.querySelector("form")!;
		const order = [...form.querySelectorAll("button")].map((b) => b.getAttribute("data-testid") ?? b.getAttribute("aria-label"));
		assert.deepEqual(order, ["dictation-mic", "attach-files", "Send"], "mic, then Attach, then Send");
		const without = await mount(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />);
		assert.equal(without.querySelector('[data-testid="dictation-mic"]'), null);
	});
});

describe("touch targets and hover-only buttons", () => {
	const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");

	it("the touch-target utility reaches 44px only on a touch screen, and only where the control is smaller", () => {
		const css = read("app/globals.css");
		const block = css.slice(css.indexOf("@utility touch-target"), css.indexOf("THE SKIN"));
		assert.match(block, /@media \(pointer: coarse\)/);
		assert.match(block, /&::after/);
		assert.match(block, /inset-block: min\(0px, calc\(\(100% - 44px\) \/ 2\)\)/);
		assert.match(block, /inset-inline: min\(0px, calc\(\(100% - 44px\) \/ 2\)\)/);
		assert.doesNotMatch(block, /position: relative/, "the control brings its own position");
	});

	it("copy-code and expand-diagram show without hover on a touch screen, with a 44px target", () => {
		const source = read("components/md-blocks.tsx");
		const buttons = source.match(/className="[^"]*group-hover\/md:opacity-100[^"]*"/g) ?? [];
		assert.equal(buttons.length, 2, "the two hover-only buttons");
		for (const classes of buttons) {
			assert.match(classes, /\bpointer-coarse:opacity-100\b/);
			assert.match(classes, /\btouch-target\b/);
			assert.match(classes, /\brelative\b/);
		}
	});

	it("the small controls that fingers use get the 44px target or the bigger size", () => {
		const read2 = (file: string) => read(file);
		assert.match(read2("components/chat.tsx"), /cn\("relative touch-target", hasHistory/, "the side question button");
		assert.match(read2("components/stats-bar.tsx"), /relative touch-target flex items-center gap-1\.5 tabular-nums/, "the cost summary");
		assert.match(read2("components/model-picker-pill.tsx"), /relative touch-target flex/, "the model and thinking pills");
		assert.match(read2("components/attach-files-button.tsx"), /size-10 pointer-coarse:size-11/);
		assert.match(read2("components/home.tsx"), /size-10 pointer-coarse:size-11/);
		const composer = read2("components/composer.tsx");
		assert.match(composer, /size-10 pointer-coarse:size-11/);
		assert.match(composer, /h-10 pointer-coarse:h-11/, "the Next problem button");
	});

	it("the stats row has no room for the dictation strip on a phone, so it hides there", () => {
		assert.match(read("components/stats-bar.tsx"), /flex min-w-0 flex-1 items-center justify-center phone:hidden">\{dictationSlot\}/);
	});
});

describe("what the independent test found on a phone (story 5a)", () => {
	const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");

	it("text that names a key follows the device: a computer on the server and at first, then the pointer, and a change of it", async () => {
		function Probe() { return <span data-testid="keys">{useOnScreenKeyboard() ? "touch" : "computer"}</span>; }
		pointer("coarse");
		assert.match(renderToStaticMarkup(<Probe />), />computer</, "the server render never guesses touch, so hydration agrees");
		let host = await mount(<Probe />);
		assert.equal(host.querySelector('[data-testid="keys"]')!.textContent, "touch");
		pointer("fine");
		host = await mount(<Probe />);
		assert.equal(host.querySelector('[data-testid="keys"]')!.textContent, "computer");

		// A window that moves between a mouse and a touch screen.
		const listeners = new Set<() => void>();
		let coarse = false;
		(window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
			media: query,
			get matches() { return coarse && query === "(pointer: coarse)"; },
			addEventListener(_: string, fn: () => void) { listeners.add(fn); },
			removeEventListener(_: string, fn: () => void) { listeners.delete(fn); },
		});
		host = await mount(<Probe />);
		assert.equal(host.querySelector('[data-testid="keys"]')!.textContent, "computer");
		coarse = true;
		await act(async () => { for (const fn of listeners) fn(); });
		assert.equal(host.querySelector('[data-testid="keys"]')!.textContent, "touch", "follows the change");
		assert.equal(listeners.size, 1, "one listener while mounted");
		await act(async () => { roots.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove(); }); });
		assert.equal(listeners.size, 0, "and none after");
	});

	it("the practice pause names the key that works: Enter on a computer, the arrow on a touch screen", () => {
		assert.equal(nextProblemPlaceholder(false), "Ask anything, or press Enter for the next one.");
		assert.equal(nextProblemPlaceholder(true), "Ask anything, or tap → for the next one.");
		assert.match(read("components/chat.tsx"), /placeholder=\{nextReady \? nextProblemPlaceholder\(onScreenKeys\) : undefined\}/);
		assert.match(read("components/chat.tsx"), /const onScreenKeys = useOnScreenKeyboard\(\);/);
	});

	it("on a phone the Next problem button is the arrow alone, so the text field keeps its width", () => {
		const html = renderToStaticMarkup(<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} nextProblem onNext={() => {}} />);
		const button = html.match(/<button[^>]*data-testid="next-problem-button"[^>]*>[\s\S]*?<\/button>/)![0];
		assert.match(button, /aria-label="Next problem"/, "still named for a screen reader");
		assert.match(button, /<span class="phone:hidden">Next problem<\/span>/, "the words go on a phone");
		assert.match(button, /\bphone:w-11\b/);
		assert.match(button, /\bphone:px-0\b/);
		assert.doesNotMatch(button.replace(/<span class="phone:hidden">Next problem<\/span>/, ""), />Next problem</, "the words are not anywhere else");
	});

	it("the thinking toggle is 44px tall on a touch screen: a real height, since an edge row clips an overhang", () => {
		assert.match(read("components/ai-elements/reasoning.tsx"), /relative touch-target flex w-full items-center gap-2 pointer-coarse:min-h-11 /);
	});

	it("the table's copy button leaves the table alone on a touch screen: it sits in a row above, at the right", () => {
		const html = renderToStaticMarkup(<MarkdownTable><tbody><tr><td>cell</td></tr></tbody></MarkdownTable>);
		const wrapper = html.match(/<div class="([^"]*)" data-testid="md-table">/)![1]!;
		assert.match(wrapper, /\bpointer-coarse:flex\b/);
		assert.match(wrapper, /\bpointer-coarse:flex-col\b/);
		const corner = html.match(/<span class="([^"]*)"><button[^>]*data-testid="md-copy"/)![1]!;
		assert.match(corner, /\babsolute top-1 right-1\b/, "over the corner with a mouse, as before");
		assert.match(corner, /\bpointer-coarse:static\b/);
		assert.match(corner, /\bpointer-coarse:self-end\b/);
	});
});
