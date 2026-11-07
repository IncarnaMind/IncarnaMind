/**
 * The real built-in reranking candidates (int8 ONNX cross-encoders on
 * onnxruntime-node), run in this process. Skipped unless
 * INCARNAMIND_REAL_RERANKER=1, because each downloads 136 to 588 MB from
 * Hugging Face. INCARNAMIND_REAL_RERANKER_IDS picks candidates by id
 * (default: the built-in one). To reuse files downloaded before, set
 * INCARNAMIND_RERANKER_MODEL_DIR to a folder holding each candidate's files
 * in a folder named like its id: they are copied in and checked against
 * their recorded SHA-256 instead of downloaded. The built-in model's GPU file
 * (235 MB) is taken from a folder named like its id and "-gpu" there.
 */
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RERANKING_MODEL_CANDIDATES } from "../../eval/lib/rerankingModels";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core";
import type { RerankingModelFiles } from "../../src/core/adapters";
import { downloadModel } from "../../src/core/embedding/download";
import { createRerankingModel, rerankText } from "../../src/core/reranking/index";
import {
  createOnnxCrossEncoder,
  createOrtSession,
  pairEncoder,
  pairIds,
} from "../../src/core/reranking/onnx";
import { createTempDataFolder } from "../helpers/core";

const ids = (process.env.INCARNAMIND_REAL_RERANKER_IDS ?? BUILT_IN_RERANKING_MODEL.id).split(",");
const candidates = RERANKING_MODEL_CANDIDATES.filter((candidate) => ids.includes(candidate.id));

const HITS = [
  { id: "bananas", documentName: "Fruit", text: "Bananas are rich in potassium and fibre." },
  {
    id: "paris",
    documentName: "Cities",
    text: "Paris is the capital and largest city of France, on the Seine.",
  },
  { id: "rain", documentName: "Weather", text: "Heavy rain is expected across the north." },
  { id: "巴黎", documentName: "城市", text: "巴黎是法国的首都和最大城市，位于塞纳河畔。" },
  { id: "长城", documentName: "历史", text: "长城是中国古代修建的军事防御工程。" },
];

describe.runIf(process.env.INCARNAMIND_REAL_RERANKER === "1")(
  "The real built-in reranking candidates",
  { timeout: 30 * 60_000 },
  () => {
    test.each(candidates.map((candidate) => [candidate.name, candidate] as const))(
      "%s puts the Passages that answer first, across English and Chinese",
      async (_name, candidate) => {
        const dataDir = await createTempDataFolder();
        const cached = process.env.INCARNAMIND_RERANKER_MODEL_DIR;
        if (cached) {
          await cp(join(cached, candidate.id), join(dataDir, "models", candidate.folder), {
            recursive: true,
          });
        }
        const states: string[] = [];
        const ready = Promise.withResolvers<void>();
        const model = createRerankingModel({
          definition: candidate,
          dataDir,
          crossEncoder: createOnnxCrossEncoder(),
          emitStatus: (status) => {
            states.push(status.state);
            if (status.state === "ready") ready.resolve();
            if (status.state === "failed") ready.reject(new Error(status.error?.message));
          },
        });
        try {
          // Files copied in are ready at once, with no status to wait for.
          if (model.isReady()) ready.resolve();
          else model.retry();
          await ready.promise;

          const english = await model.rerank("What is the capital of France?", HITS);
          expect(english?.slice(0, 2).map((hit) => hit.id)).toEqual(
            expect.arrayContaining(["paris", "巴黎"]),
          );
          const chinese = await model.rerank("中国古代修建了什么防御工程？", HITS);
          expect(chinese?.[0]?.id).toBe("长城");
          for (const hit of english ?? []) {
            expect(hit.score).toBeGreaterThan(0);
            expect(hit.score).toBeLessThan(1);
          }

          // A Passage much longer than the model reads is cut, not refused.
          const long = { id: "long", documentName: "Long", text: "Paris. ".repeat(2000) };
          expect(await model.rerank("Paris", [long, ...HITS])).toHaveLength(HITS.length + 1);

          // Its tokenizer's pairs follow one template, so a Passage's tokens are kept (#2532),
          // and each pair is the one the tokenizer reads whole.
          const { Tokenizer } = await import("@huggingface/tokenizers");
          const folder = join(dataDir, "models", candidate.folder);
          const tokenizer = new Tokenizer(
            JSON.parse(await readFile(join(folder, candidate.files.tokenizer), "utf8")),
            JSON.parse(await readFile(join(folder, candidate.files.tokenizerConfig), "utf8")),
          );
          const pairs = pairEncoder(tokenizer, candidate.maxTokens);
          const queries = [
            "What is the capital of France?",
            "中国古代修建了什么防御工程？",
            "Paris ".repeat(300),
          ];
          const texts = [...HITS, long].map(rerankText);
          for (const query of queries)
            for (const text of texts)
              expect(pairs(query, text)).toEqual(
                pairIds(tokenizer, query, text, candidate.maxTokens),
              );
          const reads = vi.spyOn(tokenizer, "encode");
          pairs("Another question", texts[0] ?? "");
          expect(reads.mock.calls.map(([text]) => text)).toEqual(["Another question"]);
        } finally {
          model.close();
        }
      },
    );
  },
);

