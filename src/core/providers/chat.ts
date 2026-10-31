/**
 * Chat providers: their settings (in SQLite, without secrets), their API keys
 * (through `Secrets`, never in SQLite), whether Questions can be asked, the
 * connection test, and the model seam Answers use (#29).
 */
import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { modelInUse } from "../../shared/mindModel";
import {
  CHOSEN_PROVIDER_FLOWS,
  type ChatModelChoice,
  type ChatModelGroup,
  type ChatProvider,
  type ChatProviderKind,
  type ChatReadiness,
  type CitationSupport,
  type ConnectionTestResult,
  type DataFlowId,
  type ExternalService,
  type ModelAbout,
  type ModelCost,
  type OtherModel,
  type ProviderError,
  type ProviderErrorKind,
  type ProviderTestResult,
  type SetChatModelInMenuInput,
} from "../api";
import type { Consent } from "../consent";
import type { Meter, MeteredModel } from "../cost/meter";
import { typicalAnswerCost } from "../cost/price";
import { ChatNotReadyError, InvalidInputError, isRecord, LocalModeError } from "../errors";
import type { Secrets } from "../secrets";
import { createSendGate, gateStop } from "../sendGate";
import type { SettingsStore } from "../settings";
import type { Database } from "../storage";
import { parseApiKey as parseKey, storedApiKey } from "./apiKey";
import {
  cloudWindow,
  type ModelCapabilities,
  type ModelFactsLayer,
  readsImages,
  resolveCapabilities,
  startingSupport,
} from "./capabilities";
import {
  cannotAnswerReason,
  catalogFacts,
  catalogModel,
  catalogProvider,
  catalogProviderOf,
  catalogProviderOfKind,
  catalogRoleModel,
  isPreset,
  modelsProviderOfKind,
  type Price,
  withRolesFirst,
} from "./catalog";
import { billingOf, OLLAMA_CLOUD_PRICES_CHECKED, ollamaCloudPrice } from "./catalog/billing";
import { endpointOf, fieldAccepts, fieldUrl, pricingUrlOf } from "./catalog/providers";
import type { ChatGptPlan } from "./chatgpt/plan";
import type { ClaudeSignIn } from "./claudeAccount/account";
import type { CopilotSignIn } from "./copilot/account";
import {
  acceptsApiKey,
  baseUrlFor,
  endpointUrl,
  isChatProviderKind,
  requiresApiKey,
  serviceFor,
} from "./kinds";
import { fetchProviderModels, type ListedModel, listProviderModels } from "./modelLists";
import {
  type ChatLanguageModel,
  type ChatModelFactory,
  type ChatModelSpec,
  type ContextWindow,
  summarizesReasoning,
} from "./models";
import { isCloudModelName, OLLAMA_CLOUD } from "./ollamaCloud";
import {
  DEFAULT_OLLAMA_SETTINGS,
  type OllamaModelProfile,
  type OllamaModels,
} from "./ollamaModels";
import { CutShortError, endsAtLimit, outputTokens } from "./outputLimits";
import { classifyProviderError, LocalModelError, OllamaNotRunningError } from "./providerErrors";

/** How long a provider's model list is kept before it is asked again. */
const MODEL_LIST_TTL_MS = 5 * 60_000;

/**
 * The chat flow: what a Question sends to a cloud chat provider. While a
 * Connector is on, the core adds "tool-results" (what its Tools return),
 * which makes it ask again. The names of Documents, another Mind a Question
 * names and a Meeting's live Transcript went before the lines named them:
 * a User who allowed the flow earlier is asked once more.
 */
export const CHAT_FLOW_SENDS = [
  "blocks",
  "passages",
  "document-names",
  "other-minds",
  "live-transcript",
] as const;

const TEST_TIMEOUT_MS = 30_000;

function notReadyError(error: ChatNotReadyError): ProviderError {
  const { reason } = error.readiness;
  const kind: ProviderErrorKind =
    reason === "local-mode" || reason === "consent-declined"
      ? reason
      : reason === "missing-api-key"
        ? "auth"
        : reason === "sign-in-required"
          ? "not-signed-in"
          : "unknown";
  return { kind, message: error.message };
}

interface ProviderRow {
  id: string;
  kind: string;
  base_url: string | null;
  /** The provider in the catalog (see ./catalog); null for one it doesn't have (the ChatGPT plan). */
  catalog_id: string | null;
  /** A hosted provider's endpoint (its region); null for a server the User gives. */
  endpoint: string | null;
}

const ROW_COLUMNS = "id, kind, base_url, catalog_id, endpoint";

/** A row of a kind this version knows, and of a preset it knows: a newer version's isn't used. */
const isKnownRow = (row: ProviderRow): row is ProviderRow & { kind: ChatProviderKind } =>
  isChatProviderKind(row.kind) &&
  (row.catalog_id === null ||
    row.catalog_id === row.kind ||
    isPreset(catalogProvider(row.catalog_id)));

interface ParsedServer {
  kind: ChatProviderKind;
  baseUrl: string | null;
  /** A hosted provider's endpoint (its region) id; null for a server the User gives. */
  endpoint: string | null;
  /** Its catalog provider's id, or null. */
  catalogId: string | null;
}

/** A model ready to use, for Answers. */
export interface PreparedChatModel {
  model: ChatLanguageModel;
  provider: ChatProvider;
  modelId: string;
  /** What the model can do, as known before the first request (see ./capabilities). */
  capabilities: ModelCapabilities;
  /**
   * The context window each request must fit: a local model's, which
   * IncarnaMind sets, or a cloud model's own when its context is known.
   */
  window?: ContextWindow;
  /** How the model gives Citations, known before the first request (see ./capabilities). */
  support?: CitationSupport;
  /** Its reasoning comes back as its provider's summary, which an Answer may show (see ./models). */
  summarizesReasoning: boolean;
  /**
   * A local model's quotes the Citation check doesn't find are asked for once
   * more (see ../answers/quoteRetry); never a cloud model's.
   */
  retryQuotes?: boolean;
  /** How many parameters a model on this computer has, when its runtime says; never a cloud model's (#680). */
  parameters?: number;
  /** Which build of the model this is (Ollama's digest), when known: what was learnt about it holds for this build. */
  revision?: string;
  /**
   * For a local model: whether it is loaded and ready now, or a request would
   * first wait for it to load; null when that can't be told.
   */
  loaded?: () => Promise<boolean | null>;
}

/** What is known now of a model on a saved provider (see `describeModel`). */
export interface DescribedModel {
  choice: ChatModelChoice;
  kind: ChatProviderKind;
  /** Its provider's catalog entry, or null for one the catalog doesn't have (the ChatGPT plan). */
  catalogId: string | null;
  /** Where its requests go; null for a model on this computer. */
  service: ExternalService | null;
  /** A model in Ollama that runs on ollama.com. */
  ollamaCloud: boolean;
  readsImages: boolean;
  /** Its name in the catalog, else its id. */
  name: string;
  /** Its price in the catalog, when known. */
  price: Price | undefined;
}

