import { describe, expect, test, vi } from "vitest";
import { createOnnxEmbedder } from "../../src/core/embedding/onnx";
import { createOnnxCrossEncoder } from "../../src/core/reranking/onnx";
import { sessionInUse } from "../../src/core/sessionInUse";

/*
 * A model closed while a run is still on its session lets the session go only once the run has
 * ended (#2830): released under a run, onnxruntime aborts the process, and a check of what the
 * assistant wrote can still be searching as the core closes.
 */

const session = vi.hoisted(() => {
  let finish: () => void = () => undefined;
  return {
    release: vi.fn(async () => undefined),
    /** A run that ends only once `finish` is called. */
    held: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    finish: () => finish(),
  };
});

vi.mock("onnxruntime-node", () => ({
  InferenceSession: {
    create: async () => ({
      inputNames: ["input_ids", "attention_mask"],
      outputNames: ["logits"],
      run: async () => {
        await session.held();
        const tensor = {
          dims: [1, 1, 2],
          data: new Float32Array([1, 0]),
          dispose: () => undefined,
        };
        return { last_hidden_state: tensor, logits: tensor };
      },
      release: session.release,
    }),
  },
  Tensor: class {},
}));
vi.mock("@huggingface/tokenizers", () => ({
  Tokenizer: class {
    encode() {
      return { ids: [1] };
    }
  },
}));
vi.mock("node:fs/promises", () => ({ readFile: async () => "{}" }));

const FILES = { model: "m.onnx", tokenizer: "t.json", tokenizerConfig: "c.json", maxTokens: 8 };

describe("An inference session in use", () => {
  // protects=a session let go while work runs on it is released once that work ends, and once only, and refuses new work; fails_when=it is released under the run, twice, or takes work after it was let go; no_claim=onnxruntime's own behaviour.
  test("is released once its run ends, and takes no more work", async () => {
    const release = vi.fn(async () => undefined);
    const inUse = sessionInUse(release);
    let end: () => void = () => undefined;
    const running = inUse.use(
      () =>
        new Promise<string>((resolve) => {
          end = () => resolve("done");
        }),
    );

    inUse.release();
    expect(release).not.toHaveBeenCalled();
    await expect(inUse.use(async () => "more")).rejects.toThrow("The model was closed.");
    end();
    await expect(running).resolves.toBe("done");
    expect(release).toHaveBeenCalledTimes(1);
    inUse.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  // protects=the embedding model closed while a text is embedded keeps its session until the text is done (#2830); fails_when=close releases the session under the run; no_claim=the vector's values.
  test("the embedding model closed mid-run releases its session after the run", async () => {
    session.release.mockClear();
    const embedder = createOnnxEmbedder();
    await embedder.load(FILES);
    const embedded = embedder.embed("Spring tides");

    embedder.close();
    expect(session.release).not.toHaveBeenCalled();
    session.finish();
    await embedded;
    expect(session.release).toHaveBeenCalledTimes(1);
  });

  // protects=the reranking model closed while it scores keeps its session until the scores are in (#2830); fails_when=close releases the session under the run; no_claim=the scores' values.
  test("the reranking model closed mid-run releases its session after the run", async () => {
    session.release.mockClear();
    const reranker = createOnnxCrossEncoder();
    await reranker.load(FILES);
    const scored = reranker.score("tides", ["Spring tides come at new moon."]);

    reranker.close();
    expect(session.release).not.toHaveBeenCalled();
    session.finish();
    await scored.catch(() => undefined);
    await vi.waitFor(() => expect(session.release).toHaveBeenCalledTimes(1));
  });
});
