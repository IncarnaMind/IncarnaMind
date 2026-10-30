/**
 * The seam between provider settings and the AI SDK: everything that builds a
 * chat model goes through a `ChatModelFactory`. The core uses the AI SDK
 * providers by default; tests inject AI SDK mock models instead (ADR-0005).
 * Where a hosted provider's API is, and what every request to it carries,
 * come from the catalog (see ./catalog).
 */
import { createAlibaba } from "@ai-sdk/alibaba";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogle } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createZai } from "@ai-sdk/zai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, type LanguageModel, wrapLanguageModel } from "ai";
import type { ChatProviderKind } from "../api";
import type { OAuthCredentials } from "../oauthAccount";
import { catalogFacts, modelsProviderOfKind, withoutDateSuffix } from "./catalog";
import { catalogProviderOf, catalogProviderOfKind } from "./catalog/providers";
import type { ProviderOptions, RequestQuirks } from "./catalog/types";
import { createPlanChatModel } from "./chatgpt/planEndpoint";
import { createClaudeAccountChatModel } from "./claudeAccount/messages";
import { createCopilotChatModel } from "./copilot/requests";
import { endpointUrl } from "./kinds";
import { createOllamaChatModel } from "./ollamaChat";
import { DEFAULT_OLLAMA_SETTINGS, type OllamaModelSettings } from "./ollamaModels";
import { withOpenRouterRouting } from "./openrouterRouting";
import { withCacheBreakpoints } from "./promptCache";
import { withOptionsOver, withoutStorage } from "./responsesStore";
import type { RequestTransform } from "./signedFetch";
import { strictSchema } from "./strictSchema";

/** A model object, never a model id string (which the AI SDK would send to its gateway). */
export type ChatLanguageModel = Exclude<LanguageModel, string>;

/** Everything needed to build a chat model. */
export interface ChatModelSpec {
  kind: ChatProviderKind;
  /**
   * The API's base URL: a hosted provider's endpoint from the catalog (null:
   * the one `endpoint` names), the server's for "openai-compatible" and
   * "ollama", the plan's model endpoint for "chatgpt".
   */
  baseUrl: string | null;
  /** A hosted provider's endpoint id: which region's address and models it is (its first when left out). */
  endpoint?: string | null;
  /** A preset's catalog id, whose endpoint and request quirks it takes. */
  catalogId?: string | null;
  /**
   * "off": a small call that doesn't write the Answer (tagging, classifying),
   * which asks a model that thinks to skip it, where the provider lets it.
   * "summary": a call that writes the Answer, which asks a model that thinks
   * for its provider's summary of its reasoning, where there is one
   * (`reasoningSummaryOptions`).
   * "answer": the same with a modest budget, for the Answer to a Question.
   * "careful": the same with a larger budget, for an Answer to a Question
   * that asks to check or calculate.
   */
  thinking?: "off" | "summary" | "answer" | "careful";
  /** Small-call options reported by the server, ahead of the bundled catalog. */
  thinkingOff?: ProviderOptions;
  apiKey: string | null;
  modelId: string;
  /** "chatgpt", "claude-account" and "copilot": the User's sign-in, which signs (and refreshes) every request. */
  credentials?: OAuthCredentials;
  /** "claude-account" and "copilot": what the client profile adds to every request. */
  request?: RequestTransform;
  /** "ollama" only: the settings every request to the model carries (see ./ollamaModels). */
  ollama?: OllamaModelSettings;
}

/**
 * A model's context window: what one request may hold, in tokens, output
 * included, and how much of it is kept for the output. For a local model it
 * is the window IncarnaMind sets, and its server refuses a longer request
 * rather than cut it; for a cloud model it is the model's own, from the
 * catalog (see ./capabilities). The Answer engine keeps each request within it.
 */
export interface ContextWindow {
  tokens: number;
  outputTokens: number;
}

export type ChatModelFactory = (spec: ChatModelSpec) => ChatLanguageModel;

