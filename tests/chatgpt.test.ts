import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { createModels, Type, type OAuthCredential, normalizeContext } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createChatGPTStore } from "../src/store/chatgpt.ts";
import { createChatGPTService, verifyChatGPTIdentity, isLocalChatGPTRequest } from "../src/server/chatgpt.ts";
import { chatGPTPayload, createChatGPTProvider } from "../src/agent/chatgpt-provider.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { callCost } from "../src/core/prices.ts";
import { isProviderKeyRefusal, providerKeyMissing } from "../src/core/settings.ts";

const scopes = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";
const nativeModel = openaiProvider().getModels().find(model => model.id === "gpt-6.1-sol")!;
const model = { ...nativeModel, provider: "chatgpt", compat: { ...nativeModel.compat, supportsMidConvoEffort: false, supportsToolSearch: false } };
const pair = await generateKeyPair("RS256");
const jwk = await exportJWK(pair.publicKey);
const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] });
async function identity(nonce: string, audience = "oaiapp_fixture", overrides = {}) {
	return new SignJWT({ nonce, email: "fixture@example.test", ...overrides }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer("https://auth.openai.com").setAudience(audience).setSubject("fixture-user").setIssuedAt().setExpirationTime((overrides as { exp?: number }).exp ?? "1h").sign(pair.privateKey);
}
function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chatgpt-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = createChatGPTStore(path.join(dir, "chatgpt.json"));
	let auth = new URL("https://example.test");
	let tokenScope = scopes;
	let badNonce = false;
	const exchanges: URLSearchParams[] = [];
	const service = createChatGPTService(store, {
		verifyIdentity: (token, clientId, nonce) => verifyChatGPTIdentity(token, clientId, nonce, jwks),
		getAuth: async () => "fixture-access",
		catalog: () => [nativeModel],
		fetch: async (input, init) => {
			if (String(input).endsWith("/models")) return Response.json({ models: [
				{ slug: nativeModel.id, display_name: "Fixture GPT", visibility: "list" },
				{ slug: "unknown-future-model", visibility: "list" },
				{ slug: "hidden", visibility: "hidden" },
			] });
			const params = new URLSearchParams(init?.body as URLSearchParams);
			exchanges.push(params);
			return Response.json({ id_token: await identity(badNonce ? "wrong" : auth.searchParams.get("nonce")!), access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, scope: tokenScope, token_type: "Bearer" });
		},
	});
	t.after(() => service.cancel());
	async function begin() { auth = new URL(await service.start()); return auth; }
	async function callback(params: Record<string, string> = {}) {
		const url = new URL(auth.searchParams.get("redirect_uri")!);
		url.search = new URLSearchParams({ code: "fixture-code", state: auth.searchParams.get("state")!, client_id: "oaiapp_fixture", ...params }).toString();
		const res = await fetch(url);
		const text = await res.text();
		// finish may be delivered just after the browser has received the body.
		await new Promise(resolve => setImmediate(resolve));
		return { status: res.status, text };
	}
	return { dir, store, service, exchanges, begin, callback, declineScope: () => { tokenScope = "openid email profile"; }, wrongNonce: () => { badNonce = true; } };
}

