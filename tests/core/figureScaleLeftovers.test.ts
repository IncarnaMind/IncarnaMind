/**
 * The scale cases #2365 still misses on `main`: a Chinese nearer line's bracket, a per-share
 * row under an exception, an exception clause's own scale, a caption for another table, a row
 * that isn't an amount, a heading that only looks like a scale, a bracket's dropped currency, a
 * sheet's name, a currency-only row head, and a price row. Each is read through the core as the
 * assistant uses it, with a scripted model; a figure is the scale its Document states, or the
 * calculation refuses, never the unscaled one.
 */
import { describe, expect, test } from "vitest";
import { docxOf, xlsxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";
import { pdf, pdfZh, record } from "../helpers/scaleCases";

const rows: readonly [string, string] = ["Revenue 1,234.5", "Costs 334.5"];
const rowsZh: readonly [string, string] = ["收入 1,200", "成本 300"];
/** Enough text that a page's scale line is a Passage of its own. */
const filler = (chinese: boolean) =>
  Array.from({ length: 40 }, (_, index) =>
    chinese
      ? `董事会第${index + 1}次审阅了集团的经营情况、现金状况以及来年的展望。`
      : `The directors reviewed item ${index + 1} of the group's trading, cash and outlook in detail.`,
  );

describe("The scale cases #2365 still misses (#2365)", { timeout: 120_000 }, () => {
  // protects=#2365; fails_when=a Chinese bracket naming a currency and a scale ("（人民币，百万）") is invisible to the nearer check, so a wider 千元 line scales figures at a hundredth of the stated 百万.
  test.each([
    { language: "Simplified", nearer: "董事酬金（人民币，百万）" },
    { language: "Traditional", nearer: "董事酬金（人民幣，百萬）" },
  ])("a nearer Chinese bracket states its currency and scale: $language", async ({ nearer }) => {
    const file = pdfZh("董事酬金账目", ["所有金额单位：千元", nearer, ...rowsZh]);
    const wider = await record({
      file,
      cites: rowsZh,
      numbers: ["1,200", "300"],
      unitQuote: "所有金额单位：千元",
      query: "董事酬金 收入 成本",
    });
    const bracket = await record({
      file,
      cites: rowsZh,
      numbers: ["1,200", "300"],
      unitQuote: nearer,
      query: "董事酬金 收入 成本",
    });

    expect([null, 900_000_000]).toContain(wider.value);
    expect(bracket.value).toBe(900_000_000);
    expect(bracket.scale).toBe(1_000_000);
  });

  // protects=#2365; fails_when=a per-share row a line excepts is scaled by the line, or loses the currency its own head states, so the result has no unit statement.
  test("a per-share row the line excepts keeps its own currency", async () => {
    const recorded = await record({
      file: pdf("EPS results", [
        "(in millions, except per share data)",
        "Basic EPS ($) 2.47",
        "Diluted EPS ($) 2.41",
      ]),
      cites: ["Basic EPS ($) 2.47", "Diluted EPS ($) 2.41"],
      numbers: ["2.47", "2.41"],
      query: "EPS results",
    });

    expect(recorded.value).toBeCloseTo(0.06, 9);
    expect(recorded.currency).toBe("USD");
    expect(recorded.statement).not.toBeNull();
  });

  // protects=#2365; fails_when=a scale inside a bracket's exception clause ("except share counts in thousands") is read as the line's scale and the currency is dropped.
  test.each([
    "(in $, except share counts in thousands)",
    "(in $, other than headcount in thousands)",
  ])("a scale in an exception clause states only what the clause excepts: %s", async (line) => {
    const recorded = await record({
      file: pdf("Exceptions", [line, ...rows]),
      cites: rows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: line,
      query: "exceptions revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a caption in the figure's own Unit that names another table ("Table 1 … (in thousands)") states a later table's scale.
  test.each([
    {
      language: "PDF",
      file: pdf("Two tables", [
        "Table 1 Group revenue (in thousands)",
        "Sales 500.5",
        "Fees 100.5",
        "Table 2 Company results",
        ...rows,
      ]),
      line: "Table 1 Group revenue (in thousands)",
    },
    {
      language: "text",
      file: {
        name: "Two tables.txt",
        contents:
          "Table 1 Group revenue (in thousands)\nSales 500.5\nFees 100.5\n\nTable 2 Company results\nRevenue 1,234.5\nCosts 334.5\n",
      },
      line: "Table 1 Group revenue (in thousands)",
    },
    {
      language: "this table",
      file: pdf("Table blocks", [
        "All amounts in this table are in £'000",
        "Sales 500.5",
        "Fees 100.5",
        "Other information",
        ...rows,
      ]),
      line: "All amounts in this table are in £'000",
    },
  ])(
    "a caption for another table never states the figure's scale: $language",
    async ({ file, line }) => {
      const recorded = await record({
        file,
        cites: rows,
        numbers: ["1,234.5", "334.5"],
        unitQuote: line,
        query: "company results revenue costs",
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a caption's money scale is applied to a row that isn't an amount: a return, a cover, a days ratio, gearing, or a price in pence.
  test.each([
    {
      row: "Return on equity 12.5",
      other: "Return on assets 4.5",
      line: "(in £'000)",
      ok: [null, 8],
    },
    {
      row: "Interest cover 4.5",
      other: "Dividend cover 2.5",
      line: "(in $ millions)",
      ok: [null, 2],
    },
    { row: "Inventory days 60.5", other: "Debtor days 45.5", line: "(in £'000)", ok: [null, 15] },
    {
      row: "Gearing 35.5",
      other: "Net debt to EBITDA 1.5",
      line: "(in thousands)",
      ok: [null, 34],
    },
    {
      row: "Closing share price (p) 245.5",
      other: "Opening share price (p) 45.5",
      line: "Five-year summary (in £m)",
      ok: [null, 200],
    },
  ])("a scale for amounts doesn't apply to $row", async ({ row, other, line, ok }) => {
    const recorded = await record({
      file: pdf("Ratios", [line, row, other]),
      cites: [row, other],
      numbers: [row.split(" ").at(-1) as string, other.split(" ").at(-1) as string],
      unitQuote: line,
      query: "ratios summary",
    });

    expect(ok).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a heading that only looks like a scale ("Thousand Oaks", "Millions of customers served", "千元店业绩") is read and scales a figure under it.
  test.each([
    {
      language: "Thousand Oaks",
      file: pdf("Oaks", ["Thousand Oaks", ...rows]),
      line: "Thousand Oaks",
    },
    {
      language: "Thousand Island",
      file: pdf("Island", ["Thousand Island", ...rows]),
      line: "Thousand Island",
    },
    {
      language: "Billion dollar brands",
      file: pdf("Brands", ["Billion dollar brands", ...rows]),
      line: "Billion dollar brands",
    },
    {
      language: "千元店业绩",
      file: pdfZh("千元店", ["千元店业绩", ...rowsZh]),
      line: "千元店业绩",
      chinese: true,
    },
    {
      language: "Millions of customers served",
      file: {
        name: "Customers.docx",
        contents: docxOf([
          { text: "Overview", heading: 1 },
          { text: "Millions of customers served", heading: 2 },
          ...rows.map((text) => ({ text })),
        ]),
      },
      line: "Millions of customers served",
    },
  ])(
    "a heading that only looks like a scale states none: $language",
    async ({ file, line, chinese }) => {
      const cited = chinese ? rowsZh : rows;
      const recorded = await record({
        file,
        cites: cited,
        numbers: chinese ? ["1,200", "300"] : ["1,234.5", "334.5"],
        unitQuote: line,
        query: `${line.split(" ")[0]} revenue costs`,
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a bracket's currency is dropped once its tail's scale is read ("(in dollars, in thousands)", "(in HK$, figures in millions)").
  test.each([
    { line: "(in dollars, in thousands)", value: 900_000, currency: "USD" },
    { line: "(in HK$, figures in millions)", value: 900_000_000, currency: "HKD" },
  ])(
    "a bracket's currency is kept with its tail's scale: %s",
    async ({ line, value, currency }) => {
      const recorded = await record({
        file: pdf("Currency tails", [line, ...rows]),
        cites: rows,
        numbers: ["1,234.5", "334.5"],
        unitQuote: line,
        query: "currency tails revenue costs",
      });

      expect(recorded.value).toBe(value);
      expect(recorded.currency).toBe(currency);
    },
  );

  // protects=#2365; fails_when=a sheet's name states a scale ("P&L £'000") and its figures are calculated unscaled with no statement.
  test("a scale in a sheet's name refuses a figure that can't quote it", async () => {
    const recorded = await record({
      file: {
        name: "Sheet scale.xlsx",
        contents: xlsxOf([
          {
            name: "P&L £'000",
            rows: [
              ["Revenue", 1234.5],
              ["Costs", 334.5],
            ],
          },
        ]),
      },
      cites: ["Revenue\t1234.5", "Costs\t334.5"],
      numbers: ["1234.5", "334.5"],
      query: "revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("P&L £'000");
  });

  // protects=#2365; fails_when=quoting a row head that states only a currency ("(US$)" under "(in thousands)") records the amount unscaled.
  test("a currency-only row head quoted under a scale refuses or combines the scale", async () => {
    const dollarRows: readonly [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const recorded = await record({
      file: pdf("Dollar head", ["(in thousands)", ...dollarRows]),
      cites: dollarRows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(US$)",
      query: "dollar head revenue costs",
    });

    expect(recorded.value).toBe(900_000);
    expect(recorded.statement).toBe("(in thousands)");
  });

  // protects=#2365; fails_when=a row head that states only a currency ("(US$)", "(£)") takes the scale of a line that names a currency the reader can't place ("in millions of Japanese yen", "in thousands of Egyptian pounds"), so an amount in one currency is scaled by another's line, whether the row heads or the line are quoted.
  test.each([
    {
      line: "(in millions of Japanese yen)",
      heads: ["(US$)", "(USD)"],
      quote: "heads",
      value: null,
    },
    {
      line: "(in thousands of Brazilian reais)",
      heads: ["(US$)", "(USD)"],
      quote: "heads",
      value: null,
    },
    {
      line: "(in thousands of Egyptian pounds)",
      heads: ["(£)", "(£)"],
      quote: "heads",
      value: null,
    },
    {
      line: "(IN THOUSANDS OF CONTRACTS WON)",
      heads: ["(US$)", "(USD)"],
      quote: "heads",
      value: null,
    },
    { line: "(in millions)", heads: ["(US$)", "(USD)"], quote: "heads", value: 900_000_000 },
    {
      line: "(in millions of Japanese yen)",
      heads: ["(US$)", "(US$)"],
      quote: "line",
      value: null,
    },
    { line: "(in millions)", heads: ["(US$)", "(US$)"], quote: "line", value: 900_000_000 },
  ] as const)(
    "a currency-only row head takes only a line's scale that names no currency: $line, $quote quoted",
    async ({ line, heads, quote, value }) => {
      const headRows = [`Revenue ${heads[0]} 1,234.5`, `Costs ${heads[1]} 334.5`] as const;
      const recorded = await record({
        file: pdf("Currency heads", [line, ...headRows]),
        cites: headRows,
        numbers: ["1,234.5", "334.5"],
        ...(quote === "heads" ? { unitQuotes: heads } : { unitQuote: line }),
        query: "currency heads revenue costs",
      });

      expect(recorded.value).toBe(value);
    },
  );

  // protects=#2365; fails_when=a row head that states only a currency borrows a scale from another table, or one below it, instead of refusing or reading the row's own currency.
  test.each([
    {
      language: "another table's scale",
      file: pdf("Two tables", [
        "Table 1 Headcount (in thousands)",
        "Employees 1,200",
        "Table 2 Revenue",
        "Revenue (US$) 1,234.5",
        "Costs (US$) 334.5",
      ]),
    },
    {
      language: "a scale below the rows",
      file: pdf("Later table", [
        "Table 2 Revenue",
        "Revenue (US$) 1,234.5",
        "Costs (US$) 334.5",
        "Table 1 Headcount (in thousands)",
        "Employees 1,200",
      ]),
    },
  ])("a currency-only row head doesn't borrow $language", async ({ file }) => {
    const dollarRows: readonly [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const recorded = await record({
      file,
      cites: dollarRows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(US$)",
      query: "two tables revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a fragment of another table's caption ("(in thousands)" from "Table 1 …") is quoted and states a later table's scale, because only the fragment is judged.
  test("a fragment of another table's caption doesn't state a scale", async () => {
    const recorded = await record({
      file: pdf("Fragment table", [
        "Table 1 Headcount (in thousands)",
        "Employees 1,200",
        "Table 2 Revenue",
        ...rows,
      ]),
      cites: rows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(in thousands)",
      query: "fragment table revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a bracket that only looks like a scale ("（千元店业绩）", "（万元户调查）") states one and scales the rows under it.
  test.each(["经营概况（千元店业绩）", "经营概况（万元户调查）"])(
    "a bracketed shop or household name states no scale: %s",
    async (line) => {
      const recorded = await record({
        file: pdfZh("经营概况", [line, ...rowsZh]),
        cites: rowsZh,
        numbers: ["1,200", "300"],
        unitQuote: line,
        query: "经营概况 收入 成本",
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a longer Chinese bracket that names its currency ("（以港币千元列示）", "（以港幣仟元列示）") is read as yuan.
  test.each(["董事酬金（以港币千元列示）", "董事酬金（以港幣仟元列示）"])(
    "a longer Chinese bracket keeps its named currency: %s",
    async (line) => {
      const recorded = await record({
        file: pdfZh("董事酬金账目", [line, ...rowsZh]),
        cites: rowsZh,
        numbers: ["1,200", "300"],
        unitQuote: line,
        query: "董事酬金 收入 成本",
      });

      expect(recorded.value).toBe(900_000);
      expect(recorded.currency).toBe("HKD");
    },
  );

  // protects=#2365; fails_when=a quote of the number alone drops the currency its own line writes, so a unitQuote in another currency ("(in £m)" over "$1,234.5", "金额单位：万英镑" over "收入（元）") scales it instead of refusing.
  test.each([
    {
      language: "English",
      file: pdf("Currency", ["(in £m)", "Revenue $1,234.5", "Costs $334.5"]),
      cites: ["1,234.5", "334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuote: "(in £m)",
      query: "currency rows revenue costs",
    },
    {
      language: "Chinese",
      file: pdfZh("币种", ["金额单位：万英镑", "收入（元） 1,200", "成本（元） 300"]),
      cites: ["1,200", "300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuote: "金额单位：万英镑",
      query: "币种 收入 成本",
    },
  ])("a bare-number quote keeps the currency its line states: $language", async (each) => {
    const recorded = await record({
      file: each.file,
      cites: each.cites,
      numbers: each.numbers,
      unitQuote: each.unitQuote,
      query: each.query,
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=the exception-clause guard is removed and a bracket that states only an exception ("(except share counts in thousands)") scales the rows.
  test("an exception-only bracket states no scale", async () => {
    const line = "(except share counts in thousands)";
    const recorded = await record({
      file: pdf("Exception only", [line, ...rows]),
      cites: rows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: line,
      query: "exception only revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("states no unit or scale");
  });

  // protects=#2365; fails_when=the row's own currency is dropped when the exception line itself is the unitQuote.
  test("a per-share row keeps its own currency when the exception line is quoted", async () => {
    const head = "(in millions, except per share data)";
    const recorded = await record({
      file: pdf("EPS results", [head, "Basic EPS ($) 2.47", "Diluted EPS ($) 2.41"]),
      cites: ["Basic EPS ($) 2.47", "Diluted EPS ($) 2.41"],
      numbers: ["2.47", "2.41"],
      unitQuote: head,
      query: "EPS results",
    });

    expect(recorded.value).toBeCloseTo(0.06, 9);
    expect(recorded.currency).toBe("USD");
  });

  // protects=#2365; fails_when=a per-share row the quoted line excepts takes the line's currency ("(in US$ millions, except per share data)") over the one its own head or figure writes ("Basic EPS (HK$)"), so HK$1.00 is recorded as $1.00; or a row that writes none loses the line's.
  test.each([
    {
      language: "English, the whole row",
      lines: ["Basic EPS (HK$) 2.47", "Diluted EPS (HK$) 1.47"],
      cites: ["Basic EPS (HK$) 2.47", "Diluted EPS (HK$) 1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "English, the number alone",
      lines: ["Basic EPS (HK$) 2.47", "Diluted EPS (HK$) 1.47"],
      cites: ["2.47", "1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "English, the number alone on a line that writes its sign",
      lines: ["Basic EPS HK$2.47", "Diluted EPS HK$1.47"],
      cites: ["2.47", "1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "English, a row that writes no currency",
      lines: ["Basic EPS 2.47", "Diluted EPS 1.47"],
      cites: ["Basic EPS 2.47", "Diluted EPS 1.47"] as [string, string],
      currency: "USD",
    },
    {
      language: "Chinese, the whole row",
      lines: ["基本每股收益（港元） 2.47", "稀释每股收益（港元） 1.47"],
      cites: ["基本每股收益（港元） 2.47", "稀释每股收益（港元） 1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "Chinese, the number alone",
      lines: ["基本每股收益（港元） 2.47", "稀释每股收益（港元） 1.47"],
      cites: ["2.47", "1.47"] as [string, string],
      currency: "HKD",
    },
    {
      language: "Chinese, a row that writes no currency",
      lines: ["基本每股收益 2.47", "稀释每股收益 1.47"],
      cites: ["基本每股收益 2.47", "稀释每股收益 1.47"] as [string, string],
      currency: "USD",
    },
  ])(
    "an excepted per-share row keeps its own currency over the line's: $language",
    async (each) => {
      const chinese = each.language.startsWith("Chinese");
      const head = chinese
        ? "（除每股数据外，单位：百万美元）"
        : "(in US$ millions, except per share data)";
      const recorded = await record({
        file: chinese
          ? pdfZh("每股收益", [head, ...each.lines])
          : pdf("EPS currency", [head, ...each.lines]),
        cites: each.cites,
        numbers: ["2.47", "1.47"],
        unitQuote: head,
        query: chinese ? "每股收益" : "EPS currency",
      });

      expect(recorded.value).toBeCloseTo(1, 9);
      expect(recorded.currency).toBe(each.currency);
    },
  );

  // protects=#2365; fails_when=a per-share row whose head writes a minor unit ("(US cents)", "(pence)", "(p)", "（港仙）", "（美分）") takes the exception line's whole currency, so 10 cents is recorded as $10.00; or a row in whole units loses its own currency.
  test.each([
    {
      language: "English, US cents",
      head: "(in US$ millions, except per share data)",
      lines: ["Basic EPS (US cents) 24.7", "Diluted EPS (US cents) 14.7"],
      cites: ["Basic EPS (US cents) 24.7", "Diluted EPS (US cents) 14.7"] as [string, string],
      currency: null,
    },
    {
      language: "English, US cents, the number alone",
      head: "(in US$ millions, except per share data)",
      lines: ["Basic EPS (US cents) 24.7", "Diluted EPS (US cents) 14.7"],
      cites: ["24.7", "14.7"] as [string, string],
      currency: null,
    },
    {
      language: "English, pence",
      head: "(in £ millions, except per share data)",
      lines: ["Basic EPS (pence) 24.7", "Diluted EPS (pence) 14.7"],
      cites: ["Basic EPS (pence) 24.7", "Diluted EPS (pence) 14.7"] as [string, string],
      currency: null,
    },
    {
      language: "English, p",
      head: "(in £ millions, except per share data)",
      lines: ["Basic EPS (p) 24.7", "Diluted EPS (p) 14.7"],
      cites: ["Basic EPS (p) 24.7", "Diluted EPS (p) 14.7"] as [string, string],
      currency: null,
    },
    {
      language: "English, whole pounds",
      head: "(in £ millions, except per share data)",
      lines: ["Basic EPS (£) 24.7", "Diluted EPS (£) 14.7"],
      cites: ["Basic EPS (£) 24.7", "Diluted EPS (£) 14.7"] as [string, string],
      currency: "GBP",
    },
    {
      language: "Chinese, 港仙",
      head: "（除每股数据外，单位：百万港元）",
      lines: ["基本每股收益（港仙） 24.7", "稀释每股收益（港仙） 14.7"],
      cites: ["基本每股收益（港仙） 24.7", "稀释每股收益（港仙） 14.7"] as [string, string],
      currency: null,
    },
    {
      language: "Chinese, 港仙, the number alone",
      head: "（除每股数据外，单位：百万港元）",
      lines: ["基本每股收益（港仙） 24.7", "稀释每股收益（港仙） 14.7"],
      cites: ["24.7", "14.7"] as [string, string],
      currency: null,
    },
    {
      language: "Chinese, 美分",
      head: "（除每股数据外，单位：百万美元）",
      lines: ["基本每股收益（美分） 24.7", "稀释每股收益（美分） 14.7"],
      cites: ["基本每股收益（美分） 24.7", "稀释每股收益（美分） 14.7"] as [string, string],
      currency: null,
    },
    {
      language: "Chinese, whole 港元",
      head: "（除每股数据外，单位：百万港元）",
      lines: ["基本每股收益（港元） 24.7", "稀释每股收益（港元） 14.7"],
      cites: ["基本每股收益（港元） 24.7", "稀释每股收益（港元） 14.7"] as [string, string],
      currency: "HKD",
    },
  ])(
    "an excepted per-share row in a minor unit never takes the line's whole currency: $language",
    async (each) => {
      const chinese = each.language.startsWith("Chinese");
      const recorded = await record({
        file: chinese
          ? pdfZh("每股盈利", [each.head, ...each.lines])
          : pdf("EPS minor units", [each.head, ...each.lines]),
        cites: each.cites,
        numbers: ["24.7", "14.7"],
        unitQuote: each.head,
        query: chinese ? "每股盈利" : "EPS minor units",
      });

      expect(recorded.value).toBeCloseTo(10, 9);
      expect(recorded.currency).toBe(each.currency);
    },
  );

  // protects=#2365; fails_when=a row whose head or unit column writes a minor unit ("(US cents)", "（港仙）", a "US cents" cell) takes a line's millions or thousands, so 10 cents becomes 10,000,000.
  test.each([
    {
      language: "English, a plain scale",
      file: pdf("Dividends", [
        "(in millions)",
        "Interim dividend (US cents) 24.7",
        "Final dividend (US cents) 14.7",
      ]),
      cites: ["Interim dividend (US cents) 24.7", "Final dividend (US cents) 14.7"] as [
        string,
        string,
      ],
      unitQuote: "(in millions)",
      query: "dividends",
    },
    {
      language: "English, a currency's scale",
      file: pdf("Dividends", [
        "(in £ millions)",
        "Interim dividend (pence) 24.7",
        "Final dividend (pence) 14.7",
      ]),
      cites: ["Interim dividend (pence) 24.7", "Final dividend (pence) 14.7"] as [string, string],
      unitQuote: "(in £ millions)",
      query: "dividends",
    },
    {
      language: "Chinese, a currency's scale",
      file: pdfZh("股息", ["（单位：百万港元）", "中期股息（港仙） 24.7", "末期股息（港仙） 14.7"]),
      cites: ["中期股息（港仙） 24.7", "末期股息（港仙） 14.7"] as [string, string],
      unitQuote: "（单位：百万港元）",
      query: "股息",
    },
    {
      language: "English, a workbook's unit column",
      file: {
        name: "EPS sheet.xlsx",
        contents: xlsxOf([
          {
            name: "Results",
            rows: [
              ["(in US$ millions, except per share data)"],
              ["Basic EPS", "US cents", 24.7],
              ["Diluted EPS", "US cents", 14.7],
            ],
          },
        ]),
      },
      cites: ["Basic EPS\tUS cents\t24.7", "Diluted EPS\tUS cents\t14.7"] as [string, string],
      unitQuote: "(in US$ millions, except per share data)",
      query: "EPS sheet",
    },
    {
      language: "Chinese, a workbook's unit column",
      file: {
        name: "每股收益表.xlsx",
        contents: xlsxOf([
          {
            name: "业绩",
            rows: [
              ["（除每股数据外，单位：百万港元）"],
              ["基本每股收益", "港仙", 24.7],
              ["稀释每股收益", "港仙", 14.7],
            ],
          },
        ]),
      },
      cites: ["基本每股收益\t港仙\t24.7", "稀释每股收益\t港仙\t14.7"] as [string, string],
      unitQuote: "（除每股数据外，单位：百万港元）",
      query: "每股收益",
    },
  ])("a row in a minor unit is never scaled by a line: $language", async (each) => {
    const recorded = await record({ ...each, numbers: ["24.7", "14.7"] });

    expect(recorded.value).toBeCloseTo(10, 9);
    expect(recorded.currency).toBeNull();
  });

  // protects=#2365; fails_when=a "(P)" or "P" that isn't pence (a company's "(P) Ltd", a head outside a table in pounds) makes the row a minor unit's, so its scale line is dropped and the figure is 1,000 or 100,000 times too small.
  test.each([
    {
      language: "English, a company's (P) Ltd under lakhs",
      query: "loans",
      file: pdf("Loans", [
        "(INR in lakhs)",
        "Loan to Sun (P) Ltd 1,234.5",
        "Loan to Moon (P) Ltd 334.5",
      ]),
      cites: ["Loan to Sun (P) Ltd 1,234.5", "Loan to Moon (P) Ltd 334.5"] as [string, string],
      unitQuote: "(INR in lakhs)",
      value: 90_000_000,
    },
    {
      language: "English, a company's (P) Limited under thousands",
      query: "balances",
      file: pdf("Balances", [
        "(Rs. in thousands)",
        "Receivable from Star (P) Limited 1,234.5",
        "Payable to Star (P) Limited 334.5",
      ]),
      cites: ["Receivable from Star (P) Limited 1,234.5", "Payable to Star (P) Limited 334.5"] as [
        string,
        string,
      ],
      unitQuote: "(Rs. in thousands)",
      value: 900_000,
    },
    {
      language: "English, a (P) head in no table of pounds",
      query: "heads revenue costs",
      file: pdf("Heads", ["(in thousands)", "Revenue (P) 1,234.5", "Costs (P) 334.5"]),
      cites: ["Revenue (P) 1,234.5", "Costs (P) 334.5"] as [string, string],
      unitQuote: "(in thousands)",
      value: 900_000,
    },
    {
      language: "English, a company's (P) Ltd in a table of pounds",
      query: "loans",
      file: pdf("Loans", ["(£'000)", "Loan to Sun (P) Ltd 1,234.5", "Loan to Moon (P) Ltd 334.5"]),
      cites: ["Loan to Sun (P) Ltd 1,234.5", "Loan to Moon (P) Ltd 334.5"] as [string, string],
      unitQuote: "(£'000)",
      value: 900_000,
    },
    {
      language: "English, a workbook's P unit column in no table of pounds",
      query: "revenue costs",
      file: {
        name: "Heads.xlsx",
        contents: xlsxOf([
          {
            name: "Results",
            rows: [["(in thousands)"], ["Revenue", "P", 1234.5], ["Costs", "P", 334.5]],
          },
        ]),
      },
      cites: ["Revenue\tP\t1234.5", "Costs\tP\t334.5"] as [string, string],
      numbers: ["1234.5", "334.5"] as [string, string],
      unitQuote: "(in thousands)",
      value: 900_000,
    },
    {
      language: "Chinese, a company's （P） name",
      query: "往来 应收 应付",
      file: pdfZh("往来", [
        "单位：千元",
        "应收太阳（P）有限公司 1,234.5",
        "应付月亮（P）有限公司 334.5",
      ]),
      cites: ["应收太阳（P）有限公司 1,234.5", "应付月亮（P）有限公司 334.5"] as [string, string],
      unitQuote: "单位：千元",
      value: 900_000,
    },
  ])("a (P) that isn't pence keeps its scale line: $language", async (each) => {
    const recorded = await record({
      file: each.file,
      cites: each.cites,
      numbers: each.numbers ?? ["1,234.5", "334.5"],
      unitQuote: each.unitQuote,
      query: each.query,
    });

    expect(recorded.value).toBe(each.value);
  });

  // protects=#2365; fails_when=a page that states its scale lets a "(P) Ltd" row be recorded unscaled with no unitQuote, where the model must be asked to quote that line.
  test("a (P) Ltd row with no unitQuote is asked for its page's scale line", async () => {
    const recorded = await record({
      file: pdf("Loans", [
        "(INR in lakhs)",
        "Loan to Sun (P) Ltd 1,234.5",
        "Loan to Moon (P) Ltd 334.5",
      ]),
      cites: ["Loan to Sun (P) Ltd 1,234.5", "Loan to Moon (P) Ltd 334.5"],
      numbers: ["1,234.5", "334.5"],
      query: "loans",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("INR in lakhs");
  });

  // protects=#2365; fails_when=a per-share row in pence ("Dividend per share (p)", a "p" unit column) in a table in pounds takes the table's £'000, so 10p becomes £10,000.
  test.each([
    {
      language: "a (p) head",
      file: pdf("Dividends", [
        "(£'000)",
        "Interim dividend per share (p) 24.7",
        "Final dividend per share (p) 14.7",
      ]),
      cites: ["Interim dividend per share (p) 24.7", "Final dividend per share (p) 14.7"] as [
        string,
        string,
      ],
    },
    {
      language: "a workbook's p unit column",
      file: {
        name: "Dividends.xlsx",
        contents: xlsxOf([
          {
            name: "Dividends",
            rows: [
              ["(£'000)"],
              ["Interim dividend per share", "p", 24.7],
              ["Final dividend per share", "p", 14.7],
            ],
          },
        ]),
      },
      cites: ["Interim dividend per share\tp\t24.7", "Final dividend per share\tp\t14.7"] as [
        string,
        string,
      ],
    },
  ])("a row in pence in a table of pounds is read in pence: $language", async (each) => {
    const recorded = await record({
      file: each.file,
      cites: each.cites,
      numbers: ["24.7", "14.7"],
      unitQuote: "(£'000)",
      query: "dividends",
    });

    expect(recorded.value).toBeCloseTo(10, 9);
    expect(recorded.currency).toBeNull();
  });

  // protects=#2365; fails_when=the conflicting-scales refusal is removed and a currency-only row takes one of two scales of amounts ("Revenue in US$ millions; costs in US$ thousands").
  test("a currency-only row with two scale statements refuses", async () => {
    const dollarRows: readonly [string, string] = ["Revenue (US$) 1,234.5", "Costs (US$) 334.5"];
    const recorded = await record({
      file: pdf("Two scales", ["Revenue in US$ millions; costs in US$ thousands", ...dollarRows]),
      cites: dollarRows,
      numbers: ["1,234.5", "334.5"],
      unitQuote: "(US$)",
      query: "two scales revenue costs",
    });

    expect(recorded.value).toBeNull();
  });

  // protects=#2365; fails_when=a currency-only row takes a scale across a bare table caption ("表2"), from a measure ("million tonnes"), or from a retained Word header, instead of refusing or using only its own scale.
  test.each([
    {
      language: "a bare table caption",
      file: pdfZh("分部", [
        "表1 分部业绩（单位：千元）",
        "分部收入 1,200",
        "表2",
        "收入（元） 1,200",
        "成本（元） 300",
      ]),
      cites: ["收入（元） 1,200", "成本（元） 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuotes: ["收入（元）", "成本（元）"] as [string, string],
      query: "分部 收入 成本",
      ok: [null, 900],
    },
    {
      language: "a measure",
      file: pdf("Measures", ["Unit: million tonnes", "Revenue (US$) 1,234.5", "Costs (USD) 334.5"]),
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuotes: ["(US$)", "(USD)"] as [string, string],
      query: "measures revenue costs",
      ok: [null, 900],
    },
    {
      language: "a retained Word header",
      file: {
        name: "Header scale.docx",
        contents: docxOf([{ text: "Revenue (US$) 1,234.5" }, { text: "Costs (USD) 334.5" }], {
          header: "All amounts in thousands",
        }),
      },
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuotes: ["(US$)", "(USD)"] as [string, string],
      query: "header scale revenue costs",
      ok: [null, 900_000],
    },
  ])("a currency-only row doesn't take $language", async (each) => {
    const recorded = await record({
      file: each.file,
      cites: each.cites,
      numbers: each.numbers,
      unitQuotes: each.unitQuotes,
      query: each.query,
    });

    expect(each.ok).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a quoted line that states a measure ("Unit: million tonnes", "单位：万吨") scales or names the unit of an amount its row head or own line writes in a currency, so $1,234.5 becomes $1,234.5 million or 1,234.5 million tonnes.
  test.each([
    {
      language: "English, the whole row",
      lines: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"],
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
    },
    {
      language: "English, the number alone",
      lines: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"],
      cites: ["1,234.5", "334.5"] as [string, string],
    },
    {
      language: "English, the number alone on a line that writes its sign",
      lines: ["Revenue $1,234.5", "Costs $334.5"],
      cites: ["1,234.5", "334.5"] as [string, string],
    },
    {
      language: "Chinese, the whole row",
      lines: ["收入（元） 1,200", "成本（元） 300"],
      cites: ["收入（元） 1,200", "成本（元） 300"] as [string, string],
    },
    {
      language: "Chinese, the number alone",
      lines: ["收入（元） 1,200", "成本（元） 300"],
      cites: ["1,200", "300"] as [string, string],
    },
  ])("a quoted measure's line never scales an amount: $language", async (each) => {
    const chinese = each.language.startsWith("Chinese");
    const measure = chinese ? "单位：万吨" : "Unit: million tonnes";
    const recorded = await record({
      file: chinese
        ? pdfZh("计量", [measure, ...each.lines])
        : pdf("Measures", [measure, ...each.lines]),
      cites: each.cites,
      numbers: chinese ? ["1,200", "300"] : ["1,234.5", "334.5"],
      unitQuote: measure,
      query: chinese ? "计量 收入 成本" : "measures revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("states a unit of measure");
  });

  // protects=#2365; fails_when=the reader reads a line that names a measure or a rate ("(in thousands of tonnes)", "In millions of barrels", "(thousand barrels per day)", "单位：万平方米", "单位：万桶/日") as a plain scale, so it scales an amount whose row head states a currency, whether that line or the row head is quoted.
  test.each(
    [
      { language: "English", line: "(in thousands of tonnes)" },
      { language: "English", line: "(in millions of shares)" },
      { language: "English", line: "In millions of barrels" },
      { language: "English", line: "(thousand barrels per day)" },
      { language: "English", line: "Unit: million barrels/day" },
      { language: "Chinese", line: "单位：万平方米" },
      { language: "Chinese", line: "单位：万桶/日" },
      { language: "Chinese", line: "单位：千立方米/年" },
    ].flatMap((each) => [
      { ...each, quoted: "the line" },
      { ...each, quoted: "the row heads" },
    ]),
  )("a line that names a measure never scales an amount: $line, quoting $quoted", async (each) => {
    const chinese = each.language === "Chinese";
    const lines = chinese
      ? (["收入（元） 1,200", "成本（元） 300"] as const)
      : (["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as const);
    const heads = chinese ? (["收入（元）", "成本（元）"] as const) : (["(US$)", "(USD)"] as const);
    const recorded = await record({
      file: chinese ? pdfZh("计量", [each.line, ...lines]) : pdf("Measures", [each.line, ...lines]),
      cites: lines,
      numbers: (chinese ? ["1,200", "300"] : ["1,234.5", "334.5"]) as [string, string],
      ...(each.quoted === "the line" ? { unitQuote: each.line } : { unitQuotes: heads }),
      query: chinese ? "计量 收入 成本" : "measures revenue costs",
    });

    expect([null, 900]).toContain(recorded.value);
  });

  // protects=#2365; fails_when=a quote of the number alone from a line that writes its currency ("Revenue $1,234.5") takes a measure's scale from "In millions of barrels".
  test("a measure's line never scales a number whose own line writes its currency", async () => {
    const recorded = await record({
      file: pdf("Barrels", ["In millions of barrels", "Revenue $1,234.5", "Costs $334.5"]),
      cites: ["1,234.5", "334.5"],
      numbers: ["1,234.5", "334.5"],
      unitQuote: "In millions of barrels",
      query: "barrels revenue costs",
    });

    expect(recorded.value).toBeNull();
    expect(recorded.asked).toContain("states a unit of measure");
  });

  // protects=#2365; fails_when=a line that names a measure or a rate no longer states its scale and unit for the measure's own rows, or a line that names a currency after "of" stops stating that currency.
  test.each([
    {
      line: "(in thousands of tonnes)",
      rows: ["Output 1,234.5", "Shipments 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      value: 900_000,
      unit: { kind: "other", word: "tonnes" },
    },
    {
      line: "(thousand barrels per day)",
      rows: ["Production 1,234.5", "Sales 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      value: 900_000,
      unit: { kind: "other", word: "barrels per day" },
    },
    {
      line: "(in thousands of US dollars)",
      rows: ["Revenue 1,234.5", "Costs 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      value: 900_000,
      unit: { kind: "currency", code: "USD" },
    },
    {
      line: "单位：万平方米",
      rows: ["建筑面积 1,200", "出租面积 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      value: 9_000_000,
      unit: { kind: "other", word: "平方米" },
    },
    {
      line: "单位：万桶/日",
      rows: ["产量 1,200", "销量 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      value: 9_000_000,
      unit: { kind: "other", word: "桶/日" },
    },
  ])("a line that names a measure scales its own rows: $line", async (each) => {
    const chinese = /\p{Script=Han}/u.test(each.line);
    const recorded = await record({
      file: chinese
        ? pdfZh("计量", [each.line, ...each.rows])
        : pdf("Measures", [each.line, ...each.rows]),
      cites: each.rows,
      numbers: each.numbers,
      unitQuote: each.line,
      query: chinese ? "计量 产量" : "measures rows",
    });

    expect(recorded.value).toBe(each.value);
    expect(recorded.unit).toEqual(each.unit);
    expect(recorded.statement).toBe(each.line);
  });

  // protects=#2365; fails_when=a line that doesn't positively state amounts' scale (a measure or a rate in any spelling, a word the reader doesn't read, a CJK line's joined text) scales an amount whose row head states a currency, whether the row heads or the line are quoted.
  test.each(
    [
      { language: "English", line: "(in thousands of tonnes CO2e)" },
      { language: "English", line: "In thousands of tonnes (kt)" },
      { language: "English", line: "(in thousands of tonnes – unaudited)" },
      {
        language: "English",
        line: "In thousands of metric tonnes of crude steel shipped to customers",
      },
      { language: "English", line: "(tonnes, in thousands)" },
      { language: "English", line: "(in millions, tonnes)" },
      { language: "English", line: "(in US$ thousands per tonne)" },
      { language: "English", line: "Volumes in millions; amounts in thousands" },
      { language: "English", line: "Volumes in million tonnes; amounts in US$ thousands" },
      { language: "Chinese", line: "单位：万头" },
      { language: "Chinese", line: "单位：万亩" },
      { language: "Chinese", line: "单位：万吉瓦时" },
      { language: "Chinese", line: "单位万平方米" },
    ].flatMap((each) => [
      { ...each, quoted: "the row heads" },
      { ...each, quoted: "the line" },
    ]),
  )(
    "only a line that states amounts' scale scales an amount: $line, quoting $quoted",
    async (each) => {
      const chinese = each.language === "Chinese";
      const lines = chinese
        ? (["营业收入（元） 1,200", "营业成本（元） 300"] as const)
        : (["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as const);
      const heads = chinese
        ? (["营业收入（元）", "营业成本（元）"] as const)
        : (["(US$)", "(USD)"] as const);
      const recorded = await record({
        file: chinese
          ? pdfZh("经营", [each.line, ...lines])
          : pdf("Volumes", [each.line, ...lines]),
        cites: lines,
        numbers: (chinese ? ["1,200", "300"] : ["1,234.5", "334.5"]) as [string, string],
        ...(each.quoted === "the line" ? { unitQuote: each.line } : { unitQuotes: heads }),
        query: chinese ? "经营 营业收入 营业成本" : "volumes revenue costs",
      });

      expect([null, 900]).toContain(recorded.value);
    },
  );

  // protects=#2365; fails_when=a line that positively states amounts' scale ("All amounts in thousands", "Dollars in thousands, except per share amounts", "（单位：千）") stops scaling a row whose head states its currency.
  test.each([
    {
      line: "All amounts in thousands",
      rows: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      heads: ["(US$)", "(USD)"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      query: "amounts revenue costs",
    },
    {
      line: "Dollars in thousands, except per share amounts",
      rows: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      heads: ["(US$)", "(USD)"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      query: "dollars revenue costs",
    },
    {
      line: "（单位：千）",
      rows: ["营业收入（元） 1,200", "营业成本（元） 300"] as [string, string],
      heads: ["营业收入（元）", "营业成本（元）"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      query: "经营 营业收入 营业成本",
    },
  ])("a line that states amounts' scale still scales them: $line", async (each) => {
    const chinese = /\p{Script=Han}/u.test(each.line);
    const recorded = await record({
      file: chinese
        ? pdfZh("经营", [each.line, ...each.rows])
        : pdf("Amounts", [each.line, ...each.rows]),
      cites: each.rows,
      numbers: each.numbers,
      unitQuotes: each.heads,
      query: each.query,
    });

    expect(recorded.value).toBe(900_000);
    expect(recorded.statement).toBe(each.line);
  });

  // protects=#2365; fails_when=the measure guard refuses a measure's own rows, which the line's scale states.
  test.each([
    {
      language: "English",
      file: pdf("Measures", ["Unit: million tonnes", "Output 1,234.5", "Shipments 334.5"]),
      cites: ["Output 1,234.5", "Shipments 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuote: "Unit: million tonnes",
      query: "measures output shipments",
      value: 900_000_000,
    },
    {
      language: "Chinese",
      file: pdfZh("计量", ["单位：万吨", "产量 1,200", "销量 300"]),
      cites: ["产量 1,200", "销量 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuote: "单位：万吨",
      query: "计量 产量 销量",
      value: 9_000_000,
    },
  ])("a measure's line still scales its own rows: $language", async (each) => {
    const recorded = await record(each);

    expect(recorded.value).toBe(each.value);
    expect(recorded.currency).toBeNull();
    expect(recorded.statement).toBe(each.unitQuote);
  });

  // protects=#2365; fails_when=a currency-only row head reads its rows plain though an earlier page states a scale for the whole Document ("All amounts in thousands"), so $900 thousand is recorded as $900.
  test.each([
    {
      language: "English",
      pages: [
        ["Group notes", "All amounts in thousands", ...filler(false)],
        filler(false),
        ["Group accounts", "Revenue (US$) 1,234.5", "Costs (USD) 334.5"],
      ],
      cites: ["Revenue (US$) 1,234.5", "Costs (USD) 334.5"] as [string, string],
      numbers: ["1,234.5", "334.5"] as [string, string],
      unitQuotes: ["(US$)", "(USD)"] as [string, string],
      scale: "All amounts in thousands",
      query: "group accounts revenue costs",
    },
    {
      language: "Chinese",
      pages: [
        ["集团附注", "所有金额单位：千元", ...filler(true)],
        filler(true),
        ["集团账目", "收入（元） 1,200", "成本（元） 300"],
      ],
      cites: ["收入（元） 1,200", "成本（元） 300"] as [string, string],
      numbers: ["1,200", "300"] as [string, string],
      unitQuotes: ["收入（元）", "成本（元）"] as [string, string],
      scale: "所有金额单位：千元",
      query: "集团账目 收入 成本",
    },
  ])(
    "a currency-only row head doesn't read plain under an earlier page's scale: $language",
    async (each) => {
      const chinese = each.language === "Chinese";
      const recorded = await record({
        file: {
          name: chinese ? "跨页.pdf" : "Cross page.pdf",
          contents: buildPdf(
            each.pages.map((lines) => (chinese ? { chineseLines: lines } : { lines })),
          ),
        },
        cites: each.cites,
        numbers: each.numbers,
        unitQuotes: each.unitQuotes,
        query: each.query,
      });

      expect(recorded.value).toBeNull();
      expect(recorded.asked).toContain(each.scale);
    },
  );

  // protects=#2365; fails_when=prose that names a shop's results or a household survey ("以千元店业绩为基准", "以万元户调查为基础") is read as a unit declaration.
  test.each(["经营概况（以千元店业绩为基准）", "经营概况（以万元户调查为基础）"])(
    "prose with a shop or household clause states no scale: %s",
    async (line) => {
      const recorded = await record({
        file: pdfZh("经营概况", [line, ...rowsZh]),
        cites: rowsZh,
        numbers: ["1,200", "300"],
        unitQuote: line,
        query: "经营概况 收入 成本",
      });

      expect(recorded.value).toBeNull();
    },
  );

  // protects=#2365; fails_when=a price row takes the page's money scale, so "(in thousands)" turns 12.5 − 3.5 into $9.0 thousand.
  test("a price row under a page's scale is refused or read plain", async () => {
    const priceRows: readonly [string, string] = [
      "Average price (US$) 12.5",
      "Unit cost (US$) 3.5",
    ];
    const recorded = await record({
      file: pdf("Average prices", ["(in thousands)", ...priceRows]),
      cites: priceRows,
      numbers: ["12.5", "3.5"],
      unitQuote: "(in thousands)",
      query: "average prices",
    });

    expect([null, 9]).toContain(recorded.value);
  });
});
