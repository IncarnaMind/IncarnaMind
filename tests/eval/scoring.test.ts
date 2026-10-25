/**
 * How the evaluation (`npm run eval`, eval/README.md) scores what the core
 * returns. The evaluation itself needs the real model and isn't part of
 * `npm test`; its scoring is, since a mistake there would skew every report.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type AnswerRecord,
  type CitationOutcome,
  type CitationRecord,
  type CitationRun,
  checkQuestionIds,
  citationLine,
  evalOllamaModels,
  outcomeOf,
  questionsToAsk,
  quotePages,
  quoteRetryLine,
  sentencesOf,
  summariseGroup,
  summariseQuoteRetries,
} from "../../eval/lib/citations";
import type { PassageSearchResult } from "../../src/core";
import { checkCitation } from "../../src/core/answers/citations";

const record = (overrides: Partial<AnswerRecord>): AnswerRecord => ({
  questionId: "en-01",
  language: "en",
  crossLingual: false,
  round: 1,
  question: "When are spring tides?",
  status: "done",
  error: null,
  citationSupport: "tools",
  searches: [],
  droppedMarkers: 0,
  droppedRecords: 0,
  rejectedRecords: [],
  text: "",
  sentences: [],
  citations: [],
  seconds: 1,
  ...overrides,
});

import { readConfig } from "../../eval/lib/config";
import { type EvalQuestion, isGating, loadEvaluationSet } from "../../eval/lib/evaluationSet";
import {
  type EvalReport,
  reviewerSheet,
  terminalSummary,
  writeReports,
} from "../../eval/lib/report";
import type { OpenReranker, RerankerInfo } from "../../eval/lib/rerank";
import { RERANKING_MODEL_CANDIDATES } from "../../eval/lib/rerankingModels";
import {
  type CandidateRecord,
  candidateCounts,
  checkPassage,
  coreSource,
  GATING_LABEL,
  GATING_MODE,
  GATING_SEARCH,
  HYBRID_RERANK_LABEL,
  HYBRID_RERANK_MODE,
  isHit,
  keywordRerankCandidates,
  modesOf,
  OTHER_SEARCHES,
  type QuestionResult,
  RERANKED_SEARCHES,
  type RetrievalRun,
  rerankCandidates,
  rerankedLabel,
  rerankedSearchOf,
  rerankMode,
  retrievalFailures,
  runReranked,
  scoreHanded,
  scoreRanking,
  summarise,
  TOOL_LABEL,
  TOOL_MODE,
} from "../../eval/lib/retrieval";
import {
  BUILT_IN_RERANKING_MODEL,
  type Core,
  type OllamaModelProfile,
  type OllamaModels,
} from "../../src/core";
import { SEARCH_TOOL_PARAMETERS } from "../../src/core/documents/searchTool";

const MARK = "\uE000";

describe("Sentences of an Answer and their Citations", () => {
  test("a Citation counts for the sentence it is in, or the one whose full stop it follows", () => {
    const text = `Spring tides come at full moon ${MARK}. Neap tides are smaller.${MARK} Tides vary.`;
    expect(sentencesOf(text, ["a", "b"], "en")).toEqual([
      { text: "Spring tides come at full moon .", citations: ["a"] },
      { text: "Neap tides are smaller.", citations: ["b"] },
      { text: "Tides vary.", citations: [] },
    ]);
  });

  test("Chinese sentences split at their full stops", () => {
    const text = `月球引力形成潮汐隆起${MARK}。大潮发生在满月时。${MARK}${MARK}小潮最小。`;
    expect(sentencesOf(text, [1, 2, 3], "zh")).toEqual([
      { text: "月球引力形成潮汐隆起。", citations: [1] },
      { text: "大潮发生在满月时。", citations: [2, 3] },
      { text: "小潮最小。", citations: [] },
    ]);
  });
});

describe("What became of a Citation", () => {
  const pages = [
    { page: 1, text: "Tides rise and fall." },
    { page: 2, text: "Revenue grew by ten per-\ncent in the third quarter." },
    { page: 3, text: "Costs fell." },
  ];
  const citation = (quote: string, pageFrom = 2, pageTo = 2) => ({
    check: "not-found" as const,
    checkReason: "quote-not-on-pages" as const,
    quote,
    pageFrom,
    pageTo,
  });

  test("a quote on the cited page under the looser normalisation is a false 'not found'", () => {
    expect(outcomeOf(citation("revenue grew by ten percent, in the third quarter"), pages)).toBe(
      "false-not-found",
    );
  });

  test("a quote on another page is a wrong page; one nowhere in the Document isn't in it", () => {
    expect(outcomeOf(citation("Tides rise and fall"), pages)).toBe("wrong-page");
    expect(outcomeOf(citation("Revenue rose by 10%"), pages)).toBe("not-in-document");
  });

  test("where a quote is: the first page that holds it, or two consecutive ones, or nowhere", () => {
    const twoPages = [
      ...pages,
      { page: 4, text: "Costs fell, and then" },
      { page: 5, text: "rose again." },
    ];
    expect(quotePages("Revenue grew by ten percent", twoPages)).toEqual([2, 2]);
    expect(quotePages("and then rose again", twoPages)).toEqual([4, 5]);
    expect(quotePages("Revenue rose by 10%", twoPages)).toBeNull();
  });

  test("a Citation not found reads as a line: the check, the pages cited and its Passage's, where the quote is", () => {
    const line = citationLine({
      sentence: "Revenue grew.",
      quote: "Revenue grew by ten percent",
      documentName: "Report",
      pageFrom: 1,
      pageTo: 1,
      check: "not-found",
      checkReason: "quote-not-on-pages",
      outcome: "wrong-page",
      passagePages: [1, 2],
      quoteOn: [2, 2],
    });
    expect(line).toBe(
      'wrong page (quote-not-on-pages): Report, cites p. 1 of a Passage on pp. 1–2; the quote is on p. 2: "Revenue grew by ten percent"',
    );
  });

  test("a quote of a page whose stored text lost its f-ligatures is found, told so; not told, it is the check's miss", () => {
    // JP Morgan 2022 Environmental Social Governance Report, p. 8, as stored: pdf.js reads its
    // "fi" ligature as "f", so the page shows "finance" where its text reads "fnance".
    const stored = [
      {
        page: 8,
        text: "set our Sustainable Development Target (the “Target”) with the goal to fnance and\nfacilitate more than $2.5 trillion over 10 years—from 2021 through the end of 2030—",
      },
    ];
    const asShown = "with the goal to finance and facilitate more than $2.5 trillion over 10 years";
    const range = { pageFrom: 8, pageTo: 8 };
    const check = (quote: string, lostLigatures = false) =>
      checkCitation({
        quote,
        range,
        passage: { pageFrom: 7, pageTo: 8 },
        documentDeleted: false,
        pages: stored,
        lostLigatures,
      });

    // Told the Document's text lost its ligatures, as the core tells it from the whole text, the
    // check finds the quote as the page shows it (ADR-0009's amendment).
    expect(check(asShown, true)).toEqual({ check: "found", checkReason: null });
    // Not told, it finds it only as the stored text reads it; the evaluation calls that its miss.
    expect(check(asShown.replace("finance", "fnance")).check).toBe("found");
    const checked = check(asShown);
    expect(checked).toEqual({ check: "not-found", checkReason: "quote-not-on-pages" });
    expect(outcomeOf({ ...checked, ...range, quote: asShown }, stored)).toBe("false-not-found");
    // "efforts" for "eforts", "office" for "ofce", "fifty" for a lost ligature's "ffty".
    const pages = [{ page: 1, text: "our eforts in the ofce, ffty in all" }];
    expect(
      outcomeOf(
        { ...checked, pageFrom: 1, pageTo: 1, quote: "our efforts in the office, fifty in all" },
        pages,
      ),
    ).toBe("false-not-found");
  });

  test("the check's own results are kept", () => {
    expect(
      outcomeOf({ ...citation("Costs fell."), check: "found", checkReason: null }, pages),
    ).toBe("found");
    expect(
      outcomeOf({ ...citation("Costs fell.", 1, 3), checkReason: "too-many-pages" }, pages),
    ).toBe("page-range");
  });
});

describe("The retrieval hit rule", () => {
  const expected = {
    document: "tides",
    pages: [4, 4] as [number, number],
    quote: "international trade slowed",
  };
  const passage = (overrides: Partial<PassageSearchResult>): PassageSearchResult => ({
    passageId: "p",
    documentId: "doc-1",
    documentName: "Tides",
    pageFrom: 3,
    pageTo: 4,
    position: 0,
    text: "Growth in inter-\nnational trade slowed.",
    ...overrides,
  });

  test("needs the expected Document, pages covering the expected ones, and the quote", () => {
    expect(isHit(checkPassage(passage({}), expected, "doc-1"))).toBe(true);
    expect(checkPassage(passage({}), expected, "doc-2")).toMatchObject({ rightDocument: false });
    expect(checkPassage(passage({ pageTo: 3 }), expected, "doc-1")).toMatchObject({
      coversPages: false,
    });
    expect(checkPassage(passage({ text: "Trade slowed." }), expected, "doc-1")).toMatchObject({
      hasQuote: false,
    });
  });

  test("a ranking is a hit in its top 5, and a near miss shows its rank in the top 20", () => {
    const miss = passage({ documentId: "doc-2" });
    const ranked = (at: number) =>
      Array.from({ length: 20 }, (_, index) => (index === at ? passage({}) : miss));
    expect(scoreRanking(ranked(4), expected, "doc-1")).toMatchObject({ hit: true, rank: 5 });
    expect(scoreRanking(ranked(5), expected, "doc-1")).toMatchObject({ hit: false, rank: 6 });
    expect(scoreRanking([miss], expected, "doc-1")).toMatchObject({ hit: false, rank: null });
    expect(scoreRanking(ranked(0), expected, "doc-1").top).toHaveLength(5);
  });
});

describe("Retrieval tallies", () => {
  const result = (
    id: string,
    modes: QuestionResult["modes"],
    extra: Partial<QuestionResult> = {},
  ): QuestionResult => ({
    id,
    language: id.startsWith("zh") ? "zh" : "en",
    crossLingual: id.startsWith("xl"),
    question: id,
    modes,
    ...extra,
  });
  const at = (rank: number | null) => ({ hit: rank !== null && rank <= 5, rank, top: [] });

  test("reranked modes are tallied like the others; a translated second query counts when either search hits", () => {
    const results = [
      result("en-01", { hybrid: at(7), "rerank:mmarco-minilm": at(2) }),
      result("zh-01", { hybrid: at(1), "rerank:mmarco-minilm": at(1) }),
      result(
        "xl-01",
        { hybrid: at(null), "rerank:mmarco-minilm": at(null) },
        { translated: { hybrid: at(3), "rerank:mmarco-minilm": at(9) } },
      ),
      result(
        "xl-02",
        { hybrid: at(4), "rerank:mmarco-minilm": at(1) },
        { translated: { hybrid: at(null), "rerank:mmarco-minilm": at(1) } },
      ),
      // No translation: it isn't in the translated tally.
      result("xl-03", { hybrid: at(2), "rerank:mmarco-minilm": at(2) }),
    ];

    const summary = summarise(results);

    expect(modesOf(results)).toEqual(["hybrid", "rerank:mmarco-minilm"]);
    expect(summary.hybrid).toEqual({
      en: { hits: 0, total: 1 },
      zh: { hits: 1, total: 1 },
      core: { hits: 1, total: 2 },
      crossLingual: { hits: 2, total: 3 },
      crossLingualTranslated: { hits: 2, total: 2 },
      paraphrase: {
        en: { hits: 0, total: 0 },
        zh: { hits: 0, total: 0 },
        all: { hits: 0, total: 0 },
      },
    });
    expect(summary["rerank:mmarco-minilm"]).toMatchObject({
      en: { hits: 1, total: 1 },
      crossLingual: { hits: 2, total: 3 },
      crossLingualTranslated: { hits: 1, total: 2 },
    });
    // Keyword search never ran on the translated query: no tally rather than a misleading one.
    expect(summarise([result("xl-01", { keyword: at(1) })]).keyword?.crossLingualTranslated).toBe(
      null,
    );
  });

  test("paraphrase Questions are tallied apart, out of the gating counts and the bar", () => {
    const paraphrase = { paraphrase: true };
    const results = [
      ...["en-01", "en-02", "en-03", "en-04", "en-05", "zh-01", "zh-02", "zh-03", "zh-04"].map(
        (id) => result(id, { hybrid: at(1) }),
      ),
      result("para-en-01", { hybrid: at(null) }, paraphrase),
      result("para-en-02", { hybrid: at(7) }, paraphrase),
      result("para-zh-01", { hybrid: at(4) }, { ...paraphrase, language: "zh" }),
    ];

    const hybrid = summarise(results).hybrid;

    expect(hybrid).toMatchObject({
      en: { hits: 5, total: 5 },
      zh: { hits: 4, total: 4 },
      core: { hits: 9, total: 9 },
      paraphrase: {
        en: { hits: 0, total: 2 },
        zh: { hits: 1, total: 1 },
        all: { hits: 1, total: 3 },
      },
    });
  });
});

describe("What the reranked modes rerank", () => {
  const passage = (id: string): PassageSearchResult => ({
    passageId: id,
    documentId: "doc-1",
    documentName: "Tides",
    pageFrom: 1,
    pageTo: 1,
    position: 0,
    text: id,
  });

  test("keyword search's top 10 and vector search's top 10, each Passage once, as the search Tool hands them", async () => {
    const asked: string[] = [];
    const ranked = (prefix: string) =>
      Array.from({ length: 12 }, (_, index) => passage(`${prefix}${index}`));
    const core = {
      searchPassages: async (_query: string, options: { mode: string; limit: number }) => {
        asked.push(`${options.mode} ${options.limit}`);
        // Both lists share k0 and k1; vector search adds 8 of its own in its top 10.
        return options.mode === "keyword"
          ? ranked("k").slice(0, options.limit)
          : [passage("k1"), passage("k0"), ...ranked("v")].slice(0, options.limit);
      },
    } as unknown as Core;

    const candidates = await rerankCandidates(core, "tides");

    expect(asked.sort()).toEqual(["keyword 10", "vector 10"]);
    expect(candidates.map((each) => each.passageId)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `k${index}`),
      ...Array.from({ length: 8 }, (_, index) => `v${index}`),
    ]);
  });

  test("the report counts candidates per reranked search, the translated queries' too, and how often they held the expected Passage", () => {
    const result = (
      hybrid?: CandidateRecord,
      extra: Partial<QuestionResult> = {},
    ): QuestionResult => ({
      id: "x",
      language: "en",
      crossLingual: false,
      question: "x",
      modes: {},
      ...(hybrid && { candidates: { hybrid } }),
      ...extra,
    });

    expect(candidateCounts([result()])).toBeNull();
    expect(
      candidateCounts([
        result({ question: 12, reached: 3 }),
        result({ question: 20, translated: 16, reached: null }, { crossLingual: true }),
        result({ question: 18, reached: 18 }, { paraphrase: true }),
        result(),
      ]),
    ).toEqual({
      search: "hybrid",
      searches: 4,
      mean: 16.5,
      min: 12,
      max: 20,
      reached: { gating: { hits: 1, total: 1 }, paraphrase: { hits: 1, total: 1 } },
    });
    // Keyword + rerank's counts are its own.
    expect(candidateCounts([result({ question: 12, reached: null })], "keyword")).toBeNull();
  });

  test("the search Tool's order reranks keyword search's top 20 alone, with no vector search, as the Tool does with embeddings off", async () => {
    const asked: string[] = [];
    const core = {
      searchPassages: async (_query: string, options: { mode: string; limit: number }) => {
        asked.push(`${options.mode} ${options.limit}`);
        return Array.from({ length: options.limit }, (_, index) => passage(`k${index}`));
      },
    } as unknown as Core;

    const candidates = await keywordRerankCandidates(core, "tides");

    expect(SEARCH_TOOL_PARAMETERS.keywordRerankCandidates).toBe(20);
    expect(asked).toEqual(["keyword 20"]);
    expect(candidates.map((each) => each.passageId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `k${index}`),
    );
    const tool = await coreSource(core, GATING_SEARCH)?.("tides", {} as EvalQuestion);
    expect(tool?.candidates).toHaveLength(20);
  });

  test("keyword top 20 + rerank, the gate before, reranks keyword search's candidates and records their counts apart", async () => {
    const asked: string[] = [];
    // Keyword search finds 14 Passages; the expected one is its last.
    const keyword = Array.from({ length: 14 }, (_, index) => ({
      ...passage(`k${index}`),
      text: index === 13 ? "Spring tides happen at full moon." : `k${index}`,
    }));
    const core = {
      searchPassages: async (query: string, options: { mode: string; limit: number }) => {
        asked.push(`${query}: ${options.mode} ${options.limit}`);
        return options.mode === "keyword" ? keyword.slice(0, options.limit) : [];
      },
    } as unknown as Core;
    const reversing = (mode: string): OpenReranker => ({
      mode,
      rerank: async (_query, passages) => [...passages].reverse(),
      info: () => ({}) as RerankerInfo,
      close: () => {},
    });
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
    const ids = new Map([["tides", "doc-1"]]);

    const found = await runReranked(
      core,
      [question],
      ids,
      reversing("keyword-rerank:fake"),
      results,
    );

    expect(asked).toEqual(["大潮什么时候出现？: keyword 20", "When are spring tides?: keyword 20"]);
    expect(results[0]?.modes["keyword-rerank:fake"]).toMatchObject({ hit: true, rank: 1 });
    expect(results[0]?.translated?.["keyword-rerank:fake"]).toMatchObject({ hit: true, rank: 1 });
    // The expected Passage was the 14th candidate, before the reranker put it first.
    expect(results[0]?.candidates).toEqual({
      keyword: { question: 14, translated: 14, reached: 14 },
    });
    expect(found.queries).toBe(2);
    expect(candidateCounts(results, "keyword")).toEqual({
      search: "keyword",
      searches: 2,
      mean: 14,
      min: 14,
      max: 14,
      reached: { gating: { hits: 0, total: 0 }, paraphrase: { hits: 0, total: 0 } },
    });
    expect(summarise(results)["keyword-rerank:fake"]?.crossLingualTranslated).toEqual({
      hits: 1,
      total: 1,
    });
  });
});

describe("The search Tool's score", () => {
  const found = (id: string, text: string): PassageSearchResult => ({
    passageId: id,
    documentId: "doc-1",
    documentName: "Tides",
    pageFrom: 1,
    pageTo: 1,
    position: 0,
    text,
  });
  const question: EvalQuestion = {
    id: "xl-01",
    language: "zh",
    crossLingual: true,
    question: "大潮什么时候出现？",
    translatedQuery: "When are spring tides?",
    expected: { document: "tides", pages: [1, 1], quote: "Spring tides happen at full moon." },
  };

  test("is a hit when a Passage the Tool handed the model holds the expected one, for the Question or its translation", () => {
    const own = scoreHanded([found("c", "Nothing about it.")], question.expected, "doc-1");
    const translated = scoreHanded(
      [found("a", "Neap tides."), found("b", "Spring tides happen at full moon.")],
      question.expected,
      "doc-1",
    );
    const results: QuestionResult[] = [
      {
        id: "xl-01",
        language: "zh",
        crossLingual: true,
        question: question.question,
        modes: { [TOOL_MODE]: own },
        translated: { [TOOL_MODE]: translated },
      },
    ];

    expect(own).toMatchObject({ hit: false, rank: null });
    expect(translated).toMatchObject({ hit: true, rank: 2 });
    expect(translated.top).toHaveLength(2);
    expect(summarise(results)[TOOL_MODE]?.crossLingualTranslated).toEqual({ hits: 1, total: 1 });
  });
});

describe("The reranked modes", () => {
  test("keyword top 20 + rerank with the built-in model is the search Tool's order, reported beside its score; hybrid + rerank, as with embeddings on, and keyword top 60, the gate before, are reported", () => {
    expect(GATING_MODE).toBe(`keyword-rerank:${BUILT_IN_RERANKING_MODEL.id}`);
    expect(GATING_LABEL).toBe(`keyword top 20 + ${BUILT_IN_RERANKING_MODEL.name}`);
    expect(HYBRID_RERANK_MODE).toBe(`rerank:${BUILT_IN_RERANKING_MODEL.id}`);
    expect(HYBRID_RERANK_LABEL).toBe(`hybrid + ${BUILT_IN_RERANKING_MODEL.name}`);
    expect(rerankMode(BUILT_IN_RERANKING_MODEL, "keyword")).toBe(GATING_MODE);
    expect(rerankMode(BUILT_IN_RERANKING_MODEL)).toBe(HYBRID_RERANK_MODE);
    expect([GATING_MODE, HYBRID_RERANK_MODE, "hybrid"].map(rerankedSearchOf)).toEqual([
      "keyword",
      "hybrid",
      null,
    ]);
    // Every reranking model runs the gate's search and hybrid's; the other seven, the built-in one.
    expect(RERANKED_SEARCHES).toEqual(["keyword", "hybrid"]);
    expect(OTHER_SEARCHES).toEqual([
      "keyword-40",
      "keyword-60",
      "feedback",
      "rewrites",
      "sub-questions",
      "small-to-big",
      "document-first",
    ]);
    expect(rerankedLabel("keyword", BUILT_IN_RERANKING_MODEL.name)).toBe(
      `keyword top 20 + ${BUILT_IN_RERANKING_MODEL.name}`,
    );
  });
});

describe("The retrieval gate", () => {
  const tally = (hits: number, total = 20) => ({ hits, total });
  /** A mode's summary over today's set: 20 + 20 gating Questions, 10 cross-lingual, 8 + 7 paraphrase. */
  const summary = (en: number, zh: number, [paraphraseEn, paraphraseZh] = [0, 0]) => ({
    en: tally(en),
    zh: tally(zh),
    core: tally(en + zh, 40),
    crossLingual: tally(2, 10),
    crossLingualTranslated: tally(7, 10),
    paraphrase: {
      en: tally(paraphraseEn, 8),
      zh: tally(paraphraseZh, 7),
      all: tally(paraphraseEn + paraphraseZh, 15),
    },
  });

  test("is the search Tool's score: 15 of 20 English and 20 of 20 Chinese gating Questions", () => {
    expect(retrievalFailures(summary(15, 20))).toEqual([]);
    expect(retrievalFailures(summary(16, 20))).toEqual([]);
    expect(retrievalFailures(summary(14, 20))).toEqual([
      `Retrieval (${TOOL_LABEL}), overall: 34 of 40, needs 35.`,
      `Retrieval (${TOOL_LABEL}), English: 14 of 20, needs 15.`,
    ]);
    expect(retrievalFailures(summary(17, 19))).toEqual([
      `Retrieval (${TOOL_LABEL}), Chinese: 19 of 20, needs 20.`,
    ]);
    expect(retrievalFailures(undefined)).toEqual([`No ${TOOL_LABEL} results.`]);
  });

  test("the summary marks the gating row, and reports plain hybrid search next to it", () => {
    const report = {
      result: "pass",
      failures: [],
      run: {
        startedAt: "2026-10-09T08:00:00.000Z",
        seconds: 60,
        commit: "abc1234",
        node: "v25",
        platform: "darwin arm64",
        cpu: "M2",
      },
      evaluationSet: {
        source: "eval/retrieval/questions.json",
        hitRule: "",
        questions: { gating: { en: 20, zh: 20 }, crossLingual: 10, paraphrase: 0 },
      },
      documents: [],
      retrieval: {
        topK: 5,
        gatingMode: GATING_MODE,
        runs: [
          {
            embedding: "multilingual-e5-small (built-in)",
            gating: true,
            passageCount: 1199,
            processingSeconds: 60,
            questions: [],
            summary: { hybrid: summary(13, 19), [TOOL_MODE]: summary(15, 20) },
          },
        ],
      },
      citations: { skipped: "no chat model" },
    } satisfies EvalReport;

    const lines = terminalSummary(report, "/repo/eval/results/x", "/repo").split("\n");

    expect(lines.find((line) => line.includes("(gating)"))).toContain(
      `${TOOL_LABEL} (gating) English 15/20`,
    );
    expect(lines.find((line) => line.trim().startsWith("hybrid "))).toContain("English 13/20");
  });

  test("hybrid + rerank is reported next to the gating row, never gating, and paraphrase Questions in a column of their own", async () => {
    const reranker = (mode: string): RerankerInfo => ({
      mode,
      name: BUILT_IN_RERANKING_MODEL.name,
      licence: "Apache-2.0",
      downloadBytes: 136e6,
      loadSeconds: 1.5,
      latency: { queries: 74, mean: 700, median: 690, p95: 900, max: 950 },
      candidates: { queries: 75, mean: 3, median: 2, p95: 6, max: 9 },
    });
    const reached = (gating: number, paraphrase: number) => ({
      gating: { hits: gating, total: 40 },
      paraphrase: { hits: paraphrase, total: 15 },
    });
    const run = {
      embedding: "multilingual-e5-small (built-in)",
      gating: true,
      passageCount: 1199,
      processingSeconds: 60,
      questions: [],
      summary: {
        hybrid: summary(13, 19, [5, 4]),
        // Under the old bar in English: reported, and the run still passes.
        [GATING_MODE]: summary(15, 20, [6, 5]),
        [HYBRID_RERANK_MODE]: summary(14, 20, [4, 3]),
        [TOOL_MODE]: summary(15, 20, [6, 5]),
      },
      rerankers: [reranker(GATING_MODE), reranker(HYBRID_RERANK_MODE)],
      candidates: [
        {
          search: "keyword",
          searches: 75,
          mean: 19.5,
          min: 9,
          max: 20,
          reached: reached(39, 13),
        },
        { search: "hybrid", searches: 75, mean: 16, min: 12, max: 20, reached: reached(38, 13) },
      ],
    } satisfies RetrievalRun;
    const failures = retrievalFailures(run.summary[TOOL_MODE]);
    const report = {
      result: failures.length === 0 ? "pass" : "fail",
      failures,
      run: {
        startedAt: "2026-10-10T08:00:00.000Z",
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
      retrieval: { topK: 5, gatingMode: TOOL_MODE, runs: [run] },
      citations: { skipped: "no chat model" },
    } satisfies EvalReport;

    expect(report.result).toBe("pass");
    const lines = terminalSummary(report, "/repo/eval/results/x", "/repo").split("\n");
    expect(lines.find((line) => line.trim().startsWith("hybrid + "))).toMatch(
      /English 14\/20 .*; paraphrase 7\/15$/,
    );
    expect(lines.some((line) => line.includes("keyword top 20 + rerank search"))).toBe(true);
    expect(lines.some((line) => line.includes("hybrid + rerank search"))).toBe(true);

    const results = await mkdtemp(join(tmpdir(), "retrieval-report-"));
    try {
      const markdown = (
        await readFile(join(await writeReports(report, results, "/"), "report.md"), "utf8")
      ).split("\n");
      const model = BUILT_IN_RERANKING_MODEL.name;
      expect(markdown).toContain(
        "- Evaluation set: `eval/retrieval/questions.json`, 20 English and 20 Chinese gating Questions, 10 cross-lingual, 15 paraphrase",
      );
      expect(markdown).toContain(
        `| multilingual-e5-small (built-in) | **${TOOL_LABEL} (gating)** | **15/20** | **20/20** | **35/40** | 2/10 | 7/10 | 11/15 (6 + 5) |`,
      );
      expect(markdown).toContain(
        `| multilingual-e5-small (built-in) | keyword top 20 + ${model} | 15/20 | 20/20 | 35/40 | 2/10 | 7/10 | 11/15 (6 + 5) |`,
      );
      expect(markdown).toContain(
        `| multilingual-e5-small (built-in) | hybrid + ${model} | 14/20 | 20/20 | 34/40 | 2/10 | 7/10 | 7/15 (4 + 3) |`,
      );
      expect(markdown).toContain(
        "Candidates per keyword top 20 + rerank search (keyword search's top 20, no vector search, what the search Tool hands its reranker with embeddings off): 19.5 on average, from 9 to 20, over 75 searches; the expected Passage among them for 39/40 gating and 13/15 paraphrase Questions.",
      );
      expect(markdown).toContain(
        "Candidates per hybrid + rerank search (keyword search's top 10 and vector search's top 10, each Passage once): 16.0 on average, from 12 to 20, over 75 searches; the expected Passage among them for 38/40 gating and 13/15 paraphrase Questions.",
      );
      expect(markdown.filter((line) => line.includes("| Apache-2.0 | 136 MB | 3 ms"))).toEqual([
        `| keyword top 20 + ${model} | Apache-2.0 | 136 MB | 3 ms | 700 ms | 690 ms | 900 ms | 950 ms | 1.5 s |`,
        `| hybrid + ${model} | Apache-2.0 | 136 MB | 3 ms | 700 ms | 690 ms | 900 ms | 950 ms | 1.5 s |`,
      ]);
      // The other searches didn't run: no section for them.
      expect(markdown.some((line) => line.includes("Other ways to find the candidates"))).toBe(
        false,
      );
    } finally {
      await rm(results, { recursive: true, force: true });
    }
  });
});

