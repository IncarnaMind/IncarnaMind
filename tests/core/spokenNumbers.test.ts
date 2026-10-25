import { describe, expect, test } from "vitest";
import { writtenNumbers } from "../../src/core/transcription/spokenNumbers";

/*
 * A transcript writes numbers one way (#1508): digits for figures, percentages, money and dates,
 * so a check of "6.8%" finds the line that says "six point eight percent".
 */

describe("English numbers in a transcript", () => {
  test.each([
    ["one hundred and twenty eight thousand four hundred shipments", "128,400 shipments"],
    ["nine point three percent", "9.3%"],
    ["six point eight percent to eighteen point four million", "6.8% to 18.4 million"],
    ["four hundred and twelve to three hundred and thirty-seven", "412 to 337"],
    ["the thirtieth of November", "the 30th of November"],
    ["on November the twenty-first", "on November the 21st"],
    ["0.5 percent", "0.5%"],
    ["up 50 percent", "up 50%"],
    ["a hundred percent sure", "100% sure"],
    ["it cost twelve million dollars", "it cost 12 million dollars"],
    ["five dollars and fifty cents", "5 dollars and 50 cents"],
    ["in twenty twenty-five and nineteen ninety-nine", "in 2025 and 1999"],
    ["two million", "2 million"],
  ])("%s is %s", (said, written) => {
    expect(writtenNumbers(said)).toBe(written);
  });

  // protects=text the engine got right isn't rewritten: a scale word after digits, "a few million", "several hundred"; fails_when=$18.4 million becomes $18.4 1 million, or several hundred becomes several 100; no_claim=what else may be written as digits.
  test.each([
    "$18.4 million",
    "revenue of 18.4 million",
    "a few million",
    "several hundred",
    "3 hundred",
    "hundreds of thousands",
    "a million reasons",
    "Twenty twenty-five was good",
    "We may first need to check",
    "I may second that motion",
    "March third parties out of the building",
    "May the first of us to arrive wait",
    "May the second round go well",
    "on November twenty-first",
    "the first of may be the problem",
    "25 percentage points",
  ])("%s stays as it is", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  test("digits already there stay, and so does a small number in running speech", () => {
    expect(writtenNumbers("Sales were 128,400, up 9.3%.")).toBe("Sales were 128,400, up 9.3%.");
    expect(writtenNumbers("one of the two of us waited five minutes")).toBe(
      "one of the two of us waited five minutes",
    );
    expect(writtenNumbers("on the first day of the year, none came")).toBe(
      "on the first day of the year, none came",
    );
  });

  test("the whole clip of the issue is written one way, and 6.8% is in it", () => {
    const said =
      "one hundred and twenty eight thousand four hundred shipments, nine point three percent, " +
      "six point eight percent to eighteen point four million, four hundred and twelve to " +
      "three hundred and thirty seven, the thirtieth of November, 96.2% and 41%";
    const written = writtenNumbers(said);
    expect(written).toBe(
      "128,400 shipments, 9.3%, 6.8% to 18.4 million, 412 to 337, the 30th of November, 96.2% and 41%",
    );
    expect(written).toContain("6.8%");
  });
});

describe("Chinese numbers in a transcript", () => {
  test.each([
    ["三千二百件", "3,200件"],
    ["一百二十八万四千件货", "1,284,000件货"],
    ["百分之九点三", "9.3%"],
    ["百分之三十", "30%"],
    ["百分之百", "100%"],
    ["三百万元", "300万元"],
    ["十八点四万元", "18.4万元"],
    ["二零二五年十一月三十日", "2025年11月30日"],
    ["三月", "3月"],
    ["五元", "5元"],
    ["三百块", "300块"],
    ["两块钱", "2块钱"],
  ])("%s is %s", (said, written) => {
    expect(writtenNumbers(said)).toBe(written);
  });

  // protects=text the engine got right isn't rewritten: digits with 万 or 亿 after them, and the words and idioms with 一, 万 or 千 in them, even at the end of the text, stay as they are; fails_when=3万 grows to 30万, 之一 becomes 之1, or 千万不要 loses its characters; no_claim=what else may be written as digits.
  test.each([
    "3万",
    "2亿",
    "5000万",
    "2.4万亿",
    "营收3万元，增长2亿",
    "万一",
    "万一下雨",
    "千万不要",
    "万分感谢",
    "万万",
    "亿万",
    "万事如意",
    "二三十",
    "二三十个人",
    "之一",
    "唯一",
    "这是唯一",
    "我们十分高兴，三个人一起去",
    "一方面，另一方面",
    "我们一块去吃饭",
    "一块去吃饭",
    "一块儿走吧",
    "两块儿走",
    "一块蛋糕",
    "一块钱",
  ])("%s stays as it is", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });
});
