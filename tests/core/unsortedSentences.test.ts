/**
 * Check this Note never leaves a figure unchecked on the sort's word alone (#2447): a sentence with a
 * figure, a Citation or a record cite that no reply decides is checked all the same, and a table's
 * value cell goes to the sort with its row's label and its column's heading and is checked whatever
 * the sort, or a run that left out the same words, said of it.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { CITATION_NODE, MIND_SETTINGS_FIELD } from "../../src/core/api";
import { mindCheckOf, sentenceKey } from "../../src/shared/mindCheck";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  sentenceOf,
} from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

interface Pack {
  language: "en" | "zh-CN";
  source: { name: string; text: string };
  /** A sentence with a wrong figure. */
  figure: string;
  /** A sentence with neither a figure nor a Citation. */
  plain: string;
  /** A sentence with a Citation and no figure. */
  cited: string;
  /** A sentence with a record cite and no figure. */
  record: string;
  /** A question with a figure: no claim. */
  question: string;
  caption: string;
  head: [string, string];
  /** Each row's label and its value: the second label holds a figure, and its value is wrong. */
  rows: [[string, string], [string, string]];
  plans: Record<string, Plan>;
}

const figurePlan = (verdict: "supported" | "contradicted", quote: string, number: string) => ({
  verdict,
  quote,
  number,
  says: verdict === "supported" ? "It says so." : "It gives another figure.",
  judgement: "conflict" as const,
});

const PACKS: Pack[] = [
  {
    language: "en",
    source: {
      name: "Harbour accounts.md",
      text: [
        "# Harbour accounts, Q3 2025",
        "",
        "Groceries and household revenue was 2,100 in Q3 2025.",
        "",
        "Fuel at depot 4 brought in 450 in Q3 2025.",
        "",
        "The harbour employed 84 pilots in the quarter.",
      ].join("\n"),
    },
    figure: "The harbour employed 48 pilots in the quarter.",
    plain: "Penguins nest on the cliffs above the harbour.",
    cited: "The harbour office publishes the tide tables.",
    record: "The harbour master left early (Smith Dep. 45:3–12).",
    question: "Did fuel bring in 540 in the quarter?",
    caption: "Revenue by segment, Q3 2025",
    head: ["Segment", "Q3 2025"],
    rows: [
      ["Groceries and household", "2,100"],
      ["Fuel at depot 4", "540"],
    ],
    plans: {
      "The harbour employed 48 pilots in the quarter.": figurePlan(
        "contradicted",
        "The harbour employed 84 pilots in the quarter.",
        "84",
      ),
      "The harbour office publishes the tide tables.": { verdict: "unsupported" },
      "2,100": figurePlan(
        "supported",
        "Groceries and household revenue was 2,100 in Q3 2025.",
        "2,100",
      ),
      "540": figurePlan("contradicted", "Fuel at depot 4 brought in 450 in Q3 2025.", "450"),
    },
  },
  {
    language: "zh-CN",
    source: {
      name: "港口账目.md",
      text: [
        "# 港口2025年第三季度账目",
        "",
        "2025年第三季度日用食品及家居收入为2,100。",
        "",
        "2025年第三季度4号油站燃油收入为450。",
        "",
        "本季度港口共有84名引航员。",
      ].join("\n"),
    },
    figure: "本季度港口共有48名引航员。",
    plain: "企鹅在港口上方的悬崖筑巢。",
    cited: "港务处会公布潮汐表。",
    record: "港务长提前离开（Smith Dep. 45:3–12）。",
    question: "本季度燃油收入是540吗？",
    caption: "2025年第三季度分部收入",
    head: ["分部", "2025年第三季度"],
    rows: [
      ["日用食品及家居", "2,100"],
      ["4号油站燃油", "540"],
    ],
    plans: {
      "本季度港口共有48名引航员。": figurePlan("contradicted", "本季度港口共有84名引航员。", "84"),
      "港务处会公布潮汐表。": { verdict: "unsupported" },
      "2,100": figurePlan("supported", "2025年第三季度日用食品及家居收入为2,100。", "2,100"),
      "540": figurePlan("contradicted", "2025年第三季度4号油站燃油收入为450。", "450"),
    },
  },
];

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content,
});
const cell = (value: string, header = false): JSONContent => ({
  type: header ? "tableHeader" : "tableCell",
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(text(value))],
});
const table = (pack: Pack): JSONContent[] => [
  paragraph(text(pack.caption)),
  {
    type: "table",
    attrs: { id: randomUUID() },
    content: [
      { type: "tableRow", content: pack.head.map((value) => cell(value, true)) },
      ...pack.rows.map((row) => ({ type: "tableRow", content: row.map((each) => cell(each)) })),
    ],
  },
];
const citation = (quote: string) => ({
  type: CITATION_NODE,
  attrs: {
    id: "c1",
    passageId: "passage-office",
    documentId: "office",
    documentName: "Harbour office",
    contentHash: "hash-office",
    quote,
    check: "found",
  },
});

