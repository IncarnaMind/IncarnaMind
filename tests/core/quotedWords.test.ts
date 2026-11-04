/**
 * Words an Answer puts in quotation marks are checked against the Units of
 * the Passage its Citations name (#483), and in a sheet against the title rows
 * above the header, which name the table a Citation's rows are in (#2358).
 * First how an Answer's Markdown is read: which spans count, and which
 * Citations are in their sentence; then, through the core with scripted
 * models, what a User sees.
 */

import { describe, expect, test } from "vitest";
import type { QuotedWords } from "../../src/core";
import { quotedWordsIn, withoutQuotationMarks } from "../../src/core/answers/quotedWords";
import { extractCsv } from "../../src/core/documents/formats/csv";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  onlyCitation,
  type ShownPassage,
  type SourceFile,
  setUpWithDocuments,
} from "../helpers/citations";
import { xlsxPackage } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

describe("Reading the words an Answer puts in quotation marks", () => {
  test("a span of four words, with the Citations of its sentence", () => {
    expect(
      quotedWordsIn('The report says "training coverage reached 98%" [^1]. Other things [^2].'),
    ).toEqual([{ words: "training coverage reached 98%", markers: [1] }]);
  });

  test.each([
    ["curly", "The report says “training coverage reached 98%” [^1]."],
    ["single curly", "The report says ‘training coverage reached 98%’ [^1]."],
    ["corner", "报告称「training coverage reached 98%」[^1]。"],
    ["double corner", "报告称『training coverage reached 98%』[^1]。"],
    ["angle", "The report says «training coverage reached 98%» [^1]."],
  ])("in %s quotation marks", (_kind, text) => {
    expect(quotedWordsIn(text)).toEqual([{ words: "training coverage reached 98%", markers: [1] }]);
  });

  test("in Chinese, six characters or more count and fewer don't", () => {
    expect(quotedWordsIn("报告称“培训覆盖率达到98%”[^1]。")).toEqual([
      { words: "培训覆盖率达到98%", markers: [1] },
    ]);
    expect(quotedWordsIn("报告称“培训覆盖率”达到98%[^1]。")).toEqual([]);
    expect(quotedWordsIn("报告称“覆盖率”[^1]。")).toEqual([]);
    expect(quotedWordsIn("报告称“培训覆盖率已达”[^1]。")).toHaveLength(1);
  });

  test("a term or a name is not a quote", () => {
    expect(quotedWordsIn("The “Site Safety Report” covers “three sites” [^1].")).toEqual([]);
  });

  test("the marker may come before the closing punctuation, after it, or inside the quotation marks", () => {
    for (const text of [
      "It says “training coverage reached 98%”[^1].",
      "It says “training coverage reached 98%”. [^1] Next.",
      "It says “training coverage reached 98%[^1]”.",
    ]) {
      expect(quotedWordsIn(text)).toEqual([
        { words: "training coverage reached 98%", markers: [1] },
      ]);
    }
  });

  test("a comma or full stop inside the closing mark is typography, not the Document's words", () => {
    expect(quotedWordsIn("“Training coverage reached 98%,” it says [^1].")).toEqual([
      { words: "Training coverage reached 98%", markers: [1] },
    ]);
    expect(quotedWordsIn("报告称“培训覆盖率达到98%。”[^1]")).toEqual([
      { words: "培训覆盖率达到98%", markers: [1] },
    ]);
  });

  test("a sentence with no Citation is left alone", () => {
    expect(quotedWordsIn("It says “training coverage reached 98%”. Other things [^1].")).toEqual(
      [],
    );
  });

  test("a full stop inside the quotation marks does not end the sentence", () => {
    expect(
      quotedWordsIn("It says “Training was held. Coverage reached 98% of staff.” [^2]"),
    ).toEqual([{ words: "Training was held. Coverage reached 98% of staff", markers: [2] }]);
  });

  test("two quotes in one sentence, each with the sentence's Citations", () => {
    expect(
      quotedWordsIn(
        "It says “training coverage reached 98%” [^1] and “every site passed its audit” [^2].",
      ),
    ).toEqual([
      { words: "training coverage reached 98%", markers: [1, 2] },
      { words: "every site passed its audit", markers: [1, 2] },
    ]);
  });

  test("a quote may run across a line break, and an apostrophe is not a quotation mark", () => {
    expect(quotedWordsIn("It says “training coverage\nreached 98%” [^1].")).toEqual([
      { words: "training coverage reached 98%", markers: [1] },
    ]);
    expect(quotedWordsIn("The firm's board and the partners' vote were held [^1].")).toEqual([]);
  });

  test("none in code or a heading's Citation-less line; a table's cell is a sentence", () => {
    expect(
      quotedWordsIn(
        [
          "```",
          'say "training coverage reached 98%" [^1]',
          "```",
          "",
          "| Claim | Where |",
          "|:--|:--|",
          '| "training coverage reached 98%" [^1] | p. 3 |',
        ].join("\n"),
      ),
    ).toEqual([{ words: "training coverage reached 98%", markers: [1] }]);
  });

  test("a stray mark doesn't take in the sentences after it", () => {
    expect(quotedWordsIn('A 5" pipe is fine [^1]. Then "it ended here [^2].')).toEqual([]);
  });
});

