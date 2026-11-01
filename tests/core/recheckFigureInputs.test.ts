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
  const input = session.read("Less: agent's fee (4,620.00)", {
    unitQuote: "Sale price £385,000.00",
  });
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
  const input = session.read("Less: agent's fee (4,620.00)", {
    unitQuote: "Sale price £385,000.00",
  });
  const unit = input.unitStatement;
  if (!unit) throw new Error("Missing unit statement.");
  expect(
    session.recheck({ ...input, unitStatement: { ...unit, currencyChars: "$" } }),
  ).toHaveProperty("problem");
});

test("a Passage that names two currencies gives a bare number neither", () => {
  const text = "Sale price £385,000.00\nDeposit $12,000.00\nLess: agent's fee (4,620.00)";
  const session = source(page(text));
  expect(() =>
    session.read("Less: agent's fee (4,620.00)", { unitQuote: "Sale price £385,000.00" }),
  ).toThrow(/gives GBP, but p\. 1 names more than one currency \(GBP, USD\)/);
});

test("a unitQuote that isn't in the Passage, or writes no currency, is refused", () => {
  const text = "Sale price £385,000.00\nLess: agent's fee (4,620.00)";
  const session = source(page(text));
  expect(() =>
    session.read("Less: agent's fee (4,620.00)", { unitQuote: "Sale price £999,999.00" }),
  ).toThrow(/isn't word for word in P1/);
  expect(() =>
    session.read("Less: agent's fee (4,620.00)", { unitQuote: "Less: agent's fee (4,620.00)" }),
  ).toThrow(/states no unit or scale/);
});

describe("a currency a statement writes on its first amount", () => {
  const fee = "Less: agent's fee (4,620.00)";
  const price = "Sale price £385,000.00";
  const cost = "Less: search and other costs (804.00)";
  const readFee = (text: string, passage?: string, language: "en" | "zh-CN" = "en") =>
    source(page(text), language, passage).read(fee, { unitQuote: price });
  const refused = (
    text: string,
    message: RegExp,
    passage?: string,
    language: "en" | "zh-CN" = "en",
  ) => {
    const session = source(page(text), language, passage);
    expect(() => session.read(fee, { unitQuote: price })).toThrow(message);
  };

  test("the issue's statement reads its fee in the sale price's currency", () => {
    expect(readFee(`Completion statement: 14 Mill Lane\n${price}\n${fee}`)).toMatchObject({
      number: { value: -4620, unit: { kind: "currency", code: "GBP" }, decimals: 2 },
      unitStatement: { currency: "GBP", currencyChars: "£" },
    });
  });

  // protects=#1001; fails_when=a Chinese statement's two-decimal amounts are refused, or its ¥ is read as another currency.
  test("a Chinese statement with two decimals reads in 元", () => {
    const session = source(
      page("房产交易结算表\n成交价 ¥3,850,000.00\n减：中介费 （46,200.00）"),
      "zh-CN",
    );
    expect(
      session.read("减：中介费 （46,200.00）", { unitQuote: "成交价 ¥3,850,000.00" }),
    ).toMatchObject({
      number: { value: -46_200, unit: { kind: "currency", code: "CNY" }, decimals: 2 },
    });
  });

  // The price of the rule: a statement written in whole pounds has no two-decimal amount to trust.
  test("a statement in whole pounds is refused", () => {
    const session = source(page("Sale price £385,000\nLess: agent's fee (4,620)"));
    expect(() =>
      session.read("Less: agent's fee (4,620)", {
        unitQuote: "Sale price £385,000",
        reading: 1,
      }),
    ).toThrow(/two decimals/);
  });

  // A currency written next to a scale, in either order, anywhere in the Document.
  test.each(["TEUR", "T€", "k€", "$K", "MEUR", "$MM", "USD MM"])(
    "refuses when the Document writes %s",
    (marker) => {
      refused(["Completion statement", marker, price, fee].join("\n"), /states a scale/);
    },
  );

  test.each(["新台幣仟元", "港幣百萬"])("refuses when a Chinese Document writes %s", (marker) => {
    const session = source(
      page(["房产交易结算表", marker, "成交价 ¥380,400.00", "减：中介费 （4,620.00）"].join("\n")),
      "zh-CN",
    );
    expect(() =>
      session.read("减：中介费 （4,620.00）", { unitQuote: "成交价 ¥380,400.00" }),
    ).toThrow(/states a scale/);
  });

  test("refuses a scale written between the two rows", () => {
    refused([price, "金额（万）", fee].join("\n"), /one statement block/);
  });

  test("refuses a blank line between the two rows", () => {
    refused([price, "", fee].join("\n"), /one statement block/);
  });

  test("refuses a heading between the two rows", () => {
    refused([price, "Deductions", fee].join("\n"), /one statement block/);
  });

  test("refuses a page break between the two rows", () => {
    const session = source(
      [
        { kind: "page", page: 1, text: price },
        { kind: "page", page: 2, text: fee },
      ],
      "en",
      [price, fee].join("\n"),
    );
    expect(() => session.read(fee, { unitQuote: price })).toThrow(/page break/);
  });

  test("refuses a number above the line", () => {
    const session = source(page(["Shares 1,000,000.00", price, fee].join("\n")));
    expect(() => session.read("Shares 1,000,000.00", { unitQuote: price })).toThrow(/not above/);
  });

  test("refuses a row with no label", () => {
    const session = source(page(["£385,000.00", "(4,620.00)"].join("\n")));
    expect(() => session.read("(4,620.00)", { unitQuote: "£385,000.00" })).toThrow(
      /statement rows/,
    );
  });

  test("refuses another table column", () => {
    const session = source(
      page(["Item\tPrice\tQty", "Widget\t£380.40\t1.00", "Gadget\t£380.40\t12.00"].join("\n")),
    );
    expect(() =>
      session.read("Gadget\t£380.40\t12.00", {
        unitQuote: "Widget\t£380.40",
        position: 2,
      }),
    ).toThrow(/table column/);
  });

  test("reads a bare row of the statement's own column", () => {
    const session = source(
      page(["Item\tAmount", "Widget\t£385,000.00", "Fee\t(4,620.00)"].join("\n")),
    );
    expect(session.read("Fee\t(4,620.00)", { unitQuote: "Widget\t£385,000.00" })).toMatchObject({
      number: { value: -4620, unit: { kind: "currency", code: "GBP" } },
    });
  });

  test("reads a block with other rows between the two", () => {
    const session = source(page([price, "Less: legal fees (1,500.00)", cost].join("\n")));
    expect(session.read(cost, { unitQuote: price })).toMatchObject({
      number: { value: -804, unit: { kind: "currency", code: "GBP" } },
    });
  });

  test.each([
    "In 2026 the sale completed.",
    "Unit 4, 12 Mill Lane",
    "I'm the seller's agent.",
    "M. Smith",
    "Room 000",
  ])("accepts a two-decimal statement with %s above it", (line) => {
    expect(
      readFee(["Completion statement: 14 Mill Lane", line, price, fee].join("\n")),
    ).toMatchObject({ number: { value: -4620, unit: { kind: "currency", code: "GBP" } } });
  });

  test.each(["万科", "一千", "工作单位"])(
    "accepts a Chinese two-decimal statement with %s above it",
    (line) => {
      const session = source(
        page(
          [
            "房产交易结算表",
            `备注：${line}`,
            "成交价 ¥3,850,000.00",
            "减：中介费 （46,200.00）",
          ].join("\n"),
        ),
        "zh-CN",
      );
      expect(
        session.read("减：中介费 （46,200.00）", { unitQuote: "成交价 ¥3,850,000.00" }),
      ).toMatchObject({ number: { value: -46_200, unit: { kind: "currency", code: "CNY" } } });
    },
  );

  // Rule 3, through the reader's own scale statements: a scale line needs no currency beside it.
  test.each(["All figures in thousands", "(in millions)"])(
    "refuses a scale line %s with two-decimal amounts",
    (scaleLine) => {
      const session = source(
        page([scaleLine, "Sale price £6.12", "Less: agent's fee (6.12)"].join("\n")),
      );
      expect(() =>
        session.read("Less: agent's fee (6.12)", { unitQuote: "Sale price £6.12" }),
      ).toThrow(/states a scale/);
    },
  );

  test.each(["单位：万元", "（万元）"])(
    "refuses a Chinese scale line %s with two-decimal amounts",
    (scaleLine) => {
      const session = source(
        page(["房产交易结算表", scaleLine, "成交价 ¥378.88", "减：中介费 （6.12）"].join("\n")),
        "zh-CN",
      );
      expect(() => session.read("减：中介费 （6.12）", { unitQuote: "成交价 ¥378.88" })).toThrow(
        /states a scale/,
      );
    },
  );

  test("a Document read before this build is refused the carry until it is read again", () => {
    const text = "Sale price £385,000.00\nLess: agent's fee (4,620.00)";
    const session = source([{ kind: "page", page: 1, text, scaleMarker: null }]);
    expect(() =>
      session.read("Less: agent's fee (4,620.00)", { unitQuote: "Sale price £385,000.00" }),
    ).toThrow(/older build/);
  });

  test("a Chinese statement naming its scale's own line still applies that scale", () => {
    const session = source(
      page("房产交易结算表\n单位：万元\n成交价 ¥380.38\n减：中介费 （4.00）"),
      "zh-CN",
    );
    expect(session.read("减：中介费 （4.00）", { unitQuote: "单位：万元" })).toMatchObject({
      number: { value: -40_000, scale: 10_000, unit: { kind: "currency", code: "CNY" } },
    });
  });
});
