import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { installVisualViewportVars, KEYBOARD_MIN_PX, visibleArea } from "../lib/visual-viewport.ts";
import { DockDictationContext, DockDictationNote, DockMic, DICTATION_KEYLESS, type Dictation } from "../components/dictation.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { SideThreadBody, SideThreadPanel, SideThreadPopover } from "../components/side-thread.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import type { SideThreadState } from "../components/use-side-thread.ts";

// Mobile epic, story 5b: the screen follows the on-screen keyboard, the answer docks
// get a full-width Submit and a microphone on a phone, and the side question is a
// bottom sheet there.

const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");

describe("what a keyboard leaves of the screen", () => {
	it("no keyboard: the visual viewport is the layout viewport", () => {
		assert.equal(visibleArea({ layoutHeight: 844, height: 844, offsetTop: 0, scale: 1 }), null);
	});

	it("the browser's own bars (a few dozen pixels) are not a keyboard", () => {
		assert.equal(visibleArea({ layoutHeight: 844, height: 790, offsetTop: 0, scale: 1 }), null);
		assert.equal(visibleArea({ layoutHeight: 844, height: 844 - KEYBOARD_MIN_PX + 1, offsetTop: 0, scale: 1 }), null);
	});

	it("a keyboard: the visible height and where the visible area starts", () => {
		assert.deepEqual(visibleArea({ layoutHeight: 844, height: 508, offsetTop: 0, scale: 1 }), { height: 508, top: 0 });
		assert.deepEqual(visibleArea({ layoutHeight: 844, height: 844 - KEYBOARD_MIN_PX, offsetTop: 0, scale: 1 }), { height: 744, top: 0 }, "exactly the smallest keyboard counts");
		assert.deepEqual(visibleArea({ layoutHeight: 390, height: 190.4, offsetTop: 0, scale: 1 }), { height: 190, top: 0 }, "landscape, rounded");
	});

	it("iOS pans the page to show the field: the keyboard is as big as before, wherever the page has been panned to", () => {
		// iOS and Chrome pan just far enough to show the focused field, which can leave the bottom of the page (the
		// Submit row) under the keyboard, or flush with the top of it: both are a keyboard, and the area follows the pan.
		for (const offsetTop of [0, 120, 200, 250, 336]) {
			assert.deepEqual(visibleArea({ layoutHeight: 844, height: 508, offsetTop, scale: 1 }), { height: 508, top: offsetTop }, `panned ${offsetTop}px`);
		}
	});

	it("a pinch-zoomed page has a smaller visual viewport for another reason: not a keyboard", () => {
		assert.equal(visibleArea({ layoutHeight: 844, height: 422, offsetTop: 0, scale: 2 }), null);
		assert.deepEqual(visibleArea({ layoutHeight: 844, height: 508, offsetTop: 0, scale: 1.004 }), { height: 508, top: 0 }, "rounding noise in the scale");
	});
});

/** A window as lib/visual-viewport.ts uses it. */
function fakeWindow({ coarse = true, viewport = true }: { coarse?: boolean; viewport?: boolean } = {}) {
	const props: Record<string, string> = {};
	const attrs = new Set<string>();
	const listeners = new Map<string, Set<() => void>>();
	const frames: Array<() => void> = [];
	const vv = { height: 844, offsetTop: 0, scale: 1,
		addEventListener(type: string, fn: () => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
		removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn); } };
	const win = {
		innerHeight: 844,
		visualViewport: viewport ? vv : null,
		matchMedia: (query: string) => ({ matches: coarse && query === "(pointer: coarse)" }),
		requestAnimationFrame: (fn: () => void) => frames.push(fn),
		cancelAnimationFrame: (id: number) => { frames[id - 1] = () => {}; },
		document: { documentElement: {
			style: { setProperty: (name: string, value: string) => { props[name] = value; }, removeProperty: (name: string) => { delete props[name]; } },
			setAttribute: (name: string) => { attrs.add(name); }, removeAttribute: (name: string) => { attrs.delete(name); },
		} },
	};
	return {
		win: win as unknown as Window, vv, props, attrs,
		count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
		emit: (type: "resize" | "scroll") => { for (const fn of listeners.get(type) ?? []) fn(); },
		frame: () => { const queued = frames.splice(0); for (const fn of queued) fn(); return queued.length; },
	};
}