describe("Taking quotation marks off words", () => {
  const taken = (markdown: string, ...words: string[]) =>
    withoutQuotationMarks(markdown, new Set(words));

  test("only the words given lose their marks, in a paragraph, a heading and a table's cell", () => {
    const markdown = [
      "## The report says “training coverage reached 98%” [^1]",
      "",
      "报告称“培训覆盖率达到98%”[^1]，并写道“every site passed its audit”[^2]。",
      "",
      "| Claim | Where |",
      "|:--|:--|",
      '| "training coverage reached 98%" [^1] | p. 3 |',
    ].join("\n");

    expect(taken(markdown, "培训覆盖率达到98%", "training coverage reached 98%")).toBe(
      [
        "## The report says training coverage reached 98% [^1]",
        "",
        "报告称培训覆盖率达到98%[^1]，并写道“every site passed its audit”[^2]。",
        "",
        "| Claim | Where |",
        "|:--|:--|",
        "| training coverage reached 98% [^1] | p. 3 |",
      ].join("\n"),
    );
  });

  test("a quote across a line break keeps its lines, and code is left alone", () => {
    const markdown = [
      "It says “training coverage",
      "reached 98%” [^1].",
      "",
      "```",
      'say "training coverage reached 98%" [^1]',
      "```",
    ].join("\n");

    expect(taken(markdown, "training coverage reached 98%")).toBe(
      [
        "It says training coverage",
        "reached 98% [^1].",
        "",
        "```",
        'say "training coverage reached 98%" [^1]',
        "```",
      ].join("\n"),
    );
  });

  test("with no words given, nothing changes", () => {
    const markdown = 'It says "training coverage reached 98%" [^1].';
    expect(taken(markdown)).toBe(markdown);
  });
});

/** The Document: one sentence, as a Markdown file, in English and in Chinese. */
const REPORTS = {
  en: {
    name: "Site safety report.md",
    contents:
      "# Site safety report\n\nSafety training: coverage reached 98% of site staff, up 6 points on 2024.\n",
    quote: "coverage reached 98% of site staff",
    query: "training coverage",
    question: "How many staff were trained?",
    found: "The report says “coverage reached 98% of site staff” [^1].",
    changed: "The report says “training coverage reached 98% of site staff” [^1].",
    term: "The report says “site staff” reached 98% [^1].",
    uncited:
      "Coverage is high [^1]. The report says “training coverage reached 98% of site staff”.",
    answer: [
      { text: "training ", found: false },
      { text: "coverage reached 98% of site staff", found: true },
    ],
    closest: [
      { text: "Safety training: ", found: false },
      { text: "coverage reached 98% of site staff", found: true },
      { text: ", up 6 points on 2024.", found: false },
    ],
  },
  zh: {
    name: "安全生产报告.md",
    contents: "# 安全生产报告\n\n安全培训，覆盖率达到98%，较上年提高 6 个百分点。\n",
    quote: "覆盖率达到98%",
    query: "覆盖率",
    question: "培训覆盖率是多少？",
    found: "报告称“覆盖率达到98%”[^1]。",
    changed: "报告称“培训覆盖率达到98%”[^1]。",
    term: "报告称“覆盖率”达到98%[^1]。",
    uncited: "覆盖率很高[^1]。报告称“培训覆盖率达到98%”。",
    answer: [
      { text: "培训", found: false },
      { text: "覆盖率达到98%", found: true },
    ],
    closest: [
      { text: "安全培训，", found: false },
      { text: "覆盖率达到98%", found: true },
      { text: "，较上年提高 6 个百分点。", found: false },
    ],
  },
} as const;

