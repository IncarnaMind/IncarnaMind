/**
 * Rerank (ADR-0005): document search reranks its candidates before grouping
 * them (see ../documents/searchTool):
 * - "built-in", the default: the built-in reranking model, on this computer
 *   (see ../reranking). Nothing is sent, so it needs no consent, and local
 *   mode doesn't pause it. Its files are downloaded once, when the first
 *   Documents are ready to search (or when the User chooses it); until they
 *   are ready, search keeps its own order.
 * - With a Cohere or Voyage key: the service's reranking model, through the
 *   AI SDK's `rerank` and the official @ai-sdk/cohere and @ai-sdk/voyage
 *   providers. Its requests are the "rerank" data flow: the search query and
 *   the candidate Passages, to the service. Choosing the service allows it
 *   (ADR-0022); when the User declines it, or a request fails, search keeps
 *   its own order. Local mode pauses it.
 * - Off, when the User turns it off: search keeps its own order.
 * The settings are per device: nothing stored is the default, null is off.
 * A key is in the keychain, never in SQLite.
 */
import { createCohere } from "@ai-sdk/cohere";
import { createVoyage } from "@ai-sdk/voyage";
import { type RerankingModel as AiSdkRerankingModel, rerank } from "ai";
import {
  type ConnectionTestResult,
  DEFAULT_RERANK_MODELS,
  type ExternalService,
  type RerankProviderKind,
  type RerankServiceKind,
  type RerankSettings,
  rerankProviderKinds,
} from "../api";
import type { Consent } from "../consent";
import type { Reranker, SearchCandidate } from "../documents/searchTool";
import { InvalidInputError, isRecord } from "../errors";
import type { RerankingModel } from "../reranking";
import type { Secrets } from "../secrets";
import { createSendGate, gateStop } from "../sendGate";
import type { SettingsStore } from "../settings";
import { parseApiKey, readApiKey, storedApiKey } from "./apiKey";
import { classifyProviderError } from "./providerErrors";

/** A model object, never a model id string (which the AI SDK would send to its gateway). */
export type ApiRerankingModel = Exclude<AiSdkRerankingModel, string>;

export interface RerankingModelSpec {
  kind: RerankServiceKind;
  apiKey: string;
  modelId: string;
}

export type RerankingModelFactory = (spec: RerankingModelSpec) => ApiRerankingModel;

/** The AI SDK provider for each service. */
export const createAiSdkRerankingModel: RerankingModelFactory = ({ kind, apiKey, modelId }) =>
  kind === "cohere"
    ? createCohere({ apiKey }).reranking(modelId)
    : createVoyage({ apiKey }).reranking(modelId);

/** Where each service's requests go. */
const RERANK_SERVICES: Readonly<Record<RerankServiceKind, ExternalService>> = {
  cohere: { id: "https://api.cohere.com", name: "Cohere" },
  voyage: { id: "https://api.voyageai.com", name: "Voyage AI" },
};

/** The data the "rerank" flow sends. */
const RERANK_FLOW_SENDS = ["queries", "passages"] as const;

const KEY_NAME = "rerank:api-key";
/** A per-device value, outside `DeviceSettings`: only these methods change it. */
const SETTINGS_VALUE = "rerank";

const RERANK_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

/** What a connection test reranks: nothing of the User's. */
const TEST_QUERY = "Which city is the capital of France?";
const TEST_DOCUMENTS = ["Bananas are rich in potassium.", "Paris is the capital of France."];

/** What is stored: a null model means the service's default (always null for "built-in"). */
interface StoredRerank {
  kind: RerankProviderKind;
  modelId: string | null;
  /** Nothing is stored: the default, not the User's choice. */
  byDefault?: boolean;
}

/** Reranking on a device where the User hasn't chosen: the built-in model. */
const DEFAULT_RERANK: StoredRerank = { kind: "built-in", modelId: null, byDefault: true };

const isRerankKind = (value: unknown): value is RerankProviderKind =>
  rerankProviderKinds.some((kind) => kind === value);

const isService = (kind: RerankProviderKind): kind is RerankServiceKind => kind !== "built-in";

/** Nothing stored: the default. Null (the User turned it off), or anything else: off. */
function parseStored(value: unknown): StoredRerank | null {
  if (value === undefined) return DEFAULT_RERANK;
  if (!isRecord(value) || !isRerankKind(value.kind)) return null;
  return { kind: value.kind, modelId: typeof value.modelId === "string" ? value.modelId : null };
}

function parseModel(value: unknown): string | null {
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string" || value.length > 200) {
    throw new InvalidInputError({ key: "error.provider.rerankModelMissing" });
  }
  return value.trim();
}

function parseKind(value: unknown): RerankProviderKind {
  if (!isRerankKind(value)) {
    throw new InvalidInputError(`Unknown reranking provider "${String(value)}".`);
  }
  return value;
}

/** What the reranking model reads for a candidate: its Document's name, then the Passage. */
const candidateText = (candidate: SearchCandidate) =>
  `${candidate.documentName}\n${candidate.text}`;

