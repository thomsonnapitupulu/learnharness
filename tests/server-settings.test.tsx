import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ServerSettings } from "../components/settings/server-settings.tsx";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});

type SetResult = { ok: true } | { ok: false; cancelled?: boolean; error?: string };
let root: Root | undefined, host: HTMLDivElement | undefined;
const windowWithBridge = dom.window as unknown as { lh?: unknown };

/** Mount the row with a bridge that answers `state`, and records what set() is asked. */
async function mount(state: { mode: "local" | "remote"; address: string | null } | "absent" | "no server member" | "get rejects", set: (address: string | null) => Promise<SetResult> = async () => ({ ok: true })) {
	const asked: (string | null)[] = [];
	windowWithBridge.lh = state === "absent" ? undefined
		: state === "no server member" ? { platform: "darwin" }
		: { server: { get: () => (state === "get rejects" ? Promise.reject(new Error("no")) : Promise.resolve(state)), set: (address: string | null) => { asked.push(address); return set(address); } } };
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<ServerSettings />));
	return asked;
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Server address"]')!;
async function type(value: string) {
	await act(async () => {
		input().value = value;
		input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
async function submit() {
	await act(async () => { input().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = host = undefined;
	windowWithBridge.lh = undefined;
});

test("there is no Server row in a browser, in the dev shell, or when the app cannot say", async () => {
	for (const state of ["absent", "no server member", "get rejects"] as const) {
		await mount(state);
		assert.equal(host!.innerHTML, "", state);
		await act(async () => root?.unmount());
		host?.remove();
	}
});

test("on this computer it says so and offers an address box with Connect", async () => {
	await mount({ mode: "local", address: null });
	assert.match(byTest("server-state")!.textContent!, /Using this computer\. Your sessions and notes are stored here\./);
	assert.equal(input().getAttribute("placeholder"), "learn.example.com");
	assert.equal(byTest("server-connect")!.textContent!.trim(), "Connect");
	assert.equal(byTest("server-use-computer"), null);
	assert.equal(byTest("server-origin"), null, "no address line on this computer");
});

test("Connect sends what was typed, untouched, and then shows that the app is restarting", async () => {
	const asked = await mount({ mode: "local", address: null });
	await type("  Learn.Example.com/chat  ");
	await submit();
	assert.deepEqual(asked, ["  Learn.Example.com/chat  "], "the app validates and normalizes, not the page");
	assert.equal(byTest("server-message")!.textContent, "Restarting…");
	assert.equal(byTest("server-message")!.getAttribute("role"), "status");
	assert.ok(!byTest("server-message")!.className.split(/\s+/).includes("text-error"), "and Restarting… is not an error");
	assert.equal(input().getAttribute("aria-invalid"), null, "nor is the box invalid");
	assert.equal(input().getAttribute("aria-describedby"), null);
	assert.equal(input().disabled, true);
	assert.equal((byTest("server-connect") as HTMLButtonElement).disabled, true);
});

test("a refusal is shown as an alert and the box is usable again with the text kept", async () => {
	await mount({ mode: "local", address: null }, async () => ({ ok: false, error: "Use an https:// address. Plain http is only for this computer." }));
	await type("http://learn.example.com");
	await submit();
	assert.equal(byTest("server-message")!.textContent, "Use an https:// address. Plain http is only for this computer.");
	assert.equal(byTest("server-message")!.getAttribute("role"), "alert");
	assert.ok(byTest("server-message")!.className.split(/\s+/).includes("text-error"), "an error looks like the other Settings errors");
	assert.equal(input().disabled, false);
	assert.equal(input().value, "http://learn.example.com");
	assert.equal(input().getAttribute("aria-invalid"), "true", "the box says it is invalid");
	assert.equal(input().getAttribute("aria-describedby"), byTest("server-message")!.id, "and points at the message that says why");
});

test("Cancel in the confirmation leaves no message and nothing locked", async () => {
	await mount({ mode: "local", address: null }, async () => ({ ok: false, cancelled: true }));
	await type("learn.example.com");
	await submit();
	assert.equal(byTest("server-message"), null);
	assert.equal(input().disabled, false);
	assert.equal(input().value, "learn.example.com");
});

test("a request that fails outright says so instead of hanging", async () => {
	await mount({ mode: "local", address: null }, () => Promise.reject(new Error("ipc")));
	await type("learn.example.com");
	await submit();
	assert.equal(byTest("server-message")!.textContent, "The server could not be changed.");
	assert.equal(input().disabled, false);
});

test("with a server it names it and offers only the way back to this computer", async () => {
	const asked = await mount({ mode: "remote", address: "https://learn.example.com" });
	assert.equal(byTest("server-state")!.textContent, "Using the server at");
	assert.equal(byTest("server-origin")!.textContent, "https://learn.example.com", "the address alone on its line, with no full stop after it");
	assert.match(host!.textContent!, /Your sessions and notes are stored there\./);
	assert.equal(document.querySelector("input"), null);
	await act(async () => byTest("server-use-computer")!.click());
	assert.deepEqual(asked, [null]);
	assert.equal(byTest("server-message")!.textContent, "Restarting…");
	assert.equal((byTest("server-use-computer") as HTMLButtonElement).disabled, true);
});

test("General shows the row between the update rows and the sign-out rows", () => {
	const dialog = readFileSync(new URL("../components/settings/settings-dialog.tsx", import.meta.url), "utf8");
	const general = dialog.slice(dialog.indexOf('testid="section-general"'));
	const [update, server, access] = ["<UpdateSettings", "<ServerSettings />", "<AccessSettings />"].map((tag) => general.indexOf(tag));
	assert.ok(update! > 0 && update! < server! && server! < access!, `${update} ${server} ${access}`);
});
