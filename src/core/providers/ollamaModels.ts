/**
 * What IncarnaMind knows about a model in Ollama before it sends it anything,
 * and the fixed settings every chat request to it carries (see ./ollamaChat):
 *
 * - Whether it can chat, call Tools and think: its `capabilities`, from
 *   `/api/show` (Ollama 0.6.4 and later).
 * - How it cites, chosen from those and its size before the first request
 *   (see `citingMode`): "tools" with the `tools` capability, unless the model
 *   is small; else structured output. Ollama holds any completion model to a
 *   JSON schema with `format`.
 * - Its context window, `num_ctx` (see `chooseNumCtx`; a cloud model's is its
 *   own length, whatever this computer's memory), and the output cap.
 * - `think`: off, so a model answers at once, unless it can only think.
 *
 * Looked up with plain `fetch`: `/api/tags` for the model's digest and size,
 * then `/api/show`. Kept per server, model and digest, so a model pulled again
 * is looked up again, and every request to a model carries the same `num_ctx`:
 * Ollama reloads a model whose `num_ctx` changes.
 */
import { freemem, totalmem } from "node:os";
import type { CitationSupport } from "../api";
import { isRecord } from "../errors";
import { ollamaAnswers } from "./ollama";
import { isCloudModelName, isRemoteEntry } from "./ollamaCloud";

/** The settings every chat request to one model carries. */
export interface OllamaModelSettings {
  /** `options.num_ctx`: the context window, in tokens. */
  numCtx: number;
  /** `options.num_predict` when the request sets no output limit: room the window keeps for the output. */
  outputTokens: number;
  /** `keep_alive`: how long Ollama keeps the model loaded after a request. */
  keepAlive: string;
  /** `think`: false, except for a model that can only think. */
  think: boolean;
  /**
   * The least output cap an Answer's requests may be given where the window is small
   * (`ContextWindow.outputFloor`). Never chosen by the app: an evaluation compares floors with it.
   */
  outputFloor?: number;
}

/** What Ollama says about a model, and the settings chosen from it. */
export interface OllamaModelProfile {
  /** The model's digest in Ollama: it changes when the model is pulled again. */
  digest: string | null;
  /** Its capabilities ("completion", "tools", "thinking", "embedding"…); null when the server doesn't say. */
  capabilities: string[] | null;
  /** The longest context the model was trained for, in tokens; null when unknown. */
  contextLength: number | null;
  /** How many parameters it has; null when Ollama doesn't say. */
  parameters: number | null;
  /** How it gives Citations, chosen from its capabilities and size; null when they are unknown. */
  support: CitationSupport | null;
  /** False for a model that can't answer Questions, such as an embedding model. */
  chat: boolean;
  /** True for a cloud model: Ollama forwards its requests to ollama.com (see `OLLAMA_CLOUD`). */
  remote: boolean;
  settings: OllamaModelSettings;
}

export interface OllamaModels {
  /**
   * The profile of `model` on the Ollama at `baseUrl`, or null when Ollama
   * can't be asked or doesn't have the model: its own request then fails.
   */
  describe(baseUrl: string, model: string): Promise<OllamaModelProfile | null>;
  /**
   * Whether Ollama has the model loaded with a `numCtx` window now (`/api/ps`):
   * a request otherwise waits for it to load. Null when Ollama can't say.
   */
  loaded(baseUrl: string, model: string, numCtx: number): Promise<boolean | null>;
  /** Whether anything answers at `baseUrl`, asked quickly and with no retry. */
  running(baseUrl: string): Promise<boolean>;
}

/** How long Ollama keeps a model loaded after a request: long enough not to reload between Questions. */
export const OLLAMA_KEEP_ALIVE = "30m";

/**
 * The context windows IncarnaMind uses, largest first. Each holds a kind of Answer:
 * - 32,768: a whole Answer at the usual budgets: about 12,000 tokens of
 *   Question context, the instructions, two or three searches of about 4,000
 *   tokens each, and the output.
 * - 16,384: about 4,000 tokens of Question context, and two searches.
 * - 8,192: the least that holds one search and the output; the Question
 *   context then gets what is left.
 */
export const CONTEXT_SIZES = [32_768, 16_384, 8_192] as const;

/** The share of this computer's memory a local model may take, its context included. The rest is for the system, this app and the User's other apps. */
const MEMORY_SHARE = 0.5;

