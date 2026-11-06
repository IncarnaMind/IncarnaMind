/**
 * A cited Document's name in quotation marks, or a part of it at a separator, is a name, not a
 * quote (#2504): the Citation keeps its own quote's check, and says the words are the Document's
 * name. The name is neutral: it never makes the Citation found, and other quoted words the pages
 * don't have still make it not found. Written before the code it gates.
 */
import { describe, expect, test } from "vitest";
import { parseQuotedWords } from "../../src/shared/citations";
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
