import { describe, expect, test } from "vitest";
import { addedUncited } from "../../src/core/tools/minds/lengthAsked";
import { sentenceNumbers } from "../../src/core/tools/minds/sentenceNumbers";

/**
 * Which sentences a rewrite adds with no Citation (#1385): one that keeps an old sentence's
 * words but states a number that sentence doesn't is added, whatever script the number is in.
 */
describe("A sentence added with a figure the old one doesn't state", () => {
  // protects=a changed figure makes a sentence new, in digits, separators, percents, days and Chinese numerals; fails_when=950 → 1,200, 5 → 15 days, 12% → 15% or 五天 → 十五天 passes as a restatement; no_claim=a number written out in words beyond ninety-nine.
  test.each([
    ["The rent is 950 per month for the flat.", "The rent is 1,200 per month for the flat."],
    ["Up to 5 unused holiday days carry over.", "Up to 15 unused holiday days carry over."],
    ["Revenue grew 12% in the year.", "Revenue grew 15% in the year."],
    ["Either party gives two weeks' notice.", "Either party gives three weeks' notice."],
    ["未休年假最多可结转五天至下一年。", "未休年假最多可结转十五天至下一年。"],
    ["年薪为人民币415,000元，按月发放。", "年薪为人民币450,000元，按月发放。"],
    ["年薪为三万元，按月发放。", "年薪为4万元，按月发放。"],
  ])("“%s” → “%s”", (old, added) => {
    expect(addedUncited(old, added)).toEqual([added]);
  });

  // protects=a restatement that keeps its numbers, however they are written, and one with no number, are not taken for added claims; fails_when=either is named; no_claim=a reworded sentence that shares fewer words.
  test.each([
    ["The rent is 950 per month for the flat.", "The rent for the flat is 950 per month."],
    ["The rent is 1200 per month for the flat.", "The rent for the flat is 1,200 per month."],
    ["Up to 5 unused holiday days carry over.", "Up to five unused holiday days carry over."],
    ["未休年假最多可结转5天至下一年。", "未休年假最多可结转五天至下一年。"],
    ["年薪为三万元，按月发放。", "年薪为3万元，按月发放。"],
    ["The tenant pays for water and power.", "The tenant pays for the water and the power."],
  ])("“%s” → “%s” restates it", (old, added) => {
    expect(addedUncited(old, added)).toEqual([]);
  });

  // protects=a number dropped from the old sentence keeps it a restatement: only a number it adds is new; fails_when=a shorter restatement is named; no_claim=whether dropping it changes the meaning.
  test("a number left out is no new claim", () => {
    expect(
      addedUncited(
        "The salary is £41,500 a year, paid monthly on the last working day.",
        "The salary is paid monthly on the last working day.",
      ),
    ).toEqual([]);
  });

  // protects=numbers read as numbers in every form the old and new text use; fails_when=a form is missed, so its change passes; no_claim=ordinals and fractions written in words.
  test("numbers are read in each form", () => {
    expect([...sentenceNumbers("1,200 and 1200.0 and １２００")]).toEqual(["1200"]);
    expect([...sentenceNumbers("12% · 3万 · 三万 · 十五 · 二〇二五年 · twenty-five")]).toEqual([
      "12",
      "30000",
      "15",
      "2025",
      "25",
    ]);
    expect([...sentenceNumbers("自2025年3月3日起")]).toEqual(["2025", "3"]);
  });
});
