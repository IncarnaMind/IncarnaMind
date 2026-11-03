/**
 * How the evaluation reports the every-format set (#70) per format and per
 * hard place: which Questions count, known gaps apart, and each format's
 * Citations. The run itself needs the models; its scoring doesn't.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AnswerRecord, CitationRecord, CitationRun } from "../../eval/lib/citations";
import type { EvalQuestion, EvaluationSet } from "../../eval/lib/evaluationSet";
import { type FormatsReport, formatOf, summariseFormats } from "../../eval/lib/formats";
import { type EvalReport, terminalSummary, writeReports } from "../../eval/lib/report";
import {
  GATING_MODE,
  HYBRID,
  HYBRID_RERANK_MODE,
  type QuestionResult,
  type RetrievalRun,
  summarise,
} from "../../eval/lib/retrieval";

const question = (
  id: string,
  document: string,
  extra: Partial<EvalQuestion> = {},
): EvalQuestion => ({
  id,
  language: "en",
  crossLingual: false,
  question: id,
  expected: { document, pages: [1, 1], quote: "a quote" },
  ...extra,
});

const SET: EvaluationSet = {
  source: "eval/retrieval/formats.json",
  hitRule: "",
  documents: [
    { key: "deck", path: "/repo/Launch Review.pptx" },
    { key: "scan", path: "/repo/scan_0042.pdf" },
    { key: "orders", path: "/repo/Orders.csv" },
    { key: "workbook", path: "/repo/Budget.xlsx" },
  ],
  questions: [
    question("ppt-en-01", "deck", { place: "slide-text" }),
    question("ppt-zh-01", "deck", { place: "slide-text", language: "zh" }),
    question("ppt-en-02", "deck", { place: "speaker-notes" }),
    question("pdf-en-01", "scan", { place: "scanned", knownGap: "No text layer." }),
    question("sheet-en-01", "orders", { place: "row-with-header" }),
    question("sheet-zh-01", "workbook", { place: "second-sheet", language: "zh" }),
    question("x-zh-01", "deck", { place: "slide-text", language: "zh", crossLingual: true }),
  ],
};

/** Hits in the default mode (keyword + rerank), in plain hybrid search, and in hybrid + rerank. */
const HITS: Record<string, [boolean, boolean, boolean]> = {
  "ppt-en-01": [true, true, true],
  "ppt-zh-01": [false, true, false],
  "ppt-en-02": [true, false, false],
  "pdf-en-01": [false, false, false],
  "sheet-en-01": [true, true, true],
  "sheet-zh-01": [false, false, true],
  "x-zh-01": [true, false, false],
};

const RESULTS: QuestionResult[] = SET.questions.map((each) => {
  const [reranked, hybrid, hybridReranked] = HITS[each.id] as [boolean, boolean, boolean];
  const result = (hit: boolean) => ({ hit, rank: hit ? 1 : null, top: [] });
  return {
    id: each.id,
    language: each.language,
    crossLingual: each.crossLingual,
    question: each.question,
    modes: {
      [GATING_MODE]: result(reranked),
      [HYBRID]: result(hybrid),
      [HYBRID_RERANK_MODE]: result(hybridReranked),
    },
  };
});

const RETRIEVAL: RetrievalRun = {
  embedding: "multilingual-e5-small (built-in)",
  gating: false,
  passageCount: 40,
  processingSeconds: 10,
  questions: RESULTS,
  summary: summarise(RESULTS),
};

const cited = (outcome: CitationRecord["outcome"]): CitationRecord => ({
  sentence: "A claim.",
  quote: "a quote",
  documentName: "Launch Review",
  pageFrom: 1,
  pageTo: 1,
  check: outcome === "found" ? "found" : "not-found",
  checkReason: outcome === "found" ? null : "quote-not-on-pages",
  outcome,
  passagePages: [1, 1],
  quoteOn: outcome === "not-in-document" ? null : [1, 1],
});

const answer = (questionId: string, citations: CitationRecord[]): AnswerRecord => {
  const asked = SET.questions.find((each) => each.id === questionId) as EvalQuestion;
  return {
    questionId,
    language: asked.language,
    crossLingual: asked.crossLingual,
    round: 1,
    question: asked.question,
    status: "done",
    error: null,
    citationSupport: "tools",
    searches: [],
    droppedMarkers: 0,
    droppedRecords: 0,
    rejectedRecords: [],
    text: "A claim.",
    sentences: citations.map(() => ({ text: "A claim.", cited: true })),
    citations,
    seconds: 1,
  };
};

const CITATIONS = {
  answers: [
    answer("ppt-en-01", [cited("found"), cited("false-not-found")]),
    answer("ppt-zh-01", [cited("found")]),
    answer("sheet-en-01", [cited("wrong-page")]),
    answer("x-zh-01", [cited("found")]),
  ],
} as Pick<CitationRun, "answers"> as CitationRun;