/**
 * The share of this computer's memory the context alone may take: its KV
 * cache grows with `num_ctx`, and one that doesn't fit sends the computer
 * into swap. Qwen3-4B at its own 262,144 tokens needs about 38 GB.
 */
const KV_MEMORY_SHARE = 0.1;

/** The share of the memory free right now that the context may take. */
const KV_FREE_SHARE = 0.5;

/** Memory a loaded model takes besides its weights and its context: compute buffers and the runtime. */
const RUNTIME_BYTES = 512 * 1024 ** 2;

/**
 * The context's memory per token when the model doesn't say enough to work
 * it out: that of a 4B model with full attention in every layer (Qwen3-4B:
 * 36 layers × 8 KV heads × 256 values × 2 bytes), so a guess errs on the large side.
 */
const FALLBACK_KV_BYTES_PER_TOKEN = 147_456;

/** Settings when the model couldn't be looked up: the smallest window, as for a small computer. */
export const DEFAULT_OLLAMA_SETTINGS: Readonly<OllamaModelSettings> = {
  numCtx: 8_192,
  outputTokens: outputTokensFor(8_192, false),
  keepAlive: OLLAMA_KEEP_ALIVE,
  think: false,
};

const LOOKUP_TIMEOUT_MS = 5_000;
/** `/api/ps` can wait while Ollama loads a model: it then counts as not loaded yet. */
const PS_TIMEOUT_MS = 2_000;

/**
 * The output cap: a quarter of the window, at most 4,096 tokens (an Answer of
 * about 3,000 English words), so a model that loops can't hold the User's
 * Answer, and Ollama's queue, for minutes. A model that can only think spends
 * much of it reasoning, so it gets half the window, at most 8,192.
 */
export function outputTokensFor(numCtx: number, thinks: boolean): number {
  return thinks ? Math.min(8_192, Math.floor(numCtx / 2)) : Math.min(4_096, Math.floor(numCtx / 4));
}

