/**
 * How the evaluation runs and reports the other ways to find what the
 * reranker sees (eval/lib/searches.ts): keyword search's top 40 and 60, each
 * search's candidates reranked as a mode of its own, never gating, and what
 * the report says of them. The evaluation itself needs the real models and
 * isn't part of `npm test`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ChatSettings } from "../../eval/lib/config";
import { type CorpusPassage, createCorpus } from "../../eval/lib/corpus";
import type { EvalQuestion } from "../../eval/lib/evaluationSet";
import type { Library } from "../../eval/lib/library";
import { openOtherSearches } from "../../eval/lib/otherSearches";
import { type EvalReport, terminalSummary, writeReports } from "../../eval/lib/report";
import type { OpenReranker, RerankerInfo } from "../../eval/lib/rerank";
import {
  compareAggregations,
  coreSource,
  GATING_MODE,
  type QuestionResult,
  type RerankedSearch,
  type RetrievalRun,
  rerankedSearchOf,
  rerankMode,
  runReranked,
  SEARCH_LABELS,
} from "../../eval/lib/retrieval";
import { buildSubChunkIndex } from "../../eval/lib/subChunks";
import { BUILT_IN_RERANKING_MODEL, type Core, type PassageSearchResult } from "../../src/core";

let nextSeq = 1;
const passage = (
  documentId: string,
  text: string,
  overrides: Partial<CorpusPassage> = {},
): CorpusPassage => {
  const seq = nextSeq++;
  return {
    seq,
    passageId: `p${seq}`,
    documentId,
    documentName: documentId,
    pageFrom: 1,
    pageTo: 1,
    position: seq,
    text,
    ...overrides,
  };
};

/** A core whose keyword search returns `ranking` (cut to the limit asked), recording what it was asked. */
function fakeCore(ranking: (query: string) => readonly PassageSearchResult[]) {
  const asked: string[] = [];
  const core = {
    searchPassages: async (query: string, options: { mode: string; limit: number }) => {
      asked.push(`${query}: ${options.mode} ${options.limit}`);
      return ranking(query).slice(0, options.limit);
    },
  } as unknown as Core;
  return { core, asked };
}

describe("Keyword search's top 20, 40 and 60", () => {
  test("hand the reranker that many of keyword search's Passages", async () => {
    const ranking = Array.from({ length: 70 }, (_, index) =>
      passage("d", `p${index}`, { passageId: `k${index}` }),
    );
    const { core, asked } = fakeCore(() => ranking);
    for (const [search, depth] of [
      ["keyword", 20],
      ["keyword-40", 40],
      ["keyword-60", 60],
    ] as const) {
      const source = coreSource(core, search);
      const found = await source?.("tides", {} as EvalQuestion);
      expect(found?.candidates).toHaveLength(depth);
    }
    expect(asked).toEqual(["tides: keyword 20", "tides: keyword 40", "tides: keyword 60"]);
    // The searches that need more than the core have no source of their own here.
    expect(coreSource(core, "feedback")).toBeNull();
  });

  test("their modes, and the other searches', are named after them", () => {
    const model = BUILT_IN_RERANKING_MODEL;
    expect(rerankMode(model, "keyword-40")).toBe(`keyword-40-rerank:${model.id}`);
    expect(rerankMode(model, "small-to-big")).toBe(`small-to-big-rerank:${model.id}`);
    for (const search of Object.keys(SEARCH_LABELS) as (keyof typeof SEARCH_LABELS)[]) {
      expect(rerankedSearchOf(rerankMode(model, search))).toBe(search);
    }
    expect(rerankedSearchOf(`keyword-rerank:${model.id}`)).toBe("keyword");
  });
});

