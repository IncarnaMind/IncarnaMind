/**
 * One more reading of the words an Answer puts in quotation marks (#2504), written before the code
 * it gates: words that run on to the next page across a heading it repeats with a continuation
 * mark. Each positive has decoys in the same state, which stay not found.
 */
import { describe, expect, test } from "vitest";
import {
  askAndFinish,
  citingModel,
  onlyCitation,
  type ShownPassage,
  type SourceFile,
  setUpWithDocuments,
} from "../helpers/citations";
import { buildPdf } from "../helpers/pdf";

interface Case {
  file: SourceFile;
  query: string;
  question: string;
  /** The record's quote, which is on the cited page. */
  quote: string;
}

async function citationOf({ file, query, question, quote }: Case, sentence: string) {
  const model = citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer: sentence,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [file]);
  const { answerId } = await askAndFinish(core, client, mind.id, question);
  return onlyCitation(client, answerId);
}

const FOUND = { check: "found", checkReason: null };
const NOT_FOUND = { check: "not-found", checkReason: "quoted-words-not-on-pages" };

/** A Document of two pages: the first ends mid-sentence, the second opens with `top`. */
function twoPages(
  language: "en" | "zh",
  first: readonly string[],
  top: readonly string[],
  rest: readonly string[],
): SourceFile {
  const key = language === "en" ? "lines" : "chineseLines";
  return {
    name: language === "en" ? "Returns policy.pdf" : "退货政策.pdf",
    contents: buildPdf([{ [key]: first }, { [key]: [...top, ...rest] }]),
  };
}

const EN = {
  heading: "Section 4 Returns and refunds",
  first: [
    "Section 4 Returns and refunds",
    "Goods can be sent back within 30 days of delivery.",
    "The notice must state that no fee is charged when goods are",
  ],
  rest: ["returned within 30 days. A receipt is required."],
  query: "notice fee goods returned",
  question: "What must the notice state?",
  quote: "The notice must state that no fee is charged",
  quoted: "The notice says “no fee is charged when goods are returned within 30 days” [^1].",
} as const;

const ZH = {
  heading: "第四条 退货与退款的处理办法",
  first: [
    "第四条 退货与退款的处理办法",
    "货物可在收货后三十天内退回。",
    "通知必须写明退回货物时不收取任何",
  ],
  rest: ["费用，并须出示收据。"],
  query: "通知 退回货物 费用",
  question: "通知必须写明什么？",
  quote: "通知必须写明退回货物时不收取任何",
  quoted: "通知写明“退回货物时不收取任何费用，并须出示收据”[^1]。",
} as const;

