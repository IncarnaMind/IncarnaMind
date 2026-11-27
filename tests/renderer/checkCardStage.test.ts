/**
 * The check card's first line (#3840): where the Note's check stands, said once. Not checked yet
 * before the Note's first whole check; Checking with how far it has got; Check done and when;
 * All supported and when, only with nothing left. The rows the head, its line or its foot already
 * count are not drawn again.
 */
import { describe, expect, test } from "vitest";
import type { MindCheckRun } from "../../src/core/api";
import {
  cardHeadWords,
  cardStageOf,
  rowShownAt,
  wholeCheckStands,
} from "../../src/renderer/src/editor/checkCardStage";
import type { NoteHealth } from "../../src/renderer/src/editor/healthCounts";
import { noteStateOf } from "../../src/renderer/src/noteState";
import { formatDateTime } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";

const CHECKED_AT = "2026-11-02T21:00:00.000Z";
const RUN_AT = "2026-11-02T21:04:00.000Z";

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

const run = (over: Partial<MindCheckRun> = {}): MindCheckRun => ({
  at: RUN_AT,
  sentences: 6,
  stop: null,
  skipped: [],
  unexamined: [],
  ...over,
});

function stageOf(
  note: NoteHealth,
  last: MindCheckRun | null,
  progress: { words: string; done: number; total: number } | null = null,
) {
  const state = noteStateOf(note, 0);
  return cardStageOf({
    progress,
    state,
    wholeCheck: wholeCheckStands(last, note),
    health: note,
    problem: false,
  });
}

const WAITING = health({ checkable: 3, toCheck: [1, 5, 9] });
const CLEAN = health({ checkable: 3, supported: 3, supportedAt: [1, 5, 9], checkedAt: CHECKED_AT });
const LOOK = health({
  checkable: 3,
  supported: 2,
  supportedAt: [1, 5],
  unsupported: [9],
  lookClaims: [9],
  checkedAt: CHECKED_AT,
});

