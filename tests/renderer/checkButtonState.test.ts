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
 * wait, one press checking; how far a run has got; then what the check found. Its words come from
 * the interface's own strings, in English and Chinese alike.
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

    // protects=#3794: sentences waiting keep the button the one-press Check, so the next check is never two presses, while what needs a look stays in its tooltip; fails_when=what needs a look hides the Check
    test("sentences waiting beside what needs a look: still Check", () => {
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
      expect(view?.title).toContain(words.look);
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
