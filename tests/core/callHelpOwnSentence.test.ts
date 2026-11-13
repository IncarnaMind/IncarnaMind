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
const RULE = "What the Documents or the call say goes in a sentence of its own";

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
