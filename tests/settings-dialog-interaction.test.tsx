import React, { act, useState } from "react";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider, useInteractionLayers, type CloseOutcome, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { SettingsDialogProvider, useSettingsDialog } from "../components/settings/settings-dialog.tsx";
import { installModalDom } from "./modal-dom.ts";

let root: Root | undefined;
let restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const byTest = (id: string) => {
	const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert(element, `missing ${id}`);
	return element;
};

function fixture() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const globals = { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	restore = () => {
		restoreModal();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	let settingsReads = 0;
	globalThis.fetch = async input => {
		if (String(input) === "/api/settings") {
			settingsReads++;
			return Response.json({ settings: { version: 1 } });
		}
		if (String(input) === "/api/keys") return Response.json({ keys: [], providers: [] });
		if (String(input) === "/api/settings/prompts") return Response.json({ prober: [], teacher: [], practice: [] });
		if (String(input) === "/api/models") return Response.json({ models: [], slots: {}, providers: [] });
		if (String(input) === "/api/search") return Response.json({ available: false });
		return Response.json({});
	};
	let controller!: InteractionLayersController;
	let settings!: ReturnType<typeof useSettingsDialog>;
	let setChildren!: React.Dispatch<React.SetStateAction<string[]>>;
	let outcome: CloseOutcome = "closed";
	const closeCalls: string[] = [];
	function Harness() {
		controller = useInteractionLayers();
		settings = useSettingsDialog();
		const [children, changeChildren] = useState<string[]>([]);
		setChildren = changeChildren;
		return <>{children.map(id => <HostDialog key={id} open layerId={id} aria-label={id}
			onClose={() => {
				closeCalls.push(id);
				if (outcome === "closed") changeChildren(previous => previous.filter(child => child !== id));
				return outcome;
			}}><h2>{id}</h2><input data-testid={`${id}-draft`} defaultValue="child draft" /></HostDialog>)}</>;
	}
	root = createRoot(document.querySelector("#root")!);
	return {
		controller: () => controller,
		closeCalls,
		settingsReads: () => settingsReads,
		outcome(next: CloseOutcome) { outcome = next; },
		async mount() {
			await act(async () => root!.render(<InteractionLayersProvider><SettingsDialogProvider><Harness /></SettingsDialogProvider></InteractionLayersProvider>));
		},
		async open(section = "appearance", row?: string) { await act(async () => settings.open(section, row)); },
		async child(id: string) { await act(async () => setChildren(previous => [...previous, id])); },
		async disposeChildren() { await act(async () => setChildren([])); },
		async escape() {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Escape" });
			await act(async () => { controller.captureKeyDown(event as unknown as KeyboardEvent); document.dispatchEvent(event); });
			return event;
		},
	};
}

afterEach(async () => {
	await act(async () => root?.unmount()); root = undefined;
	await new Promise(resolve => setTimeout(resolve, 5));
	restore?.(); restore = undefined; globalThis.fetch = originalFetch;
});

it("Settings remains painted, mounted and stateful beneath a child; one Escape restores only Settings", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const frame = byTest("settings-dialog"), content = byTest("settings-content");
	const modal = frame.closest<HTMLElement>("[data-interaction-layer]")!;
	const invoker = byTest("settings-nav-appearance");
	await act(async () => invoker.focus()); content.scrollTop = 47;
	await f.child("child");
	assert.equal(frame.isConnected, true); assert.equal(frame.hidden, false);
	assert.notEqual(frame.style.display, "none"); assert.equal(modal.hasAttribute("inert"), true);
	assert.equal(content.scrollTop, 47); assert.equal(f.settingsReads(), 1);
	assert.equal(document.activeElement?.getAttribute("data-testid"), "child-draft");
	const event = await f.escape();
	assert.equal(event.defaultPrevented, true); assert.deepEqual(f.closeCalls, ["child"]);
	assert.ok(byTest("settings-dialog") === frame); assert.equal(modal.hasAttribute("inert"), false);
	assert.equal(content.scrollTop, 47); assert.equal(f.settingsReads(), 1);
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(document.activeElement === invoker, `focus returned to ${document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName}`);
	await f.escape(); assert.equal(document.querySelector('[data-testid="settings-dialog"]'), null);
});

