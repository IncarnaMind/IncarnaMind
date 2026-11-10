/**
 * The real built-in embedding model (multilingual-e5-small on onnxruntime-node),
 * run in this process. Skipped unless INCARNAMIND_REAL_MODEL=1, because it
 * downloads 135 MB from Hugging Face. To reuse files downloaded before, set
 * INCARNAMIND_MODEL_DIR to a folder holding them (onnx/model_quantized.onnx,
 * tokenizer.json, tokenizer_config.json): they are copied in and checked
 * against their recorded SHA-256 instead of downloaded.
 */
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { BUILT_IN_EMBEDDING_MODEL, type Embedder } from "../../src/core";
import {
  createChannelEmbedder,
  type EmbedderChannel,
  type EmbedderRequest,
  type EmbedderResponse,
  serveEmbedder,
} from "../../src/core/embedding/channel";
import { downloadModel } from "../../src/core/embedding/download";
import { createOnnxEmbedder } from "../../src/core/embedding/onnx";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { waitForModel } from "../helpers/embedding";

const PASSAGES: Record<string, string> = {
  "Attention.md":
    "The Transformer dispenses with recurrence and convolutions entirely and relies on an attention mechanism to draw global dependencies between input and output.",
  "Climate.md":
    "Rising sea levels and more frequent heatwaves are among the consequences of global warming caused by greenhouse gas emissions.",
  "Banking.md":
    "The central bank raised interest rates by half a percentage point to bring inflation back to its target.",
  "梯度下降.txt": "梯度下降法是一种一阶迭代优化算法，用于寻找可微函数的局部最小值。",
  "长城.txt": "长城是中国古代修建的军事防御工程，东起山海关，西至嘉峪关，全长两万多公里。",
};

describe.runIf(process.env.INCARNAMIND_REAL_MODEL === "1")(
  "The real built-in embedding model",
  { timeout: 15 * 60_000 },
  () => {
    test("embeds Passages, and Chinese and English queries find the right one", async () => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const cached = process.env.INCARNAMIND_MODEL_DIR;
      if (cached) {
        await cp(cached, join(dataDir, "models", BUILT_IN_EMBEDDING_MODEL.folder), {
          recursive: true,
        });
      }
      const core = startCore(dataDir, {
        embedder: createOnnxEmbedder(),
        embeddingModelSource: BUILT_IN_EMBEDDING_MODEL.source,
      });
      await core.downloadEmbeddingModel();
      await waitForModel(core, (status) => status.state !== "downloading", 14 * 60_000);
      expect(await core.getEmbeddingModel()).toMatchObject({ state: "ready", error: null });

      const documents = await addAndProcess(
        core,
        await Promise.all(
          Object.entries(PASSAGES).map(([name, text]) => writeSourceFile(sources, name, text)),
        ),
        60_000,
      );
      expect(documents.map((document) => document.status)).toEqual(documents.map(() => "ready"));
      const idOf = (name: string) =>
        documents.find((document) => document.name === name.replace(/\.\w+$/, ""))?.id;

      const top = async (query: string) =>
        (await core.searchPassages(query, { mode: "vector", limit: 1 }))[0]?.documentId;
      expect(await top("什么算法可以找到函数的最小值？")).toBe(idOf("梯度下降.txt"));
      expect(await top("古代中国修建了什么防御工程？")).toBe(idOf("长城.txt"));
      expect(await top("How do neural networks model long-range dependencies?")).toBe(
        idOf("Attention.md"),
      );
      expect(await top("Why would a central bank put rates up?")).toBe(idOf("Banking.md"));
      expect(
        (await core.searchPassages("effects of climate change on the oceans"))[0]?.documentId,
      ).toBe(idOf("Climate.md"));
    });

    // protects=the real model behind the app's channel and serving code: closed with a text out, that text fails, and the next load embeds as before (#2930); fails_when=the text waits for ever, or the model can't load again after a close; no_claim=the utility process's own stop, which needs Electron.
    test("closed with a text out, it fails that text, then loads again and embeds it", async () => {
      const folder = join(await createTempDataFolder(), "models", BUILT_IN_EMBEDDING_MODEL.folder);
      const cached = process.env.INCARNAMIND_MODEL_DIR;
      if (cached) await cp(cached, folder, { recursive: true });
      await downloadModel({
        directory: folder,
        source: BUILT_IN_EMBEDDING_MODEL.source,
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      const files = {
        model: join(folder, BUILT_IN_EMBEDDING_MODEL.files.model),
        tokenizer: join(folder, BUILT_IN_EMBEDDING_MODEL.files.tokenizer),
        tokenizerConfig: join(folder, BUILT_IN_EMBEDDING_MODEL.files.tokenizerConfig),
        maxTokens: BUILT_IN_EMBEDDING_MODEL.maxTokens,
      };
      // Served on this thread, not a worker: a worker stopped under onnxruntime's run aborts the
      // whole process (#2830).
      const served: { model: Embedder; busy: number }[] = [];
      const embedder = createChannelEmbedder((): EmbedderChannel => {
        const each = { model: createOnnxEmbedder(), busy: 0 };
        served.push(each);
        let serve: (request: EmbedderRequest) => void = () => {};
        let deliver: (response: EmbedderResponse) => void = () => {};
        let stopped = false;
        serveEmbedder(each.model, {
          onRequest: (listener) => {
            serve = listener;
          },
          respond: (response) => {
            each.busy--;
            if (!stopped) setImmediate(() => deliver(structuredClone(response)));
          },
        });
        return {
          send: (request) => {
            each.busy++;
            setImmediate(() => serve(structuredClone(request)));
          },
          onResponse: (listener) => {
            deliver = listener;
          },
          onExit: () => {},
          stop: () => {
            stopped = true;
          },
        };
      });

      await embedder.load(files);
      const answered = await embedder.embed("query: 长城有多长？");
      const out = embedder.embed("query: How long is the Great Wall?");
      embedder.close();
      await expect(out).rejects.toThrow("The embedding model was stopped.");

      await embedder.load(files);
      const again = await embedder.embed("query: 长城有多长？");
      const cosine = again.reduce((sum, value, at) => sum + value * (answered[at] ?? 0), 0);
      expect(again).toHaveLength(BUILT_IN_EMBEDDING_MODEL.dimensions);
      expect(cosine).toBeGreaterThan(0.9999);
      expect(served).toHaveLength(2);
      embedder.close();
      await vi.waitFor(() => expect(served.map((each) => each.busy)).toEqual([0, 0]));
      for (const each of served) each.model.close();
    });
  },
);