describe("the variables the shell follows", () => {
	it("a keyboard opens: the visible height, its top and the keyboard flag are set after the next frame", () => {
		const f = fakeWindow();
		const stop = installVisualViewportVars(f.win);
		assert.deepEqual(f.props, {}, "no keyboard yet");
		f.vv.height = 508;
		f.emit("resize");
		assert.deepEqual(f.props, {}, "not before the frame");
		f.frame();
		assert.deepEqual(f.props, { "--lh-vvh": "508px", "--lh-vv-top": "0px" });
		assert.deepEqual([...f.attrs], ["data-lh-keyboard"]);
		stop();
	});

	it("the page is panned: the top follows (a scroll of the visual viewport)", () => {
		const f = fakeWindow();
		const stop = installVisualViewportVars(f.win);
		f.vv.height = 508; f.emit("resize"); f.frame();
		f.vv.offsetTop = 120; f.emit("scroll"); f.frame();
		assert.equal(f.props["--lh-vv-top"], "120px");
		assert.equal(f.props["--lh-vvh"], "508px");
		stop();
	});

	it("the keyboard closes: everything is unset, so the shell is 100dvh at the top again", () => {
		const f = fakeWindow();
		const stop = installVisualViewportVars(f.win);
		f.vv.height = 508; f.emit("resize"); f.frame();
		f.vv.height = 844; f.emit("resize"); f.frame();
		assert.deepEqual(f.props, {});
		assert.deepEqual([...f.attrs], []);
		stop();
	});

	it("many events in one frame are applied once, with the last reading", () => {
		const f = fakeWindow();
		const stop = installVisualViewportVars(f.win);
		for (const height of [700, 600, 508]) { f.vv.height = height; f.emit("resize"); }
		assert.equal(f.frame(), 1, "one frame was asked for");
		assert.equal(f.props["--lh-vvh"], "508px");
		stop();
	});

	it("it starts from what is already there: a keyboard that is up when the page loads", () => {
		const f = fakeWindow();
		f.vv.height = 508;
		const stop = installVisualViewportVars(f.win);
		assert.equal(f.props["--lh-vvh"], "508px", "no event needed");
		stop();
	});

	it("stopping removes both listeners and clears the variables", () => {
		const f = fakeWindow();
		const stop = installVisualViewportVars(f.win);
		f.vv.height = 508; f.emit("resize"); f.frame();
		assert.equal(f.props["--lh-vvh"], "508px");
		assert.equal(f.count(), 2);
		stop();
		assert.equal(f.count(), 0);
		assert.deepEqual(f.props, {});
		assert.deepEqual([...f.attrs], []);
	});

	it("a frame that is still queued when it stops does nothing", () => {
		const f = fakeWindow();
		const stop = installVisualViewportVars(f.win);
		f.vv.height = 508; f.emit("resize");
		stop();
		f.frame();
		assert.deepEqual(f.props, {});
		assert.deepEqual([...f.attrs], []);
	});

	it("only a touch screen with a visual viewport: a computer or an old browser installs nothing", () => {
		const mouse = fakeWindow({ coarse: false });
		installVisualViewportVars(mouse.win)();
		assert.equal(mouse.count(), 0);
		const mouse2 = fakeWindow({ coarse: false });
		const stop = installVisualViewportVars(mouse2.win);
		assert.equal(mouse2.count(), 0, "no listeners were added");
		stop();
		const old = fakeWindow({ viewport: false });
		assert.doesNotThrow(() => installVisualViewportVars(old.win)());
		assert.doesNotThrow(() => installVisualViewportVars({ ...old.win, matchMedia: undefined } as unknown as Window)());
	});

});

// ---------------------------------------------------------------------------- a mounted provider

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** The real SidebarProvider in a window that is a phone (or not), with a visual viewport. */
async function mountWindow(element: React.ReactElement, { phone, visualViewport }: { phone: boolean; visualViewport?: ReturnType<typeof fakeWindow>["vv"] }) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.defineProperty(doc, "oninput", { configurable: true, value: null });
	const frames: Array<() => void> = [];
	Object.assign(win, {
		innerHeight: 844,
		visualViewport: visualViewport ?? null,
		matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" ? true : phone, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (fn: () => void) => frames.push(fn),
		cancelAnimationFrame() {},
	});
	// linkedom has no focus model: the last focus() call is the active element.
	let active: unknown = null;
	Object.defineProperty(doc, "activeElement", { configurable: true, get: () => active ?? doc.body });
	(win.HTMLElement.prototype as { focus: unknown }).focus = function (this: unknown) { active = this; };
	const localStorage = { getItem: () => null, setItem: () => {} };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	// The provider renders "not a phone" first, so the floating window mounts for a moment before the sheet replaces it.
	class DOMRectStub { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} get left() { return this.x; } get top() { return this.y; } get right() { return this.x + this.width; } get bottom() { return this.y + this.height; } }
	class Observer { observe() {} disconnect() {} unobserve() {} }
	Object.assign(win, { innerWidth: 390 });
	for (const [name, value] of Object.entries({ React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, localStorage, navigator: { userAgent: "", platform: "" }, IS_REACT_ACT_ENVIRONMENT: true,
		DOMRect: DOMRectStub, MutationObserver: (win as unknown as { MutationObserver?: unknown }).MutationObserver ?? Observer, ResizeObserver: Observer })) {
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
	const render = (el: React.ReactElement) => act(async () => { root.render(<PathnameContext.Provider value="/chat/a"><SidebarProvider>{el}</SidebarProvider></PathnameContext.Provider>); });
	await render(element);
	return { doc, root, frames, render, win };
}

