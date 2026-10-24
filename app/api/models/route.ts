import { modelCatalog, chatGPT } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog for API-key providers; ChatGPT refreshes the account catalog.
 */
export async function GET() {
	await chatGPT.refreshModels();
	return Response.json(modelCatalog());
}