describe("where the card says the Note's check stands", () => {
  // protects=#3840: a whole check speaks for the Note only when one ran to its end, a result still holds and the model decided every sentence it read; one stopped by a cost cap or a plan limit, one that left a sentence undecided (#1682), or none, does not; fails_when=a stopped run keeps the verdict, an undecided sentence stops waiting for the Note's Check, or a Note never checked reads done
  test("a whole check stands only when it ran to its end and decided every sentence", () => {
    expect(wholeCheckStands(run(), CLEAN)).toBe(true);
    expect(wholeCheckStands(run({ stop: { reason: "cost-cap" } }), CLEAN)).toBe(false);
    expect(wholeCheckStands(null, CLEAN)).toBe(false);
    expect(wholeCheckStands(run(), WAITING)).toBe(false);
    const undecided = health({ ...CLEAN, toCheck: [12], unexamined: [12] });
    expect(wholeCheckStands(run({ unexamined: ["sentence"] }), undecided)).toBe(false);
  });

  // protects=#3840: before any check the card says Not checked yet and counts the sentences on its line, with no row repeating them; fails_when=the head says done, or the not-checked row counts them a second time
  test("before any check: Not checked yet, counted on the line, not in a row", () => {
    const stage = stageOf(WAITING, null);
    expect(stage).toEqual({ kind: "not-checked", sentences: 3, inRow: false });
    if (stage === null) throw new Error("No stage.");
    expect(rowShownAt(stage, "toCheck")).toBe(false);
    expect(cardHeadWords(stage, (key) => translate("en", key), "en")).toEqual({
      words: "Not checked yet",
      aside: null,
    });
  });

  // protects=#3840: a check stopped part-way, or results with no whole check, keep Not checked yet, and the sentences still waiting stay a row a click moves to beside the results so far; fails_when=the waiting row goes, or the head reads done before a whole check
  test("results so far with sentences waiting: Not checked yet, and the waiting row stays", () => {
    const partial = health({
      checkable: 3,
      supported: 1,
      supportedAt: [1],
      toCheck: [5, 9],
      checkedAt: CHECKED_AT,
    });
    for (const last of [null, run({ stop: { reason: "cost-cap" } })]) {
      const stage = stageOf(partial, last);
      expect(stage).toEqual({ kind: "not-checked", sentences: 2, inRow: true });
      expect(rowShownAt(stage, "toCheck")).toBe(true);
      expect(rowShownAt(stage, "supported")).toBe(true);
    }
  });

  // protects=#3840: a run going says Checking and how far it has got at the head's end, and no row counts what is being checked or waiting; one not counted yet says only its own words; fails_when=a row repeats the head's count, or a count shows before it is known
  test("a run going: Checking and its count at the head, no row repeating it", () => {
    const counted = stageOf(WAITING, null, { words: "Checking this Note…", done: 3, total: 12 });
    if (counted === null) throw new Error("No stage.");
    expect(cardHeadWords(counted, (key, params) => translate("en", key, params), "en")).toEqual({
      words: "Checking…",
      aside: "3 of 12",
    });
    expect(
      cardHeadWords(counted, (key, params) => translate("zh-CN", key, params), "zh-CN"),
    ).toEqual({ words: "正在核对…", aside: "3/12" });
    expect(rowShownAt(counted, "checking")).toBe(false);
    expect(rowShownAt(counted, "toCheck")).toBe(false);
    expect(rowShownAt(counted, "supported")).toBe(true);

    const uncounted = stageOf(WAITING, null, {
      words: "Checking in your own AI.",
      done: 0,
      total: 0,
    });
    if (uncounted === null) throw new Error("No stage.");
    expect(cardHeadWords(uncounted, (key) => translate("en", key), "en")).toEqual({
      words: "Checking in your own AI.",
      aside: null,
    });
  });

  // protects=#3840: once done with something to look at, the head says Check done and when the newest check ended, as Home and the Saved line say it, with no other count; fails_when=the head counts what needs a look, or gives a time the Note's other places don't
  test.each(["en", "zh-CN"] as const)(
    "done with things to look at: Check done and when (%s)",
    (language) => {
      const stage = stageOf(LOOK, run());
      expect(stage).toEqual({ kind: "done", at: CHECKED_AT });
      if (stage === null) throw new Error("No stage.");
      expect(cardHeadWords(stage, (key) => translate(language, key), language)).toEqual({
        words: translate(language, "checks.head.done"),
        aside: formatDateTime(CHECKED_AT, language),
      });
    },
  );

  // protects=#3840: a Note all supported says All supported and when, once, and no row says the same count again; fails_when=a supported row repeats the line's count, or All supported shows over anything left
  test("all supported: All supported and when, and no supported row", () => {
    const stage = stageOf(CLEAN, run());
    expect(stage).toEqual({ kind: "clean", at: CHECKED_AT, sentences: 3 });
    if (stage === null) throw new Error("No stage.");
    expect(rowShownAt(stage, "supported")).toBe(false);
    expect(rowShownAt(stage, "notYetCited")).toBe(true);
    expect(cardHeadWords(stage, (key) => translate("en", key), "en").words).toBe("All supported");
  });

  // protects=#3840: a sentence a check is reading with no run of the Note's counted here, as one from another device, has the head say Checking with no count and no row repeating it; fails_when=the head says done over a sentence being checked, or a row counts it
  test("a sentence being checked with no run here: Checking, with no count", () => {
    const stage = stageOf(health({ ...CLEAN, checking: [9] }), run());
    expect(stage).toEqual({ kind: "checking", words: null, done: 0, total: 0 });
    if (stage === null) throw new Error("No stage.");
    expect(cardHeadWords(stage, (key) => translate("en", key), "en")).toEqual({
      words: "Checking…",
      aside: null,
    });
    expect(rowShownAt(stage, "checking")).toBe(false);
  });

  // protects=#3840: after a whole check, a sentence edited or added since keeps the card done, never Not checked yet, and leaves All supported off; its count goes to the foot's Check N new, not a row; fails_when=the card goes back to Not checked yet over one edit, still says All supported, or counts the edit twice
  test("a sentence edited after a whole check: Check done, the count left to the foot", () => {
    const edited = health({
      checkable: 3,
      supported: 2,
      supportedAt: [1, 5],
      toCheck: [9],
      checkedAt: CHECKED_AT,
    });
    const stage = stageOf(edited, run());
    expect(stage).toEqual({ kind: "done", at: CHECKED_AT });
    expect(rowShownAt(stage, "toCheck")).toBe(false);
  });
});
