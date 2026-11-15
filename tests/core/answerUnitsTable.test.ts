/**
 * #2997's measured table: each sentence of the figure currency and unit tests (#1452, #2189,
 * #2225, #2226), of the checks evaluation's labelled set, and of the issue's rows, twins and edge
 * cases, with what it read on main and reads here. Each part of the table runs in its own file
 * (answerUnitsTable*.test.ts).
 */
import { describe, expect, test } from "vitest";
import { PARTS, rowsOf, shows, TABLE } from "../helpers/answerUnitsTable";

const inBothLanguages = (ids: readonly string[]) =>
  ids.flatMap((id) => [`colon-${id}-en`, `colon-${id}-zh-CN`]);

// An organisation named after a colon ("编制单位：万禾股份有限公司" over "单位：元") states no
// unit, and the unit line beside it states the Document's own (#2997). Right sentences that gain
// the ✓:
const COLON_GAINED = inBothLanguages([
  "case-1",
  "half-colon-1",
  "half-colons-1",
  "space-after-1",
  "space-before-1",
  "reversed-1",
  "one-line-1",
  "one-line-wide-space-1",
  "one-line-unit-first-1",
  "one-line-glued-1",
  "one-line-date-1",
  "currency-line-1",
  "year-line-1",
  "no-colon-1",
  "wan-0",
  "wan-one-line-0",
  "label-00-1",
  "label-01-1",
  "label-04-1",
  "label-05-1",
  "label-06-1",
  "label-08-1",
  "label-09-1",
  "label-10-1",
  "name-yili-1",
  "name-baise-1",
  "name-usd-fund-1",
  "name-qianwa-1",
  "name-qianwa-short-1",
  "name-qianhe-1",
  "name-wanchuan-1",
  "name-yuanqi-0",
  "name-yuanqi-alone-0",
  "name-yuanbaoshan-0",
  "name-yuanbaoshan-alone-0",
  "name-rmb-centre-0",
  "name-rmb-centre-alone-0",
  "name-dunwei-0",
  "name-dunwei-alone-0",
  "name-qianwa-plants-0",
  "name-yili-one-line-1",
  "name-yuanqi-one-line-0",
  "unit-yuan-0",
  "unit-wanyuan-0",
  "unit-rmb-wan-0",
  "unit-wandun-0",
  "unit-measure-dun-0",
  "unit-output-wandun-0",
  "unit-table-wan-0",
  "markdown-1",
  "markdown-lines-1",
  "word-two-lines-1",
  "word-one-line-1",
  "pdf-two-lines-1",
  "pdf-one-line-1",
  "joined-org-0",
]);
// Right sentences that gain the ✓ and Check against Documents' Supported together, under
// 金额单位：千元 and 所有金额单位：千元, where main read the name's 万 as a second scale:
const COLON_GAINED_BOTH = inBothLanguages(["unit-amount-qian-0", "unit-all-qian-0"]);
// Wrong sentences now caught, and rows that now read as the unit line alone reads them:
const COLON_CHANGED = inBothLanguages([
  "case-0",
  "half-colon-0",
  "half-colons-0",
  "space-after-0",
  "space-before-0",
  "reversed-0",
  "one-line-0",
  "one-line-wide-space-0",
  "one-line-unit-first-0",
  "one-line-glued-0",
  "one-line-date-0",
  "currency-line-0",
  "year-line-0",
  "no-colon-0",
  "label-00-0",
  "label-01-0",
  "label-04-0",
  "label-05-0",
  "label-06-0",
  "label-08-0",
  "label-09-0",
  "label-10-0",
  "name-yili-0",
  "name-yili-alone-0",
  "name-baise-alone-0",
  "name-usd-fund-alone-0",
  "name-usd-fund-alone-1",
  "name-qianwa-alone-0",
  "name-qianwa-short-alone-0",
  "name-qianhe-alone-0",
  "name-wanchuan-0",
  "name-wanchuan-alone-0",
  "name-yuanqi-alone-1",
  "name-yuanbaoshan-alone-1",
  "name-rmb-centre-alone-1",
  "name-dunwei-1",
  "name-dunwei-alone-1",
  "name-qianwa-plants-1",
  "name-yili-one-line-0",
  "unit-yuan-1",
  "unit-amount-qian-1",
  "unit-usd-million-1",
  "unit-measure-dun-1",
  "unit-all-qian-1",
  "markdown-0",
  "markdown-lines-0",
  "word-two-lines-0",
  "word-one-line-0",
  "pdf-two-lines-0",
  "pdf-one-line-0",
]);
// Of those, the wrong sentences main ticks and Check against Documents calls Supported:
const COLON_TAKEN = inBothLanguages([
  "case-0",
  "half-colon-0",
  "half-colons-0",
  "space-after-0",
  "space-before-0",
  "reversed-0",
  "one-line-0",
  "one-line-wide-space-0",
  "one-line-unit-first-0",
  "one-line-glued-0",
  "one-line-date-0",
  "currency-line-0",
  "year-line-0",
  "no-colon-0",
  "label-00-0",
  "label-01-0",
  "label-04-0",
  "label-05-0",
  "label-06-0",
  "label-08-0",
  "label-09-0",
  "label-10-0",
  "name-yili-0",
  "name-usd-fund-alone-0",
  "name-wanchuan-0",
  "name-rmb-centre-alone-1",
  "name-yili-one-line-0",
  "unit-yuan-1",
  "unit-amount-qian-1",
  "unit-usd-million-1",
  "unit-all-qian-1",
  "markdown-0",
  "markdown-lines-0",
  "word-two-lines-0",
  "word-one-line-0",
  "pdf-two-lines-0",
  "pdf-one-line-0",
]);
// A cost: wrong sentences that gain the model's ✓ where the organisation's line is the only line
// that seemed to state a scale. Main read the name's first character as the Document's scale and
// caught them; here the Document states none, and in an Answer the model's verdict stands.
const COLON_COSTS = inBothLanguages([
  "name-yili-alone-2",
  "name-baise-alone-2",
  "name-usd-fund-alone-2",
  "name-qianwa-alone-2",
  "name-qianwa-short-alone-2",
  "name-qianhe-alone-2",
  "name-yuanqi-alone-2",
  "name-yuanbaoshan-alone-2",
  "name-rmb-centre-alone-2",
  "name-qianwa-plants-alone-1",
]);

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
  "tbl-next1-011-en",
  "tbl-next1-011-zh-CN",
  "tbl-next1-016-en",
  "tbl-next1-016-zh-CN",
  "tbl-next1-019-en",
  "tbl-next1-019-zh-CN",
  "tbl-next1-030-en",
  "tbl-next1-030-zh-CN",
  "tbl-next1-034-en",
  "tbl-next1-034-zh-CN",
  "tbl-next1-037-en",
  "tbl-next1-037-zh-CN",
  "tbl-next1-039-en",
  "tbl-next1-039-zh-CN",
  "tbl-gain-01-en",
  "tbl-gain-01-zh-CN",
  ...COLON_GAINED,
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
  "e-row-label-right-other-caption-energy-en",
  "e-row-label-right-other-caption-energy-zh-CN",
  "e-row-label-right-other-caption-percent-en",
  "e-row-label-right-other-caption-percent-zh-CN",
  "tbl-next1-000-en",
  "tbl-next1-000-zh-CN",
  "tbl-next1-001-en",
  "tbl-next1-001-zh-CN",
  "tbl-next1-002-en",
  "tbl-next1-002-zh-CN",
  "tbl-next1-003-en",
  "tbl-next1-003-zh-CN",
  "tbl-next1-004-en",
  "tbl-next1-004-zh-CN",
  "tbl-next1-012-en",
  "tbl-next1-012-zh-CN",
  "tbl-next1-013-en",
  "tbl-next1-013-zh-CN",
  "tbl-next1-014-en",
  "tbl-next1-014-zh-CN",
  "tbl-next1-017-en",
  "tbl-next1-017-zh-CN",
  "tbl-next1-020-en",
  "tbl-next1-020-zh-CN",
  "tbl-next1-022-en",
  "tbl-next1-022-zh-CN",
  "tbl-next1-023-en",
  "tbl-next1-023-zh-CN",
  "tbl-next1-024-en",
  "tbl-next1-024-zh-CN",
  "tbl-next1-025-en",
  "tbl-next1-025-zh-CN",
  "tbl-next1-026-en",
  "tbl-next1-026-zh-CN",
  "tbl-next1-027-en",
  "tbl-next1-027-zh-CN",
  "tbl-next1-028-en",
  "tbl-next1-028-zh-CN",
  "tbl-next1-029-en",
  "tbl-next1-029-zh-CN",
  "tbl-next1-031-en",
  "tbl-next1-031-zh-CN",
  "tbl-next1-032-en",
  "tbl-next1-032-zh-CN",
  "tbl-next1-035-en",
  "tbl-next1-035-zh-CN",
  "tbl-next1-038-en",
  "tbl-next1-038-zh-CN",
  "tbl-next1-040-en",
  "tbl-next1-040-zh-CN",
  "tbl-next1-042-en",
  "tbl-next1-042-zh-CN",
  "tbl-next1-043-en",
  "tbl-next1-043-zh-CN",
  "tbl-next1-045-en",
  "tbl-next1-045-zh-CN",
  "tbl-next1-046-en",
  "tbl-next1-046-zh-CN",
  "tbl-next1-048-en",
  "tbl-next1-048-zh-CN",
  "tbl-next1-049-en",
  "tbl-next1-049-zh-CN",
  "tbl-next1-059-en",
  "tbl-next1-059-zh-CN",
  "tbl-next1-060-en",
  "tbl-next1-060-zh-CN",
  "tbl-next1-063-en",
  "tbl-next1-063-zh-CN",
  "tbl-next1-065-en",
  "tbl-next1-065-zh-CN",
  "tbl-next1-066-en",
  "tbl-next1-066-zh-CN",
  "tbl-next1-068-en",
  "tbl-next1-068-zh-CN",
  "tbl-next1-070-en",
  "tbl-next1-070-zh-CN",
  "tbl-next1-073-en",
  "tbl-next1-073-zh-CN",
  "tbl-next1-075-en",
  "tbl-next1-075-zh-CN",
  "tbl-next1-076-en",
  "tbl-next1-076-zh-CN",
  "tbl-next1-077-en",
  "tbl-next1-077-zh-CN",
  "tbl-next1-078-en",
  "tbl-next1-078-zh-CN",
  "tbl-next1-079-en",
  "tbl-next1-079-zh-CN",
  "tbl-next1-081-en",
  "tbl-next1-081-zh-CN",
  "tbl-next1-083-en",
  "tbl-next1-083-zh-CN",
  "tbl-next1-085-en",
  "tbl-next1-085-zh-CN",
  "tbl-next1-088-en",
  "tbl-next1-088-zh-CN",
  "tbl-next1-089-en",
  "tbl-next1-089-zh-CN",
  "tbl-next1-091-en",
  "tbl-next1-091-zh-CN",
  "tbl-next1-093-en",
  "tbl-next1-093-zh-CN",
  "tbl-next1-097-en",
  "tbl-next1-097-zh-CN",
  "tbl-next1-099-en",
  "tbl-next1-099-zh-CN",
  "tbl-next1-101-en",
  "tbl-next1-101-zh-CN",
  "tbl-next1-102-en",
  "tbl-next1-102-zh-CN",
  "tbl-gain-00-en",
  "tbl-gain-00-zh-CN",
  "tbl-gain-02-en",
  "tbl-gain-02-zh-CN",
  "tbl-mark-00-en",
  "tbl-mark-00-zh-CN",
  "tbl-mark-01-en",
  "tbl-mark-01-zh-CN",
  "tbl-mark-02-en",
  "tbl-mark-02-zh-CN",
  "tbl-mark-03-en",
  "tbl-mark-03-zh-CN",
  "tbl-mark-04-en",
  "tbl-mark-04-zh-CN",
  "tbl-mark-05-en",
  "tbl-mark-05-zh-CN",
  "tbl-line-header-en",
  "tbl-line-header-zh-CN",
  ...COLON_CHANGED,
];

