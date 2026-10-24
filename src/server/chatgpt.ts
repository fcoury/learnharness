import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { OAuthCredential, Api, Model } from "@earendil-works/pi-ai";
import type { ChatGPTStore } from "../store/chatgpt.ts";
import { CHATGPT_PROVIDER, type ChatGPTStatus } from "../core/chatgpt.ts";
import { piModels } from "../agent/models.ts";
import { chatGPTStore } from "./stores.ts";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const tokenResponse = z.object({
	id_token: z.string().min(1),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().finite().positive(),
	scope: z.string(),
	token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
});
const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function verifyChatGPTIdentity(token: string, clientId: string, nonce: string, jwks: JWTVerifyGetKey = keys) {
	const { payload } = await jwtVerify(token, jwks, {
		issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
		requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
	});
	if (!payload.sub || payload.nonce !== nonce) throw new Error("ChatGPT identity verification failed");
	return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
}

/** Fail closed for cross-origin and non-local callers before any credential mutation. */
export function isLocalChatGPTRequest(request: Request): boolean {
	try {
		const url = new URL(request.url);
		// Next reconstructs request.url using its bind hostname. Match the
		// browser's origin against the actual local Host, including its port.
		const origin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`);
		return ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
			&& request.headers.get("origin") === origin.origin;
	} catch { return false; }
}

type Pending = { state: string; nonce: string; verifier: string; redirectUri: string; clientId?: string; subject?: string; server: Server; timer?: ReturnType<typeof setTimeout>; controller: AbortController; completing: boolean };

/** All routes share one login attempt. The callback listener is bound only to loopback. */
export function createChatGPTService(store: ChatGPTStore, deps: {
	fetch?: typeof fetch;
	verifyIdentity?: typeof verifyChatGPTIdentity;
	getAuth?: () => Promise<string>;
	catalog?: () => readonly Model<Api>[];
} = {}) {
	const fetchFn = deps.fetch ?? fetch;
	let pending: Pending | undefined;
	let error: string | null = null;
	let catalogCheckedAt = 0;
	let refreshing: Promise<void> | undefined;
	function status(): ChatGPTStatus {
		const data = store.read();
		const connected = data?.credential?.type === "oauth" && Array.isArray(data.credential.scopes)
			&& data.credential.scopes.includes("chatgpt.tokens.use.direct");
		return { connected: !!connected, email: connected ? data?.registration?.email ?? null : null, pending: !!pending, error };
	}
	function stop(attempt: Pending) {
		clearTimeout(attempt.timer);
		attempt.controller.abort();
		attempt.server.close();
		attempt.server.closeAllConnections();
		if (pending === attempt) pending = undefined;
	}
	function cancel() { if (pending) stop(pending); }
	function page(response: ServerResponse, ok: boolean) {
		response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
		response.end(`<!doctype html><html><title>LearnHarness · ChatGPT</title><body style="font:18px system-ui;padding:3rem"><h1>${ok ? "ChatGPT connected" : "ChatGPT was not connected"}</h1><p>${ok ? "Return to LearnHarness to choose your models. You can close this tab." : "Return to LearnHarness and try signing in again."}</p></body></html>`);
	}
	async function start(): Promise<string> {
		if (pending) throw new Error("A ChatGPT sign-in is already in progress");
		error = null;
		// Persist the host before opening the browser, even for a cancelled first sign-in.
		const data = await store.update(data => structuredClone(data));
		if (pending) throw new Error("A ChatGPT sign-in is already in progress");
		const controller = new AbortController();
		const attempt: Pending = {
			state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url"),
			verifier: randomBytes(64).toString("base64url"), redirectUri: "",
			clientId: data.registration?.clientId ?? data.pendingClientId, subject: data.registration?.subject,
			controller, completing: false,
			server: createServer((request, response) => { void callback(request.url ?? "", response, attempt); }),
		};
		pending = attempt;
		try {
			await new Promise<void>((resolve, reject) => {
				attempt.server.once("error", reject);
				attempt.server.listen(0, "127.0.0.1", () => resolve());
			});
			controller.signal.throwIfAborted();
			const address = attempt.server.address();
			if (!address || typeof address === "string") throw new Error("Could not start ChatGPT callback");
			attempt.redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
			attempt.timer = setTimeout(() => { error = "ChatGPT sign-in timed out. Try again."; stop(attempt); }, 5 * 60_000);
			attempt.timer.unref();
			const url = new URL(AUTHORIZE);
			url.search = new URLSearchParams({
				client_id: attempt.clientId ?? "dynamic_agent_client",
				...(attempt.clientId ? {} : { agent_name_hint: "LearnHarness" }),
				...(data.pendingClientId ? { prompt: "consent" } : {}),
				...(data.registration?.idToken ? { id_token_hint: data.registration.idToken } : {}),
				ext_agent_host_id: `urn:uuid:${data.deviceId}`,
				response_type: "code", redirect_uri: attempt.redirectUri, resource: RESOURCE, scope: SCOPES,
				state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256",
				code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
			}).toString();
			return url.toString();
		} catch {
			stop(attempt);
			throw new Error("Could not start ChatGPT sign-in. Try again.");
		}
	}
	async function callback(raw: string, response: ServerResponse, attempt: Pending) {
		let url: URL;
		try { url = new URL(raw, attempt.redirectUri || "http://127.0.0.1"); }
		catch { page(response, false); return; }
		// Invalid requests must not consume or cancel the actual user's attempt.
		if (pending !== attempt || attempt.completing || url.pathname !== "/auth/callback" || url.searchParams.get("state") !== attempt.state) {
			page(response, false); return;
		}
		attempt.completing = true;
		try {
			if (url.searchParams.has("error")) throw new Error("Authorization declined");
			const code = url.searchParams.get("code");
			const clientId = url.searchParams.get("client_id") ?? attempt.clientId;
			if (!code || !clientId || clientId === "dynamic_agent_client" || (attempt.clientId && clientId !== attempt.clientId)) throw new Error("Invalid callback");
			if (!attempt.clientId) {
				await store.update(data => {
					attempt.controller.signal.throwIfAborted();
					data.pendingClientId = clientId;
				});
			}
			const res = await fetchFn(TOKEN, {
				method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }),
				signal: attempt.controller.signal,
			});
			if (!res.ok) throw new Error("Code exchange failed");
			const tokens = tokenResponse.parse(await res.json());
			const identity = await (deps.verifyIdentity ?? verifyChatGPTIdentity)(tokens.id_token, clientId, attempt.nonce);
			if (attempt.subject && identity.subject !== attempt.subject) throw new Error("Account did not match");
			const scopes = tokens.scope.split(/\s+/);
			if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("Plan usage was not authorized");
			const credential: OAuthCredential = {
				type: "oauth", access: tokens.access_token, refresh: tokens.refresh_token,
				expires: Date.now() + tokens.expires_in * 1000, clientId, scopes,
			};
			await store.update(data => {
				attempt.controller.signal.throwIfAborted();
				data.registration = { clientId, ...identity, idToken: tokens.id_token };
				delete data.pendingClientId;
				data.credential = credential;
				delete data.models;
			});
			catalogCheckedAt = 0;
			page(response, true);
		} catch {
			if (pending === attempt) error = "ChatGPT sign-in failed or plan usage was not authorized. Reconnect and allow ChatGPT plan usage.";
			page(response, false);
		} finally {
			// Allow the success/failure page to finish before closing browser keepalive sockets.
			response.once("finish", () => stop(attempt));
			if (response.writableFinished) stop(attempt);
		}
	}
	async function refreshModels(force = false) {
		if (!status().connected || (!force && Date.now() - catalogCheckedAt < 60_000)) return;
		if (refreshing) return refreshing;
		const registration = store.read()?.registration?.clientId;
		refreshing = (async () => {
			let stage = "authentication";
			try {
				const access = deps.getAuth ? await deps.getAuth() : (await piModels().getAuth(CHATGPT_PROVIDER))?.auth.apiKey;
				if (!access) throw new Error("No connected ChatGPT account");
				stage = "request";
				const response = await fetchFn(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15_000) });
				if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
				stage = "catalog";
				const body = await response.json();
				if (!Array.isArray(body.models)) throw new Error("Invalid model catalog");
				const known = deps.catalog?.() ?? piModels().getModels("openai");
				// pi-ai owns capabilities/limits. Never invent limits for an unknown model.
				const models = body.models.filter((entry: { visibility?: string }) => entry.visibility === "list").flatMap((entry: { slug?: string; display_name?: string }) => {
					const model = known.find(model => model.id === entry.slug);
					return model ? [{ ...model, provider: CHATGPT_PROVIDER, name: entry.display_name ?? model.name, compat: { ...model.compat, supportsToolSearch: false, supportsMidConvoEffort: false } }] : [];
				});
				if (!models.length) throw new Error("No supported ChatGPT models available");
				stage = "persistence";
				await store.update(data => {
					if (data.credential && data.registration?.clientId === registration) data.models = models;
				});
				error = null;
			} catch (failure) {
				console.error("ChatGPT model discovery failed", { stage, name: failure instanceof Error ? failure.name : "Error", code: (failure as { cause?: { code?: string } })?.cause?.code });
				error = "Could not load ChatGPT models. Check your connection or reconnect ChatGPT.";
			} finally {
				catalogCheckedAt = Date.now();
				refreshing = undefined;
			}
		})();
		return refreshing;
	}
	async function disconnect() {
		cancel();
		await store.credentials.delete(CHATGPT_PROVIDER);
		error = null;
		catalogCheckedAt = 0;
	}
	return { status, start, cancel, disconnect, refreshModels };
}
const key = Symbol.for("lh.chatgptService");
const globals = globalThis as Record<symbol, ReturnType<typeof createChatGPTService> | undefined>;
export const chatGPT = globals[key] ??= createChatGPTService(chatGPTStore);
