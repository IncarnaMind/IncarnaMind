/**
 * A cited Document's name in quotation marks, or a part of it at a separator, is a name, not a
 * quote (#2504): the Citation keeps its own quote's check, and says the words are the Document's
 * name. The name is neutral: it never makes the Citation found, and other quoted words the pages
 * don't have still make it not found.
 */
import { describe, expect, test } from "vitest";
import { parseQuotedWords } from "../../src/shared/citations";
import {
  askAndFinish,
  citationsIn,
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
  /** The record's quote, which is on the page. */
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

const CASES = {
  en: {
    page: ["Minutes", "The board approved the harbour budget on 12 March."],
    query: "board approved budget",
    question: "What did the board approve?",
    quote: "The board approved the harbour budget",
    whole: {
      name: "Board meeting notes for March.pdf",
      sentence: "The minutes record “board meeting notes for March” as approved [^1].",
      words: "board meeting notes for March",
    },
    part: {
      name: "Harbour Authority annual report 2024 - Final draft.pdf",
      sentence: "The report is titled “Harbour Authority annual report 2024” [^1].",
      words: "Harbour Authority annual report 2024",
    },
    notOnPage: "the board rejected the harbour budget",
    sentenceWith: (first: string, second: string) =>
      `The minutes say “${first}” and “${second}” [^1].`,
  },
  zh: {
    page: ["会议纪要", "董事会于三月十二日批准了港口预算。"],
    query: "董事会 批准 预算",
    question: "董事会批准了什么？",
    quote: "董事会于三月十二日批准了港口预算",
    whole: {
      name: "三月董事会会议纪要.pdf",
      sentence: "纪要“三月董事会会议纪要”记录了这项批准[^1]。",
      words: "三月董事会会议纪要",
    },
    part: {
      name: "港务局二〇二四年年度报告－定稿.pdf",
      sentence: "报告的标题是“港务局二〇二四年年度报告”[^1]。",
      words: "港务局二〇二四年年度报告",
    },
    notOnPage: "董事会否决了港口预算方案",
    sentenceWith: (first: string, second: string) => `纪要写道“${first}”，又写道“${second}”[^1]。`,
  },
} as const;

type Language = keyof typeof CASES;

const caseOf = (
  language: Language,
  name: string,
  page: readonly string[] = CASES[language].page,
): Case => {
  const text = CASES[language];
  const key = language === "en" ? "lines" : "chineseLines";
  return {
    file: { name, contents: buildPdf([{ [key]: page }]) },
    query: text.query,
    question: text.question,
    quote: text.quote,
  };
};

describe.each(Object.keys(CASES) as Language[])(
  "A Document's name in quotation marks (%s)",
  (language) => {
    const text = CASES[language];

    // protects=a cited Document's whole name in quotation marks is a name: the Citation keeps its own quote's check and records the words as the name (#2504); fails_when=the Citation says nothing of the name, or the name changes its check; no_claim=the card's look, which the screenshots show.
    test("its whole name: the Citation keeps its own check and says the words are its name", async () => {
      const citation = await citationOf(caseOf(language, text.whole.name), text.whole.sentence);
      expect(citation).toMatchObject(FOUND);
      expect(citation.quotedWords).toEqual({ name: text.whole.words });
    });

    // protects=a part of the name at a separator, the title before " - " or "－", is a name too (#2504), where main read it as quoted words not on the page; fails_when=it reads not found, or found with nothing said of the name; no_claim=parts inside a word, which never split.
    test("a part of its name at a separator: a name too, not quoted words missing from the page", async () => {
      const citation = await citationOf(caseOf(language, text.part.name), text.part.sentence);
      expect(citation).toMatchObject(FOUND);
      expect(citation.quotedWords).toEqual({ name: text.part.words });
    });

    // protects=words that are both the name and on the cited page are a quote found there, not a name (#2504); fails_when=the card calls words the page has a name; no_claim=none beyond protects.
    test("its name, when the cited page has the words too: a quote found there, not a name", async () => {
      const page = [text.whole.words, ...text.page.slice(1)];
      const citation = await citationOf(
        caseOf(language, text.whole.name, page),
        text.whole.sentence,
      );
      expect(citation).toMatchObject(FOUND);
      expect(citation.quotedWords).toBeUndefined();
    });

    // protects=the name is neutral: other quoted words the pages don't have make the Citation not found, and its card shows them, whichever comes first (#2504); fails_when=the name keeps the Citation found, or takes the place of the words not found; no_claim=none beyond protects.
    test.each([
      ["the name first", true],
      ["the words not on the page first", false],
    ])(
      "its name beside quoted words the page doesn't have: not found, %s",
      async (_, nameFirst) => {
        const sentence = nameFirst
          ? text.sentenceWith(text.whole.words, text.notOnPage)
          : text.sentenceWith(text.notOnPage, text.whole.words);
        const citation = await citationOf(caseOf(language, text.whole.name), sentence);
        expect(citation).toMatchObject(NOT_FOUND);
        expect(
          parseQuotedWords(citation.quotedWords)
            ?.answer.map((piece) => piece.text)
            .join(""),
        ).toBe(text.notOnPage);
      },
    );
  },
);

const quoting = (language: Language, words: string) =>
  language === "en" ? `The record says “${words}” [^1].` : `记录写道“${words}”[^1]。`;

// protects=a name is compared with its figures' marks and its words' spaces kept, and only an extension files are added with is cut, so quoted words that differ from the name only in a figure's mark or a space are quoted words the page lacks, not a name (#2504); fails_when=a decimal point, a thousands comma, a sign, a currency, a per-mille sign or a space between words is dropped, or a ".5" is taken for an extension, and the words read as the name; no_claim=the same figure written another way, which reads not found too.
test.each([
  ["en", "Revenue grew 12.5 percent.pdf", "revenue grew 125 percent"],
  ["en", "Margin rose to 3,500 tonnes.pdf", "margin rose to 3500 tonnes"],
  ["en", "Revenue growth was 12.5.pdf", "revenue growth was 12"],
  ["en", "Q3 results - Operating margin fell -5% in 2024.pdf", "Operating margin fell 5% in 2024"],
  ["en", "Budget of €12.5 million approved.pdf", "Budget of £12.5 million approved"],
  ["en", "Default rate 1.5‰ in 2024.pdf", "Default rate 1.5% in 2024"],
  ["en", "The water is now here - Audited.pdf", "The water is nowhere"],
  ["zh", "营业收入增长12.5%.pdf", "营业收入增长125%"],
  ["zh", "全年销量达到3,500吨.pdf", "全年销量达到3500吨"],
  ["zh", "全年营业收入增长12.5.pdf", "全年营业收入增长12"],
  ["zh", "营业利润率同比+5%.pdf", "营业利润率同比5%"],
  ["zh", "年度预算为￥12.5万元.pdf", "年度预算为$12.5万元"],
  ["zh", "全年违约率为1.5‰.pdf", "全年违约率为1.5%"],
  ["zh", "系统记录显示 now here 两个词－Audited.pdf", "系统记录显示 nowhere 两个词"],
] as const)(
  "a name with figures or words (%s, %s): other figures or words in quotation marks are not the name",
  async (language, name, words) => {
    const citation = await citationOf(caseOf(language, name), quoting(language, words));
    expect(citation).toMatchObject(NOT_FOUND);
  },
);

// protects=the positive beside them: the same name with the same figures is a name, and so is a title whose colon or full-width colon its file name leaves out (#2504); fails_when=a name's figure marks or a mark a file name can't hold make it quoted words the page lacks; no_claim=none beyond protects.
test.each([
  ["en", "Q3 results - Operating margin fell -5% in 2024.pdf", "Operating margin fell -5% in 2024"],
  ["en", "Harbour review 2024 The final word.pdf", "Harbour review 2024: the final word"],
  ["zh", "营业利润率同比+5%.pdf", "营业利润率同比+5%"],
  ["zh", "港务局年度报告 第二部分.pdf", "港务局年度报告：第二部分"],
] as const)("the same name (%s, %s): a name", async (language, name, words) => {
  const citation = await citationOf(caseOf(language, name), quoting(language, words));
  expect(citation).toMatchObject(FOUND);
  expect(citation.quotedWords).toEqual({ name: words });
});

// protects=a part of a name is a name only as a whole part at a separator, never a piece of one (#2504); fails_when=a piece of a part, or of a name that doesn't split inside a Latin word, reads as the name; no_claim=none beyond protects.
test.each([
  [
    "en",
    "Harbour Authority annual report 2024 - Final draft.pdf",
    "Harbour Authority annual report",
  ],
  ["en", "Cooling-off notice for harbour tenants.pdf", "notice for harbour tenants"],
  ["zh", "港务局二〇二四年年度报告－定稿.pdf", "港务局二〇二四年年度"],
] as const)(
  "a piece of a name (%s, %s): quoted words the page lacks, not a name",
  async (language, name, words) => {
    const citation = await citationOf(caseOf(language, name), quoting(language, words));
    expect(citation).toMatchObject(NOT_FOUND);
  },
);

// protects=only the name of a Document the sentence's own Citations cite counts (#2504): a part of another cited Document's name, in a sentence that doesn't cite it, is quoted words the page lacks; fails_when=it reads as a name; no_claim=the whole name of another cited Document, skipped as on main.
test.each(["en", "zh"] as const)(
  "a part of another cited Document's name (%s): not a name in this sentence",
  async (language) => {
    const text = CASES[language];
    const other =
      language === "en"
        ? "Harbour Authority annual report 2024 - Final draft.pdf"
        : "港务局二〇二四年年度报告－定稿.pdf";
    const otherPage =
      language === "en"
        ? ["Report", "Tonnage handled rose by a tenth over the year."]
        : ["报告", "全年货物吞吐量增长了一成。"];
    const otherQuote =
      language === "en" ? "Tonnage handled rose by a tenth" : "全年货物吞吐量增长了一成";
    const key = language === "en" ? "lines" : "chineseLines";
    const model = citingModel({
      query: `${text.query} ${language === "en" ? "tonnage" : "吞吐量"}`,
      records: (passages: ShownPassage[]) => [
        {
          marker: 1,
          passage: passages.find((each) => each.text.includes(text.quote.slice(0, 6)))?.id,
          quote: text.quote,
        },
        {
          marker: 2,
          passage: passages.find((each) => each.text.includes(otherQuote.slice(0, 6)))?.id,
          quote: otherQuote,
        },
      ],
      answer: `${quoting(language, text.part.words)} ${language === "en" ? "Tonnage rose [^2]." : "吞吐量上升[^2]。"}`,
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: text.whole.name, contents: buildPdf([{ [key]: text.page }]) },
      { name: other, contents: buildPdf([{ [key]: otherPage }]) },
    ]);
    const { answerId } = await askAndFinish(core, client, mind.id, text.question);
    const [first] = citationsIn(client, answerId);
    expect(first).toMatchObject(NOT_FOUND);
  },
);
