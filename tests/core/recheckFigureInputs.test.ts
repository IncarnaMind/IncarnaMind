import { describe, expect, test } from "vitest";
import { createCalculationSession } from "../../src/core/answers/calculations";
import { type AnswerDocuments, createCitationSession } from "../../src/core/answers/citations";
import type { FigureInput } from "../../src/core/api";

type Unit = ReturnType<AnswerDocuments["pageTexts"]>[number];

function source(units: Unit[], language: "en" | "zh-CN" = "en", passageText?: string) {
  let pages = units;
  let hash = "v1";
  let deleted = false;
  let missing = false;
  const documents: AnswerDocuments = {
    searchableCount: () => 1,
    async search() {
      throw new Error("Rechecking a retained input must not search or ask a model.");
    },
    citationSource: (id) =>
      id === "passage" && !missing
        ? {
            passageId: id,
            documentId: "accounts",
            documentName: "Accounts",
            contentHash: hash,
            documentKind: pages[0]?.kind === "rows" ? "xlsx" : "pdf",
            documentDeleted: deleted,
            notCited: false,
            text: passageText ?? pages.map((unit) => unit.text).join("\n"),
            pageFrom: 1,
            pageTo: 1,
          }
        : null,
    pageTexts: () => pages,
    documentDate: () => null,
  };
  const citations = createCitationSession(documents, { onRecord: () => undefined });
  const passage = documents.citationSource("passage");
  if (!passage) throw new Error("Missing fixture Passage.");
  citations.show([{ ...passage, seq: 0, position: 0, windowFrom: 0, windowTo: 0 }]);
  const calculations = createCalculationSession({
    documents,
    quotes: citations.quotes,
    language,
  });
  return {
    recheck: calculations.recheck,
    read(quote: string, options: Record<string, unknown> = {}): FigureInput {
      const result = calculations.number({
        name: "amount",
        label: "Amount",
        passage: "passage",
        location: "p. 1",
        quote,
        position: 1,
        ...options,
      });
      if ("problem" in result) throw new Error(result.problem);
      return result.input;
    },
    replace(next: Unit[], nextHash = hash) {
      pages = next;
      hash = nextHash;
    },
    deleteDocument() {
      deleted = true;
    },
    removePassage() {
      missing = true;
    },
  };
}

const page = (text: string): Unit[] => [{ kind: "page", page: 1, text }];

test("recheck reads the saved UTF-16 span rather than its one-based number ordinal", () => {
  const quote = "Revenue was 20 and costs were 5.";
  const session = source(page(quote));
  const input = session.read(quote, { position: 2 });
  expect(input.number).toMatchObject({ chars: "5", at: quote.indexOf("5"), value: 5 });
  expect(input.number.at).toBeGreaterThan(2);
  expect(session.recheck(input)).toEqual({ input });
  expect(session.recheck({ ...input, number: { ...input.number, at: 2 } })).toHaveProperty(
    "problem",
  );
});

test("recheck preserves the second equal number's own span", () => {
  const quote = "Revenue 20 and costs 20.";
  const session = source(page(quote));
  const input = session.read(quote, { position: 2 });
  expect(input.number.at).toBe(quote.lastIndexOf("20"));
  const result = session.recheck(input);
  expect(result).toEqual({ input });
  expect("input" in result && result.input.number.at).not.toBe(quote.indexOf("20"));
});

test("a surrogate prefix keeps UTF-16 offsets instead of Unicode character counts", () => {
  const quote = "📊 Revenue 20 and costs 5.";
  const session = source(page(quote));
  const input = session.read(quote);
  const codePoints = [...quote.slice(0, input.number.at)].length;
  expect(input.number.at).toBe(quote.indexOf("20"));
  expect(codePoints).toBe(input.number.at - 1);
  expect(session.recheck(input)).toEqual({ input });
  expect(session.recheck({ ...input, number: { ...input.number, at: codePoints } })).toHaveProperty(
    "problem",
  );
});

test("recheck refuses a saved numeric value the quote does not produce", () => {
  const quote = "Revenue was £20.";
  const session = source(page(quote));
  const input = session.read(quote);
  expect(session.recheck({ ...input, number: { ...input.number, value: 21 } })).toHaveProperty(
    "problem",
  );
});