describe("The evaluation's settings for reranking", () => {
  test("INCARNAMIND_EVAL_RERANK names candidates, or all of them; none by default", () => {
    expect(readConfig("/repo", {}).rerank).toEqual([]);
    expect(
      readConfig("/repo", { INCARNAMIND_EVAL_RERANK: "all" }).rerank.map((each) => each.id),
    ).toEqual(RERANKING_MODEL_CANDIDATES.map((each) => each.id));
    expect(
      readConfig("/repo", { INCARNAMIND_EVAL_RERANK: "bge-m3, mmarco-minilm" }).rerank.map(
        (each) => each.id,
      ),
    ).toEqual(["bge-m3", "mmarco-minilm"]);
    expect(() => readConfig("/repo", { INCARNAMIND_EVAL_RERANK: "jina-v2" })).toThrow(/jina-v2/);
  });

  test("every cross-lingual Question has a translated query, and only those do", () => {
    const set = loadEvaluationSet(fileURLToPath(new URL("../..", import.meta.url)));
    for (const question of set.questions) {
      expect(question.translatedQuery !== undefined, question.id).toBe(question.crossLingual);
    }
  });
});

describe("The evaluation's settings for a short check", () => {
  test("INCARNAMIND_EVAL_QUESTIONS names Questions by id, each once; all of them by default", () => {
    expect(readConfig("/repo", {}).questionIds).toBeNull();
    expect(
      readConfig("/repo", { INCARNAMIND_EVAL_QUESTIONS: " en-07, zh-02,,en-07 " }).questionIds,
    ).toEqual(["en-07", "zh-02"]);
    expect(() => readConfig("/repo", { INCARNAMIND_EVAL_QUESTIONS: ", ," })).toThrow(
      /Question ids separated by commas/,
    );
  });

  test("INCARNAMIND_EVAL_FORMATS=off skips the every-format set, which runs by default", () => {
    expect(readConfig("/repo", {}).formats).toBe(true);
    expect(readConfig("/repo", { INCARNAMIND_EVAL_FORMATS: "on" }).formats).toBe(true);
    expect(readConfig("/repo", { INCARNAMIND_EVAL_FORMATS: "off" }).formats).toBe(false);
    expect(() => readConfig("/repo", { INCARNAMIND_EVAL_FORMATS: "no" })).toThrow(/"on" or "off"/);
  });

  test("INCARNAMIND_EVAL_LOCAL_QUERY_MODES=on runs the chat-model modes with a local model, which is off by default", () => {
    expect(readConfig("/repo", {}).localQueryModes).toBe(false);
    expect(readConfig("/repo", { INCARNAMIND_EVAL_LOCAL_QUERY_MODES: "off" }).localQueryModes).toBe(
      false,
    );
    expect(readConfig("/repo", { INCARNAMIND_EVAL_LOCAL_QUERY_MODES: "on" }).localQueryModes).toBe(
      true,
    );
    expect(() => readConfig("/repo", { INCARNAMIND_EVAL_LOCAL_QUERY_MODES: "1" })).toThrow(
      /"on" or "off"/,
    );
  });

  test("the Questions named are asked in the set's order; an id in no set asked from is refused", () => {
    const set = loadEvaluationSet(fileURLToPath(new URL("../..", import.meta.url)));
    expect(questionsToAsk(set.questions, null)).toHaveLength(set.questions.length);
    expect(questionsToAsk(set.questions, ["zh-02", "en-07"]).map((each) => each.id)).toEqual([
      "en-07",
      "zh-02",
    ]);
    expect(() => checkQuestionIds(["en-07", "zh-02"], [set.questions])).not.toThrow();
    expect(() => checkQuestionIds(["en-07", "en-99", "docx-en-01"], [set.questions])).toThrow(
      /en-99, docx-en-01/,
    );
  });
});

