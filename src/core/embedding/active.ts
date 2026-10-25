/**
 * The embedding model document search uses on this device (ADR-0005): none
 * by default, since embeddings are off and search finds Passages by their
 * words, reranked (ADR-0009, 2026-10-10). The User can turn them on with the
 * built-in model, or a provider (OpenAI, Google, an OpenAI-compatible server,
 * or Ollama), through the AI SDK's `embed` and `embedMany`. While they are
 * off, nothing is downloaded, loaded or sent, and Documents are ready once
 * their keyword index is.
 *
 * An install from before embeddings could be off has no stored on/off: it
 * keeps them on only if the User had chosen a provider other than the
 * built-in model, which only an explicit choice stored. The built-in model,
 * the old default, goes off; the vectors it made stay stored, unused, and
 * are used again if the User turns it back on.
 *
 * Documents see one `SearchEmbedder` whatever the provider. Its `id` names
 * the model, and is recorded with every vector (documents.embedding_model,
 * with their size in documents.embedding_dimensions), so search never
 * compares vectors from different models. Switching model tells Documents to
 * embed everything again (see ../documents/embedding).
 *
 * A cloud provider's requests are the "embeddings" data flow: every
 * Document's text and every search query. Nothing is sent before the User
 * accepts it; declining leaves Documents waiting, and search finds Passages
 * by their words alone. Local mode ("keep everything on this computer")
 * switches a cloud provider back to the built-in model.
 *
 * The provider's settings and key are per device, like the vectors they make:
 * the settings as device values, the key in the keychain, never in SQLite.
 */
import { embed, embedMany } from "ai";
import { normaliseText } from "../../shared/text";
import type {
  EmbeddingConnectionTestResult,
  EmbeddingProvider,
  EmbeddingRebuild,
  ExternalService,
  ProviderError,
} from "../api";
import type { Consent } from "../consent";
import { ConsentDeclinedError, EmbeddingModelNotReadyError, InvalidInputError } from "../errors";
import { storedApiKey } from "../providers/apiKey";
import {
  type ApiEmbeddingChoice,
  type ApiEmbeddingModel,
  type EmbeddingModelFactory,
  embeddingKeyRequired,
  embeddingModelKey,
  embeddingProviderName,
  embeddingProviderOptions,
  embeddingServiceFor,
  type ParsedEmbeddingInput,
  parseEmbeddingInput,
  parseStoredChoice,
  shortError,
} from "../providers/embeddings";
import { classifyProviderError } from "../providers/providerErrors";
import type { Secrets } from "../secrets";
import { createSendGate } from "../sendGate";
import type { SettingsStore } from "../settings";
import type { EmbeddingModel } from "./index";

/** The data the "embeddings" flow sends to a cloud provider. */
const EMBEDDINGS_FLOW_SENDS = ["document-text", "queries"] as const;

/** Device values: only this module changes them. */
const ENABLED_VALUE = "embeddingsOn";
const PROVIDER_VALUE = "embeddingProvider";
const LOCAL_ONLY_VALUE = "localOnly";
const REBUILD_VALUE = "embeddingRebuild";
const KEY_NAME = "embedding-provider:api-key";

/** Passages per API request: progress is stored as each batch comes back. */
const API_BATCH_SIZE = 32;
const BATCH_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;
/** Tries after the first, for rate limits and lost connections (the AI SDK backs off between them). */
const RETRIES = 2;

/** The text a connection test embeds: nothing of the User's. */
const TEST_TEXT = "IncarnaMind is checking that it can reach this embedding model.";

/**
 * Thrown by `embedPassages` when the model can't be used now (the built-in
 * model couldn't start again, or the provider failed): Documents wait for it
 * rather than fail.
 */
export class EmbeddingUnavailableError extends Error {
  override name = "EmbeddingUnavailableError";
}

