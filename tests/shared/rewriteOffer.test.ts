import { describe, expect, test } from "vitest";
import { mayRewrite } from "../../src/shared/rewriteWords";
import { REWRITE_CASES } from "../helpers/notFoundFixesHeldOut";
import { REWRITE_OFFER_CASES, REWRITE_RULE_CASES } from "../helpers/rewriteRulesHeldOut";

describe("Rewrite is offered", () => {
  test.each(REWRITE_OFFER_CASES.map((each) => [each.id, each] as const))("%s", (_, each) => {
    expect(mayRewrite(each.sentence, each.quote)).toBe(each.offered);
  });

  test("not where an earlier clause writes a number the line doesn't, which a rewrite would keep", () => {
    expect(mayRewrite("In 2025, the pool fee is $30.", "The pool fee is $45.")).toBe(false);
    expect(mayRewrite("The pool fee is $30.", "The pool fee is $45.")).toBe(true);
  });

  test("where the line's figure is a measure whose digits look like a year, but never where it is a year, nor for the sentence's year", () => {
    expect(mayRewrite("The lot is 1,800 square feet.", "The lot is 2025 square feet.")).toBe(true);
    expect(mayRewrite("The grant was 500.", "The grant was in 2025.")).toBe(false);
    expect(mayRewrite("The opening balance was 500.", "The opening balance was in 2025.")).toBe(
      false,
    );
    expect(mayRewrite("The lot was sold in 2019.", "The lot was sold in 2021.")).toBe(false);
  });

  test.each([
    ["The grant was 500 after approval.", "The grant was in 2025 after approval.", false],
    ["The grant was paid 500 after approval.", "The grant was paid in 2025 after approval.", false],
    ["合同期限为 3 财年。", "合同期限为 2025 财年。", false],
    ["The grant was 500.", "The grant was in ２０２５.", false],
    ["The fee is $1,800.", "The fee is $2025.", true],
    ["The track is 1800 m long.", "The track is 2025 m long.", true],
    [
      "The grant was paid 500 under the scheme.",
      "The grant was paid in 2025 under the scheme.",
      false,
    ],
    ["预算期为 3 会计年度。", "预算期为 2025 会计年度。", false],
    ["The grant was 500 pending approval.", "The grant was in 2025 pending approval.", false],
    [
      "The grant was paid 500 shortly after approval.",
      "The grant was paid in 2025 shortly after approval.",
      false,
    ],
    ["The pipe is 1100 in long.", "The pipe is 2025 in long.", true],
    [
      "The grant was paid 500 per the agreement.",
      "The grant was paid in 2025 per the agreement.",
      false,
    ],
    [
      "The fee was agreed at 500 in long negotiations.",
      "The fee was agreed in 2025 in long negotiations.",
      false,
    ],
    [
      "The grant was paid 500 in long-term instalments.",
      "The grant was paid in 2025 in long-term instalments.",
      false,
    ],
    ["The grant was paid 500 in full.", "The grant was paid in 2025 in full.", false],
    [
      "The grant was paid 500 per head office instructions.",
      "The grant was paid in 2025 per head office instructions.",
      false,
    ],
    [
      "The fee was agreed at 500 in long, difficult negotiations.",
      "The fee was agreed in 2025 in long, difficult negotiations.",
      false,
    ],
    ["The hire costs 1100 per day.", "The hire costs 2025 per day.", true],
    ["Catering costs 1500 per head.", "Catering costs 2024 per head.", true],
    ["Scrap sells at 1800 per kg.", "Scrap sells at 2025 per kg.", true],
    ["数据来自 300 家庭调查。", "数据来自 2024 家庭调查。", false],
    ["The fee was paid 500 monthly.", "The fee was paid in 2025 monthly.", false],
    ["The grant was paid 500 in person.", "The grant was paid in 2025 in person.", false],
    ["The grant was paid 500 in shares.", "The grant was paid in 2025 in shares.", false],
    ["The award was 500.", "The award was 2025.", false],
    ["The award was 500.", "The award was ２０２５.", false],
    [
      "The hall seats 1800 people on the ground floor.",
      "The hall seats 2020 people on the ground floor.",
      false,
    ],
    ["The hall seats 1800 people.", "The hall seats 2020 people. It opened last year.", true],
    [
      "The cost was stated as a constant 500 dollars.",
      "The cost was stated in constant 2025 dollars.",
      false,
    ],
    [
      "The cost was stated as a constant 500 dollars.",
      "The cost was stated as a constant 2025 dollars.",
      true,
    ],
    [
      "The fee was agreed at about 500 in long negotiations.",
      "The fee was agreed in about 2025 in long negotiations.",
      false,
    ],
    [
      "The fee was agreed in about 500 in long negotiations.",
      "The fee was agreed in about 2025 in long negotiations.",
      false,
    ],
    ["Revenue rose by about 8%.", "Revenue rose to about 12%.", false],
    ["Revenue rose to about 8%.", "Revenue rose to about 12%.", true],
    ["营收增长约8%。", "营收增长至约12%。", false],
    ["营收增长至约8%。", "营收增长至约12%。", true],
    [
      "Total spending by Marketing was $1.2 million.",
      "Total spending by Engineering was $8.1 million.",
      false,
    ],
    [
      "Total spending by Sales was $1.2 million.",
      "Total spending by Sales was $8.1 million.",
      true,
    ],
    ["Sales by Beijing rose to 500 units.", "Sales by Nanjing rose to 600 units.", false],
    ["Revenue earned by Consulting was $500.", "Revenue earned was $600.", false],
    ["Costs covered by financing were 500.", "Costs covered were 600.", false],
    ["Funds raised by giving circles were 500.", "Funds raised were 600.", false],
    ["The rent paid by the Tenant is $500.", "The rent paid is $600.", false],
    ["The rent paid by the Tenant is $500.", "The rent paid by the Tenant is $600.", true],
    [
      "Either party may end it with 30 days' notice.",
      "Either party may end it by giving 45 days' notice.",
      true,
    ],
    [
      "The project was funded by borrowing 500 million.",
      "The project was funded by issuing 600 million.",
      false,
    ],
    ["项目通过借款筹集5亿元。", "项目通过发债筹集6亿元。", false],
    ["由市场部承担的费用为120万元。", "由工程部承担的费用为810万元。", false],
    ["由市场部承担的费用为120万元。", "由市场部承担的费用为810万元。", true],
    ["注册资本增加1000万元。", "注册资本增加为2000万元。", false],
    ["租金上调500元。", "租金上调为3000元。", false],
    ["租金提高500元。", "租金提高为3000元。", false],
    ["租金上涨500元。", "租金上涨为3000元。", false],
    ["营收减少2亿元。", "营收减少为5亿元。", false],
    ["注册资本增加1000万元。", "注册资本增加至2000万元。", false],
    ["注册资本增加至1000万元。", "注册资本增加至2000万元。", true],
    ["注册资本增加为1000万元。", "注册资本增加为2000万元。", true],
    ["Rent rose 500 dollars.", "Rent rose to 3000 dollars.", false],
    ["Rent rose to 2500 dollars.", "Rent rose to 3000 dollars.", true],
    ["租赁期限延长2年。", "租赁期限延长为5年。", false],
    ["付款期限缩短10天。", "付款期限缩短为30天。", false],
    ["成本压缩500万元。", "成本压缩为2000万元。", false],
    ["亏损收窄2000万元。", "亏损收窄为500万元。", false],
    ["授信额度放宽1000万元。", "授信额度放宽为5000万元。", false],
    ["管道加长20米。", "管道加长为50米。", false],
    ["租赁期限延长为2年。", "租赁期限延长为5年。", true],
    ["乙方以设备作抵押，借款500万元。", "乙方以设备作为抵押，借款600万元。", true],
    ["因乙方逾期，违约金为500元。", "因为乙方逾期，违约金为700元。", true],
    ["董事会认为损失为500万元。", "董事会认为损失为800万元。", true],
    ["公司为客户垫付500元。", "公司为客户垫付600元。", true],
    ["持股比例增加公司股本的3%。", "持股比例增加为公司股本的8%。", false],
    ["服务费下调客户合同金额的0.5%。", "服务费下调为客户合同金额的2%。", false],
    ["持股比例增加为公司股本的3%。", "持股比例增加为公司股本的8%。", true],
    ["The lease was extended by 2 years.", "The lease was extended to 5 years.", false],
    ["The lease was extended to 2 years.", "The lease was extended to 5 years.", true],
  ])("for %s from %s: %s", (sentence, quote, offered) => {
    expect(mayRewrite(sentence, quote)).toBe(offered);
  });

  test("for every held-out rewrite the rules write, and for none of the controls", () => {
    for (const each of REWRITE_RULE_CASES.filter((one) => one.kind === "rewritten")) {
      expect(mayRewrite(each.sentence, each.quote), each.id).toBe(true);
    }
    for (const each of REWRITE_CASES) {
      expect(mayRewrite(each.sentence, each.line), each.id).toBe(each.rewrites);
    }
  });
});