describe.runIf(process.env.INCARNAMIND_REAL_RERANKER === "1")(
  "The built-in reranking model on the GPU",
  { timeout: 30 * 60_000 },
  () => {
    // protects=reading the GPU file's copies between host and GPU memory as Identity changes no score or order (#2532); fails_when=any score differs by a bit from the file opened as downloaded; no_claim=a computer with no GPU adapter, where it doesn't run.
    test("gives every score, bit for bit, with its file's host copies read as Identity", async (context) => {
      const definition = BUILT_IN_RERANKING_MODEL;
      const gpu = definition.gpu;
      if (!gpu) throw new Error("The built-in model has no GPU file.");
      const dataDir = await createTempDataFolder();
      const folder = join(dataDir, "models", definition.folder);
      const gpuFolder = join(dataDir, "models", gpu.folder);
      const cached = process.env.INCARNAMIND_RERANKER_MODEL_DIR;
      if (cached) {
        await cp(join(cached, definition.id), folder, { recursive: true });
        await cp(join(cached, `${definition.id}-gpu`), gpuFolder, { recursive: true });
      }
      const signal = new AbortController().signal;
      await downloadModel({
        directory: folder,
        source: definition.source,
        signal,
        onProgress: () => {},
      });
      await downloadModel({
        directory: gpuFolder,
        source: { baseUrl: definition.source.baseUrl, files: [gpu.file] },
        signal,
        onProgress: () => {},
      });
      const files: RerankingModelFiles = {
        model: join(folder, definition.files.model),
        tokenizer: join(folder, definition.files.tokenizer),
        tokenizerConfig: join(folder, definition.files.tokenizerConfig),
        maxTokens: definition.maxTokens,
        gpu: { model: join(gpuFolder, gpu.file.path), check: gpu.check },
      };
      const texts = [
        ...HITS,
        { documentName: "Long", text: "Paris is on the Seine. ".repeat(400) },
        { documentName: "长文", text: "长城是中国古代修建的军事防御工程。".repeat(120) },
        ...Array.from({ length: 13 }, (_, index) => ({
          documentName: `Notes ${index + 1}`,
          text: `Clause ${index + 1}: the tenant pays rent on day ${index + 1}. `.repeat(
            index * 3 + 1,
          ),
        })),
      ].map(rerankText);
      const queries = [
        "What is the capital of France?",
        "中国古代修建了什么防御工程？",
        "When is rent due?",
      ];
      const scores = async (crossEncoder: ReturnType<typeof createOnnxCrossEncoder>) => {
        const all = [];
        for (const query of queries) all.push(await crossEncoder.score(query, texts));
        crossEncoder.close();
        return all;
      };
      const asApp = createOnnxCrossEncoder();
      if ((await asApp.load(files)).device !== "gpu") context.skip();
      const withoutCopies = await scores(asApp);
      const asDownloaded = createOnnxCrossEncoder({ createSession: createOrtSession });
      expect(await asDownloaded.load(files)).toEqual({ device: "gpu" });

      const downloaded = await scores(asDownloaded);

      expect(withoutCopies.flat()).toHaveLength(queries.length * texts.length);
      expect(
        withoutCopies.flat().map((score, at) => Object.is(score, downloaded.flat()[at])),
      ).not.toContain(false);
    });
  },
);
