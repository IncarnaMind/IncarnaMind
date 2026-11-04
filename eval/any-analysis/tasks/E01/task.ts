import { columnName, type FormulaCell, type SheetCell, xlsx } from "../../inputs";
import type { Task } from "../../task";

const NAME = "Five-year plan model.xlsx";
const YEARS = 5;

const INPUTS = [
  ["Units sold, year 1", 12_000],
  ["Unit growth per year", 0.08],
  ["Price per unit, year 1", 185],
  ["Price growth per year", 0.03],
  ["Material cost per unit", 48],
  ["Headcount, year 1", 14],
  ["Salary per head", 61_000],
  ["Headcount added per year", 2],
  ["Marketing, share of revenue", 0.06],
  ["Rent per year", 180_000],
  ["Capital expenditure, year 1", 900_000],
  ["Useful life, years", 6],
  ["Tax rate", 0.25],
  ["Working capital, share of revenue", 0.12],
  ["Discount rate", 0.1],
] as const;

/**
 * The numbers typed into formulas that belong on Inputs, each in one cell only, where a modeller
 * overrode the row's pattern: a year-4 price uplift, a salary, a marketing share, a year-5 tax
 * rate, a one-off payment and a haircut on the headline NPV.
 */
const PLANTED: Readonly<Record<string, number>> = {
  "Revenue!E3": 1.05,
  "Staff!D3": 58_000,
  "Opex!C2": 0.045,
  "Tax!F2": 0.28,
  "CashFlow!D6": 250_000,
  "Summary!B4": 0.9,
};

const planted = (address: string): number | undefined => PLANTED[address];

/** A workbook built cell by cell: each formula with the value Excel saves for it. */
class Book {
  readonly values = new Map<string, number>();
  readonly sheets = new Map<string, SheetCell[][]>();

  set(sheet: string, row: number, column: number, cell: SheetCell): void {
    const rows = this.sheets.get(sheet) ?? [];
    this.sheets.set(sheet, rows);
    while (rows.length < row) rows.push([]);
    const cells = rows[row - 1] ?? [];
    rows[row - 1] = cells;
    while (cells.length < column) cells.push(null);
    cells[column - 1] = cell;
    const value = typeof cell === "number" ? cell : typeof cell === "object" ? cell?.value : null;
    if (typeof value === "number")
      this.values.set(`${sheet}!${columnName(column - 1)}${row}`, value);
  }

  value(address: string): number {
    const value = this.values.get(address);
    if (value === undefined) throw new Error(`E01's model reads ${address} before it is set.`);
    return value;
  }

  /** A row of five years in columns B to F, under its label in A. */
  years(
    sheet: string,
    row: number,
    label: string,
    make: (column: string, year: number) => FormulaCell | number,
  ): void {
    this.set(sheet, row, 1, label);
    for (let year = 0; year < YEARS; year++) {
      this.set(sheet, row, year + 2, make(columnName(year + 1), year));
    }
  }
}

const SHEETS = [
  "Inputs",
  "Volume",
  "Revenue",
  "COGS",
  "Staff",
  "Opex",
  "Depreciation",
  "PnL",
  "Tax",
  "WorkingCapital",
  "CashFlow",
  "Summary",
] as const;

const previous = (column: string) => String.fromCharCode(column.charCodeAt(0) - 1);

