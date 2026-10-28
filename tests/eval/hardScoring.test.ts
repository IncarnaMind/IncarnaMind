/**
 * How the hard tier (eval/hard/README.md) scores and reports: a hit needs
 * every Passage a Question needs in the top 5 (of either search, for a
 * cross-lingual one), tallies per difficulty, domain and language, the
 * report's tables, and the Citation figures per difficulty. The run itself
 * needs the models; its scoring doesn't.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { asEvalQuestion, summariseDifficulty } from "../../eval/hard/lib/citations";
import { embedEveryPassage } from "../../eval/hard/lib/indexing";
import { BM25_SQL, timeKeywordSearch, timingOf } from "../../eval/hard/lib/keywordTiming";
import type { HardDocument } from "../../eval/hard/lib/manifest";
import { type HardQuestion, textProblems } from "../../eval/hard/lib/questions";
import {
  type HardReport,
  hardSummary,
  markdownReport,
  modeLabels,
  ownQueryOnly,
  writeHardReports,
} from "../../eval/hard/lib/report";
import {
  type HardQuestionResult,
  KEYWORD_60_RERANK_MODE,
  modeResult,
  ranksOf,
  rerankAll,
  searchAll,
  searchable,
  summariseHard,
} from "../../eval/hard/lib/scoring";
import type { AnswerRecord, CitationRecord, CitationRun } from "../../eval/lib/citations";
import type { OpenReranker } from "../../eval/lib/rerank";
import { GATING_MODE, HYBRID_RERANK_MODE } from "../../eval/lib/retrieval";
import { DATABASE_FILE, type PassageSearchResult } from "../../src/core";
import { keywordQuery } from "../../src/core/documents/keywords";
import { DOCUMENT_NAME_WEIGHT } from "../../src/core/documents/search";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import { buildPdf } from "../helpers/pdf";

const passage = (documentId: string, page: number, text: string): PassageSearchResult =>
  ({
    passageId: `${documentId}-${page}-${text.length}`,
    documentId,
    documentName: documentId,
    pageFrom: page,
    pageTo: page,
    text,
  }) as PassageSearchResult;

const IDS = new Map([
  ["a", "doc-a"],
  ["b", "doc-b"],
]);

describe("Scoring the hard tier's searches", () => {
  const expected = [
    { document: "a", pages: [2, 2] as [number, number], quote: "first fact" },
    { document: "b", pages: [5, 5] as [number, number], quote: "second fact" },
  ];

  test("each Passage a Question needs has the rank of the first retrieved Passage that is it", () => {
    const found = [
      passage("doc-a", 1, "first fact, wrong page"),
      passage("doc-b", 5, "the second fact here"),
      passage("doc-a", 2, "the first fact here"),
    ];
    expect(ranksOf(found, expected, IDS)).toEqual([3, 2]);
    expect(ranksOf([passage("doc-a", 2, "nothing")], expected, IDS)).toEqual([null, null]);
  });

  test("a hit needs every Passage in the top 5; some of them is a partial find", () => {
    expect(modeResult([1, 4])).toMatchObject({ hit: true, partial: true });
    expect(modeResult([1, 7])).toMatchObject({ hit: false, partial: true });
    expect(modeResult([null, 9])).toMatchObject({ hit: false, partial: false });
  });

  test("a cross-lingual Question's Passage counts when either its own search or its translation finds it", () => {
    expect(modeResult([12], [3])).toEqual({
      hit: true,
      partial: true,
      ranks: [12],
      translatedRanks: [3],
    });
    expect(modeResult([null, 2], [4, null]).hit).toBe(true);
    expect(modeResult([null], [8]).hit).toBe(false);
  });

  test("unanswerable Questions aren't searched for", () => {
    const questions = [
      { id: "u", expected: [] },
      { id: "e", expected: expected.slice(0, 1) },
    ] as unknown as HardQuestion[];
    expect(searchable(questions).map((each) => each.id)).toEqual(["e"]);
  });
});

const result = (
  id: string,
  difficulty: HardQuestionResult["difficulty"],
  domain: HardQuestionResult["domain"],
  language: HardQuestionResult["language"],
  hits: Record<string, (number | null)[]>,
  translated?: Record<string, (number | null)[]>,
): HardQuestionResult => ({
  id,
  difficulty,
  domain,
  language,
  question: `${id}?`,
  modes: Object.fromEntries(
    Object.entries(hits).map(([mode, ranks]) => [mode, modeResult(ranks, translated?.[mode])]),
  ),
});

const RESULTS = [
  result("e1", "easy", "contracts", "en", {
    keyword: [1],
    hybrid: [2],
    [GATING_MODE]: [1],
  }),
  result("e2", "easy", "filings", "zh", { keyword: [9], hybrid: [3], [GATING_MODE]: [2] }),
  result("p1", "paraphrase", "filings", "en", {
    keyword: [null],
    hybrid: [4],
    [GATING_MODE]: [7],
  }),
  result("m1", "multi-page", "papers", "en", {
    keyword: [1, 8],
    hybrid: [1, 2],
    [GATING_MODE]: [1, 3],
  }),
  result(
    "x1",
    "cross-lingual",
    "reports",
    "zh",
    { keyword: [null], hybrid: [11], [GATING_MODE]: [null] },
    { keyword: [2], hybrid: [1], [GATING_MODE]: [1] },
  ),
];

describe("The hard tier's searches through a core", { timeout: 60_000 }, () => {
  test("searches each mode, reranks, and checks the Questions against the stored text", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    // The hard tier turns embeddings on, as `openLibrary` does: they are off by default.
    await turnOnEmbeddings(core);
    const paths = await Promise.all([
      writeSourceFile(
        sources,
        "Harbour Report 2025.pdf",
        buildPdf([
          { lines: ["Harbour traffic", "The harbour handled 4,200 container ships in 2025."] },
          { lines: ["Dredging", "Dredging deepened the main channel to fourteen metres."] },
        ]),
      ),
      writeSourceFile(
        sources,
        "Ferry Review.pdf",
        buildPdf([
          { lines: ["Ferries", "The night ferry to the islands carried 90,000 passengers."] },
        ]),
      ),
    ]);
    const [harbour, ferry] = await addAndProcess(core, paths);
    const ids = new Map([
      ["harbour", harbour?.id as string],
      ["ferry", ferry?.id as string],
    ]);
    const questions: HardQuestion[] = [
      {
        id: "easy",
        language: "en",
        domain: "reports",
        difficulty: "easy",
        question: "How deep was the main channel dredged?",
        expected: [
          {
            document: "harbour",
            pages: [2, 2],
            quote: "deepened the main channel to fourteen metres",
          },
        ],
      },
      {
        id: "cross",
        language: "zh",
        domain: "reports",
        difficulty: "cross-lingual",
        question: "夜间渡轮运送了多少乘客？",
        translatedQuery: "How many passengers did the night ferry carry?",
        expected: [{ document: "ferry", pages: [1, 1], quote: "carried 90,000 passengers" }],
      },
      {
        id: "none",
        language: "en",
        domain: "reports",
        difficulty: "unanswerable",
        question: "What did the 2030 report say?",
        expected: [],
      },
    ];
    const results = await searchAll(core, questions, ids);
    expect(results.map((each) => each.id)).toEqual(["easy", "cross"]);
    expect(Object.keys(results[0]?.modes ?? {})).toEqual(["keyword", "vector", "hybrid"]);
    expect(results[0]?.modes.keyword).toMatchObject({ hit: true, ranks: [1] });
    // Keyword search can't match the Chinese wording; its translation finds the Passage.
    expect(results[1]?.modes.keyword).toMatchObject({
      hit: true,
      ranks: [null],
      translatedRanks: [1],
    });

    // A reranker that puts keyword search's Passages in reverse order: the ranks follow its order.
    const reversing: OpenReranker = {
      mode: GATING_MODE,
      rerank: async (_query, passages) => [...passages].reverse(),
      info: () => ({
        mode: GATING_MODE,
        name: "reversing",
        licence: "",
        downloadBytes: 0,
        loadSeconds: 0,
        latency: { queries: 0, mean: 0, median: 0, p95: 0, max: 0 },
      }),
      close: () => {},
    };
    await rerankAll(core, questions, ids, reversing, results);
    const found = await core.searchPassages(questions[0]?.question as string, {
      mode: "keyword",
      limit: 20,
    });
    expect(results[0]?.modes[GATING_MODE]?.ranks).toEqual([found.length]);

    const stored = (key: string) => {
      const id = ids.get(key) ?? "";
      return {
        units: queryDatabase<{ page: number; kind: "page"; text: string }>(
          dataDir,
          "SELECT page, kind, text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL",
          [id],
        ),
        passages: queryDatabase<{ pageFrom: number; pageTo: number; text: string }>(
          dataDir,
          "SELECT page_from AS pageFrom, page_to AS pageTo, text FROM passages WHERE document_id = ? AND deleted_at IS NULL",
          [id],
        ),
      };
    };
    // Keyword search timed as the app runs it, and over the Passages alone: the same Passages.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const timing = timeKeywordSearch(
        db,
        ["How deep was the main channel dredged?", "the ferry passengers", "and the"],
        20,
      );
      // A query of stopwords only isn't searched, as in the app.
      expect(timing).toMatchObject({ passages: 2, limit: 20, reordered: 0 });
      expect(timing.app.queries).toBe(2);
      expect(timing.alone.queries).toBe(2);
      const match = keywordQuery("the ferry passengers") as string;
      const bm25 = db
        .all<{ seq: number }>(BM25_SQL, [
          match,
          DOCUMENT_NAME_WEIGHT,
          match,
          DOCUMENT_NAME_WEIGHT,
          20n,
        ])
        .map((row) => row.seq);
      const ids = queryDatabase<{ seq: number; id: string }>(
        dataDir,
        "SELECT seq, id FROM passages",
      );
      expect(bm25.map((seq) => ids.find((row) => row.seq === seq)?.id)).toEqual(
        (await core.searchPassages("the ferry passengers", { mode: "keyword", limit: 20 })).map(
          (each) => each.passageId,
        ),
      );
    } finally {
      db.close();
    }

    const library = { documents: [] };
    expect(questions.map((each) => textProblems(each, stored, library))).toEqual([[], [], []]);
    const wrongPage: HardQuestion = {
      ...(questions[0] as HardQuestion),
      expected: [{ document: "harbour", pages: [1, 1], quote: "fourteen metres" }],
    };
    expect(textProblems(wrongPage, stored, library)).toEqual([
      "harbour: the quote isn't on Unit 1.",
    ]);
  });
});

describe("The hard tier's two indexing passes", { timeout: 60_000 }, () => {
  test("Documents are ready with embeddings off; turning them on then embeds every Passage", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    const path = await writeSourceFile(
      sources,
      "Tide Tables.pdf",
      buildPdf([
        { lines: ["Spring tides", "Spring tides come at new moon and at full moon."] },
        { lines: ["Neap tides", "Neap tides come at the quarter moons."] },
      ]),
    );
    // First pass: embeddings off, the default, so the Document is ready on its keyword index alone.
    const [document] = await addAndProcess(core, [path]);
    expect(document?.status).toBe("ready");
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const unembedded = () =>
        db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM passages WHERE deleted_at IS NULL AND embedding IS NULL",
        )?.count ?? 0;
      expect(unembedded()).toBeGreaterThan(0);
      // Second pass: embeddings on, waited for until every Passage has a vector.
      const pass = await embedEveryPassage(core, db, () => {}, { pollMs: 20 });
      expect(pass.passages).toBeGreaterThan(0);
      expect(pass.embedded).toBe(pass.passages);
      expect(unembedded()).toBe(0);
      expect(pass.seconds).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });

  test("gives up, saying so, when embedding stalls", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir);
    await addAndProcess(core, [
      await writeSourceFile(sources, "Notes.pdf", buildPdf([{ lines: ["Notes", "A line."] }])),
    ]);
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      // A data folder that never changes stands for a stalled embedding queue.
      const frozen = {
        get: <Row>(sql: string) =>
          ({ count: sql.includes("IS NOT NULL") ? 0 : 3 }) as unknown as Row,
      } as unknown as typeof db;
      const log: string[] = [];
      const pass = await embedEveryPassage(core, frozen, (line) => log.push(line), {
        pollMs: 1,
        stallMs: 5,
      });
      expect(pass).toMatchObject({ passages: 3, embedded: 0 });
      expect(log.at(-1)).toBe("Embedding stalled at 0 of 3 Passages; going on");
    } finally {
      db.close();
    }
  });
});

describe("The hard tier's tallies", () => {
  const summary = summariseHard(RESULTS);

  test("count hits per difficulty, domain, language and domain × difficulty, for each mode that ran", () => {
    expect(Object.keys(summary)).toEqual(["keyword", GATING_MODE, "hybrid"]);
    expect(summary.keyword?.all).toEqual({ hits: 2, partial: 1, total: 5 });
    expect(summary.hybrid?.all).toEqual({ hits: 5, partial: 0, total: 5 });
    expect(summary.keyword?.byDifficulty.easy).toEqual({ hits: 1, partial: 0, total: 2 });
    expect(summary.keyword?.byDifficulty["multi-page"]).toEqual({ hits: 0, partial: 1, total: 1 });
    expect(summary.keyword?.byDomain.filings).toEqual({ hits: 0, partial: 0, total: 2 });
    expect(summary.keyword?.byLanguage.zh).toEqual({ hits: 1, partial: 0, total: 2 });
    expect(summary[GATING_MODE]?.byDomainAndDifficulty["filings easy"]).toEqual({
      hits: 1,
      partial: 0,
      total: 1,
    });
  });

  test("the cross-lingual Questions can be scored on their own query alone", () => {
    const own = summariseHard(ownQueryOnly(RESULTS));
    expect(own.hybrid?.all).toEqual({ hits: 0, partial: 0, total: 1 });
    expect(summary.hybrid?.byDifficulty["cross-lingual"]).toEqual({
      hits: 1,
      partial: 0,
      total: 1,
    });
  });
});

const REPORT: HardReport = {
  run: {
    startedAt: "2026-10-10T08:00:00.000Z",
    seconds: 3600,
    commit: "abc1234",
    node: "v25",
    platform: "darwin arm64",
    cpu: "Apple M2 Max (12 cores)",
    memoryBytes: 32e9,
  },
  library: {
    manifest: "eval/hard/library.json",
    documents: 3,
    added: 2,
    leftOut: [{ key: "gone", status: "unavailable", reason: "HTTP 404" }],
    downloadBytes: 2e9,
    fetchedBytes: 0,
    fetchSeconds: 1,
    composition: [
      { domain: "contracts", language: "en", format: "pdf", documents: 1 },
      { domain: "filings", language: "zh", format: "docx", documents: 1 },
    ],
    sources: [
      {
        id: "cuad",
        name: "CUAD",
        licence: "CC-BY-4.0",
        terms: "https://example.org",
        documents: 1,
      },
    ],
  },
  indexing: {
    passages: 1000,
    embeddedPassages: 900,
    keywordSeconds: 120,
    embeddingSeconds: 1500,
    embeddingModelSeconds: 1200,
    peakRssBytesKeyword: 1e9,
    peakRssBytes: 3e9,
    peakRssBytesRun: 3.5e9,
  },
  questions: {
    source: "eval/hard/questions.json",
    total: 6,
    counts: { easy: { en: 1, zh: 1 }, unanswerable: { en: 1 } },
    leftOut: [{ id: "q9", reasons: ["gone isn't in the library."] }],
  },
  retrieval: {
    topK: 5,
    modes: modeLabels("reranker"),
    results: RESULTS,
    summary: summariseHard(RESULTS),
    rerankers: [],
    keywordTiming: {
      passages: 1000,
      limit: 20,
      app: timingOf([4, 2, 1, 3, 120]),
      alone: timingOf([3, 2, 1, 2, 90]),
      reordered: 5,
    },
  },
  citations: { skipped: "no chat model was given." },
};

describe("The hard tier's report", () => {
  test("labels the modes: keyword search's top 20 and top 60 reranked, and hybrid search's candidates reranked", () => {
    expect(REPORT.retrieval.modes.map((each) => each.label)).toEqual([
      "keyword",
      "keyword top 20 + reranker",
      "keyword top 60 + reranker",
      "hybrid",
      "hybrid + reranker",
      "vector",
    ]);
    // Keyword search's top 20 reranked is what the search Tool does by default.
    expect(REPORT.retrieval.modes[1]?.mode).toBe(GATING_MODE);
    expect(REPORT.retrieval.modes[2]?.mode).toBe(KEYWORD_60_RERANK_MODE);
    expect(REPORT.retrieval.modes[4]?.mode).toBe(HYBRID_RERANK_MODE);
  });

  test("report.md has the library, indexing, and retrieval per difficulty, domain and language", () => {
    const markdown = markdownReport(REPORT).split("\n");
    expect(markdown).toContain("| Contracts | 1 | 0 | pdf |");
    expect(markdown).toContain("| Company reports and filings | 0 | 1 | docx |");
    expect(markdown).toContain("- gone (unavailable): HTTP 404");
    expect(markdown).toContain(
      "- **With embeddings off,** every Document was ready after 120 s: text extracted, Passages built and keyword-indexed. This is what a User with embeddings off waits for.",
    );
    expect(markdown).toContain(
      "- **Turning embeddings on** then took 1500 s until every Passage had a vector, 1200 s of it in the embedding model (0.8 Passages a second). With embeddings on from the start, a User waits for both.",
    );
    expect(markdown).toContain("- q9: gone isn't in the library.");
    expect(markdown).toContain("| | keyword | keyword top 20 + reranker | hybrid |");
    expect(markdown).toContain(
      "| Easy (the Documents' own words) | 1/2 (50%) | 2/2 (100%) | 2/2 (100%) |",
    );
    expect(markdown).toContain(
      "| Cross-lingual, its own query only | 0/1 (0%) | 0/1 (0%) | 0/1 (0%) |",
    );
    expect(markdown).toContain("| English | 1/3 (33%) | 2/3 (67%) | 3/3 (100%) |");
    expect(markdown).toContain(
      "| x1 | cross-lingual | reports | – / 2 | – / 1 | – | (11) / 1 | – | – | x1? |",
    );
    expect(markdown).toContain(
      "| Keyword search (the app's, its Document's name match added) | 3.0 ms | 120 ms | 26 ms | 120 ms |  |",
    );
    expect(markdown).toContain(
      "| Keyword search over the Passages alone (no name index) | 2.0 ms | 90 ms | 20 ms | 90 ms |  |",
    );
    expect(markdown).toContain("Skipped: no chat model was given.");
  });

  test("the terminal summary has a line per difficulty and the indexing figures", async () => {
    const results = await mkdtemp(join(tmpdir(), "hard-report-"));
    try {
      const dir = await writeHardReports(REPORT, results);
      expect(dir.endsWith("-hard")).toBe(true);
      const json = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as HardReport;
      expect(json.indexing.passages).toBe(1000);
      const lines = hardSummary(REPORT, dir, results).split("\n");
      expect(lines.find((line) => line.trim().startsWith("paraphrase"))).toMatch(
        /paraphrase +0\/1 \(0%\) +0\/1 \(0%\) +1\/1 \(100%\)/,
      );
      expect(lines.find((line) => line.includes("Passages"))).toContain(
        "2 Documents, 1000 Passages; ready with embeddings off after 120 s, embedding took 1500 s more; peak memory 3.50 GB",
      );
    } finally {
      await rm(results, { recursive: true, force: true });
    }
  });
});

describe("The hard tier's Citations per difficulty", () => {
  const cite = (
    documentName: string,
    outcome: CitationRecord["outcome"] = "found",
  ): CitationRecord => ({
    sentence: "A claim.",
    quote: "a quote",
    documentName,
    pageFrom: 1,
    pageTo: 1,
    check: outcome === "found" ? "found" : "not-found",
    checkReason: null,
    passagePages: null,
    quoteOn: null,
    outcome,
  });
  const answer = (
    questionId: string,
    citations: CitationRecord[],
    status: AnswerRecord["status"] = "done",
  ): AnswerRecord => ({
    questionId,
    language: "en",
    crossLingual: false,
    round: 1,
    question: questionId,
    status,
    error: null,
    citationSupport: "tools",
    searches: [],
    droppedMarkers: 0,
    droppedRecords: 0,
    rejectedRecords: [],
    text: "A claim.",
    sentences: [{ text: "A claim.", cited: citations.length > 0 }],
    citations,
    seconds: 1,
  });
  const library: Pick<{ documents: HardDocument[] }, "documents"> = {
    documents: [
      { key: "r22", group: "r", title: "Report 2022" },
      { key: "r23", group: "r", title: "Report 2023" },
    ] as HardDocument[],
  };
  const questions = new Map<string, HardQuestion>([
    [
      "nd",
      {
        id: "nd",
        language: "en",
        domain: "reports",
        difficulty: "near-duplicate",
        question: "What did the 2023 report say?",
        expected: [{ document: "r23", pages: [1, 1], quote: "x" }],
      },
    ],
    [
      "un",
      {
        id: "un",
        language: "en",
        domain: "reports",
        difficulty: "unanswerable",
        question: "?",
        expected: [],
      },
    ],
  ]);
  const names = (key: string) => ({ r22: "Report 2022", r23: "Report 2023" })[key];

  test("count Answers citing the right version, another version, and no Citation", () => {
    const nearDuplicate = summariseDifficulty(
      [
        answer("nd", [cite("Report 2023")]),
        answer("nd", [cite("Report 2022")]),
        answer("nd", [cite("Report 2023", "wrong-page")]),
      ],
      questions,
      names,
      library,
    );
    expect(nearDuplicate).toMatchObject({
      answers: 3,
      citations: 3,
      citingExpected: 1,
      citingOtherVersion: 1,
    });
    const unanswerable = summariseDifficulty(
      [answer("un", []), answer("un", [cite("Report 2022")]), answer("un", [], "failed")],
      questions,
      names,
      library,
    );
    expect(unanswerable).toMatchObject({ answers: 3, withoutCitation: 1, failedAnswers: 1 });
  });

  test("count the unanswerable Answers that decline per language, with or without Citations", () => {
    const declining = (
      language: "en" | "zh",
      declines: boolean,
      citations: CitationRecord[] = [],
    ) => ({
      ...answer("un", citations),
      language,
      declines,
    });
    const summary = summariseDifficulty(
      [
        declining("en", true, [cite("Report 2022")]),
        declining("en", true),
        declining("en", false, [cite("Report 2022")]),
        declining("zh", true, [cite("Report 2022")]),
        declining("zh", false),
      ],
      questions,
      names,
      library,
    );
    expect(summary.declines).toBe(3);
    expect(summary.declinesByLanguage).toEqual({
      en: { answers: 3, declines: 2 },
      zh: { answers: 2, declines: 1 },
    });
  });

  test("report.md shows the declines share per language beside the answered-without-a-Citation row", () => {
    const unanswerable = summariseDifficulty(
      [
        { ...answer("un", [cite("Report 2022")]), declines: true },
        { ...answer("un", []), declines: true },
        { ...answer("un", []), declines: false },
        { ...answer("un", []), language: "zh" as const, declines: true },
      ],
      questions,
      names,
      library,
    );
    const markdown = markdownReport({
      ...REPORT,
      citations: {
        run: { model: "test/model", service: null } as CitationRun,
        byDifficulty: { unanswerable },
        rules: [],
      },
    }).split("\n");
    expect(markdown).toContain("| **Answered without a Citation** | 3/4 (75%) |");
    expect(markdown).toContain("| **Declines, with or without Citations** | 3/4 (75%) |");
    expect(markdown).toContain("- English: 2/3 (67%)");
    expect(markdown).toContain("- Chinese: 1/1 (100%)");
  });

  test("the gating set's Citation part gets the Questions as it takes them", () => {
    expect(asEvalQuestion(questions.get("un") as HardQuestion)).toMatchObject({
      id: "un",
      crossLingual: false,
      question: "?",
    });
  });
});
