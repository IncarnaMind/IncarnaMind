/**
 * #2997's measured table: each sentence of the #1332, #1452 and #2226 tests, of the checks
 * evaluation's supported set, and of the issue's rows, twins and edge cases, with what it read on
 * main and reads here. Each part of the table runs in its own file (answerUnitsTable*.test.ts).
 */
import { describe, expect, test } from "vitest";
import { PARTS, rowsOf, shows, TABLE } from "../helpers/answerUnitsTable";

describe("#2997's measured table", () => {
  // protects=the table itself: no row reads ✓ here that didn't on main, no row Check against Documents calls Supported on main loses the Answer's ✓, and every twin keeps the ✓ it had; fails_when=a row of the table is changed to say otherwise; no_claim=what the code reads, which the part files run.
  test("takes a ✓ only away, never from a sentence Check against Documents calls Supported", () => {
    expect(
      TABLE.rows.filter((row) => shows(row.here) && !shows(row.main)).map(({ id }) => id),
    ).toEqual([]);
    expect(
      TABLE.rows
        .filter(
          (row) => shows(row.main) && row.main.document.verdict === "supported" && !shows(row.here),
        )
        .map(({ id }) => id),
    ).toEqual([]);
    expect(
      TABLE.rows
        .filter((row) => row.source.includes("twin") && shows(row.main) && !shows(row.here))
        .map(({ id }) => id),
    ).toEqual([]);
  });

  // protects=every row is run by one of the part files; fails_when=a row comes from a test or set no part runs; no_claim=what the rows read.
  test("every row is in one part", () => {
    const parts = Object.keys(PARTS) as (keyof typeof PARTS)[];
    expect(parts.reduce((count, part) => count + rowsOf(part).length, 0)).toBe(TABLE.rows.length);
  });
});
