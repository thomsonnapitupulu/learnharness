import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";

// The desktop app keeps its own layout at every width: its window can be dragged
// down to 640px and zoomed in, and neither may turn it into a phone. The module
// decides "this is the desktop app" when it loads, so this file sets the user
// agent first and imports the sidebar after.

Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => "Mozilla/5.0 LearnHarness Electron/40.0.0" }); // no "Chrome" here: react-dom then probes window.location, which linkedom lacks
const { SidebarFrame, SidebarProvider, SidebarToggle } = await import("../components/sidebar.tsx");

test("in the desktop app a narrow window stays the desktop layout: no phone query, no drawer, the saved choice rules", async () => {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const queries: string[] = [];
	Object.assign(win, { matchMedia: (query: string) => { queries.push(query); return { matches: true, addEventListener() {}, removeEventListener() {} }; } });
	const saved = new Map<string, string>([["lh:sidebar-open", "1"]]);
	const writes: Array<[string, string]> = [];
	const localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { writes.push([key, value]); saved.set(key, value); } };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({ React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, CustomEvent: win.CustomEvent, localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	try {
		await act(async () => {
			root.render(
				<PathnameContext.Provider value="/chat/a">
					<SidebarProvider>
						<SidebarFrame><div>Sessions</div></SidebarFrame>
						<main><SidebarToggle /></main>
					</SidebarProvider>
				</PathnameContext.Provider>,
			);
		});
		const aside = doc.querySelector<HTMLElement>('[data-testid="sidebar"]')!;
		assert.deepEqual(queries, [], "the phone query is never asked in the desktop app");
		assert.equal(doc.documentElement.classList.contains("lh-electron"), true, "the class that switches the phone: styles off");
		assert.equal(aside.getAttribute("aria-hidden"), "false", "open, from the desktop's saved choice");
		assert.match(aside.className, /\bw-72\b/);
		assert.doesNotMatch(aside.className, /\bfixed\b/);
		assert.equal(aside.hasAttribute("inert"), false);
		assert.equal(doc.querySelector('[data-testid="sidebar-backdrop"]'), null);
		await act(async () => { doc.querySelector<HTMLElement>('button[aria-label="Open sidebar"]')!.click(); });
		assert.equal(aside.getAttribute("aria-hidden"), "true", "the toggle works as it always did");
		assert.deepEqual(writes, [["lh:sidebar-open", "0"]], "and saves the choice");
	} finally {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
