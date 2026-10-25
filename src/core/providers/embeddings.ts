/**
 * Embedding providers other than the built-in model (ADR-0005): what each
 * kind needs, where its data goes, how its vectors are recorded, and the seam
 * to the AI SDK. Everything that builds an embedding model goes through an
 * `EmbeddingModelFactory`: the AI SDK providers by default, AI SDK mock
 * models in tests.
 */
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, embedMany } from "ai";
import {
  type EmbeddingProviderKind,
  type ExternalService,
  embeddingProviderKinds,
  type ProviderError,
} from "../api";
import { InvalidInputError, isRecord } from "../errors";
import { parseApiKey as parseKey } from "./apiKey";
import { normalizeBaseUrl, OLLAMA_DEFAULT_URL, serviceForUrl } from "./kinds";

/** The providers reached through an API: every kind but "off" and the built-in model. */
export type ApiEmbeddingProviderKind = Exclude<EmbeddingProviderKind, "off" | "built-in">;

/** A model object, never a model id string (which the AI SDK would send to its gateway). */
export type ApiEmbeddingModel = Exclude<EmbeddingModel, string>;

/** Everything needed to build an embedding model. */
export interface EmbeddingModelSpec {
  kind: ApiEmbeddingProviderKind;
  /** Set for "openai-compatible" and "ollama". */
  baseUrl: string | null;
  apiKey: string | null;
  modelId: string;
}

export type EmbeddingModelFactory = (spec: EmbeddingModelSpec) => ApiEmbeddingModel;

/** Options the AI SDK passes through to a provider. */
export type EmbeddingProviderOptions = Parameters<typeof embedMany>[0]["providerOptions"];

interface KindInfo {
  /** The hosted API, for kinds that don't take a base URL. */
  hosted?: ExternalService;
  baseUrl: "none" | "required" | "optional";
  apiKey: "required" | "optional" | "none";
}

const kinds: Record<ApiEmbeddingProviderKind, KindInfo> = {
  openai: {
    hosted: { id: "https://api.openai.com", name: "OpenAI" },
    baseUrl: "none",
    apiKey: "required",
  },
  google: {
    hosted: { id: "https://generativelanguage.googleapis.com", name: "Google" },
    baseUrl: "none",
    apiKey: "required",
  },
  "openai-compatible": { baseUrl: "required", apiKey: "optional" },
  ollama: { baseUrl: "optional", apiKey: "none" },
};

const isEmbeddingProviderKind = (value: unknown): value is EmbeddingProviderKind =>
  embeddingProviderKinds.some((kind) => kind === value);

export const embeddingKeyRequired = (kind: ApiEmbeddingProviderKind) =>
  kinds[kind].apiKey === "required";
const embeddingKeyAccepted = (kind: ApiEmbeddingProviderKind) => kinds[kind].apiKey !== "none";

/** Where a provider's requests go, or null when the server runs on this computer. */
export function embeddingServiceFor(
  kind: ApiEmbeddingProviderKind,
  baseUrl: string | null,
): ExternalService | null {
  const hosted = kinds[kind].hosted;
  if (hosted) return hosted;
  return baseUrl ? serviceForUrl(baseUrl) : null;
}

/** An API provider as stored on this device, without its key. */
export interface ApiEmbeddingChoice {
  kind: ApiEmbeddingProviderKind;
  baseUrl: string | null;
  modelId: string;
}

/**
 * The id recorded with a Document's vectors (documents.embedding_model): the
 * kind, the server (for kinds that take one) and the model. The same model on
 * another server counts as another model, so its vectors are never compared.
 */
export function embeddingModelKey(choice: ApiEmbeddingChoice): string {
  const server = choice.baseUrl === null ? "" : `@${choice.baseUrl}`;
  return `${choice.kind}${server}:${choice.modelId}`;
}

/** What the User sees, e.g. "OpenAI" or "api.example.com" or "Ollama". */
export function embeddingProviderName(choice: Pick<ApiEmbeddingChoice, "kind" | "baseUrl">) {
  if (choice.kind === "ollama") return "Ollama";
  return embeddingServiceFor(choice.kind, choice.baseUrl)?.name ?? choice.baseUrl ?? choice.kind;
}

/** The base URL to store for a kind, from what the User entered. */
function parseBaseUrl(kind: ApiEmbeddingProviderKind, raw: unknown): string | null {
  const rule = kinds[kind].baseUrl;
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw new InvalidInputError("The server URL must be text.");
  }
  const given = typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
  if (rule === "none") {
    if (given) {
      throw new InvalidInputError(`${kinds[kind].hosted?.name} doesn't take a server URL.`);
    }
    return null;
  }
  if (!given) {
    if (rule === "required") throw new InvalidInputError({ key: "error.provider.urlMissing" });
    return OLLAMA_DEFAULT_URL;
  }
  return normalizeBaseUrl(given);
}

