import type { ExternalService } from "../api";
import { CATALOG_PROVIDERS, catalogProvider } from "./catalog/providers";
import type { DataUse } from "./catalog/types";
import { RERANK_SERVICES } from "./rerankServices";

export function dataUseForService(service: ExternalService): DataUse | undefined {
  const rerank = Object.values(RERANK_SERVICES).find((each) => each.id === service.id);
  const provider =
    catalogProvider(service.catalogId ?? rerank?.catalogId) ??
    CATALOG_PROVIDERS.find((each) =>
      each.endpoints.some((endpoint) => new URL(endpoint.baseUrl).origin === service.id),
    );
  return provider?.dataUse;
}
