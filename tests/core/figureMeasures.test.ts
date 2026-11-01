/**
 * A figure is never Supported by a quote that gives the same number about something else (#2255):
 * each Figures item names, in words copied from the sentence and from its quote, what the number
 * measures, and whether the two are the same measure. The check finds those words where the reply
 * says it copied them; an equal number that measures something else needs a look, and words it
 * can't find never make a figure Supported. A bare table cell keeps its row label and headings.
 *
 * Figures are checked one by one only in a Note's check (`core.checkClaim` takes no figures), so
 * these go through Check this Note, as the editor runs it.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { FigureCheckAttributes } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { isCheckRun, listedSentences, requestedFigures, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";

/** How the model checks one figure: the quote it records, the number it binds and the measure it names. */
interface Reply {
  quote: string;
  number: string;
  measure: unknown;
}

const EN_DOCUMENT = {
  name: "Larkfield results 2025.md",
  contents: [
    "# Larkfield results 2025",
    "",
    "Revenue grew 12% in 2025, to £48.2m.",
    "",
    "| Measure | 2025 |",
    "| --- | --- |",
    "| Gross margin | 31% |",
    "| Net debt to EBITDA | 1.4x |",
    "",
    "| Depot | On-time rate |",
    "| --- | --- |",
    "| Felixstowe | 94% |",
    "",
  ].join("\n"),
};

const ZH_DOCUMENT = {
  name: "明川食品2025年业绩.md",
  contents: [
    "# 明川食品2025年业绩",
    "",
    "2025年收入增长12%，达到4.82亿元。",
    "",
    "| 指标 | 2025年 |",
    "| --- | --- |",
    "| 毛利率 | 31% |",
    "",
  ].join("\n"),
};

const paragraph = (id: string, value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text: value }],
});

const cell = (value: string, header = false): JSONContent => ({
  type: header ? "tableHeader" : "tableCell",
  content: [paragraph(randomUUID(), value)],
});

const table = (head: readonly string[], rows: readonly (readonly string[])[]): JSONContent => ({
  type: "table",
  attrs: { id: "table" },
  content: [
    { type: "tableRow", content: head.map((value) => cell(value, true)) },
    ...rows.map((row) => ({ type: "tableRow", content: row.map((value) => cell(value)) })),
  ],
});

/**
 * A model that searches, records `reply.quote` as marker 1 and calls each figure Supported on it,
 * with the topic found: the sloppy reply #2255 found, whatever the measure it names says.
 */
function checking(replies: (call: ModelCall) => Reply, calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      calls.push(call);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
      const planned = replies(call);
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
          each.text.includes(planned.quote),
        );
        if (!passage) throw new Error(`The fixture's quote isn't shown: ${planned.quote}`);
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: planned.quote }] },
            },
          ],
        };
      }
      const items = requestedFigures(call).map(({ id }) => ({
        id,
        verdict: "supported",
        scope: "same",
        topic: "found",
        roles: "same",
        measure: planned.measure,
        says: null,
        reading: null,
        relation: "equals",
        source: { citation: 1, number: planned.number, reading: null, unitQuote: null },
        calculation: null,
      }));
      return {
        text: [
          "Verdict: supported",
          "Absence: no",
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Time: none / none, same",
          `The Document gives ${planned.number} [^1].`,
          `Figures: ${JSON.stringify({ items, remainder: null })}`,
        ].join("\n"),
      };
    },
    {
      // Asked which sentences make claims, each is one fact.
      generate: (call) =>
        call.system.startsWith("You sort the sentences")
          ? {
              text: JSON.stringify({
                sentences: listedSentences(call.prompt).map(({ number, text }) => ({
                  number,
                  parts: [{ kind: "fact", text }],
                })),
              }),
            }
          : { text: JSON.stringify({ passage: null }) },
    },
  );
}

