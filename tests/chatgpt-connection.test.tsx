import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { ChatGPTConnection } from "../components/chatgpt-connection.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

async function click(label: string) {
	const button = [...document.querySelectorAll("button")].find(button => button.textContent === label);
	assert.ok(button, `Missing ${label}`);
	await act(async () => { button.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}

async function clickId(testid: string) {
	const button = document.querySelector(`[data-testid="${testid}"]`);
	assert.ok(button, `Missing ${testid}`);
	await act(async () => { button.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}

describe("ChatGPT connection UI", () => {
	it("advances keyless onboarding to model selection only after browser authorization", async t => {
		const original = globalThis.fetch;
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original; });
		let pending = false, connected = false, starts = 0, saves = 0;
		let opened = "";
		dom.window.open = ((url: string) => { opened = url; return null; }) as typeof window.open;
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (init?.method === "POST") {
				assert.equal(url, "/api/chatgpt/login"); starts++; pending = true;
				return Response.json({ url: "https://auth.openai.com/api/accounts/authorize?fixture=1" });
			}
			assert.equal(init?.method ?? "GET", "GET", "sign-in must not silently pick or save models");
			if (url === "/api/chatgpt") {
				if (pending) { pending = false; connected = true; }
				return Response.json({ connected, pending, email: connected ? "fixture@example.test" : null, error: null });
			}
			if (url === "/api/keys") return Response.json({ keys: [], providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }] });
			assert.equal(url, "/api/models");
			return Response.json({
				providers: [{ id: "chatgpt", keyPresent: connected }],
				models: connected ? [{ id: "fixture", name: "Fixture model", provider: "chatgpt", input: ["text", "image"], supportedLevels: ["off"], cost: { input: 0, output: 0 }, contextWindow: 8192 }] : [],
				slots: { strong: null, cheap: null, vision: null },
			});
		};
		await act(async () => root.render(<SetupDialog open onClose={() => {}} onDone={() => { saves++; }} />));
		assert.equal(document.querySelector('[data-testid="chatgpt-connection"]'), null, "sign-in is tucked into the provider selector");
		await clickId("setup-key-provider");
		await clickId("provider-option-chatgpt");
		assert.equal(document.querySelector('[data-testid="setup-key-input"]'), null, "ChatGPT never asks for an API key");
		await clickId("setup-key-provider");
		assert.equal(document.querySelector('[data-testid="provider-list"] button')?.getAttribute("data-testid"), "provider-option-chatgpt");
		await clickId("provider-option-openai");
		assert.ok(document.querySelector('[data-testid="setup-key-input"]'), "OpenAI still offers its API-key input");
		assert.equal(document.querySelector('[data-testid="chatgpt-connection"]'), null);
		await clickId("setup-key-provider");
		await clickId("provider-option-chatgpt");
		assert.equal(starts, 0, "selecting a provider never starts authorization");
		await click("Continue with ChatGPT");
		assert.equal(starts, 1);
		assert.equal(new URL(opened).hostname, "auth.openai.com");
		assert.match(document.body.textContent ?? "", /Waiting for browser sign-in/);
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
		assert.ok(document.querySelector('[data-testid="setup-stage-pickers"]'));
		assert.equal(saves, 0);
	});
	it("disconnects explicitly and renders the sign-in option again", async t => {
		const original = globalThis.fetch;
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original; });
		let connected = true, deletions = 0;
		globalThis.fetch = async (input, init) => {
			assert.equal(String(input), "/api/chatgpt");
			if (init?.method === "DELETE") { deletions++; connected = false; }
			return Response.json({ connected, pending: false, email: connected ? "fixture@example.test" : null, error: null });
		};
		await act(async () => root.render(<ChatGPTConnection />));
		assert.match(host.textContent ?? "", /fixture@example.test/);
		assert.equal(host.querySelector("a")?.getAttribute("href"), "https://chatgpt.com/settings/usage");
		await click("Disconnect");
		assert.equal(deletions, 1);
		assert.match(host.textContent ?? "", /Continue with ChatGPT/);
		assert.ok(!host.textContent?.includes("fixture@example.test"));
	});
	it("keeps ChatGPT and an OpenAI API key as independent connections", async t => {
		const original = globalThis.fetch;
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original; });
		let connected = true;
		const mutations: string[] = [];
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			const chatgpt = { connected, pending: false, email: connected ? "fixture@example.test" : null, error: null };
			if (url === "/api/keys") return Response.json({
				keys: [{ id: "OPENAI_API_KEY", info: null, present: true, masked: "…test (20 chars)", source: "file", shadowedByEnv: false }],
				providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }], chatgpt,
			});
			assert.equal(url, "/api/chatgpt");
			if (init?.method === "DELETE") { connected = false; mutations.push(url); }
			return Response.json({ ...chatgpt, connected, email: connected ? chatgpt.email : null });
		};
		await act(async () => root.render(<KeysSection />));
		assert.match(host.textContent ?? "", /ChatGPT plan/);
		assert.match(host.textContent ?? "", /OpenAI API/);
		assert.ok(host.querySelector('summary[aria-label="ChatGPT connection options"]'));
		await act(async () => host.querySelector("details")!.setAttribute("open", ""));
		await click("Disconnect");
		assert.deepEqual(mutations, ["/api/chatgpt"], "disconnect never deletes the independent API key");
		assert.equal(host.querySelector('[data-testid="chatgpt-connection"]'), null);
		assert.ok(host.querySelector('[data-testid="key-openai_api_key"]'));
		await clickId("add-provider");
		assert.ok(document.querySelector('[data-testid="provider-option-chatgpt"]'), "ChatGPT can be added again while the API key remains connected");
		await clickId("provider-option-chatgpt");
		assert.match(host.textContent ?? "", /Continue with ChatGPT/);
		assert.ok(host.querySelector('[data-testid="key-openai_api_key"]'));
	});

});
