/**
 * Words an Answer quotes from its Document are found when they run on from the cited page to the
 * next (#2504), and the Citation names that page. A quote that changes a word or a number, takes a word from another line or leaves
 * words out still shows Quote not found.
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
import { para, pptxOf, sp, txBody } from "../helpers/pptx";

interface Case {
  file: SourceFile;
  query: string;
  question: string;
  /** The record's quote, which is on the page. */
  quote: string;
}

/** The check of the one Citation of an Answer whose sentence is `sentence`, citing `quote`. */
async function checkOf({ file, query, question, quote }: Case, sentence: string) {
  const model = citingModel({
    query,
    records: (passages: ShownPassage[]) => [{ marker: 1, passage: passages[0]?.id, quote }],
    answer: sentence,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [file]);
  const { answerId } = await askAndFinish(core, client, mind.id, question);
  const { check, checkReason } = onlyCitation(client, answerId);
  return { check, checkReason };
}

const FOUND = { check: "found", checkReason: null };
const NOT_FOUND = { check: "not-found", checkReason: "quoted-words-not-on-pages" };

const RUN_ON_PAGES = {
  first: [
    "Clause 26 Delivery of items",
    "When a representative offers to drop items off, the reply card must say that there is no",
    "obligation to grant an interview when items are",
  ],
  second: [
    "delivered. Items can be returned without explanation.",
    "The reply card must give the health professional a way to say no.",
  ],
};

const RUN_ON = {
  en: {
    file: {
      name: "Code of Practice.pdf",
      contents: buildPdf([{ lines: RUN_ON_PAGES.first }, { lines: RUN_ON_PAGES.second }]),
    },
    query: "reply card interview",
    question: "What must the reply card say?",
    quote: "the reply card must say that there is no",
    found:
      "The card must say there is “no obligation to grant an interview when items are delivered” [^1].",
    otherLine:
      "The card must say there is “no obligation to grant an interview when items are returned” [^1].",
    number:
      "The card must say there is “no obligation to grant an interview when 3 items are delivered” [^1].",
    nextPageOnly: "The card says “Items can be returned without explanation” [^1].",
    ellipsis:
      "The card must say there is “no obligation to grant an interview … give the health professional a way to say no” [^1].",
  },
  zh: {
    file: {
      name: "行为准则.pdf",
      contents: buildPdf([
        {
          chineseLines: [
            "第二十六条 物品递送",
            "代表提出送来物品时，回执卡必须写明医务人员没有义务在物品送达",
          ],
        },
        {
          chineseLines: [
            "时接受面谈。物品可以退回，无须向代表说明任何理由。",
            "回执卡必须让医务人员可以拒绝。",
          ],
        },
      ]),
    },
    query: "回执卡 面谈",
    question: "回执卡必须写明什么？",
    quote: "回执卡必须写明医务人员没有义务",
    found: "回执卡必须写明“医务人员没有义务在物品送达时接受面谈”[^1]。",
    otherLine: "回执卡必须写明“医务人员没有义务在物品退回时接受面谈”[^1]。",
    number: "回执卡必须写明“医务人员没有义务在3件物品送达时接受面谈”[^1]。",
    nextPageOnly: "回执卡写明“物品可以退回，无须向代表说明任何理由”[^1]。",
    ellipsis:
      "回执卡写明“回执卡必须写明医务人员没有义务在物品送达……物品可以退回，无须向代表说明任何理由”[^1]。",
  },
} as const;

describe.each(["en", "zh"] as const)(
  "Quoted words that run on to the next page (%s)",
  (language) => {
    const runOn = RUN_ON[language];

    test("starting on the cited page and running on to the next page: found", async () => {
      expect(await checkOf(runOn, runOn.found)).toEqual(FOUND);
    });

    test.each([
      ["a word from another line", "otherLine"],
      ["a number added", "number"],
      ["words only on the next page", "nextPageOnly"],
      ["a part after an ellipsis only on the next page", "ellipsis"],
    ] as const)("with %s, not found", async (_, key) => {
      expect(await checkOf(runOn, runOn[key])).toEqual(NOT_FOUND);
    });
  },
);

describe("Quoted words that run on to the next slide", () => {
  test("a slide is a place of its own: words joined from two slides are not found", async () => {
    const slideOf = (text: string) => ({
      shapes: sp({ id: 2, name: "Body", txBox: true, body: txBody(para(text)) }),
    });
    const deck = {
      file: {
        name: "Results.pptx",
        contents: new Uint8Array(
          pptxOf({
            slides: [
              slideOf("Costs fell 4% this year and revenue grew"),
              slideOf("12% in Asia was the target for next year."),
            ],
          }),
        ),
      },
      query: "revenue grew",
      question: "How did revenue do?",
      quote: "Costs fell 4% this year and revenue grew",
    };

    expect(
      await checkOf(deck, "It says “costs fell 4% this year and revenue grew 12% in Asia” [^1]."),
    ).toEqual(NOT_FOUND);
  });
});

describe("Changed words in Chinese stay not found", () => {
  const governance = {
    file: {
      name: "公司治理.md",
      contents:
        "# 公司治理\n\n其他該注意事項包括報告和透明度、商業道德、董事會監督、執行長/董事會主席由不同人擔任、股東提名董事會候選人的權利。\n",
    },
    query: "董事會主席",
    question: "公司治理要注意什么？",
    quote: "執行長/董事會主席由不同人擔任",
  };

  test("a word put in for the page's (CEO for 執行長): not found", async () => {
    expect(await checkOf(governance, "条目列出“CEO/董事会主席由不同人担任”[^1]。")).toEqual(
      NOT_FOUND,
    );
  });

  test("the page's words in simplified characters: found", async () => {
    expect(await checkOf(governance, "条目列出“执行长/董事会主席由不同人担任”[^1]。")).toEqual(
      FOUND,
    );
  });
});

describe("Quoted words that run on past the end of their Passage", () => {
  test("the next page is read even where the Passage the record names ends at the cited page", async () => {
    const filler = (line: number) =>
      `Filler line ${String(line).padStart(2, "0")} about the general terms of the code for every representative.`;
    const file = {
      name: "Code of Practice.pdf",
      contents: buildPdf([
        {
          lines: [
            "Clause 26 Delivery of items",
            ...Array.from({ length: 22 }, (_, line) => filler(line)),
            "When a representative offers to drop items off, the reply card must say that there is no",
            "obligation to grant an interview when items are",
          ],
        },
        {
          lines: [
            "delivered. Items can be returned without explanation, and the representative must accept that at once.",
            "The reply card must give the health professional a way to say no.",
          ],
        },
      ]),
    };
    let passagePages: (string | null)[] = [];
    const model = citingModel({
      query: "reply card interview obligation",
      records: (passages: ShownPassage[]) => {
        passagePages = passages.map((passage) => passage.pages);
        const onFirstPage = passages.find(
          (passage) => passage.pages === "1" && passage.text.includes("obligation to grant"),
        );
        return [
          {
            marker: 1,
            passage: onFirstPage?.id,
            quote: "the reply card must say that there is no",
          },
        ];
      },
      answer:
        "The card must say there is “no obligation to grant an interview when items are delivered” [^1].",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [file]);
    const { answerId } = await askAndFinish(core, client, mind.id, "What must the reply card say?");

    expect(passagePages).toContain("1");
    const { check, checkReason } = onlyCitation(client, answerId);
    expect({ check, checkReason }).toEqual(FOUND);
  });
});

describe("Quoted words that run on, only from one cited page to the next", () => {
  const page = (lines: string[]) => ({ lines });
  const file = {
    name: "Storage rules.pdf",
    contents: buildPdf([
      page([
        "Storage",
        "Every sample is labelled at intake and logged in the register before it is",
      ]),
      page([
        "moved to the cold room on the same day by the duty technician on shift,",
        "where it stays at four degrees until it is",
      ]),
      page(["tested by the laboratory, and samples older than ninety days are destroyed."]),
    ]),
  };
  const ask = (quote: string, sentence: string) =>
    checkOf({ file, query: "sample cold room", question: "Where do samples go?", quote }, sentence);

  test("words starting on the one cited page run on to the next: found", async () => {
    expect(
      await ask(
        "where it stays at four degrees until it is",
        "It says samples stay “at four degrees until it is tested by the laboratory” [^1].",
      ),
    ).toEqual(FOUND);
  });

  test("a record that cites two pages doesn't run on to a third: not found", async () => {
    expect(
      await ask(
        "logged in the register before it is moved to the cold room",
        "It says samples stay “at four degrees until it is tested by the laboratory” [^1].",
      ),
    ).toEqual(NOT_FOUND);
  });

  test("words that run past the next page: not found", async () => {
    expect(
      await ask(
        "logged in the register before it is",
        "It says a sample is “logged in the register before it is moved to the cold room on the same day by the duty technician on shift, where it stays at four degrees until it is tested by the laboratory” [^1].",
      ),
    ).toEqual(NOT_FOUND);
  });
});

/** The one Citation of an Answer whose sentence is `sentence`, citing `quote`. */
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

// protects=a Citation whose quoted words run on to the next page says where they continue (#2504), its card naming the next page; fails_when=the Citation says nothing of the page; no_claim=the card's wording.
test.each(["en", "zh"] as const)(
  "quoted words that run on to the next page: the Citation names that page (%s)",
  async (language) => {
    const runOn = RUN_ON[language];
    const citation = await citationOf(runOn, runOn.found);
    expect(citation).toMatchObject(FOUND);
    expect(citation.quotedWords).toEqual({ runsOnTo: { kind: "page", from: 2, to: 2 } });
  },
);

// protects=the next page is named as the Document prints it (#2504), as the Citation's own Location is, so a PDF that numbers its own pages says the printed one; fails_when=the card says the file's page number; no_claim=none beyond protects.
test("the next page is named as the Document prints it", async () => {
  const file = {
    name: "Code of Practice.pdf",
    contents: buildPdf(
      [
        { lines: RUN_ON_PAGES.first },
        { lines: RUN_ON_PAGES.second },
        { lines: ["A third page."] },
        { lines: ["A fourth page."] },
      ],
      { pageLabels: [{ page: 1, style: "D", start: 11 }] },
    ),
  };
  const citation = await citationOf({ ...RUN_ON.en, file }, RUN_ON.en.found);
  expect(citation).toMatchObject(FOUND);
  expect(citation.quotedWords).toMatchObject({
    runsOnTo: { kind: "page", from: 2, printed: { from: "12" } },
  });
});

const MADE_UP = "a refusal must be given in writing within ten days";
const RUNS_ON = "no obligation to grant an interview when items are delivered";

// protects=one stored value holds what the check of a sentence's quoted words found (#2504): words that aren't on the pages make the Citation not found, and its card shows them, though other quoted words of the sentence run on to the next page, whichever comes first; fails_when=the page they ran on to keeps the Citation found, or takes the place of the words not found; no_claim=none beyond protects.
test.each([
  ["the run-on words first", `The card must say “${RUNS_ON}” and “${MADE_UP}” [^1].`],
  ["the words not on the pages first", `The card must say “${MADE_UP}” and “${RUNS_ON}” [^1].`],
])(
  "quoted words that run on, beside quoted words the pages don't have: not found, %s",
  async (_, sentence) => {
    const citation = await citationOf(RUN_ON.en, sentence);
    expect(citation).toMatchObject(NOT_FOUND);
    expect(
      parseQuotedWords(citation.quotedWords)
        ?.answer.map((piece) => piece.text)
        .join(""),
    ).toBe(MADE_UP);
  },
);
