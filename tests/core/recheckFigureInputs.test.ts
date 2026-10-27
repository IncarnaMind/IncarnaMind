import { expect, test } from "vitest";
import { createCalculationSession } from "../../src/core/answers/calculations";
import { type AnswerDocuments, createCitationSession } from "../../src/core/answers/citations";
import type { FigureInput } from "../../src/core/api";

type Unit = ReturnType<AnswerDocuments["pageTexts"]>[number];

function source(units: Unit[], language: "en" | "zh-CN" = "en") {
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
            text: pages.map((unit) => unit.text).join("\n"),
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
      label: { sheet: "Accounts", rows: [1, 2], column: 0, values: { B2: stored } },
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