/** Checks `blocks` as one Note with `replies`, in the interface's `language`; each figure's check. */
async function checkNote(
  language: Language,
  document: { name: string; contents: string },
  blocks: JSONContent[],
  replies: (call: ModelCall) => Reply,
) {
  const calls: ModelCall[] = [];
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(checking(replies, calls)).createChatModel,
  });
  await core.updateSettings({ user: { language } });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, document.name, document.contents)]);
  const mind = await core.createMind({ title: "Results" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, blocks);
  await client.settled();
  expect(await core.checkMind({ requestId: "check", mindId: mind.id, mode: "all" })).toMatchObject({
    kind: "checked",
  });
  await client.settled();
  const figures = claimSpans(readMind(client)).flatMap(({ sentence, check }) =>
    (check.figures ?? []).map((figure: FigureCheckAttributes) => ({
      sentence: sentence.text.trim(),
      sentenceState: check.state,
      shown: figure.reading.chars,
      state: figure.state,
      reason: figure.reason,
      why: figure.unsupported?.reason ?? null,
      sentenceWhy: check.unsupported?.reason ?? null,
    })),
  );
  core.close();
  return { figures, calls };
}

const one = (sentence: string, reply: Reply) => (call: ModelCall) => {
  if (sentenceOf(call) !== sentence) throw new Error(`No reply planned for ${sentenceOf(call)}`);
  return reply;
};

describe.each([
  {
    language: "en" as const,
    document: EN_DOCUMENT,
    wrong: "Operating margin was 12% in 2025.",
    right: "Revenue grew 12% in 2025.",
    quote: "Revenue grew 12% in 2025, to £48.2m.",
    claimed: "Operating margin",
    measured: "Revenue",
    reason: "The Document gives 12% for revenue, not for operating margin.",
  },
  {
    language: "zh-CN" as const,
    document: ZH_DOCUMENT,
    wrong: "2025年营业利润率为12%。",
    right: "2025年收入增长了12%。",
    quote: "2025年收入增长12%，达到4.82亿元。",
    claimed: "营业利润率",
    measured: "收入",
    reason: "文档中的 12% 指的是收入，而不是营业利润率。",
  },
])("the same number about another measure ($language)", (example) => {
  // protects=a figure bound to a quote whose equal number measures something else needs a look, with the plain reason, even when the model calls it supported with the topic found (#2255); fails_when=the figure or its sentence shows Supported, or the reason names the wrong measures; no_claim=that a real model names the measures this way.
  test("an equal number about another measure is never Supported, and says what it measures", async () => {
    const { figures } = await checkNote(
      example.language,
      example.document,
      [paragraph("wrong", example.wrong)],
      one(example.wrong, {
        quote: example.quote,
        number: "12%",
        measure: { sentence: example.claimed, quote: example.measured, match: "differs" },
      }),
    );
    expect(figures).toEqual([
      {
        sentence: example.wrong,
        sentenceState: "unsupported",
        shown: "12%",
        state: "unsupported",
        reason: null,
        why: example.reason,
        sentenceWhy: example.reason,
      },
    ]);
  });

  // protects=the right measure's quote still supports its figure, its words found in the sentence and the quote (#2255); fails_when=a figure whose measure matches isn't Supported; no_claim=none beyond protects.
  test("the quote about the figure's own measure supports it", async () => {
    const { figures } = await checkNote(
      example.language,
      example.document,
      [paragraph("right", example.right)],
      one(example.right, {
        quote: example.quote,
        number: "12%",
        measure: { sentence: example.measured, quote: example.measured, match: "same" },
      }),
    );
    expect(figures).toMatchObject([
      { sentence: example.right, sentenceState: "supported", state: "supported" },
    ]);
  });

  // protects=the check finds the measure's words where the reply says it copied them, so words the quote doesn't hold, a measure left out or the number alone never make a figure Supported (#2255); fails_when=any of these is Supported; no_claim=which words a real model copies.
  test.each([
    { name: "words the quote doesn't hold", quote: "operating margin", sentence: null },
    { name: "words the sentence doesn't hold", quote: null, sentence: "gross margin" },
    { name: "the number alone", quote: "12%", sentence: "12%" },
    { name: "no measure", quote: undefined, sentence: undefined },
  ])("a measure it can't find, $name, is never Supported", async ({ quote, sentence }) => {
    const measure =
      quote === undefined
        ? null
        : {
            sentence: sentence ?? example.claimed,
            quote: quote ?? example.measured,
            match: "same",
          };
    const { figures } = await checkNote(
      example.language,
      example.document,
      [paragraph("wrong", example.wrong)],
      one(example.wrong, { quote: example.quote, number: "12%", measure }),
    );
    expect(figures).toMatchObject([
      { sentence: example.wrong, state: "not-checked", reason: "malformed" },
    ]);
    expect(figures[0]?.sentenceState).not.toBe("supported");
  });
});

