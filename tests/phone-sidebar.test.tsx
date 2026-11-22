import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { SidebarFrame, SidebarProvider, SidebarToggle, useInertBehindDrawer } from "../components/sidebar.tsx";

// Story 4: below 768px the sidebar is a drawer over the page. These tests mount
// the real provider, toggle and frame with a controllable `matchMedia`.

const KEY = "lh:sidebar-open";

let cleanup: (() => Promise<void>) | undefined;
async function teardown() { await cleanup?.(); cleanup = undefined; }
afterEach(teardown);

async function fixture({ phone = false, stored, matchMedia = true }: { phone?: boolean; stored?: string; matchMedia?: boolean } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const saved = new Map<string, string>();
	if (stored !== undefined) saved.set(KEY, stored);
	const writes: Array<[string, string]> = [];
	const localStorage = {
		getItem: (key: string) => saved.get(key) ?? null,
		setItem: (key: string, value: string) => { writes.push([key, value]); saved.set(key, value); },
	};
	let isPhone = phone;
	const listeners = new Set<() => void>();
	const queries: string[] = [];
	if (matchMedia) {
		Object.assign(win, {
			matchMedia: (query: string) => {
				queries.push(query);
				return {
					get matches() { return isPhone; },
					addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
					removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
				};
			},
		});
	}
	let pathname = "/chat/a";
	// linkedom has no focus model: the last focus() call is the active element.
	let active: Element | null = null;
	Object.defineProperty(doc, "activeElement", { configurable: true, get: () => active ?? doc.body });
	win.HTMLElement.prototype.focus = function (this: HTMLElement) { active = this; };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, localStorage, IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	function Page() {
		const [element, setElement] = React.useState<HTMLElement | null>(null);
		useInertBehindDrawer(element);
		return <main ref={setElement} data-testid="page"><SidebarToggle /></main>;
	}
	function Harness() {
		return (
			<PathnameContext.Provider value={pathname}>
				<SidebarProvider>
					<SidebarFrame><div data-testid="sessions">Sessions <input data-testid="field" /></div></SidebarFrame>
					<Page />
				</SidebarProvider>
			</PathnameContext.Provider>
		);
	}
	const draw = () => root.render(<Harness />);
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const aside = () => doc.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
	const touch = async (type: "touchstart" | "touchend", x: number, y: number, target = "sessions") => {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		const point = { clientX: x, clientY: y };
		Object.assign(event, { touches: type === "touchend" ? [] : [point], changedTouches: [point] });
		await act(async () => { doc.querySelector(`[data-testid="${target}"]`)!.dispatchEvent(event); });
	};
	const key = async (target: Element, name: string) => {
		const event = Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key: name });
		await act(async () => { target.dispatchEvent(event); });
		return event;
	};
	return {
		doc, writes, queries, key,
		aside,
		page: () => doc.querySelector<HTMLElement>('[data-testid="page"]')!,
		field: () => doc.querySelector<HTMLElement>('[data-testid="field"]')!,
		sessions: () => doc.querySelector<HTMLElement>('[data-testid="sessions"]')!,
		backdrop: () => doc.querySelector<HTMLElement>('[data-testid="sidebar-backdrop"]'),
		isOpen: () => aside().getAttribute("aria-hidden") === "false",
		toggleButton: () => doc.querySelector<HTMLElement>('button[aria-label="Open sidebar"]')!,
		toggleSlot: () => doc.querySelector<HTMLElement>('button[aria-label="Open sidebar"]')!.parentElement!,
		press: async (element: HTMLElement) => { await act(async () => { element.click(); }); },
		/** A swipe from one point to another, on the drawer's list or on the dimmed backdrop beside it. */
		swipe: async (from: [number, number], to: [number, number], on: "sessions" | "sidebar-backdrop" = "sessions") => {
			await touch("touchstart", from[0], from[1], on);
			await touch("touchend", to[0], to[1], on);
		},
		goTo: async (next: string) => { pathname = next; await act(async () => { draw(); }); },
		resize: async (nowPhone: boolean) => {
			isPhone = nowPhone;
			await act(async () => { for (const listener of [...listeners]) listener(); });
		},
		get listening() { return listeners.size; },
	};
}