function parseModelId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
    throw new InvalidInputError({ key: "error.provider.embeddingModelMissing" });
  }
  return value.trim();
}

/** undefined: keep the stored key. Blank text counts as "keep". */
function parseApiKey(value: unknown, kind: ApiEmbeddingProviderKind): string | undefined {
  if (value === undefined || value === null) return undefined;
  const key = parseKey(value);
  if (key === undefined) return undefined;
  if (!embeddingKeyAccepted(kind)) {
    throw new InvalidInputError("This provider doesn't take an API key.");
  }
  return key;
}

export type ParsedEmbeddingInput =
  | { kind: "off" }
  | { kind: "built-in" }
  | { kind: ApiEmbeddingProviderKind; choice: ApiEmbeddingChoice; apiKey: string | undefined };

/** `saveEmbeddingProvider` and `testEmbeddingConnection` input, checked. */
export function parseEmbeddingInput(input: unknown): ParsedEmbeddingInput {
  if (!isRecord(input)) throw new InvalidInputError("Expected an object.");
  for (const key of Object.keys(input)) {
    if (!["kind", "baseUrl", "apiKey", "modelId"].includes(key)) {
      throw new InvalidInputError(`Embedding providers have no setting "${key}".`);
    }
  }
  const { kind } = input;
  if (!isEmbeddingProviderKind(kind)) {
    throw new InvalidInputError(`Unknown embedding provider "${String(kind)}".`);
  }
  if (kind === "off" || kind === "built-in") {
    if (input.baseUrl || input.apiKey || input.modelId) {
      throw new InvalidInputError(
        kind === "off"
          ? "Turning embeddings off takes no server, key or model name."
          : "The built-in model takes no server, key or model name.",
      );
    }
    return { kind };
  }
  return {
    kind,
    choice: {
      kind,
      baseUrl: parseBaseUrl(kind, input.baseUrl),
      modelId: parseModelId(input.modelId),
    },
    apiKey: parseApiKey(input.apiKey, kind),
  };
}

/** A stored choice, checked: null if it isn't one this version understands. */
export function parseStoredChoice(value: unknown): ApiEmbeddingChoice | null {
  if (!isRecord(value)) return null;
  const { kind, baseUrl, modelId } = value;
  if (!isEmbeddingProviderKind(kind) || kind === "off" || kind === "built-in") return null;
  if (typeof modelId !== "string" || modelId === "") return null;
  if (baseUrl !== null && typeof baseUrl !== "string") return null;
  return { kind, baseUrl, modelId };
}

function requireKey(spec: EmbeddingModelSpec): string {
  // Never fall back to the AI SDK's environment variables: keys come from the keychain only.
  if (!spec.apiKey) throw new Error(`An API key is required for ${spec.kind}.`);
  return spec.apiKey;
}

function requireBaseUrl(spec: EmbeddingModelSpec): string {
  if (!spec.baseUrl) throw new Error(`A server URL is required for ${spec.kind}.`);
  return spec.baseUrl;
}

/** The AI SDK provider for each kind. */
export const createAiSdkEmbeddingModel: EmbeddingModelFactory = (spec) => {
  switch (spec.kind) {
    case "openai":
      return createOpenAI({ apiKey: requireKey(spec) }).embedding(spec.modelId);
    case "google":
      return createGoogle({ apiKey: requireKey(spec) }).embedding(spec.modelId);
    case "openai-compatible":
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: requireBaseUrl(spec),
        apiKey: spec.apiKey ?? undefined,
      }).embeddingModel(spec.modelId);
    case "ollama":
      // Ollama serves the OpenAI embeddings API (/v1/embeddings) beside its own /api/embed.
      return createOpenAICompatible({
        name: "ollama",
        baseURL: `${requireBaseUrl(spec)}/v1`,
      }).embeddingModel(spec.modelId);
  }
};

/**
 * What a text is for, for providers that embed what is searched and searches
 * differently: Google's task types. The others embed both alike.
 */
export function embeddingProviderOptions(
  kind: ApiEmbeddingProviderKind,
  purpose: "document" | "query",
): EmbeddingProviderOptions {
  if (kind !== "google") return undefined;
  return {
    google: { taskType: purpose === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY" },
  };
}

/** The provider's own words for a failure, kept short. */
export const shortError = (error: ProviderError): ProviderError => ({
  kind: error.kind,
  message: error.message.slice(0, 1_000),
});