/** The embedding model as Documents use it, whatever the provider. */
export interface SearchEmbedder {
  /**
   * Whether embeddings are on. While they are off (the default), nothing is
   * embedded: Documents are ready once their keyword index is, and search
   * doesn't embed queries. The rest is the model the User would turn on.
   */
  enabled(): boolean;
  /** The model vectors come from: recorded with them. Changes when the User switches. */
  readonly id: string;
  /** How many Passages one `embedPassages` call takes. */
  readonly batchSize: number;
  /** Whether Documents can be embedded now: the built-in model is downloaded, or the provider has no error. */
  isReady(): boolean;
  /** Starts what makes it ready, if anything does by itself (the built-in model's download). */
  ensure(): void;
  /** Resolves true once it can embed; false if it can't (see `notReadyError`). */
  load(): Promise<boolean>;
  /**
   * The vectors of a Document's Passages, in order: its name, then each
   * Passage, normalised. L2-normalised. Throws `EmbeddingUnavailableError`
   * when the model can't be used now; another error fails this Document.
   */
  embedPassages(documentName: string, texts: readonly string[]): Promise<Float32Array[]>;
  /** A search query's vector. L2-normalised. */
  embedQuery(query: string): Promise<Float32Array>;
  /** What a vector search throws while the model can't be used. */
  notReadyError(): Error;
  /** Calls `listener` each time the model becomes ready: downloaded, or recovered from an error. */
  onReady(listener: () => void): void;
  /** Calls `listener` after the User switched to another model. */
  onSwitch(listener: () => void): void;
}

/** One provider's model, behind the `SearchEmbedder`. */
interface ProviderModel {
  readonly id: string;
  readonly batchSize: number;
  isReady(): boolean;
  ensure(): void;
  load(): Promise<boolean>;
  embedPassages(documentName: string, texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(query: string): Promise<Float32Array>;
  notReadyError(): Error;
  /** No longer in use: stop its requests, free its memory. */
  release(): void;
}

/** What is stored for an API provider. */
interface StoredProvider extends ApiEmbeddingChoice {
  /** Learned from the model's first vector. */
  dimensions: number | null;
}

function parseStored(value: unknown): StoredProvider | null {
  const choice = parseStoredChoice(value);
  if (!choice) return null;
  const dimensions = (value as { dimensions?: unknown }).dimensions;
  return {
    ...choice,
    dimensions:
      typeof dimensions === "number" && Number.isInteger(dimensions) && dimensions > 0
        ? dimensions
        : null,
  };
}

const isRebuildReason = (value: unknown): value is EmbeddingRebuild["reason"] =>
  value === "provider-changed" || value === "local-mode";

/** L2-normalised, as float32s. Throws for an empty or all-zero vector. */
function normalised(vector: readonly number[]): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!(norm > 0)) throw new Error("The embedding model returned an empty vector.");
  return Float32Array.from(vector, (value) => value / norm);
}

/** The built-in model, one Passage at a time (ADR-0009). */
function builtInProvider(model: EmbeddingModel): ProviderModel {
  /** The process running the model may have stopped: start it again and try once more. */
  const withRestart = async (embedOne: () => Promise<Float32Array>) => {
    try {
      return await embedOne();
    } catch {
      if (!(await model.load())) {
        throw new EmbeddingUnavailableError("The built-in embedding model couldn't start again.");
      }
      return embedOne();
    }
  };
  return {
    id: model.id,
    batchSize: 1,
    isReady: () => model.isReady(),
    ensure: () => model.ensure(),
    load: () => model.load(),
    async embedPassages(documentName, texts) {
      const vectors: Float32Array[] = [];
      for (const text of texts) {
        vectors.push(await withRestart(() => model.embedPassage(documentName, text)));
      }
      return vectors;
    },
    embedQuery: (query) => withRestart(() => model.embedQuery(query)),
    notReadyError: () => new EmbeddingModelNotReadyError(model.status()),
    release: () => model.unload(),
  };
}