const numberOf = (value: unknown): number | null => {
  if (Array.isArray(value)) {
    const numbers = value.filter((each): each is number => typeof each === "number");
    return numbers.length > 0 ? Math.max(...numbers) : null;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * The context's memory per token, from `/api/show`'s `model_info`: keys and
 * values for each layer that keeps them, at 2 bytes each (f16, Ollama's
 * default). A model that uses full attention only every few layers (like
 * Qwen3.5's `full_attention_interval`) keeps them only in those.
 */
export function kvBytesPerToken(modelInfo: Record<string, unknown>): number {
  const arch = modelInfo["general.architecture"];
  const get = (key: string) => numberOf(modelInfo[`${String(arch)}.${key}`]);
  const layers = get("block_count");
  const kvHeads = get("attention.head_count_kv");
  const heads = get("attention.head_count");
  const embedding = get("embedding_length");
  const keyLength = get("attention.key_length") ?? (embedding && heads ? embedding / heads : null);
  const valueLength = get("attention.value_length") ?? keyLength;
  if (!layers || !kvHeads || !keyLength || !valueLength) return FALLBACK_KV_BYTES_PER_TOKEN;
  const interval = get("full_attention_interval");
  const keptLayers = interval && interval > 1 ? Math.ceil(layers / interval) : layers;
  return keptLayers * kvHeads * (keyLength + valueLength) * 2;
}

/** The context's memory, its KV cache, for `tokens` tokens. */
export const kvCacheBytes = (bytesPerToken: number, tokens: number) => bytesPerToken * tokens;

/**
 * The context window, `num_ctx`: the largest of `CONTEXT_SIZES` such that
 * - the context's KV cache (see `kvBytesPerToken`) takes at most a tenth of
 *   this computer's memory, and at most half of the memory free now;
 * - with the model's weights, it takes at most half of this computer's memory;
 * and no larger than the model's own context length. At least the smallest
 * size, which every Answer needs: a model too big for it still runs, more
 * slowly, partly on the CPU. Never the model's own maximum, which Ollama
 * would otherwise use when its server is set to a large default.
 *
 * With 32 GB, and enough of it free: 16,384 for Qwen3.5-4B, Qwen3-4B, Llama
 * 3.2 3B and Mistral 7B (32,768 would take 3.8 to 4.8 GB). With 16 GB or
 * less, or little memory free: 8,192. With 64 GB: 32,768.
 */
export function chooseNumCtx(input: {
  weightsBytes: number;
  kvBytesPerToken: number;
  contextLength: number | null;
  memoryBytes: number;
  /** Memory free now; the total when unknown. */
  freeBytes?: number;
}): number {
  const free = input.freeBytes ?? input.memoryBytes;
  const smallest = CONTEXT_SIZES[CONTEXT_SIZES.length - 1] as number;
  const fits =
    CONTEXT_SIZES.find((size) => {
      const kv = kvCacheBytes(input.kvBytesPerToken, size);
      return (
        kv <= input.memoryBytes * KV_MEMORY_SHARE &&
        kv <= free * KV_FREE_SHARE &&
        input.weightsBytes + RUNTIME_BYTES + kv <= input.memoryBytes * MEMORY_SHARE
      );
    }) ?? smallest;
  return input.contextLength ? Math.min(fits, input.contextLength) : fits;
}

/**
 * Below this many parameters, a model that can call Tools still cites with
 * structured output (ADR-0007, #67). Small models search in the Tool-calling
 * loop but don't call `cite`: qwen3.5:4b (4.5 billion parameters) and
 * Llama 3.2 (3.2 billion) gave no Citations there, while qwen3.5:4b gave
 * Citation records with nearly every Answer in structured output. Models
 * from 7 billion up weren't measured, so they keep the loop.
 */
export const SMALL_MODEL_PARAMETERS = 7_000_000_000;

/**
 * How a model gives Citations, from its capabilities and size: in the
 * Tool-calling loop when it can call Tools and isn't small (see
 * `SMALL_MODEL_PARAMETERS`; a model of unknown size counts as not small);
 * else with structured output, which Ollama gives any completion model; else
 * not at all. Null when the server doesn't say what the model can do.
 */
export function citingMode(
  capabilities: readonly string[] | null,
  parameters: number | null = null,
): CitationSupport | null {
  if (!capabilities) return null;
  const small = parameters !== null && parameters < SMALL_MODEL_PARAMETERS;
  if (capabilities.includes("tools") && !small) return "tools";
  if (capabilities.includes("completion")) return "structured-output";
  return "none";
}

const SIZE_UNITS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/**
 * How many parameters a model has: `/api/show`'s `general.parameter_count`,
 * else its `parameter_size` ("4.5B", "751.63M"). Null when neither says.
 */
export function parameterCount(
  modelInfo: Record<string, unknown>,
  details: Record<string, unknown>,
): number | null {
  const counted = numberOf(modelInfo["general.parameter_count"]);
  if (counted) return counted;
  const size = /^\s*(\d+(?:\.\d+)?)\s*([KMBT])\s*$/i.exec(String(details.parameter_size ?? ""));
  if (!size) return null;
  return Number(size[1]) * (SIZE_UNITS[(size[2] as string).toUpperCase()] as number);
}

/**
 * `think` for a model: false, so it answers without reasoning first, unless
 * `/api/show` says false isn't allowed (a model that can only think: turned
 * off, its reasoning would leak into the Answer).
 */
export function thinkFor(show: Record<string, unknown>): boolean {
  const values = isRecord(show.thinking) ? show.thinking.values : undefined;
  return Array.isArray(values) && values.length > 0 && !values.includes(false);
}

/** The model's entry in `/api/tags`, by its name or, for a name without a tag, as "name:latest". */
function tagEntry(body: unknown, model: string): Record<string, unknown> | null {
  const models = isRecord(body) && Array.isArray(body.models) ? body.models.filter(isRecord) : [];
  const names = model.includes(":") ? [model] : [model, `${model}:latest`];
  return (
    models.find(
      (each) => names.includes(String(each.name)) || names.includes(String(each.model)),
    ) ?? null
  );
}

/** A model's context length, from `model_info` ("<arch>.context_length") or `/api/tags` details. */
function contextLengthOf(
  modelInfo: Record<string, unknown>,
  tag: Record<string, unknown>,
): number | null {
  const arch = modelInfo["general.architecture"];
  const fromInfo = numberOf(modelInfo[`${String(arch)}.context_length`]);
  if (fromInfo) return fromInfo;
  const details = isRecord(tag.details) ? tag.details : {};
  return numberOf(details.context_length);
}

/** Builds the profile from what `/api/tags` and `/api/show` said. */
export function profileOf(
  tag: Record<string, unknown>,
  show: Record<string, unknown>,
  memory: { totalBytes: number; freeBytes?: number },
): OllamaModelProfile {
  const listed = Array.isArray(show.capabilities)
    ? show.capabilities
    : Array.isArray(tag.capabilities)
      ? tag.capabilities
      : null;
  const capabilities = listed?.filter((each): each is string => typeof each === "string") ?? null;
  const modelInfo = isRecord(show.model_info) ? show.model_info : {};
  const contextLength = contextLengthOf(modelInfo, tag);
  const remote = isRemoteEntry(tag) || isRemoteEntry(show);
  const numCtx =
    remote || isCloudModelName(String(tag.name ?? ""))
      ? (contextLength ?? CONTEXT_SIZES[0])
      : chooseNumCtx({
          weightsBytes: numberOf(tag.size) ?? 0,
          kvBytesPerToken: kvBytesPerToken(modelInfo),
          contextLength,
          memoryBytes: memory.totalBytes,
          ...(memory.freeBytes !== undefined && { freeBytes: memory.freeBytes }),
        });
  const think = thinkFor(show);
  const parameters = parameterCount(
    modelInfo,
    isRecord(show.details) ? show.details : isRecord(tag.details) ? tag.details : {},
  );
  return {
    digest: typeof tag.digest === "string" ? tag.digest : null,
    capabilities,
    contextLength,
    parameters,
    support: citingMode(capabilities, parameters),
    chat: capabilities ? capabilities.includes("completion") : true,
    remote,
    settings: {
      numCtx,
      outputTokens: outputTokensFor(numCtx, think),
      keepAlive: OLLAMA_KEEP_ALIVE,
      think,
    },
  };
}

async function request(
  url: string,
  init?: RequestInit,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Whether `/api/ps`'s list has the model loaded with a `numCtx` window. A
 * model loaded with another window is loaded again for the request.
 */
export function isLoaded(ps: unknown, model: string, numCtx: number): boolean {
  const entry = tagEntry(ps, model);
  if (!entry) return false;
  const loadedWith = numberOf(entry.context_length);
  return loadedWith === null || loadedWith === numCtx;
}

/**
 * Looks models up in Ollama, and keeps what it learnt per server, model and
 * digest. The window is chosen from this computer's memory, total and free
 * when the model is first looked up; tests give their own (free memory then
 * counts as the total unless they say).
 */
export function createOllamaModels(
  options: { memoryBytes?: () => number; freeBytes?: () => number } = {},
): OllamaModels {
  const memory = () =>
    options.memoryBytes
      ? { totalBytes: options.memoryBytes(), freeBytes: options.freeBytes?.() }
      : { totalBytes: totalmem(), freeBytes: (options.freeBytes ?? freemem)() };
  const profiles = new Map<string, Promise<OllamaModelProfile | null>>();

  return {
    async describe(baseUrl, model) {
      let tag: Record<string, unknown> | null;
      try {
        tag = tagEntry(await request(`${baseUrl}/api/tags`), model);
      } catch {
        return null;
      }
      if (!tag) return null;
      const key = `${baseUrl}\n${model}\n${String(tag.digest ?? "")}`;
      let profile = profiles.get(key);
      if (!profile) {
        const found = tag;
        profile = request(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model }),
        }).then(
          (show) => profileOf(found, isRecord(show) ? show : {}, memory()),
          // Without /api/show a model is unknown, except that /api/tags may already
          // say it runs on ollama.com: that must still reach the consent check.
          () => (isRemoteEntry(found) ? profileOf(found, {}, memory()) : null),
        );
        profiles.set(key, profile);
        // A failed lookup is tried again next time.
        void profile.then((result) => {
          if (!result) profiles.delete(key);
        });
      }
      return profile;
    },

    async loaded(baseUrl, model, numCtx) {
      try {
        return isLoaded(
          await request(`${baseUrl}/api/ps`, undefined, PS_TIMEOUT_MS),
          model,
          numCtx,
        );
      } catch (error) {
        // Ollama is busy loading (the list waits for it), or can't be reached.
        return error instanceof Error && error.name === "TimeoutError" ? false : null;
      }
    },

    running: ollamaAnswers,
  };
}
