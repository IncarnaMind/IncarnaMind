import type { ExternalService, RerankServiceKind } from "../api";

/** Where each rerank service's requests go, and its provider in the catalog. */
export const RERANK_SERVICES: Readonly<Record<RerankServiceKind, ExternalService>> = {
  cohere: { id: "https://api.cohere.com", name: "Cohere", catalogId: "cohere" },
  voyage: { id: "https://api.voyageai.com", name: "Voyage AI" },
};
