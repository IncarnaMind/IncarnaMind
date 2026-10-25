/**
 * Timing each step of an Answer in the evaluation (#488): the first-text rule,
 * the written-twice check, the summaries, and that recording sends the model
 * exactly what it would be sent without it.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { type CitationRun, runCitations, summariseGroup } from "../../eval/lib/citations";
import { type ChatSettings, readConfig } from "../../eval/lib/config";
import type { EvalQuestion } from "../../eval/lib/evaluationSet";
import { expectedCounts, summariseHanded } from "../../eval/lib/handed";
import type { Library } from "../../eval/lib/library";
import { type EvalReport, terminalSummary, writeReports } from "../../eval/lib/report";
import { GATING_MODE, summarise } from "../../eval/lib/retrieval";
import {
  type AnswerTiming,
  answerOptionsOf,
  answerSearchOf,
  createTimingRecorder,
  firstKeptText,
  isWrittenTwice,
  spreadOf,
  summariseTiming,
} from "../../eval/lib/timing";
import { timingLine, timingTable } from "../../eval/lib/timingReport";
import { citingModel, type ShownPassage, setUpWithDocuments } from "../helpers/citations";
import { queryDatabase } from "../helpers/core";
import { scriptedModel } from "../helpers/models";
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

const CHAT = {
  kind: "ollama",
  modelId: "local-model",
  apiKey: null,
  baseUrl: null,
  numCtx: null,
  endpoint: null,
  citing: null,
} as const;
const CONFIG = { minCitations: 1, maxRounds: 1, answerTimeoutMs: 30_000 };

const first = (passages: ShownPassage[]) => passages[0]?.id ?? "none";

const citing = (preamble?: string) =>
  citingModel({
    query: "spring tides",
    preamble,
    records: (passages) => [
      { marker: 1, passage: first(passages), pageFrom: 2, pageTo: 2, quote: SPRING },
    ],
    answer: "Spring tides come at new moon [^1].",
  });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** What a request carried, without the ids a data folder makes up (a Passage's, a Mind's cache key) and the signal each call owns. */
const sent = (model: MockLanguageModelV4) =>
  model.doStreamCalls.map((call) =>
    JSON.stringify({
      prompt: call.prompt,
      tools: call.tools,
      toolChoice: call.toolChoice,
      temperature: call.temperature,
      maxOutputTokens: call.maxOutputTokens,
      providerOptions: call.providerOptions,
    })
      .replace(UUID, "<id>")
      .replace(/"promptCacheKey":"[0-9a-f]+"/g, '"promptCacheKey":"<key>"'),
  );

/** The evaluation's library over a core the test set up, with the Documents it added. */
function libraryOf(
  setup: Awaited<ReturnType<typeof setUpWithDocuments>>,
  timings: Library["timings"],
): Library {
  const { core, dataDir, documents } = setup;
  return {
    core,
    timings,
    dataDir,
    documents: new Map(
      documents.map((document) => [document.name.replace(/\.pdf$/, "").toLowerCase(), document]),
    ),
    processingSeconds: 0,
    passageCount: 0,
    pageTexts: (documentId) =>
      queryDatabase(
        dataDir,
        "SELECT page, text FROM document_pages WHERE document_id = ? AND deleted_at IS NULL ORDER BY page",
        [documentId],
      ),
    passagePages: () => null,
    passages: () => [],
    close: async () => {},
  };
}

/** Asks QUESTION with `model`, recording or not. */
async function ask(model: MockLanguageModelV4, record: boolean, chat: ChatSettings = CHAT) {
  const recorder = record ? createTimingRecorder() : null;
  const search = answerSearchOf({}, recorder);
  const setup = await setUpWithDocuments(
    model,
    [{ name: "Tides.pdf", contents: TIDES }],
    recorder
      ? {
          createChatModel: recorder.chatModels(() => model),
          answerEngine: recorder.engine,
          ...(search && { answerSearch: search }),
        }
      : {},
  );
  const run = await runCitations(libraryOf(setup, recorder), [QUESTION], chat, CONFIG, () => {});
  return { run, recorder };
}

