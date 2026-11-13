/**
 * The count of the app's own matches under a list number (#3059), from made-up citing records: the
 * Answer's sentence the app matched by itself and its Document's line, each starting with a list
 * number in a form the citing step's readers see, or one of them with a mark and a number after it.
 */
import { describe, expect, test } from "vitest";
import { citingLines, countCiting } from "../../eval/lib/citingCount";
import type { CitingRecord } from "../../eval/lib/citingRecord";
import type { Language } from "../../src/core/language";

const LEASE = "Lease for Harbor Bakery.md";

const SAID: Record<Language, { notice: string; phone: string; deposit: string }> = {
  en: {
    notice: "The tenant must give 30 days' notice before leaving.",
    phone: "10 5550 1234 is the number of Harbor Bakery's office.",
    deposit: "2.5 thousand euros is the deposit for the bakery.",
  },
  "zh-CN": {
    notice: "承租人须提前三十天书面通知出租人。",
    phone: "10 5550 1234 是海港面包房办公室的电话。",
    deposit: "2.5 千欧元是面包房的押金。",
  },
};

type Citation = CitingRecord["citations"][number];

/** An Answer whose sentence `answer` took a Citation of the Document's line `line`, quoting `quote`. */
function matched(
  answer: string,
  line: string,
  quote: string,
  citation: Partial<Citation> = {},
): CitingRecord {
  return {
    written: [`What the lease says:\n${answer} [^1]`],
    passages: [
      {
        id: "lease-1",
        document: LEASE,
        location: null,
        text: `Ending the lease\n${line}\nRent is due on the first of the month.`,
      },
    ],
    records: [],
    unrecorded: [1],
    asked: null,
    citations: [
      {
        marker: 1,
        document: LEASE,
        quote,
        from: "app-marked",
        check: "found",
        checkReason: null,
        judged: true,
        ...citation,
      },
    ],
  };
}

const countsOf = (records: readonly CitingRecord[], language: Language) =>
  countCiting(records.map((citing) => ({ model: "anthropic/claude-haiku-5-5", language, citing })));

/** How one record is counted: under a differing list number, with a mark on one side only. */
function counted(record: CitingRecord, language: Language): [number, number] {
  const numbers = countsOf([record], language)[0]?.listNumbers;
  return [numbers?.differing.citations ?? -1, numbers?.oneSided.citations ?? -1];
}

/** The forms of a list's number the citing step's two readers see, as each writes number `n`. */
const FORMS: [string, (n: number) => string][] = [
  ['"N. "', (n) => `${n}. `],
  ['"- N. "', (n) => `- ${n}. `],
  ['"N." with no space', (n) => `${n}.`],
  ['"N．"', (n) => `${n}．`],
  ['"**N.** "', (n) => `**${n}.** `],
  ['"**N.**"', (n) => `**${n}.**`],
];

