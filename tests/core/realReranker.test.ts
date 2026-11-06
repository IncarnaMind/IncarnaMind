/**
 * The real built-in reranking candidates (int8 ONNX cross-encoders on
 * onnxruntime-node), run in this process. Skipped unless
 * INCARNAMIND_REAL_RERANKER=1, because each downloads 136 to 588 MB from
 * Hugging Face. INCARNAMIND_REAL_RERANKER_IDS picks candidates by id
 * (default: the built-in one). To reuse files downloaded before, set
 * INCARNAMIND_RERANKER_MODEL_DIR to a folder holding each candidate's files
 * in a folder named like its id: they are copied in and checked against
 * their recorded SHA-256 instead of downloaded.
 */
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RERANKING_MODEL_CANDIDATES } from "../../eval/lib/rerankingModels";
import { BUILT_IN_RERANKING_MODEL } from "../../src/core";
import { createRerankingModel, rerankText } from "../../src/core/reranking/index";
import { createOnnxCrossEncoder, pairEncoder, pairIds } from "../../src/core/reranking/onnx";
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
          model.retry();
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
