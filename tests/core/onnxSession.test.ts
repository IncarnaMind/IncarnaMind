import { describe, expect, test, vi } from "vitest";
import { createOnnxCrossEncoder } from "../../src/core/reranking/onnx";
import { onnxModel } from "../helpers/onnxModels";

const create = vi.hoisted(() => vi.fn(async (..._: unknown[]) => ({ release: async () => {} })));
const gpuFile = vi.hoisted((): { bytes: Uint8Array } => ({ bytes: new Uint8Array() }));

vi.mock("onnxruntime-node", () => ({ InferenceSession: { create }, Tensor: class {} }));
vi.mock("@huggingface/tokenizers", () => ({ Tokenizer: class {} }));
vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => (path === "gpu.onnx" ? gpuFile.bytes : "{}"),
}));

const FILES = { model: "m.onnx", tokenizer: "t.json", tokenizerConfig: "c.json", maxTokens: 512 };

describe("The built-in reranking model's session", () => {
  // Four threads and spinning off measured 26% and 34% slower on a quiet computer; four
  // threads was 29% faster at the median only under a heavy load, so the defaults stay (#487).
  test("runs on the CPU with onnxruntime's default threads", async () => {
    create.mockClear();
    await createOnnxCrossEncoder().load(FILES);

    expect(create).toHaveBeenCalledWith("m.onnx", {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
  });

  // protects=a GPU session never runs the copies between host and GPU memory a CUDA export keeps, each of which made the GPU drain once a layer (#2532); fails_when=the GPU file is opened as it was downloaded; no_claim=that the copies cost the same on every GPU.
  test("on the GPU, reads its file with the copies between host and GPU memory read as Identity", async () => {
    create.mockClear();
    gpuFile.bytes = onnxModel([{ op: "MemcpyToHost" }, { op: "Neg" }, { op: "MemcpyFromHost" }]);
    const check = { query: "q", texts: ["t"], scores: [0] };

    await createOnnxCrossEncoder().load({ ...FILES, gpu: { model: "gpu.onnx", check } });

    const opened = create.mock.calls
      .filter(([, options]) => JSON.stringify(options).includes("webgpu"))
      .map(([model]) => model);
    expect(opened.at(-1)).toEqual(
      onnxModel([{ op: "Identity" }, { op: "Neg" }, { op: "Identity" }]),
    );
  });
});
