/**
 * Held-out evaluation set for #2372: workbook Questions that need a formula trace or a what-if.
 * The model is a small rental property's five-year cash flow with its mortgage. It was written
 * from the issue text and the workbook builder's API alone, apart from the lane being measured.
 *
 * Sheets: Assumptions (inputs, a management-fee table, four named cells), Loan (the mortgage
 * and its yearly balance) and Operations (income, costs, debt service, a DSCR covenant check,
 * the sale and the returns). Every saved result is worked out here from the inputs, in the
 * order its formula takes them, and a what-if's `result` is the same builder run again with
 * that one input changed.
 */
import { WorkbookBuilder } from "./financeWorkbooks";

export interface HeldOutQuestion {
  question: string;
  /** The cell that answers it, as "Sheet!B9". */
  cell: string;
  /** A what-if names one input and the value to try (0.03 for 3%); a trace has none. */
  change: { input: string; value: number; result: number } | null;
  /** Other cells that answer the same Question read another way. */
  also?: string[];
}

type Format = "general" | "percent" | "money" | "multiple";

const ASSUMPTIONS: readonly (readonly [string, string, number, Format])[] = [
  ["B3", "Purchase price", 1_100_000, "money"],
  ["B4", "Down payment %", 0.25, "percent"],
  ["B5", "Mortgage rate", 0.07, "percent"],
  ["B6", "Loan term (years)", 25, "general"],
  ["B7", "Number of units", 8, "general"],
  ["B8", "Monthly rent per unit", 1_500, "money"],
  ["B9", "Vacancy rate", 0.07, "percent"],
  ["B10", "Annual rent growth", 0.03, "percent"],
  ["B11", "Property tax % of price", 0.012, "percent"],
  ["B12", "Insurance per year", 6_800, "money"],
  ["B13", "Repairs % of rent collected", 0.06, "percent"],
  ["B14", "Annual cost inflation", 0.025, "percent"],
  ["B15", "Minimum DSCR (lender)", 1.35, "multiple"],
  ["B16", "Annual appreciation", 0.03, "percent"],
  ["B17", "Selling costs % of price", 0.06, "percent"],
  ["B18", "Closing costs % of price", 0.025, "percent"],
];

const FEE_TIERS: readonly (readonly [number, number])[] = [
  [1, 0.1],
  [4, 0.08],
  [10, 0.065],
];

const YEAR_COLUMNS = ["B", "C", "D", "E", "F"];

