import { describe, expect, test, vi } from "vitest";
import { createOnnxCrossEncoder } from "../../src/core/reranking/onnx";

const create = vi.hoisted(() => vi.fn(async () => ({ release: async () => {} })));

vi.mock("onnxruntime-node", () => ({ InferenceSession: { create } }));
vi.mock("@huggingface/tokenizers", () => ({ Tokenizer: class {} }));
vi.mock("node:fs/promises", () => ({ readFile: async () => "{}" }));

describe("The built-in reranking model's session", () => {
  // Four threads and spinning off measured 26% and 34% slower on a quiet computer; four
  // threads was 29% faster at the median only under a heavy load, so the defaults stay (#487).
  test("runs on the CPU with onnxruntime's default threads", async () => {
    await createOnnxCrossEncoder().load({
      model: "m.onnx",
      tokenizer: "t.json",
      tokenizerConfig: "c.json",
      maxTokens: 512,
    });

    expect(create).toHaveBeenCalledWith("m.onnx", {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
  });
});
