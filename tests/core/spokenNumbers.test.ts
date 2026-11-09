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
    ["two point seven million pounds", "2.7 million pounds"],
    ["fifty to sixty percent", "50 to 60%"],
    ["one hundred and fifty dollars", "150 dollars"],
    ["ten or fifteen percent", "10 or 15%"],
    ["between twenty and thirty people", "between 20 and 30 people"],
    ["from twenty nineteen to twenty twenty-one", "from 2019 to 2021"],
    ["between twenty nineteen and twenty twenty-one", "between 2019 and 2021"],
    ["the first to the thirtieth of November", "the 1st to the 30th of November"],
    ["November the first to the thirtieth", "November the 1st to the 30th"],
    ["three hundred four thousand five hundred", "304,500"],
    ["twenty seconds", "20 seconds"],
  ])("%s is %s", (said, written) => {
    expect(writtenNumbers(said)).toBe(written);
  });

  // protects=a number is written whole or left as said, and a range at both ends or at neither (#1031); fails_when=a hundred and fifty dollars becomes a hundred and 50 dollars, one to ten becomes one to 10, twenty third becomes 20 third, or three hundred and four hundred becomes 30,400; no_claim=that these could not be written whole one day.
  test.each([
    "a hundred and fifty dollars",
    "a thousand two hundred pounds",
    "point five percent",
    "twelve and a half euros",
    "on a scale of one to ten",
    "a million dollars",
    "one and a half million",
    "a hundred and ten percent",
    "3 hundred and fifty",
    "five to ten percent",
    "one to two dollars",
    "five to six hundred dollars",
    "a hundred to two hundred dollars",
    "five hundred to a thousand pounds",
    "one and a half to two million",
    "ten to twelve and a half percent",
    "the odds are twenty to one",
    "nine courses, one or ten, or something",
    "two or three hundred",
    "between five and ten percent",
    "due on twenty third February",
    "thirty fives and unders",
    "between three hundred and four hundred people",
    "two thousand and three thousand dollars",
    "up to twenty twenty-five people",
  ])("%s is left as said", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  test("an empty line, a line that is only a number, and a number at each end of a line", () => {
    expect(writtenNumbers("")).toBe("");
    expect(writtenNumbers("twelve")).toBe("12");
    expect(writtenNumbers("five")).toBe("five");
    expect(writtenNumbers("Twelve people came and we sold fifteen")).toBe(
      "12 people came and we sold 15",
    );
  });

  test("beside a number the engine wrote in digits, a spoken one is written by its own rule", () => {
    expect(writtenNumbers("5 to ten percent")).toBe("5 to 10%");
    expect(writtenNumbers("from 2019 to twenty twenty-one")).toBe("from 2019 to 2021");
    expect(writtenNumbers("$5 million and fifteen percent")).toBe("$5 million and fifteen percent");
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
    ["二百七十万英镑", "270万英镑"],
    ["两万四千英镑", "24,000英镑"],
    ["百分之十二点五", "12.5%"],
    ["十一月二十日", "11月20日"],
    ["一天工作十二到十四个小时", "一天工作12到14个小时"],
    ["二十一到五十五岁", "21到55岁"],
    ["二十到三十个", "20到30个"],
    ["二十或三十个", "20或30个"],
    ["一百到两百块钱", "100到200块钱"],
    ["百分之二十到百分之三十", "20%到30%"],
    ["十一月二十日到三十日", "11月20日到30日"],
    ["五十块一个", "50块一个"],
    ["三千块一个月", "3,000块一个月"],
    ["最多到五十个", "最多到50个"],
    ["比去年多二十个", "比去年多20个"],
    ["一周三十个小时", "一周30个小时"],
  ])("%s is %s", (said, written) => {
    expect(writtenNumbers(said)).toBe(written);
  });

  // protects=a number is written whole or left as said, and a range at both ends or at neither (#1031); fails_when=十几二十个 becomes 十几20个, 两块五 becomes 2块五, 百分之二十到三十 becomes 20%到三十, 一到十二月就下雪 becomes 1到12月就下雪, or 周六日 becomes 周6日; no_claim=that these could not be written whole one day.
  test.each([
    "至少有十几二十个吧",
    "百分之二十到三十",
    "两块五",
    "四十五厘米",
    "一亿二千万",
    "三万五到四万",
    "十几万",
    "两三百万",
    "二十几到三十个",
    "一百多到两百个",
    "五到十五个",
    "二十个到三十",
    "一到十二月就下雪",
    "礼拜六到二十号",
    "周六日的话大家有没有时间",
    "下周二十号",
    "两块五一个",
    "十二块五",
    "三元五角",
    "两块五十个",
    "增长百分之二十到三十五万",
    "百分之二十到三分之一",
  ])("%s is left as said", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  test("a line that is only a number, a number at each end of a line, and both languages in one line", () => {
    expect(writtenNumbers("百分之三十")).toBe("30%");
    expect(writtenNumbers("十二")).toBe("十二");
    expect(writtenNumbers("三十个人来了，卖了五十件")).toBe("30个人来了，卖了50件");
    expect(writtenNumbers("我们卖了 twenty units 和三十个")).toBe("我们卖了 20 units 和30个");
    expect(writtenNumbers("营收3万元，增长百分之二十")).toBe("营收3万元，增长20%");
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