interface Sorted {
  number: number;
  parts: { kind: "fact"; text: string }[];
}
/** A sort's reply to one request: each record it decides, by its number. */
type Sorter = (
  records: { number: number; text: string; row?: string; column?: string }[],
) => Sorted[];

/**
 * The Note written as `blocks` and checked whole, its sort replying as `sorter` says; `before`, the
 * last whole-Note check's record it is checked after, in "changed" mode.
 */
async function checkedNote(
  pack: Pack,
  blocks: JSONContent[],
  sorter: Sorter,
  before?: { skipped: string[] },
) {
  const runs: ModelCall[] = [];
  const sorts: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call) || call.results.length > 0) return checkReply(call, pack.plans);
      runs.push(call);
      // A Run names its sentence's parts in its first turn, as its instructions ask, and searches
      // with the words it will quote: a bare cell's own words find nothing.
      const sentence = sentenceOf(call);
      const parts = JSON.stringify([{ kind: "fact", text: sentence }]);
      const query = pack.plans[sentence]?.quote ?? sentence;
      return { text: `Parts: ${parts}`, calls: [{ tool: "search_documents", input: { query } }] };
    },
    {
      generate: (call) => {
        if (call.question !== "find-claims") return checkGenerate(pack.plans)(call);
        sorts.push(call);
        const { sentences } = JSON.parse(call.prompt) as { sentences: Parameters<Sorter>[0] };
        return { text: JSON.stringify({ sentences: sorter(sentences) }) };
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  await core.updateSettings({ user: { language: pack.language } });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, pack.source.name, pack.source.text)]);
  const mind = await core.createMind({ title: "Q3 memo" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, blocks);
  if (before)
    client.doc.getMap(MIND_SETTINGS_FIELD).set("mindCheck", {
      at: "2026-10-01T09:00:00.000Z",
      sentences: 0,
      stop: null,
      skipped: before.skipped,
      unexamined: [],
    });
  await client.settled();
  await core.checkMind({
    requestId: randomUUID(),
    mindId: mind.id,
    mode: before ? "changed" : "all",
  });
  await client.settled();
  const schedule = await core.getFigureSchedule(mind.id);
  return {
    sent: runs.map(sentenceOf),
    sorts,
    /** How each figure written with these characters first shows, in the Note's order. */
    shown: (chars: string) =>
      schedule.rows
        .filter((row) => row.reading.chars.startsWith(chars))
        .map((row) => row.shown.state),
    run: mindCheckOf(client.doc),
  };
}

const fact = (words: string) => [{ kind: "fact" as const, text: words }];

