import { wrapLanguageModel } from "ai";
import { isRecord, TranslatableError } from "../errors";
import { catalogProviderOfKind } from "./catalog";
import type { ChatLanguageModel } from "./models";

/** OpenRouter's forced-choice filter can reject an endpoint that implements the Tool (#2248). */
export function withOpenRouterRouting(
  model: ChatLanguageModel,
  baseUrl: string,
  fetcher: typeof globalThis.fetch,
): ChatLanguageModel {
  const policy = catalogProviderOfKind("openrouter")?.request?.body?.provider;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        const choice = params.toolChoice;
        const named = choice?.type === "tool";
        if (!named && choice?.type !== "required") return params;
        const url = `${baseUrl.replace(/\/$/, "")}/models/${model.modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`;
        let result: unknown;
        try {
          const signal = AbortSignal.any([
            ...(params.abortSignal ? [params.abortSignal] : []),
            AbortSignal.timeout(5_000),
          ]);
          const response = await fetcher(url, { signal });
          if (!response.ok)
            throw new Error(`OpenRouter endpoint lookup failed (${response.status}).`);
          result = await response.json();
        } catch (cause) {
          params.abortSignal?.throwIfAborted();
          throw new TranslatableError({ key: "error.provider.openrouterCapabilities" }, { cause });
        }
        const endpoints = isRecord(result) && isRecord(result.data) ? result.data.endpoints : null;
        const json = params.responseFormat?.type === "json";
        const schema = params.responseFormat?.type === "json" && params.responseFormat.schema;
        const capable = Array.isArray(endpoints)
          ? endpoints.filter(
              (endpoint): endpoint is Record<string, unknown> =>
                isRecord(endpoint) &&
                typeof endpoint.tag === "string" &&
                endpoint.tag.trim() !== "" &&
                Array.isArray(endpoint.supported_parameters) &&
                endpoint.supported_parameters.includes("tools") &&
                (!json || endpoint.supported_parameters.includes("response_format")) &&
                (!schema || endpoint.supported_parameters.includes("structured_outputs")),
            )
          : [];
        if (capable.length === 0)
          throw new TranslatableError({ key: "error.provider.openrouterCapabilities" });
        const name = named ? "function" : "required";
        if (
          capable.some(
            (endpoint) =>
              isRecord(endpoint.supports_tool_choice) &&
              endpoint.supports_tool_choice[name] === true,
          )
        )
          return params;
        return {
          ...params,
          providerOptions: {
            ...params.providerOptions,
            openrouter: {
              ...params.providerOptions?.openrouter,
              provider: {
                ...(isRecord(policy) ? policy : {}),
                require_parameters: false,
                only: [...new Set(capable.map((endpoint) => String(endpoint.tag)))],
                allow_fallbacks: false,
              },
            },
          },
        };
      },
    },
  });
}