test("on a computer the sidebar still opens from the saved choice, and a toggle is saved", async () => {
	const f = await fixture({ stored: "1" });
	assert.equal(f.isOpen(), true);
	assert.match(f.aside().className, /\bw-72\b/);
	assert.doesNotMatch(f.aside().className, /\bfixed\b/);
	assert.equal(f.backdrop(), null, "no backdrop beside the page");
	assert.match(f.toggleSlot().className, /\bw-0\b/, "the header toggle collapses while the sidebar is open");
	await f.press(f.toggleButton());
	assert.equal(f.isOpen(), false);
	assert.deepEqual(f.writes, [[KEY, "0"]]);
	assert.equal(f.aside().hasAttribute("inert"), false, "the computer's closed sidebar is as it was");
});

test("on a phone the drawer starts closed whatever the computer had saved", async () => {
	const f = await fixture({ phone: true, stored: "1" });
	assert.equal(f.isOpen(), false);
	assert.match(f.aside().className, /\bw-0\b/);
	assert.doesNotMatch(f.aside().className, /shadow/, "a closed drawer casts no shadow");
	assert.equal(f.backdrop(), null);
	assert.equal(f.aside().hasAttribute("inert"), true, "nothing in a closed drawer takes focus or is read out");
	assert.equal(f.toggleButton().getAttribute("aria-hidden"), "false", "the menu button is there to open it");
	assert.deepEqual(f.queries, ["(max-width: 767px)"], "the same 768px line the phone: styles use");
});

test("the menu button opens the drawer over the page with a backdrop, and saves nothing", async () => {
	const f = await fixture({ phone: true, stored: "1" });
	await f.press(f.toggleButton());
	assert.equal(f.isOpen(), true);
	assert.match(f.aside().className, /\bfixed\b/);
	assert.match(f.aside().className, /w-\[min\(20rem,85vw\)\]/);
	assert.ok(f.backdrop(), "a dimmed backdrop appears behind the drawer");
	assert.equal(f.aside().hasAttribute("inert"), false, "an open drawer is live");
	assert.equal(f.toggleButton().getAttribute("aria-hidden"), "false", "the title does not slide: the toggle keeps its place");
	assert.doesNotMatch(f.toggleSlot().className, /\bw-0\b/);
	await f.press(f.toggleButton());
	assert.equal(f.isOpen(), false, "pressing it again closes the drawer");
	assert.deepEqual(f.writes, [], "the phone's open drawer is never the computer's saved choice");
});

test("a tap outside the drawer closes it", async () => {
	const f = await fixture({ phone: true });
	await f.press(f.toggleButton());
	assert.equal(f.isOpen(), true);
	await f.press(f.backdrop()!);
	assert.equal(f.isOpen(), false);
	assert.equal(f.backdrop(), null);
});

test("a swipe left on the drawer closes it; scrolling, short drags and a swipe right do not", async () => {
	const f = await fixture({ phone: true });
	await f.press(f.toggleButton());
	await f.swipe([250, 300], [100, 640]);
	assert.equal(f.isOpen(), true, "a mostly vertical drag is the list scrolling");
	await f.swipe([250, 300], [210, 300]);
	assert.equal(f.isOpen(), true, "40px is a touch, not a swipe");
	await f.swipe([100, 300], [260, 300]);
	assert.equal(f.isOpen(), true, "a swipe right leaves it open");
	await f.swipe([250, 300], [100, 330]);
	assert.equal(f.isOpen(), false, "150px left, nearly level: closed");
});

test("a swipe left on the dimmed strip beside the drawer closes it too, by the same rule", async () => {
	const f = await fixture({ phone: true });
	await f.press(f.toggleButton());
	await f.swipe([360, 300], [200, 640], "sidebar-backdrop");
	assert.equal(f.isOpen(), true, "a mostly vertical drag on the strip does nothing");
	await f.swipe([360, 300], [330, 300], "sidebar-backdrop");
	assert.equal(f.isOpen(), true, "30px is a touch, not a swipe");
	await f.swipe([200, 300], [360, 300], "sidebar-backdrop");
	assert.equal(f.isOpen(), true, "a swipe right leaves it open");
	await f.swipe([360, 300], [250, 310], "sidebar-backdrop");
	assert.equal(f.isOpen(), false, "110px left, nearly level: closed");
	assert.equal(f.backdrop(), null);
});