describe.each(PACKS)("Check this Note in $language", (pack) => {
  test("a sentence with a figure, a Citation or a record cite that the sort says nothing of is checked; one with none is counted as unsorted", async () => {
    const silent = new Set([pack.figure, pack.plain, pack.cited, pack.record]);
    const { sent, sorts, shown, run } = await checkedNote(
      pack,
      [
        paragraph(text(pack.figure)),
        paragraph(text(pack.plain)),
        paragraph(text(pack.cited), citation(pack.cited)),
        paragraph(text(pack.record)),
      ],
      (records) =>
        records
          .filter((record) => !silent.has(record.text))
          .map(({ number, text: words }) => ({ number, parts: fact(words) })),
    );

    // Asked once and once more, the sort says nothing of any of the four.
    expect(sorts).toHaveLength(2);
    expect(listedSentences(sorts[1]?.prompt ?? "")).toHaveLength(4);
    expect(sent).toEqual([pack.figure, pack.cited, pack.record]);
    expect(shown("48")).toEqual(["contradicted"]);
    expect(run?.unexamined).toEqual([sentenceKey(pack.plain)]);
    expect(run?.skipped).toEqual([]);
  });

  test("a table's value cells go to the sort with their row's label and their column's heading, its labels as their own words alone, and only the values are checked", async () => {
    const [[groceries, first], [fuel, wrong]] = pack.rows;
    const { sent, sorts, shown, run } = await checkedNote(
      pack,
      table(pack),
      // Shown a row's label or a column's heading, the sort takes the record for a fact.
      (records) =>
        records.map(({ number, text: words, row, column }) => ({
          number,
          parts: row || column ? fact(words) : [],
        })),
    );

    expect(sorts).toHaveLength(1);
    expect(JSON.parse(sorts[0]?.prompt ?? "")).toEqual({
      sentences: [
        { number: 1, text: pack.caption },
        { number: 2, text: groceries },
        { number: 3, text: first, row: groceries, column: pack.head[1] },
        { number: 4, text: fuel },
        { number: 5, text: wrong, row: fuel, column: pack.head[1] },
      ],
    });
    expect(sent).toEqual(["2,100", "540"]);
    expect(shown("2,100")).toEqual(["supported"]);
    expect(shown("540")).toEqual(["contradicted"]);
    expect(run?.unexamined).toEqual([]);
  });

  test("a value cell's figure is checked though the sort names nothing in it; a question's figure is not", async () => {
    const { sent, shown, run } = await checkedNote(
      pack,
      [paragraph(text(pack.question)), ...table(pack)],
      (records) => records.map(({ number }) => ({ number, parts: [] })),
    );

    expect(sent).toEqual(["2,100", "540"]);
    expect(shown("540")).toEqual(["not-checked", "contradicted"]);
    expect(run?.skipped).toContain(sentenceKey(pack.question));
    expect(run?.skipped).not.toContain(sentenceKey("540"));
    expect(run?.unexamined).toEqual([]);
  });

  test("a value cell's figure is checked though the last run left out its words, as a run before #2447 did; the sentence outside the table stays left out", async () => {
    const [, [, wrong]] = pack.rows;
    const { sent, shown, run } = await checkedNote(
      pack,
      [paragraph(text(wrong)), ...table(pack)],
      (records) =>
        records.map(({ number, text: words, row, column }) => ({
          number,
          parts: row || column ? fact(words) : [],
        })),
      { skipped: [sentenceKey(wrong)] },
    );

    expect(sent).toEqual(["2,100", "540"]);
    expect(shown("540")).toEqual(["not-checked", "contradicted"]);
    expect(run?.skipped).toContain(sentenceKey(wrong));
  });

  test("a one-column table's cells are values: each goes to the sort with its column's heading and is checked though the sort names nothing in it", async () => {
    const [[, first], [, wrong]] = pack.rows;
    const { sent, sorts, shown } = await checkedNote(
      pack,
      [
        paragraph(text(pack.caption)),
        {
          type: "table",
          attrs: { id: randomUUID() },
          content: [pack.head[1], first, wrong].map((value, at) => ({
            type: "tableRow",
            content: [cell(value, at === 0)],
          })),
        },
      ],
      (records) => records.map(({ number }) => ({ number, parts: [] })),
    );

    expect(JSON.parse(sorts[0]?.prompt ?? "")).toEqual({
      sentences: [
        { number: 1, text: pack.caption },
        { number: 2, text: first, column: pack.head[1] },
        { number: 3, text: wrong, column: pack.head[1] },
      ],
    });
    expect(sent).toEqual(["2,100", "540"]);
    expect(shown("540")).toEqual(["contradicted"]);
  });
});
