/**
 * Runs the built-in embedding model with onnxruntime-node and the Hugging Face
 * tokenizer (ADR-0009), on the CPU. It blocks whatever thread it runs on for
 * tens of milliseconds a text, so the desktop app runs it in an Electron
 * utility process (src/main/embedderProcess.ts), never on the core's thread.
 *
 * multilingual-e5-small takes token ids and an attention mask; its vector is
 * the mean of the last hidden states over the tokens, L2-normalised, which is
 * what sentence-transformers and transformers.js compute for it. One text at a
 * time: with the int8 model, batching changes the results.
 */

import { readFile } from "node:fs/promises";
import type { Embedder, EmbeddingModelFiles } from "../adapters";
import { ONNX_RUNTIME, TOKENIZERS } from "../engineModules";

type OnnxRuntime = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

interface Loaded {
  key: string;
  session: InferenceSession;
  tokenizer: import("@huggingface/tokenizers").Tokenizer;
  maxTokens: number;
  ort: OnnxRuntime;
}

export function createOnnxEmbedder(): Embedder {
  let loaded: Loaded | undefined;
  let loading: Promise<Loaded> | undefined;

  async function load(files: EmbeddingModelFiles): Promise<Loaded> {
    const ort = await ONNX_RUNTIME.load();
    const { Tokenizer } = await TOKENIZERS.load();
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      readFile(files.tokenizer, "utf8"),
      readFile(files.tokenizerConfig, "utf8"),
    ]);
    const tokenizer = new Tokenizer(JSON.parse(tokenizerJson), JSON.parse(tokenizerConfig));
    const session = await ort.InferenceSession.create(files.model, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
    return { key: JSON.stringify(files), session, tokenizer, maxTokens: files.maxTokens, ort };
  }

  return {
    async load(files) {
      const key = JSON.stringify(files);
      if (loaded?.key === key) return;
      loading ??= load(files).finally(() => {
        loading = undefined;
      });
      const next = await loading;
      if (loaded && loaded !== next) void loaded.session.release();
      loaded = next;
    },

    async embed(text) {
      if (!loaded) throw new Error("The embedding model isn't loaded.");
      const { session, tokenizer, maxTokens, ort } = loaded;
      let { ids } = tokenizer.encode(text);
      // Cut long texts like the model's tokenizer config does: keep the end-of-text token.
      if (ids.length > maxTokens) ids = [...ids.slice(0, maxTokens - 1), ids.at(-1) as number];
      const length = ids.length;
      const tensor = (values: BigInt64Array) => new ort.Tensor("int64", values, [1, length]);
      const feeds: Record<string, import("onnxruntime-node").Tensor> = {
        input_ids: tensor(BigInt64Array.from(ids, (id) => BigInt(id))),
        attention_mask: tensor(new BigInt64Array(length).fill(1n)),
      };
      if (session.inputNames.includes("token_type_ids")) {
        feeds.token_type_ids = tensor(new BigInt64Array(length));
      }
      const output = await session.run(feeds);
      const hidden = output.last_hidden_state;
      if (!hidden) throw new Error("The model returned no last_hidden_state.");
      const dimensions = hidden.dims[2] ?? 0;
      const states = hidden.data as Float32Array;
      // Mean pooling over the tokens (all of them: there is no padding), then L2 normalisation.
      const vector = new Float32Array(dimensions);
      let norm = 0;
      for (let d = 0; d < dimensions; d++) {
        let sum = 0;
        for (let token = 0; token < length; token++)
          sum += states[token * dimensions + d] as number;
        const mean = sum / length;
        vector[d] = mean;
        norm += mean * mean;
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dimensions; d++) vector[d] = (vector[d] as number) / norm;
      for (const tensorOut of Object.values(output)) tensorOut.dispose();
      return vector;
    },

    close() {
      void loaded?.session.release();
      loaded = undefined;
    },
  };
}