function requireKey(spec: ChatModelSpec): string {
  // Never fall back to the AI SDK's environment variables: keys come from the keychain only.
  if (!spec.apiKey) throw new Error(`An API key is required for ${spec.kind}.`);
  return spec.apiKey;
}

function requireBaseUrl(spec: ChatModelSpec): string {
  if (!spec.baseUrl) throw new Error(`A server URL is required for ${spec.kind}.`);
  return spec.baseUrl;
}

const hostedUrl = (spec: ChatModelSpec): string =>
  spec.baseUrl ?? endpointUrl(spec.kind, spec.endpoint, spec.catalogId) ?? requireBaseUrl(spec);

/**
 * The APIs sent a reply schema as it is written: Anthropic closes objects
 * itself, Gemini reads a smaller schema language, and the local server of
 * Ollama constrains a small model's decoding by the schema, where every
 * property forced would change what it writes. Every other API either
 * enforces OpenAI's strict rules (OpenAI, xAI, OpenRouter, DeepSeek, Kimi,
 * any server that takes `json_schema`) or accepts a schema that meets them
 * (#2146).
 */
const SCHEMA_AS_WRITTEN: ReadonlySet<ChatProviderKind> = new Set([
  "anthropic",
  "claude-account",
  "google",
  "ollama",
]);

function withStrictSchema(model: ChatLanguageModel): ChatLanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        const { responseFormat } = params;
        if (responseFormat?.type !== "json" || !responseFormat.schema) return params;
        return {
          ...params,
          responseFormat: { ...responseFormat, schema: strictSchema(responseFormat.schema) },
        };
      },
    },
  });
}

/**
 * The AI SDK provider for each kind, with what every request to its provider
 * carries: for OpenAI and xAI, `store: false`, as the Responses API keeps
 * requests unless every one says not to; for a small call, thinking off; for
 * the Answer's, the request for a summary of the model's reasoning; and for
 * an API that enforces a reply schema, the schema in its strict form.
 */
export const createAiSdkChatModel: ChatModelFactory = (spec) => {
  const request = catalogProviderOf(anthropicFor(spec.kind), spec.catalogId)?.request;
  let model = providerModel(spec);
  if (!SCHEMA_AS_WRITTEN.has(spec.kind)) model = withStrictSchema(model);
  if (request?.store === false) {
    model = withoutStorage(model, spec.kind === "xai" ? "xai" : "openai");
  }
  if (anthropicFor(spec.kind) === "anthropic") model = withCacheBreakpoints(model);
  if (spec.thinking === "off" && request?.thinkingOff && canSkipThinking(spec, request)) {
    model = withThinkingOff(model, spec, request.thinkingOff);
  }
  const summary = spec.thinking && spec.thinking !== "off" ? reasoningSummaryOptions(spec) : null;
  if (summary) model = withAnswerThinking(model, spec, summary);
  return model;
};

/** A Claude account's requests are Anthropic's Messages API, with what the catalog says of it. */
const anthropicFor = (kind: ChatProviderKind): ChatProviderKind =>
  kind === "claude-account" ? "anthropic" : kind;

/** The ChatGPT plan is OpenAI's Responses API: its reasoning is summarized as OpenAI's is. */
const summaryQuirk = (kind: ChatProviderKind) =>
  catalogProviderOfKind(kind === "chatgpt" ? "openai" : anthropicFor(kind))?.request
    ?.reasoningSummary;

/**
 * Whether a provider's reasoning comes back as its own summary (Anthropic,
 * OpenAI's Responses API), which an Answer may show; any other's is raw chain
 * of thought, which is never kept or shown (#391).
 */
export const summarizesReasoning = (kind: ChatProviderKind): boolean =>
  summaryQuirk(kind) !== undefined;

/**
 * The provider options that ask a model for a summary of its reasoning: none
 * for a provider that gives none, a model that doesn't think by default (it
 * isn't turned on for one), or one the catalog knows doesn't reason.
 */
