/**
 * How one Note's check state reads in the five places that say it, in English and Chinese
 * (#3212): the badge, the check card (its head and its rows), Home's row, the Export menu's line
 * and the Saved line. A Note that reads Checked with a caveat says the badge's line in the card's
 * head; a Note whose Citation's quote is found but whose sentence nobody checked says how many
 * sentences wait; a table with two columns not recalculated counts both, in the badge and in the
 * card.
 */
import { describe, expect, test } from "vitest";
import {
  checkRows,
  healthSummary,
  type NoteHealth,
} from "../../src/renderer/src/editor/healthCounts";
import {
  cardHead,
  exportStateLine,
  noteStateOf,
  noteStateParts,
  nothingLeft,
} from "../../src/renderer/src/noteState";
import { formatDateTime } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";

const CHECKED_AT = "2026-10-20T14:25:00.000Z";
const NOW = new Date("2026-10-21T09:00:00.000Z");

const health = (parts: Partial<NoteHealth>): NoteHealth => ({
  found: [],
  notFound: [],
  lookClaims: [],
  lookNotFound: [],
  unsupported: [],
  contradicted: [],
  toCheck: [],
  failed: [],
  uncheckable: [],
  notRecalculated: [],
  recheck: [],
  edited: [],
  checking: [],
  kept: [],
  keptCharts: [],
  tableCells: [],
  noCitation: [],
  ownNotes: [],
  supportedAt: [],
  notYetCited: [],
  citable: [],
  ownViews: [],
  checkable: 0,
  supported: 0,
  checkedAt: null,
  unexamined: [],
  ...parts,
});

/** Each place's words for one Note, as the app reads them. */
function places(language: "en" | "zh-CN", note: NoteHealth, unread: number) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const state = noteStateOf(note, unread);
  if (state === null) throw new Error("No state.");
  const summary = healthSummary(note, { running: false, problem: false, unread: 0 });
  return {
    t,
    badge: noteStateParts(state, t, language, NOW),
    home: noteStateParts(state, t, language, NOW).join(" · "),
    saved: nothingLeft(state) ? [] : noteStateParts(state, t, language, NOW),
    exportLine: exportStateLine(state, note.toCheck.length, t, language),
    head: summary?.kind === "all" ? cardHead(state, t, language) : null,
    rows: checkRows(note).map(({ row, places }) => [row, places.length] as const),
    time: formatDateTime(CHECKED_AT, language, { now: NOW }),
  };
}

describe.each(["en", "zh-CN"] as const)(
  "One Note's check state in five places (%s)",
  (language) => {
    // protects=a Note that reads Checked and names a caveat never has its card's head say "Everything checked"; the head says Checked and its time, and leaves the unread files to the card's own line, so they are said once (#3212, #3756); the Export menu says nothing for it, as for any Checked Note; fails_when=the head says Everything checked over a caveat the badge names, or counts the unread files a second time
    test("a caveat under Checked: the card's head says Checked and its time, the Export menu says nothing", () => {
      const seen = places(
        language,
        health({ checkable: 3, supported: 3, supportedAt: [1, 5, 9], checkedAt: CHECKED_AT }),
        3,
      );
      const caveat = seen.t("unread.count", { count: "3" });
      const checked = seen.t("health.state.checked", { time: seen.time });

      expect(seen.badge).toEqual([checked, caveat]);
      expect(seen.home).toBe(`${checked} · ${caveat}`);
      expect(seen.head).toBe(checked);
      expect(seen.head).not.toBe(seen.t("health.allChecked"));
      expect(seen.exportLine).toBeNull();
      expect(seen.saved).toEqual([checked, caveat]);
    });

    test("with no caveat, the card's head stays Everything checked", () => {
      const seen = places(
        language,
        health({ checkable: 3, supported: 3, supportedAt: [1, 5, 9], checkedAt: CHECKED_AT }),
        0,
      );
      expect(seen.badge).toEqual([seen.t("health.state.checked", { time: seen.time })]);
      expect(seen.head).toBe(seen.t("health.allChecked"));
    });

    // protects=a hand-added Citation whose quote is found beside a sentence nobody checked reads as sentences waiting, in every place that says the state, never a bare "Not checked" (#3212); fails_when=a place says the bare words where there is a count
    test("a found quote beside an unchecked sentence: the sentences waiting, counted", () => {
      const one = places(language, health({ checkable: 1, toCheck: [0] }), 0);
      const waiting = one.t("health.toCheck.one", { count: "1" });
      expect(one.badge).toEqual([waiting]);
      expect(one.home).toBe(waiting);
      expect(one.saved).toEqual([waiting]);
      expect(one.exportLine?.label).toBe(`${waiting} · ${one.t("export.checkFirstAction")}`);
      expect(one.exportLine?.action).toBe("check");
      expect(one.rows).toEqual([["toCheck", 1]]);

      const three = places(language, health({ checkable: 3, toCheck: [0, 4, 8] }), 0);
      const many = three.t("health.toCheck", { count: "3" });
      expect(three.badge).toEqual([many]);
      expect(three.rows).toEqual([["toCheck", 3]]);

      // Nothing to count while a check runs: the bare words stay.
      const running = places(language, health({ checkable: 1, checking: [0] }), 0);
      expect(running.badge).toEqual([running.t("health.state.notChecked")]);
    });

    // protects=a table with two columns not recalculated is two figures in the badge and two in the card's rows, as its own card lists them (#3212); fails_when=the card counts the table once beside a badge that counts two
    test("a table with two columns not recalculated: counted per column in the badge and the card", () => {
      const seen = places(
        language,
        health({
          checkable: 1,
          toCheck: [4, 4],
          failed: [4, 4],
          notRecalculated: [4, 4],
        }),
        0,
      );
      expect(seen.badge).toEqual([seen.t("health.state.notRecalculated", { count: "2" })]);
      expect(seen.rows).toEqual([["cantCheck", 2]]);
    });
  },
);