/** `changes` maps an Assumptions cell ("Assumptions!B9") to the value to try in its place. */
export function rentalPropertyWorkbook(
  changes: Readonly<Record<string, number>> = {},
): WorkbookBuilder {
  const known = new Set(ASSUMPTIONS.map(([ref]) => `Assumptions!${ref}`));
  for (const input of Object.keys(changes))
    if (!known.has(input)) throw new Error(`Not an input: ${input}`);

  const book = new WorkbookBuilder();
  const a = book.sheet("Assumptions");
  a.text("A1", "Assumption").text("B1", "Value").text("D1", "Units from").text("E1", "Fee");
  for (const [ref, label, value, format] of ASSUMPTIONS)
    a.text(`A${ref.slice(1)}`, label).number(ref, changes[`Assumptions!${ref}`] ?? value, format);
  FEE_TIERS.forEach(([units, fee], i) => {
    a.number(`D${3 + i}`, units).number(`E${3 + i}`, fee, "percent");
  });
  book
    .name("PurchasePrice", "Assumptions!$B$3")
    .name("MortgageRate", "Assumptions!$B$5")
    .name("Vacancy", "Assumptions!$B$9")
    .name("MinDSCR", "Assumptions!$B$15");

  const price = a.n("B3");
  const rate = a.n("B5");
  const loan = price * (1 - a.n("B4"));
  const payment = (loan * rate) / (1 - (1 + rate) ** -a.n("B6"));

  const l = book.sheet("Loan");
  l.text("A1", "Loan");
  l.text("A3", "Loan amount").formula("B3", "PurchasePrice*(1-Assumptions!B4)", loan, "money");
  l.text("A4", "Annual payment").formula(
    "B4",
    "PMT(MortgageRate,Assumptions!B6,-B3)",
    payment,
    "money",
  );
  l.text("A7", "Year");
  YEAR_COLUMNS.forEach((column, i) => {
    l.text(`${column}7`, `Year ${i + 1}`);
  });
  const opening: number[] = [];
  const interest: number[] = [];
  const principal: number[] = [];
  const closing: number[] = [];
  for (let i = 0; i < 5; i++) {
    opening.push(i === 0 ? loan : (closing[i - 1] as number));
    interest.push((opening[i] as number) * rate);
    principal.push(payment - (interest[i] as number));
    closing.push((opening[i] as number) - (principal[i] as number));
  }
  l.text("A8", "Opening balance").formula("B8", "B3", loan, "money");
  l.fill("C8:F8", "B11", (i) => closing[i] as number, "money");
  l.text("A9", "Interest").fill("B9:F9", "B8*MortgageRate", (i) => interest[i] as number, "money");
  l.text("A10", "Principal").fill("B10:F10", "$B$4-B9", (i) => principal[i] as number, "money");
  l.text("A11", "Closing balance").fill("B11:F11", "B8-B10", (i) => closing[i] as number, "money");

  const units = a.n("B7");
  const tier = [...FEE_TIERS].reverse().find(([from]) => units >= from);
  if (!tier) throw new Error("Fewer units than the first fee tier");
  const feeRate = tier[1];

  const o = book.sheet("Operations");
  o.text("A1", "Operating cash flow");
  o.text("A3", "Management fee rate").formula(
    "B3",
    "VLOOKUP(Assumptions!B7,Assumptions!D3:E5,2,TRUE)",
    feeRate,
    "percent",
  );
  o.text("A5", "Year");
  YEAR_COLUMNS.forEach((column, i) => {
    o.text(`${column}5`, `Year ${i + 1}`);
  });

  const growth = a.n("B10");
  const inflation = a.n("B14");
  const rent: number[] = [];
  const tax: number[] = [];
  const insurance: number[] = [];
  for (let i = 0; i < 5; i++) {
    rent.push(i === 0 ? units * a.n("B8") * 12 : (rent[i - 1] as number) * (1 + growth));
    tax.push(i === 0 ? price * a.n("B11") : (tax[i - 1] as number) * (1 + inflation));
    insurance.push(i === 0 ? a.n("B12") : (insurance[i - 1] as number) * (1 + inflation));
  }
  const vacancy = rent.map((each) => each * a.n("B9"));
  const collected = rent.map((each, i) => each - (vacancy[i] as number));
  const repairs = collected.map((each) => each * a.n("B13"));
  const management = collected.map((each) => each * feeRate);
  const expenses = rent.map(
    (_, i) =>
      (tax[i] as number) +
      (insurance[i] as number) +
      (repairs[i] as number) +
      (management[i] as number),
  );
  const noi = collected.map((each, i) => each - (expenses[i] as number));
  const cashFlow = noi.map((each) => each - payment);
  const dscr = noi.map((each) => each / payment);

  o.text("A6", "Gross potential rent").formula(
    "B6",
    "Assumptions!B7*Assumptions!B8*12",
    rent[0] as number,
    "money",
  );
  o.fill("C6:F6", "B6*(1+Assumptions!$B$10)", (i) => rent[i + 1] as number, "money");
  o.text("A7", "Vacancy loss").fill("B7:F7", "B6*Vacancy", (i) => vacancy[i] as number, "money");
  o.text("A8", "Rent collected").fill("B8:F8", "B6-B7", (i) => collected[i] as number, "money");
  o.text("A9", "Property tax").formula(
    "B9",
    "PurchasePrice*Assumptions!B11",
    tax[0] as number,
    "money",
  );
  o.fill("C9:F9", "B9*(1+Assumptions!$B$14)", (i) => tax[i + 1] as number, "money");
  o.text("A10", "Insurance").formula("B10", "Assumptions!B12", insurance[0] as number, "money");
  o.fill("C10:F10", "B10*(1+Assumptions!$B$14)", (i) => insurance[i + 1] as number, "money");
  o.text("A11", "Repairs").fill(
    "B11:F11",
    "B8*Assumptions!$B$13",
    (i) => repairs[i] as number,
    "money",
  );
  o.text("A12", "Management fee").fill(
    "B12:F12",
    "B8*$B$3",
    (i) => management[i] as number,
    "money",
  );
  o.text("A13", "Operating expenses").fill(
    "B13:F13",
    "SUM(B9:B12)",
    (i) => expenses[i] as number,
    "money",
  );
  o.text("A14", "Net operating income").fill("B14:F14", "B8-B13", (i) => noi[i] as number, "money");
  o.text("A15", "Debt service").fill("B15:F15", "Loan!$B$4", () => payment, "money");
  o.text("A16", "Cash flow after debt").fill(
    "B16:F16",
    "B14-B15",
    (i) => cashFlow[i] as number,
    "money",
  );
  o.text("A17", "DSCR").fill("B17:F17", "B14/B15", (i) => dscr[i] as number, "multiple");
  o.text("A18", "Covenant");
  YEAR_COLUMNS.forEach((column, i) => {
    o.formula(
      `${column}18`,
      `IF(${column}17>=MinDSCR,"OK","Breach")`,
      (dscr[i] as number) >= a.n("B15") ? "OK" : "Breach",
    );
  });

  const fiveYear = cashFlow.reduce((total, each) => total + each, 0);
  const salePrice = price * (1 + a.n("B16")) ** 5;
  const sellingCosts = salePrice * a.n("B17");
  const payoff = closing[4] as number;
  const netSale = salePrice - sellingCosts - payoff;
  const cashIn = price * (a.n("B4") + a.n("B18"));
  const cashBack = fiveYear + netSale;
  o.text("A20", "Five-year cash flow").formula("B20", "SUM(B16:F16)", fiveYear, "money");
  o.text("A21", "Sale price, end of Year 5").formula(
    "B21",
    "PurchasePrice*(1+Assumptions!B16)^5",
    salePrice,
    "money",
  );
  o.text("A22", "Selling costs").formula("B22", "B21*Assumptions!B17", sellingCosts, "money");
  o.text("A23", "Loan payoff").formula("B23", "Loan!F11", payoff, "money");
  o.text("A24", "Net sale proceeds").formula("B24", "B21-B22-B23", netSale, "money");
  o.text("A25", "Cash invested").formula(
    "B25",
    "PurchasePrice*(Assumptions!B4+Assumptions!B18)",
    cashIn,
    "money",
  );
  o.text("A26", "Total cash back").formula("B26", "B20+B24", cashBack, "money");
  o.text("A27", "Equity multiple").formula("B27", "B26/B25", cashBack / cashIn, "multiple");
  o.text("A28", "Lowest DSCR").formula("B28", "MIN(B17:F17)", Math.min(...dscr), "multiple");
  o.text("A29", "Year 1 cash-on-cash return").formula(
    "B29",
    "B16/B25",
    (cashFlow[0] as number) / cashIn,
    "percent",
  );
  return book;
}

