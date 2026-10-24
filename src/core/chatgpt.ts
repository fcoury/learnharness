/** Public connection state. Tokens and authorization URLs never appear here. */
export const CHATGPT_PROVIDER = "chatgpt";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
export interface ChatGPTStatus {
	connected: boolean;
	email: string | null;
	pending: boolean;
	error: string | null;
}
export function usesChatGPTPlan(model: string): boolean {
	return model.startsWith(`${CHATGPT_PROVIDER}:`);
}