export function reasoningSummaryOptions(
  spec: Pick<ChatModelSpec, "kind" | "modelId" | "endpoint" | "catalogId" | "thinking">,
): ProviderOptions | null {
  const summary = summaryQuirk(spec.kind);
  if (!summary) return null;
  if (summary.only && !summary.only.some((prefix) => spec.modelId.startsWith(prefix))) return null;
  const set = modelsProviderOfKind(spec.kind, spec.endpoint, spec.catalogId);
  if (catalogFacts(set, spec.modelId)?.reasoning === false) return null;
  if (spec.thinking === "careful") return summary.careful ?? summary.options;
  return (spec.thinking === "answer" && summary.answer) || summary.options;
}

/** Whether thinking can be turned off on this model: not on one the provider says always thinks, nor one the catalog knows doesn't think. */
function canSkipThinking(
  spec: ChatModelSpec,
  request: NonNullable<ReturnType<typeof catalogProviderOfKind>>["request"],
): boolean {
  const { unless = [], except = [] } = request?.thinkingOff ?? {};
  if (unless.some((prefix) => spec.modelId.startsWith(prefix))) return false;
  if (except.includes(spec.modelId) || except.includes(withoutDateSuffix(spec.modelId))) {
    return false;
  }
  const set = modelsProviderOfKind(spec.kind, spec.endpoint, spec.catalogId);
  return spec.thinkingOff !== undefined || catalogFacts(set, spec.modelId)?.reasoning !== false;
}

const namedByRefusal = new Map<string, ProviderOptions>();

function refusedForm(
  error: unknown,
  refused: readonly { names: string; options: ProviderOptions }[] | undefined,
): ProviderOptions | undefined {
  if (!APICallError.isInstance(error) || error.statusCode !== 400) return undefined;
  const said = `${error.message} ${error.responseBody ?? ""}`;
  return refused?.find((each) => said.includes(each.names))?.options;
}

/**
 * Every call carries the options of the model's form; a call a model refuses is asked again once
 * in the form `named` gives for its refusal, judged against the options that call sent, and that
 * form is kept for the model's later calls.
 */
function withRememberedForm(
  model: ChatLanguageModel,
  key: string,
  initial: () => ProviderOptions,
  named: (error: unknown, sent: ProviderOptions) => ProviderOptions | undefined,
): ChatLanguageModel {
  const options = () => namedByRefusal.get(key) ?? initial();
  const sentBy = new WeakMap<object, ProviderOptions>();
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => {
        const sent = options();
        const next = withOptionsOver(params, sent);
        sentBy.set(next, sent);
        return next;
      },
      wrapGenerate: async ({ doGenerate, params, model: inner }) => {
        try {
          return await doGenerate();
        } catch (error) {
          const form = named(error, sentBy.get(params) ?? options());
          if (!form) throw error;
          namedByRefusal.set(key, form);
          return inner.doGenerate(withOptionsOver(params, form));
        }
      },
      wrapStream: async ({ doStream, params, model: inner }) => {
        try {
          return await doStream();
        } catch (error) {
          const form = named(error, sentBy.get(params) ?? options());
          if (!form) throw error;
          namedByRefusal.set(key, form);
          return inner.doStream(withOptionsOver(params, form));
        }
      },
    },
  });
}

// A model the catalog doesn't know yet may refuse the provider's form; its refusal names the one it takes (#907).
function withThinkingOff(
  model: ChatLanguageModel,
  spec: ChatModelSpec,
  thinkingOff: NonNullable<RequestQuirks["thinkingOff"]>,
): ChatLanguageModel {
  const set = modelsProviderOfKind(spec.kind, spec.endpoint, spec.catalogId);
  return withRememberedForm(
    model,
    `${spec.catalogId ?? spec.kind}\n${spec.modelId}`,
    () => spec.thinkingOff ?? catalogFacts(set, spec.modelId)?.thinkingOff ?? thinkingOff.options,
    (error, sent) => {
      const form = refusedForm(error, thinkingOff.refused);
      return form && form !== sent ? form : undefined;
    },
  );
}