/** Asks one Question whose Answer is `answer`, citing the report's quote; gives the Answer's Citations. */
async function askWithQuote(language: keyof typeof REPORTS, answer: string) {
  const report = REPORTS[language];
  const model = citingModel({
    query: report.query,
    records: (passages: ShownPassage[]) => [
      { marker: 1, passage: passages[0]?.id, quote: report.quote },
    ],
    answer,
  });
  const { core, client, mind } = await setUpWithDocuments(model, [
    { name: report.name, contents: report.contents },
  ]);
  const { answerId, finished } = await askAndFinish(core, client, mind.id, report.question);
  return { client, answerId, finished };
}

describe.each(["en", "zh"] as const)("Quoted words in an Answer's sentence (%s)", (language) => {
  const report = REPORTS[language];

  test("words that are in the cited Unit change nothing", async () => {
    const { client, answerId, finished } = await askWithQuote(language, report.found);

    const citation = onlyCitation(client, answerId);
    expect(citation).toMatchObject({ check: "found", checkReason: null });
    expect(citation.quotedWords).toBeUndefined();
    expect(finished.citations).toHaveLength(1);
    expect(finished.citations[0]?.quotedWords).toBeUndefined();
  });

  test("words that differ by one word are not found: the Citation shows not found, with both texts", async () => {
    const { client, answerId, finished } = await askWithQuote(language, report.changed);

    const citation = onlyCitation(client, answerId);
    expect(citation).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      // The Citation's own quote is still the record's, which the Document has.
      quote: report.quote,
    });
    const expected: QuotedWords = {
      answer: [...report.answer],
      closest: [...report.closest],
    };
    expect(citation.quotedWords).toEqual(expected);
    expect(finished.citations[0]).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      quotedWords: expected,
    });
  });

  test("a term in quotation marks is not a quote", async () => {
    const { client, answerId } = await askWithQuote(language, report.term);

    expect(onlyCitation(client, answerId)).toMatchObject({ check: "found", checkReason: null });
  });

  test("words in a sentence with no Citation are left alone", async () => {
    const { client, answerId } = await askWithQuote(language, report.uncited);

    const citations = citationsIn(client, answerId);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ check: "found", checkReason: null });
  });
});

/** A sheet's title, header and quoted row, and what a quote of the row reads as in the Passage. */
const STORE = {
  en: {
    name: "Stores.csv",
    title: "2026 Q3 store sales",
    header: "Store,City,Sales",
    row: 'Changjiang Road Flagship,Wenzhou,"¥621,383"',
    filler: (index: number) => `Store ${index + 1},Hangzhou,${1000 + index}`,
    holds: "Changjiang Road Flagship",
    quote: "Changjiang Road Flagship Wenzhou ¥621,383",
    otherRow: "Store 1 Hangzhou 1000",
    query: "Changjiang Road Flagship sales",
    question: "What were the Changjiang Road Flagship's Q3 sales?",
  },
  zh: {
    name: "门店销售.xlsx",
    title: "2026年第三季度门店销售",
    header: ["门店", "城市", "销售额"],
    row: ["长江路旗舰店", "温州", "¥621,383"],
    filler: (index: number) => [`长江路一号店${index + 1}`, "杭州", `¥${2000 + index}`],
    holds: "长江路旗舰店",
    quote: "长江路旗舰店 温州 ¥621,383",
    otherRow: "长江路一号店1 杭州 ¥2000",
    query: "长江路旗舰店 第三季度 销售额",
    question: "长江路旗舰店第三季度的销售额是多少？",
  },
} as const;

