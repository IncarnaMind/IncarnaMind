/**
 * Runs a built-in reranking model, a cross-encoder, with onnxruntime-node and
 * the Hugging Face tokenizer. Like the embedding model (see ../embedding/onnx),
 * it blocks whatever thread it runs on, so the desktop app runs it in an
 * Electron utility process (src/main/rerankerProcess.ts).
 *
 * A cross-encoder reads the query and a text together, as one pair
 * ("<s> query </s></s> text </s>" for the XLM-RoBERTa models), and gives one
 * logit: how well the text answers the query. A pair longer than the model
 * reads loses the end of the text, keeping the end-of-text token, as
 * sentence-transformers' CrossEncoder cuts it.
 *
 * On the CPU, the int8 file scores one pair at a time, like the embedding
 * model: with int8 models, batching makes a score depend on the other texts in
 * the batch. A model with a GPU file runs it instead where onnxruntime's WebGPU
 * execution provider finds an adapter, in batches of texts of similar length:
 * in fp16, padding is masked and changes no score (#270). WebGPU is
 * experimental in onnxruntime, with wrong outputs on some GPUs
 * (microsoft/onnxruntime#32938, #32134, #24442), so the GPU scores the model's
 * check before it reranks, and the model runs on the CPU when no adapter is
 * found, the GPU session fails, or the check's scores are off.
 */

import { readFile } from "node:fs/promises";
import type {
  CpuFallbackReason,
  CrossEncoder,
  RerankingCheck,
  RerankingDevice,
  RerankingModelFiles,
} from "../adapters";
import { ONNX_RUNTIME, TOKENIZERS } from "../engineModules";
import { isRecord } from "../errors";

type Tokenizer = import("@huggingface/tokenizers").Tokenizer;

/** Where a session runs: the CPU, or a GPU through onnxruntime's WebGPU execution provider. */
export type SessionDevice = "cpu" | "gpu";

/** A model's session, as the cross-encoder runs it. */
export interface PairSession {
  /**
   * One logit for each of `rows` pairs of token ids, each padded to `width`,
   * with an attention mask of 1 over its tokens and 0 over the padding.
   */
  run(ids: BigInt64Array, mask: BigInt64Array, rows: number, width: number): Promise<Float32Array>;
  release(): Promise<void>;
}

/** Opens a session for a model's file, or a model's bytes. Rejects if it can't start on that device. */
export type PairSessionFactory = (
  model: string | Uint8Array,
  device: SessionDevice,
) => Promise<PairSession>;

export interface OnnxCrossEncoderOptions {
  /** Defaults to onnxruntime-node's sessions; tests pass a fake. */
  createSession?: PairSessionFactory;
}

/** Texts a GPU batch holds. */
export const GPU_BATCH_SIZE = 8;

/** How far a GPU score may be from the check's, in logits: fp16 is within about 0.02 of fp32. */
export const CHECK_TOLERANCE = 0.1;

/**
 * The smallest ONNX model, y = Identity(x) for one float, as protobuf bytes:
 * opening it on the GPU tells whether onnxruntime finds a GPU adapter, before
 * the model's GPU file is downloaded.
 */
const ADAPTER_PROBE = Uint8Array.from(
  Buffer.from(
    "CAg6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAR",
    "base64",
  ),
);

interface Scorer {
  session: PairSession;
  /** The token ids of the pair (query, text), as `pairIds` gives them. */
  pairs(query: string, text: string): number[];
  /** Texts scored together: 1 on the CPU. */
  batchSize: number;
  padId: number;
}

interface Loaded extends Scorer {
  key: string;
  device: RerankingDevice;
}

/** A query keeps at most this share of the tokens a pair may have; the text gets the rest. */
const QUERY_SHARE = 0.25;

/** The token ids of the pair (query, text), cut to `maxTokens`. */
export function pairIds(tokenizer: Tokenizer, query: string, text: string, maxTokens: number) {
  let question = query;
  const queryTokens = tokenizer.encode(query, { add_special_tokens: false }).ids;
  const queryLimit = Math.floor(maxTokens * QUERY_SHARE);
  // A very long query is cut too, so the text still has room.
  if (queryTokens.length > queryLimit) {
    question = tokenizer.decode(queryTokens.slice(0, queryLimit), { skip_special_tokens: true });
  }
  const { ids } = tokenizer.encode(question, { text_pair: text });
  // The text comes last, followed by one end-of-text token: cut the text's end, keep that token.
  return ids.length > maxTokens ? [...ids.slice(0, maxTokens - 1), ids.at(-1) as number] : ids;
}

/** Texts whose tokens a model keeps, so a Passage met again by another search isn't read again. */
const KEPT_TEXTS = 2_000;

/** Pairs a tokenizer's pair template is checked on before it is trusted: words, CJK, marks, lines. */
const TEMPLATE_PROBES: readonly [string, string][] = [
  ["Which city is the capital?", "Cities\nParis is the capital and largest city of France."],
  ["巴黎是首都吗？", "城市\n巴黎是法国的首都和最大城市，位于塞纳河畔。"],
  ["  spaced  query ", "Notes:\n\n  1. a, b; c! (d) — e…"],
];

