/**
 * #2997's measured table: each sentence of the figure currency and unit tests (#1452, #2189,
 * #2225, #2226), of the checks evaluation's labelled set, and of the issue's rows, twins and edge
 * cases, with what it read on main and reads here. Each part of the table runs in its own file
 * (answerUnitsTable*.test.ts).
 */
import { describe, expect, test } from "vitest";
import { PARTS, rowsOf, shows, TABLE } from "../helpers/answerUnitsTable";

const GAINED = [
  "u120",
  "u125",
  "u126",
  "u128",
  "u130",
  "u131",
  "u196",
  "u201",
  "u203",
  "u204",
  "u205",
  "u206",
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
  "l-fs-103",
  "e-heading-second-rows-row2-right-en",
  "e-heading-second-rows-row2-right-zh-CN",
  "e-cell-label-over-column-right-en",
  "e-cell-label-over-column-right-zh-CN",
  "e-en-unit-column-right-en",
  "e-en-unit-column-right-zh-CN",
  "e-en-row-label-right-en",
  "e-en-row-label-right-zh-CN",
  "e-same-unit-caption-elsewhere-other-scale-en",
  "e-same-unit-caption-elsewhere-other-scale-zh-CN",
];

// The rows that read otherwise than main in more than the ✓ they gain, where a table states its
// unit (#2997): a right sentence Check against Documents now calls Supported, and a wrong one
// caught in both checks.
const CHANGED = [
  "e-bracket-usd-millions-other-scale-en",
  "e-bracket-usd-millions-other-scale-zh-CN",
  "e-label-other-cell-row-en",
  "e-label-other-cell-row-zh-CN",
  "e-caption-mass-plain-wrong-en",
  "e-caption-mass-plain-wrong-zh-CN",
  "e-caption-other-measure-en",
  "e-caption-other-measure-zh-CN",
  "e-qualified-caption-coal-plain-wrong-en",
  "e-qualified-caption-coal-plain-wrong-zh-CN",
  "e-qualified-caption-co2-plain-wrong-en",
  "e-qualified-caption-co2-plain-wrong-zh-CN",
  "e-qualified-bare-unit-coal-right-en",
  "e-qualified-bare-unit-coal-right-zh-CN",
  "e-qualified-bare-unit-coal-wan-en",
  "e-qualified-bare-unit-coal-wan-zh-CN",
  "e-row-label-right-2024-en",
  "e-row-label-right-2024-zh-CN",
  "e-row-label-right-2023-en",
  "e-row-label-right-2023-zh-CN",
  "e-row-label-yi-en",
  "e-row-label-yi-zh-CN",
  "e-row-label-plain-wrong-en",
  "e-row-label-plain-wrong-zh-CN",
  "e-row-label-money-row-yi-en",
  "e-row-label-money-row-yi-zh-CN",
  "e-row-label-money-row-right-en",
  "e-row-label-money-row-right-zh-CN",
  "e-unit-column-right-en",
  "e-unit-column-right-zh-CN",
  "e-unit-column-yi-en",
  "e-unit-column-yi-zh-CN",
  "e-unit-column-plain-wrong-en",
  "e-unit-column-plain-wrong-zh-CN",
  "e-c-heading-coal-right-en",
  "e-c-heading-coal-right-zh-CN",
  "e-c-heading-coal-wan-en",
  "e-c-heading-coal-wan-zh-CN",
  "e-c-column-coal-right-en",
  "e-c-column-coal-right-zh-CN",
  "e-c-own-label-coal-right-en",
  "e-c-own-label-coal-right-zh-CN",
  "e-c-caption-co2-right-en",
  "e-c-caption-co2-right-zh-CN",
  "e-scale-word-no-unit-other-bracket-en",
  "e-scale-word-no-unit-other-bracket-zh-CN",
  "e-row-label-right-other-caption-energy-en",
  "e-row-label-right-other-caption-energy-zh-CN",
  "e-row-label-right-other-caption-percent-en",
  "e-row-label-right-other-caption-percent-zh-CN",
];

describe("#2997's measured table", () => {
  // protects=the table itself: the rows that read ✓ here and not on main are exactly the listed ones, the right sentences a label, a unit line, a table's row label or units column, prose or the quote's unit in another word now states, u252, whose dollar the Document states nowhere and the Answer leaves to the model, and e-same-unit-caption-elsewhere-other-scale, whose own table states no unit, so another table's caption states none for it either (#2997); a listed row's Check against Documents reading is main's; the rows that read otherwise in more than that are exactly the listed CHANGED, and every other row reads as on main in both checks; no row Check against Documents calls Supported on main loses the Answer's ✓, and every twin keeps the ✓ it had; fails_when=another row gains a ✓, one of these loses it, any row reads otherwise than main in either check beyond these lists, or a row of the table is changed to say otherwise; no_claim=what the code reads, which the part files run.
  test("gives a ✓ only to the listed sentences, and never takes one from a sentence Check against Documents calls Supported", () => {
    expect(
      TABLE.rows.filter((row) => shows(row.here) && !shows(row.main)).map(({ id }) => id),
    ).toEqual(GAINED);
    expect(
      TABLE.rows
        .filter(
          (row) =>
            GAINED.includes(row.id) &&
            JSON.stringify(row.here.document) !== JSON.stringify(row.main.document),
        )
        .map(({ id }) => id),
    ).toEqual([]);
    expect(
      TABLE.rows
        .filter(
          (row) =>
            !GAINED.includes(row.id) && JSON.stringify(row.here) !== JSON.stringify(row.main),
        )
        .map(({ id }) => id),
    ).toEqual(CHANGED);
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