describe("The every-format set's report", () => {
  test("groups Documents by format as Users name them", () => {
    expect(
      ["a.docx", "a.pptx", "a.xlsx", "a.csv", "a.md", "a.txt", "a.pdf", "a.vtt"].map((path) =>
        formatOf(path),
      ),
    ).toEqual([
      "word",
      "powerpoint",
      "spreadsheet",
      "spreadsheet",
      "text",
      "text",
      "pdf",
      "transcript",
    ]);
    expect(() => formatOf("a.png")).toThrow(/a\.png/);
    // A Web page has no file kind: the set names its kind.
    expect(formatOf("/repo/Page.html", "web")).toBe("web");
    expect(() => formatOf("/repo/Page.html")).toThrow(/Page\.html/);
  });

  test("counts each format's Questions per language, known gaps and cross-lingual ones apart", () => {
    const formats = summariseFormats(SET, RETRIEVAL, CITATIONS);
    const of = (id: string) => formats.find((format) => format.format === id);

    expect(formats.map((format) => [format.label, format.documents])).toEqual([
      ["Word", 0],
      ["PowerPoint", 1],
      ["Excel and CSV", 2],
      ["Markdown and plain text", 0],
      ["PDF", 1],
      ["Transcript", 0],
      ["Web page", 0],
    ]);
    expect(of("powerpoint")?.retrieval).toEqual({
      [GATING_MODE]: {
        en: { hits: 2, total: 2 },
        zh: { hits: 0, total: 1 },
        all: { hits: 2, total: 3 },
      },
      [HYBRID]: {
        en: { hits: 1, total: 2 },
        zh: { hits: 1, total: 1 },
        all: { hits: 2, total: 3 },
      },
      [HYBRID_RERANK_MODE]: {
        en: { hits: 1, total: 2 },
        zh: { hits: 0, total: 1 },
        all: { hits: 1, total: 3 },
      },
    });
    // A mode that didn't run isn't reported as all misses.
    const hybridOnly = RESULTS.map((result) => ({
      ...result,
      modes: { [GATING_MODE]: result.modes[GATING_MODE], [HYBRID]: result.modes[HYBRID] },
    }));
    expect(
      Object.keys(
        summariseFormats(SET, { ...RETRIEVAL, summary: summarise(hybridOnly) }, CITATIONS)[1]
          ?.retrieval ?? {},
      ),
    ).toEqual([GATING_MODE, HYBRID]);
    expect(of("powerpoint")?.places.map((place) => [place.place, place.hits.all])).toEqual([
      ["slide-text", { hits: 1, total: 2 }],
      ["speaker-notes", { hits: 1, total: 1 }],
    ]);
    // The scan's Question is a known gap: out of the PDF's figures, marked in its place.
    expect(of("pdf")).toMatchObject({
      retrieval: { [GATING_MODE]: { all: { hits: 0, total: 0 } } },
      knownGaps: { hits: 0, total: 1 },
      places: [
        { place: "scanned", knownGap: "No text layer.", hits: { en: { hits: 0, total: 1 } } },
      ],
    });
    expect(of("spreadsheet")?.retrieval[GATING_MODE]?.all).toEqual({ hits: 1, total: 2 });
  });

  test("gives each format's Citations, the cross-lingual Answers left out", () => {
    const formats = summariseFormats(SET, RETRIEVAL, CITATIONS);
    const powerpoint = formats.find((format) => format.format === "powerpoint")?.citations;
    expect(powerpoint).toMatchObject({ answers: 2, citations: 3, foundShare: 2 / 3 });
    expect(powerpoint?.falseNotFoundShare).toBe(1 / 3);
    expect(
      formats.find((format) => format.format === "spreadsheet")?.citations?.outcomes,
    ).toMatchObject({ "wrong-page": 1 });
    expect(summariseFormats(SET, RETRIEVAL, { skipped: "no chat model" })[1]?.citations).toBe(null);
  });

  test("the summary and report.md have a line per format, and the cross-lingual Questions", async () => {
    const formats: FormatsReport = {
      source: SET.source,
      documents: [],
      retrieval: RETRIEVAL,
      formats: summariseFormats(SET, RETRIEVAL, { skipped: "no chat model" }),
      crossLingualCitations: null,
      citations: { skipped: "no chat model" },
    };
    const report = {
      result: "pass",
      failures: [],
      run: {
        startedAt: "2026-10-09T08:00:00.000Z",
        seconds: 1,
        commit: "",
        node: "",
        platform: "",
        cpu: "",
      },
      evaluationSet: {
        source: "",
        hitRule: "",
        questions: { gating: { en: 0, zh: 0 }, crossLingual: 0, paraphrase: 0 },
      },
      documents: [],
      retrieval: { topK: 5, gatingMode: GATING_MODE, runs: [{ ...RETRIEVAL, gating: true }] },
      citations: { skipped: "no chat model" },
      formats,
    } satisfies EvalReport;

    const lines = terminalSummary(report, "/repo/eval/results/x", "/repo").split("\n");

    expect(lines.find((line) => line.trim().startsWith("PowerPoint"))).toMatch(
      /English 2\/2 +Chinese 0\/1 +known gaps 0\/0; hybrid \+ .+ 1\/3$/,
    );
    expect(lines.find((line) => line.trim().startsWith("PDF"))).toContain("known gaps 0/1");
    expect(lines.find((line) => line.trim().startsWith("Cross-lingual"))).toContain("1/1");

    // report.md: a row per format, and per hard place, known gaps marked.
    const results = await mkdtemp(join(tmpdir(), "formats-report-"));
    try {
      const dir = await writeReports(report, results, "/");
      const markdown = (await readFile(join(dir, "report.md"), "utf8")).split("\n");
      expect(markdown).toContain("## Every format (reported, not gating)");
      expect(markdown).toContain(
        "| PowerPoint | 1 | 2 / 1 | 2/2 | 0/1 | **2/3** | 2/3 | 1/3 | 0/0 |",
      );
      expect(markdown).toContain(
        "| Excel and CSV | 2 | 1 / 1 | 1/1 | 0/1 | **1/2** | 1/2 | 2/2 | 0/0 |",
      );
      expect(markdown).toContain("| PDF | scanned | 0/1 | 0/0 | known gap: No text layer. |");
    } finally {
      await rm(results, { recursive: true, force: true });
    }
  });
});
