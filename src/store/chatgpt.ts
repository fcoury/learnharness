import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Credential, CredentialStore, Model, Api } from "@earendil-works/pi-ai";
import { AUTH_FILE } from "../../config.ts";
import { CHATGPT_PROVIDER } from "../core/chatgpt.ts";

export interface ChatGPTData {
	deviceId: string;
	/** Issued registration retained if its first code exchange fails. */
	pendingClientId?: string;
	registration?: { clientId: string; subject: string; email: string | null; idToken?: string };
	credential?: Credential;
	models?: Model<Api>[];
}

/** One writer, private atomic snapshots; credentials never enter the flat env-key store. */
export function createChatGPTStore(file: string) {
	let chain: Promise<unknown> = Promise.resolve();
	function read(): ChatGPTData | undefined {
		try {
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!data || typeof data.deviceId !== "string") throw new Error("Invalid ChatGPT connection file");
			return data;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	function save(data: ChatGPTData) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, file);
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	}
	function update<T>(fn: (data: ChatGPTData) => Promise<T> | T): Promise<T> {
		const result = chain.then(async () => {
			const data = read() ?? { deviceId: randomUUID() };
			const value = await fn(data);
			save(data);
			return value;
		});
		chain = result.catch(() => {});
		return result;
	}
	const credentials: CredentialStore = {
		async read(id) { return id === CHATGPT_PROVIDER ? read()?.credential : undefined; },
		async list() {
			const credential = read()?.credential;
			return credential ? [{ providerId: CHATGPT_PROVIDER, type: credential.type }] : [];
		},
		async modify(id, fn, options) {
			if (id !== CHATGPT_PROVIDER) return undefined;
			return update(async data => {
				options?.signal?.throwIfAborted();
				const next = await fn(data.credential);
				if (next) data.credential = next;
				return data.credential;
			});
		},
		async delete(id, options) {
			if (id !== CHATGPT_PROVIDER) return;
			await update(data => {
				options?.signal?.throwIfAborted();
				delete data.credential;
				delete data.models;
				if (data.registration) delete data.registration.idToken;
			});
		},
	};
	return { read, update, credentials };
}
export type ChatGPTStore = ReturnType<typeof createChatGPTStore>;
// HMR must preserve the refresh serialization queue shared by all routes.
const key = Symbol.for("lh.chatgptStore");
const globals = globalThis as Record<symbol, ChatGPTStore | undefined>;
export const chatGPTStore = globals[key] ??= createChatGPTStore(path.join(path.dirname(AUTH_FILE), "chatgpt.json"));
