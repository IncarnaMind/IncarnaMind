/**
 * An amount a comparison table's cell writes, against the amounts its Citations quote, each at the
 * scale its Document gives it (#1798). The sheets are the workbooks in tests/fixtures/comparisons,
 * read as IncarnaMind indexes them.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { QuotedText } from "../../src/core/answers/calculations";
import { changedScale } from "../../src/core/answers/changedScale";
import { extractXlsx } from "../../src/core/documents/formats/xlsx";
import type { UnitText } from "../../src/shared/units";

const FIXTURES = join(import.meta.dirname, "../fixtures/comparisons");
const sheet = async (name: string) =>
  (await extractXlsx(new Uint8Array(await readFile(join(FIXTURES, name))))).units;
const CEDAR = await sheet("Cedar Q3 2026 final.xlsx");
const XUESONG = await sheet("雪松控股2026年三季度终稿.xlsx");

const cited = (quote: string, units: readonly UnitText[]): QuotedText => ({
  citation: { quote },
  units: [...units],
});
const page = (text: string): UnitText[] => [{ page: 1, kind: "page", text }];

const check = (text: string, quotes: readonly QuotedText[], language: "en" | "zh-CN" = "en") =>
  changedScale(text, quotes, language);

const NET_DEBT = cited("310000", CEDAR);
const EBITDA = cited("95000", CEDAR);
const DRAFT = page(
  "Cedar draft\nAll amounts in GBP million unless stated otherwise.\nNet debt: 340. LTM adjusted EBITDA: 80.",
);

describe("A cell's amount against its Citations' amounts", () => {
  // protects=the reported case: GBP thousands written as GBP millions, 1,000 times too large, is found and says what the Document gives; fails_when=it passes as found words; no_claim=what the cell shows (comparisons.test.ts).
  test("finds GBP thousands written as GBP millions, and says what the Document gives", () => {
    expect(check("Net debt: 310,000 GBP million [^1]", [NET_DEBT])).toEqual({
      written: "310,000 GBP million",
      given: "310000 GBP thousands",
      times: 1000,
    });
    expect(check("£310 billion [^1]", [NET_DEBT])?.times).toBe(1_000);
    expect(check("£310,000 [^1]", [NET_DEBT])?.times).toBe(0.001);
  });

  // protects=a quote copied with spaces for the row's tabs, which reads "310000 GBP thousands" itself, isn't read as its row's bare cell; fails_when="GBP 310 million" is flagged against "310000" (seen with Claude Haiku 5.5 after #1798); no_claim=none beyond protects.
  test("passes a right amount whose quote joins the row's cells with spaces", () => {
    const spaced = cited(
      "Net debt Q3 2026 actual 310000 GBP thousands actual, not forecast",
      CEDAR,
    );
    expect(check("Net debt: GBP 310 million [^1]", [spaced])).toBeNull();
    expect(check("Net debt: 310,000 GBP million [^1]", [spaced])?.times).toBe(1_000);
  });

  // protects=a right amount passes at any scale it is written in: converted, as given, rounded, beside another; fails_when=a correct cell shows a problem line; no_claim=amounts worked out from several figures, which calculate checks.
  test("passes a right amount at any scale: converted, as the Document gives it, or beside another", () => {
    expect(check("Net debt: GBP 310 million [^1]", [NET_DEBT])).toBeNull();
    expect(check("£0.31 billion [^1]", [NET_DEBT])).toBeNull();
    expect(
      check("310,000 GBP thousands [^1]", [cited("Net debt\tQ3 2026 actual\t310000", CEDAR)]),
    ).toBeNull();
    expect(check("Net debt £310m [^1]; EBITDA £95m [^2]", [NET_DEBT, EBITDA])).toBeNull();
    expect(check("Net debt £310m [^1]; EBITDA £95,000m [^2]", [NET_DEBT, EBITDA])).toMatchObject({
      written: "£95,000m",
      given: "95000 GBP thousands",
    });
  });

  // protects=an amount none of the Citations gives, a share, a count or a date is left alone; fails_when=a worked-out total or a percentage shows a problem line; no_claim=whether that amount is right.
  test("leaves alone an amount no Citation gives, a percentage, a plain count and an empty cell", () => {
    expect(check("Net debt plus EBITDA: £405m [^1] [^2]", [NET_DEBT, EBITDA])).toBeNull();
    expect(check("87% [^1]", [cited("87%", CEDAR)])).toBeNull();
    expect(check("310,000 [^1]", [NET_DEBT])).toBeNull();
    expect(check("Q3 2026 [^1]", [NET_DEBT])).toBeNull();
    expect(check("", [NET_DEBT])).toBeNull();
    expect(check("£310m", [])).toBeNull();
  });

  // protects=an amount in brackets keeps its sign on both sides; fails_when=a negative read as positive hides or invents a change; no_claim=none beyond protects.
  test("reads amounts in brackets as negative on both sides", () => {
    expect(check("(£12.5 million) [^1]", [cited("(12,500)", CEDAR)])).toBeNull();
    expect(check("(12,500) GBP million [^1]", [cited("(12,500)", CEDAR)])?.times).toBe(1_000);
  });

  // protects=a scale the column's heading states, and one the page states, count as the Document's; fails_when=a heading's unit is missed and a right cell is flagged; no_claim=a scale stated on another page, which is left unsettled.
  test("takes the scale from a column's heading or the page's unit line", () => {
    const headed = [
      { page: 1, kind: "rows" as const, text: "Metric\tAmount (GBP thousands)\nNet debt\t310,000" },
    ];
    expect(check("£310m [^1]", [cited("Net debt\t310,000", headed)])).toBeNull();
    expect(check("£310,000m [^1]", [cited("Net debt\t310,000", headed)])?.given).toBe(
      "310,000 GBP thousands",
    );
    expect(check("Net debt GBP 340 million [^1]", [cited("Net debt: 340.", DRAFT)])).toBeNull();
    expect(
      check("Net debt 340; EBITDA 80 (GBP million) [^1]", [cited("Net debt: 340.", DRAFT)]),
    ).toBeNull();
    expect(check("GBP 340,000 million [^1]", [cited("Net debt: 340.", DRAFT)])?.given).toBe(
      "340 GBP million",
    );
  });

  // protects=a number whose scale the cited text doesn't state in words the reader knows is never flagged, whatever the cell writes; fails_when=a table continued from a page whose heading states its scale, or one under "£000", "€000", "TEUR" or "(000's omitted)", has a right amount flagged (R55); no_claim=a wrong amount there, which can't be told from a right one.
  test("never flags against a scale the cited text doesn't state in words the reader knows", () => {
    expect(
      check("£340 million [^1]", [cited("Net debt: 340.", page("Net debt: 340."))]),
    ).toBeNull();
    for (const heading of ["£000", "€000", "TEUR", "(000's omitted)"]) {
      const sheet = page(`Group results\nNet debt ${heading}\n310,000`);
      for (const cell of ["£310m", "€310 million", "£310,000", "£310 billion"]) {
        expect(check(`${cell} [^1]`, [cited("310,000", sheet)]), `${heading}: ${cell}`).toBeNull();
      }
    }
  });

  // protects=a quoted amount with its own currency under a heading's scale may be either, so a right per-share figure isn't flagged (R55); fails_when="$2.15" earnings per share under "(in millions, except per share data)" is flagged, and the note then gets "$2.15 million" written; no_claim=which of the two the Document means.
  test("passes a per-share amount under a table's (in millions) heading", () => {
    const results = cited(
      "Diluted earnings per share $2.15",
      page(
        "Results (in millions, except per share data)\nNet income $1,231\nDiluted earnings per share $2.15",
      ),
    );
    expect(check("$2.15 [^1]", [results])).toBeNull();
    expect(check("$2,150 [^1]", [results])?.given).toBe("$2.15 in millions");
  });

  // protects=a total, a difference or a rounded amount is never taken for a changed scale, only the same digits at another power of ten (R55); fails_when="GBP 500 million" for 450 + 50, or "about £1bn" beside £95m, is flagged; no_claim=whether the total is right.
  test("leaves alone a total, a difference and an approximate or rounded amount", () => {
    const segments = page("Segment net debt (GBP million)\nUK 450\nIreland 50");
    const both = [cited("UK 450", segments), cited("Ireland 50", segments)];
    expect(check("GBP 500 million [^1] [^2]", both)).toBeNull();
    expect(check("GBP 400 million [^1] [^2]", both)).toBeNull();
    expect(check("about £1bn [^1]", [EBITDA])).toBeNull();
    expect(check("£1bn [^1]", [EBITDA])).toBeNull();
    expect(check("£950m [^1]", [EBITDA])).toMatchObject({ times: 10 });
  });

  // protects=万元 and 亿元: a unit in its own cell beside the number applies to it, 万 to 亿 converts, and 10ⁿ off is found; fails_when=31000万元 written as 0.31亿 or 31000亿 passes, or 3.1亿 is flagged; no_claim=none beyond protects.
  test("reads 万元 from its own cell, passes 3.1亿, and finds 0.31亿, 31000亿 and 31000元", () => {
    const quote = cited("31000", XUESONG);
    expect(check("净负债3.1亿元[^1]", [quote], "zh-CN")).toBeNull();
    expect(check("净负债31,000万元[^1]", [quote], "zh-CN")).toBeNull();
    expect(check("净负债0.31亿元[^1]", [quote], "zh-CN")).toEqual({
      written: "0.31亿元",
      given: "31000万元",
      times: 0.1,
    });
    expect(check("净负债31000亿元[^1]", [quote], "zh-CN")?.times).toBe(10_000);
    expect(check("净负债31000元[^1]", [quote], "zh-CN")?.times).toBe(0.0001);
  });

  // protects=a quote in a sheet of 20,000 rows is placed and read; fails_when=a long sheet's Units lose the quote's row; no_claim=how long it takes.
  test("reads a quote in a sheet of 20,000 rows", () => {
    const rows = Array.from({ length: 20_000 }, (_, at) => `Line ${at}\t${at * 7}\tGBP thousands`);
    const huge = cited("Line 19999\t139993", [{ page: 1, kind: "rows", text: rows.join("\n") }]);
    expect(check("£139.993 million [^1]", [huge])).toBeNull();
    expect(check("£139,993 million [^1]", [huge])?.times).toBe(1_000);
  });
});