describe("The first text of an Answer", () => {
  test("is the first text that stays: a preamble taken back doesn't count", () => {
    const events = [
      { type: "text-delta", atMs: 400, length: 20 },
      { type: "text-retracted", atMs: 1_200, length: 20 },
      { type: "text-delta", atMs: 4_400, length: 30 },
      { type: "text-delta", atMs: 4_900, length: 10 },
    ] as const;
    expect(firstKeptText(events)).toBe(4_400);
  });

  test("counts a preamble only partly taken back, and none when everything is", () => {
    expect(
      firstKeptText([
        { type: "text-delta", atMs: 300, length: 25 },
        { type: "text-retracted", atMs: 900, length: 10 },
      ]),
    ).toBe(300);
    expect(
      firstKeptText([
        { type: "text-delta", atMs: 300, length: 25 },
        { type: "text-retracted", atMs: 900, length: 25 },
      ]),
    ).toBeNull();
    expect(firstKeptText([])).toBeNull();
  });
});

describe("The written-twice check", () => {
  const ANSWER = "Spring tides come at new moon and at full moon.";

  test("finds a paragraph said again, Citation markers aside", () => {
    expect(isWrittenTwice(`${ANSWER} [^1]\n\n${ANSWER}`)).toBe(true);
    expect(isWrittenTwice(`${ANSWER}[^1]\n${ANSWER.toUpperCase()}  [^2]`)).toBe(true);
  });

  test("leaves Answers alone that repeat nothing, or only something short", () => {
    expect(isWrittenTwice(`${ANSWER}\n\nNeap tides are smaller.`)).toBe(false);
    expect(isWrittenTwice("Yes.\n\nYes.")).toBe(false);
    expect(isWrittenTwice("")).toBe(false);
  });
});

