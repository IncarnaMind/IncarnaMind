/**
 * A figure is never Supported by a quote that gives the same number about something else (#2255):
 * each Figures item names, in words copied from the sentence and from its quote, what the number
 * measures, and whether the two are the same measure. A "differs" takes support away. In a
 * Document's table the code can tell on its own: a cell's words that are another row's label or
 * another column's heading name another number. Everything else goes on as before measures.
 *
 * Figures are checked one by one only in a Note's check (`core.checkClaim` takes no figures), so
 * these go through Check this Note, as the editor runs it.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { measureFinding, readMeasure } from "../../src/core/answers/checks/figureMeasures";
import type { FigureCheckAttributes } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  isCheckRun,
  listedSentences,
  requestedFigures,
  SAME_DETAIL,
  sentenceOf,
} from "../helpers/checks";
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

/** The number a quote of it alone binds, and the figure's, the same. */
const bound = (chars: string, value: number, at = 0) => ({
  chars,
  at,
  figure: chars,
  values: [value],
});

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
          SAME_DETAIL,
          `The Document gives ${planned.number} [^1].`,
          `Figures: ${JSON.stringify({ items, remainder: null })}`,
        ].join("\n"),
      };
    },
    {
      // Asked which sentences make claims, each is one fact.
      generate: (call) =>
        call.question === "find-claims"
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
  // protects=a figure whose quote's equal number the model itself says measures something else needs a look, with the plain reason, even when it calls the figure supported with the topic found (#2255); fails_when=the figure or its sentence shows Supported, or the reason names the wrong measures; no_claim=that a real model says differs here.
  test("an equal number the model says measures something else is never Supported, and says what it measures", async () => {
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

  // protects=the right measure's quote still supports its figure (#2255); fails_when=a figure whose measure matches isn't Supported; no_claim=none beyond protects.
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

  // protects=a figure the model calls unsupported or contradicted on another measure's number is Unsupported, never Contradicted, and the card gives the plain reason, even with the sentence's measure paraphrased (#2255); fails_when=another measure's number contradicts the figure, or the reason is missing; no_claim=none beyond protects.
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

// protects=a "differs" backs nothing even when its words for the quote's measure aren't in the quote, and then the card keeps the model's own reason (#2255); fails_when=such a figure is Supported, or a reason names words the quote doesn't hold; no_claim=none beyond protects.
test("a differs whose words the quote lacks", async () => {
  const sentence = "Revenue grew 12% in 2025.";
  const { figures } = await checkNote(
    "en",
    EN_DOCUMENT,
    [paragraph("joined", sentence)],
    one(sentence, {
      quote: "Revenue grew 12% in 2025, to £48.2m.",
      number: "12%",
      measure: { sentence: "Revenue grew", quote: "turnover", match: "differs" },
    }),
  );
  expect(figures).toMatchObject([{ sentence, state: "unsupported", why: null }]);
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

// protects=the reason names the measures only when each fits in 80 characters, and a marker the reply's words carry where they repeat a recorded quote ("Revenue[^1]") is no part of them, so the reason still names the measure (#2255); fails_when=a reason prints a long copy, or a marker keeps the measure from being shown; no_claim=none beyond protects.
test.each([
  {
    said: "consolidated operating expenditure attributable to international distribution partnerships",
    quoted: "Revenue",
    shown: null,
  },
  {
    said: "Operating margin",
    quoted: "Revenue[^1]",
    shown: { measured: "Revenue", claimed: "Operating margin" },
  },
])("the reason's measures: $quoted", ({ said, quoted, shown }) => {
  const sentence = `In 2025 ${said} was 12%.`;
  const quote = "Revenue grew 12% in 2025, to £48.2m.";
  const measure = readMeasure({ sentence: said, quote: quoted, match: "differs" });
  const finding = measureFinding(measure, [sentence], quote, bound("12%", 0.12, 13), () => []);
  expect(finding).toEqual({ kind: "differs", shown });
});

/** A Document's table whose rows give the same number for different measures, in two columns. */
const SEGMENTS = {
  en: {
    name: "Segment results 2025.md",
    contents: [
      "# Segment results 2025",
      "",
      "| Segment | Revenue growth | Operating margin |",
      "| --- | --- | --- |",
      "| Retail | 12% | 9% |",
      "| Wholesale | 7% | 12% |",
      "",
    ].join("\n"),
  },
  zh: {
    name: "分部业绩2025.md",
    contents: [
      "# 分部业绩2025",
      "",
      "| 分部 | 收入增长 | 营业利润率 |",
      "| --- | --- | --- |",
      "| 零售 | 12% | 9% |",
      "| 批发 | 7% | 12% |",
      "",
    ].join("\n"),
  },
};

// protects=a quote from a Document's table names its number by the number's own row and column: when the reply's words for it are another column's heading of that table, the equal number is Not checked with its own reason, never Supported, while the same row's number named by its own heading is Supported, in English and Chinese (#2255); fails_when=another column's heading makes a figure Supported, or the cell's own heading doesn't; no_claim=that the model's words for the sentence's measure are right.
test.each([
  {
    language: "en" as const,
    sentence: "Retail's operating margin was 12% in 2025.",
    measure: { sentence: "operating margin", quote: "Operating margin" },
    state: "not-checked",
  },
  {
    language: "en" as const,
    sentence: "Retail revenue grew 12% in 2025.",
    measure: { sentence: "Retail revenue", quote: "Revenue growth" },
    state: "supported",
  },
  {
    language: "zh-CN" as const,
    sentence: "零售业务的营业利润率为12%。",
    measure: { sentence: "营业利润率", quote: "营业利润率" },
    state: "not-checked",
  },
  {
    language: "zh-CN" as const,
    sentence: "零售业务收入增长12%。",
    measure: { sentence: "收入增长", quote: "收入增长" },
    state: "supported",
  },
])("another column's heading: $sentence", async ({ language, sentence, measure, state }) => {
  const quote = language === "en" ? "| Retail | 12% | 9% |" : "| 零售 | 12% | 9% |";
  const { figures } = await checkNote(
    language,
    language === "en" ? SEGMENTS.en : SEGMENTS.zh,
    [paragraph("segment", sentence)],
    one(sentence, { quote, number: "12%", measure: { ...measure, match: "same" } }),
  );
  expect(figures).toMatchObject([
    state === "supported"
      ? { sentence, state, sentenceState: "supported" }
      : { sentence, state, reason: "other-cell" },
  ]);
  if (state !== "supported") expect(figures[0]?.sentenceState).not.toBe("supported");
});

describe("a table's row label and headings say what a cell measures (#2255)", () => {
  // protects=a Note's table cell is named by its row label, so the row the model says names the quote's measure is Supported and the row it says names another is not (#2255); fails_when=the other row's cell shows Supported, or the right row's doesn't; no_claim=how a real model names a row.
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

  // protects=a quote that is a Document's bare table cell names nothing but its number, so its row label, copied from its Passage, says what it measures; with no words named the check keeps the table's headings to the model's judgement as before, its "differs" included; another row's label is never Supported (#2255); fails_when=a bare cell can't be Supported on its row label or on no words, or is Supported on another row's label or on a measure the model says differs; no_claim=none beyond protects.
  test.each([
    {
      measure: { sentence: "Gross margin", quote: "Gross margin", match: "same" },
      state: "supported",
    },
    { measure: { sentence: "Gross margin", quote: null, match: "same" }, state: "supported" },
    { measure: { sentence: "Gross margin", quote: null, match: "differs" }, state: "unsupported" },
    {
      measure: { sentence: "Gross margin", quote: "Net debt to EBITDA", match: "same" },
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

  // protects=a quote of a table's row names its row (a depot), and the column's heading what its number measures, so the heading counts as the quote's words; another row's label never does; a quote outside a table keeps the check as before (#2255); fails_when=a row quote can't be Supported on its column's heading, or is Supported on another row's label; no_claim=none beyond protects.
  test.each([
    {
      sentence: "Felixstowe's on-time rate was 94% in 2025.",
      quote: "Felixstowe | 94%",
      measure: { sentence: "on-time rate", quote: "On-time rate", match: "same" },
      state: "supported",
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
  ])(
    "a row's column heading: $measure.quote for $quote",
    async ({ sentence, quote, measure, state }) => {
      const number = ["94%", "£48.2m", "1.4x"].find((each) => quote.includes(each)) ?? "";
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

describe("where a table cell's words may come from (#2255's review)", () => {
  // protects=a cell's row is found by the quote's text, so "21%" is the "21%" row's, never the "21.5%" row's, and the other row's label names another number (#2255); fails_when=another row's label makes a figure Supported; no_claim=none beyond protects.
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

  // protects=the same rule in Chinese: a cell's own row label names it, another row's label of its table names another number (#2255); fails_when=another row's label is "same", or its own isn't; no_claim=none beyond protects.
  test("a cell's own row, in Chinese", () => {
    const text = [
      "| 指标 | 2025年 |",
      "| --- | --- |",
      "| 营业利润率 | 21.5% |",
      "| 收入增长 | 21% |",
    ].join("\n");
    const finding = (words: string) =>
      measureFinding(
        { sentence: words, quote: words, match: "same" },
        [`2025年${words}为21%。`],
        "21%",
        bound("21%", 0.21),
        () => [text],
      ).kind;
    expect([finding("收入增长"), finding("营业利润率")]).toEqual(["same", "other-cell"]);
  });

  // protects=the sentence's words for its measure may be in its paragraph, where "It" gets its subject (#2255); fails_when=a figure whose measure only its paragraph names isn't Supported; no_claim=that words from another sentence of the paragraph name the right figure.
  test("the paragraph names the measure a sentence refers to", async () => {
    const text = "Revenue was the year's story. It grew 12% in 2025.";
    const { figures } = await checkNote("en", EN_DOCUMENT, [paragraph("p", text)], () => ({
      quote: "Revenue grew 12% in 2025, to £48.2m.",
      number: "12%",
      measure: { sentence: "Revenue", quote: "Revenue", match: "same" },
    }));
    expect(figures).toMatchObject([{ sentence: "It grew 12% in 2025.", state: "supported" }]);
  });

  // protects=a quote is placed by the first text that holds it, its cited pages before the rest of its Document, so a number its page holds once is placed there though the Document holds it twice, and the page's other row names another number (#2255); fails_when=the cited page doesn't decide; no_claim=none beyond protects.
  test("the cited page places a quote its Document holds twice", () => {
    const page =
      "| Measure | 2025 |\n| --- | --- |\n| Revenue growth | 12% |\n| Operating margin | 9% |";
    const document = `${page}\n\n| Measure | 2024 |\n| --- | --- |\n| Revenue growth | 9% |\n| Operating margin | 12% |`;
    const finding = (words: string) =>
      measureFinding(
        { sentence: words, quote: words, match: "same" },
        [`${words} was 12% in 2025.`],
        "12%",
        bound("12%", 0.12),
        () => [page, document],
      ).kind;
    expect([finding("Revenue growth"), finding("Operating margin")]).toEqual([
      "same",
      "other-cell",
    ]);
  });

  // protects=a quote is placed only where its text stands as a number of its own ("21%" not inside "121%" or "1.21%"), and a text that holds it twice places it nowhere, so neither row's label decides (#2255); fails_when=a quote is placed inside a longer number, or in one of two rows; no_claim=none beyond protects.
  test.each([
    {
      rows: ["| Margin index | 121% |", "| Revenue growth | 21% |"],
      found: { "Revenue growth": "same", "Margin index": "other-cell" },
    },
    {
      rows: ["| Margin index | 1.21% |", "| Revenue growth | 21% |"],
      found: { "Revenue growth": "same", "Margin index": "other-cell" },
    },
    {
      rows: ["| Headcount growth | 21% |", "| Depot growth | 21% |"],
      found: { "Headcount growth": "unknown", "Depot growth": "unknown" },
    },
  ])("a quote placed once, as text: $rows", ({ rows, found }) => {
    const text = ["| Measure | 2025 |", "| --- | --- |", ...rows].join("\n");
    for (const [row, kind] of Object.entries(found))
      expect(
        measureFinding(
          { sentence: row, quote: row, match: "same" },
          [`${row} was 21% in 2025.`],
          "21%",
          bound("21%", 0.21),
          () => [text],
        ).kind,
        row,
      ).toBe(kind);
  });

  // protects=a table's number is named by its row's label and its own column's heading, never another column's, whether the quote is the cell, the cells of its row, the whole row or a sheet's tab-separated row (#2255); fails_when=another column's heading is "same", or its own column's isn't; no_claim=none beyond protects.
  test.each([
    { form: "the cell", quote: "94%" },
    { form: "the row's cells", quote: "Felixstowe | 94% | 81%" },
    { form: "the whole row", quote: "| Felixstowe | 94% | 81% |" },
    { form: "a sheet's row", quote: "Felixstowe\t94%\t81%", sheet: true },
  ])("only the number's own column: $form", ({ quote, sheet }) => {
    const text = sheet
      ? "Depot\tOn-time rate\tSpace occupancy\nFelixstowe\t94%\t81%"
      : "| Depot | On-time rate | Space occupancy |\n| --- | --- | --- |\n| Felixstowe | 94% | 81% |";
    const finding = (heading: string) =>
      measureFinding(
        { sentence: heading, quote: heading, match: "same" },
        [`Felixstowe's ${heading.toLowerCase()} was 94% in 2025.`],
        quote,
        bound("94%", 0.94, quote.indexOf("94%")),
        () => [text],
      ).kind;
    expect([finding("On-time rate"), finding("Space occupancy"), finding("Felixstowe")]).toEqual([
      "same",
      "other-cell",
      "same",
    ]);
  });

  // protects=a quote that starts or ends in a letter is never placed inside a longer word ("rent assets" in "Current assets"), so that row lends it nothing (#2255); fails_when=a quote is placed inside another word; no_claim=none beyond protects.
  test("a quote never runs on into a longer word", () => {
    const text = "| Measure | 2025 |\n| --- | --- |\n| Current assets | 12% |\n| Rent | 9% |";
    const finding = (quote: string) =>
      measureFinding(
        { sentence: "Rent", quote: "Rent", match: "same" },
        ["Rent was 12% in 2025."],
        quote,
        bound("12%", 0.12, quote.indexOf("12%")),
        () => [text],
      ).kind;
    expect([finding("rent assets | 12%"), finding("Current assets | 12%")]).toEqual([
      "unknown",
      "other-cell",
    ]);
  });
});

describe("where a table's headings line up (#2255's review)", () => {
  // protects=a heading row that doesn't line up with the quote's row says nothing either way, since its cells can't say which is the number's, while a row that keeps its blank corner, a merged heading that fills its columns, a sheet's second heading row, two heading rows in Markdown, and a transposed table name the number and tell another column's or row's apart (#2255, #2426); fails_when=a shifted heading is "same" or "other-cell", or an aligned one stops naming the number or telling another apart; no_claim=that a table from elsewhere, its merged heading written once, lines up.
  test.each([
    {
      name: "a heading row with a cell fewer than the row",
      text: "On-time rate\tSpace occupancy\nFelixstowe\t94%\t81%",
      found: { "Space occupancy": "unknown", "On-time rate": "unknown", Felixstowe: "same" },
    },
    {
      name: "a Word row, its blank corner kept",
      text: "\tOn-time rate\tSpace occupancy\nFelixstowe\t94%\t81%",
      found: { "Space occupancy": "other-cell", "On-time rate": "same", Felixstowe: "same" },
    },
    {
      name: "a merged heading written once, filling no cells",
      text: "\tRates\tOccupancy\nDepot\tOn-time\tLate\tSpace\tYard\nFelixstowe\t81%\t94%\t70%\t60%",
      found: {
        Occupancy: "unknown",
        Rates: "unknown",
        Late: "same",
        "On-time": "other-cell",
        Felixstowe: "same",
      },
    },
    {
      name: "a merged heading that fills its columns",
      text: "Depot\tRates\t\n\tOn-time\tLate\nFelixstowe\t94%\t81%",
      found: { Rates: "same", "On-time": "same", Late: "other-cell", Felixstowe: "same" },
    },
    {
      name: "a Markdown row with its blank corner kept",
      text: "|  | On-time rate | Space occupancy |\n| --- | --- | --- |\n| Felixstowe | 94% | 81% |",
      found: { "Space occupancy": "other-cell", "On-time rate": "same" },
    },
    {
      name: "two heading rows",
      text: "| Depot | 2025 | 2025 |\n| Depot | On-time rate | Space occupancy |\n| --- | --- | --- |\n| Felixstowe | 94% | 81% |",
      found: { "Space occupancy": "other-cell", "On-time rate": "same" },
    },
    {
      name: "a transposed table",
      text: "| Measure | Felixstowe | Leeds |\n| --- | --- | --- |\n| On-time rate | 94% | 89% |\n| Space occupancy | 81% | 70% |",
      found: {
        "Space occupancy": "other-cell",
        Leeds: "other-cell",
        "On-time rate": "same",
        Felixstowe: "same",
      },
    },
  ])("headings that line up: $name", ({ text, found }) => {
    for (const [words, kind] of Object.entries(found))
      expect(
        measureFinding(
          { sentence: words, quote: words, match: "same" },
          [`In 2025 ${words.toLowerCase()} was 94%.`],
          "94%",
          bound("94%", 0.94),
          () => [text],
        ).kind,
        words,
      ).toBe(kind);
  });

  // protects=a number's row label is the nearest cell to its left that names something, so in side-by-side panels another row's label in the number's own panel names another number, while the other panel's labels refuse nothing (#2255); fails_when=the other row's label in the number's panel isn't "other-cell", or the other panel's label is; no_claim=that the other panel's label names the number.
  test("side-by-side panels: the label left of the number", () => {
    const text =
      "| Measure | 2025 | Measure | 2025 |\n| --- | --- | --- | --- |\n| Revenue | 12% | Operating margin | 94% |\n| Costs | 5% | Net margin | 7% |";
    const quote = "Operating margin | 94%";
    const finding = (words: string) =>
      measureFinding(
        { sentence: words, quote: words, match: "same" },
        [`In 2025 ${words.toLowerCase()} was 94%.`],
        quote,
        bound("94%", 0.94, quote.indexOf("94%")),
        () => [text],
      ).kind;
    expect([
      finding("Operating margin"),
      finding("Net margin"),
      finding("Revenue"),
      finding("Costs"),
    ]).toEqual(["same", "other-cell", "unknown", "unknown"]);
  });

  // protects=a quote that is itself a table, its heading row and its data row, names its number only by the number's own column, though the quote's text holds every heading (#2255); fails_when=another column's heading in the quote is "same"; no_claim=none beyond protects.
  test("a quote of a table's rows names only its own column", () => {
    const text =
      "| Depot | On-time rate | Space occupancy |\n| --- | --- | --- |\n| Felixstowe | 94% | 81% |";
    const finding = (words: string) =>
      measureFinding(
        { sentence: words, quote: words, match: "same" },
        [`In 2025 ${words.toLowerCase()} was 94%.`],
        text,
        bound("94%", 0.94, text.indexOf("94%")),
        () => [text],
      ).kind;
    expect([finding("Space occupancy"), finding("On-time rate")]).toEqual(["other-cell", "same"]);
  });
});

// protects=outside a Document's table the code tells no measure apart, so prose quotes, words found nowhere in the table and a bare cell with no words named go on as before measures, and nothing right is lost (#2255); fails_when=any of these is refused; no_claim=that the model's "same" is right for them (the known gaps of #2255).
test.each([
  {
    name: "a prose quote",
    measure: { sentence: "Revenue", quote: "Revenue", match: "same" as const },
    quote: "Revenue grew 12% in 2025, to £48.2m.",
    text: "Revenue grew 12% in 2025, to £48.2m.",
  },
  {
    name: "words found nowhere in the table",
    measure: { sentence: "segment revenue", quote: "segment revenue", match: "same" as const },
    quote: "Fresh food\t1420\t1350",
    text: "Segment revenue (£m)\nSegment\tQ3 2026\tQ3 2025\nFresh food\t1420\t1350",
  },
  {
    name: "a bare cell with no words",
    measure: { sentence: "Fresh food", quote: null, match: "same" as const },
    quote: "1420",
    text: "Segment\tQ3 2026\tQ3 2025\nFresh food\t1420\t1350",
  },
])("as before measures: $name", ({ measure, quote, text }) => {
  const chars = /1420/.test(quote) ? "1420" : "12%";
  const finding = measureFinding(
    measure,
    ["Fresh food brought in £1,420m and revenue grew 12% in 2025."],
    quote,
    bound(chars, chars === "1420" ? 1420 : 0.12, quote.indexOf(chars)),
    () => [text],
  );
  expect(finding.kind).toBe("unknown");
});

// protects=only another number's own names refuse a cell's number: a heading over the labels, a prior-year cell or a units or region column left of the number, a section row, a caption row, a period row on top, a heading row the reader shifted, a label merged over two rows and a parent line's label all refuse nothing, as main does; in the same table another number's row label or column heading still does, or the cell's own name is found (#2255); fails_when=any of the first is "other-cell", or the table's own check stops; no_claim=that the words kept name the number.
test.each([
  {
    name: "a heading over the labels",
    text: "| Revenue (£m) | 2026 | 2025 |\n| --- | --- | --- |\n| Fresh food | 1,420 | 1,350 |\n| Frozen | 610 | 590 |",
    quote: "| Fresh food | 1,420 | 1,350 |",
    chars: "1,420",
    kept: "Revenue",
    checked: ["Frozen", "other-cell"],
  },
  {
    name: "a heading over the labels, in Chinese",
    text: "| 营业收入（万元） | 2025年 | 2024年 |\n| --- | --- | --- |\n| 生鲜食品 | 1,420 | 1,350 |\n| 冷冻食品 | 610 | 590 |",
    quote: "| 生鲜食品 | 1,420 | 1,350 |",
    chars: "1,420",
    kept: "营业收入",
    checked: ["冷冻食品", "other-cell"],
  },
  {
    name: "a sheet's heading over the labels",
    text: "Segment revenue\tQ3 2026\tQ3 2025\nFresh food\t1420\t1350\nFrozen\t610\t590",
    quote: "1420",
    chars: "1420",
    kept: "Segment revenue",
    checked: ["Frozen", "other-cell"],
  },
  {
    name: "a prior-year cell left of the number",
    text: "| Measure | 2024 | 2025 |\n| --- | --- | --- |\n| Dividend per share | 6.1p | 6.5p |\n| Earnings per share | 5.9p | 6.2p |",
    quote: "| Dividend per share | 6.1p | 6.5p |",
    chars: "6.5p",
    kept: "Dividend per share",
    checked: ["Dividend per share", "same"],
  },
  {
    name: "a units column",
    text: "| Metric | Unit | 2025 | 2024 |\n| --- | --- | --- | --- |\n| Headcount | FTE | 1,840 | 1,700 |\n| Drivers | FTE | 620 | 600 |",
    quote: "| Headcount | FTE | 1,840 | 1,700 |",
    chars: "1,840",
    kept: "Headcount",
    checked: ["FTE", "same"],
  },
  {
    name: "a region column",
    text: "| Depot | County | On-time rate |\n| --- | --- | --- |\n| Felixstowe | Suffolk | 94% |\n| Leeds | Yorkshire | 89% |",
    quote: "| Felixstowe | Suffolk | 94% |",
    chars: "94%",
    kept: "Felixstowe",
    checked: ["On-time rate", "same"],
  },
  {
    name: "a section row",
    text: "| £m | 2025 | 2024 |\n| --- | --- | --- |\n| Revenue | | |\n| Product | 900 | 850 |\n| Services | 520 | 500 |",
    quote: "| Product | 900 | 850 |",
    chars: "900",
    kept: "Revenue",
    checked: ["Services", "other-cell"],
  },
  {
    name: "a caption row above the rule",
    text: "| Revenue by segment (£m) | | |\n| --- | --- | --- |\n| Segment | 2026 | 2025 |\n| Fresh food | 1420 | 1350 |\n| Frozen | 610 | 590 |",
    quote: "1420",
    chars: "1420",
    kept: "Revenue",
    checked: ["Frozen", "other-cell"],
  },
  {
    name: "a period row on top of a sheet",
    text: "\t2025\t2025\t2024\t2024\n\tRevenue growth\tRevenue\tRevenue growth\tRevenue\nRetail\t12%\t900\t10%\t850",
    quote: "Retail\t12%\t900\t10%\t850",
    chars: "900",
    kept: "Revenue",
    checked: ["Retail", "same"],
  },
  {
    name: "a heading row the reader shifted",
    text: "Revenue\tMargin\nRetail\t900\t12%\nRevenue per store\t4.1\t3.9",
    quote: "Retail\t900\t12%",
    chars: "900",
    kept: "Revenue",
    checked: ["Revenue per store", "other-cell"],
  },
  {
    name: "a second table's heading row in the same sheet",
    text: "Line\tQ3 2026\tQ3 2025\nRevenue\t4983.4\t4860.0\nSegment revenue\tQ3 2026\tQ3 2025\tShare\nFresh food\t1420\t1350\t29%\nFrozen\t610\t590\t12%",
    quote: "Fresh food\t1420\t1350\t29%",
    chars: "1420",
    kept: "Segment revenue",
    checked: ["Frozen", "other-cell"],
  },
  {
    name: "a wider table's row above",
    text: "Line\tQ3 2026\tQ3 2025\nRevenue\t4983.4\t4860.0\nSegment revenue\tQ3 2026\tQ3 2025\tShare\nFresh food\t1420\t1350\t29%\nFrozen\t610\t590\t12%",
    quote: "Fresh food\t1420\t1350\t29%",
    chars: "1420",
    kept: "Revenue",
    checked: ["Frozen", "other-cell"],
  },
  {
    name: "two sheet tables run on as one",
    text: "Group\t2025\t2024\nRevenue\t1,420\t1,350\nOperating margin\t11%\t10%\nSegment\tRevenue\tOperating margin\nRetail\t900\t12%\nWholesale\t520\t9%",
    quote: "Retail\t900\t12%",
    chars: "900",
    kept: "Revenue",
    checked: ["Wholesale", "other-cell"],
  },
  {
    name: "two sheet tables run on as one, in Chinese",
    text: "集团\t2025年\t2024年\n营业收入\t1,420\t1,350\n营业利润率\t11%\t10%\n分部\t营业收入\t营业利润率\n零售\t900\t12%\n批发\t520\t9%",
    quote: "零售\t900\t12%",
    chars: "12%",
    kept: "营业利润率",
    checked: ["批发", "other-cell"],
  },
  {
    name: "two Markdown tables run on as one",
    text: "| Group | 2025 | 2024 |\n| --- | --- | --- |\n| Revenue | 1,420 | 1,350 |\n| Segment | Revenue | Operating margin |\n| --- | --- | --- |\n| Retail | 900 | 12% |\n| Wholesale | 520 | 9% |",
    quote: "| Retail | 900 | 12% |",
    chars: "900",
    kept: "Revenue",
    checked: ["Wholesale", "other-cell"],
  },
  {
    name: "a table run on below",
    text: "Revenue (£m)\t2025\t2024\nFresh food\t1,420\t1,350\nFrozen\t610\t590\nKPI\t2025\t2024\nRevenue\t48.2\t43.0",
    quote: "Fresh food\t1,420\t1,350",
    chars: "1,420",
    kept: "Revenue",
    checked: ["Frozen", "other-cell"],
  },
  {
    name: "a row with no number in the number's column",
    text: "| Segment | 2025 | 2024 |\n| --- | --- | --- |\n| Retail | 900 | 850 |\n| Wholesale | 520 | 500 |\n| Online | | 120 |",
    quote: "| Retail | 900 | 850 |",
    chars: "900",
    kept: "Online",
    checked: ["Wholesale", "other-cell"],
  },
  {
    name: "a parent line's label",
    text: "| 项目 | 2025年 | 2024年 |\n| --- | --- | --- |\n| 一、营业收入 | 1,420 | 1,350 |\n| 其中：主营业务 | 900 | 850 |",
    quote: "| 其中：主营业务 | 900 | 850 |",
    chars: "900",
    kept: "营业收入",
    checked: ["一、营业收入", "other-cell"],
  },
])("another number's own names only: $name", ({ text, quote, chars, kept, checked }) => {
  const finding = (words: string) =>
    measureFinding(
      { sentence: words, quote: words, match: "same" },
      [`In 2025 ${words} was ${chars}.`],
      quote,
      bound(chars, 0, quote.lastIndexOf(chars)),
      () => [text],
    ).kind;
  const [words, kind] = checked as [string, string];
  expect([finding(kept) === "other-cell", finding(words)]).toEqual([false, kind]);
});

// protects=a number in a row whose label is merged over two rows, written once, can't say whose it is, so it refuses nothing, while a row that keeps its label is still told apart from the other's (#2255); fails_when=the label-less row is "other-cell", or the labelled row isn't; no_claim=none beyond protects.
test("a label merged over two rows", () => {
  const text =
    "Measure\tYear\tValue\nRevenue growth\t2025\t12%\n\t2024\t9%\nOperating margin\t2025\t21%\n\t2024\t19%";
  const finding = (quote: string, chars: string) =>
    measureFinding(
      { sentence: "Revenue growth", quote: "Revenue growth", match: "same" },
      [`Revenue growth was ${chars}.`],
      quote,
      bound(chars, 0, quote.indexOf(chars)),
      () => [text],
    ).kind;
  expect([finding("\t2024\t9%", "9%"), finding("Operating margin\t2025\t21%", "21%")]).toEqual([
    "unknown",
    "other-cell",
  ]);
});

// protects=a "differs" whose two names are the same words, digits included, is a model that compared the numbers, not the measures, so it neither takes support away nor names a reason, while two names that differ do, "Scope 1 emissions" and "Scope 2 emissions" too (#2255); fails_when=the same words come back "differs", or different ones don't; no_claim=none beyond protects.
test("a differs between the same words", () => {
  const finding = (said: string) =>
    measureFinding(
      { sentence: said, quote: "Revenue", match: "differs" },
      [`${said} grew 15% in 2025.`],
      "Revenue grew 12% in 2025, to £48.2m.",
      bound("12%", 0.12, 13),
      () => [],
    ).kind;
  expect([finding("Revenue"), finding("Operating margin")]).toEqual(["unknown", "differs"]);
  const scope = measureFinding(
    { sentence: "Scope 2 emissions", quote: "Scope 1 emissions", match: "differs" },
    ["Scope 2 emissions fell 11% in 2025."],
    "Scope 1 emissions fell 11% in 2025.",
    bound("11%", 0.11, 25),
    () => [],
  ).kind;
  expect(scope).toBe("differs");
});
