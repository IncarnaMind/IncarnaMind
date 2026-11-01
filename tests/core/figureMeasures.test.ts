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
import { measureFinding } from "../../src/core/answers/checks/figureMeasures";
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
  /** The figure's verdict and the sentence's: supported when absent, the reply #2255 found. */
  verdict?: "supported" | "unsupported" | "contradicted";
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

/** A heading that names a measure above a line about another (#2255's review). */
const HEADED = {
  en: {
    name: "Harbour results 2025.md",
    contents: "## Operating margin\n\nRevenue grew 12% in 2025, to £48.2m.\n",
  },
  zh: { name: "港口业绩2025.md", contents: "## 营业利润率\n\n2025年收入增长12%，达到4.82亿元。\n" },
};

/** Rows whose numbers start the same. */
const ROWS = {
  name: "Depot measures 2025.md",
  contents: [
    "| Measure | 2025 |",
    "| --- | --- |",
    "| Operating margin | 21.5% |",
    "| Revenue growth | 21% |",
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
      const verdict = planned.verdict ?? "supported";
      const items = requestedFigures(call).map(({ id }) => ({
        id,
        verdict,
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
          `Verdict: ${verdict}`,
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
    reason: "The Document gives 12% for Revenue, not for Operating margin.",
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

  // protects=the check finds the measure's words where the reply says it copied them, so words the quote doesn't hold, a measure left out, the number alone, or a match that is neither same nor differs never make a figure Supported (#2255); fails_when=any of these is Supported; no_claim=which words a real model copies.
  test.each([
    { name: "words the quote doesn't hold", quote: "operating margin", sentence: null },
    { name: "words the sentence doesn't hold", quote: null, sentence: "gross margin" },
    { name: "the number alone", quote: "12%", sentence: "12%" },
    { name: "no measure", quote: undefined, sentence: undefined },
    { name: "a match of yes", quote: null, sentence: null, match: "yes" },
  ])(
    "a measure it can't find, $name, is never Supported",
    async ({ quote, sentence, match = "same" }) => {
      const measure =
        quote === undefined
          ? null
          : {
              sentence: sentence ?? example.claimed,
              quote: quote ?? example.measured,
              match,
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
    },
  );

  // protects=a number quoted alone from prose has its measure in its own sentence, so the reply names it from there: with no words, or empty ones, it is never Supported, as only a table's cell may name nothing; with its sentence's words it is (#2255); fails_when=a bare prose quote is Supported on no words, or not on its sentence's; no_claim=none beyond protects.
  test.each([
    { sentence: example.wrong, words: null, said: example.claimed, state: "not-checked" },
    { sentence: example.wrong, words: "", said: example.claimed, state: "not-checked" },
    {
      sentence: example.right,
      words: example.measured,
      said: example.measured,
      state: "supported",
    },
  ])("a number quoted alone from prose: $words", async ({ sentence, words, said, state }) => {
    const { figures } = await checkNote(
      example.language,
      example.document,
      [paragraph("bare", sentence)],
      one(sentence, {
        quote: "12%",
        number: "12%",
        measure: { sentence: said, quote: words, match: "same" },
      }),
    );
    expect(figures).toMatchObject([{ sentence, state }]);
  });

  // protects=the card gives the plain reason when the model itself calls the figure unsupported for another measure, as the check's instructions ask, and a figure it calls contradicted on another measure's number, even with the sentence's measure paraphrased, is Unsupported, never Contradicted (#2255); fails_when=the reason shows only on a wrong Supported reply, or another measure's number contradicts the figure; no_claim=none beyond protects.
  test.each([
    { verdict: "unsupported" as const, said: example.claimed, why: example.reason },
    { verdict: "contradicted" as const, said: `${example.claimed}s`, why: null },
  ])("another measure, called $verdict, is Unsupported", async ({ verdict, said, why }) => {
    const sentence = example.wrong.replace("12%", "15%");
    const { figures } = await checkNote(
      example.language,
      example.document,
      [paragraph("wrong", sentence)],
      one(sentence, {
        quote: example.quote,
        number: "12%",
        verdict,
        measure: { sentence: said, quote: example.measured, match: "differs" },
      }),
    );
    expect(figures).toMatchObject([{ sentence, state: "unsupported", ...(why && { why }) }]);
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
    { sentence, state: "unsupported", why: "文档中的 12% 指的是 Revenue，而不是营业利润率。" },
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
      reason: "The Document gives 12% for Revenue, not for Operating margin.",
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
    { measure: { sentence: "Gross margin", quote: "", match: "same" }, state: "not-checked" },
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

  // protects=a quote of a table's row names its row (a depot), and the column's heading what its number measures, so the heading, copied from the table, counts as the quote's words; a clause ("to £48.2m") takes them from its sentence before it; words its table doesn't hold, or another row's label, never do, and a quote outside a table takes none from the rest of its Passage (#2255); fails_when=a row quote can't be Supported on its column's heading, a clause on its sentence's subject, or a quote is Supported on another row's label or on words found elsewhere in its Document; no_claim=how a real model quotes a row.
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
      sentence: "Revenue reached £48.2m in 2025.",
      quote: "to £48.2m",
      measure: { sentence: "Revenue", quote: "Revenue", match: "same" },
      state: "supported",
    },
    {
      sentence: "Gross margin was 1.4x in 2025.",
      quote: "1.4x",
      measure: { sentence: "Gross margin", quote: "Gross margin", match: "same" },
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
      const number = ["94%", "£48.2m", "12%", "1.4x"].find((each) => quote.includes(each)) ?? "";
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

describe("where a quote's words may come from (#2255's review)", () => {
  // protects=a heading is never part of a quote's sentence: words above the quote's line don't name its number, in English and Chinese, while a clause still takes its sentence's subject (#2255); fails_when=a heading's measure makes another measure's figure Supported, or the clause loses its subject; no_claim=none beyond protects.
  test.each([
    {
      language: "en" as const,
      document: HEADED.en,
      sentence: "Operating margin was 12% in 2025.",
      quote: "Revenue grew 12% in 2025",
      number: "12%",
      measure: { sentence: "Operating margin", quote: "Operating margin", match: "same" },
      state: "not-checked",
    },
    {
      language: "en" as const,
      document: HEADED.en,
      sentence: "Revenue reached £48.2m in 2025.",
      quote: "to £48.2m",
      number: "£48.2m",
      measure: { sentence: "Revenue", quote: "Revenue", match: "same" },
      state: "supported",
    },
    {
      language: "zh-CN" as const,
      document: HEADED.zh,
      sentence: "2025年营业利润率为12%。",
      quote: "2025年收入增长12%",
      number: "12%",
      measure: { sentence: "营业利润率", quote: "营业利润率", match: "same" },
      state: "not-checked",
    },
  ])("a heading above the quote: $sentence", async ({ language, document, sentence, ...reply }) => {
    const { figures } = await checkNote(language, document, [paragraph("h", sentence)], () => ({
      quote: reply.quote,
      number: reply.number,
      measure: reply.measure,
    }));
    expect(figures).toMatchObject([{ sentence, state: reply.state }]);
  });

  // protects=a cell's row is found by the quote's text, so "21%" is the "21%" row's, never the "21.5%" row's (#2255); fails_when=another row's label makes a figure Supported; no_claim=none beyond protects.
  test.each([
    {
      sentence: "Operating margin was 21% in 2025.",
      quote: "21%",
      row: "Operating margin",
      state: "not-checked",
    },
    {
      sentence: "Revenue growth was 21% in 2025.",
      quote: "21%",
      row: "Revenue growth",
      state: "supported",
    },
  ])("a cell's own row: $quote for $row", async ({ sentence, quote, row, state }) => {
    const { figures } = await checkNote("en", ROWS, [paragraph("r", sentence)], () => ({
      quote,
      number: quote,
      measure: { sentence: row, quote: row, match: "same" },
    }));
    expect(figures).toMatchObject([{ sentence, state }]);
  });

  // protects=the sentence's words for its measure may be in its paragraph, where "It" gets its subject, and are then the sentence's own (#2255); fails_when=a figure whose measure only its paragraph names can't be Supported; no_claim=that words from another sentence of the paragraph name the right figure.
  test("the paragraph names the measure a sentence refers to", async () => {
    const text = "Revenue was the year's story. It grew 12% in 2025.";
    const { figures } = await checkNote("en", EN_DOCUMENT, [paragraph("p", text)], () => ({
      quote: "Revenue grew 12% in 2025, to £48.2m.",
      number: "12%",
      measure: { sentence: "Revenue", quote: "Revenue", match: "same" },
    }));
    expect(figures).toMatchObject([{ sentence: "It grew 12% in 2025.", state: "supported" }]);
  });

  // protects=a quote is placed by the first text that holds it, its cited pages before the rest of its Document, so a number its page holds once is placed there though the Document holds it twice; a Document's second "12%" never lends its words (#2255); fails_when=the cited page doesn't decide; no_claim=none beyond protects.
  test("the cited page places a quote its Document holds twice", () => {
    const page = "Revenue grew 12% in 2025.";
    const document = `${page}\n\nOperating margin was 12% in 2024.`;
    const sentence = (said: string) => [`${said} was 12% in 2025.`];
    const finding = (said: string) =>
      measureFinding({ sentence: said, quote: null, match: "same" }, sentence(said), "12%", () => [
        page,
        document,
      ]).kind;
    const named = (said: string) =>
      measureFinding({ sentence: said, quote: said, match: "same" }, sentence(said), "12%", () => [
        page,
        document,
      ]).kind;
    expect([named("Revenue"), named("Operating margin"), finding("Revenue")]).toEqual([
      "same",
      "unread",
      "unread",
    ]);
  });

  // protects=a quote is placed only where its text stands as a number of its own ("21%" not inside "121%" or "1.21%"), and a text that holds it twice places it nowhere, so neither row's label names it, though a Passage the citation reads may hold it once; a text that holds it once places it (#2255); fails_when=a quote is placed inside a longer number, or in the first of two rows; no_claim=none beyond protects.
  test.each([
    {
      rows: ["| Margin index | 121% |", "| Revenue growth | 21% |"],
      row: "Revenue growth",
      kind: "same",
    },
    {
      rows: ["| Margin index | 1.21% |", "| Revenue growth | 21% |"],
      row: "Revenue growth",
      kind: "same",
    },
    {
      rows: ["| Headcount growth | 21% |", "| Depot growth | 21% |"],
      row: "Headcount growth",
      kind: "unread",
    },
  ])("a quote placed once, as text: $rows", ({ rows, row, kind }) => {
    const text = ["| Measure | 2025 |", "| --- | --- |", ...rows].join("\n");
    const finding = measureFinding(
      { sentence: row, quote: row, match: "same" },
      [`${row} was 21% in 2025.`],
      "21%",
      () => [text],
    );
    expect(finding.kind).toBe(kind);
  });
});