describe("Recording an Answer", () => {
  test("changes nothing that is sent to the model", async () => {
    const plain = citing();
    const recorded = citing();
    await ask(plain, false);
    const { recorder } = await ask(recorded, true);

    expect(recorded.doStreamCalls.length).toBeGreaterThan(1);
    expect(sent(recorded)).toEqual(sent(plain));
    expect(recorder).not.toBeNull();
  });

  test("times each model call and search, and counts what the model was handed", async () => {
    const { run } = await ask(citing(), true);
    const [answer] = run.answers;
    const timing = answer?.timing;

    expect(answer?.status).toBe("done");
    // The scripted model refuses a request that is not streamed (the core's probe of it): a call with no first byte.
    const calls = (timing?.modelCalls ?? []).filter((call) => call.firstByteMs !== null);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.endMs ?? 0).toBeGreaterThanOrEqual(call.firstByteMs ?? 0);
      expect(call.firstByteMs ?? 0).toBeGreaterThanOrEqual(call.startMs);
    }
    expect(calls.map((call) => call.startMs)).toEqual(
      [...calls.map((call) => call.startMs)].sort((a, b) => a - b),
    );
    expect(timing?.searches).toHaveLength(1);
    expect(timing?.searches[0]?.passages).toBeGreaterThan(0);
    expect(timing?.searches[0]?.rerankMs).toBeNull();
    expect(timing?.firstTextMs).not.toBeNull();
    expect(timing?.firstTextMs ?? 0).toBeGreaterThanOrEqual(calls[1]?.endMs ?? 0);
    expect(timing?.totalMs ?? 0).toBeGreaterThanOrEqual(timing?.firstTextMs ?? Infinity);
    expect(timing?.writtenTwice).toBe(false);
    expect(timing?.loadAverage).toBeGreaterThanOrEqual(0);
    expect(answer?.expected).toEqual({ needed: 1, handed: 1, cited: 1 });
    expect(run.summary.en.timing?.answers).toBe(1);
    expect(run.summary.en.handed).toEqual({ answers: 1, handed: 1, cited: 1 });
  });

  test("starts the first text after the preamble the engine took back", async () => {
    const { run } = await ask(citing("Let me look that up for you."), true);
    const timing = run.answers[0]?.timing;
    const [searchCall] = timing?.modelCalls ?? [];

    expect(run.answers[0]?.text).toBe("Spring tides come at new moon [^1].");
    // The preamble streamed in the first call; the text that stayed came after the search.
    expect(timing?.firstTextMs ?? 0).toBeGreaterThanOrEqual(searchCall?.endMs ?? Infinity);
    expect(timing?.searches[0]?.endMs ?? Infinity).toBeLessThanOrEqual(timing?.firstTextMs ?? 0);
  });

  test("finds an Answer a model wrote, cited and wrote again written once, since the engine keeps one copy (#466)", async () => {
    const twice = scriptedModel((call) => {
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      }
      const answer = "Spring tides come at new moon and at full moon [^1].";
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = call.results.at(-1)?.text.match(/<passage id="([^"]+)"/);
        return {
          text: answer,
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passages?.[1], pageFrom: 2, pageTo: 2, quote: SPRING },
                ],
              },
            },
          ],
        };
      }
      return { text: answer };
    });
    const { run } = await ask(twice, true);

    expect(run.answers[0]?.timing?.writtenTwice).toBe(false);
    expect(run.summary.en.timing?.writtenTwice).toBe(0);
  });

  test("records no model call, nor a timing, without a recorder", async () => {
    const { run } = await ask(citing(), false);

    expect(run.answers[0]?.timing).toBeUndefined();
    expect(run.summary.en.timing).toBeNull();
  });

  test("keeps no key, request or Passage in what it records", async () => {
    const { run } = await ask(citing(), true);
    const written = JSON.stringify(run.answers[0]?.timing);

    expect(written).not.toContain("Spring tides");
    expect(written).not.toMatch(/api[-_]?key|authorization|prompt/i);
  });
});

describe("Tuning the search Tool for Answers", () => {
  test("INCARNAMIND_EVAL_RERANK_DEPTH takes a number or off, and INCARNAMIND_EVAL_MAX_PASSAGES a number", () => {
    expect(readConfig("/repo", {})).toMatchObject({ rerankDepth: null, maxPassages: null });
    expect(
      readConfig("/repo", {
        INCARNAMIND_EVAL_RERANK_DEPTH: "20",
        INCARNAMIND_EVAL_MAX_PASSAGES: "12",
      }),
    ).toMatchObject({ rerankDepth: 20, maxPassages: 12 });
    expect(readConfig("/repo", { INCARNAMIND_EVAL_RERANK_DEPTH: "off" }).rerankDepth).toBe("off");
    expect(() => readConfig("/repo", { INCARNAMIND_EVAL_RERANK_DEPTH: "none" })).toThrow(
      "INCARNAMIND_EVAL_RERANK_DEPTH must be a whole number",
    );
    expect(() => readConfig("/repo", { INCARNAMIND_EVAL_MAX_PASSAGES: "0" })).toThrow(
      "INCARNAMIND_EVAL_MAX_PASSAGES must be a whole number",
    );
  });

  test("a run that changes the search is reported as set by the run, and never gates", async () => {
    const model = citing();
    const setup = await setUpWithDocuments(model, [{ name: "Tides.pdf", contents: TIDES }]);
    const run = await runCitations(
      libraryOf(setup, null),
      [QUESTION],
      { ...CHAT, kind: "anthropic", modelId: "a-cloud-model", apiKey: "a-key" },
      { ...CONFIG, rerankDepth: "off", maxPassages: 12 },
      () => {},
    );

    expect(run.overrides).toEqual(["reranking off", "12 Passages a search"]);
    expect(run.gating).toBe(false);
  });

  test("leaves reranking out, or changes how many Passages a search hands over", async () => {
    const searchesOnce = scriptedModel((call) =>
      call.tools.length > 0
        ? { error: { status: 400, message: "this model does not support tools" } }
        : { text: JSON.stringify({ answer: "Spring tides come at new moon.", citations: [] }) },
    );
    const searched = async (settings: { rerankDepth?: number | "off"; maxPassages?: number }) => {
      const recorder = createTimingRecorder();
      const setup = await setUpWithDocuments(
        searchesOnce,
        [{ name: "Tides.pdf", contents: TIDES }],
        {
          answerSearch: answerSearchOf(settings, recorder),
        },
      );
      const run = await runCitations(
        libraryOf(setup, recorder),
        [QUESTION],
        CHAT,
        CONFIG,
        () => {},
      );
      return run.answers[0]?.timing?.searches[0];
    };

    expect((await searched({}))?.rerankMs).not.toBeNull();
    expect((await searched({ rerankDepth: 20 }))?.rerankMs).not.toBeNull();
    expect((await searched({ rerankDepth: "off" }))?.rerankMs).toBeNull();
    expect((await searched({ maxPassages: 1 }))?.passages).toBe(1);
  });

  test("is read from the run's settings", () => {
    expect(answerOptionsOf({ chat: null, rerankDepth: null, maxPassages: null })).toEqual({
      answerSearch: {},
      recordTimings: false,
    });
    expect(answerOptionsOf({ chat: CHAT, rerankDepth: "off", maxPassages: 12 })).toEqual({
      answerSearch: { rerankDepth: "off", maxPassages: 12 },
      recordTimings: true,
    });
  });
});