// protects=a model names a measure's words around its number, joining them across it ("employed drivers" for "employed 1,840 drivers"), and the check still finds them; a measure it calls different backs nothing even when its words for the quote's aren't found there (#2255); fails_when=words joined across the number aren't found, or a "differs" with words the quote lacks is Supported or Not checked; no_claim=none beyond protects.
test.each([
  {
    measure: { sentence: "Revenue grew in 2025", quote: "Revenue grew in 2025", match: "same" },
    state: "supported",
  },
  {
    measure: { sentence: "Revenue grew", quote: "turnover", match: "differs" },
    state: "unsupported",
  },
])("words joined across the number, or a differs: $measure.match", async ({ measure, state }) => {
  const sentence = "Revenue grew 12% in 2025.";
  const { figures } = await checkNote(
    "en",
    EN_DOCUMENT,
    [paragraph("joined", sentence)],
    one(sentence, { quote: "Revenue grew 12% in 2025, to £48.2m.", number: "12%", measure }),
  );
  expect(figures).toMatchObject([{ sentence, state, why: null }]);
});

// protects=a Chinese sentence checked against an English Document gets the reason in Chinese, the quote's English words spaced from the Chinese around them (docs/agents/zh-CN.md), and its own Chinese measure in its place (#2255); fails_when=the reason runs Latin words into Chinese or names the measures the wrong way round; no_claim=how a real model words either measure.
test("the reason names an English quote's measure in a Chinese sentence's reason", async () => {
  const sentence = "2025年营业利润率为12%。";
  const { figures } = await checkNote(
    "zh-CN",
    EN_DOCUMENT,
    [paragraph("mixed", sentence)],
    one(sentence, {
      quote: "Revenue grew 12% in 2025, to £48.2m.",
      number: "12%",
      measure: { sentence: "营业利润率", quote: "Revenue", match: "differs" },
    }),
  );
  expect(figures).toMatchObject([
    { sentence, state: "unsupported", why: "文档中的 12% 指的是 revenue，而不是营业利润率。" },
  ]);
});