function model(): Book {
  const book = new Book();
  const v = (address: string) => book.value(address);
  book.set("Inputs", 1, 1, "Assumption");
  book.set("Inputs", 1, 2, "Value");
  for (const [index, [label, value]] of INPUTS.entries()) {
    book.set("Inputs", index + 2, 1, label);
    book.set("Inputs", index + 2, 2, value);
  }
  const input = (row: number) => v(`Inputs!B${row}`);
  const headings = ["Line", ...Array.from({ length: YEARS }, (_, year) => `Year ${year + 1}`)];
  for (const sheet of SHEETS.slice(1, -1)) {
    for (const [index, heading] of headings.entries()) book.set(sheet, 1, index + 1, heading);
  }

  book.years("Volume", 2, "Units sold", (c, year) =>
    year === 0
      ? { formula: "Inputs!$B$2", value: input(2) }
      : {
          formula: `${previous(c)}2*(1+Inputs!$B$3)`,
          value: v(`Volume!${previous(c)}2`) * (1 + input(3)),
        },
  );
  book.years("Revenue", 2, "Price per unit", (c, year) =>
    year === 0
      ? { formula: "Inputs!$B$4", value: input(4) }
      : {
          formula: `${previous(c)}2*(1+Inputs!$B$5)`,
          value: v(`Revenue!${previous(c)}2`) * (1 + input(5)),
        },
  );
  book.years("Revenue", 3, "Revenue", (c) => {
    const uplift = planted(`Revenue!${c}3`);
    const value = v(`Volume!${c}2`) * v(`Revenue!${c}2`);
    return uplift === undefined
      ? { formula: `Volume!${c}2*${c}2`, value }
      : { formula: `Volume!${c}2*${c}2*${uplift}`, value: value * uplift };
  });
  book.years("COGS", 2, "Material cost", (c) => ({
    formula: `Volume!${c}2*Inputs!$B$6`,
    value: v(`Volume!${c}2`) * input(6),
  }));
  book.years("Staff", 2, "Headcount", (c, year) =>
    year === 0
      ? { formula: "Inputs!$B$7", value: input(7) }
      : { formula: `${previous(c)}2+Inputs!$B$9`, value: v(`Staff!${previous(c)}2`) + input(9) },
  );
  book.years("Staff", 3, "Staff cost", (c) => {
    const salary = planted(`Staff!${c}3`);
    return salary === undefined
      ? { formula: `${c}2*Inputs!$B$8`, value: v(`Staff!${c}2`) * input(8) }
      : { formula: `${c}2*${salary}`, value: v(`Staff!${c}2`) * salary };
  });
  book.years("Opex", 2, "Marketing", (c) => {
    const share = planted(`Opex!${c}2`);
    return share === undefined
      ? { formula: `Revenue!${c}3*Inputs!$B$10`, value: v(`Revenue!${c}3`) * input(10) }
      : { formula: `Revenue!${c}3*${share}`, value: v(`Revenue!${c}3`) * share };
  });
  book.years("Opex", 3, "Rent", () => ({ formula: "Inputs!$B$11", value: input(11) }));
  book.years("Opex", 4, "Total operating expenses", (c) => ({
    formula: `${c}2+${c}3`,
    value: v(`Opex!${c}2`) + v(`Opex!${c}3`),
  }));
  book.years("Depreciation", 2, "Depreciation", () => ({
    formula: "Inputs!$B$12/Inputs!$B$13",
    value: input(12) / input(13),
  }));
  const link = (row: number, label: string, from: (c: string) => string) =>
    book.years("PnL", row, label, (c) => ({ formula: from(c), value: v(from(c)) }));
  const difference = (row: number, label: string, minus: readonly number[], from: number) =>
    book.years("PnL", row, label, (c) => ({
      formula: `${c}${from}-${minus.map((each) => `${c}${each}`).join("-")}`,
      value: minus.reduce((left, each) => left - v(`PnL!${c}${each}`), v(`PnL!${c}${from}`)),
    }));
  link(2, "Revenue", (c) => `Revenue!${c}3`);
  link(3, "Cost of goods sold", (c) => `COGS!${c}2`);
  difference(4, "Gross profit", [3], 2);
  link(5, "Staff cost", (c) => `Staff!${c}3`);
  link(6, "Operating expenses", (c) => `Opex!${c}4`);
  difference(7, "EBITDA", [5, 6], 4);
  link(8, "Depreciation", (c) => `Depreciation!${c}2`);
  difference(9, "EBIT", [8], 7);
  book.years("Tax", 2, "Tax", (c) => {
    const rate = planted(`Tax!${c}2`) ?? input(14);
    const rateText = planted(`Tax!${c}2`) === undefined ? "Inputs!$B$14" : String(rate);
    return { formula: `MAX(0,PnL!${c}9*${rateText})`, value: Math.max(0, v(`PnL!${c}9`) * rate) };
  });
  link(10, "Tax", (c) => `Tax!${c}2`);
  difference(11, "Net income", [10], 9);
  book.years("WorkingCapital", 2, "Working capital", (c) => ({
    formula: `PnL!${c}2*Inputs!$B$15`,
    value: v(`PnL!${c}2`) * input(15),
  }));
  book.years("WorkingCapital", 3, "Increase in working capital", (c, year) =>
    year === 0
      ? { formula: `${c}2`, value: v(`WorkingCapital!${c}2`) }
      : {
          formula: `${c}2-${previous(c)}2`,
          value: v(`WorkingCapital!${c}2`) - v(`WorkingCapital!${previous(c)}2`),
        },
  );
  book.years("CashFlow", 2, "Net income", (c) => ({
    formula: `PnL!${c}11`,
    value: v(`PnL!${c}11`),
  }));
  book.years("CashFlow", 3, "Depreciation", (c) => ({
    formula: `PnL!${c}8`,
    value: v(`PnL!${c}8`),
  }));
  book.years("CashFlow", 4, "Increase in working capital", (c) => ({
    formula: `-WorkingCapital!${c}3`,
    value: -v(`WorkingCapital!${c}3`),
  }));
  book.years("CashFlow", 5, "Capital expenditure", (_, year) =>
    year === 0 ? { formula: "-Inputs!$B$12", value: -input(12) } : 0,
  );
  book.years("CashFlow", 6, "Free cash flow", (c) => {
    const payment = planted(`CashFlow!${c}6`);
    const sum = [2, 3, 4, 5].reduce((total, row) => total + v(`CashFlow!${c}${row}`), 0);
    return payment === undefined
      ? { formula: `SUM(${c}2:${c}5)`, value: sum }
      : { formula: `SUM(${c}2:${c}5)-${payment}`, value: sum - payment };
  });
  book.years("CashFlow", 7, "Cumulative free cash flow", (c, year) =>
    year === 0
      ? { formula: `${c}6`, value: v(`CashFlow!${c}6`) }
      : {
          formula: `${previous(c)}7+${c}6`,
          value: v(`CashFlow!${previous(c)}7`) + v(`CashFlow!${c}6`),
        },
  );
  const flows = Array.from({ length: YEARS }, (_, year) => v(`CashFlow!${columnName(year + 1)}6`));
  const npv = flows.reduce((sum, flow, year) => sum + flow / (1 + input(16)) ** (year + 1), 0);
  const haircut = planted("Summary!B4") ?? 1;
  const outputs: [string, FormulaCell][] = [
    ["Year 5 net income", { formula: "PnL!F11", value: v("PnL!F11") }],
    ["Cumulative free cash flow", { formula: "CashFlow!F7", value: v("CashFlow!F7") }],
    [
      "NPV of free cash flow (headline)",
      { formula: `NPV(Inputs!$B$16,CashFlow!B6:F6)*${haircut}`, value: npv * haircut },
    ],
  ];
  book.set("Summary", 1, 1, "Output");
  book.set("Summary", 1, 2, "Value");
  for (const [index, [label, cell]] of outputs.entries()) {
    book.set("Summary", index + 2, 1, label);
    book.set("Summary", index + 2, 2, cell);
  }
  return book;
}