for (const language of ["en", "zh-CN"] as const) {
  const { notice, phone, deposit } = SAID[language];

  describe(`The app's matches under a list number, ${language} (#3059)`, () => {
    // protects=an app match whose Document line starts with a list number in any form the Document's reader cuts off, under an Answer's sentence starting with another, is counted as differing, and one under the same number isn't; fails_when=a form goes unseen, or the same number is counted; no_claim=whether such a match is wrong, which the counts on real runs decide.
    test.each(FORMS)("the Document's line written %s", (_form, written) => {
      expect(counted(matched(`3. ${notice}`, `${written(2)}${notice}`, notice), language)).toEqual([
        1, 0,
      ]);
      expect(counted(matched(`2. ${notice}`, `${written(2)}${notice}`, notice), language)).toEqual([
        0, 0,
      ]);
    });

    // protects=the same, the Answer's sentence written in each form and its Document's line "2. ": plain forms included ("3. " against "2. "); fails_when=a form of the Answer's goes unseen, or the same number is counted; no_claim=the Answer's reader, which cuts only "3. " and "- 3. ".
    test.each(FORMS)("the Answer's sentence written %s", (_form, written) => {
      expect(counted(matched(`${written(3)}${notice}`, `2. ${notice}`, notice), language)).toEqual([
        1, 0,
      ]);
      expect(counted(matched(`${written(2)}${notice}`, `2. ${notice}`, notice), language)).toEqual([
        0, 0,
      ]);
    });

    // protects=a bracketed number, which both readers keep, is a list number to the count too; fails_when=it goes unseen beside a dotted one; no_claim=the rule, which stops such a match where both numbers stay.
    test("a bracketed number against a dotted one", () => {
      expect(counted(matched(`(3) ${notice}`, `2. ${notice}`, notice), language)).toEqual([1, 0]);
      expect(counted(matched(`(2) ${notice}`, `2. ${notice}`, notice), language)).toEqual([0, 0]);
    });

    // protects=a mark that starts one side only, a number after it, is counted both ways round ("(86) 10 5550 1234…" against a line with no code); a mark with words after it, or no mark, isn't; fails_when=either way round goes unseen, or a list item's plain words are counted; no_claim=whether the number after the mark is the sentence's own.
    test("a mark on one side only, a number after it", () => {
      expect(counted(matched(`(86) ${phone}`, phone, phone), language)).toEqual([0, 1]);
      expect(counted(matched(phone, `(86) ${phone}`, phone), language)).toEqual([0, 1]);
      expect(counted(matched(`2. ${notice}`, notice, notice), language)).toEqual([0, 0]);
      expect(counted(matched(notice, `2. ${notice}`, notice), language)).toEqual([0, 0]);
      expect(counted(matched(phone, phone, phone), language)).toEqual([0, 0]);
    });

    // protects=a figure that starts a line ("2.5 thousand…") is no list number: a mark before it on one side is, with a number after it; fails_when="2.5" reads as list number 2; no_claim=figures elsewhere in the sentence.
    test("a figure at a line's start is no list number", () => {
      expect(counted(matched(deposit, `3. ${deposit}`, deposit), language)).toEqual([0, 1]);
      expect(counted(matched(deposit, deposit, deposit), language)).toEqual([0, 0]);
    });

    // protects=only the app's own matches on a marked sentence are counted, not a Citation the model recorded or the request gave under the same numbers; fails_when=another origin's Citation is counted; no_claim=those origins' own counts, which the script gives by origin.
    test("only the app's own matches on a marked sentence", () => {
      const differing = (from: Citation["from"]) =>
        counted(matched(`3. ${notice}`, `2. ${notice}`, notice, { from }), language);
      expect(differing("app-marked")).toEqual([1, 0]);
      expect(differing("model")).toEqual([0, 0]);
      expect(differing("request")).toEqual([0, 0]);
      expect(differing("app-unmarked")).toEqual([0, 0]);
    });

    // protects=a match whose sentence or line the record doesn't hold is counted as unplaced, not as either kind; fails_when=it is counted under a number, or dropped unseen; no_claim=why the record lacks it.
    test("a match the record can't place", () => {
      const unplaced = (quote: string) =>
        countsOf([matched(`3. ${notice}`, `2. ${notice}`, quote)], language)[0]?.listNumbers
          .unplaced;
      expect(unplaced(notice)).toBe(0);
      expect(unplaced(phone)).toBe(1);
    });

    // protects=for each match counted, whether the Answer's own check judged its sentence and passed it, as the script tallies each origin; and the lines it prints hold numbers only, never a sentence; fails_when=the check's verdicts are lost, or a sentence or quote reaches the output; no_claim=the check itself.
    test("each counted match's check, and numbers only in the output", () => {
      const counts = countsOf(
        [
          matched(`3. ${notice}`, `2. ${notice}`, notice),
          matched(`4. ${notice}`, `2. ${notice}`, notice, { check: "unsupported" }),
          matched(`5. ${notice}`, `2. ${notice}`, notice, { judged: false }),
          matched(`(86) ${phone}`, phone, phone),
          matched(`2. ${notice}`, `2. ${notice}`, notice),
        ],
        language,
      );
      expect(counts.map((group) => group.listNumbers)).toEqual([
        {
          differing: { citations: 3, judged: 2, passed: 1 },
          oneSided: { citations: 1, judged: 1, passed: 1 },
          unplaced: 0,
        },
      ]);
      const printed = citingLines(counts).join("\n");
      expect(printed).toContain(
        "app-marked under a list number that differs from its Document line's: 3, 2 judged, 1 passed",
      );
      expect(printed).toContain(
        "app-marked with a list number on one side only, a number after it: 1, 1 judged, 1 passed",
      );
      for (const words of [notice, phone, "5550", "tenant", "承租人", "Harbor"]) {
        expect(printed).not.toContain(words);
      }
    });
  });
}