describe("ChatGPT registration and credentials", () => {
	it("registers, verifies identity, discovers eligible models, persists privately, and reuses registration", async t => {
		const f = fixture(t);
		const first = await f.begin();
		assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client");
		assert.equal(first.searchParams.get("agent_name_hint"), "LearnHarness");
		assert.match(first.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
		assert.equal(new URL(first.searchParams.get("redirect_uri")!).hostname, "127.0.0.1");
		assert.equal((await f.callback()).status, 200);
		assert.deepEqual(f.service.status(), { connected: true, email: "fixture@example.test", pending: false, error: null });
		const exchange = f.exchanges[0]!;
		assert.equal(exchange.get("client_id"), "oaiapp_fixture");
		assert.equal(exchange.get("redirect_uri"), first.searchParams.get("redirect_uri"));
		assert.equal(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url"), first.searchParams.get("code_challenge"));
		assert.equal(exchange.has("client_secret"), false);
		await f.service.refreshModels();
		assert.equal(f.store.read()?.models?.length, 1);
		assert.equal(f.store.read()?.models?.[0]?.provider, "chatgpt");
		assert.equal(f.store.read()?.models?.[0]?.name, "Fixture GPT");
		assert.equal(fs.statSync(path.join(f.dir, "chatgpt.json")).mode & 0o777, 0o600);
		const reopened = createChatGPTStore(path.join(f.dir, "chatgpt.json"));
		assert.equal(reopened.read()?.registration?.subject, "fixture-user");
		const second = await f.begin();
		assert.equal(second.searchParams.get("client_id"), "oaiapp_fixture");
		assert.equal(second.searchParams.get("ext_agent_host_id"), first.searchParams.get("ext_agent_host_id"));
		assert.ok(second.searchParams.get("id_token_hint"));
		assert.notEqual(second.searchParams.get("state"), first.searchParams.get("state"));
		// Returning callbacks may omit client_id.
		const returning = new URL(second.searchParams.get("redirect_uri")!);
		returning.search = new URLSearchParams({ code: "returning", state: second.searchParams.get("state")! }).toString();
		assert.equal((await fetch(returning)).status, 200);
		await f.service.disconnect();
		assert.equal(f.service.status().connected, false);
		assert.equal(f.store.read()?.credential, undefined);
		assert.equal(f.store.read()?.models, undefined);
		assert.equal(f.store.read()?.registration?.idToken, undefined);
		assert.equal(f.store.read()?.registration?.clientId, "oaiapp_fixture");
	});
	it("rejects invalid state without consuming the pending attempt, then handles refusal", async t => {
		const f = fixture(t); await f.begin();
		assert.equal((await f.callback({ state: "wrong" })).status, 400);
		assert.equal(f.service.status().pending, true);
		assert.equal(f.exchanges.length, 0);
		assert.equal((await f.callback({ error: "access_denied" })).status, 400);
		assert.equal(f.exchanges.length, 0);
		assert.equal(f.service.status().pending, false);
		assert.equal(f.service.status().connected, false);
		assert.ok(f.service.status().error);
	});
	it("rejects a missing plan scope and mismatched ID-token nonce", async t => {
		for (const kind of ["scope", "nonce"]) {
			const f = fixture(t); await f.begin();
			if (kind === "scope") f.declineScope(); else f.wrongNonce();
			assert.equal((await f.callback()).status, 400);
			assert.equal(f.store.read()?.credential, undefined);
			assert.equal(f.store.read()?.pendingClientId, "oaiapp_fixture");
			const retry = await f.begin();
			assert.equal(retry.searchParams.get("client_id"), "oaiapp_fixture");
			assert.equal(retry.searchParams.get("prompt"), "consent");
		}
	});
	it("preserves an existing connection when reauthorization returns a different client", async t => {
		const f = fixture(t); await f.begin(); await f.callback();
		await f.begin();
		assert.equal((await f.callback({ client_id: "oaiapp_attacker" })).status, 400);
		assert.equal(f.exchanges.length, 1);
		assert.equal(f.service.status().connected, true);
		assert.equal(f.store.read()?.registration?.clientId, "oaiapp_fixture");
	});
	it("cancels without persisting credentials or leaving a listener", async t => {
		const f = fixture(t); const auth = await f.begin(); f.service.cancel();
		assert.equal(f.service.status().pending, false);
		await assert.rejects(fetch(auth.searchParams.get("redirect_uri")!));
		assert.equal(f.store.read()?.credential, undefined);
	});
	it("rejects a bad signature, audience, and expiration", async () => {
		await assert.rejects(verifyChatGPTIdentity(await identity("nonce"), "other-client", "nonce", jwks));
		await assert.rejects(verifyChatGPTIdentity(await identity("nonce", "oaiapp_fixture", { exp: 1 }), "oaiapp_fixture", "nonce", jwks));
		const foreign = await generateKeyPair("RS256");
		const token = await new SignJWT({ nonce: "nonce" }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer("https://auth.openai.com").setAudience("oaiapp_fixture").setSubject("user").setIssuedAt().setExpirationTime("1h").sign(foreign.privateKey);
		await assert.rejects(verifyChatGPTIdentity(token, "oaiapp_fixture", "nonce", jwks));
	});
	it("rejects cross-origin, missing-origin, and non-local mutations", () => {
		assert.equal(isLocalChatGPTRequest(new Request("http://localhost:3000/api/chatgpt", { headers: { origin: "http://localhost:3000" } })), true);
		assert.equal(isLocalChatGPTRequest(new Request("http://localhost:3000/api/chatgpt", { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } })), true);
		for (const origin of [undefined, "https://attacker.test", "http://localhost:3001"]) assert.equal(isLocalChatGPTRequest(new Request("http://localhost:3000/api/chatgpt", { headers: origin ? { origin } : {} })), false);
		assert.equal(isLocalChatGPTRequest(new Request("https://example.test/api/chatgpt", { headers: { origin: "https://example.test" } })), false);
	});
	it("does not overwrite corrupt credential data", async t => {
		const f = fixture(t); const file = path.join(f.dir, "chatgpt.json");
		fs.writeFileSync(file, "broken");
		await assert.rejects(f.service.start());
		assert.equal(fs.readFileSync(file, "utf8"), "broken");
	});
});

describe("ChatGPT provider integration", () => {
	it("serializes concurrent token refresh and retains the replacement token", async t => {
		const f = fixture(t);
		await f.store.update(data => { data.credential = { type: "oauth", clientId: "oaiapp_fixture", access: "expired", refresh: "original", expires: 0, scopes: scopes.split(" ") }; });
		const originalFetch = globalThis.fetch;
		t.after(() => { globalThis.fetch = originalFetch; });
		let refreshes = 0;
		globalThis.fetch = async (input, init) => {
			assert.equal(String(input), "https://auth.openai.com/api/accounts/oauth/token");
			const body = new URLSearchParams(init?.body as URLSearchParams);
			assert.equal(body.get("client_id"), "oaiapp_fixture");
			assert.equal(body.get("refresh_token"), "original");
			refreshes++;
			return Response.json({ access_token: "renewed", refresh_token: "replacement", expires_in: 3600, scope: scopes });
		};
		const models = createModels({ credentials: f.store.credentials });
		models.setProvider(createChatGPTProvider(() => [model]));
		const results = await Promise.all(Array.from({ length: 5 }, () => models.getAuth("chatgpt")));
		assert.equal(refreshes, 1);
		assert.ok(results.every(result => result?.auth.apiKey === "renewed"));
		assert.equal((f.store.read()?.credential as OAuthCredential).refresh, "replacement");
		await models.logout("chatgpt");
		assert.equal(await models.getAuth("chatgpt"), undefined);
	});
	it("uses the public Responses endpoint with subscription-safe fields and namespaced tools", async t => {
		const f = fixture(t);
		await f.store.update(data => { data.credential = { type: "oauth", access: "fixture-oauth", refresh: "fixture-refresh", clientId: "oaiapp_fixture", scopes: scopes.split(" "), expires: Date.now() + 3600_000 }; });
		const models = createModels({ credentials: f.store.credentials });
		models.setProvider(createChatGPTProvider(() => [model]));
		let payload: Record<string, unknown> = {};
		const message = await models.streamSimple(model, normalizeContext({
			systemPrompt: "Teach precisely.",
			messages: [{ role: "user", content: "Explain addition", timestamp: 1 }],
			tools: [{ name: "quiz", description: "Ask a quiz", parameters: Type.Object({ question: Type.String() }) }],
		}), {
			temperature: 0.5, maxTokens: 100, maxRetries: 0,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				assert.equal(request.url, "https://api.openai.com/v1/responses");
				assert.equal(request.headers.get("authorization"), "Bearer fixture-oauth");
				payload = JSON.parse(await request.text());
				const events = [
					{ type: "response.created", response: { id: "resp_fixture" } },
					{ type: "response.output_item.added", output_index: 0, item: { id: "msg_fixture", type: "message", role: "assistant", content: [] } },
					{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Two." },
					{ type: "response.completed", response: { id: "resp_fixture", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
				];
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			},
		}).result();
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.equal(message.provider, "chatgpt");
		assert.equal(payload.store, false); assert.equal(payload.stream, true);
		for (const key of ["temperature", "max_output_tokens", "previous_response_id"]) assert.equal(key in payload, false);
		assert.ok((payload.tools as { type: string }[] | undefined)?.[0]?.type === "namespace"
			|| (payload.input as { type?: string }[]).some(item => item.type === "additional_tools"));
		const grouped = chatGPTPayload({ tools: [{ type: "function", name: "quiz" }] });
		assert.equal((grouped.tools as { type: string }[])[0]?.type, "namespace");
		assert.ok(!(payload.input as { role?: string }[]).some(item => item.role === "system"));
	});
	it("runs a native teaching tool round and replays its result through completion", async t => {
		const f = fixture(t);
		await f.store.update(data => { data.credential = { type: "oauth", access: "fixture-access", refresh: "refresh", clientId: "oaiapp_fixture", scopes: scopes.split(" "), expires: Date.now() + 3600_000 }; });
		const models = createModels({ credentials: f.store.credentials });
		models.setProvider(createChatGPTProvider(() => [model]));
		let requests = 0;
		let executions = 0;
		const fetchFn: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const body = await request.json();
			requests++;
			if (requests > 1) {
				const call = body.input.find((item: { type?: string }) => item.type === "function_call");
				const result = body.input.find((item: { type?: string }) => item.type === "function_call_output");
				assert.ok(call && result, "the next request contains both sides of the tool call");
				assert.equal(call.call_id, result.call_id);
				assert.equal(call.namespace, "functions");
			}
			const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", namespace: "functions", arguments: '{"topic":"addition"}' };
			const message = { type: "message", id: "msg_done", role: "assistant", content: [{ type: "output_text", text: "Two." }] };
			const item = requests === 1 ? call : message;
			const events = [
				{ type: "response.created", response: { id: `resp_${requests}` } },
				{ type: "response.output_item.added", output_index: 0, item: requests === 1 ? { ...call, arguments: "" } : { ...message, content: [] } },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 30, output_tokens: 5 } } },
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		};
		const agent = createTeacherAgent(undefined, {
			engine: { model, streamFn: (requestModel, context, options) => models.streamSimple(requestModel, context, { ...options, fetch: fetchFn, maxRetries: 0 }) },
			tools: { lookup: { name: "lookup", label: "Lookup", description: "Look up a concept", parameters: Type.Object({ topic: Type.String() }), execute: async () => { executions++; return { content: [{ type: "text", text: "One plus one is two." }], details: {} }; } } },
		});
		await agent.prompt("Teach addition.");
		assert.equal(executions, 1);
		assert.equal(requests, 2);
		const last = agent.state.messages.at(-1);
		assert.equal(last?.role, "assistant");
		if (last?.role === "assistant") assert.equal(last.stopReason, "stop", last.errorMessage);
	});
	it("reports a disconnected ChatGPT pin as setup required and never infers an API charge", () => {
		const refusal = providerKeyMissing("chatgpt", ["strong"]);
		assert.match(refusal.error, /reconnect/);
		assert.equal(isProviderKeyRefusal(refusal.error), true);
		assert.equal(callCost({ inputTokens: 100, outputTokens: 20 }, "chatgpt:gpt-6.1-sol"), null);
	});
});