// A cost: wrong sentences that read ✓ or Supported here and not on main, as main already reads them
// under a column's heading, its own label, a heading or a caption, now that a row's label is read as
// those are (#2997): a rate dropped or changed, and a unit the reader doesn't read (厘米, "g", "m").
const COSTS = [
  "tbl-gain-03-en",
  "tbl-gain-03-zh-CN",
  "tbl-gain-04-en",
  "tbl-gain-04-zh-CN",
  "tbl-gain-05-en",
  "tbl-gain-05-zh-CN",
  "tbl-gain-06-en",
  "tbl-gain-06-zh-CN",
  "tbl-gain-07-en",
  "tbl-gain-07-zh-CN",
  "tbl-gain-08-en",
  "tbl-gain-08-zh-CN",
  "tbl-gain-09-en",
  "tbl-gain-09-zh-CN",
  "tbl-gain-10-en",
  "tbl-gain-10-zh-CN",
  ...COLON_COSTS,
];

// A cost: right sentences that lose main's ✓, beside a footnote letter that is a unit's symbol on a
// row's label (#2997). "(t)" and "(W)" now read in tabs as main reads them with bars and spaces;
// "[t]" and "[W]" read so in tabs, bars and spaces alike, square brackets being read as round
// ones are, where main reads all three ✓ and Supported.
const LOSSES = [
  "tbl-mark-10-en",
  "tbl-mark-10-zh-CN",
  "tbl-mark-11-en",
  "tbl-mark-11-zh-CN",
  "tbl-mark-12-en",
  "tbl-mark-12-zh-CN",
  "tbl-mark-13-en",
  "tbl-mark-13-zh-CN",
  "tbl-mark-16-en",
  "tbl-mark-16-zh-CN",
  "tbl-mark-17-en",
  "tbl-mark-17-zh-CN",
  "tbl-mark-18-en",
  "tbl-mark-18-zh-CN",
  "tbl-mark-19-en",
  "tbl-mark-19-zh-CN",
];