describe("the shell on a phone with a keyboard", () => {
	it("the shell is the visible part of the screen: its height and top come from the variables, it is fixed to the layout viewport while a keyboard is up, and it gives up the home-indicator padding", async () => {
		const { doc } = await mountWindow(<div data-testid="page" />, { phone: true });
		const shell = doc.querySelector('[data-testid="page"]')!.closest('[class*="--lh-vvh"]')!;
		const classes = shell.getAttribute("class")!.split(/\s+/);
		for (const cls of ["relative", "top-[var(--lh-vv-top,0px)]", "h-[var(--lh-vvh,100dvh)]", "pb-[env(safe-area-inset-bottom)]",
			"[html[data-lh-keyboard]_&]:pb-0", "[html[data-lh-keyboard]_&]:fixed", "[html[data-lh-keyboard]_&]:inset-x-0"]) assert.ok(classes.includes(cls), cls);
	});

	it("the provider installs the variables on the page's root element, and removes them when it goes", async () => {
		const f = fakeWindow();
		f.vv.height = 508;
		const { doc } = await mountWindow(<div data-testid="page" />, { phone: true, visualViewport: f.vv });
		const root = doc.documentElement as unknown as HTMLElement;
		assert.equal(root.style.getPropertyValue("--lh-vvh"), "508px");
		assert.equal(root.hasAttribute("data-lh-keyboard"), true);
		await cleanup!(); cleanup = undefined;
		assert.equal(f.count(), 0, "listeners are gone with the provider");
	});
});

// ---------------------------------------------------------------------------- the side question

const sideState = (mode: "popover" | "panel"): SideThreadState => ({ threadId: "side_1", segmentId: "s", messages: [], answering: false, streamText: "", mode, anchor: { kind: "composer" } });
const handlers = { onAsk: async () => true, onStop() {}, onExpand() {}, onFloat() {}, onClose() {} };

