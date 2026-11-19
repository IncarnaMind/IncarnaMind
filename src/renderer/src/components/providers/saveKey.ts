import type { ChatProvider, ProviderError } from "../../../../core/api";
import { catalogProvider, kindOfCatalogId } from "../../../../core/providers/catalog/providers";
import type { MessageKey, MessageParams } from "../../../../shared/i18n";
import { core } from "../../core";
import { testErrorKey } from "./shared";

export type KeySaved =
  | { kind: "saved"; provider: ChatProvider; modelId: string }
  | { kind: "refused"; error: ProviderError }
  /** The service names no Answers model, so its key can't be used here. */
  | { kind: "unknown" };

/**
 * A key for a named service, tested with it and saved as that service's account, with its Answers
 * model (#1922). `keepDefault`: the Answers model stays as it is while there is one; the core makes
 * this one the Answers model when there is none.
 */
export async function testAndSaveKey({
  service,
  key,
  endpoint,
  keepDefault = false,
}: {
  service: string;
  key: string;
  endpoint: string | null;
  keepDefault?: boolean | "always";
}): Promise<KeySaved> {
  const modelId = catalogProvider(service)?.roles.answers;
  if (!modelId) return { kind: "unknown" };
  const request = {
    kind: kindOfCatalogId(service),
    catalogId: service,
    modelId,
    apiKey: key,
    ...(endpoint !== null && { endpoint }),
  };
  const result = await core.testChatConnection(request);
  if (!result.ok) return { kind: "refused", error: result.error };
  const provider = await core.saveChatProvider(keepDefault ? { ...request, keepDefault } : request);
  return { kind: "saved", provider, modelId };
}

/** What a refused key says, in one line: refused, out of credit, or what else went wrong. */
export function refusalWords(
  error: ProviderError,
  service: string,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  if (error.kind === "auth") return t("setup.key.refused");
  if (error.kind === "out-of-credit") return t("setup.key.credit");
  return t(testErrorKey(error.kind), { model: catalogProvider(service)?.roles.answers ?? "" });
}
