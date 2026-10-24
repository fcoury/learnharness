import { chatGPT, isLocalChatGPTRequest } from "@/src/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
	if (!chatGPT.status().pending) await chatGPT.refreshModels();
	return Response.json(chatGPT.status(), { headers: { "cache-control": "no-store" } });
}
export async function DELETE(request: Request) {
	if (!isLocalChatGPTRequest(request)) return new Response(null, { status: 403 });
	await chatGPT.disconnect();
	return Response.json(chatGPT.status());
}
