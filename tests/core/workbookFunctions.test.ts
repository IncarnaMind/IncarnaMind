/**
 * The formula engine against results Excel is documented to give (#2347):
 * Microsoft's own examples for YEARFRAC, IRR, XIRR, XNPV, ROUND, IFERROR and
 * MATCH, its two date systems, how an error spreads through SUM, and the
 * cases where IncarnaMind refuses rather than give a number it can't vouch
 * for. Each formula is worked out in a cell with no saved value, so what is
 * tested is the engine's own result.
 */
import { describe, expect, test } from "vitest";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import { workbookModel } from "../../src/core/workbooks/model";
import { placeKey, recalculate, WorkbookEngine } from "../../src/core/workbooks/recalculate";
import { isError } from "../../src/core/workbooks/values";
import { serial, WorkbookBuilder } from "../helpers/financeWorkbooks";

type Given = number | string | boolean | { error: string };

/** What Excel's formula gives over these cells of a sheet "S", or why it is refused. */
async function excel(
  formula: string,
  cells: Record<string, Given> = {},
  date1904 = false,
): Promise<number | string | boolean | null | { refused: string }> {
  const book = new WorkbookBuilder();
  book.date1904 = date1904;
  const sheet = book.sheet("S").text("Y1", "Case");
  for (const [ref, value] of Object.entries(cells)) {
    if (typeof value === "number") sheet.number(ref, value);
    else if (typeof value === "boolean") sheet.flag(ref, value);
    else if (typeof value === "string") sheet.text(ref, value);
    else sheet.error(ref, value.error);
  }
  sheet.formula("Z1", formula, null);
  const model = workbookModel("d", "v", (await extractXlsx(new Uint8Array(book.xlsx()))).units);
  const found = model?.byName.get("S");
  if (!model || !found) throw new Error("No model.");
  const key = placeKey(found, 1, 25);
  const result = (await recalculate(new WorkbookEngine(model), [key])).results.get(key);
  if (!result) throw new Error("Not worked out.");
  if (result.problem && result.problem.kind !== "no-saved-value")
    return { refused: result.problem.kind };
  const worked = result.worked ?? null;
  return isError(worked) ? worked.code : worked;
}

const DOC_DATES = { A1: serial(2012, 1, 1), A2: serial(2012, 7, 30) };
const IRR_FLOWS = { A1: -70000, A2: 12000, A3: 15000, A4: 18000, A5: 21000, A6: 26000 };
const XIRR_FLOWS = {
  A1: -10000,
  A2: 2750,
  A3: 4250,
  A4: 3250,
  A5: 2750,
  B1: serial(2008, 1, 1),
  B2: serial(2008, 3, 1),
  B3: serial(2008, 10, 30),
  B4: serial(2009, 2, 15),
  B5: serial(2009, 4, 1),
};