it("on a phone the Settings window fills the visible screen, the sections become a row along the top, and its buttons are 44px (story 6)", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const has = (id: string, ...tokens: string[]) => {
		const list = byTest(id).className.split(/\s+/);
		for (const token of tokens) assert.ok(list.includes(token), `${id}: ${token}`);
	};
	has("settings-dialog", "phone:fixed", "phone:inset-x-0", "phone:top-[var(--lh-vv-top,0px)]", "phone:h-[var(--lh-vvh,100dvh)]", "phone:max-h-none", "phone:w-auto", "phone:max-w-none",
		"phone:rounded-none", "phone:border-0", "phone:pt-[env(safe-area-inset-top)]", "phone:pl-[env(safe-area-inset-left)]", "phone:pr-[env(safe-area-inset-right)]", "phone:pb-[env(safe-area-inset-bottom)]", "[html[data-lh-keyboard]_&]:pb-0");
	has("settings-nav", "phone:w-auto", "phone:flex-row", "phone:overflow-x-auto", "phone:overflow-y-hidden", "phone:border-r-0", "phone:border-b");
	has("settings-close", "phone:size-11");
	has("settings-nav-appearance", "phone:min-h-11", "phone:whitespace-nowrap");
	assert.ok(byTest("settings-content").closest('[data-testid="settings-dialog"]')!.querySelector(".phone\\:flex-col"), "the nav and the page stack on a phone");
	for (const hr of byTest("settings-nav").querySelectorAll("hr")) assert.ok(hr.className.split(/\s+/).includes("phone:hidden"), "the dividers between nav groups do not make sense in a row");
	// and the two section grids that were too wide for a phone
	const root = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
	assert.match(root("components/settings/theme-cards.tsx"), /grid grid-cols-3 gap-3 phone:grid-cols-2/);
	assert.match(root("components/settings/appearance-section.tsx"), /grid grid-cols-2 gap-x-10 gap-y-2 phone:grid-cols-1/);
});

for (const outcome of ["blocked", "handled-without-close", "pending"] as const) {
	it(`return-to Settings stops at ${outcome} without retargeting or queued navigation`, async () => {
		const f = fixture(); await f.mount(); await f.open(); await f.child("guarded"); f.outcome(outcome);
		const frame = byTest("settings-dialog");
		await f.open("agent");
		assert.deepEqual(f.closeCalls, ["guarded"]);
		assert.equal(byTest("settings-nav-appearance").getAttribute("aria-current"), "true");
		assert.equal(byTest("settings-nav-agent").getAttribute("aria-current"), "false");
		assert.ok(byTest("settings-dialog") === frame);
		await f.disposeChildren();
		assert.equal(byTest("settings-nav-appearance").getAttribute("aria-current"), "true", "later cancellation completion must not trigger queued navigation");
		await f.open("agent");
		assert.equal(byTest("settings-nav-agent").getAttribute("aria-current"), "true");
		assert.equal(f.settingsReads(), 1);
	});
}

it("return-to closes each intervening layer once, top down, then retargets the same Settings instance", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const frame = byTest("settings-dialog");
	await f.child("lower"); await f.child("upper"); await f.open("graph");
	assert.deepEqual(f.closeCalls, ["upper", "lower"]);
	assert.equal(document.querySelectorAll('[data-testid="settings-dialog"]').length, 1);
	assert.ok(byTest("settings-dialog") === frame);
	assert.equal(byTest("settings-nav-graph").getAttribute("aria-current"), "true");
	assert.equal(f.settingsReads(), 1);
	assert.equal(f.controller().getSnapshot().length, 1);
});

it("fresh Settings opens above an existing dialog and is not destroyed by unloading that dialog", async () => {
	const f = fixture(); await f.mount(); await f.child("plugin-origin");
	const origin = byTest("plugin-origin-draft");
	await f.open();
	const frame = byTest("settings-dialog");
	assert.equal(origin.isConnected, true);
	assert.equal(origin.closest("[data-interaction-layer]")?.hasAttribute("inert"), true);
	assert.ok(f.controller().getActiveModal()?.rootRef.current === frame.closest("[data-interaction-layer]"));
	await f.disposeChildren();
	assert.ok(byTest("settings-dialog") === frame); assert.equal(f.controller().getSnapshot().length, 1);
	assert.deepEqual(f.closeCalls, [], "external unload is not a domain close request");
});

it("same-instance Settings retarget synchronously invalidates an older pending opening intent", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const intent = f.controller().beginOpening(byTest("settings-nav-appearance"));
	assert.equal(f.controller().isOpeningCurrent(intent), true);
	await f.open();
	assert.equal(f.controller().isOpeningCurrent(intent), false);
	assert.equal(f.settingsReads(), 1);
});