describe("Reranking another search's candidates", () => {
  test("uses the source given, records what it searched for and whether its candidates held the expected Passage, and skips the translated query", async () => {
    const expected = passage("doc-1", "Spring tides happen at full moon.");
    const others = Array.from({ length: 4 }, (_, index) => passage("doc-1", `other ${index}`));
    const { core, asked } = fakeCore(() => []);
    const sourced: string[] = [];
    const reranker: OpenReranker = {
      mode: "feedback-rerank:fake",
      rerank: async (_query, passages) => [...passages].reverse(),
      info: () => ({}) as RerankerInfo,
      close: () => {},
    };
    const question: EvalQuestion = {
      id: "xl-01",
      language: "zh",
      crossLingual: true,
      question: "大潮什么时候出现？",
      translatedQuery: "When are spring tides?",
      expected: { document: "tides", pages: [1, 1], quote: "Spring tides happen at full moon." },
    };
    const results: QuestionResult[] = [
      {
        id: "xl-01",
        language: "zh",
        crossLingual: true,
        question: question.question,
        modes: {},
        translated: {},
      },
    ];

    const timing = await runReranked(
      core,
      [question],
      new Map([["tides", "doc-1"]]),
      reranker,
      results,
      {
        source: async (query) => {
          sourced.push(query);
          return { candidates: [...others, expected], queries: ["moon", "full"] };
        },
        translated: false,
      },
    );

    expect(asked).toEqual([]);
    expect(sourced).toEqual(["大潮什么时候出现？"]);
    expect(timing.queries).toBe(1);
    expect(results[0]?.modes["feedback-rerank:fake"]).toMatchObject({ hit: true, rank: 1 });
    expect(results[0]?.translated?.["feedback-rerank:fake"]).toBeUndefined();
    expect(results[0]?.candidates).toEqual({ feedback: { question: 5, reached: 5 } });
    expect(results[0]?.queries).toEqual({ feedback: ["moon", "full"] });
    await expect(
      runReranked(core, [question], new Map([["tides", "doc-1"]]), reranker, results),
    ).rejects.toThrow("its candidates weren't given");
  });
});

describe("Small-to-big's ways of scoring Passages", () => {
  test("are compared by how often they put the expected Passage among the 20 candidates, before reranking", () => {
    nextSeq = 1;
    const text = "Spring tides come at full moon.";
    const corpus = createCorpus([
      passage("a", text),
      passage("b", "Orders ship from the Leeds warehouse on Fridays."),
    ]);
    const index = buildSubChunkIndex(corpus, (id) => [
      { page: 1, text: id === "a" ? text : "Orders ship from the Leeds warehouse on Fridays." },
    ]);
    const question = (id: string, asked: string, paraphrase = false): EvalQuestion => ({
      id,
      language: "en",
      crossLingual: false,
      ...(paraphrase && { paraphrase }),
      question: asked,
      expected: { document: "tides", pages: [1, 1], quote: text },
    });
    try {
      expect(
        compareAggregations(
          index,
          [
            question("en-01", "spring tides full moon"),
            question("en-02", "Leeds warehouse"),
            question("para-en-01", "When is the sea highest? At full moon?", true),
          ],
          new Map([["tides", "a"]]),
        ),
      ).toEqual(
        (["best", "sum"] as const).map((aggregation) => ({
          aggregation,
          reached: { gating: { hits: 1, total: 2 }, paraphrase: { hits: 1, total: 1 } },
        })),
      );
    } finally {
      index.close();
    }
  });
});