test("an identical quote from a changed source hash does not refresh the retained input", () => {
  const quote = "Revenue was £20.";
  const session = source(page(quote));
  const input = session.read(quote);
  session.replace(page(quote), "v2");
  expect(session.recheck(input)).toHaveProperty("problem");
  expect(input.citation.contentHash).toBe("v1");
});

test.each(["deleted", "missing"])("a %s source cannot recheck a retained input", (kind) => {
  const quote = "Revenue was £20.";
  const session = source(page(quote));
  const input = session.read(quote);
  if (kind === "deleted") session.deleteDocument();
  else session.removePassage();
  expect(session.recheck(input)).toHaveProperty("problem");
});

test("an unavailable or nonnumeric saved quote never becomes a checked input", () => {
  const quote = "Revenue was £20.";
  const session = source(page(`${quote}\nRevenue is unavailable.`));
  const input = session.read(quote);
  for (const changed of ["", "Revenue is unavailable.", "Revenue was £21."])
    expect(
      session.recheck({ ...input, citation: { ...input.citation, quote: changed } }),
    ).toHaveProperty("problem");
});

test("recheck retains the chosen reading of a range", () => {
  const quote = "Growth of 2–3% is expected.";
  const session = source(page(quote));
  const input = session.read(quote, { reading: 2 });
  expect(input.number).toMatchObject({ value: 0.03, reading: 2, unit: { kind: "percent" } });
  expect(session.recheck(input)).toEqual({ input });
});

function workbook(header: string, stored = 1.2345): Unit[] {
  return [
    {
      kind: "rows",
      page: 1,
      text: `${header}\nRevenue\t1.2`,
      label: { sheet: "Accounts", from: 1, to: 2, rows: [1, 2], column: 0, values: { B2: stored } },
    },
  ];
}

test.each([
  { language: "en" as const, header: "Revenue ($bn)", scale: 1_000_000_000, currency: "USD" },
  {
    language: "zh-CN" as const,
    header: "单位：万元　币种：人民币",
    scale: 10_000,
    currency: "CNY",
  },
])("stable stored cells and their stated units recheck in $language", (fixture) => {
  const session = source(workbook(fixture.header), fixture.language);
  const input = session.read("Revenue\t1.2", {
    location: "Accounts, row 2",
    unitQuote: fixture.header,
  });
  expect(input.cell).toEqual({ sheet: "Accounts", ref: "B2", stored: 1.2345 });
  expect(input.number.value).toBe(1.2345 * fixture.scale);
  expect(input.unitStatement).toMatchObject({
    scale: fixture.scale,
    currency: fixture.currency,
    citation: { quote: fixture.header, check: "found" },
  });
  expect(session.recheck(input)).toEqual({ input });
});

test("changed raw cell values are refused even when the displayed quote is unchanged", () => {
  const header = "Revenue ($bn)";
  const session = source(workbook(header));
  const input = session.read("Revenue\t1.2", {
    location: "Accounts, row 2",
    unitQuote: header,
  });
  session.replace(workbook(header, 1.2399));
  expect(session.recheck(input)).toHaveProperty("problem");
  expect(input.cell?.stored).toBe(1.2345);
});

test("a changed or missing unit statement cannot preserve its old reading", () => {
  const header = "Revenue ($bn)";
  const session = source(workbook(header));
  const input = session.read("Revenue\t1.2", {
    location: "Accounts, row 2",
    unitQuote: header,
  });
  for (const changed of ["Revenue ($m)", "Revenue"]) {
    session.replace(workbook(changed));
    expect(session.recheck(input)).toHaveProperty("problem");
  }
});

test("a currency written on another line's amount states a bare number's unit, and rechecks", () => {
  const text = "Sale price £385,000.00\nLess: agent's fee (4,620.00)";
  const session = source(page(text));
  const input = session.read("(4,620.00)", { unitQuote: "Sale price £385,000.00" });
  expect(input.number).toMatchObject({ value: -4620, unit: { kind: "currency", code: "GBP" } });
  expect(input.unitStatement).toMatchObject({
    citation: { quote: "Sale price £385,000.00", check: "found" },
    scale: 1,
    currency: "GBP",
    currencyChars: "£",
  });
  expect(session.recheck(input)).toEqual({ input });
});