test("going to another page closes the drawer", async () => {
	const f = await fixture({ phone: true });
	await f.press(f.toggleButton());
	assert.equal(f.isOpen(), true);
	await f.goTo("/chat/b");
	assert.equal(f.isOpen(), false);
});

test("the drawer does not carry over when the window crosses the phone line", async () => {
	const f = await fixture({ phone: true, stored: "1" });
	await f.press(f.toggleButton());
	assert.equal(f.isOpen(), true);
	await f.resize(false);
	assert.equal(f.isOpen(), true, "wider than a phone: the computer's saved choice (open) applies");
	assert.doesNotMatch(f.aside().className, /\bfixed\b/);
	assert.equal(f.backdrop(), null);
	await f.resize(true);
	assert.equal(f.isOpen(), false, "back to phone width: closed again, not left open");
	assert.deepEqual(f.writes, []);
});

test("on a computer a swipe on the sidebar does nothing", async () => {
	const f = await fixture({ stored: "1" });
	await f.swipe([250, 300], [100, 300]);
	assert.equal(f.isOpen(), true);
});

test("a browser without matchMedia behaves like a computer, and the listener is removed on unmount", async () => {
	const none = await fixture({ matchMedia: false, stored: "1" });
	assert.equal(none.isOpen(), true);
	await teardown();
	const f = await fixture({ phone: true });
	assert.equal(f.listening, 1);
	await teardown();
	assert.equal(f.listening, 0);
});

test("opening the drawer moves focus into it and makes the page behind it inert until it closes", async () => {
	const f = await fixture({ phone: true });
	assert.equal(f.page().hasAttribute("inert"), false);
	await f.press(f.toggleButton());
	assert.equal(f.doc.activeElement === f.aside(), true, "a keyboard or a screen reader starts in the drawer"); // booleans: a failing assert must not try to print a whole DOM
	assert.equal(f.aside().getAttribute("aria-label"), "Sidebar");
	assert.equal(f.page().hasAttribute("inert"), true, "the dimmed page cannot be used through the drawer");
	await f.press(f.backdrop()!);
	assert.equal(f.page().hasAttribute("inert"), false, "closed: the page is live again");
});

test("on a computer the page is never made inert and the sidebar takes no focus", async () => {
	const f = await fixture({ stored: "1" });
	assert.equal(f.page().hasAttribute("inert"), false);
	assert.equal(f.aside().hasAttribute("tabindex"), false);
	await f.press(f.toggleButton());
	await f.press(f.toggleButton());
	assert.equal(f.page().hasAttribute("inert"), false);
	assert.equal(f.doc.activeElement === f.aside(), false);
});

test("Escape closes the open drawer, except while a field inside is using the key", async () => {
	const f = await fixture({ phone: true });
	await f.key(f.sessions(), "Escape");
	assert.equal(f.isOpen(), false, "closed already: nothing to do");
	await f.press(f.toggleButton());
	await f.key(f.field(), "Escape");
	assert.equal(f.isOpen(), true, "Escape in the rename or search field belongs to the field");
	await f.key(f.sessions(), "Tab");
	assert.equal(f.isOpen(), true, "other keys do nothing");
	await f.key(f.sessions(), "Escape");
	assert.equal(f.isOpen(), false);
});

test("on a computer Escape in the sidebar does not close it", async () => {
	const f = await fixture({ stored: "1" });
	await f.key(f.sessions(), "Escape");
	assert.equal(f.isOpen(), true);
});

test("the phone: variant skips the desktop app, and no component uses max-md: directly", () => {
	const css = readFileSync("app/globals.css", "utf8");
	assert.match(css, /@custom-variant phone \{\s*@media \(max-width: 767px\) \{\s*&:where\(:not\(\.lh-electron \*\)\) \{\s*@slot;/, "768px line, everywhere except html.lh-electron");
	const direct: string[] = [];
	for (const dir of ["components", "app"]) {
		for (const file of readdirSync(dir, { recursive: true }) as string[]) {
			if (/\.(tsx|ts|css)$/.test(file) && readFileSync(`${dir}/${file}`, "utf8").includes("max-md:")) direct.push(`${dir}/${file}`);
		}
	}
	assert.deepEqual(direct, [], "a bare max-md: would also turn the desktop app's narrow window into a phone");
});