/** A cell's saved value in a workbook, as a number. */
export function savedNumber(book: WorkbookBuilder, cell: string): number {
  const [sheet, ref] = cell.split("!") as [string, string];
  return book.get(sheet).n(ref);
}

/** The target cell after the builder is run again with one input changed. */
function whatIf(input: string, value: number, cell: string): HeldOutQuestion["change"] {
  return { input, value, result: savedNumber(rentalPropertyWorkbook({ [input]: value }), cell) };
}

export const RENTAL_HELD_OUT: readonly HeldOutQuestion[] = [
  {
    question: "Where does the Year 3 net operating income come from, line by line?",
    cell: "Operations!D14",
    change: null,
  },
  {
    question: "如果按揭利率涨到8%，每年要还银行多少？",
    cell: "Loan!B4",
    change: whatIf("Assumptions!B5", 0.08, "Loan!B4"),
    also: ["Operations!B15"],
  },
  {
    question: "Why does the covenant column flag Year 1?",
    cell: "Operations!B18",
    change: null,
    also: ["Operations!B17"],
  },
  {
    question: "If vacancy rises to 10%, how much cash flow is left after debt in Year 3?",
    cell: "Operations!D16",
    change: whatIf("Assumptions!B9", 0.1, "Operations!D16"),
  },
  {
    question: "第5年年底的贷款余额是怎么算出来的？",
    cell: "Loan!F11",
    change: null,
    also: ["Operations!B23"],
  },
  {
    question: "Suppose we got the seller down to 1,000,000. Where would the equity multiple land?",
    cell: "Operations!B27",
    change: whatIf("Assumptions!B3", 1_000_000, "Operations!B27"),
  },
  {
    question: "Which of the assumptions actually feed the cash I put in at closing?",
    cell: "Operations!B25",
    change: null,
  },
  {
    question: "假如首付提到四成，第一年的 DSCR 是多少？",
    cell: "Operations!B17",
    change: whatIf("Assumptions!B4", 0.4, "Operations!B17"),
  },
  {
    question: "管理费率是从哪儿取的？为什么是现在这个数？",
    cell: "Operations!B3",
    change: null,
  },
  {
    question:
      "What does the five-year cash flow add up to if rent growth is 5% a year rather than 3%?",
    cell: "Operations!B20",
    change: whatIf("Assumptions!B10", 0.05, "Operations!B20"),
  },
  {
    question: "How is the annual loan payment put together?",
    cell: "Loan!B4",
    change: null,
    also: ["Operations!B15"],
  },
  {
    question: "要是每户月租只能收到1400，第一年还完贷款后手里还剩多少现金？",
    cell: "Operations!B16",
    change: whatIf("Assumptions!B8", 1400, "Operations!B16"),
  },
  {
    question: "净售房所得主要受哪些假设影响？",
    cell: "Operations!B24",
    change: null,
  },
  {
    question: "Say it were a 12-unit building. How big is the Year 1 management fee then?",
    cell: "Operations!B12",
    change: whatIf("Assumptions!B7", 12, "Operations!B12"),
  },
  {
    question: "Can you break down what moves the Year 2 cash flow after debt service?",
    cell: "Operations!C16",
    change: null,
  },
  {
    question: "把贷款期限缩短到15年的话，最低的偿债覆盖率会变成多少？",
    cell: "Operations!B28",
    change: whatIf("Assumptions!B6", 15, "Operations!B28"),
  },
];