// A model must never fail for its thinking budget: one that refuses it is asked again without it (#899).
function withAnswerThinking(
  model: ChatLanguageModel,
  spec: ChatModelSpec,
  options: ProviderOptions,
): ChatLanguageModel {
  const refused = summaryQuirk(spec.kind)?.refused;
  return withRememberedForm(
    model,
    `answers\n${spec.catalogId ?? spec.kind}\n${spec.modelId}`,
    () => options,
    (error, sent) => {
      const without = refusedForm(error, refused);
      const dropsSomething = Object.entries(without ?? {}).some(([provider, values]) =>
        Object.keys(values).some((name) => sent[provider]?.[name] !== undefined),
      );
      return without && dropsSomething
        ? withOptionsOver({ providerOptions: sent }, without).providerOptions
        : undefined;
    },
  );
}

function providerModel(spec: ChatModelSpec): ChatLanguageModel {
  switch (spec.kind) {
    case "openai":
      return createOpenAI({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) }).responses(
        spec.modelId,
      );
    case "anthropic":
      return createAnthropic({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "google":
      return createGoogle({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "deepseek":
      return createDeepSeek({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "qwen":
      return createAlibaba({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "kimi":
      return createMoonshotAI({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "glm":
      return createZai({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "mistral":
      return createMistral({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "xai":
      // The Responses API, which is the AI SDK's default for xAI (made through `withoutStorage`).
      return createXai({ apiKey: requireKey(spec), baseURL: hostedUrl(spec) })(spec.modelId);
    case "openrouter":
      // "strict" asks for streamed token usage; the body carries the provider's routing
      // preferences (no providers that keep or train on prompts).
      return withOpenRouterRouting(
        createOpenRouter({
          apiKey: requireKey(spec),
          baseURL: hostedUrl(spec),
          compatibility: "strict",
          extraBody: catalogProviderOfKind("openrouter")?.request?.body ?? {},
        })(spec.modelId),
        hostedUrl(spec),
        globalThis.fetch,
      );
    case "siliconflow":
    case "openai-compatible": {
      const provider = catalogProviderOf(spec.kind, spec.catalogId);
      const quirks = provider?.request?.openAiCompatible;
      return createOpenAICompatible({
        name: provider?.id ?? spec.kind,
        baseURL: hostedUrl(spec),
        apiKey: provider?.apiKey === "required" ? requireKey(spec) : (spec.apiKey ?? undefined),
        includeUsage: quirks?.includeUsage ?? false,
        supportsStructuredOutputs: quirks?.supportsStructuredOutputs ?? false,
      })(spec.modelId);
    }
    case "ollama":
      // Ollama's own API, which sets the context window and refuses rather than cuts a
      // longer request (see ./ollamaChat). It holds a reply to a JSON schema too, which
      // Answers from models without Tools use for their Citations (#30).
      return createOllamaChatModel({
        baseUrl: requireBaseUrl(spec),
        modelId: spec.modelId,
        settings: spec.ollama ?? DEFAULT_OLLAMA_SETTINGS,
      });
    case "chatgpt":
      if (!spec.credentials) throw new Error("A ChatGPT sign-in is required.");
      return createPlanChatModel({
        baseUrl: requireBaseUrl(spec),
        modelId: spec.modelId,
        credentials: spec.credentials,
      });
    case "claude-account":
      if (!spec.credentials) throw new Error("A Claude sign-in is required.");
      return createClaudeAccountChatModel({
        baseUrl: requireBaseUrl(spec),
        modelId: spec.modelId,
        credentials: spec.credentials,
        request: spec.request ?? {},
      });
    case "copilot":
      if (!spec.credentials) throw new Error("A GitHub sign-in is required.");
      return createCopilotChatModel({
        baseUrl: requireBaseUrl(spec),
        modelId: spec.modelId,
        credentials: spec.credentials,
        headers: spec.request?.headers ?? {},
      });
  }
}
