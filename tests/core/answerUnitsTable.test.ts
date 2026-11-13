/**
 * #2997's measured table: each sentence of the figure currency and unit tests (#1452, #2189,
 * #2225, #2226), of the checks evaluation's labelled set, and of the issue's rows, twins and edge
 * cases, with what it read on main and reads here. Each part of the table runs in its own file
 * (answerUnitsTable*.test.ts).
 */
import { describe, expect, test } from "vitest";
import { PARTS, rowsOf, shows, TABLE } from "../helpers/answerUnitsTable";

describe("#2997's measured table", () => {
  // protects=the table itself: the rows that read ✓ here and not on main are exactly the right sentences a label, a unit line or the quote's unit in another word now states (#2997), no row Check against Documents calls Supported on main loses the Answer's ✓, and every twin keeps the ✓ it had; fails_when=another row gains a ✓, one of these loses it, or a row of the table is changed to say otherwise; no_claim=what the code reads, which the part files run.
  test("gives a ✓ only to the listed right sentences, and never takes one from a sentence Check against Documents calls Supported", () => {
    expect(
      TABLE.rows.filter((row) => shows(row.here) && !shows(row.main)).map(({ id }) => id),
    ).toEqual([
      "u120",
      "u125",
      "u201",
      "u205",
      "u235",
      "u251",
      "u252",
      "c417",
      "c418",
      "c420",
      "e-heading-second-label-en",
      "e-heading-second-label-zh-CN",
      "e-heading-en-second-label-en",
      "e-heading-en-second-label-zh-CN",
      "l-fs-038",
      "e-heading-second-rows-row2-right-en",
      "e-heading-second-rows-row2-right-zh-CN",
      "e-cell-label-over-column-right-en",
      "e-cell-label-over-column-right-zh-CN",
    ]);
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