describe("the side question on a phone is a bottom sheet", () => {
	it("a phone: one dialog over a dimmed lesson, in the visible part of the screen, with the same conversation in it", async () => {
		let closed = 0;
		const { doc } = await mountWindow(<SideThreadPopover state={sideState("popover")} chatId="chat" composer={() => null} {...handlers} onClose={() => { closed++; }} />, { phone: true });
		const frame = doc.querySelector('[data-testid="side-thread-sheet-frame"]') as HTMLElement;
		assert.ok(frame, "the sheet frame");
		assert.equal(doc.querySelector('[data-testid="side-thread-popover"]'), null, "not the floating window");
		assert.equal(doc.querySelectorAll('[data-testid="side-thread-sheet"]').length, 1);
		const sheet = doc.querySelector('[data-testid="side-thread-sheet"]')!;
		assert.equal(sheet.getAttribute("role"), "dialog");
		assert.equal(sheet.getAttribute("aria-label"), "Side question");
		assert.ok(sheet.querySelector('[data-testid="side-thread-input"]'), "the question field is in it");
		assert.ok(sheet.querySelector('[data-testid="side-thread-header"]'), "and the header with Close");
		assert.equal(frame.style.top, "var(--lh-vv-top, 0px)", "it covers what the screen shows, above the keyboard");
		assert.equal(frame.style.height, "var(--lh-vvh, 100dvh)");
		assert.match(sheet.getAttribute("class")!, /\bh-\[70%\]/, "70% of that");
		const backdrop = doc.querySelector('[data-testid="side-thread-backdrop"]')!;
		await act(async () => { backdrop.dispatchEvent(new (doc.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true })); });
		assert.equal(closed, 1, "a tap on the dimmed lesson closes it");
	});

	it("the docked panel is a sheet too on a phone; on a wide screen it stays the docked panel", async () => {
		const body = <SideThreadBody state={sideState("panel")} {...handlers} />;
		let closed = 0;
		const phone = await mountWindow(<SideThreadPanel onClose={() => { closed++; }}>{body}</SideThreadPanel>, { phone: true });
		assert.ok(phone.doc.querySelector('[data-testid="side-thread-sheet"]'));
		assert.equal(phone.doc.querySelector('[data-testid="side-thread-panel"]'), null);
		await act(async () => { phone.doc.querySelector('[data-testid="side-thread-backdrop"]')!.dispatchEvent(new (phone.doc.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true })); });
		assert.equal(closed, 1);
		await cleanup!(); cleanup = undefined;
		const wide = await mountWindow(<SideThreadPanel onClose={() => {}}>{body}</SideThreadPanel>, { phone: false });
		assert.ok(wide.doc.querySelector('[data-testid="side-thread-panel"]'), "wide: the docked panel");
		assert.equal(wide.doc.querySelector('[data-testid="side-thread-sheet"]'), null);
	});

	it("the sheet is a modal dialog: it says so, focus is inside it, Escape closes it from anywhere in it (once), and focus goes back to what had it", async () => {
		let closed = 0;
		const sheet = (open: boolean) => <>
			<button data-testid="opener" />
			{open && <SideThreadPopover state={sideState("popover")} chatId="chat" composer={() => null} {...handlers} onClose={() => { closed++; }} />}
		</>;
		const w = await mountWindow(sheet(false), { phone: true });
		const opener = w.doc.querySelector('[data-testid="opener"]') as HTMLElement;
		opener.focus();
		await w.render(sheet(true));
		const dialog = w.doc.querySelector('[data-testid="side-thread-sheet"]') as HTMLElement;
		assert.equal(dialog.getAttribute("aria-modal"), "true");
		assert.equal(dialog.contains(w.doc.activeElement as Node), true, "focus is inside the sheet, not left on the lesson");
		assert.equal(w.doc.activeElement === dialog.querySelector('[data-testid="side-thread-input"]'), true, "the body's own focus on its field is kept");
		const escape = (target: Element) => act(async () => { const event = new w.win.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key: "Escape", isComposing: false }); target.dispatchEvent(event); });
		await escape(dialog.querySelector('button[aria-label="Close side conversation"]')!);
		assert.equal(closed, 1, "Escape on the Close button closes it");
		await escape(dialog.querySelector('[data-testid="side-thread-input"]')!);
		assert.equal(closed, 2, "Escape in the field closes it once, not twice");
		await w.render(sheet(false));
		assert.equal(w.doc.activeElement === opener, true, "closed: focus is back where it was");
	});

	it("a computer renders the floating window, as before", () => {
		const html = renderToStaticMarkup(<SideThreadPopover state={sideState("popover")} chatId="chat" composer={() => null} {...handlers} />);
		assert.match(html, /data-testid="side-thread-popover"/);
		assert.doesNotMatch(html, /side-thread-sheet/);
	});

	it("on a phone the body drops pin and float, and its controls are finger-sized: Close 44px, the field 16px, Send 44px, the mic 36px", () => {
		const html = renderToStaticMarkup(<SideThreadBody state={sideState("popover")} dictation={{ active: false, phase: "idle", blocked: false, error: null, toggle() {}, finish: async () => {} }} {...handlers} />);
		const pin = html.match(/<button[^>]*aria-label="Dock side conversation"[^>]*>/)![0];
		assert.match(pin, /\bphone:hidden\b/);
		assert.match(html.match(/<button[^>]*aria-label="Close side conversation"[^>]*>/)![0], /\bphone:size-11\b/);
		assert.match(html.match(/<textarea[^>]*data-testid="side-thread-input"[^>]*>/)![0], /\bphone:text-\[16px\]/, "iOS zooms a focused field below 16px");
		assert.match(html.match(/<button[^>]*aria-label="Send side question"[^>]*>/)![0], /\bphone:size-11\b/);
		assert.match(html.match(/<button[^>]*data-testid="side-dictation-toggle"[^>]*>/)![0], /\bphone:size-9\b/);
	});
});

// ---------------------------------------------------------------------------- the answer docks

function fakeDictation(over: Partial<Dictation> = {}): Dictation {
	return { phase: "idle", active: false, blocked: false, error: null, levelRef: { current: 0 }, toggle() {}, clearError() {}, cancel() {}, finish: async () => {}, ...over } as unknown as Dictation;
}
const shared = (dictation: Dictation, node: React.ReactNode) => <DockDictationContext.Provider value={{ dictation, disabled: false }}>{node}</DockDictationContext.Provider>;
const practice = <PracticeDock problemCallId="p1" input={{ statement: "Show that the sum is even." }} expanded onExpand={() => {}} onSubmit={() => {}} />;
const question = <QuestionDock toolName="probe" toolCallId="q1" input={{ question: "Pick one", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "A." }} expanded dictationClaim={false} onExpand={() => {}} onSubmit={() => {}} />;