describe("The report of the other searches", () => {
  const model = BUILT_IN_RERANKING_MODEL;
  const tally = (hits: number, total: number) => ({ hits, total });
  const summary = (en: number, zh: number, paraphrase: [number, number]) => ({
    en: tally(en, 20),
    zh: tally(zh, 20),
    core: tally(en + zh, 40),
    crossLingual: tally(2, 10),
    crossLingualTranslated: null,
    paraphrase: {
      en: tally(paraphrase[0], 8),
      zh: tally(paraphrase[1], 7),
      all: tally(paraphrase[0] + paraphrase[1], 15),
    },
  });
  const info = (search: RerankedSearch, candidates: number): RerankerInfo => ({
    mode: rerankMode(model, search),
    name: model.name,
    licence: "Apache-2.0",
    downloadBytes: 136e6,
    loadSeconds: 1.5,
    latency: { queries: 74, mean: 700, median: 690, p95: 900, max: 950 },
    candidates: {
      queries: 75,
      mean: candidates,
      median: candidates,
      p95: candidates,
      max: candidates,
    },
  });
  const counts = (search: RerankedSearch, mean: number, gating: number, paraphrase: number) => ({
    search,
    searches: 65,
    mean,
    min: 9,
    max: mean,
    reached: { gating: tally(gating, 40), paraphrase: tally(paraphrase, 15) },
  });
  const run: RetrievalRun = {
    embedding: "multilingual-e5-small (built-in)",
    gating: true,
    passageCount: 1199,
    processingSeconds: 60,
    questions: [
      {
        id: "en-12",
        language: "en",
        crossLingual: false,
        question: 'What does "few-shot" mean in the Brellan report?',
        modes: { [GATING_MODE]: { hit: false, rank: null, top: [] } },
        keywordRank: 71,
        queries: {
          feedback: ["articles", "generated"],
          "document-first": ["Demonstrations Not Weights"],
        },
      },
    ],
    summary: {
      [GATING_MODE]: summary(15, 19, [6, 4]),
      [rerankMode(model, "keyword-60")]: summary(16, 20, [6, 5]),
      [rerankMode(model, "sub-questions")]: summary(15, 19, [6, 4]),
    },
    rerankers: [info("keyword", 2), info("keyword-60", 3), info("sub-questions", 5)],
    candidates: [
      counts("keyword", 19.5, 36, 10),
      counts("keyword-60", 58, 39, 13),
      counts("sub-questions", 19.8, 36, 10),
    ],
    otherSearches: {
      skipped: { rewrites: "the chat model failed: timeout" },
      smallToBig: {
        maxTokens: 128,
        subChunks: 3074,
        meanTokens: 114.4,
        unplaced: 0,
        indexBytes: 0.9e6,
        passageIndexBytes: 1.1e6,
        buildSeconds: 0.4,
        aggregations: [
          { aggregation: "best", reached: { gating: tally(35, 40), paraphrase: tally(10, 15) } },
          { aggregation: "sum", reached: { gating: tally(34, 40), paraphrase: tally(10, 15) } },
        ],
      },
      queryModel: [
        {
          search: "sub-questions",
          model: "anthropic/model",
          questions: 65,
          calls: 0,
          cached: 65,
          meanMs: 850,
          p95Ms: 1200,
          meanInputTokens: 210,
          meanOutputTokens: 18,
          meanQueries: 0.2,
        },
      ],
    },
  };
  const report: EvalReport = {
    result: "fail",
    failures: [],
    run: {
      startedAt: "2026-10-10T09:00:00.000Z",
      seconds: 60,
      commit: "abc1234",
      node: "v25",
      platform: "darwin arm64",
      cpu: "M2",
    },
    evaluationSet: {
      source: "eval/retrieval/questions.json",
      hitRule: "",
      questions: { gating: { en: 20, zh: 20 }, crossLingual: 10, paraphrase: 15 },
    },
    documents: [],
    retrieval: { topK: 5, gatingMode: GATING_MODE, runs: [run] },
    citations: { skipped: "no chat model" },
  };

  test("gives each one's hits next to the gate's, what its candidates held, and what a search costs", async () => {
    const results = await mkdtemp(join(tmpdir(), "other-searches-report-"));
    try {
      const markdown = (
        await readFile(join(await writeReports(report, results, "/"), "report.md"), "utf8")
      ).split("\n");
      const name = model.name;
      expect(markdown).toContain("### Other ways to find the candidates (reported, not gating)");
      expect(markdown).toContain(
        `| keyword top 60 + ${name} | 16/20 | 20/20 | 36/40 | 11/15 (6 + 5) | 39/40 | 13/15 | 58.0 | 3 ms | 700 ms | 703 ms |`,
      );
      expect(markdown).toContain(
        `| keyword top 20 + ${name} | 15/20 | 19/20 | 34/40 | 10/15 (6 + 4) | 36/40 | 10/15 | 19.5 | 2 ms | 700 ms | 702 ms |`,
      );
      // The search Tool's reranked order first, then the other seven.
      const header = markdown.findIndex((line) =>
        line.startsWith("| Reranked mode | English | Chinese |"),
      );
      const end = markdown.indexOf("", header);
      expect(
        markdown.slice(header + 2, end).map((line) => line.split(" | ")[0]?.replace(/^\| /, "")),
      ).toEqual([
        `keyword top 20 + ${name}`,
        ...[
          "keyword top 40",
          "keyword top 60",
          "keyword + feedback terms",
          "keyword + rewrites",
          "keyword + sub-questions",
          "small-to-big",
          "document first",
        ].map((search) => `${search} + ${name}`),
      ]);
      // A chat model's call is part of the cost, as measured when it was made.
      expect(markdown).toContain(
        `| keyword + sub-questions + ${name} | 15/20 | 19/20 | 34/40 | 10/15 (6 + 4) | 36/40 | 10/15 | 19.8 | 5 ms + 850 ms model call | 700 ms | 1555 ms |`,
      );
      expect(markdown).toContain(
        `| keyword + rewrites + ${name} | skipped: the chat model failed: timeout ||||||||||`,
      );
      expect(markdown).toContain(`| small-to-big + ${name} | skipped: it didn't run. ||||||||||`);
      expect(markdown).toContain(
        "Small-to-big's index: 3074 sub-chunks of 114 tokens on average (at most 128), 0.9 MB for the FTS5 table and the sub-chunk to Passage table, against 1.1 MB for the Passages' own keyword index built the same way; built in 0.4 s.",
      );
      expect(markdown).toContain("| their best sub-chunk's score (the mode's) | 35/40 | 10/15 |");
      expect(markdown).toContain(
        `| keyword + sub-questions + ${name} | \`anthropic/model\` | 65 | 0 | 65 | 850 ms | 1200 ms | 210 | 18 | 0.2 |`,
      );
      // The gate's misses say how deep keyword search has the expected Passage, and what the other searches looked for.
      expect(markdown).toContain("  Plain keyword search ranks the expected Passage at 71.");
      expect(markdown).toContain('  Feedback terms: "articles", "generated".');
      expect(markdown).toContain('  Documents searched inside: "Demonstrations Not Weights".');
      expect(markdown.find((line) => line.startsWith("| Question |"))).toContain(
        "| keyword, to 200 | Text |",
      );
      expect(markdown).toContain(
        `| en-12 | – | – | – | 71 | What does "few-shot" mean in the Brellan report? |`,
      );

      const lines = terminalSummary(report, "/repo/eval/results/x", "/repo").split("\n");
      expect(lines).toContain(
        "    Small-to-big's index: 3074 sub-chunks, 0.9 MB (the Passages' own: 1.1 MB), built in 0.4 s; expected Passage among the 20 candidates by best sub-chunk score 35/40 gating, 10/15 paraphrase; by sum sub-chunk score 34/40 gating, 10/15 paraphrase",
      );
      expect(lines).toContain(
        "    keyword + sub-questions: anthropic/model, 0 calls in this run and 65 from the cache, 850 ms and 210 + 18 tokens per call on average",
      );
      expect(lines).toContain("    keyword + rewrites: skipped, the chat model failed: timeout");
    } finally {
      await rm(results, { recursive: true, force: true });
    }
  });
});