test("a stored currency the Document writes otherwise isn't its unit statement any more", () => {
  const text = "Sale price £385,000.00\nLess: agent's fee (4,620.00)";
  const session = source(page(text));
  const input = session.read("(4,620.00)", { unitQuote: "Sale price £385,000.00" });
  const unit = input.unitStatement;
  if (!unit) throw new Error("Missing unit statement.");
  expect(
    session.recheck({ ...input, unitStatement: { ...unit, currencyChars: "$" } }),
  ).toHaveProperty("problem");
});

test("a Passage that names two currencies gives a bare number neither", () => {
  const text = "Sale price £385,000.00\nDeposit $12,000.00\nLess: agent's fee (4,620.00)";
  const session = source(page(text));
  expect(() => session.read("(4,620.00)", { unitQuote: "Sale price £385,000.00" })).toThrow(
    /gives GBP, but p\. 1 names more than one currency \(GBP, USD\)/,
  );
});

test("a unitQuote that isn't in the Passage, or writes no currency, is refused", () => {
  const text = "Sale price £385,000.00\nLess: agent's fee (4,620.00)";
  const session = source(page(text));
  expect(() => session.read("(4,620.00)", { unitQuote: "Sale price £999,999.00" })).toThrow(
    /isn't word for word in P1/,
  );
  expect(() => session.read("(4,620.00)", { unitQuote: "Less: agent's fee (4,620.00)" })).toThrow(
    /states no unit or scale/,
  );
});

