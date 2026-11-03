/**
 * The evaluation's Citation part (`npm run eval` with a chat model,
 * eval/README.md), run against a core with a scripted model in place of a
 * real one: it asks through the public interface, reads each Answer back from
 * its Mind, and sorts the Citations by what became of them.
 */
import { describe, expect, test } from "vitest";
import { runCitations } from "../../eval/lib/citations";
import type { EvalQuestion } from "../../eval/lib/evaluationSet";
import type { Library } from "../../eval/lib/library";
import { citingModel, type ShownPassage, setUpWithDocuments } from "../helpers/citations";
import { queryDatabase } from "../helpers/core";
import { buildPdf } from "../helpers/pdf";

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "Most coasts see two high tides every day."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const SPRING = "Spring tides happen at new moon and at full moon.";

const QUESTION: EvalQuestion = {
  id: "en-01",
  language: "en",
  crossLingual: false,
  question: "When are spring tides?",
  expected: { document: "tides", pages: [2, 2], quote: SPRING },
};

/** The same fact in other words: a group of its own, never asked again for a language's count. */
const PARAPHRASE: EvalQuestion = {
  id: "para-en-01",
  language: "en",
  crossLingual: false,
  paraphrase: true,
  question: "When does the sea rise highest?",
  expected: { document: "tides", pages: [2, 2], quote: SPRING },
};

const first = (passages: ShownPassage[]) => passages[0]?.id ?? "none";

/** The evaluation's library over a core the test set up. */
const libraryOf = (
  core: Library["core"],
  dataDir: string,
  timings: Library["timings"] = null,
): Library => ({
  core,
  timings,
  dataDir,
  documents: new Map(),
  processingSeconds: 0,
  passageCount: 0,
  pageTexts: (documentId) =>
    queryDatabase(
      dataDir,
      "SELECT page, text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY page",
      [documentId],
    ),
  passagePages: (passageId) => {
    const [row] = queryDatabase<{ page_from: number | null; page_to: number | null }>(
      dataDir,
      "SELECT page_from, page_to FROM passages WHERE id = ?",
      [passageId],
    );
    return row?.page_from && row.page_to ? [row.page_from, row.page_to] : null;
  },
  passages: () => [],
  close: async () => {},
});

describe("The evaluation's Citation part", { timeout: 60_000 }, () => {
  test("scores each Citation of each Answer, and asks again while a language has too few", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        // On the cited page, word for word.
        { marker: 1, passage: first(passages), pageFrom: 2, pageTo: 2, quote: SPRING },
        // On the cited page, but not word for word: a false "not found".
        {
          marker: 2,
          passage: first(passages),
          pageFrom: 2,
          pageTo: 2,
          quote: "spring tides happen at new moon, and at full moon",
        },
        // On another page than the one cited: placed where it uniquely occurs.
        { marker: 3, passage: first(passages), pageFrom: 1, pageTo: 1, quote: SPRING },
      ],
      answer:
        "Spring tides come at new moon [^1]. And at full moon [^2]. They are the largest.[^3] Neap tides are smaller.",
    });
    const { core, dataDir } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const logged: string[] = [];

    const run = await runCitations(
      libraryOf(core, dataDir),
      [QUESTION, PARAPHRASE],
      {
        kind: "ollama",
        modelId: "local-model",
        apiKey: null,
        baseUrl: null,
        numCtx: null,
        endpoint: null,
        citing: null,
      },
      { minCitations: 4, maxRounds: 2, answerTimeoutMs: 30_000 },
      (line) => logged.push(line),
    );

    // Three Citations in round 1 are fewer than 4, so the gating Question was asked again;
    // the paraphrase Question's Citations don't count for English, and it isn't asked again.
    expect(run).toMatchObject({
      model: "ollama/local-model",
      gating: false,
      rounds: 2,
      failures: [],
    });
    expect(run.answers.map((each) => [each.questionId, each.round])).toEqual([
      ["en-01", 1],
      ["para-en-01", 1],
      ["en-01", 2],
    ]);
    const [answer] = run.answers;
    expect(answer).toMatchObject({
      questionId: "en-01",
      round: 1,
      status: "done",
      citationSupport: "tools",
      searches: ["spring tides"],
      droppedMarkers: 0,
      droppedRecords: 0,
      sentences: [
        { text: "Spring tides come at new moon .", cited: true },
        { text: "And at full moon .", cited: true },
        { text: "They are the largest.", cited: true },
        { text: "Neap tides are smaller.", cited: false },
      ],
    });
    expect(answer?.citations.map(({ sentence, outcome }) => [sentence, outcome])).toEqual([
      ["Spring tides come at new moon .", "found"],
      ["And at full moon .", "false-not-found"],
      ["They are the largest.", "found"],
    ]);
    // Where each quote is, and the pages of the Passage cited: one Passage covers both short pages.
    expect(answer?.citations.map(({ passagePages, quoteOn }) => [passagePages, quoteOn])).toEqual([
      [
        [1, 2],
        [2, 2],
      ],
      [
        [1, 2],
        [2, 2],
      ],
      [
        [1, 2],
        [2, 2],
      ],
    ]);
    // The uniquely placed quote no longer has a wrong-page line.
    expect(logged).not.toContain(
      `  wrong page (quote-not-on-pages): Tides, cites p. 1 of a Passage on pp. 1–2; the quote is on p. 2: "${SPRING}"`,
    );
    expect(run.summary.en).toMatchObject({
      answers: 2,
      citedAnswers: 2,
      citedAnswerShare: 1,
      citations: 6,
      foundShare: 4 / 6,
      falseNotFoundShare: 2 / 6,
      coverage: 6 / 8,
    });
    expect(run.summary.zh).toMatchObject({ answers: 0, citations: 0, foundShare: null });
    expect(run.summary.paraphrase).toMatchObject({ answers: 1, citations: 3, foundShare: 2 / 3 });
    expect(run.answers[1]).toMatchObject({ paraphrase: true });
  });

  test("with some Questions named, asks only those, once each, and never gates, even with a cloud model", async () => {
    const model = citingModel({
      query: "spring tides",
      records: (passages) => [
        { marker: 1, passage: first(passages), pageFrom: 2, pageTo: 2, quote: SPRING },
      ],
      answer: "Spring tides come at new moon [^1].",
    });
    const { core, dataDir } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const other: EvalQuestion = { ...QUESTION, id: "en-02", question: "What are neap tides?" };
    const logged: string[] = [];

    const run = await runCitations(
      libraryOf(core, dataDir),
      [QUESTION, other],
      {
        kind: "anthropic",
        modelId: "a-cloud-model",
        apiKey: "a-key",
        baseUrl: null,
        numCtx: null,
        endpoint: null,
        citing: null,
      },
      { minCitations: 30, maxRounds: 3, answerTimeoutMs: 30_000, questionIds: ["en-02"] },
      (line) => logged.push(line),
    );

    // Far fewer than 30 Citations, yet no second round: a short check gathers none for the targets.
    expect(run).toMatchObject({ gating: false, subset: ["en-02"], rounds: 1, failures: [] });
    expect(run.answers.map((answer) => answer.questionId)).toEqual(["en-02"]);
    expect(logged.join("\n")).toMatch(/asking only en-02, once each \(not gating\)/);
  });
});
