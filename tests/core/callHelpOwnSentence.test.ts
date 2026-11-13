/**
 * Call help gives what it cites in a sentence of its own, and the User's own advice, conclusion or
 * "no" in another with no Citation (#2847): the sentence check can pass a sentence only when its
 * quotes say all of it, so the part they can't say is never in the sentence it reads.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { meetingHelpInstructions } from "../../src/core/answers/meetingHelp";
import { citedSentences } from "../../src/shared/citedSentences";
import { HELP_SHAPE, type MeetingHelpKind, plainLine } from "../../src/shared/meetingHelp";
import { sentenceSpans } from "../../src/shared/sentences";

const KINDS = Object.keys(HELP_SHAPE) as MeetingHelpKind[];
// The rule as frozen after the development trial (#2847): its gate measures these words alone.
const RULE =
  'What the Documents or the call say goes in a sentence of its own, its Citation markers at that sentence\'s end. Every fact in that sentence is in the words it cites: a second fact gets a Citation of its own, to the words that state it. What is the User\'s own (advice, a conclusion, a "no", an offer or a plan the Documents don\'t state) goes in another sentence with no Citation marker: it cites neither the question it answers nor the rule it rests on, and that rule is a cited sentence of its own. End the cited sentence with "." or "。" before the User\'s own part: joined by anything else (", so", ", but", "，", a dash, a semicolon) it is still the cited sentence. A "→" line never has a Citation marker.';

/** The example lines a button's instructions give, between "For example:" and the next rule. */
function examples(kind: MeetingHelpKind, callLanguage: string): string[] {
  const text = meetingHelpInstructions(kind, { found: true, language: "en", callLanguage });
  const from = text.indexOf("For example:\n") + "For example:\n".length;
  return text.slice(from, text.indexOf("\n- Base it on", from)).split("\n");
}

describe("an option, and a short line, gives what it cites in a sentence of its own", () => {
  // protects=every button whose reply cites in options or short lines is told to give the cited fact a sentence of its own and the User's own part another with no Citation, and its examples do so in both languages; a reading, which cites its moment on a line of its own, is not; fails_when=a button's instructions or examples join a cited fact to an own part again; no_claim=how often a model writes it so, which the gate on fresh presses measures.
  test.each(KINDS)("the %s button", (kind) => {
    for (const callLanguage of ["English", "Chinese"]) {
      const text = meetingHelpInstructions(kind, { found: true, language: "en", callLanguage });
      expect(text.includes(RULE)).toBe(HELP_SHAPE[kind] !== "readings");
    }
  });

  test.each([
    { shape: "options", kind: "answer" as const },
    { shape: "lines", kind: "sum" as const },
  ])(
    "the $shape examples: a cited sentence and an own one, apart, in both languages",
    ({ kind }) => {
      for (const callLanguage of ["English", "Chinese"]) {
        const cited = examples(kind, callLanguage).filter((line) => line.includes("[^"));
        expect(cited.length).toBeGreaterThan(0);
        for (const line of cited) {
          const plain = plainLine(line).replace(/^[★-]\s*/, "");
          expect(sentenceSpans(plain)).toHaveLength(2);
          expect(citedSentences(plain)).toHaveLength(1);
        }
      }
    },
  );
});

describe("a check line gives its verdict a sentence of its own, then the Documents' fact cited", () => {
  // protects=the check button's lines start with "Right." or "Wrong." as a sentence with no Citation and give the Documents' fact in a sentence of its own with its Citation, or say in one uncited sentence that the Documents don't speak to the claim, in both languages; fails_when=a check example cites its verdict, joins it to the fact, or cites a line the Documents don't speak to; no_claim=how often a model writes it so.
  test.each(["English", "Chinese"])("in %s", (callLanguage) => {
    const text = meetingHelpInstructions("check", { found: true, language: "en", callLanguage });
    expect(text).toContain('Each line starts with the verdict, "Right." or "Wrong."');
    const lines = examples("check", callLanguage).map((line) =>
      plainLine(line).replace(/^-\s*/, ""),
    );
    expect(lines).toHaveLength(3);
    for (const line of lines.filter((each) => each.includes("[^"))) {
      const [verdict, fact] = sentenceSpans(line).map(({ from, to }) => line.slice(from, to));
      expect(verdict).toMatch(/^(?:Right|Wrong|对|不对)[.。]$/);
      expect(citedSentences(line).map((each) => each.sentence)).toEqual([
        citedSentences(fact ?? "")[0]?.sentence,
      ]);
    }
    const unsaid = lines.filter((each) => !each.includes("[^"));
    expect(unsaid).toHaveLength(1);
    expect(sentenceSpans(unsaid[0] ?? "")).toHaveLength(1);
  });
});

describe("the evaluation's switch asks as main did", () => {
  // protects=a paired gate's arms differ only in what call help writes: under `callHelpWritingAsBefore` every button's instructions are main's at 61615612f, byte for byte, in every language and with or without Passages found ahead; fails_when=the switch's text differs from main's by one byte; no_claim=what a model writes under either.
  test("every button, language and found ahead", () => {
    const all = createHash("sha256");
    let changed = 0;
    for (const kind of KINDS) {
      for (const callLanguage of ["English", "Chinese", null]) {
        for (const language of ["en", "zh-CN"] as const) {
          for (const found of [true, false]) {
            const before = meetingHelpInstructions(kind, {
              found,
              language,
              callLanguage,
              asBefore: true,
            });
            all.update(before);
            if (before !== meetingHelpInstructions(kind, { found, language, callLanguage })) {
              changed++;
            }
          }
        }
      }
    }
    expect(all.digest("hex")).toBe(
      "464daefa8ebee8999a2b41e32fa744f942b1b56e76795d1ba76329e0ad384bf5",
    );
    // A reading's instructions are the same under both; every other button's differ.
    expect(changed).toBe(KINDS.filter((kind) => HELP_SHAPE[kind] !== "readings").length * 12);
  });
});