describe("The chat-model modes with a local chat model", () => {
  const chat: ChatSettings = {
    kind: "ollama",
    modelId: "llama3.2",
    apiKey: null,
    baseUrl: null,
    numCtx: null,
    endpoint: null,
    citing: null,
  };
  const question = {
    id: "en-01",
    language: "en",
    crossLingual: false,
    question: "What are tides?",
    expected: { document: "d", pages: [1, 1], quote: "tides" },
  } satisfies EvalQuestion;

  /** A library whose chat provider sends to `service` (null: this computer), and how many times the chat model was called. */
  async function open(service: { name: string } | null, localQueryModes?: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "incarnamind-modes-"));
    let calls = 0;
    const core = {
      searchPassages: async () => [],
      saveChatProvider: async () => ({ service }),
    } as unknown as Core;
    const library = {
      core,
      documents: new Map([["d", { id: "doc-d" }]]),
      passages: () => [],
      pageTexts: () => [],
    } as unknown as Library;
    try {
      const opened = await openOtherSearches(
        library,
        [question],
        {
          chat,
          resultsDir: dir,
          ...(localQueryModes !== undefined && { localQueryModes }),
          generate: async () => {
            calls++;
            return { text: "tides at the full moon", inputTokens: 1, outputTokens: 1 };
          },
        },
        () => {},
      );
      opened.close();
      return { opened, calls };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("are skipped by default, and the report says why", async () => {
    const { opened, calls } = await open(null);
    expect(calls).toBe(0);
    expect(Object.keys(opened.sources)).not.toContain("rewrites");
    expect(Object.keys(opened.sources)).not.toContain("sub-questions");
    expect(opened.report.skipped.rewrites).toMatch(/runs on this computer.*LOCAL_QUERY_MODES=on/);
    expect(opened.report.skipped["sub-questions"]).toMatch(/LOCAL_QUERY_MODES=on/);
  });

  test("run when the variable is on", async () => {
    const { opened, calls } = await open(null, true);
    expect(calls).toBe(2);
    expect(Object.keys(opened.sources)).toEqual(
      expect.arrayContaining(["rewrites", "sub-questions"]),
    );
    expect(opened.report.skipped).toEqual({});
  });

  test("run for a model that sends to a service, whatever the variable says", async () => {
    const { opened, calls } = await open({ name: "Anthropic" });
    expect(calls).toBe(2);
    expect(opened.report.skipped).toEqual({});
  });
});
