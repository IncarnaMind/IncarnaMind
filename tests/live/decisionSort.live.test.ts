/**
 * The decision model's sort of a Note's sentences (#3334), on the real model: every fact of the
 * fixed Notes and pairs has to score at or over the measured line, since a fact left out is a
 * check that never runs. How many of the writer's own remarks and views it leaves out is counted,
 * not judged: either a grey mark or none is right for those.
 *
 * And its question about the Library (#2525): every sentence about the Library itself has to score
 * at or over that question's line, since one under it may read Unsupported with its lists never
 * counted. How many other sentences score over it is counted: those only cost their own check.
 *
 * Runs with an OpenRouter key in INCARNAMIND_LIVE_DECISION_KEY; writes its counts to
 * INCARNAMIND_LIVE_GATE_OUT when set.
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { libraryScore } from "../../src/core/answers/checks/decisionLibrary";
import { decisionLinesFor } from "../../src/core/answers/checks/decisionLines";
import { sortScore } from "../../src/core/answers/checks/decisionSort";
import { decisionEndpoint } from "../../src/core/providers/catalog/decisions";
import { askJev } from "../../src/core/providers/jev";
import { slots } from "../../src/core/runs/stop";
import { ADVICE, DUTY_PAIRS } from "./dutySentences.cases";
import { EVERYDAY_PAIRS } from "./everydaySentences.cases";
import { FIELD_PAIRS } from "./fieldSentences.cases";
import { JUDGEMENT_NOTES } from "./judgementSentences.cases";
import { LIBRARY_CASES } from "./libraryFacts.cases";
import { REMARK_NOTES } from "./remarkSentences.cases";
import { linesOf, STRUCTURED_NOTES } from "./structuredNotes.cases";

const KEY = process.env.INCARNAMIND_LIVE_DECISION_KEY;
const OUT = process.env.INCARNAMIND_LIVE_GATE_OUT;
const HOST = "openrouter";
const MODEL = "perplexity/pplx-decider-v1.2";

interface Asked {
  set: string;
  sentence: string;
  fact: boolean;
}

const pairs = (set: string, all: readonly { right: string; wrong: string }[]): Asked[] =>
  all.flatMap(({ right, wrong }) => [
    { set, sentence: right, fact: true },
    { set, sentence: wrong, fact: true },
  ]);
const lines = (
  set: string,
  all: readonly { sentence: string; expected: "right" | "wrong" | "none" }[],
): Asked[] => all.map(({ sentence, expected }) => ({ set, sentence, fact: expected !== "none" }));

const ASKED: Asked[] = [
  ...lines(
    "remark and memo Notes",
    [...REMARK_NOTES, ...JUDGEMENT_NOTES].flatMap((note) => note.lines),
  ),
  ...lines("structured Notes", STRUCTURED_NOTES.flatMap(linesOf)),
  ...pairs("everyday pairs", EVERYDAY_PAIRS),
  ...pairs("field pairs", FIELD_PAIRS),
  ...pairs("duty pairs", DUTY_PAIRS),
  ...ADVICE.map(({ sentence }) => ({ set: "advice", sentence, fact: false })),
];

/** Sentences about a Library, in shapes the Library cases lack; no Library holds them. */
const OTHER_LIBRARY_SENTENCES = [
  "There are three PDFs in the Contracts folder.",
  "None of your files is tagged urgent.",
  "The note called Weekly sync sits in the Meetings folder.",
  "You have two spreadsheets and one slide deck.",
  "The Archive folder is inside the Projects folder.",
  "Five of the documents are tagged 2025.",
  "No document here is named Lease draft.",
  "Your notes include one called Board prep.",
  "Most of your documents are PDFs.",
  "The Invoices folder is empty.",
  "合同文件夹里有三个 PDF。",
  "你的文件里没有一个带“紧急”标签。",
  "名为“周会”的笔记放在“会议”文件夹里。",
  "你有两个表格和一个演示文稿。",
  "有五个文档带“2025”标签。",
  "资料库里没有叫“租约草稿”的文档。",
  "你的大部分文档是 PDF。",
  "“发票”文件夹是空的。",
];

