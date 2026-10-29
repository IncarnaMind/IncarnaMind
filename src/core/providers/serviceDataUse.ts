import { CATALOG_PROVIDERS, catalogProvider } from "./catalog/providers";
import type { DataUse } from "./catalog/types";

export function dataUseForService(serviceId: string): DataUse | undefined {
  // Cohere's rerank API uses api.cohere.com; its OpenAI-compatible chat API uses api.cohere.ai.
  if (serviceId === "https://api.cohere.com") return catalogProvider("cohere")?.dataUse;
  return CATALOG_PROVIDERS.find((provider) =>
    provider.endpoints.some((endpoint) => new URL(endpoint.baseUrl).origin === serviceId),
  )?.dataUse;
}
