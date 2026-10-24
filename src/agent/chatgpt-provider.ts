import type { Api, CredentialStore, Model, Provider, OAuthCredential, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CHATGPT_PROVIDER } from "../core/chatgpt.ts";

/** Subscription requests have a narrower contract than API-key requests. */
export function chatGPTPayload(value: unknown): Record<string, unknown> {
	const payload: Record<string, unknown> = { ...(value as Record<string, unknown>), store: false, stream: true };
	for (const key of ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]) delete payload[key];
	if (Array.isArray(payload.tools) && payload.tools.length) {
		payload.tools = [{ type: "namespace", name: "functions", description: "LearnHarness tools", tools: payload.tools }];
	}
	return payload;
}

export function createChatGPTProvider(getModels: () => readonly Model<Api>[]): Provider {
	const native = openaiProvider();
	const oauth = native.auth.oauth!;
	const options = (input?: SimpleStreamOptions): SimpleStreamOptions => ({
		...input,
		onPayload: async (payload, model) => chatGPTPayload(await input?.onPayload?.(payload, model) ?? payload),
	});
	return {
		id: CHATGPT_PROVIDER,
		name: "ChatGPT",
		baseUrl: native.baseUrl,
		auth: { oauth: {
			...oauth,
			async login() { throw new Error("Connect ChatGPT through LearnHarness settings"); },
			async refresh(credential, signal) {
				return { ...credential, ...await oauth.refresh(credential, signal) } as OAuthCredential;
			},
		} },
		getModels,
		stream: (model, context, input) => native.stream(model as Model<"openai-responses">, context, options(input as SimpleStreamOptions)),
		streamSimple: (model, context, input) => native.streamSimple(model as Model<"openai-responses">, context, options(input)),
	};
}
export interface ChatGPTModelRuntime {
	credentials: CredentialStore;
	getModels(): readonly Model<Api>[];
}