// Wrong sentences main ticks and Check against Documents calls Supported, now caught (#2997).
const TAKEN = [
  "tbl-next1-066-en",
  "tbl-next1-066-zh-CN",
  "tbl-next1-068-en",
  "tbl-next1-068-zh-CN",
  "tbl-mark-01-en",
  "tbl-mark-01-zh-CN",
  "tbl-mark-04-en",
  "tbl-mark-04-zh-CN",
  ...COLON_TAKEN,
];

describe("#2997's measured table", () => {
  // protects=the table itself: the rows that read ✓ here and not on main are exactly the listed ones, the right sentences a label, a unit line, a table's row label or units column, prose or the quote's unit in another word now states, and u252, whose dollar the Document states nowhere and the Answer leaves to the model (#2997); a listed row's Check against Documents reading is main's, but for the listed right sentences that gain the ✓ and Supported together (COLON_GAINED_BOTH), which read both here and neither on main; the wrong sentences that read ✓ or Supported here and not on main are exactly the listed COSTS, a cost; the rows that read otherwise in more than that are exactly the listed CHANGED and LOSSES, and every other row reads as on main in both checks; the rows Check against Documents calls Supported on main that lose the Answer's ✓ are exactly the wrong ones now caught (TAKEN) and LOSSES, a cost; and every twin keeps the ✓ it had; fails_when=another row gains a ✓, one of these loses it, any row reads otherwise than main in either check beyond these lists, or a row of the table is changed to say otherwise; no_claim=what the code reads, which the part files run.
  test("gives a ✓ only to the listed sentences, and takes one from a sentence Check against Documents calls Supported only where listed", () => {
    const listed = (ids: readonly string[]) =>
      TABLE.rows.filter((row) => ids.includes(row.id)).map(({ id }) => id);
    expect(
      TABLE.rows
        .filter((row) => shows(row.here) && !shows(row.main) && !COSTS.includes(row.id))
        .map(({ id }) => id),
    ).toEqual(listed([...GAINED, ...COLON_GAINED_BOTH]));
    expect(
      TABLE.rows
        .filter(
          (row) =>
            (shows(row.here) && !shows(row.main)) ||
            (row.here.document.verdict === "supported" &&
              row.main.document.verdict !== "supported"),
        )
        .filter((row) => ![...GAINED, ...COLON_GAINED_BOTH, ...CHANGED].includes(row.id))
        .map(({ id }) => id),
    ).toEqual(COSTS);
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
            ![...GAINED, ...COLON_GAINED_BOTH, ...COSTS, ...LOSSES].includes(row.id) &&
            JSON.stringify(row.here) !== JSON.stringify(row.main),
        )
        .map(({ id }) => id),
    ).toEqual(CHANGED);
    expect(
      TABLE.rows
        .filter(
          (row) =>
            COLON_GAINED_BOTH.includes(row.id) &&
            !(
              shows(row.here) &&
              row.here.document.verdict === "supported" &&
              !shows(row.main) &&
              row.main.document.verdict !== "supported"
            ),
        )
        .map(({ id }) => id),
    ).toEqual([]);
    expect(
      TABLE.rows
        .filter(
          (row) => shows(row.main) && row.main.document.verdict === "supported" && !shows(row.here),
        )
        .map(({ id }) => id),
    ).toEqual(listed([...TAKEN, ...LOSSES]));
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