const ABOUT_LIBRARY = [
  ...Object.values(LIBRARY_CASES).flatMap((cases) =>
    cases.filter((each) => each.aboutLibrary).map((each) => each.sentence),
  ),
  ...OTHER_LIBRARY_SENTENCES,
];

function readerOf() {
  const endpoint = decisionEndpoint(HOST, MODEL, { account: null, region: null });
  if (!endpoint || !KEY) throw new Error("The decision model has no endpoint or no key.");
  const atOnce = slots(16);
  const counts = { failed: 0 };
  const ask = (
    state: Record<string, unknown>,
    questions: Parameters<typeof askJev>[0]["questions"],
    signal: AbortSignal,
  ) =>
    atOnce.run(() =>
      askJev({
        baseUrl: endpoint.url,
        endpoint,
        apiKey: KEY,
        model: MODEL,
        state,
        questions,
        signal,
        retries: 1,
        timeoutMs: 15_000,
      }).catch(() => {
        counts.failed += 1;
        return null;
      }),
    );
  return { reader: { ask }, counts };
}

test.skipIf(!KEY)(
  "no fact is left out of the check by the decision model's sort",
  {
    timeout: 300_000,
  },
  async () => {
    const line = decisionLinesFor(HOST, MODEL)?.sort;
    if (line === undefined) throw new Error("The model has no sorting line.");
    const { reader, counts } = readerOf();
    const started = Date.now();
    const stop = new AbortController();
    const asked = [
      ...ASKED,
      ...ABOUT_LIBRARY.map((sentence) => ({ set: "about the Library", sentence, fact: true })),
    ];
    const scored = await Promise.all(
      asked.map(async (each) => ({
        ...each,
        score: await sortScore(reader, each.sentence, stop.signal),
      })),
    );
    const seconds = (Date.now() - started) / 1000;
    const sets = [...new Set(asked.map((each) => each.set))].map((set) => {
      const of = scored.filter((each) => each.set === set);
      const facts = of.filter((each) => each.fact);
      const others = of.filter((each) => !each.fact);
      const under = (all: typeof of) => all.filter((each) => (each.score ?? 1) < line).length;
      return {
        set,
        facts: facts.length,
        factsLeftOut: under(facts),
        ...(facts.length > 0 && { lowestFact: Math.min(...facts.map((each) => each.score ?? 1)) }),
        others: others.length,
        othersLeftOut: under(others),
      };
    });
    const report = { model: MODEL, line, requests: asked.length, ...counts, seconds, sets };
    if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    expect(counts.failed).toBe(0);
    expect(sets.map(({ set, factsLeftOut }) => ({ set, factsLeftOut }))).toEqual(
      sets.map(({ set }) => ({ set, factsLeftOut: 0 })),
    );
  },
);

test.skipIf(!KEY)(
  "every sentence about the Library scores over the line that leaves it to its own check",
  {
    timeout: 300_000,
  },
  async () => {
    const line = decisionLinesFor(HOST, MODEL)?.library;
    const { reader, counts } = readerOf();
    const stop = new AbortController();
    const score = (sentence: string) => libraryScore(reader, sentence, stop.signal);
    const about = await Promise.all(ABOUT_LIBRARY.map(score));
    const others = await Promise.all(ASKED.map(({ sentence }) => score(sentence)));
    const atOrOver = (at: number) => others.filter((each) => (each ?? 1) >= at).length;
    const report = {
      model: MODEL,
      line,
      ...counts,
      aboutLibrary: about.length,
      lowest: [...about].sort((a, b) => (a ?? 1) - (b ?? 1)).slice(0, 5),
      others: others.length,
      othersAtOrOver: Object.fromEntries(
        [0.05, 0.1, 0.2, 0.3, 0.5].map((at) => [at, atOrOver(at)]),
      ),
    };
    if (OUT)
      writeFileSync(
        OUT.replace(/(\.json)?$/, ".library.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    expect(counts.failed).toBe(0);
    expect(line).toBeDefined();
    expect(about.filter((each) => (each ?? 0) < (line ?? 1))).toEqual([]);
  },
);
