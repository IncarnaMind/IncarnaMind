/**
 * The list sentences `npm run eval:support` judges as an Answer does (#3020, #2809): a frozen set
 * over the made-up résumés, whose labels the run's result rests on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LIST_CASES, LIST_DOCUMENTS } from "../../eval/answerSupport/lists";

const FIXTURES = join(__dirname, "../fixtures/answers/resume");
const resume = (language: "en" | "zh-CN") =>
  readFileSync(join(FIXTURES, LIST_DOCUMENTS[language === "en" ? 0 : 1]), "utf8");

describe("the support eval's list sentences", () => {
  // protects=each list sentence cites words that are in its language's résumé, under an id used once, so the run can cite every one and tell them apart; fails_when=a quote drifts from the fixture's text, so its sentence is skipped as uncitable, or two sentences share an id; no_claim=what a model reads of them, which the eval's run shows.
  test("each cites a line of its résumé, under its own id", () => {
    expect(new Set(LIST_CASES.map((each) => each.id)).size).toBe(LIST_CASES.length);
    for (const each of LIST_CASES) {
      expect(resume(each.language), each.id).toContain(each.quote);
      expect(
        LIST_DOCUMENTS.some((name) => name.startsWith(each.document)),
        each.id,
      ).toBe(true);
    }
  });

  // protects=a sentence labelled as stated by the Documents is in a true set and one with an item no Document states is a decoy, never the other way, with the unstated item's own words absent from both résumés; fails_when=a decoy is labelled supported, a true sentence unsupported, or a decoy's item is in a résumé after all, which would count a right ✓ as a wrong one; no_claim=that each true sentence's every item is stated, which was read by hand when the set was frozen.
  test("a decoy is labelled unsupported and its unstated item is in no résumé", () => {
    const both = `${resume("en")}\n${resume("zh-CN")}`;
    for (const each of LIST_CASES) {
      expect(each.supported, each.id).toBe(each.set !== "list-decoy");
    }
    for (const unstated of [
      "Example Bank mobile wallet",
      "Example Insurance Ltd",
      "9,000 trades",
      "2016",
      "示例银行手机钱包",
      "示例保险有限公司",
      "9,000 笔",
    ]) {
      expect(both, unstated).not.toContain(unstated);
      expect(
        [
          ...new Set(
            LIST_CASES.filter((each) => each.sentence.includes(unstated)).map((each) => each.set),
          ),
        ],
        unstated,
      ).toEqual(["list-decoy"]);
    }
    expect(LIST_CASES.filter((each) => each.supported)).toHaveLength(10);
    expect(LIST_CASES.filter((each) => !each.supported)).toHaveLength(8);
  });
});