describe("The evaluation's settings for a model in Ollama", () => {
  test("an Ollama run may set num_ctx and the citing mode; no other kind may", () => {
    const ollama = {
      INCARNAMIND_EVAL_CHAT_KIND: "ollama",
      INCARNAMIND_EVAL_CHAT_MODEL: "qwen3.5:4b",
    };
    expect(readConfig("/repo", ollama).chat).toMatchObject({ numCtx: null, citing: null });
    expect(
      readConfig("/repo", {
        ...ollama,
        INCARNAMIND_EVAL_CHAT_NUM_CTX: "8192",
        INCARNAMIND_EVAL_CHAT_CITING: "structured-output",
      }).chat,
    ).toMatchObject({ numCtx: 8192, citing: "structured-output" });
    expect(() => readConfig("/repo", { ...ollama, INCARNAMIND_EVAL_CHAT_CITING: "json" })).toThrow(
      /json/,
    );
    expect(() =>
      readConfig("/repo", {
        INCARNAMIND_EVAL_CHAT_KIND: "anthropic",
        INCARNAMIND_EVAL_CHAT_MODEL: "a-model",
        INCARNAMIND_EVAL_CHAT_KEY: "a-key",
        INCARNAMIND_EVAL_CHAT_NUM_CTX: "8192",
      }),
    ).toThrow(/only apply to "ollama"/);
  });

  test("an Ollama run's window and citing mode replace the app's choice", async () => {
    const profile: OllamaModelProfile = {
      digest: "d1",
      capabilities: ["completion", "tools"],
      contextLength: 262_144,
      parameters: 9_653_104_368,
      support: "tools",
      chat: true,
      remote: false,
      settings: { numCtx: 16_384, outputTokens: 4_096, keepAlive: "30m", think: false },
    };
    const app: OllamaModels = {
      describe: async () => profile,
      loaded: async () => true,
      running: async () => true,
    };
    const chat = {
      kind: "ollama" as const,
      modelId: "qwen3.5:4b",
      apiKey: null,
      baseUrl: null,
      endpoint: null,
    };
    expect(evalOllamaModels({ ...chat, numCtx: null, citing: null }, app)).toBeNull();
    const models = evalOllamaModels({ ...chat, numCtx: 8_192, citing: "structured-output" }, app);
    expect(await models?.describe("http://127.0.0.1:11434", "qwen3.5:4b")).toEqual({
      ...profile,
      support: "structured-output",
      settings: { ...profile.settings, numCtx: 8_192, outputTokens: 2_048 },
    });
  });
});

