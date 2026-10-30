import { wrapLanguageModel } from "ai";
import { isRecord, TranslatableError } from "../errors";
import type { ChatLanguageModel } from "./models";

/** OpenRouter's forced-choice filter can reject an endpoint that implements the Tool (#2248). */
export function withOpenRouterRouting(
  model: ChatLanguageModel,
  baseUrl: string,
  fetcher: typeof globalThis.fetch,
): ChatLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        const choice = params.toolChoice;
        const wireChoice = params.providerOptions?.openrouter?.tool_choice;
        const named =
          choice?.type === "tool" || (isRecord(wireChoice) && wireChoice.type === "function");
        if (!named && choice?.type !== "required" && wireChoice !== "required") return params;
        const url = `${baseUrl.replace(/\/$/, "")}/models/${model.modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`;
        let result: unknown;
        try {
          const response = await fetcher(url, { signal: params.abortSignal });
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
                data_collection: "deny",
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
