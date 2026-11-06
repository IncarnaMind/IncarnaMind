/**
 * Two more readings of the words an Answer puts in quotation marks (#2504), written before the
 * code they gate: words that run on to the next page across a heading it repeats with a
 * continuation mark, and a Document's name in quotation marks, a part of it at a separator. Each
 * positive has decoys in the same state, which stay not found.
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

  test("the next page opens with the cited page's heading and a continuation mark: found, and the card names the next page", async () => {
    const citation = await citationOf(caseWith(text.first, [continued]), text.quoted);
    expect(citation).toMatchObject(FOUND);
    expect(citation.quotedWordsRunOn).toBe(2);
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
    const lines = [text.heading, ...text.first.slice(1, -1), text.first.at(-1) as string];
    const many = [text.heading, text.heading, text.heading, text.heading].map(
      (line) => `${line} ${mark}`,
    );
    expect(await citationOf(caseWith(lines, many), text.quoted)).toMatchObject(NOT_FOUND);
  });

  test("words only on the next page: not found", async () => {
    const only =
      language === "en"
        ? "The notice says “returned within 30 days. A receipt is required” [^1]."
        : "通知写明“费用，并须出示收据”的内容[^1]。";
    expect(await citationOf(caseWith(text.first, [continued]), only)).not.toMatchObject(FOUND);
  });
});

describe("A Document's name in quotation marks: a part of it at a separator", () => {
  const named = (name: string, body: string, quote: string): Case => ({
    file: { name: `${name}.md`, contents: `# Entry\n\n${body}\n` },
    query: quote.slice(0, 12),
    question: "What does it say?",
    quote,
  });
  const ESG = named(
    "维基百科-环境、社会和公司治理",
    "赤道原則是金融機構採用的風險管理框架，用於確定和評估專案融資中的風險。",
    "赤道原則是金融機構採用的風險管理框架",
  );
  const bank = named(
    "Annual Climate Risk Report - Northwind Bank",
    "The bank expects physical climate risk to rise in every region it lends to.",
    "The bank expects physical climate risk to rise",
  );

  test("a part of the shown name, split at a dash between CJK words: a name, not a quote", async () => {
    expect(
      await citationOf(
        ESG,
        "按照“环境、社会和公司治理”条目，“赤道原則是金融機構採用的風險管理框架”[^1]。",
      ),
    ).toMatchObject(FOUND);
  });

  test("a part of the shown name, split at a spaced dash: a name, not a quote", async () => {
    expect(
      await citationOf(
        bank,
        "The “Annual Climate Risk Report” says “the bank expects physical climate risk to rise” [^1].",
      ),
    ).toMatchObject(FOUND);
  });

  test("a part with a word or a number changed: not found", async () => {
    expect(
      await citationOf(
        ESG,
        "按照“环境、社会和公司监督”条目，“赤道原則是金融機構採用的風險管理框架”[^1]。",
      ),
    ).toMatchObject(NOT_FOUND);
    expect(
      await citationOf(
        bank,
        "The “Annual Climate Risk Review” says “the bank expects physical climate risk to rise” [^1].",
      ),
    ).toMatchObject(NOT_FOUND);
  });

  test("only a piece of a part: not found", async () => {
    expect(
      await citationOf(
        ESG,
        "按照“社会和公司治理”条目，“赤道原則是金融機構採用的風險管理框架”[^1]。",
      ),
    ).toMatchObject(NOT_FOUND);
  });

  test("a hyphen inside a word doesn't split, nor does a middle dot", async () => {
    const guide = named(
      "Cooling-off Period Guide for Buyers",
      "A buyer may cancel within fourteen days of signing the contract.",
      "A buyer may cancel within fourteen days",
    );
    expect(
      await citationOf(
        guide,
        "The “Period Guide for Buyers” says “a buyer may cancel within fourteen days” [^1].",
      ),
    ).toMatchObject(NOT_FOUND);
    const works = named(
      "列夫·托尔斯泰作品选集",
      "这部选集收录了作者晚年写成的十二篇短篇小说。",
      "这部选集收录了作者晚年写成的十二篇短篇小说",
    );
    expect(
      await citationOf(
        works,
        "按照“托尔斯泰作品选集”的介绍，“这部选集收录了作者晚年写成的十二篇短篇小说”[^1]。",
      ),
    ).toMatchObject(NOT_FOUND);
  });

  test("only the name of the Document its own record cites: another Document's name part is not found", async () => {
    const model = citingModel({
      query: "Equator Principles risk framework",
      records: (passages: ShownPassage[]) => [
        {
          marker: 1,
          passage: passages.find((each) => each.text.includes("Equator"))?.id,
          quote: "The Equator Principles are a risk management framework",
        },
      ],
      answer:
        "As the “Annual Climate Risk Report” puts it, “the Equator Principles are a risk management framework” [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Project finance notes.md",
        contents:
          "# Notes\n\nThe Equator Principles are a risk management framework for project finance.\n",
      },
      {
        name: "Annual Climate Risk Report - Northwind Bank.md",
        contents: "# Report\n\nThe bank expects physical climate risk to rise.\n",
      },
    ]);
    const { answerId } = await askAndFinish(
      core,
      client,
      mind.id,
      "What are the Equator Principles?",
    );
    expect(onlyCitation(client, answerId)).toMatchObject(NOT_FOUND);
  });

  test("a fullwidth dash splits", async () => {
    const fullwidth = named(
      "资料－环境、社会和公司治理",
      "赤道原則是金融機構採用的風險管理框架，用於確定和評估專案融資中的風險。",
      "赤道原則是金融機構採用的風險管理框架",
    );
    expect(
      await citationOf(
        fullwidth,
        "按照“环境、社会和公司治理”条目，“赤道原則是金融機構採用的風險管理框架”[^1]。",
      ),
    ).toMatchObject(FOUND);
  });
});