describe("Paraphrase Questions", () => {
  /** Reads an evaluation set of one Document and these Questions, written to a temporary folder. */
  async function setOf(questions: unknown[]) {
    const root = await mkdtemp(join(tmpdir(), "evaluation-set-"));
    try {
      await writeFile(join(root, "tides.pdf"), "");
      await writeFile(
        join(root, "set.json"),
        JSON.stringify({ documents: { tides: "tides.pdf" }, questions }),
      );
      return loadEvaluationSet(root, "set.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const asked = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    language: "en",
    question: "When is the sea highest?",
    expected: { document: "tides", pages: [1, 1], quote: "Spring tides" },
    ...extra,
  });

  test("are marked with paraphrase: true, and only true is kept", async () => {
    const set = await setOf([
      asked("en-01"),
      asked("para-en-01", { paraphrase: true }),
      asked("en-02", { paraphrase: false }),
    ]);

    expect(set.questions.map((question) => [question.id, question.paraphrase])).toEqual([
      ["en-01", undefined],
      ["para-en-01", true],
      ["en-02", undefined],
    ]);
    expect(set.questions.map(isGating)).toEqual([true, false, true]);
  });

  test("a flag that isn't true or false, or a cross-lingual paraphrase, is refused", async () => {
    await expect(setOf([asked("para-en-01", { paraphrase: "yes" })])).rejects.toThrow(
      "para-en-01: paraphrase must be true or false.",
    );
    await expect(
      setOf([
        asked("para-xl-01", {
          paraphrase: true,
          crossLingual: true,
          translatedQuery: "大潮什么时候出现？",
        }),
      ]),
    ).rejects.toThrow(/para-xl-01: a paraphrase question isn't cross-lingual/);
  });

  test("today's set has 8 English and 7 Chinese ones, and its gating Questions are unchanged", () => {
    const set = loadEvaluationSet(fileURLToPath(new URL("../..", import.meta.url)));
    const paraphrase = set.questions.filter((question) => question.paraphrase);
    const gating = set.questions.filter(isGating);

    expect(paraphrase.filter((question) => question.language === "en")).toHaveLength(8);
    expect(paraphrase.filter((question) => question.language === "zh")).toHaveLength(7);
    expect(paraphrase.every((question) => !question.crossLingual)).toBe(true);
    expect(gating.filter((question) => question.language === "en")).toHaveLength(20);
    expect(gating.filter((question) => question.language === "zh")).toHaveLength(20);
    expect(set.questions.filter((question) => question.crossLingual)).toHaveLength(10);
  });
});

const cited = (outcome: CitationOutcome, sentence = "A claim."): CitationRecord => ({
  sentence,
  quote: "a quote",
  documentName: "Tides",
  pageFrom: 1,
  pageTo: 1,
  check: outcome === "found" ? "found" : "not-found",
  checkReason: outcome === "found" ? null : "quote-not-on-pages",
  outcome,
  passagePages: [1, 1],
  quoteOn: outcome === "not-in-document" ? null : [1, 1],
});

describe("A language's Citation figures", () => {
  test("shares are of all its Citations, coverage of all its sentences", () => {
    const summary = summariseGroup([
      record({
        citations: [cited("found"), cited("found"), cited("false-not-found")],
        sentences: [
          { text: "A claim.", cited: true },
          { text: "Another.", cited: false },
        ],
        droppedMarkers: 1,
      }),
      record({
        status: "timed-out",
        citationSupport: null,
        citations: [cited("found")],
        sentences: [{ text: "A third.", cited: true }],
        droppedRecords: 2,
        seconds: 4,
      }),
      record({ sentences: [{ text: "Uncited.", cited: false }], seconds: 2 }),
    ]);
    expect(summary).toMatchObject({
      answers: 3,
      failedAnswers: 1,
      citedAnswers: 2,
      citedAnswerShare: 2 / 3,
      medianSeconds: 2,
      citations: 4,
      foundShare: 0.75,
      falseNotFoundShare: 0.25,
      sentences: 4,
      citedSentences: 2,
      coverage: 2 / 4,
      droppedMarkers: 1,
      droppedRecords: 2,
      citationSupport: { tools: 2, unknown: 1 },
    });
    expect(summariseGroup([])).toMatchObject({
      foundShare: null,
      coverage: null,
      citedAnswerShare: null,
      medianSeconds: null,
    });
  });

  test("the prompt cache: the share of the input it served, over the Answers that report usage", () => {
    const usage = (input: number, cached: number) => ({
      inputTokens: input,
      outputTokens: 10,
      cachedInputTokens: cached,
      cacheWriteTokens: 0,
    });
    const answers = [
      record({ usage: usage(1_000, 0) }),
      record({ usage: usage(1_000, 900) }),
      // A model on this computer reports none, and a report from before has none.
      record({ usage: usage(0, 0) }),
      record({}),
    ];

    expect(summariseGroup(answers).usage).toEqual({
      inputTokens: 2_000,
      outputTokens: 30,
      cachedInputTokens: 900,
      cacheWriteTokens: 0,
      cacheHitRate: 0.45,
    });
    expect(summariseGroup([record({})]).usage.cacheHitRate).toBeNull();
  });

  test("the requests for exact quotes: how many Answers made one, what they recovered, and the time they added", () => {
    const answers = [
      record({ quoteRetry: { records: 2, recovered: 1, durationMs: 3_000 } }),
      record({ quoteRetry: { records: 1, recovered: 1, durationMs: 1_000 } }),
      record({ quoteRetry: { records: 1, recovered: 0, durationMs: 2_000 } }),
      // None made, or none recorded (a report from before them).
      record({ quoteRetry: null }),
      record({}),
    ];

    expect(summariseGroup(answers).quoteRetries).toEqual({
      answers: 3,
      records: 4,
      recovered: 2,
      medianSeconds: 2,
      maxSeconds: 3,
      secondsPerAnswer: 6 / 5,
    });
    expect(quoteRetryLine(summariseQuoteRetries(answers))).toBe(
      "3 Answers, 2 of 4 records recovered, 2.0 s median, 3.0 s most, 1.2 s per Answer",
    );
    expect(summariseQuoteRetries([record({})])).toEqual({
      answers: 0,
      records: 0,
      recovered: 0,
      medianSeconds: null,
      maxSeconds: null,
      secondsPerAnswer: 0,
    });
    expect(quoteRetryLine(summariseQuoteRetries([]))).toBe("none");
  });
});

describe("The reviewer sheet", () => {
  test("lists found quotes only, quoting cells that need it, readable as UTF-8", () => {
    const answer = record({
      questionId: "zh-01",
      language: "zh",
      question: "可持续发展目标一共包含多少项具体目标？",
      citations: [
        {
          ...cited("found", 'It has 169 "targets", in all.'),
          quote: "共有 169 项",
          documentName: "维基百科-可持续发展目标",
          pageTo: 2,
        },
        cited("not-in-document"),
      ],
    });
    const sheet = reviewerSheet({ answers: [answer] } as CitationRun);

    expect(sheet.startsWith("\uFEFF")).toBe(true);
    expect(sheet.slice(1).split("\r\n")).toEqual([
      "question_id,language,round,question,answer_sentence,quote,document,page,supports (y/n),answer (the rule found no decline),decline missed by the rule (y/n),note",
      'zh-01,zh,1,可持续发展目标一共包含多少项具体目标？,"It has 169 ""targets"", in all.",共有 169 项,维基百科-可持续发展目标,1–2,,,,',
      "",
    ]);
  });
});

describe("Why Citations aren't found, in report.md", () => {
  test("lists each Citation not found and each Answer without one; a short run says it doesn't gate", async () => {
    const answers = [
      record({
        usage: {
          inputTokens: 2_000,
          outputTokens: 50,
          cachedInputTokens: 1_500,
          cacheWriteTokens: 100,
        },
        citations: [
          cited("found"),
          {
            ...cited("wrong-page"),
            quote: "a quote | with a pipe",
            pageFrom: 7,
            pageTo: 7,
            passagePages: [7, 8],
            quoteOn: [8, 8],
          },
        ],
      }),
      record({
        questionId: "zh-02",
        language: "zh",
        citationSupport: "structured-output",
        droppedMarkers: 2,
        searches: ["交通事故"],
        sentences: [{ text: "文档没有提到。", cited: false }],
        quoteRetry: { records: 2, recovered: 1, durationMs: 2_500 },
      }),
    ];
    const citations: CitationRun = {
      model: "ollama/qwen3.5:4b",
      service: null,
      gating: false,
      subset: ["en-01", "zh-02"],
      overrides: ["num_ctx 8192"],
      minCitations: 30,
      rounds: 1,
      answers,
      summary: {
        en: summariseGroup([answers[0] as AnswerRecord]),
        zh: summariseGroup([answers[1] as AnswerRecord]),
        crossLingual: summariseGroup([]),
        paraphrase: summariseGroup([]),
      },
      failures: [],
    };
    const report = {
      result: "pass",
      failures: [],
      run: {
        startedAt: "2026-10-10T08:00:00.000Z",
        seconds: 1,
        commit: "",
        node: "",
        platform: "",
        cpu: "",
      },
      evaluationSet: {
        source: "",
        hitRule: "",
        questions: { gating: { en: 1, zh: 1 }, crossLingual: 0, paraphrase: 0 },
      },
      documents: [],
      retrieval: {
        topK: 5,
        gatingMode: GATING_MODE,
        runs: [
          {
            embedding: "multilingual-e5-small (built-in)",
            gating: true,
            passageCount: 1,
            processingSeconds: 1,
            questions: [],
            summary: summarise([]),
          },
        ],
      },
      citations,
      formats: { skipped: "INCARNAMIND_EVAL_FORMATS is off." },
    } satisfies EvalReport;
    const results = await mkdtemp(join(tmpdir(), "why-report-"));
    try {
      const dir = await writeReports(report, results, "/");
      const markdown = (await readFile(join(dir, "report.md"), "utf8")).split("\n");
      expect(markdown.join("\n")).toContain(
        "Only 2 of the Questions were asked (INCARNAMIND_EVAL_QUESTIONS: en-01, zh-02), once each: a short check, reported, never gating.",
      );
      expect(markdown).toContain(
        '| en-01 | 1 | "Not found": quote on other pages | quote-not-on-pages | Tides | p. 7 | pp. 7–8 | p. 8 | a quote \\| with a pipe |',
      );
      expect(markdown).toContain(
        "| zh-02 | 1 | done | structured-output | 2 | 0 |  | 交通事故 | 文档没有提到。 |",
      );
      expect(markdown).toContain("Skipped: INCARNAMIND_EVAL_FORMATS is off.");
      // How much of the input the provider's prompt cache served (#343), per group.
      expect(markdown).toContain(
        "| Prompt cache hit rate (cached input tokens) | 75.0% (1500/2000) | – | – | – | reported |",
      );
      expect(markdown).toContain(
        "| Tokens written to the prompt cache | 100 | 0 | 0 | 0 | reported |",
      );
      // What the requests for exact quotes cost and gave, per group.
      expect(markdown).toContain(
        "| Answers that asked again for quotes | 0/1 | 1/1 | 0/0 | 0/0 | reported |",
      );
      expect(markdown).toContain(
        "| Records asked again: recovered | 0/0 | 1/2 | 0/0 | 0/0 | reported |",
      );
      expect(markdown).toContain(
        "| Time the request added: median, most | – | 2.5 s, 2.5 s | – | – | reported |",
      );
      expect(markdown).toContain(
        "| Time the requests added per Answer | 0.0 s | 2.5 s | – | – | reported |",
      );
      const summary = terminalSummary(report, "/repo/eval/results/x", "/repo");
      expect(summary).toContain(
        "Citation quality, ollama/qwen3.5:4b (2 Questions only, not gating)",
      );
      expect(summary).toContain(
        "prompt cache: 75.0% of 2000 input tokens read from it, 100 written",
      );
      expect(summary).toContain(
        "quotes asked again: 1 Answer, 1 of 2 records recovered, 2.5 s median, 2.5 s most, 2.5 s per Answer",
      );
      expect(summary).toContain("Every format: skipped. INCARNAMIND_EVAL_FORMATS is off.");
    } finally {
      await rm(results, { recursive: true, force: true });
    }
  });
});