function inputs() {
  const book = model();
  const sheets = SHEETS.map((name) => ({ name, rows: book.sheets.get(name) ?? [] }));
  const cells = sheets.flatMap(({ name, rows }) =>
    rows.flatMap((cells, row) =>
      cells.flatMap((cell, column) =>
        cell !== null && typeof cell === "object"
          ? [
              {
                sheet: name,
                cell: `${columnName(column)}${row + 1}`,
                formula: cell.formula,
                value: cell.value,
              },
            ]
          : [],
      ),
    ),
  );
  return {
    files: [{ name: NAME, bytes: xlsx(sheets) }],
    data: { "formulas.json": JSON.stringify(cells) },
  };
}

export const task: Task = {
  id: "E01",
  title: "Map a workbook's formulas",
  needs: ["F", "N"],
  seed: 201,
  question: {
    en: `${NAME} is a five-year plan over 12 sheets, from Inputs to Summary. Map it: which cells are the inputs, how the calculation flows from sheet to sheet, and which cells on Summary are the outputs. Then find every number typed directly into a formula, other than 0 and 1, that should be an input instead. Give each as Sheet!Cell without $ signs (for example Revenue!C3), with its formula and the number typed in. How many are there, and what is the headline NPV on the Summary sheet?`,
  },
  inputs,
  expect: [
    {
      id: "constants",
      kind: "rows",
      label: "Each number typed into a formula, by its cell",
      key: new RegExp(`\\b(?:${Object.keys(PLANTED).join("|")})\\b`, "gi"),
      columns: [{ id: "constant", unit: "plain", tolerance: { abs: 0 } }],
    },
    {
      id: "constant_count",
      kind: "number",
      label: "How many numbers are typed into formulas",
      unit: "plain",
      tolerance: { abs: 0 },
      near: /hard-?coded|constant|typed|literal|硬编码|常数|常量/i,
    },
    {
      id: "headline_npv",
      kind: "number",
      label: "The headline NPV on Summary",
      unit: "plain",
      tolerance: { abs: 1 },
      near: /NPV|net present|净现值/i,
    },
  ],
  sources: { documents: [NAME] },
};
