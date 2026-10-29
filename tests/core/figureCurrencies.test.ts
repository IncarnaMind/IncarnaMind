/**
 * A cited figure given another currency, or a unit its Document doesn't state, checks as
 * Unsupported, naming what the Document gives (#1452): "£54,000" against "$54,000", "人民币两万元"
 * against "2万美元", "54,000 tonnes" or "12%" against a plain number. A sign that may stand for the
 * figure's currency, a unit its Document writes, a stated conversion and a worked-out figure are
 * left alone.
 */
import { describe, expect, test } from "vitest";
import { type CheckedText, unitNotStated } from "../../src/core/answers/checks/units";
import { translate } from "../../src/shared/i18n";
import { checkingModel } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";

const read = (cited: string, document = cited): CheckedText[] => [
  { cited: () => cited, document: () => document },
];

describe("An amount in another currency (#1452)", () => {
  // protects=an amount the Document gives in one currency, written in another, is found, naming what the Document gives, in English and Chinese, with the Chinese amounts read as #2189 reads them, signed, with scale words and with a currency its table heading states; fails_when="£54,000" passes against "$54,000", "人民币两万元" against "2万美元", or "2万港币" against "2万元"; no_claim=the model's verdict.
  test.each([
    ["The annual salary is £54,000.", "The annual salary is $54,000.", "$54,000"],
    ["年薪为£54,000。", "年薪为$54,000。", "$54,000"],
    ["乙方每月租金为人民币两万元。", "乙方每月租金为2万美元。", "2万美元"],
    ["乙方每月租金为2万港币。", "乙方每月租金为2万元。", "2万元"],
    ["The loss was -£54,000.", "The loss was -$54,000.", "-$54,000"],
    ["Revenue was $2m.", "收入为200万元。", "200万元"],
    ["Revenue was £54m.", "Revenue (USD millions)\t54", "54 (USD millions)"],
    ["Revenue was £170 million.", "Revenue of RMB 1.2 billion (US$170 million)", "US$170 million"],
    ["Die Gebühr beträgt 54.000 £.", "Die Gebühr beträgt 54.000 $.", "54.000 $"],
    ["The salary is C$54,000.", "The salary is $54,000.", "$54,000"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=never a false alarm for the same currency written another way, a sign that may stand for it, a currency the Document names for its sign, the same amount at another scale, or a stated conversion; fails_when="US$54,000" against "$54,000", "RMB" against "元", "¥" against "人民币" or "円", "$" against "C$", "C$" against "$" in a Document in Canadian dollars, or "2万港币" against "2万元" in a Document paid in 港币 is flagged; no_claim=none beyond protects.
  test.each([
    ["The salary is US$54,000.", "The salary is $54,000."],
    ["The salary is $54,000.", "The salary is USD 54,000."],
    ["The salary is RMB 54,000.", "年薪为54,000元。"],
    ["年薪为¥54,000。", "年薪为人民币54,000元。"],
    ["The salary is 54,000 yuan.", "年薪为¥54,000。"],
    ["The salary is ¥54,000.", "The salary is 54,000円."],
    ["The salary is $54,000.", "The salary is C$54,000."],
    ["Revenue was $2m.", "Revenue was $2,000,000."],
    ["Revenue was $2m.", "收入为200万美元。"],
    ["Revenue was $54m.", "Revenue (USD millions)\t54"],
    ["The fee was £54,000 (about US$68,000).", "The fee was £54,000."],
    ["The loss was -£54,000.", "The loss was $54,000."],
    ["The fee is NT$54,000.", "费用为新台币54,000元。"],
    ["The fee is NT$54,000.", "費用為新台幣54,000元。"],
    ["Revenue was HK$54,000.", "單位：港幣千元\n收入\t54"],
    ["The fee was £54,000.", "The company holds 54,000 shares."],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  test.each([
    [
      "The salary is C$54,000.",
      "The salary is $54,000.",
      "All amounts are in Canadian dollars.\nThe salary is $54,000.",
    ],
    ["年薪为2万港币。", "年薪为2万元。", "本合同以港币支付。\n年薪为2万元。"],
    ["押金为2万港币。", "押金為2萬元。", "本合同以港幣支付。\n押金為2萬元。"],
    [
      "The fee is $54,000.",
      "All amounts are in US dollars.\nThe fee is 54,000.\nThe UK deposit is £54,000.",
      "All amounts are in US dollars.\nThe fee is 54,000.\nThe UK deposit is £54,000.",
    ],
    [
      "Revenue was £54,000.",
      "Amounts in £\nRevenue\t54,000\nUS revenue\t$54,000",
      "Amounts in £\nRevenue\t54,000\nUS revenue\t$54,000",
    ],
  ])("%s against %j isn't flagged where the Document names it", (claim, cited, document) => {
    expect(unitNotStated(claim, read(cited, document))).toBeNull();
  });
});

describe("A figure row's number in another currency (#1452)", () => {
  // protects=with the numbers a figure's row was bound to, an amount of the same value in another currency is found, and the same currency written another way isn't; fails_when="人民币两万元" bound to "2万美元" passes, or "US$54,000" bound to "$54,000" is flagged; no_claim=whether the row binds such a number, which the figure check decides.
  test.each([
    ["人民币两万元", "乙方每月支付租金2万美元。", "2万美元", "USD", 1e4, "2万美元"],
    ["£54,000", "The annual salary is $54,000.", "$54,000", "USD", 1, "$54,000"],
    ["US$54,000", "The annual salary is $54,000.", "$54,000", "USD", 1, null],
  ] as const)("%s bound to %j", (claim, cited, chars, code, scale, amount) => {
    const bound = [{ chars, unit: { kind: "currency" as const, code }, scale }];
    const found = unitNotStated(claim, read(cited), bound);
    if (amount === null) expect(found).toBeNull();
    else expect(found).toMatchObject({ kind: "unit", amount });
  });
});

describe("A unit the Document doesn't state (#1452)", () => {
  // protects=a unit on a figure the Document gives as a plain number is found, naming the number, in English and Chinese: tonnes, users, a percent in its every spelling, percentage points; fails_when="54,000 tonnes" or "12%" passes against a plain number; no_claim=none beyond protects.
  test.each([
    ["Output was 54,000 tonnes.", "Output was 54,000.", "54,000"],
    ["产量为5.4万吨。", "产量\t54,000", "54,000"],
    ["The route was 54 kilometres.", "The route was 54.", "54"],
    ["面积为5400平方米。", "面积\t5,400", "5,400"],
    ["Capacity was 54 MW.", "Capacity was 54.", "54"],
    ["The margin was 12%.", "The margin was 12.", "12"],
    ["The margin was 12 percent.", "The margin was 12.", "12"],
    ["毛利率为百分之十二。", "毛利率\t12", "12"],
    ["The margin rose 12 percentage points.", "The margin rose 12.", "12"],
    ["毛利率上升12个百分点。", "毛利率\t12", "12"],
    ["Revenue rose 3 pps.", "Our apps grew\t3", "3"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=a unit its Document writes is stated: in a column heading, a unit line or a row's label, or as another word for a unit the reader can't compare ("t" for tonnes); fails_when="54,000 tonnes" under "Output (tonnes)", "5.4万吨" under "单位：吨", "12%" under "Margin (%)" or "单位：%", or "54,000 users" beside "Users" is flagged; no_claim=converting one unit into another, which isn't attempted.
  test.each([
    ["Output was 54,000 tonnes.", "Product\tOutput (tonnes)\nOak\t54,000"],
    ["产量为5.4万吨。", "单位：吨\n产量\t54,000"],
    ["The margin was 12%.", "Product\tMargin (%)\nOak\t12"],
    ["毛利率为12%。", "单位：%\n毛利率\t12"],
    ["The company has 54,000 users.", "Users\t54,000"],
    ["Output was 54,000 tonnes.", "Output was 54,000 t."],
    ["The mill's output was 54,000 tonnes.", "Output (t)\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output (tons)\t54,000"],
    ["The mill's output was 54,000 tonnes.", "产量（吨）\t54,000"],
    ["产量为5.4万吨。", "产量（t）\t54,000"],
    ["The route was 54 kilometres.", "Distance (km)\t54"],
    ["Capacity was 54 MW.", "Capacity (megawatts)\t54"],
    ["The area was 54,000 square feet.", "Area (sq ft)\t54,000"],
    ["面积为5400平方米。", "面积（㎡）\t5,400"],
    ["毛利率为12%。", "单位：百分比\n毛利率\t12"],
    ["Revenue grew 12% year on year.", "Metric\tYoY%\nRevenue\t12"],
    ["Growth was 12%.", "Growth%\t12"],
    ["The margin rose 2 percentage points.", "Chgpp\t2"],
    ["The margin was 12%.", "The margin was 12%."],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=a count is no unit the Document must state: employees, users, cars, 家, 岁 and 个 against a plain number or a label are the model's to judge; fails_when="54,000 employees" against "Headcount 54,000" or "公司共有54家门店。" against "门店数量 54" gives "The Document gives 54"; no_claim=whether the count is right.
  test.each([
    ["The company has 54,000 employees.", "Headcount\t54,000"],
    ["The company has 54,000 employees.", "Staff\t54,000"],
    ["The company has 54,000 users.", "MAU\t54,000"],
    ["The company has 54,000 users.", "The company has 54,000."],
    ["The fleet was 54 cars.", "Care homes\t54"],
    ["公司共有54家门店。", "门店数量\t54"],
    ["公司共有12个项目。", "项目数量\t12"],
    ["张三今年54岁。", "年龄\t54"],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=the percent and points of #1434 keep their reasons; fails_when="2%" against "2 percentage points" names the plain number or passes; no_claim=none beyond protects.
  test("a percent against percentage points keeps its reason", () => {
    expect(
      unitNotStated("The margin rose 2%.", read("The margin rose 2 percentage points.")),
    ).toMatchObject({ kind: "unit", amount: "2 percentage points" });
  });
});

describe("A one-letter or one-character unit symbol (#2225)", () => {
  // protects=a symbol is stated only where it belongs to a figure or a unit line, not as a letter inside a word ("t" in "don't", "m" in "I'm") or a character inside a word (克 in 克服, 米 in 大米, T in （T恤）), in English and Chinese; fails_when="54,000 tonnes" against "We don't ship 54,000 a year." or "54,000吨" against "克服困难，产量54,000" passes; no_claim=whether the figure is right.
  test.each([
    ["The mill's output was 54,000 tonnes.", "We don't ship 54,000 a year.", "54,000"],
    ["The route was 54 kilometres.", "I'm sure the route was 54.", "54"],
    ["The mill's output was 54,000 tonnes.", "款式（T恤）\t54,000", "54,000"],
    ["产量为54,000吨。", "克服困难，产量54,000", "54,000"],
    ["路线长54公里。", "大米\t54", "54"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=a symbol genuinely attached to a figure, or on a unit line, states the measure in any shape: no space ("54,000t"), a scale word ("5.4万吨"), a fullwidth heading ("（T）"), a rate heading ("(t/yr)", "（吨/年）"), a capital letter, another figure's unit, or a space before a Chinese character; fails_when=any of these is Unsupported; no_claim=the value.
  test.each([
    ["The mill's output was 54,000 tonnes.", "Output was 54,000t."],
    ["The mill's output was 54,000 tonnes.", "Output （T）\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output (t/yr)\t54,000"],
    ["产量为54,000吨。", "产量（吨/年）\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Units: t\nOutput\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output: 54,000. Last year: 42,000 t."],
    ["The route was 54 kilometres.", "Distance: 54. The return leg was 27 m."],
    ["产量为54,000吨。", "2025年产量5.4万吨\n2024年产量54,000"],
    ["产量为54,000吨。", "产量 54,000 吨"],
    ["产量为54,000吨。", "单位：吨\n产量\t54,000"],
    ["路线长54公里。", "今年新增路段54米，路线长54。"],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });
});

describe("Checking a figure in another currency or unit", { timeout: 30_000 }, () => {
  const LETTER = {
    name: "Offer letter.txt",
    contents: "Offer letter\nThe annual salary is $54,000, paid monthly.\n",
  };
  const LEASE = { name: "租赁协议.txt", contents: "租赁协议\n乙方每月向甲方支付租金2万美元。\n" };
  const DEPOSIT = { name: "押金收据.txt", contents: "押金收据\n押金为2万元。\n" };
  const MILL = {
    name: "Mill report.txt",
    contents: "Mill report\nOutput was 54,000 in 2025.\nThe margin was 12 in 2025.\n",
  };
  const TABLE = {
    name: "Mill table.txt",
    contents: "Mill table\nYear\tOutput (tonnes)\tMargin (%)\n2025\t54,000\t12\n",
  };
  const supported = (quote: string) => ({ verdict: "supported" as const, quote, says: quote });
  const PLANS = {
    "The annual salary is £54,000.": supported("The annual salary is $54,000"),
    "The annual salary is US$54,000.": supported("The annual salary is $54,000"),
    "乙方每月支付租金人民币两万元。": supported("乙方每月向甲方支付租金2万美元"),
    "乙方的押金为2万港币。": supported("押金为2万元"),
    "Output was 54,000 tonnes in 2025.": supported("Output was 54,000 in 2025"),
    "The margin was 12% in 2025.": supported("The margin was 12 in 2025"),
    "The mill's output was 54,000 tonnes in 2025.": supported("2025\t54,000\t12"),
    "The mill's margin was 12% in 2025.": supported("2025\t54,000\t12"),
    "The annual salary is $54,000 (about £42,000).": supported("The annual salary is $54,000"),
  };

  // protects=through the core, with the model calling every sentence supported: another currency on the same amount and a unit the Document doesn't state are Unsupported, naming what the Document gives, in English and Chinese, while the same currency written another way, a unit its table heading states and a stated conversion stay supported (#1452); fails_when=any of these checks the other way, or the reason names something else; no_claim=a real model's verdict.
  test("is Unsupported for another currency or an unstated unit, naming what the Document gives", async () => {
    const { core } = await setUpWithDocuments(checkingModel(PLANS), [
      LETTER,
      LEASE,
      DEPOSIT,
      MILL,
      TABLE,
    ]);
    const check = (claim: string) => core.checkClaim({ claim });

    expect(await check("The annual salary is £54,000.")).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives $54,000, not £54,000." },
    });
    expect(await check("乙方每月支付租金人民币两万元。")).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives 2万美元, not 人民币两万元." },
    });
    expect(await check("乙方的押金为2万港币。")).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives 2万元, not 2万港币." },
    });
    expect(await check("Output was 54,000 tonnes in 2025.")).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives 54,000, not 54,000 tonnes." },
    });
    expect(await check("The margin was 12% in 2025.")).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives 12, not 12%." },
    });
    for (const claim of [
      "The annual salary is US$54,000.",
      "The mill's output was 54,000 tonnes in 2025.",
      "The mill's margin was 12% in 2025.",
      "The annual salary is $54,000 (about £42,000).",
    ]) {
      expect(await check(claim), claim).toMatchObject({ verdict: "supported" });
    }

    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await check("The annual salary is £54,000.")).toMatchObject({
      unsupported: { reason: "文档写的是 $54,000，不是 £54,000。" },
    });
    expect(await check("乙方每月支付租金人民币两万元。")).toMatchObject({
      unsupported: { reason: "文档写的是 2万美元，不是人民币两万元。" },
    });
    expect(await check("乙方的押金为2万港币。")).toMatchObject({
      unsupported: { reason: "文档写的是 2万元，不是 2万港币。" },
    });
  });
});

describe("Checking a worked-out figure", { timeout: 30_000 }, () => {
  const FEES = {
    name: "Fees.md",
    contents: "# Fees\n\nFee A was $20,000 and fee B was $34,000; the deposit was £54,000.\n",
  };
  const LINE = "Fee A was $20,000 and fee B was $34,000; the deposit was £54,000.";
  const input = (name: string, number: string) => ({ name, label: name, quote: LINE, number });

  // protects=a figure a calculation worked out isn't flagged for another currency that the cited line gives the same amount in (#1452); fails_when="Fees A and B came to $54,000." is Unsupported naming "£54,000"; no_claim=a real model's verdict.
  test("is decided by its calculation, not by an amount of the same value in another currency", async () => {
    const claim = "Fees A and B came to $54,000.";
    const plans = {
      [claim]: {
        verdict: "supported" as const,
        calculation: {
          inputs: [input("a", "$20,000"), input("b", "$34,000")],
          formula: "a + b",
          stated: "$54,000",
        },
      },
    };
    const setup = await setUpWithDocuments(checkingModel(plans), [FEES]);
    const saved = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);

    expect(await setup.core.checkClaim({ claim })).toMatchObject({
      verdict: "supported",
      calculation: { stated: "$54,000" },
    });
  });
});

describe("The reason in Chinese", () => {
  // protects=a space goes only where the sentence's Chinese meets a Latin letter or a number, on either side of a figure that can be either; fails_when="不是 人民币两万元", "文档写的是2万美元" or "约 ¥ 0.12" is shown; no_claim=none beyond protects.
  test.each([
    [{ amount: "2万美元", figure: "人民币两万元" }, "文档写的是 2万美元，不是人民币两万元。"],
    [{ amount: "$54,000", figure: "£54,000" }, "文档写的是 $54,000，不是 £54,000。"],
    [{ amount: "人民币两万元", figure: "2万美元" }, "文档写的是人民币两万元，不是 2万美元。"],
  ])("%j reads %s", (params, shown) => {
    expect(translate("zh-CN", "claim.unsupported.unit", params)).toBe(shown);
  });

  test("a value after a sign the template writes takes no space", () => {
    expect(translate("zh-CN", "tagging.cost.yuan", { amount: "0.12" })).toBe(
      "每 100 个文档约 ¥0.12",
    );
  });
});

describe("Checking the cases a review found (#1452)", { timeout: 60_000 }, () => {
  const supported = (quote: string) => ({ verdict: "supported" as const, quote, says: quote });
  const calculated = (quote: string, a: string, b: string, stated: string) => ({
    verdict: "supported" as const,
    calculation: {
      inputs: [
        { name: "a", label: "a", quote, number: a },
        { name: "b", label: "b", quote, number: b },
      ],
      formula: "a + b",
      stated,
    },
  });
  const FEES = "Fee A was 20,000 and fee B was 34,000, or 54,000 in all.";
  const FEES_ZH = "费用甲为20,000，费用乙为34,000，合计54,000。";
  const DOCUMENTS = [
    { name: "Fees.txt", contents: `Fees\n${FEES}\n` },
    { name: "费用.txt", contents: `费用\n${FEES_ZH}\n` },
    { name: "Mill output.txt", contents: "Mill output\nYear\tOutput (t)\n2025\t54,000\n" },
    { name: "产量.txt", contents: "产量\n年份\t产量（吨）\n2025\t36,000\n" },
    { name: "Staff.txt", contents: "Staff\nHeadcount\t4,800\n" },
    { name: "门店.txt", contents: "门店\n门店数量\t54\n" },
    { name: "Growth.txt", contents: "Growth\nMetric\tYoY%\nRevenue\t12\n" },
    { name: "增长.txt", contents: "增长\n指标\t同比%\n利润\t17\n" },
    { name: "Taipei fee.txt", contents: "Taipei fee\n費用為新台幣64,000元。\n" },
    { name: "租约.txt", contents: "租约\n本合同以港幣支付。\n押金為3萬元。\n" },
    {
      name: "Sales.txt",
      contents: "Sales\nAmounts in £\nRevenue\t71,000\nUS revenue\t$71,000\n",
    },
    {
      name: "销售.txt",
      contents: "销售\n金额单位：英镑\n收入\t83,000\n美国收入\t$83,000\n",
    },
  ];
  const PLANS = {
    "Fees A and B came to £54,000.": calculated(FEES, "20,000", "34,000", "£54,000"),
    "费用甲和费用乙合计54,000英镑。": calculated(FEES_ZH, "20,000", "34,000", "54,000英镑"),
    "The mill's output was 54,000 tonnes in 2025.": supported("2025\t54,000"),
    "2025年产量为3.6万吨。": supported("2025\t36,000"),
    "The company has 4,800 employees.": supported("Headcount\t4,800"),
    "公司共有54家门店。": supported("门店数量\t54"),
    "Revenue grew 12% year on year.": supported("Revenue\t12"),
    "利润同比增长17%。": supported("利润\t17"),
    "The Taipei fee is NT$64,000.": supported("費用為新台幣64,000元"),
    "押金为3万港币。": supported("押金為3萬元"),
    "Revenue was £71,000.": supported("Revenue\t71,000"),
    "收入为83,000英镑。": supported("收入\t83,000"),
  };

  const DOCUMENT_OF: Readonly<Record<string, (typeof DOCUMENTS)[number] | undefined>> = {
    "Fees A and B came to £54,000.": DOCUMENTS[0],
    "费用甲和费用乙合计54,000英镑。": DOCUMENTS[1],
    "The mill's output was 54,000 tonnes in 2025.": DOCUMENTS[2],
    "2025年产量为3.6万吨。": DOCUMENTS[3],
    "The company has 4,800 employees.": DOCUMENTS[4],
    "公司共有54家门店。": DOCUMENTS[5],
    "Revenue grew 12% year on year.": DOCUMENTS[6],
    "利润同比增长17%。": DOCUMENTS[7],
    "The Taipei fee is NT$64,000.": DOCUMENTS[8],
    "押金为3万港币。": DOCUMENTS[9],
    "Revenue was £71,000.": DOCUMENTS[10],
    "收入为83,000英镑。": DOCUMENTS[11],
  };
  const checkAlone = async (claim: string, language: "en" | "zh-CN" = "en", calculates = false) => {
    const document = DOCUMENT_OF[claim];
    if (!document) throw new Error(`No Document for ${claim}`);
    const setup = await setUpWithDocuments(checkingModel(PLANS), [document]);
    if (calculates) {
      // A model measured to use calculate (ADR-0021) is asked to work the figure out.
      const saved = await setup.core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) await setup.core.allowDataFlow("checks", saved.service.id);
    }
    if (language !== "en") await setup.core.updateSettings({ user: { language } });
    return setup.core.checkClaim({ claim });
  };

  // protects=through the core, a worked-out amount whose inputs carry no currency still can't be given one, in English and Chinese (#1434 kept for a Calculated figure); fails_when="Fees A and B came to £54,000." worked out from 20,000 and 34,000 is Supported; no_claim=a real model's verdict.
  test("a worked-out amount whose inputs carry no currency can't be given one", async () => {
    expect(await checkAlone("Fees A and B came to £54,000.", "en", true)).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives 54,000 without a currency." },
    });
    expect(await checkAlone("费用甲和费用乙合计54,000英镑。", "zh-CN", true)).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "文档写的是 54,000，没有注明币种。" },
    });
  });

  // protects=through the core, in English and Chinese: a unit of the same measure in a heading ("(t)", "（吨）"), a count ("employees", "家"), a percent sign after letters ("YoY%", "同比%"), a Taiwan or Hong Kong Document's own currency in Traditional script, and a plain number whose currency its unit line names stay supported; fails_when=any of these is Unsupported; no_claim=a real model's verdict.
  test.each(Object.keys(PLANS).filter((claim) => !/came to|合计/.test(claim)))(
    "%s stays supported",
    async (claim) => {
      expect(await checkAlone(claim)).toMatchObject({ verdict: "supported" });
    },
  );
});