const timing = (totalMs: number, extra: Partial<AnswerTiming> = {}): AnswerTiming => ({
  loadAverage: 2,
  totalMs,
  firstTextMs: totalMs / 2,
  writtenTwice: false,
  modelCalls: [
    {
      startMs: 0,
      firstByteMs: 600,
      endMs: 1_300,
      inputTokens: 2_000,
      cachedInputTokens: 0,
      outputTokens: 180,
    },
    {
      startMs: 1_400,
      firstByteMs: 2_100,
      endMs: 3_600,
      inputTokens: 14_000,
      cachedInputTokens: 2_000,
      outputTokens: 440,
    },
  ],
  searches: [{ startMs: 1_200, endMs: 1_450, rerankMs: 200, passages: 8 }],
  ...extra,
});

const reportOf = (citations: CitationRun) =>
  ({
    result: "pass",
    failures: [],
    run: {
      startedAt: "2026-10-12T08:00:00.000Z",
      seconds: 1,
      commit: "",
      node: "",
      platform: "",
      cpu: "",
    },
    evaluationSet: {
      source: "",
      hitRule: "",
      questions: { gating: { en: 1, zh: 0 }, crossLingual: 0, paraphrase: 0 },
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
  }) satisfies EvalReport;

describe("The reports", () => {
  test("carry the timings, and no key", async () => {
    const { run } = await ask(citing(), true, {
      ...CHAT,
      kind: "anthropic",
      modelId: "a-cloud-model",
      apiKey: "a-secret-key",
    });
    const report = reportOf(run);
    const results = await mkdtemp(join(tmpdir(), "timing-report-"));

    const dir = await writeReports(report, results, "/");
    const markdown = await readFile(join(dir, "report.md"), "utf8");
    const json = await readFile(join(dir, "report.json"), "utf8");

    expect(markdown).toContain("### Where the time went");
    expect(markdown).toContain("| **Whole Answer** |");
    expect(markdown).toContain("| A search handed every Passage the Question needs | 1/1 |");
    expect(JSON.parse(json).citations.answers[0].timing.modelCalls.length).toBeGreaterThan(0);
    expect(JSON.parse(json).citations.summary.en.timing.answers).toBe(1);
    expect(markdown + json).not.toContain("a-secret-key");
    expect(terminalSummary(report, join(results, "x"), results)).toMatch(
      /time: .* an Answer, first text /,
    );
  });

  test("have no timing section without a chat model's Answers", async () => {
    const results = await mkdtemp(join(tmpdir(), "timing-report-"));
    const run = {
      model: "ollama/x",
      service: null,
      gating: false,
      subset: null,
      overrides: [],
      minCitations: 1,
      rounds: 1,
      answers: [],
      summary: {
        en: summariseGroup([]),
        zh: summariseGroup([]),
        crossLingual: summariseGroup([]),
        paraphrase: summariseGroup([]),
      },
      failures: [],
    } satisfies CitationRun;

    const dir = await writeReports(reportOf(run), results, "/");

    expect(await readFile(join(dir, "report.md"), "utf8")).not.toContain("Where the time went");
  });
});

describe("The summaries", () => {
  test("give the median and 95th percentile, and leave out what was never measured", () => {
    expect(spreadOf([])).toBeNull();
    expect(spreadOf([1, 2, 3, 4, 100])).toEqual({ median: 3, p95: 100, n: 5 });

    const summary = summariseTiming([
      { timing: timing(4_000) },
      { timing: timing(6_000, { writtenTwice: true, firstTextMs: null }) },
      { timing: null },
      {},
    ]);

    expect(summary).toMatchObject({
      answers: 2,
      loadAverage: 2,
      whole: { median: 5, p95: 6, n: 2 },
      firstText: { median: 2, p95: 2, n: 1 },
      modelCallsPerAnswer: 2,
      searchesPerAnswer: 1,
      writtenTwice: 1,
      reranker: { median: 0.2 },
    });
    expect(summary?.modelCallsByOrder[0]?.wait?.median).toBeCloseTo(0.6);
    expect(summary?.modelCallsByOrder[3]?.duration).toBeNull();
    expect(summary?.tokensPerCall).toEqual({ input: 8_000, cachedInput: 1_000, output: 310 });
    expect(summariseTiming([{}])).toBeNull();
  });

  test("count the Answers whose searches handed over, and whose Citations cover, what the Question needs", () => {
    expect(summariseHanded([{}, { expected: null }])).toBeNull();
    expect(
      summariseHanded([
        { expected: { needed: 2, handed: 2, cited: 1 } },
        { expected: { needed: 1, handed: 0, cited: 0 } },
        { expected: { needed: 1, handed: 1, cited: 1 } },
      ]),
    ).toEqual({ answers: 3, handed: 2, cited: 1 });
  });

  test("read a Question's expected Passages from every one it needs, and none when it needs none", () => {
    const lookup = () => undefined;
    expect(expectedCounts({ ...QUESTION, expectedAll: [] }, lookup, [], [])).toBeNull();
    expect(
      expectedCounts(
        { ...QUESTION, expected: { document: "", pages: [1, 1], quote: "" } },
        lookup,
        [],
        [],
      ),
    ).toBeNull();
  });

  test("show in the report's table and in one line, and nothing without timings", () => {
    const summary = summariseTiming([{ timing: timing(4_000) }]);
    const table = timingTable([
      { label: "English", timing: summary, handed: { answers: 1, handed: 1, cited: 1 } },
      { label: "Chinese", timing: null },
    ]);

    expect(table[0]).toBe("| Median (95th percentile) | English | Chinese |");
    expect(table).toContain("| **Whole Answer** | 4.00 s (95th 4.00 s) | – |");
    expect(table).toContain("| A search handed every Passage the Question needs | 1/1 | – |");
    expect(timingTable([{ label: "English", timing: null }])).toEqual([]);
    expect(timingLine(summary)).toContain(
      "4.00 s (95th 4.00 s) an Answer, first text 2.00 s, 2.0 model calls",
    );
    expect(timingLine(null)).toBeNull();
  });
});
