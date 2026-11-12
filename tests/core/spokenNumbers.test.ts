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
    [
      "between twenty ten and twenty twelve the numbers doubled",
      "between 2010 and 2012 the numbers doubled",
    ],
    ["in twenty nineteen and twenty twenty-one", "in 2019 and 2021"],
    ["sales in March and twenty twenty-one were flat", "sales in March and 2021 were flat"],
    ["in nineteen oh five", "in 1905"],
    ["eighty to two hundred people", "80 to 200 people"],
    ["ninety to one hundred percent", "90 to 100%"],
    ["ninety to a hundred percent", "90 to 100%"],
    ["five hundred to six thousand", "500 to 6,000"],
    ["two thousand to three thousand", "2,000 to 3,000"],
    ["twenty or thirty million", "20 or 30 million"],
    ["fifty, sixty people", "50, 60 people"],
    ["in twenty twenty-five, thirty thousand people came", "in 2025, 30,000 people came"],
    ["one hundred and one days", "101 days"],
    ["one hundred first-time buyers", "100 first-time buyers"],
    ["ninety second-hand cars", "90 second-hand cars"],
    ["a fifty point drop", "a 50 point drop"],
    ["one point five million", "1.5 million"],
    [
      "revenue grew twenty percent and one of the reasons is pricing",
      "revenue grew 20% and one of the reasons is pricing",
    ],
    [
      "margin was six point eight percent and two of the plants closed",
      "margin was 6.8% and two of the plants closed",
    ],
    ["fifty to sixty percent and one of the reasons", "50 to 60% and one of the reasons"],
    ["between twenty percent and thirty percent", "between 20% and 30%"],
    ["at this point fifteen percent of users left", "at this point 15% of users left"],
    ["at that point twenty people had joined", "at that point 20 people had joined"],
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

  // protects=two numbers after "between" are years only before "and" and another year, and after "and" only when no number comes before it (#1031); fails_when=between twenty thirty people becomes between 2030 people, somewhere between twenty twenty five percent becomes 2025%, or for twenty twenty and twenty twenty-one becomes for twenty twenty and 2021; no_claim=which two numbers after another lead-in are a year.
  test.each([
    "between twenty thirty people",
    "somewhere between twenty twenty five percent",
    "between nineteen twenty people",
    "in between twenty ten minute calls",
    "between twenty twenty and thirty people",
    "for twenty twenty and twenty twenty-one",
    "we had twenty thirty and twenty thirty",
  ])("%s is no year, and is left as said", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  // protects=numbers said in a row stay as said when one may share the next one's "hundred" or "thousand" (#1031); fails_when=twenty to thirty thousand dollars becomes 20 to 30,000 dollars, ten to fifteen hundred units 10 to 1,500 units, or fifty, sixty thousand dollars 50, 60,000 dollars; no_claim=which of the two readings the speaker meant.
  test.each([
    "twenty to thirty thousand dollars",
    "fifty or sixty thousand people",
    "between fifteen and twenty thousand pounds",
    "ten to fifteen hundred units",
    "fifty, sixty thousand dollars",
    "fifty, sixty, seventy thousand",
    "one hundred to two hundred thousand dollars",
    "ten, seventy thousand, seventy",
    "twenty, sixty thousand and two million",
    "twenty twenty, thirty thousand",
  ])("%s may share a word, and is left as said", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  // protects=a number stays as said when the word that ends it lies outside what is read: an ordinal, a decade, a plural, "oh five", or a "point" that isn't its decimal point (#1031); fails_when=one hundred and first becomes 100 and first, the nineteen nineties the 19 nineties, nineteen oh five 19 oh five, or twenty point fifteen 20 point fifteen; no_claim=that an ordinal above the thirty-first is ever written as digits.
  test.each([
    "one hundred and first",
    "the one hundred and twenty-first time",
    "the nineteen nineties",
    "the eighteen hundreds",
    "the twelve thousandth customer",
    "nineteen oh five was the year",
    "twenty point fifteen",
    "at one point one hundred people left",
    "zero to a hundred percent",
  ])("%s is left as said", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  // protects=a percent ends its number, so it is written though a number said after it stays as said, but after "or" or "to" only when that number counts something named right after it, and never when "between" or "from" leads both ends in, with or without a word such as "about" (#1031); fails_when=it was fifteen percent or two points higher stays as said, it's about five percent to six becomes it's about 5% to six, it fell fifteen percent to nine last year becomes it fell 15% to nine last year, twenty percent and a hundred percent becomes twenty percent and 100%, or it fell from fifteen percent to nine becomes it fell from 15% to nine; no_claim=whether the speaker meant a pair or two things where the words leave both readings.
  test("a percent is written though the number said after it stays as said, but not a pair's near end", () => {
    expect(writtenNumbers("it was fifteen percent or two points higher")).toBe(
      "it was 15% or two points higher",
    );
    expect(writtenNumbers("fifteen percent or two points")).toBe("15% or two points");
    expect(writtenNumbers("ten percent to five people")).toBe("10% to five people");
    expect(writtenNumbers("fifty to sixty percent or two points higher")).toBe(
      "50 to 60% or two points higher",
    );
    expect(writtenNumbers("it fell fifteen percent to nine")).toBe(
      "it fell fifteen percent to nine",
    );
    expect(writtenNumbers("it's five percent or six")).toBe("it's five percent or six");
    expect(writtenNumbers("it's about five percent to six")).toBe("it's about five percent to six");
    expect(writtenNumbers("fifteen percent or two")).toBe("fifteen percent or two");
    expect(writtenNumbers("it's five percent or six this year")).toBe(
      "it's five percent or six this year",
    );
    expect(writtenNumbers("it fell fifteen percent to nine last year")).toBe(
      "it fell fifteen percent to nine last year",
    );
    expect(writtenNumbers("five percent or six of them")).toBe("five percent or six of them");
    expect(writtenNumbers("the rate is twenty percent or thirty")).toBe("the rate is 20% or 30");
    expect(writtenNumbers("twenty percent and a hundred percent")).toBe("20% and 100%");
    expect(writtenNumbers("it fell from fifteen percent to nine")).toBe(
      "it fell from fifteen percent to nine",
    );
    expect(writtenNumbers("it went from about fifteen percent to nine")).toBe(
      "it went from about fifteen percent to nine",
    );
    expect(writtenNumbers("between five percent and nine")).toBe("between five percent and nine");
    expect(writtenNumbers("between about five percent and nine")).toBe(
      "between about five percent and nine",
    );
    expect(writtenNumbers("it rose five to fifteen percent or two points")).toBe(
      "it rose five to fifteen percent or two points",
    );
  });

  // protects=numbers said after a percent are a row of their own, so a pair after it that may share a word leaves the percent written; with no percent between them the row stays as said (#1031); fails_when=revenue grew twenty percent and fifty to sixty thousand users joined stays as said, or twenty, fifty to sixty thousand users joined becomes 20, fifty to sixty thousand users joined; no_claim=which reading of the pair the speaker meant.
  test("a percent before a pair that may share a word is written, and the pair stays as said", () => {
    expect(
      writtenNumbers("revenue grew twenty percent and fifty to sixty thousand users joined"),
    ).toBe("revenue grew 20% and fifty to sixty thousand users joined");
    expect(writtenNumbers("twenty percent, fifty or sixty thousand")).toBe(
      "20%, fifty or sixty thousand",
    );
    expect(writtenNumbers("twenty, fifty to sixty thousand users joined")).toBe(
      "twenty, fifty to sixty thousand users joined",
    );
    expect(writtenNumbers("between twenty percent and fifty to sixty thousand")).toBe(
      "between twenty percent and fifty to sixty thousand",
    );
  });

  // protects=a row of numbers is written at every end or at none: one that says two numbers in a run keeps the numbers said in a row with it as said (#1031); fails_when=one hundred, two hundred and three hundred dollars becomes 100, two hundred and three hundred dollars, or one hundred, two hundred and fifty dollars is no longer 100, 250 dollars; no_claim=that such a row could not be written whole one day.
  test("a row with a run that says two numbers stays as said, and a row of whole numbers is written", () => {
    expect(writtenNumbers("one hundred, two hundred and three hundred dollars")).toBe(
      "one hundred, two hundred and three hundred dollars",
    );
    expect(writtenNumbers("fifty, one hundred two hundred dollars")).toBe(
      "fifty, one hundred two hundred dollars",
    );
    expect(writtenNumbers("one hundred, two hundred and fifty dollars")).toBe("100, 250 dollars");
    expect(writtenNumbers("one hundred, two hundred, three hundred dollars")).toBe(
      "100, 200, 300 dollars",
    );
  });

  // protects=a line of number words is written in one pass however long it is (#1031); fails_when=the reader of a run calls itself at every new number and 10,000 of them overflow the stack; no_claim=how long the writing takes.
  test("a line of 10,000 numbers in a row is left as said", () => {
    const said = "one hundred ".repeat(10_000).trim();
    expect(writtenNumbers(said)).toBe(said);
    expect(writtenNumbers("one hundred")).toBe("100");
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
    ["一百块两百块都行", "100块200块都行"],
    ["本周十五号", "本周15号"],
    ["本周十五个订单", "本周15个订单"],
    ["二十、三十个", "20、30个"],
    ["三月、四月", "3月、4月"],
    ["三十个到五十个", "30个到50个"],
  ])("%s is %s", (said, written) => {
    expect(writtenNumbers(said)).toBe(written);
  });

  // protects=a number is written whole or left as said, and a range at both ends or at neither (#1031); fails_when=十几二十个 becomes 十几20个, 十几个到二十个 becomes 十几个到20个, 两块五 becomes 2块五, 十块零五 becomes 10块零五, 百分之二十到三十 becomes 20%到三十, 一到十二月就下雪 becomes 1到12月就下雪, 周六日 becomes 周6日, or 下周二十个人来 becomes 下周20个人来; no_claim=that these could not be written whole one day.
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
    "十几个到二十个",
    "三十多个到五十个",
    "十几、二十个",
    "二、三十个",
    "十块零五",
    "下周二十个人来",
    "周二十到三十个",
  ])("%s is left as said", (said) => {
    expect(writtenNumbers(said)).toBe(said);
  });

  // protects=a rough count of days or years runs up to a date, so the date after it is written, while a rough number's range stays as said at both ends (#1031); fails_when=这几天到二十号都有空 stays as said, or 十几号到二十号 becomes 十几号到20号 and 这几天到二十天 这几天到20天; no_claim=that a rough number is ever written as digits.
  test("a date after a rough count of days or years is written, and a range from a rough number stays as said", () => {
    expect(writtenNumbers("这几天到二十号都有空")).toBe("这几天到20号都有空");
    expect(writtenNumbers("前几年到二零二五年")).toBe("前几年到2025年");
    expect(writtenNumbers("十多天到二十号")).toBe("十多天到20号");
    expect(writtenNumbers("十几号到二十号")).toBe("十几号到二十号");
    expect(writtenNumbers("这几天到二十天")).toBe("这几天到二十天");
    expect(writtenNumbers("前几年到二十年")).toBe("前几年到二十年");
  });

  // protects=amounts said one after another are written at every end or at none: one before an amount that goes on (两块五) stays as said with it, and the next amount never starts at the digit that goes on (#1031); fails_when=五块两块五 becomes 5块两块五, 两块五五块 2块五五块, 两块五一百块都行 2块五一百块都行, or 五块两块 is no longer 5块2块; no_claim=that 两块五 could not be written 2.5块 one day.
  test("an amount before one that goes on stays as said, a digit that goes on starts no amount, and whole amounts are written", () => {
    expect(writtenNumbers("五块两块五")).toBe("五块两块五");
    expect(writtenNumbers("三块五块两块五")).toBe("三块五块两块五");
    expect(writtenNumbers("两块五五块")).toBe("两块五五块");
    expect(writtenNumbers("两块五一百块都行")).toBe("两块五一百块都行");
    expect(writtenNumbers("五块两块")).toBe("5块2块");
    expect(writtenNumbers("一百块两百块都行")).toBe("100块200块都行");
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