describe("A letter or character inside a word through the core (#2225)", {
  timeout: 30_000,
}, () => {
  const supported = (quote: string) => ({ verdict: "supported" as const, quote, says: quote });
  const checkIn = async (
    claim: string,
    document: { name: string; contents: string },
    language: "en" | "zh-CN" = "en",
  ) => {
    const setup = await setUpWithDocuments(checkingModel({ [claim]: supported("54,000") }), [
      document,
    ]);
    if (language !== "en") await setup.core.updateSettings({ user: { language } });
    return setup.core.checkClaim({ claim });
  };

  // protects=through the core, a letter or one character inside a word states no unit, in English and Chinese, and the reason names the plain number the Document gives; fails_when=Supported, or a reason naming the unit; no_claim=whether the figure is right.
  test("a letter inside a word doesn't state tonnes", async () => {
    expect(
      await checkIn("The mill's output was 54,000 tonnes.", {
        name: "Mill output.txt",
        contents: "Mill output\nWe don't ship 54,000 a year.\n",
      }),
    ).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "The Document gives 54,000, not 54,000 tonnes." },
    });
  });

  test("a character inside a word doesn't state tonnes", async () => {
    expect(
      await checkIn(
        "产量为54,000吨。",
        { name: "产量.txt", contents: "产量\n克服困难，产量54,000\n" },
        "zh-CN",
      ),
    ).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "文档写的是 54,000，不是 54,000吨。" },
    });
  });
});
