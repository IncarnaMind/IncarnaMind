/**
 * A call help quote that is cells of a table (#2847): each cell's words as the quote gives them,
 * after its column's name where the table gives one, from the tables the cited Units hold, in
 * English and Chinese. Made-up price lists; nothing is read from a file.
 */
import { describe, expect, test } from "vitest";
import { LONGEST_CELL, MOST_CELLS, quoteCells } from "../../src/core/answers/quoteCells";
import type { UnitText } from "../../src/shared/units";

/** A PDF page whose index stored its table's rows and headings. */
const pdfPage = (headings: string[], rows: string[][], page = 2): UnitText => ({
  page,
  kind: "page",
  text: [headings.join(" "), ...rows.map((row) => row.join(" "))].join("\n"),
  label: { tables: [{ headings, rows }] },
});

/** A sheet's rows as its Unit shows them, from row 1 and column A. */
const sheet = (lines: string[][], name = "Prices"): UnitText => ({
  page: 1,
  kind: "rows",
  text: lines.map((cells) => cells.join("\t")).join("\n"),
  label: { sheet: name, rows: lines.map((_, index) => index + 1), column: 0 },
});

/** A section of a Markdown Document. */
const section = (text: string): UnitText => ({ page: 1, kind: "section", text, label: null });

const PLANS = [
  ["Plan", "Price", "Sign-on"],
  ["Team", "$25 per seat a month", "No"],
  ["Enterprise", "$45 per seat a month", "Yes"],
];

const 方案 = [
  ["方案", "价格", "单点登录"],
  ["团队版", "每个席位每月 25 美元", "否"],
  ["企业版", "每个席位每月 45 美元", "是"],
];

describe("A quote that is cells of a table", () => {
  // protects=a quote of a table's row is drawn cell by cell, each value the quote's own words after its column's heading, from a PDF's stored table, a sheet's header row and a Markdown table, in English and Chinese (#2847); fails_when=a value differs from the quote's words, a cell takes a name its table doesn't give, or a row's cells come out of order; no_claim=how the panel lays them out.
  test.each([
    [
      "a PDF's stored table",
      [pdfPage(PLANS[0] ?? [], PLANS.slice(1))],
      "Enterprise $45 per seat a month Yes",
    ],
    ["a sheet under its header row", [sheet(PLANS)], "Enterprise\t$45 per seat a month\tYes"],
    [
      "a Markdown table",
      [
        section(
          "Our prices.\n\n| Plan | Price | Sign-on |\n|---|---|---|\n| Team | $25 per seat a month | No |\n| Enterprise | $45 per seat a month | Yes |",
        ),
      ],
      "| Enterprise | $45 per seat a month | Yes |",
    ],
  ])("in English, from %s: each value after its column's name", (_, units, quote) => {
    expect(quoteCells(quote, units)).toEqual([
      { name: "Plan", value: "Enterprise" },
      { name: "Price", value: "$45 per seat a month" },
      { name: "Sign-on", value: "Yes" },
    ]);
  });

  test.each([
    [
      "a PDF's stored table",
      [pdfPage(方案[0] ?? [], 方案.slice(1))],
      "企业版 每个席位每月 45 美元 是",
    ],
    ["a sheet under its header row", [sheet(方案, "价格")], "企业版\t每个席位每月 45 美元\t是"],
  ])("in Chinese, from %s: each value after its column's name", (_, units, quote) => {
    expect(quoteCells(quote, units)).toEqual([
      { name: "方案", value: "企业版" },
      { name: "价格", value: "每个席位每月 45 美元" },
      { name: "单点登录", value: "是" },
    ]);
  });

  test("a quote cut inside a cell keeps the words it holds, and nothing it doesn't", () => {
    expect(quoteCells("Enterprise\t$45 per seat", [sheet(PLANS)])).toEqual([
      { name: "Plan", value: "Enterprise" },
      { name: "Price", value: "$45 per seat" },
    ]);
    expect(
      quoteCells("prise $45 per seat a month", [pdfPage(PLANS[0] ?? [], PLANS.slice(1))]),
    ).toEqual([
      { name: "Plan", value: "prise" },
      { name: "Price", value: "$45 per seat a month" },
    ]);
  });

  test("a cell its table names nothing over keeps no name: never one the table doesn't give", () => {
    // A sheet of figures alone has no header row.
    const figures = sheet([
      ["2025", "120", "4.5%"],
      ["2026", "135", "5.1%"],
    ]);
    expect(quoteCells("2026\t135\t5.1%", [figures])).toEqual([
      { name: null, value: "2026" },
      { name: null, value: "135" },
      { name: null, value: "5.1%" },
    ]);
    // A Markdown table of words alone: the figure checks' reader gives its rows no headings.
    const words = section(
      "| Plan | Support |\n|---|---|\n| Team | Email |\n| Enterprise | Phone |",
    );
    expect(quoteCells("| Enterprise | Phone |", [words])).toEqual([
      { name: null, value: "Enterprise" },
      { name: null, value: "Phone" },
    ]);
    // A PDF table whose stored heading for a column is empty.
    const blank = pdfPage(["Plan", ""], [["Enterprise", "$45"]]);
    expect(quoteCells("Enterprise $45", [blank])).toEqual([
      { name: "Plan", value: "Enterprise" },
      { name: null, value: "$45" },
    ]);
  });

  test("a quote that isn't two cells of a table is drawn as quoted", () => {
    expect(quoteCells("$45 per seat a month", [sheet(PLANS)])).toBeNull();
    expect(quoteCells("Enterprise", [sheet(PLANS)])).toBeNull();
    expect(
      quoteCells("Enterprise plan: $45 per seat a month, with single sign-on.", [
        section("- Enterprise plan: $45 per seat a month, with single sign-on."),
      ]),
    ).toBeNull();
    expect(quoteCells("Enterprise\t$46 per seat a month", [sheet(PLANS)])).toBeNull();
  });

  test("two tables that name the same words otherwise leave the quote as quoted", () => {
    const other = sheet(
      [
        ["Tier", "Cost", "SSO"],
        ["Enterprise", "$45 per seat a month", "Yes"],
      ],
      "Old prices",
    );
    expect(quoteCells("Enterprise\t$45 per seat a month", [sheet(PLANS), other])).toBeNull();
  });

  // protects=a stored reply never grows with a wide row or a long cell: past the caps the Citation has no cells and its line draws as quoted, never a cut name or value (#2847); fails_when=a row of more than the most cells, or a cell longer than the longest, gives cells; no_claim=where the caps are stored.
  test(`over ${MOST_CELLS} cells, or a cell over ${LONGEST_CELL} characters, it is drawn as quoted`, () => {
    const wide = Array.from({ length: MOST_CELLS + 1 }, (_, index) => `C${index + 1}`);
    const values = Array.from({ length: MOST_CELLS + 1 }, (_, index) => `${index + 10}`);
    expect(quoteCells(values.join("\t"), [sheet([wide, values])])).toBeNull();
    expect(
      quoteCells(values.slice(0, MOST_CELLS).join("\t"), [sheet([wide, values])]),
    ).toHaveLength(MOST_CELLS);
    const long = "word ".repeat(41).trim();
    expect(long.length).toBeGreaterThan(LONGEST_CELL);
    expect(
      quoteCells(`Enterprise\t${long}`, [
        sheet([
          ["Plan", "Notes", "Price"],
          ["Enterprise", long, "$45"],
        ]),
      ]),
    ).toBeNull();
  });
});
