"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHATGPT_USAGE_URL, type ChatGPTStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

/** Shared account controls for first-run setup and Settings → Keys. */
export function ChatGPTConnection({ compact = false, initialStatus, onStatusChange }: {
	compact?: boolean;
	initialStatus?: ChatGPTStatus | null;
	onStatusChange?: (status: ChatGPTStatus) => void;
} = {}) {
	const [status, setStatus] = useState<ChatGPTStatus | null>(initialStatus ?? null);
	const wasConnected = useRef(initialStatus?.connected ?? false);
	const [busy, setBusy] = useState(false);
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const read = useCallback(async (signal?: AbortSignal) => {
		const response = await fetch("/api/chatgpt", { signal });
		if (!response.ok) throw new Error("Could not read ChatGPT connection");
		const next: ChatGPTStatus = await response.json();
		setStatus(next);
		onStatusChange?.(next);
		if (next.connected !== wasConnected.current) {
			wasConnected.current = next.connected;
			notifySettingsSaved("keys");
		}
		return next;
	}, [onStatusChange]);
	useEffect(() => {
		const controller = new AbortController();
		void read(controller.signal).catch(() => { if (!controller.signal.aborted) setError("Could not load ChatGPT connection."); });
		return () => controller.abort();
	}, [read]);
	useEffect(() => {
		if (!status?.pending) return;
		const controller = new AbortController();
		let active = false;
		const timer = setInterval(async () => {
			if (active) return;
			active = true;
			try {
				const next = await read(controller.signal);
				if (!next.pending) {
					setUrl(null);
				}
			} catch { /* A transient poll failure must not cancel browser sign-in. */ }
			finally { active = false; }
		}, 1000);
		return () => { clearInterval(timer); controller.abort(); };
	}, [status?.pending, read]);
	async function action(kind: "connect" | "disconnect" | "cancel") {
		setBusy(true); setError(null);
		try {
			const response = await fetch(kind === "disconnect" ? "/api/chatgpt" : "/api/chatgpt/login", { method: kind === "connect" ? "POST" : "DELETE" });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.error ?? "ChatGPT connection could not be updated.");
			if (kind === "connect") {
				setUrl(body.url);
				const next = { connected: status?.connected ?? false, email: status?.email ?? null, error: null, pending: true };
				setStatus(next);
				onStatusChange?.(next);
				window.open(body.url, "_blank", "noopener,noreferrer");
			} else {
				setStatus(body); setUrl(null);
				wasConnected.current = body.connected;
				onStatusChange?.(body);
				notifySettingsSaved("keys");
			}
		} catch (failure) { setError(failure instanceof Error ? failure.message : "ChatGPT connection failed."); }
		finally { setBusy(false); }
	}
	const buttonClass = "inline-flex items-center gap-2 rounded-sm border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50";
	const controls = <>
		{status?.pending ? <>
			<span role="status">Waiting for browser sign-in…</span>
			{url && <a href={url} target="_blank" rel="noreferrer" className="underline">Open sign-in in browser</a>}
			<button type="button" className={buttonClass} disabled={busy} onClick={() => void action("cancel")}>Cancel sign-in</button>
		</> : <>
			<button type="button" className={buttonClass} disabled={busy || !status} onClick={() => void action("connect")}><span aria-hidden="true" className="size-4 bg-current" style={{ mask: "url(/chatgpt-logo.svg) center / contain no-repeat" }} />{status?.connected ? "Reconnect ChatGPT" : "Continue with ChatGPT"}</button>
			{status?.connected && <>
				<a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" className="underline">Manage usage ↗</a>
				<button type="button" className={buttonClass} disabled={busy} onClick={() => void action("disconnect")}>Disconnect</button>
			</>}
		</>}
	</>;
	return <div data-testid="chatgpt-connection" className={`flex flex-col gap-2 text-xs ${compact ? "px-1 py-1.5" : "py-3"}`}>
		{compact && status?.connected && !status.pending ? (
			<div className="flex items-center justify-between gap-3">
				<span className="shrink-0 font-ui text-foreground">ChatGPT plan</span>
				<span className="ml-auto truncate text-muted-foreground">{status.email ?? "Connected"}</span>
				<details className="relative">
					<summary aria-label="ChatGPT connection options" className="cursor-pointer list-none rounded-sm px-2 text-muted-foreground hover:bg-accent">⋯</summary>
					<div className="absolute right-0 z-10 mt-1 flex w-56 flex-col items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-xl">
						{controls}
					</div>
				</details>
			</div>
		) : <>
			<div className="font-medium text-foreground">ChatGPT</div>
			<p className="text-muted-foreground">{status?.connected ? `${status.email ?? "ChatGPT account"} · ChatGPT plan usage enabled` : "Use your eligible ChatGPT Plus or Pro plan in LearnHarness."}</p>
			<div className="flex flex-wrap items-center gap-2">{controls}</div>
		</>}
		{(error || status?.error) && <p role="alert" className="text-red-500">{error ?? status?.error}</p>}
	</div>;
}
