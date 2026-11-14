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
    // A PDF table whose stored heading for a column is empty.
    const blank = pdfPage(["Plan", ""], [["Enterprise", "$45"]]);
    expect(quoteCells("Enterprise $45", [blank])).toEqual([
      { name: "Plan", value: "Enterprise" },
      { name: null, value: "$45" },
    ]);
  });

  // protects=a table written in a Unit's text names a cell only by a Markdown heading line its rule proves, so a row above the quoted one (a body row, a section's label, a caption or note) is never drawn as a column's name, in English and Chinese, with bars or tabs (#2847); fails_when=any cell takes a name the table's heading line doesn't give; no_claim=what the figure checks read of the same table.
  describe("written in a Unit's text, a cell is named only by a heading line a rule proves", () => {
    const RENTS = {
      en: [
        ["Term", "Studio", "One-bed"],
        ["Rent per month", "£950", "£1,250"],
        ["Bills included", "Yes", "No"],
        ["Deposit", "£1,100", "£1,400"],
      ],
      zh: [
        ["期限", "单间", "一居室"],
        ["每月租金", "950 英镑", "1,250 英镑"],
        ["含水电", "是", "否"],
        ["押金", "1,100 英镑", "1,400 英镑"],
      ],
    };
    const bare = (rows: string[][]) => rows.at(-1)?.map((value) => ({ name: null, value }));
    const named = (rows: string[][]) =>
      rows.at(-1)?.map((value, column) => ({ name: rows[0]?.[column] ?? null, value }));

    test.each(["en", "zh"] as const)(
      "rows apart by bars or tabs with no rule: no names, a body row above never one (%s)",
      (language) => {
        const rows = RENTS[language];
        const last = rows.at(-1) ?? [];
        for (const separator of [" | ", "\t"]) {
          const text = rows.map((cells) => cells.join(separator)).join("\n");
          expect(quoteCells(last.join(separator), [section(text)]), separator).toEqual(bare(rows));
        }
      },
    );

    test.each(["en", "zh"] as const)(
      "a Markdown table: its heading line names each cell, whatever rows lie between (%s)",
      (language) => {
        const rows = RENTS[language];
        const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
        const [head = [], ...body] = rows;
        const text = [line(head), "|---|---|---|", ...body.map(line)].join("\n");
        expect(quoteCells(line(rows.at(-1) ?? []), [section(text)])).toEqual(named(rows));
      },
    );

    test.each([
      [
        "en",
        "| Item | 2025 | 2026 |\n|---|---|---|\n| Operating expenses | | |\n| Rent | 120 | 135 |\n| Staff | 300 | 320 |",
        "| Rent | 120 | 135 |",
        ["Item", "2025", "2026"],
      ],
      [
        "zh",
        "| 项目 | 2025 | 2026 |\n|---|---|---|\n| 营业费用 | | |\n| 租金 | 120 | 135 |\n| 人工 | 300 | 320 |",
        "| 租金 | 120 | 135 |",
        ["项目", "2025", "2026"],
      ],
    ])("a section's label inside a Markdown table names nothing (%s)", (_, text, quote, names) => {
      expect(quoteCells(quote, [section(text)])?.map((cell) => cell.name)).toEqual(names);
    });

    test.each([
      [
        "en",
        "Table 3: Rents in March\nOperating expenses\t\t\nRent\t120\t135\nStaff\t300\t320",
        "Staff\t300\t320",
      ],
      ["zh", "表 3：三月租金\n营业费用\t\t\n租金\t120\t135\n人工\t300\t320", "人工\t300\t320"],
    ])(
      "a caption, a note or a section's label above rows apart by tabs names nothing (%s)",
      (_, text, quote) => {
        expect(quoteCells(quote, [section(text)])?.map((cell) => cell.name)).toEqual([
          null,
          null,
          null,
        ]);
      },
    );

    test("two Markdown tables that run on as one: each row named by its own table's heading line", () => {
      const text =
        "| Plan | Price |\n|---|---|\n| Team | $25 |\n| Region | Tax |\n|---|---|\n| EU | 20% |";
      expect(quoteCells("| EU | 20% |", [section(text)])).toEqual([
        { name: "Region", value: "EU" },
        { name: "Tax", value: "20%" },
      ]);
      expect(quoteCells("| Team | $25 |", [section(text)])).toEqual([
        { name: "Plan", value: "Team" },
        { name: "Price", value: "$25" },
      ]);
    });
  });

  // protects=a Word, PDF or deck Unit whose tables its index stored is read from them alone, so its own text, read again as a table, never makes the quote's place look like two tables that disagree (#2847); fails_when=such a quote gets no cells, or names its text alone would give; no_claim=tables the index didn't store.
  test("a Unit whose tables its index stored is read from them alone", () => {
    const word: UnitText = {
      page: 3,
      kind: "section",
      text: "Prices\tMonthly\tYearly\nPlan\tPer seat\tPer seat\nEnterprise\t$45\t$480",
      label: {
        tables: [
          {
            headings: ["Plan", "Prices Monthly", "Prices Yearly"],
            rows: [["Enterprise", "$45", "$480"]],
          },
        ],
      },
    };
    expect(quoteCells("Enterprise\t$45\t$480", [word])).toEqual([
      { name: "Plan", value: "Enterprise" },
      { name: "Prices Monthly", value: "$45" },
      { name: "Prices Yearly", value: "$480" },
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