/**
 * `pairIds`, keeping each text's tokens between searches: a check's searches meet the same
 * Passages again and again (#2532). Only for a tokenizer whose pair is its two texts' own tokens
 * between fixed special tokens, as found and checked on `TEMPLATE_PROBES`; any other tokenizer
 * reads each pair whole, as `pairIds` does.
 */
export function pairEncoder(tokenizer: Tokenizer, maxTokens: number) {
  const tokens = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids;
  // Found on the first pair, so loading the model reads no text.
  let template: ReturnType<typeof pairTemplate> | undefined;
  const kept = new Map<string, number[]>();
  const textTokens = (text: string) => {
    const known = kept.get(text);
    if (known) return known;
    const read = tokens(text);
    const oldest = kept.size >= KEPT_TEXTS ? kept.keys().next() : null;
    if (oldest && !oldest.done) kept.delete(oldest.value);
    kept.set(text, read);
    return read;
  };
  return (query: string, text: string): number[] => {
    if (template === undefined) template = pairTemplate(tokenizer, tokens);
    // The tokenizer reads an empty second text as no pair at all.
    if (!template || text === "") return pairIds(tokenizer, query, text, maxTokens);
    const queryTokens = tokens(query);
    const queryLimit = Math.floor(maxTokens * QUERY_SHARE);
    // As `pairIds` reads a cut query: decoded, then read again.
    const question =
      queryTokens.length > queryLimit
        ? tokens(tokenizer.decode(queryTokens.slice(0, queryLimit), { skip_special_tokens: true }))
        : queryTokens;
    const ids = [
      ...template.before,
      ...question,
      ...template.between,
      ...textTokens(text),
      ...template.after,
    ];
    return ids.length > maxTokens ? [...ids.slice(0, maxTokens - 1), ids.at(-1) as number] : ids;
  };
}