describe("the answer docks on a phone", () => {
	it("the microphone only comes from the session: a dock with no dictation to share shows none", () => {
		assert.equal(renderToStaticMarkup(<DockMic />), "");
		assert.equal(renderToStaticMarkup(<DockDictationNote />), "");
		assert.doesNotMatch(renderToStaticMarkup(practice), /dictation-mic/);
		assert.doesNotMatch(renderToStaticMarkup(question), /dictation-mic/);
	});

	for (const [name, dock, submit] of [["practice", practice, "practice-send"], ["question", question, "Submit answer"]] as const) {
		it(`the ${name} dock's footer: the mic is beside Submit, Submit is a full-width 48px button, and the hint is gone on a phone`, () => {
			const html = renderToStaticMarkup(shared(fakeDictation(), dock));
			const mic = html.indexOf('data-testid="dictation-mic"');
			const send = name === "practice" ? html.indexOf('data-testid="practice-send"') : html.indexOf("Submit answer");
			assert.ok(mic > 0 && send > mic, "the mic comes right before Submit");
			const button = html.match(name === "practice" ? /<button[^>]*data-testid="practice-send"[^>]*>/ : /<button[^>]*type="submit"[^>]*>/)![0];
			for (const cls of ["phone:h-12", "phone:flex-1", "phone:text-base"]) assert.match(button, new RegExp(`\\b${cls}\\b`));
			assert.match(button, /\bh-9\b/, "36px on a computer, as before");
			assert.match(html, /<span aria-hidden="true" class="pl-1\.5 text-xs text-muted-foreground phone:hidden">/, "the Enter hint is not shown on a phone");
			assert.match(html.match(/<button[^>]*data-testid="dictation-mic"[^>]*>/)![0], /\bphone:flex\b/, "and the mic shows only there");
			assert.ok(submit);
		});
	}

	it("the thinking field starts as one 44px row on a phone", () => {
		assert.match(renderToStaticMarkup(practice), /min-h-16 phone:min-h-11/);
		assert.match(renderToStaticMarkup(question), /min-h-10 phone:min-h-11/);
		assert.match(read("components/question-dock.tsx"), /"min-h-\[4\.5rem\] phone:min-h-11"/, "teaching questions too");
	});

	it("why dictation failed shows above the footer on a phone, where the strip that says so is hidden", () => {
		const failed = fakeDictation({ error: DICTATION_KEYLESS });
		const html = renderToStaticMarkup(shared(failed, practice));
		assert.match(html, /<p role="alert" class="hidden text-xs text-destructive phone:block px-2\.5 pt-1">Dictation needs a Deepgram key<\/p>/);
		assert.doesNotMatch(renderToStaticMarkup(shared(fakeDictation(), practice)), /role="alert"/, "nothing when nothing failed");
	});

	it("the plugin question dock has the same footer", () => {
		const source = read("components/plugin-question-dock.tsx");
		assert.match(source, /<EnterHint className="phone:hidden" \/>/);
		assert.match(source, /<DockMic \/>\s*<Button type="submit" disabled=\{!canSubmit\} className="ml-auto h-9 rounded-\[6px\] px-3\.5 text-sm font-medium phone:h-12 phone:flex-1 phone:rounded-\[10px\] phone:text-base"/);
		assert.match(source, /<DockDictationNote className="px-2\.5 pt-1" \/>/);
		assert.match(source, /className="flex items-center justify-between gap-2 p-1 phone:flex-wrap">\s*<EnterHint/, "Dismiss, the mic and Submit wrap on a 320px screen instead of overflowing");
	});

	it("the session shares its dictation with every dock, and the side sheet closes with its own control", () => {
		const chat = read("components/chat.tsx");
		assert.match(chat, /<DockDictationContext\.Provider value=\{dockDictation\}>\s*<DockOverlay/);
		assert.match(chat, /<\/DockOverlay>|\/>\s*<\/DockDictationContext\.Provider>/);
		assert.match(chat, /const dockDictation = \{ dictation, disabled: pluginOwnsDock && !pluginMicAvailable \};/);
		assert.match(chat, /<SideThreadPanel onClose=\{closeSideThread\}>/);
	});
});
