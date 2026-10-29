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
    ["The company has 54,000 users.", "The company has 54,000.", "54,000"],
    ["The margin was 12%.", "The margin was 12.", "12"],
    ["The margin was 12 percent.", "The margin was 12.", "12"],
    ["毛利率为百分之十二。", "毛利率\t12", "12"],
    ["The margin rose 12 percentage points.", "The margin rose 12.", "12"],
    ["毛利率上升12个百分点。", "毛利率\t12", "12"],
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
    ["The margin was 12%.", "The margin was 12%."],
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
