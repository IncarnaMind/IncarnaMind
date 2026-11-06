/**
 * One more reading of the words an Answer puts in quotation marks (#2504), written before the code
 * it gates: words that run on to the next page across a heading it repeats with a continuation
 * mark. Each positive has decoys in the same state, which stay not found.
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
  // The second line is longer than the heading, so the app keeps the heading as a line of its own.
  first: [
    "第四条 退货与退款的处理办法",
    "货物可在收货后三十天内退回，退回时须保持商品完好并附上原始包装和购物凭证，否则不予受理。",
    "通知必须写明退回货物时不收取任何",
  ],
  // Longer than the headings, so the next page keeps them as lines of their own too.
  rest: ["费用，并须出示收据；收据丢失的，可凭订单号到门店服务台补开收据后再办理退货手续。"],
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
    expect(citation.quotedWords).toMatchObject({ runsOnTo: { kind: "page", from: 2, to: 2 } });
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

  test("a bracket at the end that isn't a continuation mark: not found", async () => {
    const draft = language === "en" ? "(draft)" : "（草稿）";
    expect(
      await citationOf(caseWith(text.first, [`${text.heading} ${draft}`]), text.quoted),
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

  test("words only on the next page: not found", async () => {
    const only =
      language === "en"
        ? "The notice says “a receipt is required” for each return [^1]."
        : "通知写明“费用，并须出示收据”的内容[^1]。";
    expect(await citationOf(caseWith(text.first, [continued]), only)).not.toMatchObject(FOUND);
  });
});

test("a Chinese heading the app reflows into a short line after it is no line of its own: not found", async () => {
  // As long as the page's longest line, the heading reads as wrapped, and is joined to the next.
  const first = [ZH.heading, "货物可在收货后三十天内退回。", ZH.first.at(-1) as string];
  const file = twoPages("zh", first, [`${ZH.heading}（续）`], ZH.rest);
  const citation = await citationOf(
    { file, query: ZH.query, question: ZH.question, quote: ZH.quote },
    ZH.quoted,
  );
  expect(citation).toMatchObject(NOT_FOUND);
});

test("three repeated lines over 200 characters together: not found", async () => {
  const long = [
    "Part Two General terms of sale for every order placed with the shop by post or online",
    "Chapter Three Delivery of the goods bought from the shop and all of the fees that apply to them",
    "Section Four Returns now",
  ];
  expect(long.join("").length).toBeGreaterThan(200);
  const file = twoPages(
    "en",
    [...long, ...EN.first.slice(1)],
    long.map((line) => `${line} (continued)`),
    EN.rest,
  );
  const citation = await citationOf(
    { file, query: EN.query, question: EN.question, quote: EN.quote },
    EN.quoted,
  );
  expect(citation).toMatchObject(NOT_FOUND);
});

// A heading over two lines is one line in Chinese once the app reflows it, so these are English.
const englishCase = (first: readonly string[], top: readonly string[]): Case => ({
  file: twoPages("en", first, top, EN.rest),
  query: EN.query,
  question: EN.question,
  quote: EN.quote,
});

test("two heading lines repeated in another order: not found", async () => {
  const second = "Clause 4.1 Fees on returned goods";
  const first = [EN.heading, second, ...EN.first.slice(1)];
  expect(
    await citationOf(
      englishCase(first, [`${second} (continued)`, `${EN.heading} (continued)`]),
      EN.quoted,
    ),
  ).toMatchObject(NOT_FOUND);
});

test("more than three lines left out: not found", async () => {
  const headings = [
    "Part Two General terms of sale",
    "Chapter 3 Delivery and returns",
    EN.heading,
    "Clause 4.1 Fees on goods",
  ];
  const first = [...headings, ...EN.first.slice(1)];
  expect(
    await citationOf(
      englishCase(
        first,
        headings.map((line) => `${line} (continued)`),
      ),
      EN.quoted,
    ),
  ).toMatchObject(NOT_FOUND);
});

test("a Chinese heading over two lines is one line once reflowed: not found", async () => {
  const second = "第四点一款 退货费用的规定";
  const first = [ZH.heading, second, ...ZH.first.slice(1)];
  const file = twoPages("zh", first, [`${ZH.heading}（续）`, `${second}（续）`], ZH.rest);
  expect(
    await citationOf({ file, query: ZH.query, question: ZH.question, quote: ZH.quote }, ZH.quoted),
  ).toMatchObject(NOT_FOUND);
});

test.each([
  [
    "en",
    {
      first: [
        "Medicines on discharge",
        "Aspirin 81 mg once a day",
        "The patient was told to keep taking every medicine on this list, including",
      ],
      top: ["Aspirin 81 mg once a day (continued)"],
      rest: [
        "Lisinopril 10 mg once a day",
        "Any new symptom should be reported to the clinic at once, by phone or in person.",
      ],
      quote: "The patient was told to keep taking every medicine",
      quoted:
        "The summary says “keep taking every medicine on this list, including Lisinopril 10 mg once a day” [^1].",
    },
  ],
  [
    "zh",
    {
      first: [
        "出院带药",
        "阿司匹林 81毫克 每日一次",
        "嘱患者出院后继续按时服用以下所列的全部药物，不得自行停药或者更改剂量，包括",
      ],
      top: ["阿司匹林 81毫克 每日一次（续）"],
      rest: [
        "赖诺普利 10毫克 每日一次",
        "如出现任何不适，患者应当立即停止服药并尽快到医院复诊，同时携带本出院小结。",
      ],
      quote: "嘱患者出院后继续按时服用以下所列的全部药物",
      quoted: "小结写明“不得自行停药或者更改剂量，包括赖诺普利 10毫克 每日一次”[^1]。",
    },
  ],
] as const)(
  "a medicine list with continued as an item's status (%s): the item is never left out, not found",
  async (language, list) => {
    const file = twoPages(language, list.first, list.top, list.rest);
    const citation = await citationOf(
      {
        file,
        query: list.quote.slice(0, 12),
        question: "What was the patient told?",
        quote: list.quote,
      },
      list.quoted,
    );
    expect(citation).toMatchObject(NOT_FOUND);
  },
);

// protects=under the heading a next page repeats, its first line may be the short end of the sentence that ran on, and the quote across it is found (#2504), in English and Chinese; fails_when=a short end reads not found; no_claim=a real end of about the heading's own length, the named cost below.
test.each([
  [
    "en",
    EN,
    "(continued)",
    ["returned.", "Goods must be sent back with a receipt within 30 days of delivery."],
    "The notice says “no fee is charged when goods are returned” [^1].",
  ],
  [
    "zh",
    ZH,
    "（续）",
    ["费用。", "退回时须出示收据；收据丢失的，可凭订单号到门店服务台补开收据后再办理退货手续。"],
    "通知写明“退回货物时不收取任何费用”[^1]。",
  ],
] as const)(
  "the short end of the sentence under the repeated heading (%s): found",
  async (language, text, mark, rest, quoted) => {
    const file = twoPages(language, text.first, [`${text.heading} ${mark}`], rest);
    const citation = await citationOf(
      { file, query: text.query, question: text.question, quote: text.quote },
      quoted,
    );
    expect(citation).toMatchObject(FOUND);
    expect(citation.quotedWords).toMatchObject({ runsOnTo: { kind: "page", from: 2 } });
  },
);

// protects=the cost of telling a list's next item from the end of a sentence (#2504): a real end of about the heading's own length under it on the next page reads as a list's next item, and the quote stays not found, as on main; fails_when=it reads found, so a list item of that length would too; no_claim=none beyond protects.
test("a real end of the sentence of about the heading's own length under it: not found, the named cost", async () => {
  const file = twoPages(
    "en",
    EN.first,
    [`${EN.heading} (continued)`],
    ["returned within 30 days.", "A receipt is required for every return and every refund."],
  );
  const citation = await citationOf(
    { file, query: EN.query, question: EN.question, quote: EN.quote },
    EN.quoted,
  );
  expect(citation).toMatchObject(NOT_FOUND);
});

test("a short list on the cited page, an item above an item of about its length: not found", async () => {
  const first = [
    "Section 4 Returns and refunds",
    "Section 5 Exchanges and repairs",
    "The notice must state that no fee is charged when goods are",
  ];
  const file = twoPages("en", first, [`${EN.heading} (continued)`], EN.rest);
  const citation = await citationOf(
    { file, query: EN.query, question: EN.question, quote: EN.quote },
    EN.quoted,
  );
  expect(citation).toMatchObject(NOT_FOUND);
});

test("the repeated heading inside the quote on the cited page, not before it: not found", async () => {
  const first = [
    "Goods can be sent back within 30 days of delivery.",
    "The notice must state that no fee is charged",
    EN.heading,
    "when goods are returned to the shop by post or by hand, and",
  ];
  const file = twoPages("en", first, [`${EN.heading} (continued)`], EN.rest);
  const citation = await citationOf(
    {
      file,
      query: EN.query,
      question: EN.question,
      quote: "The notice must state that no fee is charged",
    },
    `The notice says “no fee is charged ${EN.heading} when goods are returned to the shop by post or by hand, and returned within 30 days” [^1].`,
  );
  expect(citation).toMatchObject(NOT_FOUND);
});

test.each([
  ["across a continued heading", [`${EN.heading} (continued)`]],
  ["straight on, as #2518 reads it", []],
])("the card names the next page as the Document prints it, %s", async (_, top) => {
  const pages = [
    { lines: EN.first },
    { lines: [...top, ...EN.rest] },
    { lines: ["A third page."] },
    { lines: ["A fourth page."] },
  ];
  const file: SourceFile = {
    name: "Returns policy.pdf",
    contents: buildPdf(pages, { pageLabels: [{ page: 1, style: "D", start: 11 }] }),
  };
  const citation = await citationOf(
    { file, query: EN.query, question: EN.question, quote: EN.quote },
    EN.quoted,
  );
  expect(citation).toMatchObject(FOUND);
  expect(citation.quotedWords).toMatchObject({
    runsOnTo: { kind: "page", from: 2, printed: { from: "12" } },
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

test.each([
  ["(continued from previous page)"],
  ["(续)"],
  ["(cont’d)"],
  ["（continued）"],
  ["(CONTINUED)"],
  ["（續上頁）"],
  ["(接上页)"],
])("the continuation mark %s counts too", async (mark) => {
  // A Chinese mark is drawn with the Chinese font, which draws the English heading too.
  const next = [`${EN.heading} ${mark}`, ...EN.rest];
  const file: SourceFile = {
    name: "Returns policy.pdf",
    contents: buildPdf([
      { lines: EN.first },
      /[续續接（]/u.test(mark) ? { chineseLines: next } : { lines: next },
    ]),
  };
  const citation = await citationOf(
    { file, query: EN.query, question: EN.question, quote: EN.quote },
    EN.quoted,
  );
  expect(citation).toMatchObject(FOUND);
});

const RUN_ON = "no fee is charged when goods are returned within 30 days";
const MADE_UP = "a restocking fee of ten percent applies";

// protects=one stored value holds what the check of a sentence's quoted words found (#2504): words that aren't on the pages make the Citation not found, and its card shows them, though other quoted words of the sentence run on to the next page, whichever comes first; fails_when=the page they ran on to keeps the Citation found, or takes the place of the words not found; no_claim=none beyond protects.
test.each([
  ["the run-on words first", `The notice says “${RUN_ON}” and “${MADE_UP}” [^1].`],
  ["the words not on the pages first", `The notice says “${MADE_UP}” and “${RUN_ON}” [^1].`],
])(
  "quoted words that run on, beside quoted words the pages don't have: not found, %s",
  async (_, sentence) => {
    const citation = await citationOf(
      {
        file: twoPages("en", EN.first, [], EN.rest),
        query: EN.query,
        question: EN.question,
        quote: EN.quote,
      },
      sentence,
    );
    expect(citation).toMatchObject(NOT_FOUND);
    expect(
      parseQuotedWords(citation.quotedWords)
        ?.answer.map((piece) => piece.text)
        .join(""),
    ).toBe(MADE_UP);
  },
);