/** Another Document's row, for a quote that is not in the Passage a Citation names. */
const STOCK = {
  en: {
    name: "Stock.csv",
    contents: () => "Item,Warehouse,Units\nFrozen dumplings,Xiaoshan cold store,6300",
    quote: "Frozen dumplings Xiaoshan cold store 6300",
  },
  zh: {
    name: "库存.xlsx",
    contents: () =>
      xlsxPackage({
        sheets: [
          {
            name: "库存",
            xml: `<sheetData>${sheetRow(1, ["商品", "仓库", "库存量"])}${sheetRow(2, ["冷冻水饺", "萧山冷链仓", "6300"])}</sheetData>`,
          },
        ],
      }),
    quote: "冷冻水饺 萧山冷链仓 6300",
  },
} as const;

const cellRef = (column: number, row: number) => `${String.fromCharCode(65 + column)}${row}`;
const sheetRow = (row: number, values: readonly string[]) =>
  `<row r="${row}">${values
    .map(
      (value, column) =>
        `<c r="${cellRef(column, row)}" t="inlineStr"><is><t>${value}</t></is></c>`,
    )
    .join("")}</row>`;

/**
 * A sheet whose first Unit is its first 100 rows: a title, the header, 99
 * stores, and the quoted row, which starts the second Unit. With `blank`, two
 * empty rows lie between the title and the header, as a writer leaves them.
 */
function storeRows(blank = false): { row: number; values: readonly string[] }[] {
  const { title, header, filler, row } = STORE.zh;
  const first = blank ? 4 : 2;
  return [
    { row: 1, values: [title] },
    { row: first, values: [...header] },
    ...Array.from({ length: 99 }, (_, at) => ({ row: first + 1 + at, values: filler(at) })),
    { row: first + 100, values: [...row] },
  ];
}

/** The stores as a CSV, for English. */
function storeCsv(blank = false): string {
  const { title, header, filler, row } = STORE.en;
  return [
    title,
    ...(blank ? ["", ""] : []),
    header,
    ...Array.from({ length: 99 }, (_, at) => filler(at)),
    row,
  ].join("\n");
}

/** The stores as a workbook, for Chinese. */
function storeWorkbook(blank = false): Buffer {
  return xlsxPackage({
    sheets: [
      {
        name: "销售",
        xml: `<sheetData>${storeRows(blank)
          .map(({ row, values }) => sheetRow(row, values))
          .join("")}</sheetData>`,
      },
    ],
  });
}

/**
 * The Unit each text is on in the fixture: the title and the quoted row are on
 * different ones, which is what the Passage's quote check has to survive (#2358).
 */
async function unitOf(language: "en" | "zh", needle: string): Promise<number | null> {
  const units =
    language === "en"
      ? extractCsv(new TextEncoder().encode(storeCsv())).units
      : (await extractXlsx(new Uint8Array(storeWorkbook()))).units;
  return units.find((unit) => unit.text.includes(needle))?.page ?? null;
}

/** Asks a Question, citing `quote` from the Passage that holds `holds`; gives the Answer's Citations. */
async function askStore(
  language: "en" | "zh",
  answer: string,
  {
    quote = STORE[language].quote,
    stock = false,
    blank = false,
  }: { quote?: string; stock?: boolean; blank?: boolean } = {},
) {
  const store = STORE[language];
  const model = citingModel({
    query: store.query,
    records: (passages: ShownPassage[]) => [
      {
        marker: 1,
        passage: passages.find((passage) => passage.text.includes(store.holds))?.id,
        quote,
      },
    ],
    answer,
  });
  const contents = language === "en" ? storeCsv(blank) : storeWorkbook(blank);
  const files: SourceFile[] = [{ name: store.name, contents }];
  if (stock) files.push({ name: STOCK[language].name, contents: STOCK[language].contents() });
  const { core, client, mind } = await setUpWithDocuments(model, files);
  const { answerId } = await askAndFinish(core, client, mind.id, store.question);
  core.close();
  return citationsIn(client, answerId);
}