/** A model in Ollama that can't answer Questions, such as an embedding model, fails before anything is sent. */
function checkCanChat(profile: OllamaModelProfile | null, modelId: string): void {
  if (profile && !profile.chat) {
    throw new LocalModelError(
      "model",
      `${modelId} can't answer Questions: Ollama lists it as ${profile.capabilities?.join(", ") || "not a chat model"}. Pick a chat model.`,
    );
  }
}

const keyName = (providerId: string) => `chat-provider:${providerId}:api-key`;

function parseServer(input: Record<string, unknown>): ParsedServer {
  if (!isChatProviderKind(input.kind)) {
    throw new InvalidInputError(`Unknown chat provider "${String(input.kind)}".`);
  }
  const catalogId = parseCatalogId(input.kind, input.catalogId);
  const endpoint = parseEndpoint(input.kind, input.endpoint, catalogId);
  const baseUrl = baseUrlFor(input.kind, input.baseUrl, catalogId);
  return {
    kind: input.kind,
    baseUrl: fieldEndpointUrl(input.kind, catalogId, endpoint, input.endpointValue) ?? baseUrl,
    endpoint,
    catalogId,
  };
}

/** The address of an endpoint built from a value the User gives (`endpointValue`); null for any other. */
function fieldEndpointUrl(
  kind: ChatProviderKind,
  catalogId: string | null,
  endpointId: string | null,
  value: unknown,
): string | null {
  const provider = catalogProviderOf(kind, catalogId);
  const endpoint = provider && endpointOf(provider, endpointId);
  if (!endpoint?.field) return null;
  const given = (typeof value === "string" ? value.trim() : "") || (endpoint.field.default ?? "");
  if (given === "") throw new InvalidInputError({ key: "error.provider.fieldMissing" });
  if (!fieldAccepts(endpoint.field, given)) {
    throw new InvalidInputError({ key: "error.provider.fieldInvalid", values: { value: given } });
  }
  return fieldUrl(endpoint, given);
}

function parseCatalogId(kind: ChatProviderKind, value: unknown): string | null {
  if (value === undefined || value === null || value === kind) {
    return catalogProviderOfKind(kind)?.id ?? null;
  }
  const preset = typeof value === "string" ? catalogProvider(value) : undefined;
  if (kind !== "openai-compatible" || !preset || !isPreset(preset)) {
    throw new InvalidInputError({
      key: "error.provider.unknown",
      values: { provider: String(value) },
    });
  }
  return preset.id;
}

/** A hosted provider's endpoint: the one given, which it must have, else its first. Null for a server the User gives. */
function parseEndpoint(
  kind: ChatProviderKind,
  value: unknown,
  catalogId: string | null,
): string | null {
  const provider = catalogProviderOf(kind, catalogId);
  const given = typeof value === "string" && value !== "" ? value : undefined;
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new InvalidInputError("The endpoint must be text.");
  }
  if (!provider || provider.endpoints.length === 0) {
    if (given) {
      throw new InvalidInputError(`${provider?.name.en ?? kind} has no endpoints to choose.`);
    }
    return null;
  }
  if (given && !provider.endpoints.some((each) => each.id === given)) {
    throw new InvalidInputError(`${provider.name.en} has no endpoint "${given}".`);
  }
  return endpointOf(provider, given)?.id ?? null;
}

/** What Ollama says of a model, as the server's word on it: whether it calls Tools, and how it cites. */
const ollamaFacts = (profile: OllamaModelProfile): ModelFactsLayer => ({
  ...(profile.capabilities && { tools: profile.capabilities.includes("tools") }),
  ...(profile.support && { citing: profile.support }),
});

function parseModelId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
    throw new InvalidInputError({ key: "error.provider.modelMissing" });
  }
  return value.trim();
}

/** undefined: keep the stored key. null: remove it. Blank text counts as "keep". */
function parseApiKey(
  value: unknown,
  { kind, catalogId }: { kind: ChatProviderKind; catalogId: string | null },
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const key = parseKey(value);
  if (key === undefined) return undefined;
  if (!acceptsApiKey(kind, catalogId)) {
    throw new InvalidInputError("This provider doesn't take an API key.");
  }
  return key;
}

const displayName = ({ kind, baseUrl, endpoint, catalogId }: ParsedServer) =>
  serviceFor(kind, baseUrl, endpoint, catalogId)?.name ?? baseUrl ?? kind;

/** What chat providers need from the ChatGPT plan provider. */
export type ChatGptPlanAccess = Pick<
  ChatGptPlan,
  "hasSignIn" | "credentials" | "apiBaseUrl" | "models" | "limits"
>;

export type ClaudeAccountAccess = Pick<
  ClaudeSignIn,
  "hasSignIn" | "credentials" | "apiBaseUrl" | "request"
>;

export type CopilotAccess = Pick<
  CopilotSignIn,
  "hasSignIn" | "credentials" | "requests" | "models"
>;