describe.each([
  ["en", EN, "(continued)"],
  ["zh", ZH, "（续）"],
] as const)("Quoted words that run on across a continued heading (%s)", (language, text, mark) => {
  const caseWith = (first: readonly string[], top: readonly string[], rest = text.rest): Case => ({
    file: twoPages(language, first, top, rest),
    query: text.query,
    question: text.question,
    quote: text.quote,
  });
  const continued = `${text.heading} ${mark}`;

  test("the next page opens with the cited page's heading and a continuation mark: found in English, and the card names the next page", async () => {
    const citation = await citationOf(caseWith(text.first, [continued]), text.quoted);
    if (language === "en") {
      expect(citation).toMatchObject(FOUND);
      expect(citation.quotedWordsRunOn).toBe(2);
    } else {
      // The app reflows the Chinese heading into the line after it, so the cited page has no line
      // that is the heading: a content line starting with its words looks the same, so not found.
      expect(citation).toMatchObject(NOT_FOUND);
    }
  });

  test("the heading repeated with no continuation mark: not found", async () => {
    expect(await citationOf(caseWith(text.first, [text.heading]), text.quoted)).toMatchObject(
      NOT_FOUND,
    );
  });

  test("a heading the cited page doesn't have, with the mark: not found", async () => {
    const other =
      language === "en" ? "Section 5 Exchanges and repairs" : "第五条 换货与维修的处理办法";
    expect(await citationOf(caseWith(text.first, [`${other} ${mark}`]), text.quoted)).toMatchObject(
      NOT_FOUND,
    );
  });

  test("a repeated line shorter than a heading, with the mark: not found", async () => {
    const short = language === "en" ? "Total" : "合计";
    expect(
      await citationOf(caseWith([short, ...text.first], [`${short} ${mark}`]), text.quoted),
    ).toMatchObject(NOT_FOUND);
  });

  test("a long content line that merely starts with the heading's words: not found", async () => {
    const content =
      language === "en"
        ? `${text.heading} are handled by the shop within 30 days.`
        : `${text.heading}适用于本店出售的所有商品。`;
    expect(
      await citationOf(caseWith([content, ...text.first.slice(1)], [continued]), text.quoted),
    ).toMatchObject(NOT_FOUND);
  });

  test("text after the quoted part on the cited page: not found", async () => {
    const trailing = [
      ...text.first.slice(0, -1),
      `${text.first.at(-1)}${language === "en" ? " kept" : "保留"}`,
    ];
    expect(await citationOf(caseWith(trailing, [continued]), text.quoted)).toMatchObject(NOT_FOUND);
  });

  test("a quote that takes the heading's words: not found", async () => {
    const taking =
      language === "en"
        ? "The notice says “no fee is charged when goods are Section 4 Returns and refunds returned within 30 days” [^1]."
        : "通知写明“退回货物时不收取任何第四条 退货与退款的处理办法费用，并须出示收据”[^1]。";
    expect(await citationOf(caseWith(text.first, [continued]), taking)).toMatchObject(NOT_FOUND);
  });

  test("more than three lines left out: not found", async () => {
    const headings =
      language === "en"
        ? [
            "Part Two General terms of sale",
            "Chapter 3 Delivery and returns",
            "Section 4 Returns and refunds",
            "Clause 4.1 Fees on returned goods",
          ]
        : [
            "第二部分 一般销售条款说明",
            "第三章 交货与退货的规定",
            "第四条 退货与退款的处理办法",
            "第四点一款 退货费用的规定",
          ];
    const first = [...headings, ...text.first.slice(1)];
    expect(
      await citationOf(
        caseWith(
          first,
          headings.map((line) => `${line} ${mark}`),
        ),
        text.quoted,
      ),
    ).toMatchObject(NOT_FOUND);
  });

  test("words only on the next page: not found", async () => {
    const only =
      language === "en"
        ? "The notice says “a receipt is required” for each return [^1]."
        : "通知写明“费用，并须出示收据”的内容[^1]。";
    expect(await citationOf(caseWith(text.first, [continued]), only)).not.toMatchObject(FOUND);
  });
});

test("a heading the cited page doesn't have, the quote starting late on its last line: not found", async () => {
  const file = twoPages("en", EN.first, ["Section 5 Exchanges and repairs (continued)"], EN.rest);
  const citation = await citationOf(
    { file, query: EN.query, question: EN.question, quote: EN.quote },
    "The notice says “charged when goods are returned within 30 days” [^1].",
  );
  expect(citation).toMatchObject(NOT_FOUND);
});

test.each([["(continued from previous page)"], ["(续)"]])(
  "the continuation mark %s counts too",
  async (mark) => {
    // A Chinese mark is drawn with the Chinese font, which draws the English heading too.
    const next = [`${EN.heading} ${mark}`, ...EN.rest];
    const file: SourceFile = {
      name: "Returns policy.pdf",
      contents: buildPdf([
        { lines: EN.first },
        mark === "(续)" ? { chineseLines: next } : { lines: next },
      ]),
    };
    const citation = await citationOf(
      { file, query: EN.query, question: EN.question, quote: EN.quote },
      EN.quoted,
    );
    expect(citation).toMatchObject(FOUND);
  },
);
