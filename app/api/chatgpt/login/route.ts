import { chatGPT, isLocalChatGPTRequest } from "@/src/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
	if (!isLocalChatGPTRequest(request)) return new Response(null, { status: 403 });
	try {
		return Response.json({ url: await chatGPT.start() }, { headers: { "cache-control": "no-store" } });
	} catch {
		return Response.json({ error: "Could not start ChatGPT sign-in. Cancel any pending sign-in and try again." }, { status: 409 });
	}
}
export async function DELETE(request: Request) {
	if (!isLocalChatGPTRequest(request)) return new Response(null, { status: 403 });
	chatGPT.cancel();
	return Response.json(chatGPT.status());
}