describe("a currency a statement writes on its first amount", () => {
  test.each([
    {
      name: "a scale line above (English)",
      text: "Completion statement: 14 Mill Lane\nAll figures in thousands\nSale price £380.4\nLess: agent's fee (4.0)",
      quote: "(4.0)",
      unitQuote: "Sale price £380.4",
    },
    {
      name: "a scale the reader doesn't apply (English)",
      text: "Completion statement: 14 Mill Lane\n£000\nSale price £380.4\nLess: agent's fee (4.0)",
      quote: "(4.0)",
      unitQuote: "Sale price £380.4",
    },
    {
      name: "a scale line between the lines (English)",
      text: "Sale price £380.4\nAll figures in thousands\nLess: agent's fee (4.0)",
      quote: "(4.0)",
      unitQuote: "Sale price £380.4",
    },
    {
      name: "单位：万元 above (Chinese)",
      text: "房产交易结算表\n单位：万元\n成交价 ¥380.38\n减：中介费 （4.00）",
      quote: "（4.00）",
      unitQuote: "成交价 ¥380.38",
    },
    {
      name: "金额单位：千元 above (Chinese)",
      text: "房产交易结算表\n金额单位：千元\n成交价 ¥380.38\n减：中介费 （4.00）",
      quote: "（4.00）",
      unitQuote: "成交价 ¥380.38",
    },
    {
      name: "a scale line between the lines (Chinese)",
      text: "成交价 ¥380.38\n单位：万元\n减：中介费 （4.00）",
      quote: "（4.00）",
      unitQuote: "成交价 ¥380.38",
    },
  ])("refuses $name, which it doesn't apply", ({ text, quote, unitQuote }) => {
    const session = source(page(text));
    expect(() => session.read(quote, { unitQuote })).toThrow(/scale is stated/);
  });

  test.each([
    {
      name: "above the line (English)",
      text: "Shares 1,000,000\nSale price £385,000.00\nLess: agent's fee (4,620.00)",
      quote: "1,000,000",
      unitQuote: "Sale price £385,000.00",
    },
    {
      name: "above the line (Chinese)",
      text: "股数 1,000,000\n成交价 ¥3,850,000.00\n减：中介费 （46,200.00）",
      quote: "1,000,000",
      unitQuote: "成交价 ¥3,850,000.00",
    },
  ])("refuses a number $name", ({ text, quote, unitQuote }) => {
    const session = source(page(text));
    expect(() => session.read(quote, { unitQuote })).toThrow(/not above/);
  });

  test.each([
    {
      name: "another column (English)",
      text: "Item\tPrice\tQty\nWidget\t£380.40\t1\nGadget\t£380.40\t12",
      quote: "12",
      unitQuote: "Widget\t£380.40\t1",
    },
    {
      name: "another column (Chinese)",
      text: "项目\t价格\t数量\n甲\t¥380.40\t1\n乙\t¥380.40\t12",
      quote: "12",
      unitQuote: "甲\t¥380.40\t1",
    },
  ])("refuses a table's statement from $name", ({ text, quote, unitQuote }) => {
    const session = source(page(text));
    expect(() => session.read(quote, { unitQuote })).toThrow(/column/);
  });

  test.each([
    {
      name: "English",
      text: "Item\tAmount\nWidget\t£385,000.00\nFee\t(4,620.00)",
      quote: "(4,620.00)",
      unitQuote: "Widget\t£385,000.00",
      value: -4620,
      code: "GBP",
    },
    {
      name: "Chinese",
      text: "项目\t金额\n甲\t¥385,000.00\n乙\t（4,620.00）",
      quote: "（4,620.00）",
      unitQuote: "甲\t¥385,000.00",
      value: -4620,
      code: "CNY",
    },
  ])(
    "reads a bare row of the statement's own column: $name",
    ({ text, quote, unitQuote, value, code }) => {
      const session = source(page(text));
      expect(session.read(quote, { unitQuote })).toMatchObject({
        number: { value, unit: { kind: "currency", code } },
      });
    },
  );

  test("a scale the statement line doesn't apply is refused too", () => {
    const text = "Sale price £380.4 thousand\nLess: agent's fee (4.0)";
    const session = source(page(text));
    expect(() => session.read("(4.0)", { unitQuote: "Sale price £380.4 thousand" })).toThrow(
      /scale is stated/,
    );
  });

  test.each([
    "All figures in thousands",
    "Thousands",
    "'000",
    "000s",
    "(000 omitted)",
    "€ Mio.",
    "Tsd. €",
    "Unit: tonnes",
    "in millions",
  ])("refuses a statement when the Document writes %s anywhere", (marker) => {
    const document = [
      "Completion statement: 14 Mill Lane",
      marker,
      "Sale price £6.1",
      "Less: agent's fee (6.1)",
    ].join("\n");
    const session = source(page(document), "en", "Sale price £6.1\nLess: agent's fee (6.1)");
    expect(() => session.read("(6.1)", { unitQuote: "Sale price £6.1" })).toThrow(
      /scale is stated/,
    );
  });

  test.each(["单位：万元", "金额（万）", "单位：吨"])(
    "refuses a statement when the Chinese Document writes %s anywhere",
    (marker) => {
      const document = ["房产交易结算表", marker, "成交价 ¥6.12", "减：中介费 （6.12）"].join("\n");
      const session = source(page(document), "zh-CN", "成交价 ¥6.12\n减：中介费 （6.12）");
      expect(() => session.read("（6.12）", { unitQuote: "成交价 ¥6.12" })).toThrow(
        /scale is stated/,
      );
    },
  );

  test("a scale outside the cited Passage still refuses the statement", () => {
    const document = [
      "Completion statement: 14 Mill Lane",
      "All figures in thousands",
      "Sale price £6.1",
      "Less: agent's fee (6.1)",
    ].join("\n");
    const session = source(page(document), "en", "Sale price £6.1\nLess: agent's fee (6.1)");
    expect(() => session.read("(6.1)", { unitQuote: "Sale price £6.1" })).toThrow(
      /gives GBP, but a scale is stated \("thousands"\)/,
    );
  });

  test("a Chinese Document that names 日元 leaves its ¥ amounts unsettled", () => {
    const text = "日本子公司（以日元列示）\n收入 ¥120,000,000";
    const session = source(page(text), "zh-CN");
    expect(() => session.read("收入 ¥120,000,000")).toThrow(/could be CNY or JPY/);
  });

  test("a Chinese statement naming its scale's own line still applies that scale", () => {
    const text = "房产交易结算表\n单位：万元\n成交价 ¥380.38\n减：中介费 （4.00）";
    const session = source(page(text));
    expect(session.read("（4.00）", { unitQuote: "单位：万元" })).toMatchObject({
      number: { value: -40_000, scale: 10_000, unit: { kind: "currency", code: "CNY" } },
    });
  });
});
