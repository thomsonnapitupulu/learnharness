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
import { Composer, ChatSessionComposer } from "../components/composer.tsx";
import { DictationMic, DICTATION_KEYLESS, type Dictation } from "../components/dictation.tsx";
import { EnterHint } from "../components/enter-hint.tsx";
import { enterMaySend, onScreenKeyboard } from "../lib/touch-keyboard.ts";

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

	it("every field that sends on Enter asks first (a field added without the check fails here)", () => {
		const root = path.resolve(import.meta.dirname, "..");
		const expected: Record<string, number> = {
			"components/composer.tsx": 1, "components/home.tsx": 1, "components/practice-dock.tsx": 1,
			"components/question-dock.tsx": 2, "components/side-thread.tsx": 1, "components/plugin-question-dock.tsx": 1,
		};
		for (const [file, count] of Object.entries(expected)) {
			const source = fs.readFileSync(path.join(root, file), "utf8");
			assert.equal(source.split("enterMaySend(").length - 1, count, `${file}: enterMaySend( calls`);
			assert.match(source, /touch-keyboard"/, `${file} imports the helper`);
		}
	});

	it("the line beside Submit says what Enter does for both kinds of keyboard", () => {
		const html = renderToStaticMarkup(<EnterHint />);
		assert.match(html, /<span class="pointer-coarse:hidden">↵ submits · ⇧↵ newline<\/span>/);
		assert.match(html, /<span class="hidden pointer-coarse:inline">↵ new line<\/span>/);
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