describe("Excel's documented results", () => {
  test.each([
    ["YEARFRAC(A1,A2)", 0.58055556],
    ["YEARFRAC(A1,A2,1)", 0.57650273],
    ["YEARFRAC(A1,A2,3)", 0.57808219],
  ])("%s from 1 January to 30 July 2012 is %s", async (formula, expected) => {
    expect(await excel(formula, DOC_DATES)).toBeCloseTo(expected, 8);
  });

  test.each([
    ["IRR(A1:A5)", -0.0212],
    ["IRR(A1:A6)", 0.0866],
    ["IRR(A1:A3,-0.1)", -0.4435],
  ])("%s is %s", async (formula, expected) => {
    expect(await excel(formula, IRR_FLOWS)).toBeCloseTo(expected, 4);
  });

  test("XIRR and XNPV of Microsoft's dated flows", async () => {
    expect(await excel("XIRR(A1:A5,B1:B5)", XIRR_FLOWS)).toBeCloseTo(0.373362535, 8);
    expect(await excel("XNPV(0.09,A1:A5,B1:B5)", XIRR_FLOWS)).toBeCloseTo(2086.647602, 5);
  });

  test.each([
    ["ROUND(2.15,1)", 2.2],
    ["ROUND(2.149,1)", 2.1],
    ["ROUND(-1.475,2)", -1.48],
    ["ROUND(21.5,-1)", 20],
    ["ROUND(626.3,-3)", 1000],
    ["ROUND(1.98,-1)", 0],
    ["ROUND(-50.55,-2)", -100],
  ])("%s is %s", async (formula, expected) => {
    expect(await excel(formula)).toBe(expected);
  });

  test("IFERROR gives its value, or the fallback for an error", async () => {
    const cells = { A1: 210, B1: 35, A2: 55, B2: 0, B3: 23 };
    expect(await excel('IFERROR(A1/B1,"Error in calculation")', cells)).toBe(6);
    expect(await excel('IFERROR(A2/B2,"Error in calculation")', cells)).toBe(
      "Error in calculation",
    );
    expect(await excel('IFERROR(A3/B3,"Error in calculation")', cells)).toBe(0);
  });

  test("an error in a range SUM adds up is its result; without one, the sum", async () => {
    expect(await excel("SUM(A1:A3)", { A1: 1, A2: { error: "#DIV/0!" }, A3: 3 })).toBe("#DIV/0!");
    expect(await excel("SUM(A1:A3)", { A1: 1, A2: 2, A3: 3 })).toBe(6);
  });

  test("MATCH finds the largest value at most the one sought in a sorted range, and the exact one", async () => {
    const cells = { B1: 25, B2: 38, B3: 40, B4: 41 };
    expect(await excel("MATCH(39,B1:B4,1)", cells)).toBe(2);
    expect(await excel("MATCH(41,B1:B4,0)", cells)).toBe(4);
    // Excel gives #N/A here, the range not being in descending order: refused, never a number.
    expect(await excel("MATCH(40,B1:B4,-1)", cells)).toEqual({ refused: "unsorted" });
  });

  test("5 July 1998 is 35981 in the 1900 date system and 34519 in the 1904 one", async () => {
    expect(await excel("DATE(1998,7,5)")).toBe(35981);
    expect(await excel("DATE(1998,7,5)", {}, true)).toBe(34519);
    expect(await excel("YEAR(A1)", { A1: 34519 }, true)).toBe(1998);
  });

  test("numbers that agree to 15 significant digits are equal, as Excel compares them", async () => {
    expect(await excel("IF(A1+A2=0.3,1,0)", { A1: 0.1, A2: 0.2 })).toBe(1);
    expect(await excel("A1+A2=0.3", { A1: 0.1, A2: 0.2 })).toBe(true);
    expect(await excel("A1+A2=0.3", { A1: 0.1, A2: 0.25 })).toBe(false);
  });

  test("a block counts its blank cells, as Excel does", async () => {
    const cells = { A1: 1, A2: 9, B1: 5 };
    expect(await excel("SUMPRODUCT(--(A1:A10<B1))", cells)).toBe(9);
    expect(await excel('SUMPRODUCT((A1:A10="")*1)', cells)).toBe(8);
  });

  test("COUNTIF reads an error and a date in its condition", async () => {
    expect(await excel('COUNTIF(A1:A3,"#N/A")', { A1: { error: "#N/A" }, A2: 1, A3: "x" })).toBe(1);
    const dates = { A1: serial(2025, 1, 1), A2: 45000, A3: 46000 };
    expect(await excel('COUNTIF(A1:A3,">=1/1/2025")', dates)).toBe(2);
    expect(await excel('COUNTIF(A1:A3,">=2025-01-01")', dates)).toBe(2);
    // Day first or month first can't be told: refused.
    expect(await excel('COUNTIF(A1:A3,">=1/2/2025")', dates)).toEqual({ refused: "criterion" });
  });

  test("text is ordered as Excel orders letters, digits and spaces; other characters are refused", async () => {
    expect(await excel('"a"<"B"')).toBe(true);
    expect(await excel('"10"<"9"')).toBe(true);
    expect(await excel('" z"<"a"')).toBe(true);
    expect(await excel('"_"<"A"')).toEqual({ refused: "text-order" });
    expect(await excel('"é"="E"')).toBe(false);
  });

  test("dates before 1 March 1900 are refused; from then on they read as Excel's", async () => {
    expect(await excel("YEAR(A1)", { A1: 0 })).toEqual({ refused: "early-date" });
    expect(await excel("DATE(1900,2,28)")).toEqual({ refused: "early-date" });
    expect(await excel("MONTH(61)")).toBe(3);
    expect(await excel("DAY(61)")).toBe(1);
  });

  test("an approximate lookup over an unsorted range is refused; over a sorted one it is found", async () => {
    const unsorted = { A1: 1, A2: 7, A3: 3, A4: 9, A5: 4, B1: 10, B2: 70, B3: 30, B4: 90, B5: 40 };
    expect(await excel("VLOOKUP(4,A1:B5,2,TRUE)", unsorted)).toEqual({ refused: "unsorted" });
    expect(await excel("MATCH(4,A1:A5,1)", unsorted)).toEqual({ refused: "unsorted" });
    const sorted = { A1: 1, A2: 3, A3: 4, A4: 7, A5: 9, B1: 10, B2: 30, B3: 40, B4: 70, B5: 90 };
    expect(await excel("VLOOKUP(5,A1:B5,2,TRUE)", sorted)).toBe(40);
  });
});