describe("Quoted words on a sheet's rows (#2358)", { timeout: 60_000 }, () => {
  test.each(["en", "zh"] as const)(
    "%s: a quoted row and the table's title above the header stay found",
    async (language) => {
      const answer =
        language === "en"
          ? `The “${STORE.en.title}” table gives Changjiang Road Flagship’s sales as ¥621,383 [^1].`
          : `长江路旗舰店（温州）第三季度销售额为 ¥621,383，见“${STORE.zh.title}”表格[^1]。`;

      // The title row and the row the Citation names are on different Units.
      expect(await unitOf(language, STORE[language].title)).not.toBe(
        await unitOf(language, STORE[language].holds),
      );

      const [citation] = await askStore(language, answer);

      // The title rows name the table the Citation's rows are in, so the place holds them.
      expect(citation).toMatchObject({
        quote: STORE[language].quote,
        check: "found",
        checkReason: null,
        pageFrom: 2,
        pageTo: 2,
      });
      expect(citation?.quotedWords).toBeUndefined();
    },
  );

  test.each(["en", "zh"] as const)(
    "%s: a row quoted from the Passage's other Unit is not found",
    async (language) => {
      const other = STORE[language].otherRow;
      const answer =
        language === "en"
          ? `The “${other}” row is in the table, so the figure is ¥621,383 [^1].`
          : `表中的“${other}”一行显示 ¥621,383 [^1]。`;

      const [citation] = await askStore(language, answer);

      // Another Unit's data row is not the table's title: the place shown doesn't hold it.
      expect(citation).toMatchObject({
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
    },
  );

  test.each(["en", "zh"] as const)(
    "%s: a data row under blank rows is not the title and is not found",
    async (language) => {
      const other = STORE[language].otherRow;
      const answer =
        language === "en"
          ? `The “${other}” row is the first of the table, so the figure is ¥621,383 [^1].`
          : `表中第一行“${other}”显示 ¥621,383 [^1]。`;

      const [citation] = await askStore(language, answer, { blank: true });

      // Two blank rows between the title and the header don't make data a title.
      expect(citation).toMatchObject({
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
    },
  );

  test.each(["en", "zh"] as const)(
    "%s: a row of another Document in quotation marks is not found",
    async (language) => {
      const answer =
        language === "en"
          ? `“Frozen dumplings Xiaoshan cold store 6300” is the stock line for the same figure [^1].`
          : `“冷冻水饺 萧山冷链仓 6300”是同一条数字的库存记录[^1]。`;

      const [citation] = await askStore(language, answer, {
        quote: STOCK[language].quote,
        stock: true,
      });

      expect(citation).toMatchObject({
        check: "not-found",
        checkReason: "quote-not-on-pages",
      });
    },
  );

  test.each(["en", "zh"] as const)(
    "%s: a paraphrase of the title is still not found",
    async (language) => {
      const answer =
        language === "en"
          ? "The “2026 Q3 store takings” table gives Changjiang Road Flagship’s sales as ¥621,383 [^1]."
          : "长江路旗舰店（温州）第三季度销售额为 ¥621,383，见“2026年第四季度门店销售”表格[^1]。";

      const [citation] = await askStore(language, answer);

      expect(citation).toMatchObject({
        check: "not-found",
        checkReason: "quoted-words-not-on-pages",
      });
    },
  );

  test("a PDF page the Citation does not cite is not found", async () => {
    const model = citingModel({
      query: "harbour survey tide",
      records: (passages: ShownPassage[]) => [
        {
          marker: 1,
          passage: passages.find((passage) => passage.text.includes("The survey ended in March."))
            ?.id,
          pageFrom: 2,
          pageTo: 2,
          quote: "The survey ended in March.",
        },
      ],
      answer:
        "The survey says “the harbour floor is mostly sand” on its first page [^1], and it ended in March.",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      {
        name: "Survey.pdf",
        contents: buildPdf([
          {
            lines: [
              "Survey of the harbour",
              "The harbour floor is mostly sand.",
              "The survey ended in March.",
            ],
          },
          { lines: ["The survey ended in March.", "Divers mapped the old wreck."] },
        ]),
      },
    ]);
    const { answerId } = await askAndFinish(core, client, mind.id, "When did the survey end?");

    // The words are on the page the Citation does not cite, and sheets aside, a place is not widened.
    expect(citationsIn(client, answerId)[0]).toMatchObject({
      check: "not-found",
      checkReason: "quoted-words-not-on-pages",
      pageFrom: 2,
      pageTo: 2,
    });
    core.close();
  });
});
