import { describe, expect, test } from "vitest";
import {
  type CheckButtonInput,
  checkButtonOf,
  verifyButtonOf,
} from "../../src/renderer/src/editor/checkButtonState";
import type { NoteState } from "../../src/renderer/src/noteState";
import { translate } from "../../src/shared/i18n";

/*
 * The Note's Check button (#3794): the word Check and the sentences not checked yet while any
 * wait for the Note's first whole check, one press checking; how far a run has got; then what the
 * check found, which sentences added or edited after a whole check never take away (#3840). Its
 * words come from the interface's own strings, in English and Chinese alike.
 */

const NOT_CHECKED: NoteState = {
  kind: "not-checked",
  look: 0,
  tone: "neutral",
  mark: "notChecked",
  checkedAt: null,
  unread: 0,
  unreadMatters: false,
  checkable: 2,
  cantCheck: 0,
  notRecalculated: 0,
  needsCheck: 0,
  notYetCited: 0,
  canBeCited: 0,
  toCheck: 2,
  notChecked: 2,
};

const input = (over: Partial<CheckButtonInput> = {}): CheckButtonInput => ({
  state: NOT_CHECKED,
  running: null,
  asked: null,
  waiting: false,
  justChecked: false,
  wholeCheck: false,
  ...over,
});

