import { describe, expect, test } from "vitest";
import type { Language } from "../../src/core/language";
import { askBarKinds } from "../../src/renderer/src/meetingPanel/askBarKinds";
import { rankHelp } from "../../src/renderer/src/meetingPanel/helpRank";
import { translate } from "../../src/shared/i18n";
import { helpLabel, isGeneralHelpKind } from "../../src/shared/meetingHelp";

/** Every prompt the meeting has, in the order "/" lists them before anything is typed. */
const listed = (template: Parameters<typeof askBarKinds>[0] = null) => {
  const { bar, more } = askBarKinds(template);
  return [...bar, ...more];
};

const ranked = (typed: string, language: Language = "en", kinds = listed()) =>
  rankHelp(
    kinds,
    typed,
    (kind) => translate(language, helpLabel(kind)),
    (kind) =>
      isGeneralHelpKind(kind) ? translate(language, `meetings.help.keywords.${kind}`) : "",
  );

describe('The "/" list, narrowed as the User types', () => {
  test("with nothing typed after the slash, lists every prompt in the bar's order, then More…'s", () => {
    expect(ranked("")).toEqual(["say", "answer", "want", "sum", "no", "ask", "check"]);
    expect(ranked(" ")).toEqual(["say", "answer", "want", "sum", "no", "ask", "check"]);
    expect(ranked("", "en", listed("sales"))).toEqual([
      "say",
      "answer",
      "want",
      "objection",
      "nextStep",
      "facts",
      "sum",
      "no",
      "ask",
      "check",
    ]);
  });

  test('"su" puts Sum up so far first, the start of its label, then a keyword\'s match', () => {
    expect(ranked("su")).toEqual(["sum", "say"]);
  });

  test("the start of the label ranks above the start of a word, then anywhere in the label", () => {
    // "what" starts three labels and a word of "Check what was said"; "at" is only ever inside one.
    expect(ranked("what")).toEqual(["say", "want", "ask", "check"]);
    expect(ranked("ask")).toEqual(["ask"]);
    expect(ranked("at")).toEqual(["say", "want", "ask", "check"]);
  });

  test("case and accents don't count", () => {
    expect(ranked("SUM")).toEqual(["sum"]);
    expect(ranked("Pölitely")).toEqual(["no"]);
  });

  test("keywords find a prompt by another word for it", () => {
    expect(ranked("recap")).toEqual(["sum"]);
    expect(ranked("decline")).toEqual(["no"]);
    expect(ranked("verify")).toEqual(["check"]);
  });

  test("in Chinese, the label's characters first, then its pinyin and the pinyin's initials", () => {
    expect(ranked("总结", "zh-CN")).toEqual(["sum"]);
    expect(ranked("问题", "zh-CN")).toEqual(["answer"]);
    expect(ranked("zongjie", "zh-CN")).toEqual(["sum"]);
    expect(ranked("zj", "zh-CN")).toEqual(["sum"]);
    expect(ranked("jujue", "zh-CN")).toEqual(["no"]);
  });

  test("a template's prompts are found too", () => {
    expect(ranked("obj", "en", listed("sales"))).toEqual(["objection"]);
  });

  test("nothing that matches lists nothing, and a typo is no match", () => {
    expect(ranked("xyz")).toEqual([]);
    expect(ranked("summmary")).toEqual([]);
  });
});