export function createActiveEmbedding(options: {
  /** The built-in model: the default, and what local mode goes back to. */
  builtIn: EmbeddingModel;
  settings: SettingsStore;
  secrets: Secrets;
  consent: Consent;
  createModel: EmbeddingModelFactory;
  /** Aborts requests when the core closes. */
  signal: AbortSignal;
  /** The provider's error, or its dimensions, changed: the core reports the settings again. */
  onChange(): void;
}) {
  const { builtIn, settings, secrets, consent, createModel, signal } = options;
  const readyListeners = new Set<() => void>();
  const switchListeners = new Set<() => void>();
  /** Why the current provider can't embed now; null for the built-in model, which reports its own state. */
  let error: ProviderError | null = null;

  const stored = () => parseStored(settings.readDeviceValue(PROVIDER_VALUE));
  const localOnly = () => settings.readDeviceValue(LOCAL_ONLY_VALUE) === true;
  const gate = createSendGate(consent, localOnly);
  // No choice stored, on a new install or one from before embeddings could be off: on only
  // for a provider the User chose (see above), and stored, so it holds from now on.
  if (typeof settings.readDeviceValue(ENABLED_VALUE) !== "boolean") {
    settings.writeDeviceValue(ENABLED_VALUE, stored() !== null);
  }
  const enabled = () => settings.readDeviceValue(ENABLED_VALUE) === true;

  const notify = (listeners: ReadonlySet<() => void>) => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (failure) {
        console.error(failure);
      }
    }
  };

  const setError = (next: ProviderError | null) => {
    const recovered = error !== null && next === null;
    error = next && shortError(next);
    options.onChange();
    if (recovered) notify(readyListeners);
  };

  /** The model behind an API provider, for as long as it is the current one. */
  function apiProvider({ kind, baseUrl, modelId }: ApiEmbeddingChoice): ProviderModel {
    const choice: ApiEmbeddingChoice = { kind, baseUrl, modelId };
    const id = embeddingModelKey(choice);
    const service = embeddingServiceFor(choice.kind, choice.baseUrl);
    /** Aborted when the User switches away: requests still running stop. */
    const inUse = new AbortController();
    const abortSignal = (timeoutMs: number) =>
      AbortSignal.any([inUse.signal, signal, AbortSignal.timeout(timeoutMs)]);

    const gated = (model: ApiEmbeddingModel) =>
      service ? gate.embeddingModel(model, "embeddings", service) : model;

    /** The key, if the provider takes one; throws (setting the error) when a required one is missing. */
    const key = async (): Promise<string | null> => {
      const apiKey = storedApiKey(await secrets.tryGet(KEY_NAME));
      if (!apiKey && embeddingKeyRequired(choice.kind)) {
        throw new EmbeddingUnavailableError(
          `No API key for ${embeddingProviderName(choice)} can be read on this device.`,
        );
      }
      return apiKey;
    };

    /** Checks each vector's size against the model's, learning it from the first. */
    const checked = (vectors: readonly (readonly number[])[]): Float32Array[] => {
      const result = vectors.map(normalised);
      const size = result[0]?.length;
      if (size === undefined) return result;
      if (result.some((vector) => vector.length !== size)) {
        throw new Error("The embedding model returned vectors of different sizes.");
      }
      const current = stored();
      if (current && embeddingModelKey(current) === id) {
        if (current.dimensions === null) {
          settings.writeDeviceValue(PROVIDER_VALUE, { ...current, dimensions: size });
          options.onChange();
        } else if (current.dimensions !== size) {
          throw new Error(
            `The model now returns vectors of ${size} numbers instead of ${current.dimensions}, which can't be compared with those it made before. Choose another model, or the built-in one.`,
          );
        }
      }
      return result;
    };

    /** Runs a request; a failure becomes the provider's error, and `EmbeddingUnavailableError`. */
    const request = async <T>(send: (apiKey: string | null) => Promise<T>): Promise<T> => {
      try {
        const apiKey = await key();
        if (service) await consent.ensure("embeddings", service);
        const result = await send(apiKey);
        if (current === provider && error !== null) setError(null);
        return result;
      } catch (failure) {
        // Switched away, or the core closed: the caller notices and drops the result.
        if (inUse.signal.aborted || signal.aborted) throw new EmbeddingUnavailableError("Stopped.");
        const classified =
          failure instanceof EmbeddingUnavailableError
            ? { kind: "auth" as const, message: failure.message }
            : classifyProviderError(failure);
        if (current === provider) setError(classified);
        throw new EmbeddingUnavailableError(classified.message);
      }
    };

    const provider: ProviderModel = {
      id,
      batchSize: API_BATCH_SIZE,
      isReady: () => error === null,
      ensure: () => {},
      async load() {
        if (service && consent.status("embeddings", service) === "declined") {
          if (error?.kind !== "consent-declined") {
            setError({
              kind: "consent-declined",
              message: new ConsentDeclinedError({
                id: "embeddings",
                service,
                sends: [...EMBEDDINGS_FLOW_SENDS],
              }).message,
            });
          }
          return false;
        }
        try {
          await key();
          return true;
        } catch (failure) {
          const message = (failure as Error).message;
          if (error?.message !== message) setError({ kind: "auth", message });
          return false;
        }
      },
      embedPassages: (documentName, texts) =>
        request(async (apiKey) => {
          const { embeddings } = await embedMany({
            model: gated(createModel({ ...choice, apiKey })),
            values: texts.map((text) => `${normaliseText(documentName)}\n${normaliseText(text)}`),
            maxRetries: RETRIES,
            maxParallelCalls: 2,
            abortSignal: abortSignal(BATCH_TIMEOUT_MS),
            providerOptions: embeddingProviderOptions(choice.kind, "document"),
          });
          if (embeddings.length !== texts.length) {
            throw new Error(
              `The embedding model returned ${embeddings.length} vectors for ${texts.length} Passages.`,
            );
          }
          return checked(embeddings);
        }),
      embedQuery: (query) =>
        request(async (apiKey) => {
          const { embedding } = await embed({
            model: gated(createModel({ ...choice, apiKey })),
            value: normaliseText(query),
            maxRetries: 1,
            abortSignal: abortSignal(QUERY_TIMEOUT_MS),
            providerOptions: embeddingProviderOptions(choice.kind, "query"),
          });
          return checked([embedding])[0] as Float32Array;
        }),
      notReadyError: () => new EmbeddingModelNotReadyError(null, error),
      release: () => inUse.abort(),
    };
    return provider;
  }

  const builtInModel = builtInProvider(builtIn);
  const initial = stored();
  let current: ProviderModel = initial ? apiProvider(initial) : builtInModel;
  // The built-in model's download finishing makes it ready, if it is the one in use.
  builtIn.onReady(() => {
    if (enabled() && current === builtInModel) notify(readyListeners);
  });

  /** Makes `next` the model in use, and tells Documents to embed again with it. */
  function switchTo(next: ProviderModel, reason: EmbeddingRebuild["reason"]): void {
    const previous = current;
    current = next;
    error = null;
    if (previous !== next) previous.release();
    settings.writeDeviceValue(REBUILD_VALUE, { reason });
    notify(switchListeners);
    options.onChange();
  }

  /**
   * Turns embeddings off: the model in use stops (its requests, or the
   * built-in model's process), any rebuild ends, and Documents being
   * embedded, or waiting for the model, are ready as they are.
   */
  function turnOff(): void {
    settings.writeDeviceValue(ENABLED_VALUE, false);
    settings.writeDeviceValue(PROVIDER_VALUE, null);
    settings.writeDeviceValue(REBUILD_VALUE, null);
    const previous = current;
    current = builtInModel;
    error = null;
    previous.release();
    notify(switchListeners);
    options.onChange();
  }

  /** The key a test or save uses: the one given, or the stored one if it belongs to the same server. */
  async function keyFor(parsed: Extract<ParsedEmbeddingInput, { choice: ApiEmbeddingChoice }>) {
    if (parsed.apiKey !== undefined) return parsed.apiKey;
    const saved = stored();
    const sameServer =
      saved !== null &&
      saved.kind === parsed.choice.kind &&
      saved.baseUrl === parsed.choice.baseUrl;
    return sameServer ? storedApiKey(await secrets.tryGet(KEY_NAME)) : null;
  }

  function refuseCloudInLocalMode(service: ExternalService | null): void {
    if (service && localOnly()) {
      throw new InvalidInputError({ key: "error.provider.embeddingLocalMode" });
    }
  }

  const model: SearchEmbedder = {
    enabled,
    get id() {
      return current.id;
    },
    get batchSize() {
      return current.batchSize;
    },
    isReady: () => current.isReady(),
    ensure: () => current.ensure(),
    load: () => current.load(),
    embedPassages: (documentName, texts) => current.embedPassages(documentName, texts),
    embedQuery: (query) => current.embedQuery(query),
    notReadyError: () => current.notReadyError(),
    onReady(listener) {
      readyListeners.add(listener);
    },
    onSwitch(listener) {
      switchListeners.add(listener);
    },
  };

  consent.registry.register({
    id: "embeddings",
    sends: EMBEDDINGS_FLOW_SENDS,
    async services() {
      const provider = stored();
      const service = provider && embeddingServiceFor(provider.kind, provider.baseUrl);
      return service ? [service] : [];
    },
  });

  return {
    model,

    /** The provider in use, as the public interface describes it: "off" while embeddings are. */
    async provider(): Promise<EmbeddingProvider> {
      if (!enabled()) {
        return {
          kind: "off",
          baseUrl: null,
          modelId: "",
          hasApiKey: false,
          dimensions: null,
          service: null,
        };
      }
      const provider = stored();
      if (!provider) {
        return {
          kind: "built-in",
          baseUrl: null,
          modelId: builtIn.status().name,
          hasApiKey: false,
          dimensions: builtIn.dimensions,
          service: null,
        };
      }
      return {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        modelId: provider.modelId,
        hasApiKey: (await secrets.tryGet(KEY_NAME)) !== null,
        dimensions: provider.dimensions,
        service: embeddingServiceFor(provider.kind, provider.baseUrl),
      };
    },

    /** Why the provider can't embed now, if it can't. */
    error: () => error,

    localOnly,

    /** Why Documents are being embedded again, while a rebuild is under way. */
    rebuildReason(): EmbeddingRebuild["reason"] | null {
      const value = settings.readDeviceValue(REBUILD_VALUE);
      const reason =
        value && typeof value === "object" ? (value as { reason?: unknown }).reason : null;
      return isRebuildReason(reason) ? reason : null;
    },

    /** Every Document is embedded with the current model. */
    endRebuild(): void {
      if (settings.readDeviceValue(REBUILD_VALUE) !== null) {
        settings.writeDeviceValue(REBUILD_VALUE, null);
      }
    },

    /**
     * Switches to the provider in `input` (choosing a cloud one allows the
     * embeddings flow to it, ADR-0022), or turns embeddings off ("off", which
     * deletes any key). Turning them on, or a different model, makes Documents
     * without its vectors embed; the same model only takes the new key, and
     * tries again after an error.
     */
    async save(input: unknown): Promise<void> {
      const parsed = parseEmbeddingInput(input);
      const wasOn = enabled();
      if (parsed.kind === "off") {
        await secrets.delete(KEY_NAME);
        if (wasOn) turnOff();
        return;
      }
      if (parsed.kind === "built-in") {
        const wasApi = stored() !== null;
        settings.writeDeviceValue(ENABLED_VALUE, true);
        settings.writeDeviceValue(PROVIDER_VALUE, null);
        await secrets.delete(KEY_NAME);
        if (wasApi || !wasOn) switchTo(builtInModel, "provider-changed");
        return;
      }
      const { choice } = parsed;
      const service = embeddingServiceFor(choice.kind, choice.baseUrl);
      refuseCloudInLocalMode(service);
      const apiKey = await keyFor(parsed);
      if (!apiKey && embeddingKeyRequired(choice.kind)) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: embeddingProviderName(choice) },
        });
      }
      const saved = stored();
      const sameModel =
        wasOn && saved !== null && embeddingModelKey(saved) === embeddingModelKey(choice);
      if (apiKey) await secrets.set(KEY_NAME, apiKey);
      else await secrets.delete(KEY_NAME);
      settings.writeDeviceValue(PROVIDER_VALUE, {
        ...choice,
        dimensions: sameModel ? saved.dimensions : null,
      } satisfies StoredProvider);
      settings.writeDeviceValue(ENABLED_VALUE, true);
      // Choosing it, where the dialog says what goes, allows it (ADR-0022).
      if (service) consent.choose(["embeddings"], service);
      if (sameModel) {
        // A new key: try again whatever failed before.
        if (error !== null) setError(null);
        else options.onChange();
        return;
      }
      switchTo(apiProvider(choice), "provider-changed");
    },

    /** Embeds a fixed text with the given settings: it sends nothing of the User's, so it needs no consent. */
    async test(input: unknown): Promise<EmbeddingConnectionTestResult> {
      const parsed = parseEmbeddingInput(input);
      if (parsed.kind === "off") {
        throw new InvalidInputError("Embeddings are off: there is no model to test.");
      }
      if (parsed.kind === "built-in") {
        if (!(await builtIn.load())) {
          const status = builtIn.status();
          return {
            ok: false,
            error: {
              kind: "model",
              message: status.error?.message ?? "The built-in model isn't downloaded yet.",
            },
          };
        }
        try {
          return { ok: true, dimensions: (await builtIn.embedQuery(TEST_TEXT)).length };
        } catch (failure) {
          return { ok: false, error: classifyProviderError(failure) };
        }
      }
      const { choice } = parsed;
      const service = embeddingServiceFor(choice.kind, choice.baseUrl);
      refuseCloudInLocalMode(service);
      const apiKey = await keyFor(parsed);
      if (!apiKey && embeddingKeyRequired(choice.kind)) {
        throw new InvalidInputError({
          key: "error.provider.keyMissing",
          values: { provider: embeddingProviderName(choice) },
        });
      }
      try {
        const { embedding } = await embed({
          model: createModel({ ...choice, apiKey }),
          value: TEST_TEXT,
          maxRetries: 0,
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]),
          providerOptions: embeddingProviderOptions(choice.kind, "query"),
        });
        return { ok: true, dimensions: normalised(embedding).length };
      } catch (failure) {
        return { ok: false, error: classifyProviderError(failure) };
      }
    },

    /** Tries the provider again: Documents waiting for it carry on. Nothing while embeddings are off. */
    retry(): void {
      if (!enabled()) return;
      if (current === builtInModel) {
        builtIn.retry();
        return;
      }
      error = null;
      options.onChange();
      notify(readyListeners);
    },

    /**
     * Turns local mode on or off. On, a cloud provider goes back to the
     * built-in model (its key is deleted) and Documents embed again. Returns
     * whether the provider changed.
     */
    async setLocalOnly(enabled: unknown): Promise<boolean> {
      if (typeof enabled !== "boolean") {
        throw new InvalidInputError("“Keep everything on this computer” takes true or false.");
      }
      settings.writeDeviceValue(LOCAL_ONLY_VALUE, enabled);
      const provider = stored();
      if (!enabled || !provider || !embeddingServiceFor(provider.kind, provider.baseUrl)) {
        options.onChange();
        return false;
      }
      settings.writeDeviceValue(PROVIDER_VALUE, null);
      await secrets.delete(KEY_NAME);
      switchTo(builtInModel, "local-mode");
      return true;
    },
  };
}