for (const language of ["en", "zh-CN"] as const) {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  const words = {
    en: { check: "Check", look: "2 need a look", checked: "Checked", running: "Checking… 1 of 2" },
    "zh-CN": {
      check: "核对",
      look: "需要留意 2 处",
      checked: "已核对",
      running: "正在核对 1/2…",
    },
  }[language];

  describe(`the Note's Check button (${language})`, () => {
    // protects=#3794: a Note with sentences not checked yet shows Check and their number, the press that checks; fails_when=it shows a mark with no word, or counts what needs a look as not checked
    test("sentences not checked yet: Check and their number", () => {
      const view = checkButtonOf(input(), t, language);
      expect(view).toMatchObject({ kind: "check", words: words.check, count: "2" });
    });

    // protects=#3794: while a check runs it says how far it has got, "Checking… 1 of 2"; fails_when=the count is missing once known, or the run reads as Check
    test("a run says how far it has got", () => {
      const view = checkButtonOf(input({ running: { words: "", done: 1, total: 2 } }), t, language);
      expect(view).toMatchObject({ kind: "checking", words: words.running, fresh: true });
      expect(
        checkButtonOf(input({ running: { words: "", done: 0, total: 0 } }), t, language)?.words,
      ).toBe(language === "en" ? "Checking…" : "正在核对…");
    });

    // protects=#3765: the button carries the words a run would say at their widest, from the sentences a run could cover, so the tab strip counts its room before a press; fails_when=the widest words are missing, or count fewer sentences than the Note has
    test("carries its running words at their widest, whatever it shows now", () => {
      const widest = language === "en" ? "Checking… 2 of 2" : "正在核对 2/2…";
      expect(checkButtonOf(input(), t, language)?.widest).toBe(widest);
      const checked = { ...NOT_CHECKED, kind: "checked" as const, toCheck: 0, notChecked: 0 };
      expect(checkButtonOf(input({ state: checked }), t, language)?.widest).toBe(widest);
      const many = { ...NOT_CHECKED, checkable: 120 };
      expect(checkButtonOf(input({ state: many }), t, language)?.widest).toBe(
        language === "en" ? "Checking… 120 of 120" : "正在核对 120/120…",
      );
      // A run that counts more than the Note shows still reserves its own count; none counted, the plain words.
      const longer = checkButtonOf(
        input({ running: { words: "", done: 1, total: 150 } }),
        t,
        language,
      );
      expect(longer?.widest).toBe(language === "en" ? "Checking… 150 of 150" : "正在核对 150/150…");
      expect(
        checkButtonOf(
          input({ state: null, running: { words: "", done: 0, total: 0 } }),
          t,
          language,
        )?.widest,
      ).toBe(language === "en" ? "Checking…" : "正在核对…");
    });

    // protects=#3794: what needs a look is said in words with its count, and opens the card; fails_when=it reads Checked, or loses its count in the tight row
    test("what needs a look, with its count kept for a tight row", () => {
      const view = checkButtonOf(
        input({
          state: {
            ...NOT_CHECKED,
            kind: "needs-look",
            look: 2,
            tone: "warning",
            mark: "unsupported",
            toCheck: 0,
            notChecked: 0,
          },
        }),
        t,
        language,
      );
      expect(view).toMatchObject({ kind: "look", words: words.look, short: "2", tone: "warning" });
    });

    // protects=#3794: a Note whose every sentence is checked reads Checked, quietly; fails_when=it reads Check with nothing to check
    test("every sentence checked: Checked", () => {
      const view = checkButtonOf(
        input({
          state: {
            ...NOT_CHECKED,
            kind: "checked",
            tone: "success",
            mark: "checked",
            toCheck: 0,
            notChecked: 0,
          },
        }),
        t,
        language,
      );
      expect(view).toMatchObject({
        kind: "checked",
        words: words.checked,
        count: null,
        mark: "checked",
        tone: "success",
      });
    });

    // protects=#2313: a checked Note with a sentence a check can't settle never rests on the ✓, and its tooltip names what is left; fails_when=the button shows the green ✓ beside an unsettled sentence
    test("checked with a sentence a check can't settle: no ✓", () => {
      const view = checkButtonOf(
        input({
          state: {
            ...NOT_CHECKED,
            kind: "checked",
            tone: "success",
            mark: "checked",
            checkedAt: "2026-10-22T09:00:00.000Z",
            cantCheck: 1,
            toCheck: 1,
            notChecked: 0,
          },
        }),
        t,
        language,
      );
      expect(view).toMatchObject({ kind: "checked", mark: "notChecked", tone: "neutral" });
      expect(view?.title).toContain(
        translate(language, "health.state.cantCheck.one", { count: "1" }),
      );
    });

    // protects=#3794: before any whole check, sentences waiting keep the button the one-press Check, so the first check is never two presses, while what needs a look stays in its tooltip; fails_when=what needs a look hides the Check
    test("before a whole check, sentences waiting beside what needs a look: still Check", () => {
      const view = checkButtonOf(
        input({
          state: {
            ...NOT_CHECKED,
            kind: "needs-look",
            look: 2,
            tone: "warning",
            mark: "unsupported",
            toCheck: 1,
            notChecked: 1,
          },
        }),
        t,
        language,
      );
      expect(view).toMatchObject({ kind: "check", count: "1" });
      expect(view?.title).toBe(
        `${translate(language, "health.toCheck.one", { count: "1" })} · ${words.look}`,
      );
    });

    // protects=#3840: once a whole check has run, a sentence edited or added since leaves its verdict on the button, never the filled Check; the tooltip names what waits; fails_when=the button turns back into Check N over what needs a look
    test("after a whole check, sentences edited or added keep what needs a look", () => {
      const view = checkButtonOf(
        input({
          wholeCheck: true,
          state: {
            ...NOT_CHECKED,
            kind: "needs-look",
            look: 2,
            tone: "warning",
            mark: "unsupported",
            toCheck: 1,
            notChecked: 1,
          },
        }),
        t,
        language,
      );
      expect(view).toMatchObject({ kind: "look", words: words.look, count: null, tone: "warning" });
      expect(view?.title).toContain(
        translate(language, "checks.row.notChecked.one", { count: "1" }),
      );
    });

    // protects=#3840: a Note all supported by a whole check, with one sentence added or edited since, reads Checked without the ✓, never the filled Check; fails_when=it reads Check 1, or keeps the green ✓ over a sentence no check has read
    test("after a whole check, a sentence added or edited to a clean Note: Checked, no ✓", () => {
      for (const state of [
        { ...NOT_CHECKED, toCheck: 1, notChecked: 1 },
        {
          ...NOT_CHECKED,
          kind: "checked" as const,
          tone: "success" as const,
          mark: "checked" as const,
          needsCheck: 1,
          toCheck: 1,
          notChecked: 1,
        },
      ]) {
        const view = checkButtonOf(input({ wholeCheck: true, state }), t, language);
        expect(view).toMatchObject({
          kind: "checked",
          words: words.checked,
          count: null,
          tone: "neutral",
          mark: "notChecked",
        });
      }
    });

    // protects=#3840: the button and its tooltip never say the check's time or the sentences that can be cited, which the card says once; a Note left only with sentences to cite reads Checked with the margin's ring and "+"; fails_when=the tooltip repeats the time or the can-be-cited count, or the button's words are the can-be-cited count
    test("no time and no can-be-cited count on the button or its tooltip", () => {
      const canBeCited = translate(language, "health.state.canBeCited", { count: "2" });
      const clean = checkButtonOf(
        input({
          state: {
            ...NOT_CHECKED,
            kind: "checked",
            tone: "success",
            mark: "checked",
            checkedAt: "2026-10-22T09:00:00.000Z",
            canBeCited: 2,
            toCheck: 0,
            notChecked: 0,
          },
        }),
        t,
        language,
      );
      expect(clean).toMatchObject({ kind: "checked", title: words.checked, tone: "success" });

      const toCite = checkButtonOf(
        input({
          wholeCheck: true,
          state: {
            ...NOT_CHECKED,
            kind: "not-yet-cited",
            mark: "notYetCited",
            checkedAt: "2026-10-22T09:00:00.000Z",
            notYetCited: 2,
            canBeCited: 2,
            toCheck: 0,
            notChecked: 0,
          },
        }),
        t,
        language,
      );
      expect(toCite).toMatchObject({
        kind: "checked",
        words: words.checked,
        title: words.checked,
        tone: "neutral",
        mark: "notYetCited",
      });

      const look = checkButtonOf(
        input({
          state: {
            ...NOT_CHECKED,
            kind: "needs-look",
            look: 2,
            tone: "warning",
            mark: "unsupported",
            checkedAt: "2026-10-22T09:00:00.000Z",
            canBeCited: 2,
            toCheck: 0,
            notChecked: 0,
          },
        }),
        t,
        language,
      );
      expect(look?.title).toBe(words.look);
      expect(look?.title).not.toContain(canBeCited);
    });

    // protects=#3794: a Note with no sentence a check is for shows no button; fails_when=a Note with nothing to check reads Check
    test("nothing to check: no button", () => {
      expect(checkButtonOf(input({ state: null }), t, language)).toBeNull();
    });

    // protects=#3794: on a Note made from someone else's file, the claims found and not yet checked are its Check's number; fails_when=the claims found read as nothing to check
    test("someone else's file: the claims to check", () => {
      const view = verifyButtonOf(
        { ...input(), toCheck: 24, marked: 0, look: 0, notChecked: 0 },
        t,
        language,
      );
      expect(view).toMatchObject({ kind: "check", words: words.check, count: "24" });
      const found = verifyButtonOf(
        { ...input(), toCheck: 0, marked: 24, look: 2, notChecked: 0 },
        t,
        language,
      );
      expect(found).toMatchObject({ kind: "look", short: "2" });
    });
  });
}
