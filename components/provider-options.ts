/** Connection choices are UI-only; API-key and ChatGPT storage remain independent. */
export interface ProviderKeyInfo {
	id: string;
	envVar: string;
	label: string;
}
export interface ChatGPTOption {
	id: "chatgpt";
	label: "ChatGPT";
}
export type ProviderOption = ProviderKeyInfo | ChatGPTOption;
export const CHATGPT_OPTION: ChatGPTOption = { id: "chatgpt", label: "ChatGPT" };
export function isChatGPTOption(option: ProviderOption): option is ChatGPTOption {
	return !("envVar" in option);
}
export function providerDisplayLabel(option: ProviderOption): string {
	return option.id === "openai" ? "OpenAI API" : option.label;
}
