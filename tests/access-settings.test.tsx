import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AccessSettings } from "../components/settings/access-settings.tsx";

const dom = parseHTML("<html><body></body></html>");
const assigned: string[] = [];
Object.assign(globalThis, {
	window: Object.assign(dom.window, { location: { assign: (url: string) => assigned.push(url) } }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;

async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AccessSettings />));
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = host = undefined;
	globalThis.fetch = originalFetch;
	assigned.length = 0;
});

test("shows nothing when the server has no sign-in, or cannot say", async () => {
	for (const reply of [() => Response.json({ enabled: false }), () => new Response("no", { status: 401 }), () => { throw new Error("offline"); }]) {
		globalThis.fetch = (async () => reply()) as typeof fetch;
		await mount();
		assert.equal(host!.innerHTML, "");
		await act(async () => root?.unmount());
		host?.remove();
	}
});

test("a synchronous fetch failure is not an error either", async () => {
	globalThis.fetch = (() => { throw new Error("no fetch yet"); }) as typeof fetch;
	await mount();
	assert.equal(host!.innerHTML, "");
});

test("with a sign-in on, offers Sign out as a POST form and Sign out of all devices", async () => {
	globalThis.fetch = (async () => Response.json({ enabled: true })) as typeof fetch;
	await mount();
	const form = byTest("sign-out")!.closest("form")!;
	assert.equal(form.getAttribute("method"), "post");
	assert.equal(form.getAttribute("action"), "/logout");
	assert.ok(byTest("sign-out-all"));
	assert.match(host!.textContent ?? "", /Ends every session/);
});

test("Sign out everywhere posts the action, then goes to the sign-in page", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		return init?.method === "POST" ? Response.json({ ok: true }) : Response.json({ enabled: true });
	}) as typeof fetch;
	await mount();
	await act(async () => byTest("sign-out-all")!.click());
	const post = calls.find((call) => call.init?.method === "POST")!;
	assert.equal(post.url, "/api/access");
	assert.deepEqual(JSON.parse(post.init!.body as string), { action: "sign-out-all" });
	assert.deepEqual(assigned, ["/login"]);
});

test("a failed sign-out stays on the page and says so", async () => {
	globalThis.fetch = (async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Response("no", { status: 500 }) : Response.json({ enabled: true })) as typeof fetch;
	await mount();
	await act(async () => byTest("sign-out-all")!.click());
	assert.deepEqual(assigned, []);
	assert.match(byTest("row-sign-out-all")!.textContent ?? "", /Could not sign out/);
	assert.equal(byTest("sign-out-all")!.hasAttribute("disabled"), false, "can try again");
});