export function createChat(options: {
  db: Database;
  now: () => string;
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  createModel: ChatModelFactory;
  chatGpt: ChatGptPlanAccess;
  claudeAccount: ClaudeAccountAccess;
  copilot: CopilotAccess;
  /** Looks up models in Ollama, for the settings their requests carry and how they cite. */
  ollamaModels: OllamaModels;
  /** Whether "Keep everything on this computer" is on: Questions then go only to a model on this computer. */
  localOnly(): boolean;
  /** Counts every cloud request of the models handed out, and holds the monthly cap (see ../cost/meter). */
  meter: Pick<Meter, "wrap">;
}) {
  const {
    db,
    now,
    settings,
    secrets,
    consent,
    createModel,
    chatGpt,
    claudeAccount,
    copilot,
    ollamaModels,
    meter,
  } = options;
  const gate = createSendGate(consent, options.localOnly);

  const gateAllows = (flowId: DataFlowId, service: ExternalService): boolean => {
    try {
      gate.check(flowId, service);
      return true;
    } catch (error) {
      if (gateStop(error)) return false;
      throw error;
    }
  };

  const needsSignIn = async (kind: ChatProviderKind) =>
    (kind === "chatgpt" && !(await chatGpt.hasSignIn())) ||
    (kind === "claude-account" && !(await claudeAccount.hasSignIn())) ||
    (kind === "copilot" && !(await copilot.hasSignIn()));

  /** What the meter needs to know of a model: how it's billed, its price and its output limit. */
  const meteredModel = (
    server: { kind: ChatProviderKind; service: ExternalService | null },
    providerId: string,
    modelId: string,
    flow: MeteredModel["flow"],
    capabilities: ModelCapabilities,
    profile: OllamaModelProfile | null,
  ): MeteredModel => {
    const ollamaCloud = server.kind === "ollama" && server.service?.id === OLLAMA_CLOUD.id;
    return {
      providerId,
      kind: server.kind,
      modelId,
      flow,
      billing: billingOf(server.kind, server.service),
      price: ollamaCloud ? ollamaCloudPrice(modelId) : capabilities.facts.price,
      maxOutput:
        server.kind === "ollama"
          ? (profile?.settings ?? DEFAULT_OLLAMA_SETTINGS).outputTokens
          : capabilities.facts.maxOutput,
      ollamaCloud,
    };
  };

  /** What Ollama says about a model, for the "ollama" kind; null for other kinds, or when it can't say. */
  const profileFor = (kind: ChatProviderKind, baseUrl: string | null, modelId: string) =>
    kind === "ollama" && baseUrl ? ollamaModels.describe(baseUrl, modelId) : Promise.resolve(null);

  /**
   * Which models in Ollama run on ollama.com, as last asked, by server and
   * model. Sync code (`defaultService`, `mightBeReady`) reads it; anything that
   * sends data asks first (`remoteService`), so it never relies on a stale answer.
   */
  const remoteModels = new Map<string, boolean>();
  const remoteKey = (baseUrl: string | null, modelId: string) => `${baseUrl ?? ""}\n${modelId}`;

  /** Asks Ollama whether the model runs on ollama.com, and remembers what it said. */
  const refreshRemote = async (
    kind: ChatProviderKind,
    baseUrl: string | null,
    modelId: string,
  ): Promise<boolean> => {
    if (kind !== "ollama" || !baseUrl) return false;
    // The name decides first, whatever Ollama says: a false "local" would send data away unasked.
    const remote =
      isCloudModelName(modelId) ||
      ((await ollamaModels.describe(baseUrl, modelId))?.remote ?? false);
    remoteModels.set(remoteKey(baseUrl, modelId), remote);
    return remote;
  };

  /** Where a request to the model goes: the server's service, else ollama.com for a cloud model in Ollama. Asks Ollama. */
  const remoteService = async (
    server: {
      kind: ChatProviderKind;
      baseUrl: string | null;
      endpoint?: string | null;
      catalogId?: string | null;
    },
    modelId: string,
  ): Promise<ExternalService | null> =>
    serviceFor(server.kind, server.baseUrl, server.endpoint, server.catalogId) ??
    ((await refreshRemote(server.kind, server.baseUrl, modelId)) ? OLLAMA_CLOUD : null);

  /** `remoteService` without asking: what was last learnt, else what the name says. */
  const knownService = (row: ProviderRow, modelId: string): ExternalService | null =>
    rowService(row) ??
    (row.kind === "ollama" &&
    (remoteModels.get(remoteKey(row.base_url, modelId)) ?? isCloudModelName(modelId))
      ? OLLAMA_CLOUD
      : null);

  /** Model lists by provider and server, with when they were fetched. */
  const modelLists = new Map<string, { at: number; models: ListedModel[] }>();
  const listKey = (row: ProviderRow) => `${row.id}\n${row.base_url ?? ""}\n${row.endpoint ?? ""}`;

  /** The models a saved provider lists, kept for a few minutes; none for a cloud service the User hasn't allowed yet. */
  const listedModels = async (row: ProviderRow, provider: ChatProvider): Promise<ListedModel[]> => {
    // The list request carries the key, so it goes only where a Question could: never in Local
    // mode, and only once the User allows the chat flow to the service.
    const mayAsk = !provider.service || gateAllows("chat", provider.service);
    const cacheKey = listKey(row);
    const cached = modelLists.get(cacheKey);
    let listed = cached && Date.now() - cached.at < MODEL_LIST_TTL_MS ? cached.models : null;
    if (provider.kind === "chatgpt" || provider.kind === "copilot") {
      // The account's own list, read with its sign-in like the sign-in's own traffic, and
      // kept by the plan itself: it carries nothing of the User's.
      const models = provider.kind === "chatgpt" ? chatGpt.models() : copilot.models();
      listed = (await models).map(({ id, name }) => ({ id, name }));
    }
    if (!listed && !mayAsk) listed = [];
    if (!listed) {
      const apiKey = provider.hasApiKey ? await secrets.tryGet(keyName(row.id)) : null;
      listed = await listProviderModels({
        kind: provider.kind,
        baseUrl: row.base_url,
        apiKey,
        endpoint: row.endpoint,
        catalogId: row.catalog_id,
      });
      if (listed.length > 0) modelLists.set(cacheKey, { at: Date.now(), models: listed });
    }
    return listed;
  };

  /** The ids the User put in a provider's menu (`inMenu`), or took out of it, in the order they did. */
  const menuModelsOf = (providerId: string, inMenu = true): string[] =>
    db
      .all<{ model_id: string }>(
        `SELECT model_id FROM chat_menu_models
          WHERE provider_id = ? AND in_menu = ? AND deleted_at IS NULL ORDER BY created_at, id`,
        [providerId, inMenu ? 1 : 0],
      )
      .map((each) => each.model_id);

  const rowById = (id: string) =>
    db.get<ProviderRow>(
      `SELECT ${ROW_COLUMNS} FROM chat_providers WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );

  const rowByServer = ({ kind, baseUrl, endpoint, catalogId }: ParsedServer) =>
    db.get<ProviderRow>(
      `SELECT ${ROW_COLUMNS} FROM chat_providers
       WHERE coalesce(catalog_id, kind) = ? AND coalesce(base_url, '') = ?
         AND coalesce(endpoint, '') = ? AND deleted_at IS NULL`,
      [catalogId ?? kind, baseUrl ?? "", endpoint ?? ""],
    );

  /** Rows of a kind, and a preset, this version knows; rows from a newer version are left alone. */
  const knownRows = () =>
    db
      .all<ProviderRow>(
        `SELECT ${ROW_COLUMNS} FROM chat_providers WHERE deleted_at IS NULL
         ORDER BY created_at, rowid`,
      )
      .filter(isKnownRow);

  /** Where a row's requests go. */
  const rowService = (row: ProviderRow) =>
    serviceFor(row.kind as ChatProviderKind, row.base_url, row.endpoint, row.catalog_id);

  /**
   * What is known of a model on a provider, by precedence (see ./capabilities):
   * the server's word (`server`, else what its model list said), then the
   * catalog's. Nothing the User sets on a model is stored yet.
   */
  const capabilitiesOf = (
    row: ProviderRow,
    modelId: string,
    server?: ModelFactsLayer,
  ): ModelCapabilities =>
    resolveCapabilities({
      server: server ?? modelLists.get(listKey(row))?.models.find((m) => m.id === modelId)?.facts,
      catalog: catalogFacts(
        modelsProviderOfKind(row.kind as ChatProviderKind, row.endpoint, row.catalog_id),
        modelId,
      ),
    });

  /**
   * What the model factory needs: a hosted provider's endpoint from the
   * catalog, else the server's URL. The ChatGPT plan and a Claude account
   * sign with the sign-in instead of a key, and a model in Ollama gets its
   * fixed settings, the defaults when Ollama couldn't say.
   */
  const specFor = async (
    server: {
      kind: ChatProviderKind;
      baseUrl: string | null;
      endpoint?: string | null;
      catalogId?: string | null;
    },
    apiKey: string | null,
    modelId: string,
    profile: OllamaModelProfile | null = null,
    thinking?: ChatModelSpec["thinking"],
  ): Promise<ChatModelSpec> => {
    const { kind } = server;
    if (kind === "chatgpt") {
      return {
        kind,
        baseUrl: chatGpt.apiBaseUrl,
        apiKey: null,
        modelId,
        credentials: chatGpt.credentials,
        ...(thinking && { thinking }),
      };
    }
    if (kind === "claude-account") {
      return {
        kind,
        baseUrl: claudeAccount.apiBaseUrl,
        apiKey: null,
        modelId,
        credentials: claudeAccount.credentials,
        request: claudeAccount.request,
        ...(thinking && { thinking }),
      };
    }
    if (kind === "copilot") {
      const { apiBaseUrl, headers } = await copilot.requests();
      return {
        kind,
        baseUrl: apiBaseUrl,
        apiKey: null,
        modelId,
        credentials: copilot.credentials,
        request: { headers },
        ...(thinking && { thinking }),
      };
    }
    const baseUrl = endpointUrl(kind, server.endpoint, server.catalogId) ?? server.baseUrl;
    const checkedKey = storedApiKey(apiKey);
    if (kind === "ollama") {
      return {
        kind,
        baseUrl,
        apiKey: checkedKey,
        modelId,
        ollama: profile?.settings ?? DEFAULT_OLLAMA_SETTINGS,
      };
    }
    return {
      kind,
      baseUrl,
      apiKey: checkedKey,
      modelId,
      // Only a provider's other regions say which they are; its first is the default.
      ...(server.endpoint &&
        server.endpoint !== catalogProviderOf(kind, server.catalogId)?.endpoints[0]?.id && {
          endpoint: server.endpoint,
        }),
      ...(server.catalogId &&
        isPreset(catalogProvider(server.catalogId)) && { catalogId: server.catalogId }),
      ...(thinking && { thinking }),
    };
  };

  const watchedPlan = (kind: ChatProviderKind, model: ChatLanguageModel, modelId: string) =>
    kind === "chatgpt" ? chatGpt.limits.watch(model, modelId) : model;

  const toProvider = async (row: ProviderRow, modelId?: string): Promise<ChatProvider> => {
    const kind = row.kind as ChatProviderKind;
    const hasApiKey =
      acceptsApiKey(kind, row.catalog_id) && (await secrets.tryGet(keyName(row.id))) !== null;
    return {
      id: row.id,
      kind,
      catalogId: row.catalog_id,
      endpoint: row.endpoint,
      baseUrl: row.base_url,
      hasApiKey,
      service: modelId === undefined ? rowService(row) : knownService(row, modelId),
    };
  };

  /** A saved provider with where its default model's requests go: a cloud model in Ollama isn't on this computer. */
  const withDefaultModel = async (row: ProviderRow): Promise<ChatProvider> => {
    const choice = settings.get().user.chatModel;
    if (choice?.providerId !== row.id) return toProvider(row);
    await refreshRemote(row.kind as ChatProviderKind, row.base_url, choice.modelId);
    return toProvider(row, choice.modelId);
  };

  /**
   * What is known now of a model on a saved provider: its provider's kind and
   * catalog entry, where its requests go, whether it is an Ollama cloud model,
   * whether it reads images, its name and its price. Undefined when its
   * provider is gone.
   */
  function describeModel(choice: ChatModelChoice): DescribedModel | undefined {
    const row = rowById(choice.providerId);
    if (!row || !isKnownRow(row)) return undefined;
    const kind = row.kind;
    const set = modelsProviderOfKind(kind, row.endpoint, row.catalog_id);
    const capabilities = capabilitiesOf(row, choice.modelId);
    const service = knownService(row, choice.modelId);
    return {
      choice,
      kind,
      catalogId: row.catalog_id,
      service,
      ollamaCloud: kind === "ollama" && service?.id === OLLAMA_CLOUD.id,
      readsImages: readsImages(capabilities),
      name: catalogModel(set, choice.modelId)?.name ?? choice.modelId,
      price: capabilities.facts.price,
    };
  }

  const costOf = (row: ProviderRow, price: Price | undefined, cloud: boolean): ModelCost | null => {
    const billing = billingOf(row.kind as ChatProviderKind, cloud ? OLLAMA_CLOUD : rowService(row));
    if (billing !== "per-token") return { kind: billing };
    return price
      ? { kind: "estimate", currency: price.currency, amount: typicalAnswerCost(price) }
      : null;
  };

  const aboutOf = (row: ProviderRow, modelId: string, cloud: boolean): ModelAbout => {
    const { facts } = capabilitiesOf(row, modelId);
    return {
      tools: facts.tools ?? null,
      readsImages: facts.input?.includes("image") ?? false,
      reasoning: facts.reasoning ?? null,
      context: facts.context ?? null,
      cost: costOf(row, cloud ? ollamaCloudPrice(modelId) : facts.price, cloud),
    };
  };

  const pricesOf = (row: ProviderRow, provider: ChatProvider): ChatModelGroup["prices"] => {
    const catalog = catalogProviderOf(provider.kind, row.catalog_id);
    if (provider.kind === "ollama") {
      const url = catalog?.pricingUrl;
      return url ? { url, checked: OLLAMA_CLOUD_PRICES_CHECKED } : null;
    }
    if (billingOf(provider.kind, provider.service) !== "per-token" || !catalog) return null;
    const url = pricingUrlOf(catalog, row.endpoint);
    return url ? { url, checked: catalog.checked } : null;
  };

  const answersModelOf = async (row: ProviderRow): Promise<string | undefined> => {
    const kind = row.kind as ChatProviderKind;
    const catalog =
      kind === "claude-account"
        ? catalogProvider("anthropic")
        : catalogProviderOf(kind, row.catalog_id);
    const role = kind === "ollama" ? undefined : catalog?.roles.answers;
    if (role) return role;
    const listed = await listedModels(row, await toProvider(row));
    return listed.find((each) => !each.other)?.id ?? menuModelsOf(row.id)[0];
  };

  // A model server the User runs does its own small calls, so it has no quick-tasks model of its own.
  const testModelOf = (row: ProviderRow, listed: readonly ListedModel[]): string | undefined => {
    const { quickTasksModel, chatModel } = settings.get().user;
    if (quickTasksModel?.providerId === row.id) return quickTasksModel.modelId;
    const kind = row.kind as ChatProviderKind;
    const role =
      rowService(row) === null || kind === "ollama"
        ? undefined
        : catalogRoleModel({ kind, catalogId: row.catalog_id }, "quickTasks");
    const answers = chatModel?.providerId === row.id ? chatModel.modelId : undefined;
    return (
      role ??
      answers ??
      listed.find((each) => !each.other)?.id ??
      menuModelsOf(row.id)[0] ??
      listed[0]?.id
    );
  };

  /**
   * A role's model for Answers asked with `base` (see `quickTasksModel` and
   * `imageModel`): the User's, else the catalog's for a cloud provider (the
   * ChatGPT plan's own for the jobs it has), else `base`.
   */
  function roleModel(
    role: "quickTasks" | "images",
    base: ChatModelChoice | null,
  ): ChatModelChoice | null {
    const own = settings.get().user[role === "quickTasks" ? "quickTasksModel" : "imageModel"];
    const answers = base && describeModel(base);
    let chosen: ChatModelChoice | null = own && rowById(own.providerId) ? own : null;
    if (!chosen && answers) {
      // A model server the User runs (Ollama, here or elsewhere, or one on this computer)
      // does its own small calls: its catalog roles name models it may not have.
      const catalogRole =
        answers.service === null || answers.kind === "ollama"
          ? undefined
          : catalogRoleModel(answers, role);
      chosen = catalogRole ? { providerId: answers.choice.providerId, modelId: catalogRole } : base;
    }
    if (!chosen || !options.localOnly()) return chosen;
    if (describeModel(chosen)?.service === null) return chosen;
    return answers?.service === null ? answers.choice : null;
  }

  consent.registry.register({
    id: "chat",
    sends: CHAT_FLOW_SENDS,
    async services() {
      const services: ExternalService[] = [];
      for (const row of knownRows()) {
        const service = (await withDefaultModel(row)).service;
        if (service) services.push(service);
      }
      return services;
    },
  });

  /** The saved provider of the default chat model, if there is one. */
  const defaultRow = () => {
    const choice = settings.get().user.chatModel;
    const row = choice && rowById(choice.providerId);
    return row && isKnownRow(row) ? row : undefined;
  };

  /**
   * Whether `choice` can take requests on `flow` (Questions use "chat";
   * automatic tagging uses "tagging", with its own consent).
   */
  const readinessFor = async (
    choice: ChatModelChoice | null,
    flow: DataFlowId,
  ): Promise<ChatReadiness> => {
    const row = choice && rowById(choice.providerId);
    if (!choice || !row || !isKnownRow(row)) {
      return { ready: false, reason: "no-provider" };
    }
    const { modelId } = choice;
    await refreshRemote(row.kind as ChatProviderKind, row.base_url, modelId);
    const provider = await toProvider(row, modelId);
    // Before the key and the consent: local mode refuses a Question however the service is set up.
    if (flow === "chat" && provider.service && options.localOnly()) {
      return { ready: false, reason: "local-mode", provider, modelId };
    }
    if (requiresApiKey(provider.kind, provider.catalogId) && !provider.hasApiKey) {
      return { ready: false, reason: "missing-api-key", provider, modelId };
    }
    if (await needsSignIn(provider.kind)) {
      return { ready: false, reason: "sign-in-required", provider, modelId };
    }
    if (!provider.service) return { ready: true, provider, modelId, consent: "not-required" };
    const decision = consent.status(flow, provider.service);
    if (decision === "declined") {
      return { ready: false, reason: "consent-declined", provider, modelId };
    }
    return {
      ready: true,
      provider,
      modelId,
      consent: decision === "accepted" ? "accepted" : "needed",
    };
  };

  const chat = {
    async list(): Promise<ChatProvider[]> {
      return Promise.all(knownRows().map(withDefaultModel));
    },

    /**
     * Saves the provider and makes the model on it the default: choosing a
     * cloud provider allows the flows that send to it (`CHOSEN_PROVIDER_FLOWS`,
     * ADR-0022).
     * The key is stored first: if the keychain refuses it, nothing changes.
     */
    async save(input: unknown): Promise<ChatProvider> {
      if (!isRecord(input)) throw new InvalidInputError("saveChatProvider expects an object.");
      const server = parseServer(input);
      const apiKey = parseApiKey(input.apiKey, server);
      const modelId = parseModelId(input.modelId);
      const makeDefault = input.keepDefault !== true || settings.get().user.chatModel === null;

      const existing = rowByServer(server);
      const id = existing?.id ?? randomUUID();
      const keyAfterSave =
        apiKey === undefined
          ? existing !== undefined && (await secrets.tryGet(keyName(id))) !== null
          : apiKey !== null;
      if (requiresApiKey(server.kind, server.catalogId) && !keyAfterSave) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: displayName(server) },
        });
      }

      if (typeof apiKey === "string") await secrets.set(keyName(id), apiKey);
      const at = now();
      db.transaction(() => {
        if (existing) {
          db.run("UPDATE chat_providers SET updated_at = ? WHERE id = ?", [at, id]);
        } else {
          db.run(
            `INSERT INTO chat_providers (id, kind, base_url, catalog_id, endpoint, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, server.kind, server.baseUrl, server.catalogId, server.endpoint, at, at],
          );
        }
        // Quick tasks and reading images go back to Automatic with the Answers model, with no row of their own (#1922).
        if (makeDefault) {
          settings.update({
            user: {
              chatModel: { providerId: id, modelId },
              quickTasksModel: null,
              imageModel: null,
            },
          });
        }
      });
      if (apiKey === null) await secrets.delete(keyName(id));

      const row = rowById(id);
      if (!row) throw new Error("The chat provider wasn't saved.");
      // Ollama is chosen for models on this computer, where no line says what goes elsewhere:
      // a cloud model in it asks once, at its first send. The line doesn't name what a
      // Connector's Tools return either: with one on, the first Question asks for that.
      const service = server.kind === "ollama" ? null : rowService(row);
      if (service) consent.choose(CHOSEN_PROVIDER_FLOWS, service, ["tool-results"]);
      return toProvider(row);
    },

    /**
     * Soft-deletes the provider and deletes its key. The quick-tasks and image models it held
     * go back to Automatic, and the model last chosen on it is forgotten; the default model it
     * held moves to another provider's, when one is left. Deleting one that doesn't exist does nothing.
     */
    async delete(id: unknown): Promise<void> {
      if (typeof id !== "string") throw new InvalidInputError("A provider id must be text.");
      if (!rowById(id)) return;
      const at = now();
      const { user, device } = settings.get();
      const { chatModel, quickTasksModel, imageModel } = user;
      db.transaction(() => {
        db.run("UPDATE chat_providers SET deleted_at = ?, updated_at = ? WHERE id = ?", [
          at,
          at,
          id,
        ]);
        const held = {
          ...(chatModel?.providerId === id && { chatModel: null }),
          ...(quickTasksModel?.providerId === id && { quickTasksModel: null }),
          ...(imageModel?.providerId === id && { imageModel: null }),
        };
        const lastPick = device.lastChatModel?.providerId === id ? { lastChatModel: null } : {};
        if (Object.keys(held).length > 0 || Object.keys(lastPick).length > 0) {
          settings.update({ user: held, device: lastPick });
        }
      });
      await secrets.delete(keyName(id));
      if (chatModel?.providerId !== id) return;
      for (const row of knownRows()) {
        const modelId = await answersModelOf(row);
        if (modelId) {
          settings.update({ user: { chatModel: { providerId: row.id, modelId } } });
          return;
        }
      }
    },

    exists: (id: string) => rowById(id) !== undefined,

    /** The model a request in a Mind whose own pick is `own` is asked with (see `modelInUse`). */
    modelInUse(own: ChatModelChoice | null): ChatModelChoice | null {
      const { device, user } = settings.get();
      return modelInUse(
        { own, last: device.lastChatModel, fallback: user.chatModel },
        (id) => rowById(id) !== undefined,
      );
    },

    /** The key of the saved provider of a hosted catalog entry, for another service of its (#141). */
    async apiKeyOf(catalogId: string): Promise<{ providerId: string; apiKey: string } | null> {
      for (const row of knownRows()) {
        if ((row.catalog_id ?? row.kind) !== catalogId || row.base_url !== null) continue;
        const apiKey = await secrets.tryGet(keyName(row.id));
        if (apiKey) return { providerId: row.id, apiKey };
      }
      return null;
    },

    /**
     * How requests to `choice` (the default model when left out) are metered,
     * as known now, without asking any server; null without a model.
     */
    metered(choice?: ChatModelChoice): MeteredModel | null {
      const chosen = choice ?? settings.get().user.chatModel;
      const row = chosen && rowById(chosen.providerId);
      if (!chosen || !row || !isKnownRow(row)) return null;
      return meteredModel(
        { kind: row.kind, service: knownService(row, chosen.modelId) },
        row.id,
        chosen.modelId,
        "chat",
        capabilitiesOf(row, chosen.modelId),
        null,
      );
    },

    /**
     * What execution will know of a model before its first request, without sending a Document or
     * asking for consent: what it can do, how it gives Citations, and the window its requests fit.
     */
    async modelShape(
      choice?: ChatModelChoice,
    ): Promise<Pick<PreparedChatModel, "capabilities" | "support" | "window"> | null> {
      const chosen = choice ?? settings.get().user.chatModel;
      const row = chosen && rowById(chosen.providerId);
      if (!chosen || !row || !isKnownRow(row)) return null;
      const shaped = (capabilities: ModelCapabilities, window: ContextWindow | undefined) => {
        const support = startingSupport(capabilities);
        return { capabilities, ...(support && { support }), ...(window && { window }) };
      };
      if (row.kind !== "ollama") {
        // As `prepareModel` does: a local preset's list says how large its models' windows are.
        const provider = await toProvider(row, chosen.modelId);
        if (!provider.service && isPreset(catalogProvider(provider.catalogId))) {
          await listedModels(row, provider);
        }
        const capabilities = capabilitiesOf(row, chosen.modelId);
        return shaped(capabilities, cloudWindow(capabilities));
      }
      const profile = await profileFor(row.kind, row.base_url, chosen.modelId);
      return shaped(
        capabilitiesOf(row, chosen.modelId, profile ? ollamaFacts(profile) : undefined),
        profile
          ? { tokens: profile.settings.numCtx, outputTokens: profile.settings.outputTokens }
          : undefined,
      );
    },

    /** A provider's kind, and whether its model runs on this computer (it sends to no service); null when it's gone. */
    describe(id: string): { kind: ChatProviderKind; local: boolean } | null {
      const row = rowById(id);
      if (!row || !isKnownRow(row)) return null;
      const choice = settings.get().user.chatModel;
      const service =
        choice?.providerId === row.id ? knownService(row, choice.modelId) : rowService(row);
      return { kind: row.kind, local: service === null };
    },

    /**
     * Whether `choice`'s model reads images, as known now (see ./capabilities):
     * false when nothing says so, or its provider is gone.
     */
    readsImages(choice: ChatModelChoice): boolean {
      const row = rowById(choice.providerId);
      return !!row && isKnownRow(row) && readsImages(capabilitiesOf(row, choice.modelId));
    },

    describeModel,

    /**
     * The quick-tasks model for Answers asked with `answers` (the default
     * model when left out), for the calls that don't write the Answer:
     * the one the User set, else the catalog's for a cloud provider, else the
     * Answers model itself. A model on this computer, or in Ollama anywhere,
     * does its own small calls, as a second one would push it out of memory. In local mode a cloud model
     * gives way to the Answers model, when that is on this computer, or to
     * none. Null with no Answers model.
     */
    quickTasksModel(answers?: ChatModelChoice | null): ChatModelChoice | null {
      return roleModel(
        "quickTasks",
        answers === undefined ? settings.get().user.chatModel : answers,
      );
    },

    /**
     * The model that reads a scan's pages for Answers asked with `answers` (the
     * default model when left out): the Answers model when it reads images,
     * else the one the User set, else the catalog's for a cloud provider, when
     * it reads images. Null when none does, or, in local mode, when the one
     * that would isn't on this computer.
     */
    imageModel(answers?: ChatModelChoice | null): ChatModelChoice | null {
      const base = answers === undefined ? settings.get().user.chatModel : answers;
      const described = base && describeModel(base);
      const chosen = described?.readsImages ? base : roleModel("images", base);
      const reader = chosen && describeModel(chosen);
      if (!reader?.readsImages) return null;
      return options.localOnly() && reader.service !== null ? null : reader.choice;
    },

    /**
     * Whether Questions can be asked with `choice`, or with the default model
     * when it is left out. With another `flow`, whether that flow can use it.
     */
    readiness: (choice?: ChatModelChoice, flow: DataFlowId = "chat") =>
      readinessFor(choice ?? settings.get().user.chatModel, flow),

    /** The service the default chat model sends to, or null when there is none or it runs on this computer. */
    defaultService(): ExternalService | null {
      const row = defaultRow();
      const choice = settings.get().user.chatModel;
      return row && choice ? knownService(row, choice.modelId) : null;
    },

    /**
     * A quick check, with nothing to wait for: false when `model` (the
     * default chat model when left out) certainly can't be used on `flow`
     * (there is none, or the User declined the flow to its service, or, for
     * background work, which never asks, hasn't allowed it). `readiness`
     * checks keys and sign-ins too.
     */
    mightBeReady(flow: DataFlowId, model?: ChatModelChoice): boolean {
      const row = model ? rowById(model.providerId) : defaultRow();
      if (!row) return false;
      const choice = model ?? settings.get().user.chatModel;
      const service = choice ? knownService(row, choice.modelId) : rowService(row);
      if (!service) return true;
      const decision = consent.status(flow, service);
      return consent.isBackground(flow) ? decision === "accepted" : decision !== "declined";
    },

    /**
     * Each saved provider with the models it lists and its default model, for
     * a Question's model picker, and which of them nothing says what they can
     * do. Lists are kept for a few minutes.
     */
    async listModels(): Promise<ChatModelGroup[]> {
      const chatModel = settings.get().user.chatModel;
      return Promise.all(
        knownRows().map(async (row) => {
          const provider = await toProvider(row);
          const listed = await listedModels(row, provider);
          const defaultModel = chatModel?.providerId === row.id ? [chatModel.modelId] : [];
          const inMenu = listed.filter((each) => !each.other).map((each) => each.id);
          const addedIds = menuModelsOf(row.id);
          const takenOut = menuModelsOf(row.id, false);
          const other = listed.flatMap((each): OtherModel[] =>
            each.other ? [{ id: each.id, ...each.other }] : [],
          );
          const added = addedIds.filter(
            (id) =>
              !inMenu.includes(id) && other.find((each) => each.id === id)?.why !== "cannot-answer",
          );
          const offered = [
            ...new Set([
              ...defaultModel,
              ...withRolesFirst(catalogProviderOf(provider.kind, row.catalog_id)?.roles, inMenu),
            ]),
          ];
          const hidden = offered.filter(
            (id) => takenOut.includes(id) && !defaultModel.includes(id),
          );
          const models = [...new Set([...offered.filter((id) => !hidden.includes(id)), ...added])];
          const unknown = models.filter((id) => !capabilitiesOf(row, id).known);
          // Ollama says which of its models run on ollama.com; the default one may not be in the list.
          const cloud = models.filter(
            (id) =>
              row.kind === "ollama" &&
              (listed.some((each) => each.id === id && each.cloud) || isCloudModelName(id)),
          );
          const [chosen] = defaultModel;
          if (
            chosen !== undefined &&
            !cloud.includes(chosen) &&
            (await refreshRemote(provider.kind, row.base_url, chosen))
          ) {
            cloud.push(chosen);
          }
          const names = Object.fromEntries(
            listed.flatMap((each) => (each.name ? [[each.id, each.name]] : [])),
          );
          const inCloud = (id: string) =>
            cloud.includes(id) ||
            (row.kind === "ollama" &&
              (listed.some((each) => each.id === id && each.cloud) || isCloudModelName(id)));
          const about = Object.fromEntries(
            [...new Set([...offered, ...added, ...other.map((each) => each.id)])].map((id) => [
              id,
              aboutOf(row, id, inCloud(id)),
            ]),
          );
          return {
            provider,
            models,
            names,
            other,
            added,
            offered,
            hidden,
            about,
            prices: pricesOf(row, provider),
            unknown,
            cloud,
          };
        }),
      );
    },

    setInMenu(input: unknown): void {
      if (!isRecord(input)) throw new InvalidInputError("setChatModelInMenu expects an object.");
      const { providerId, inMenu } = input as Partial<SetChatModelInMenuInput>;
      const modelId = parseModelId(input.modelId);
      const row = typeof providerId === "string" ? rowById(providerId) : undefined;
      if (typeof providerId !== "string" || !row) {
        throw new InvalidInputError("That chat provider isn't saved.");
      }
      if (
        inMenu === true &&
        cannotAnswerReason(
          modelsProviderOfKind(row.kind as ChatProviderKind, row.endpoint, row.catalog_id),
          modelId,
        )
      ) {
        throw new InvalidInputError(`${modelId} can't answer Questions here.`);
      }
      if (typeof inMenu !== "boolean") throw new InvalidInputError("inMenu must be true or false.");
      const at = now();
      const kept = db.get<{ id: string }>(
        "SELECT id FROM chat_menu_models WHERE provider_id = ? AND model_id = ? AND deleted_at IS NULL",
        [providerId, modelId],
      );
      if (kept) {
        db.run("UPDATE chat_menu_models SET in_menu = ?, updated_at = ? WHERE id = ?", [
          inMenu ? 1 : 0,
          at,
          kept.id,
        ]);
      } else {
        db.run(
          `INSERT INTO chat_menu_models (id, provider_id, model_id, in_menu, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [randomUUID(), providerId, modelId, inMenu ? 1 : 0, at, at],
        );
      }
    },

    /**
     * Sends one tiny prompt with the given settings, which need not be saved.
     * Without a key in the input, the key stored for the same provider is used.
     * It sends the key and a fixed prompt, nothing of the User's, so it needs no consent.
     */
    async test(input: unknown): Promise<ConnectionTestResult> {
      if (!isRecord(input)) throw new InvalidInputError("testChatConnection expects an object.");
      const server = parseServer(input);
      const modelId = parseModelId(input.modelId);
      let apiKey = parseApiKey(input.apiKey, server) ?? null;
      if (apiKey === null && acceptsApiKey(server.kind, server.catalogId)) {
        const saved = rowByServer(server);
        if (saved) apiKey = await secrets.tryGet(keyName(saved.id));
      }
      if (requiresApiKey(server.kind, server.catalogId) && !apiKey) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: displayName(server) },
        });
      }
      if (server.kind === "chatgpt" && !(await chatGpt.hasSignIn())) {
        return {
          ok: false,
          error: { kind: "not-signed-in", message: "Continue with ChatGPT to sign in first." },
        };
      }
      if (server.kind === "claude-account" && !(await claudeAccount.hasSignIn())) {
        return {
          ok: false,
          error: {
            kind: "not-signed-in",
            message: "Sign in with your Claude account first.",
            signInRoute: "signed-out",
          },
        };
      }
      if (server.kind === "copilot" && !(await copilot.hasSignIn())) {
        return {
          ok: false,
          error: {
            kind: "not-signed-in",
            message: "Sign in with GitHub to use your Copilot plan first.",
            signInRoute: "signed-out",
          },
        };
      }

      try {
        const service = await remoteService(server, modelId);
        // A model in Ollama is tested with the settings Answers use, so it stays loaded for them.
        const profile = await profileFor(server.kind, server.baseUrl, modelId);
        checkCanChat(profile, modelId);
        const facts = resolveCapabilities({
          catalog: catalogFacts(
            modelsProviderOfKind(server.kind, server.endpoint, server.catalogId),
            modelId,
          ),
        });
        const model = gate.testModel(
          meter.wrap(
            watchedPlan(
              server.kind,
              createModel(await specFor(server, apiKey, modelId, profile)),
              modelId,
            ),
            meteredModel(
              { kind: server.kind, service },
              rowByServer(server)?.id ?? server.catalogId ?? server.kind,
              modelId,
              "test",
              facts,
              profile,
            ),
          ),
          service,
        );
        await generateText({
          model,
          prompt: "Reply with the word OK.",
          maxOutputTokens: outputTokens("connection-test"),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: classifyProviderError(error) };
      }
    },

    async testProvider(providerId: unknown): Promise<ProviderTestResult> {
      const row = typeof providerId === "string" ? rowById(providerId) : undefined;
      if (!row || !isKnownRow(row)) {
        throw new InvalidInputError({ key: "error.provider.removed" });
      }
      const provider = await toProvider(row);
      const failed = (
        step: "list" | "answer",
        modelId: string | null,
        error: unknown,
      ): ProviderTestResult => ({
        ok: false,
        step,
        modelId,
        error:
          error instanceof ChatNotReadyError ? notReadyError(error) : classifyProviderError(error),
      });
      let listed: ListedModel[];
      try {
        if (provider.service) {
          // Local mode first: a prompt for what couldn't be sent anyway would only be in the way.
          if (options.localOnly()) {
            throw new ChatNotReadyError({
              ready: false,
              reason: "local-mode",
              provider,
              modelId: "",
            });
          }
          await consent.ensure("chat", provider.service);
          gate.check("chat", provider.service);
        }
        listed =
          provider.kind === "chatgpt" || provider.kind === "copilot"
            ? await listedModels(row, provider)
            : await fetchProviderModels({
                kind: provider.kind,
                baseUrl: row.base_url,
                apiKey: provider.hasApiKey ? await secrets.tryGet(keyName(row.id)) : null,
                endpoint: row.endpoint,
                catalogId: row.catalog_id,
              });
      } catch (error) {
        return failed("list", null, error);
      }
      if (listed.length > 0) modelLists.set(listKey(row), { at: Date.now(), models: listed });
      const modelId = testModelOf(row, listed);
      if (!modelId) {
        return failed("answer", null, new LocalModelError("model", "It lists no models to try."));
      }
      let started = Date.now();
      try {
        const prepared = await chat.prepareModel({ providerId: row.id, modelId }, "chat", "off");
        started = Date.now();
        await generateText({
          model: prepared.model,
          prompt: "Reply with the word OK.",
          maxOutputTokens: outputTokens("connection-test"),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        return { ok: true, modelId, ms: Date.now() - started };
      } catch (error) {
        // A reply cut at the test's few tokens still shows the model answers.
        if (error instanceof CutShortError) return { ok: true, modelId, ms: Date.now() - started };
        return failed("answer", modelId, error);
      }
    },

    /**
     * The model a Question for `choice` (or the default model) goes to: the
     * ChatGPT plan's stand-in the User chose with "Answer with …" while the
     * chosen model's limit is used up. With no reset time, the chosen model
     * gets one small try an hour first, and takes the Question once it answers.
     */
    async answeringModel(choice?: ChatModelChoice): Promise<ChatModelChoice | undefined> {
      const picked = choice ?? settings.get().user.chatModel ?? undefined;
      if (!picked || rowById(picked.providerId)?.kind !== "chatgpt") return choice;
      const standIn = chatGpt.limits.standInFor(picked.modelId);
      if (!standIn) return choice;
      if (standIn.retry && (await chat.test({ kind: "chatgpt", modelId: picked.modelId })).ok) {
        return choice;
      }
      return { providerId: picked.providerId, modelId: standIn.modelId };
    },

    /**
     * For Answers (#29): the default model, or `choice` from a Question's model
     * picker, after checking readiness and getting consent for its service on
     * `flow` (automatic tagging passes "tagging"). `thinking: "off"` skips
     * thinking where the model can, for a short request on the chat flow;
     * the chat flow's other requests ask for a summary of the model's
     * reasoning, with a modest budget for `thinking: "answer"` and a larger
     * one for `"careful"`.
     * Throws `ChatNotReadyError` or `ConsentDeclinedError`; nothing is sent then.
     */
    async prepareModel(
      choice?: ChatModelChoice,
      flow: DataFlowId = "chat",
      thinking?: Exclude<ChatModelSpec["thinking"], undefined>,
    ): Promise<PreparedChatModel> {
      const readiness = await readinessFor(choice ?? settings.get().user.chatModel, flow);
      if (!readiness.ready) throw new ChatNotReadyError(readiness);
      const { provider, modelId } = readiness;
      if (provider.service) {
        try {
          await consent.ensure(flow, provider.service);
        } catch (error) {
          // Its prompt closed as Local mode came on: a Question says so as it does when asked in Local mode.
          if (error instanceof LocalModeError && flow === "chat") {
            throw new ChatNotReadyError({ ready: false, reason: "local-mode", provider, modelId });
          }
          throw error;
        }
      }
      const apiKey = acceptsApiKey(provider.kind, provider.catalogId)
        ? await secrets.get(keyName(provider.id))
        : null;
      // Ollama on this computer (its cloud models too, which it forwards) is asked first, so that
      // it not running is said at once rather than after a request's retries.
      if (
        provider.kind === "ollama" &&
        provider.baseUrl &&
        serviceFor("ollama", provider.baseUrl) === null &&
        !(await ollamaModels.running(provider.baseUrl))
      ) {
        throw new OllamaNotRunningError();
      }
      const profile = await profileFor(provider.kind, provider.baseUrl, modelId);
      checkCanChat(profile, modelId);
      // The calls that don't write the Answer (tagging, classifying, an Answer's search query)
      // skip thinking where they can.
      const reasoning = thinking ?? (flow === "chat" ? "summary" : "off");
      const row: ProviderRow = {
        id: provider.id,
        kind: provider.kind,
        base_url: provider.baseUrl,
        catalog_id: provider.catalogId,
        endpoint: provider.endpoint,
      };
      // Read before the first request: a local preset's list says what its models can do, so one is sized to its window.
      if (!provider.service && isPreset(catalogProvider(provider.catalogId))) {
        await listedModels(row, provider);
      }
      const capabilities = capabilitiesOf(row, modelId, profile ? ollamaFacts(profile) : undefined);
      const model = watchedPlan(
        provider.kind,
        createModel({
          ...(await specFor(provider, apiKey, modelId, profile, reasoning)),
          ...(provider.kind === "openrouter" &&
            capabilities.facts.thinkingOff && {
              thinkingOff: capabilities.facts.thinkingOff,
            }),
        }),
        modelId,
      );
      // The gate goes outside the meter, so a request it stops reserves nothing.
      const gated = gate.model(
        endsAtLimit(
          meter.wrap(model, {
            ...meteredModel(provider, provider.id, modelId, flow, capabilities, profile),
            reasoning,
          }),
        ),
        flow,
        provider.service,
      );
      const support = startingSupport(capabilities);
      const prepared = {
        model: gated,
        provider,
        modelId,
        capabilities,
        summarizesReasoning: summarizesReasoning(provider.kind),
        ...(support && { support }),
      };
      if (provider.kind !== "ollama") {
        // A cloud model's requests are kept within its own context window, when it is known.
        const window = cloudWindow(capabilities);
        return { ...prepared, ...(window && { window }) };
      }
      const baseUrl = provider.baseUrl;
      // Without Ollama's word on the model (it couldn't be asked, or doesn't have it), its
      // request fails anyway: nothing is sized to a window that may not be its own.
      if (!profile || !baseUrl) return prepared;
      const { numCtx, outputTokens } = profile.settings;
      return {
        ...prepared,
        window: { tokens: numCtx, outputTokens },
        retryQuotes: true,
        ...(profile.parameters !== null &&
          !profile.remote &&
          !isCloudModelName(modelId) && { parameters: profile.parameters }),
        ...(profile.digest && { revision: profile.digest }),
        loaded: () => ollamaModels.loaded(baseUrl, modelId, numCtx),
      };
    },
  };
  return chat;
}