describe("a table's row label and headings say what a cell measures (#2255)", () => {
  // protects=a Note's table cell is named by its row label, so the label is the sentence's words for what the cell measures: the row that names the quote's measure is Supported, the row that names another is not (#2255); fails_when=a cell's label can't serve as its measure, or the other row's cell shows Supported; no_claim=how a real model names a row.
  test.each([
    {
      language: "en" as const,
      document: EN_DOCUMENT,
      head: ["Measure", "2025"],
      right: "Revenue growth",
      wrong: "Operating margin",
      quote: "Revenue grew 12% in 2025, to £48.2m.",
      measured: "Revenue",
      reason: "The Document gives 12% for revenue, not for operating margin.",
    },
    {
      language: "zh-CN" as const,
      document: ZH_DOCUMENT,
      head: ["指标", "2025年"],
      right: "收入增长",
      wrong: "营业利润率",
      quote: "2025年收入增长12%，达到4.82亿元。",
      measured: "收入增长",
      reason: "文档中的 12% 指的是收入增长，而不是营业利润率。",
    },
  ])("a Note's row label ($language)", async (example) => {
    const { figures } = await checkNote(
      example.language,
      example.document,
      [
        table(example.head, [
          [example.right, "12%"],
          [example.wrong, "12%"],
        ]),
      ],
      (call) => {
        const [figure] = requestedFigures(call);
        const label = figure?.label ?? "";
        const row = label.startsWith(example.right) ? example.right : example.wrong;
        return {
          quote: example.quote,
          number: "12%",
          measure: {
            sentence: row,
            quote: example.measured,
            match: row === example.right ? "same" : "differs",
          },
        };
      },
    );
    expect(figures.map(({ state, why }) => ({ state, why }))).toEqual([
      { state: "supported", why: null },
      { state: "unsupported", why: example.reason },
    ]);
  });

  // protects=a model may name a cell's measure by joining its row label and its table's caption ("生鲜食品 分部收入", as Claude Haiku 5.5 did), each piece the cell's own words (#2255); fails_when=a measure joined from the cell's own label and caption isn't found; no_claim=none beyond protects.
  test("a cell's measure joined from its row label and its table's caption", async () => {
    const { figures } = await checkNote(
      "zh-CN",
      ZH_DOCUMENT,
      [paragraph("caption", "2025年分部指标"), table(["指标", "2025年"], [["收入增长", "12%"]])],
      () => ({
        quote: "2025年收入增长12%，达到4.82亿元。",
        number: "12%",
        measure: { sentence: "收入增长 分部指标", quote: "收入增长", match: "same" },
      }),
    );
    expect(figures).toMatchObject([{ state: "supported" }]);
  });

  // protects=a quote that is a Document's bare table cell names nothing but its number, so its row label, copied from its Passage, says what it measures, and with no words named the check keeps the table's headings to the model's judgement as before, its "differs" included; a row label the Document doesn't hold is never Supported (#2255); fails_when=a bare cell can't be Supported on its row label or on no words, or is Supported on a label its Document lacks or on a measure the model says differs; no_claim=none beyond protects.
  test.each([
    {
      measure: { sentence: "Gross margin", quote: "Gross margin", match: "same" },
      state: "supported",
    },
    { measure: { sentence: "Gross margin", quote: null, match: "same" }, state: "supported" },
    { measure: { sentence: "Gross margin", quote: null, match: "differs" }, state: "unsupported" },
    {
      measure: { sentence: "Gross margin", quote: "Operating margin", match: "same" },
      state: "not-checked",
    },
  ])("a Document's bare cell: $measure.quote", async ({ measure, state }) => {
    const sentence = "Gross margin was 31% in 2025.";
    const { figures } = await checkNote(
      "en",
      EN_DOCUMENT,
      [paragraph("margin", sentence)],
      one(sentence, { quote: "31%", number: "31%", measure }),
    );
    expect(figures).toMatchObject([{ sentence, state }]);
  });

  // protects=a quote of a table's row names its row (a depot), and the column's heading what its number measures, so the heading, copied from the table, counts as the quote's words; words its table doesn't hold never do, and a quote outside a table takes none from the rest of its Passage (#2255); fails_when=a row quote can't be Supported on its column's heading, or a quote is Supported on words found elsewhere in its Document; no_claim=how a real model quotes a row.
  test.each([
    {
      sentence: "Felixstowe's on-time rate was 94% in 2025.",
      quote: "Felixstowe | 94%",
      measure: { sentence: "on-time rate", quote: "On-time rate", match: "same" },
      state: "supported",
    },
    {
      sentence: "Felixstowe's on-time rate was 94% in 2025.",
      quote: "Felixstowe | 94%",
      measure: { sentence: "on-time rate", quote: "Space occupancy", match: "same" },
      state: "not-checked",
    },
    {
      sentence: "Gross margin grew 12% in 2025.",
      quote: "Revenue grew 12% in 2025, to £48.2m.",
      measure: { sentence: "Gross margin", quote: "Gross margin", match: "same" },
      state: "not-checked",
    },
  ])(
    "a row's column heading: $measure.quote for $quote",
    async ({ sentence, quote, measure, state }) => {
      const number = quote.includes("94%") ? "94%" : "12%";
      const { figures } = await checkNote(
        "en",
        EN_DOCUMENT,
        [paragraph("row", sentence)],
        one(sentence, { quote, number, measure }),
      );
      expect(figures).toMatchObject([{ sentence, state }]);
    },
  );
});