/** The special tokens around a pair's two texts, if every probe's pair is exactly them and its texts' tokens. */
function pairTemplate(tokenizer: Tokenizer, tokens: (text: string) => number[]) {
  const [first] = TEMPLATE_PROBES;
  if (!first) return null;
  const same = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((id, at) => id === b[at]);
  const pairOf = ([query, text]: readonly [string, string]) =>
    tokenizer.encode(query, { text_pair: text }).ids;
  const pair = pairOf(first);
  const query = tokens(first[0]);
  const text = tokens(first[1]);
  const specials = pair.length - query.length - text.length;
  for (let before = 0; before <= specials; before++) {
    for (let after = 0; before + after <= specials; after++) {
      const template = {
        before: pair.slice(0, before),
        between: pair.slice(before + query.length, pair.length - after - text.length),
        after: pair.slice(pair.length - after),
      };
      const assembled = ([a, b]: readonly [string, string]) => [
        ...template.before,
        ...tokens(a),
        ...template.between,
        ...tokens(b),
        ...template.after,
      ];
      if (TEMPLATE_PROBES.every((probe) => same(assembled(probe), pairOf(probe)))) return template;
    }
  }
  return null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** onnxruntime-node's sessions. */
const createOrtSession: PairSessionFactory = async (model, device) => {
  const ort = await ONNX_RUNTIME.load();
  const options: import("onnxruntime-node").InferenceSession.SessionOptions = {
    executionProviders: [device === "gpu" ? "webgpu" : "cpu"],
    graphOptimizationLevel: "all",
  };
  const session =
    typeof model === "string"
      ? await ort.InferenceSession.create(model, options)
      : await ort.InferenceSession.create(model, options);
  return {
    async run(ids, mask, rows, width) {
      const tensor = (values: BigInt64Array) => new ort.Tensor("int64", values, [rows, width]);
      const feeds: Record<string, import("onnxruntime-node").Tensor> = {
        input_ids: tensor(ids),
        attention_mask: tensor(mask),
      };
      // XLM-RoBERTa has one token type; a model that asks for them gets zeros.
      if (session.inputNames.includes("token_type_ids")) {
        feeds.token_type_ids = tensor(new BigInt64Array(rows * width));
      }
      const output = await session.run(feeds);
      const logits = (output.logits ?? Object.values(output)[0])?.data;
      const scores = logits instanceof Float32Array ? logits.slice(0, rows) : new Float32Array();
      for (const tensorOut of Object.values(output)) tensorOut.dispose();
      return scores;
    },
    release: () => session.release(),
  };
};

/** One logit per text, in the order given. */
async function scoreTexts(model: Scorer, query: string, texts: readonly string[]) {
  const { batchSize, padId } = model;
  const pairs = texts.map((text, index) => ({ index, ids: model.pairs(query, text) }));
  // Texts of similar length share a batch, so it carries little padding.
  if (batchSize > 1) pairs.sort((a, b) => a.ids.length - b.ids.length);
  const scores = new Array<number>(texts.length);
  for (let start = 0; start < pairs.length; start += batchSize) {
    const batch = pairs.slice(start, start + batchSize);
    const width = Math.max(...batch.map((pair) => pair.ids.length));
    const ids = new BigInt64Array(batch.length * width).fill(BigInt(padId));
    const mask = new BigInt64Array(batch.length * width);
    batch.forEach((pair, row) => {
      pair.ids.forEach((id, column) => {
        ids[row * width + column] = BigInt(id);
        mask[row * width + column] = 1n;
      });
    });
    const logits = await model.session.run(ids, mask, batch.length, width);
    batch.forEach((pair, row) => {
      const score = logits[row];
      if (score === undefined || !Number.isFinite(score)) {
        throw new Error("The reranking model returned no score.");
      }
      scores[pair.index] = score;
    });
  }
  return scores;
}

/** The tokenizer's padding token, which XLM-RoBERTa's position ids skip. */
function padIdOf(tokenizer: Tokenizer, config: unknown): number {
  const token = isRecord(config) ? config.pad_token : undefined;
  const id = typeof token === "string" ? tokenizer.token_to_id(token) : undefined;
  if (id === undefined) throw new Error("The reranking model's tokenizer has no padding token.");
  return id;
}

/** The largest difference between the check's scores and the model's, in logits. */
const checkDifference = (check: RerankingCheck, scores: readonly number[]) =>
  Math.max(...scores.map((score, index) => Math.abs(score - (check.scores[index] ?? Number.NaN))));

type GpuAttempt =
  | { session: PairSession; padId: number }
  | { fallback: { reason: CpuFallbackReason; message: string } };

export function createOnnxCrossEncoder(options: OnnxCrossEncoderOptions = {}): CrossEncoder {
  const createSession = options.createSession ?? createOrtSession;
  let loaded: Loaded | undefined;
  let loading: Promise<Loaded> | undefined;

  /** The GPU session, once it has scored the check within `CHECK_TOLERANCE`; otherwise why not. */
  async function openGpu(
    gpu: NonNullable<RerankingModelFiles["gpu"]>,
    tokenizer: Tokenizer,
    tokenizerConfig: unknown,
    pairs: Scorer["pairs"],
  ): Promise<GpuAttempt> {
    const fallback = (reason: CpuFallbackReason, message: string): GpuAttempt => ({
      fallback: { reason, message },
    });
    try {
      await (await createSession(ADAPTER_PROBE, "gpu")).release();
    } catch (error) {
      return fallback("no-adapter", messageOf(error));
    }
    if (gpu.model === null) return fallback("not-downloaded", "The GPU file isn't downloaded yet.");
    let session: PairSession;
    try {
      session = await createSession(gpu.model, "gpu");
    } catch (error) {
      return fallback("session", messageOf(error));
    }
    try {
      const padId = padIdOf(tokenizer, tokenizerConfig);
      const scorer = { session, pairs, batchSize: GPU_BATCH_SIZE, padId };
      const difference = checkDifference(
        gpu.check,
        await scoreTexts(scorer, gpu.check.query, gpu.check.texts),
      );
      // Not `>`: a check score missing from the definition makes it NaN, which must fail too.
      if (!(difference <= CHECK_TOLERANCE)) {
        await session.release();
        return fallback(
          "check",
          `The GPU's scores for the check differ from the model's by up to ${difference.toFixed(3)} logits.`,
        );
      }
      return { session, padId };
    } catch (error) {
      await session.release();
      return fallback("session", messageOf(error));
    }
  }

  async function load(files: RerankingModelFiles): Promise<Loaded> {
    const { Tokenizer } = await TOKENIZERS.load();
    const [tokenizerJson, tokenizerConfigJson] = await Promise.all([
      readFile(files.tokenizer, "utf8"),
      readFile(files.tokenizerConfig, "utf8"),
    ]);
    const tokenizerConfig = JSON.parse(tokenizerConfigJson);
    const tokenizer = new Tokenizer(JSON.parse(tokenizerJson), tokenizerConfig);
    const base = { key: JSON.stringify(files), pairs: pairEncoder(tokenizer, files.maxTokens) };
    const gpu = files.gpu && (await openGpu(files.gpu, tokenizer, tokenizerConfig, base.pairs));
    if (gpu && "session" in gpu) {
      return { ...base, ...gpu, batchSize: GPU_BATCH_SIZE, device: { device: "gpu" } };
    }
    const session = await createSession(files.model, "cpu");
    return {
      ...base,
      session,
      batchSize: 1,
      padId: 0,
      device: { device: "cpu", ...(gpu && { fallback: gpu.fallback }) },
    };
  }

  return {
    async load(files) {
      const key = JSON.stringify(files);
      if (loaded?.key === key) return loaded.device;
      loading ??= load(files).finally(() => {
        loading = undefined;
      });
      const next = await loading;
      if (loaded && loaded !== next) void loaded.session.release();
      loaded = next;
      return next.device;
    },

    async score(query, texts) {
      const model = loaded;
      if (!model) throw new Error("The reranking model isn't loaded.");
      return scoreTexts(model, query, texts);
    },

    close() {
      void loaded?.session.release();
      loaded = undefined;
    },
  };
}