export function createRerank(options: {
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  createModel: RerankingModelFactory;
  /** The built-in reranking model: downloaded and run only once the User chooses it. */
  builtIn: RerankingModel;
  /** Local mode is on: nothing is sent to a reranking service. */
  localOnly(): boolean;
  /** Aborts requests when the core closes. */
  signal: AbortSignal;
  reportError?: (error: unknown) => void;
}) {
  const { settings, secrets, consent, createModel, builtIn, signal } = options;
  const gate = createSendGate(consent, options.localOnly);
  const reportError = options.reportError ?? ((error) => console.error(error));

  const stored = () => parseStored(settings.readDeviceValue(SETTINGS_VALUE));
  const modelOf = (rerankSettings: StoredRerank) =>
    isService(rerankSettings.kind)
      ? (rerankSettings.modelId ?? DEFAULT_RERANK_MODELS[rerankSettings.kind])
      : builtIn.definition.name;
  /** A service is set up while local mode is on. */
  const pausedNow = (current: StoredRerank | null) =>
    current !== null && isService(current.kind) && options.localOnly();

  const refuseInLocalMode = () => {
    if (options.localOnly()) {
      throw new InvalidInputError({ key: "error.provider.rerankLocalMode" });
    }
  };

  consent.registry.register({
    id: "rerank",
    sends: RERANK_FLOW_SENDS,
    async services() {
      const current = stored();
      // The built-in model sends nothing: the flow stays on this computer.
      return current && isService(current.kind) ? [RERANK_SERVICES[current.kind]] : [];
    },
  });

  const status = async (): Promise<RerankSettings> => {
    const current = stored();
    const service = current && isService(current.kind) ? current.kind : null;
    return {
      enabled: current !== null,
      kind: current?.kind ?? null,
      modelId: current ? modelOf(current) : null,
      hasApiKey: service !== null && (await secrets.tryGet(KEY_NAME)) !== null,
      service: service ? RERANK_SERVICES[service] : null,
      paused: pausedNow(current),
      byDefault: current?.byDefault === true,
      model: builtIn.status(),
      runsOn: builtIn.device(),
    };
  };

  /** The built-in model's order; search's own while it isn't downloaded, or when it fails. */
  const rerankBuiltIn: Reranker = async (query, candidates, abortSignal) => {
    if (!builtIn.isReady()) {
      builtIn.ensure();
      return [...candidates];
    }
    try {
      const ranked = await builtIn.rerank(query, candidates);
      abortSignal?.throwIfAborted();
      return ranked ?? [...candidates];
    } catch (error) {
      // The Answer was stopped: stop too.
      if (abortSignal?.aborted) throw error;
      if (!signal.aborted) reportError(error);
      return [...candidates];
    }
  };

  /** A service's order and scores; search's own when the User declines or the request fails. */
  const rerankWithService = async (
    kind: RerankServiceKind,
    modelId: string,
    query: string,
    candidates: readonly SearchCandidate[],
    abortSignal: AbortSignal | undefined,
  ): Promise<SearchCandidate[]> => {
    const apiKey = await secrets.tryGet(KEY_NAME);
    if (!apiKey) return [...candidates];
    try {
      await consent.ensure("rerank", RERANK_SERVICES[kind]);
      const { ranking } = await rerank({
        model: gate.rerankingModel(
          createModel({ kind, apiKey: readApiKey(apiKey), modelId }),
          "rerank",
          RERANK_SERVICES[kind],
        ),
        documents: candidates.map(candidateText),
        query,
        topN: candidates.length,
        maxRetries: 1,
        abortSignal: AbortSignal.any([
          signal,
          AbortSignal.timeout(RERANK_TIMEOUT_MS),
          ...(abortSignal ? [abortSignal] : []),
        ]),
      });
      const ranked = ranking.flatMap(({ originalIndex, score }) => {
        const candidate = candidates[originalIndex];
        return candidate ? [{ ...candidate, score }] : [];
      });
      // Any the model left out follow, in search's order, below its lowest score.
      const seen = new Set(ranking.map((each) => each.originalIndex));
      const lowest = Math.min(0, ...ranked.map((candidate) => candidate.score));
      const rest = candidates
        .filter((_, index) => !seen.has(index))
        .map((candidate, index) => ({ ...candidate, score: lowest - (index + 1) * 1e-6 }));
      return [...ranked, ...rest];
    } catch (error) {
      // The Answer was stopped: stop too.
      if (abortSignal?.aborted) throw error;
      if (!signal.aborted && !gateStop(error)) reportError(error);
      return [...candidates];
    }
  };

  /**
   * The document-search Tool's reranker: the candidates in the reranking
   * model's order, scored by it. Unchanged, with nothing sent, while rerank
   * isn't set up or is paused, while the built-in model isn't downloaded, and
   * when the User declines or the request fails.
   */
  const reranker: Reranker = async (query, candidates, abortSignal) => {
    const current = stored();
    if (!current || pausedNow(current) || candidates.length < 2) return [...candidates];
    if (!isService(current.kind)) return rerankBuiltIn(query, candidates, abortSignal);
    return rerankWithService(current.kind, modelOf(current), query, candidates, abortSignal);
  };

  return {
    status,
    reranker,

    /** The reranker, while rerank is set up and not paused; undefined otherwise. */
    active(): Reranker | undefined {
      const current = stored();
      return current && !pausedNow(current) ? reranker : undefined;
    },

    /** The built-in model is chosen: its download's progress is rerank's to report. */
    usesBuiltIn: () => stored()?.kind === "built-in",

    /**
     * There are Documents to search: if the built-in model reranks them and
     * isn't downloaded, its download starts (again, after a failed one), as
     * the built-in embedding model's does when a Document needs it.
     */
    prepare(): void {
      if (stored()?.kind === "built-in" && !builtIn.isReady()) builtIn.ensure();
    },

    /** Starts the built-in model's download, or tries it again after a failure. */
    download(): Promise<RerankSettings> {
      builtIn.retry();
      return status();
    },

    /**
     * Sets rerank up, or changes it. A service needs the User to accept the
     * rerank flow to it first; its key is stored first, so if the keychain
     * refuses it, nothing changes. The built-in model needs neither: its
     * download starts (or starts again after a failure), and a service's key
     * is forgotten.
     */
    async save(input: unknown): Promise<RerankSettings> {
      if (!isRecord(input)) throw new InvalidInputError("saveRerankSettings expects an object.");
      for (const key of Object.keys(input)) {
        if (!["kind", "apiKey", "modelId"].includes(key)) {
          throw new InvalidInputError(`Rerank has no setting "${key}".`);
        }
      }
      const kind = parseKind(input.kind);
      if (!isService(kind)) {
        if (input.apiKey !== undefined || (input.modelId !== undefined && input.modelId !== null)) {
          throw new InvalidInputError("The built-in reranking model takes no key or model name.");
        }
        settings.writeDeviceValue(SETTINGS_VALUE, { kind, modelId: null } satisfies StoredRerank);
        await secrets.delete(KEY_NAME);
        builtIn.retry();
        return status();
      }
      const apiKey = parseApiKey(input.apiKey);
      const saved = stored();
      const sameKind = saved?.kind === kind;
      const modelId =
        input.modelId === undefined ? (sameKind ? saved.modelId : null) : parseModel(input.modelId);
      refuseInLocalMode();
      if (apiKey === undefined && (!sameKind || (await secrets.tryGet(KEY_NAME)) === null)) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: RERANK_SERVICES[kind].name },
        });
      }
      if (apiKey !== undefined) await secrets.set(KEY_NAME, apiKey);
      settings.writeDeviceValue(SETTINGS_VALUE, { kind, modelId } satisfies StoredRerank);
      // Choosing it, where the form says what goes, allows it (ADR-0022).
      consent.choose(["rerank"], RERANK_SERVICES[kind]);
      // The built-in model, if it ran, isn't needed any more.
      builtIn.unload();
      return status();
    },

    /** Forgets rerank on this device: its settings, then its key. The built-in model stops. */
    async remove(): Promise<RerankSettings> {
      settings.writeDeviceValue(SETTINGS_VALUE, null);
      await secrets.delete(KEY_NAME);
      builtIn.unload();
      return status();
    },

    /**
     * Reranks two fixed texts against a fixed query with the given service
     * settings, or the saved ones. It sends nothing of the User's, so it needs no consent.
     */
    async test(input: unknown): Promise<ConnectionTestResult> {
      if (input !== undefined && !isRecord(input)) {
        throw new InvalidInputError("testRerankConnection expects an object.");
      }
      const saved = stored();
      const kind = input?.kind === undefined ? saved?.kind : parseKind(input.kind);
      if (!kind || !isService(kind)) throw new InvalidInputError("Choose Cohere or Voyage AI.");
      const sameKind = saved?.kind === kind;
      const modelId =
        input?.modelId === undefined
          ? sameKind
            ? saved.modelId
            : null
          : parseModel(input.modelId);
      const apiKey =
        parseApiKey(input?.apiKey) ??
        (sameKind ? storedApiKey(await secrets.tryGet(KEY_NAME)) : null);
      if (!apiKey)
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: RERANK_SERVICES[kind].name },
        });
      refuseInLocalMode();
      try {
        const { ranking } = await rerank({
          model: createModel({ kind, apiKey, modelId: modelId ?? DEFAULT_RERANK_MODELS[kind] }),
          documents: TEST_DOCUMENTS,
          query: TEST_QUERY,
          topN: TEST_DOCUMENTS.length,
          maxRetries: 0,
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]),
        });
        if (ranking.length === 0) {
          return {
            ok: false,
            error: { kind: "provider", message: "The reranking model returned no ranking." },
          };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: classifyProviderError(error) };
      }
    },
  };
}
