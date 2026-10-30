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
import { checkingModel, type Plan } from "../helpers/checks";
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
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=never a false alarm for the same currency written another way, a sign that may stand for it, a currency the Document names for its sign, the same amount at another scale, or a stated conversion; fails_when="US$54,000" against "USD 54,000", "$" against "$", "RMB" against "元", "¥" against "人民币" or "円", "$" against "C$", "C$" against "$" in a Document in Canadian dollars, or "2万港币" against "2万元" in a Document paid in 港币 is flagged; no_claim=none beyond protects.
  test.each([
    ["The salary is US$54,000.", "The salary is USD 54,000."],
    ["The salary is $54,000.", "The salary is $54,000."],
    ["The salary is 54,000 dollars.", "The salary is $54,000."],
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

describe("A bare $, and ¥ in Chinese text (#2226)", () => {
  const LEASE_FACTS =
    "This lease is governed by the laws of New South Wales, Australia.\nThe premises are at 12 George Street, Sydney NSW 2000.\n";

  // protects=a bare "$" says a dollar, not which: a named dollar against it is asked which, whatever country, law or address the Document gives, while one its Document names, a bare "$" in the sentence and another currency keep their results; fails_when="A$54,000" or "US$54,000" against a bare "$54,000" passes, "Australia" names the dollar, or "£54,000" loses "not £54,000"; no_claim=a real model's verdict.
  test.each([
    ["The rent is A$54,000.", `${LEASE_FACTS}The rent is $54,000 a year.`, "which dollar"],
    ["The rent is US$54,000.", "The rent is $54,000 a year.", "which dollar"],
    ["租金为54,000澳元。", "本合同适用澳大利亚法律。\n租金为每年$54,000。", "which dollar"],
    ["The rent is £54,000.", "The rent is $54,000 a year.", "unit"],
  ])("%s against %j is %s", (claim, cited, kind) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind, amount: "$54,000" });
  });

  test.each([
    ["The rent is A$54,000.", "“$” means Australian dollars.\nThe rent is $54,000 a year."],
    ["The rent is A$54,000.", "Currency: AUD\nThe rent is $54,000 a year."],
    ["租金为54,000澳元。", "本合同中“$”指澳元。\n租金为每年$54,000。"],
    ["The rent is $54,000.", `${LEASE_FACTS}The rent is $54,000 a year.`],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=¥ follows the text's language: in Chinese text it is 人民币, so 日元 against it is asked about with the ¥ reason, and 人民币 or 元 agrees; in Japanese text ¥ is the yen; fails_when="54,000日元" against a Chinese "¥54,000" passes or names another reason, "人民币54,000元" is flagged, or a Japanese "¥" isn't the yen; no_claim=none beyond protects.
  test.each([
    ["费用为54,000日元。", "费用为¥54,000。", "yuan sign"],
    ["The fee is 54,000 yen.", "费用为¥54,000。", "yuan sign"],
    ["The fee is RMB 54,000.", "料金は¥54,000です。", "unit"],
  ])("%s against %j is %s", (claim, cited, kind) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind, amount: "¥54,000" });
  });

  test.each([
    ["费用为人民币54,000元。", "费用为¥54,000。"],
    ["费用为54,000元。", "费用为¥54,000。"],
    ["The fee is 54,000 yen.", "料金は¥54,000です。"],
    ["料金は54,000円です。", "料金は¥54,000です。"],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });
});

describe("Checking a bare $ and ¥ in Chinese text (#2226)", { timeout: 60_000 }, () => {
  const supported = (quote: string) => ({ verdict: "supported" as const, quote, says: quote });
  const contradicted = (quote: string) => ({
    verdict: "contradicted" as const,
    quote,
    says: quote,
    judgement: "conflict" as const,
  });
  const LEASE = {
    name: "Lease.txt",
    contents:
      "Lease\nThis lease is governed by the laws of New South Wales, Australia.\nThe rent is $54,000 a year.\n",
  };
  const DEFINED = {
    name: "Defined lease.txt",
    contents: "Defined lease\n“$” means Australian dollars.\nThe rent is $64,000 a year.\n",
  };
  const ZH_LEASE = {
    name: "租赁合同.txt",
    contents: "租赁合同\n本合同适用澳大利亚法律。\n租金为每年$74,000。\n",
  };
  const FEE = { name: "费用.txt", contents: "费用\n服务费用为¥54,000。\n" };
  const JAPANESE = { name: "料金.txt", contents: "料金\nサービス料金は¥84,000です。\n" };
  const CASES: readonly [string, (typeof LEASE)[], Plan][] = [
    ["The rent is A$54,000 a year.", [LEASE], supported("The rent is $54,000 a year")],
    ["The rent is A$64,000 a year.", [DEFINED], supported("The rent is $64,000 a year")],
    ["租金为每年74,000澳元。", [ZH_LEASE], supported("租金为每年$74,000")],
    ["服务费用为54,000日元。", [FEE], contradicted("服务费用为¥54,000")],
    ["服务费用为人民币54,000元。", [FEE], supported("服务费用为¥54,000")],
    ["The service fee is 84,000 yen.", [JAPANESE], supported("サービス料金は¥84,000です")],
  ];
  const alone = async (claim: string, language: "en" | "zh-CN") => {
    const found = CASES.find(([each]) => each === claim);
    if (!found) throw new Error(`No case for ${claim}`);
    const [, documents, plan] = found;
    const { core } = await setUpWithDocuments(checkingModel({ [claim]: plan }), documents);
    if (language !== "en") await core.updateSettings({ user: { language } });
    return core.checkClaim({ claim });
  };

  // protects=through the core, in English and Chinese: a named dollar against a bare "$" is Unsupported, naming the Document and its "$54,000" without a currency, whatever its governing law; a Document that defines "$" as Australian dollars backs it; 日元 against a Chinese Document's "¥" is Unsupported with the ¥ reason even when the model calls it contradicted, and 人民币 against it is supported; a Japanese Document's "¥" is the yen (#2226); fails_when=any of these checks the other way or gives another reason; no_claim=a real model's verdict.
  test.each(["en", "zh-CN"] as const)("in %s", async (language) => {
    const zh = language === "zh-CN";
    expect(await alone("The rent is A$54,000 a year.", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: zh
          ? "“Lease”写的是“$54,000”，没有注明币种"
          : "“Lease” gives “$54,000” without saying which currency",
      },
    });
    expect(await alone("租金为每年74,000澳元。", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: zh
          ? "“租赁合同”写的是“$74,000”，没有注明币种"
          : "“租赁合同” gives “$74,000” without saying which currency",
      },
    });
    expect(await alone("服务费用为54,000日元。", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: zh
          ? "“费用”写的是“¥54,000”，中文里 ¥ 指人民币"
          : "“费用” gives “¥54,000”, and in Chinese text ¥ means 人民币",
      },
    });
    for (const claim of [
      "The rent is A$64,000 a year.",
      "服务费用为人民币54,000元。",
      "The service fee is 84,000 yen.",
    ]) {
      expect(await alone(claim, language), claim).toMatchObject({ verdict: "supported" });
    }
  });
});

describe("Which dollar a bare $ is, wherever it is written (#2226)", () => {
  const REPORT = "Revenue was $54m in 2025.\nOur Hong Kong subsidiary paid HK$10m in fees.";

  // protects=only a Document's own words, codes, headings, unit lines or definitions say which dollar a bare "$" is: another figure's "HK$" or "A$" never does; a bare "$" in a heading or unit line ("Amount ($)", "($m)", "金额（$）") is as unknown as one on the number; the full-width "＄" and "￥" read as "$" and "¥"; fails_when="HK$54m" or "A$54,000" passes against a bare "$" beside another figure's sign, "US$54m" gets "not US$54m", a heading's "$" reads as US dollars, or "￥" misses the ¥ reason; no_claim=a real model's verdict.
  test.each([
    ["Revenue was HK$54m in 2025.", "Revenue was $54m in 2025.", "which dollar", "$54m", REPORT],
    ["Revenue was US$54m in 2025.", "Revenue was $54m in 2025.", "which dollar", "$54m", REPORT],
    [
      "The rent is A$54,000 a year.",
      "The rent is $54,000 a year.\nThe bond is A$5,000.",
      "which dollar",
      "$54,000",
    ],
    [
      "The rent is A$54,000 a year.",
      "Item\tAmount ($)\nRent\t54,000",
      "which dollar",
      "54,000 ($)",
    ],
    ["The rent is US$54,000 a year.", "Rent ($)\t54,000", "which dollar", "54,000 ($)"],
    ["Revenue was US$54m.", "Results ($m)\nRevenue\t54", "which dollar", "54 ($m)"],
    ["Revenue was A$54m.", "Results ($m)\nRevenue\t54", "which dollar", "54 ($m)"],
    ["租金为54,000美元。", "项目\t金额（$）\n租金\t54,000", "which dollar", "54,000 ($)"],
    ["The rent is A$54,000 a year.", "The rent is ＄54,000 a year.", "which dollar", "＄54,000"],
    ["服务费用为54,000日元。", "服务费用为￥54,000。", "yuan sign", "￥54,000"],
    ["The service fee is 54,000 yen.", "服务费用为￥54,000。", "yuan sign", "￥54,000"],
  ])("%s against %j is %s", (claim, cited, kind, amount, document?: string) => {
    expect(unitNotStated(claim, read(cited, document ?? cited))).toMatchObject({ kind, amount });
  });

  test.each([
    ["The rent is $54,000 a year.", "Item\tAmount ($)\nRent\t54,000", undefined],
    ["Revenue was US$54m.", "Results (US$m)\nRevenue\t54", undefined],
    ["The margin was 12%.", "Margin（％）\t12", undefined],
    [
      "The fee is 84,000 yen.",
      "合計金額 ¥84,000",
      "請求書\n合計金額 ¥84,000\nお支払いは月末までにお願いします。",
    ],
  ])("%s against %j isn't flagged", (claim, cited, document) => {
    expect(unitNotStated(claim, read(cited, document ?? cited))).toBeNull();
  });
});

describe("Checking which dollar a bare $ is (#2226)", { timeout: 60_000 }, () => {
  const plan = (quote: string, verdict: "supported" | "contradicted" = "supported") => ({
    verdict,
    quote,
    says: quote,
    judgement: "conflict" as const,
  });
  const CASES: Readonly<Record<string, readonly [{ name: string; contents: string }, Plan]>> = {
    "Revenue was HK$54m in 2025.": [
      {
        name: "Annual report.txt",
        contents:
          "Annual report\nRevenue was $54m in 2025.\nOur Hong Kong subsidiary paid HK$10m in fees.\n",
      },
      plan("Revenue was $54m in 2025"),
    ],
    "The rent is US$54,000 a year.": [
      { name: "Rent table.txt", contents: "Rent table\nItem\tAmount ($)\nRent\t54,000\n" },
      plan("Rent\t54,000"),
    ],
    "The rent is $54,000 a year.": [
      { name: "Rent table.txt", contents: "Rent table\nItem\tAmount ($)\nRent\t54,000\n" },
      plan("Rent\t54,000"),
    ],
    "租金为64,000美元。": [
      { name: "租金表.txt", contents: "租金表\n项目\t金额（$）\n租金\t64,000\n" },
      plan("租金\t64,000"),
    ],
    "服务费用为54,000日元。": [
      { name: "费用.txt", contents: "费用\n服务费用为￥54,000。\n" },
      plan("服务费用为￥54,000", "contradicted"),
    ],
  };
  const alone = async (claim: string, language: "en" | "zh-CN") => {
    const found = CASES[claim];
    if (!found) throw new Error(`No case for ${claim}`);
    const [document, scripted] = found;
    const { core } = await setUpWithDocuments(checkingModel({ [claim]: scripted }), [document]);
    if (language !== "en") await core.updateSettings({ user: { language } });
    return core.checkClaim({ claim });
  };

  // protects=through the core, in English and Chinese: another figure's "HK$" never says which dollar a bare "$" is, a heading's bare "$" is as unknown as one on the number, and a full-width "￥" in Chinese text is 人民币 even when the model calls the sentence contradicted, while a bare "$" against a bare "$" heading stays supported; fails_when=any of these checks the other way or names the dollar; no_claim=a real model's verdict.
  test.each(["en", "zh-CN"] as const)("in %s", async (language) => {
    const zh = language === "zh-CN";
    const which = (document: string, amount: string) =>
      zh
        ? `“${document}”写的是“${amount}”，没有注明币种`
        : `“${document}” gives “${amount}” without saying which currency`;
    expect(await alone("Revenue was HK$54m in 2025.", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: which("Annual report", "$54m") },
    });
    expect(await alone("The rent is US$54,000 a year.", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: which("Rent table", "54,000 ($)") },
    });
    expect(await alone("租金为64,000美元。", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: which("租金表", "64,000 ($)") },
    });
    expect(await alone("服务费用为54,000日元。", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: zh
          ? "“费用”写的是“￥54,000”，中文里 ¥ 指人民币"
          : "“费用” gives “￥54,000”, and in Chinese text ¥ means 人民币",
      },
    });
    expect(await alone("The rent is $54,000 a year.", language)).toMatchObject({
      verdict: "supported",
    });
  });
});

const LONG_TABLE = (heading: string, rent: string) =>
  `Item\tAmount (${heading})\n${Array.from({ length: 60 }, (_, at) => `Item ${at + 1}\t${1000 + at}`).join("\n")}\nRent\t${rent}`;
const FEE_LIST = "费用清单\n以下为本公司的服务费用明细，请于月底前支付。\nFee\t¥54,000\n";
const ROWS = Array.from({ length: 60 }, (_, at) => `Segment ${at + 1}\t${100 + at}`).join("\n");
const STATE_SALES = "Sales by state: CA $54m, TX $30m.";
const TERRITORY_REVENUE = "Revenue by state: NSW $120m, VIC $80m, NT $54m.";
const JA_FEES =
  "料金表\n以下は当社のサービス料金です。月末までにお支払いください。\nFee\t¥54,000\n";

describe("A dollar named beside its amount, and a plain number under a bare $ (#2226)", () => {
  // protects=a code, a name or a country prefix beside a "$" says which dollar it is, so the amount is in that dollar and not a bare "$", while a lone letter before it ("A $54,000 fee") stays an article; a plain number whose Document writes a dollar only by a bare "$" or "dollars", in a heading the cited text lost, a unit line or another figure, is asked which dollar, and one whose Document names no currency keeps its reason; a Chinese Document's "¥" is 人民币 and a Japanese one's the yen, even on a line in neither language; a "($m)" heading gives only a dollar figure its scale; "CA" and "NT" before a spaced "$" are a state or territory, joined ("CA$") the Canadian dollar; fails_when="$54,000 AUD" backs "US$54,000" (even where the Document mentions USD) or is backed by "HK$54,000", 日元 passes against a Chinese Document's "¥" or RMB against a Japanese one's, "€54m" passes against a "($m)" heading, "CA $54m" reads as Canadian dollars, "US $54m" backs "A$54m", a truly bare "$54,000" backs "US$54,000", or a plain number under a lost "Amount ($)", "All amounts are in dollars." or beside another figure's "$5,000" backs "US$"; no_claim=a real model's verdict.
  test.each([
    ["The fee is US$54,000.", "The fee is $54,000 AUD.", "unit", "$54,000 AUD"],
    [
      "The fee is US$54,000.",
      "The fee is $54,000 AUD.",
      "unit",
      "$54,000 AUD",
      "Invoice in USD and AUD.\nThe fee is $54,000 AUD.",
    ],
    ["The fee is $54,000 AUD.", "The fee is HK$54,000.", "unit", "HK$54,000"],
    ["服务费用为54,000日元。", "Fee\t¥54,000", "yuan sign", "¥54,000", FEE_LIST],
    ["The fee is RMB 54,000.", "Fee\t¥54,000", "unit", "¥54,000", JA_FEES],
    ["Revenue was €54m.", "Revenue\t54", "scale", "54", "Results ($m)\nRevenue\t54"],
    ["Revenue was £54m.", "Revenue\t54", "scale", "54", "Results ($m)\nRevenue\t54"],
    ["Revenue was ¥54m.", "Revenue\t54", "scale", "54", "Results ($m)\nRevenue\t54"],
    ["欧洲营收为€54m。", "Revenue\t54", "scale", "54", "Results ($m)\nRevenue\t54"],
    ["California sales were US$54m.", STATE_SALES, "which dollar", "$54m"],
    ["Northern Territory revenue was A$54m.", TERRITORY_REVENUE, "which dollar", "$54m"],
    ["Revenue was US$54m.", "Revenue was CA$54m.", "unit", "CA$54m"],
    ["The fee is A$54,000.", "The fee is $54,000 USD.", "unit", "$54,000 USD"],
    ["Revenue was A$54m in 2025.", "Revenue was US $54m in 2025.", "unit", "US $54m"],
    ["租金为54,000美元。", "租金为$54,000 AUD。", "unit", "$54,000 AUD"],
    ["The fee is US$54,000.", "The fee is $54,000.", "which dollar", "$54,000"],
    ["The fee is A$54,000.", "A $54,000 fee is due.", "which dollar", "$54,000"],
    [
      "The rent is US$74,000 a year.",
      "Rent\t74,000",
      "which dollar",
      "74,000",
      LONG_TABLE("$", "74,000"),
    ],
    [
      "The rent is US$54,000 a year.",
      "The rent is 54,000 a year.",
      "which dollar",
      "54,000",
      "All amounts are in dollars.\nThe rent is 54,000 a year.",
    ],
    [
      "The rent is US$54,000 a year.",
      "All amounts are in $.\nThe rent is 54,000 a year.",
      "which dollar",
      "54,000",
    ],
    [
      "The rent is US$64,000 a year.",
      "The rent is 64,000 a year and the bond is $5,000.",
      "which dollar",
      "64,000",
    ],
    ["Revenue was US$54m.", "Revenue\t54", "which dollar", "54", "Results ($m)\nRevenue\t54"],
    ["The rent is US$64,000 a year.", "The rent is 64,000 a year.", "currency", "64,000"],
  ])("%s against %j is %s", (claim, cited, kind, amount, document?: string) => {
    expect(unitNotStated(claim, read(cited, document ?? cited))).toMatchObject({ kind, amount });
  });

  test.each([
    ["The fee is US$54,000.", "The fee is $54,000 USD."],
    ["The rent is A$54,000 a year.", "The rent is $54,000 AUD a year."],
    ["The fee is $54,000 AUD.", "The fee is A$54,000."],
    ["服务费用为人民币54,000元。", "Fee\t¥54,000", FEE_LIST],
    ["The fee is 54,000 yen.", "Fee\t¥54,000", JA_FEES],
    ["Revenue was €54m.", "Revenue\t54", "Results (€m)\nRevenue\t54"],
    ["California sales were $54m.", STATE_SALES],
    [
      "California sales were US$54m.",
      STATE_SALES,
      `All amounts are in US dollars.\n${STATE_SALES}`,
    ],
    ["加州销售额为5400万美元。", STATE_SALES, `All amounts are in US dollars.\n${STATE_SALES}`],
    [
      "Northern Territory revenue was A$54m.",
      TERRITORY_REVENUE,
      `All amounts are in Australian dollars.\n${TERRITORY_REVENUE}`,
    ],
    ["Revenue was C$54m.", "Revenue was CA$54m."],
    ["Revenue was US$54m in 2025.", "Revenue was US $54m in 2025."],
    ["The fee is US$54,000.", "The fee is $54,000 US dollars."],
    ["The fee is US$54,000.", "The fee is U.S. $54,000."],
    ["The fee is HK$54,000.", "The fee is HK $54,000."],
    ["租金为54,000澳元。", "租金为$54,000 AUD。"],
    ["费用为54,000美元。", "费用为$54,000美元。"],
    ["The fee is $54,000.", "The fee is $54,000 USD."],
    ["The rent is US$74,000 a year.", "Rent\t74,000", LONG_TABLE("USD", "74,000")],
    ["The rent is $74,000 a year.", "Rent\t74,000", LONG_TABLE("$", "74,000")],
    [
      "The rent is US$54,000 a year.",
      "The rent is 54,000 a year.",
      "All amounts are in US dollars.\nThe rent is 54,000 a year.",
    ],
    ["The rent is US$64,000 a year.", "The rent is 64,000 a year and the bond is US$5,000."],
    ["Revenue was US$54m.", "Revenue\t54", "Results (US$m)\nRevenue\t54"],
    ["Revenue was $54m.", "Revenue\t54", "Results ($m)\nRevenue\t54"],
  ])("%s against %j isn't flagged", (claim, cited, document?: string) => {
    expect(unitNotStated(claim, read(cited, document ?? cited))).toBeNull();
  });
});

describe("Checking a dollar named beside its amount, and a plain number under a bare $ (#2226)", {
  timeout: 60_000,
}, () => {
  const supported = (quote: string) => ({ verdict: "supported" as const, quote, says: quote });
  const INVOICE = { name: "Invoice.txt", contents: "Invoice\nThe fee is $54,000 USD.\n" };
  const MIXED = {
    name: "Mixed invoice.txt",
    contents: "Mixed invoice\nInvoice in USD and AUD.\nThe fee is $34,000 AUD.\n",
  };
  const BARE = { name: "Bare invoice.txt", contents: "Bare invoice\nThe fee is $64,000.\n" };
  const TABLE = { name: "Table.txt", contents: `Table\n${LONG_TABLE("$", "74,000")}\n` };
  const USD_TABLE = {
    name: "USD table.txt",
    contents: `USD table\n${LONG_TABLE("USD", "84,000")}\n`,
  };
  const RENT = {
    name: "Rent.txt",
    contents: "Rent\nAll amounts are in dollars.\nThe rent is 54,000 a year.\n",
  };
  const US_RENT = {
    name: "US rent.txt",
    contents: "US rent\nAll amounts are in US dollars.\nThe deposit is 44,000.\n",
  };
  const BOND = {
    name: "Bond.txt",
    contents: "Bond\nThe rent is 64,000 a year and the bond is $5,000.\n",
  };
  const CASES: Readonly<Record<string, readonly [{ name: string; contents: string }, Plan]>> = {
    "The fee is US$54,000.": [INVOICE, supported("The fee is $54,000 USD")],
    "The fee is A$54,000.": [INVOICE, supported("The fee is $54,000 USD")],
    "The fee is US$34,000.": [MIXED, supported("The fee is $34,000 AUD")],
    "Revenue was €94m.": [
      { name: "Results.txt", contents: `Results\nSegment\tRevenue ($m)\n${ROWS}\nEurope\t94\n` },
      supported("Europe\t94"),
    ],
    "Revenue was $94m.": [
      { name: "Results.txt", contents: `Results\nSegment\tRevenue ($m)\n${ROWS}\nEurope\t94\n` },
      supported("Europe\t94"),
    ],
    "Revenue was €84m.": [
      {
        name: "Euro results.txt",
        contents: `Euro results\nSegment\tRevenue (€m)\n${ROWS}\nEurope\t84\n`,
      },
      supported("Europe\t84"),
    ],
    "California sales were US$54m.": [
      { name: "Sales.txt", contents: `Sales\nAll amounts are in US dollars.\n${STATE_SALES}\n` },
      supported(STATE_SALES),
    ],
    "California sales were US$64m.": [
      { name: "State sales.txt", contents: "State sales\nSales by state: CA $64m, TX $30m.\n" },
      supported("Sales by state: CA $64m, TX $30m."),
    ],
    "The fee is A$34,000.": [MIXED, supported("The fee is $34,000 AUD")],
    "The rent is A$54,000 a year.": [
      { name: "Lease.txt", contents: "Lease\nThe rent is $54,000 AUD a year.\n" },
      supported("The rent is $54,000 AUD a year"),
    ],
    "Revenue was US$54m in 2025.": [
      { name: "Report.txt", contents: "Report\nRevenue was US $54m in 2025.\n" },
      supported("Revenue was US $54m in 2025"),
    ],
    "The fee is US$64,000.": [BARE, supported("The fee is $64,000")],
    "The rent is US$74,000 a year.": [TABLE, supported("Rent\t74,000")],
    "The rent is US$84,000 a year.": [USD_TABLE, supported("Rent\t84,000")],
    "The rent is US$54,000 a year.": [RENT, supported("The rent is 54,000 a year")],
    "The deposit is US$44,000.": [US_RENT, supported("The deposit is 44,000")],
    "The rent is US$64,000 a year.": [BOND, supported("The rent is 64,000 a year")],
  };
  const alone = async (claim: string, language: "en" | "zh-CN") => {
    const found = CASES[claim];
    if (!found) throw new Error(`No case for ${claim}`);
    const [document, scripted] = found;
    const { core } = await setUpWithDocuments(checkingModel({ [claim]: scripted }), [document]);
    if (language !== "en") await core.updateSettings({ user: { language } });
    return core.checkClaim({ claim });
  };

  // protects=through the core, in English and Chinese, with the model calling every sentence supported: "$54,000 USD", "$54,000 AUD" and "US $54m" back the dollar they name, and "$54,000 USD" doesn't back "A$54,000"; a truly bare "$64,000", a plain number under a 60-row table's "Amount ($)" heading, one under "All amounts are in dollars." and one beside another figure's "$5,000" are Unsupported, naming the Document and the amount without a currency, while "Amount (USD)" and "All amounts are in US dollars." back US$ (#2226); "€94m" against row 62 of a "Revenue ($m)" table keeps the scale reason while "$94m" there and "€84m" under "Revenue (€m)" are supported; "CA $54m" in a state table is a bare "$", supported for US$ where the Document says US dollars and asked which where it doesn't; fails_when=any of these checks the other way or gives another reason; no_claim=a real model's verdict.
  test.each(["en", "zh-CN"] as const)("in %s", async (language) => {
    const zh = language === "zh-CN";
    const which = (document: string, amount: string) =>
      zh
        ? `“${document}”写的是“${amount}”，没有注明币种`
        : `“${document}” gives “${amount}” without saying which currency`;
    for (const claim of [
      "The fee is US$54,000.",
      "The rent is A$54,000 a year.",
      "Revenue was US$54m in 2025.",
      "The rent is US$84,000 a year.",
      "The deposit is US$44,000.",
      "The fee is A$34,000.",
      "Revenue was $94m.",
      "Revenue was €84m.",
      "California sales were US$54m.",
    ]) {
      expect(await alone(claim, language), claim).toMatchObject({ verdict: "supported" });
    }
    expect(await alone("The fee is A$54,000.", language)).toMatchObject({
      verdict: "unsupported",
    });
    expect(await alone("The fee is US$34,000.", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: zh
          ? "文档写的是 $34,000 AUD，不是 US$34,000。"
          : "The Document gives $34,000 AUD, not US$34,000.",
      },
    });
    expect(await alone("Revenue was €94m.", language)).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: zh ? "文档写的是 94，不是 €94m。" : "The Document gives 94, not €94m.",
      },
    });
    for (const [claim, document, amount] of [
      ["The fee is US$64,000.", "Bare invoice", "$64,000"],
      ["The rent is US$74,000 a year.", "Table", "74,000"],
      ["The rent is US$54,000 a year.", "Rent", "54,000"],
      ["The rent is US$64,000 a year.", "Bond", "64,000"],
      ["California sales were US$64m.", "State sales", "$64m"],
    ] as const) {
      expect(await alone(claim, language), claim).toMatchObject({
        verdict: "unsupported",
        unsupported: { reason: which(document, amount) },
      });
    }
  });
});

describe("A figure row's number in another currency (#1452)", () => {
  // protects=with the numbers a figure's row was bound to, an amount of the same value in another currency is found, and the same currency written another way isn't; fails_when="人民币两万元" bound to "2万美元" passes, or "US$54,000" bound to "USD 54,000" is flagged; no_claim=whether the row binds such a number, which the figure check decides.
  test.each([
    ["人民币两万元", "乙方每月支付租金2万美元。", "2万美元", "USD", 1e4, "2万美元"],
    ["£54,000", "The annual salary is $54,000.", "$54,000", "USD", 1, "$54,000"],
    ["US$54,000", "The annual salary is USD 54,000.", "USD 54,000", "USD", 1, null],
  ] as const)("%s bound to %j", (claim, cited, chars, code, scale, amount) => {
    const bound = [{ chars, unit: { kind: "currency" as const, code }, scale }];
    const found = unitNotStated(claim, read(cited), bound);
    if (amount === null) expect(found).toBeNull();
    else expect(found).toMatchObject({ kind: "unit", amount });
  });

  // protects=a row bound to a bare "$" is asked which dollar, as a sentence is (#2226); fails_when="US$54,000" bound to "$54,000" passes; no_claim=none beyond protects.
  test("a named dollar bound to a bare $ doesn't say which", () => {
    const bound = [
      { chars: "$54,000", unit: { kind: "currency" as const, code: "USD" }, scale: 1 },
    ];
    expect(unitNotStated("US$54,000", read("The annual salary is $54,000."), bound)).toMatchObject({
      kind: "which dollar",
      amount: "$54,000",
    });
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
  // protects=a Latin symbol stands alone: a letter, an apostrophe, a dot or a hyphen beside it makes it a word ("t" in "don't", "m" in "I'm", "T" in （T恤）, "t" in tea, "g" in e.g., "m" in 9 a.m., "T" in T-shirt, "t" in t-test, "L" in L.P.), and a digit after it makes a product ("m" in 27m3); fails_when="54,000 tonnes" against "We don't ship 54,000 a year." or "54 kilometres" against "27m3" passes; no_claim=whether the figure is right.
  test.each([
    ["The mill's output was 54,000 tonnes.", "We don't ship 54,000 a year.", "54,000"],
    ["The route was 54 kilometres.", "I'm sure the route was 54.", "54"],
    ["The mill's output was 54,000 tonnes.", "款式（T恤）\t54,000", "54,000"],
    ["The mill's output was 54,000 tonnes.", "Units: tea\nOutput\t54,000", "54,000"],
    ["The mill's output was 54,000 tonnes.", "The output was 54,000 at the kiosk.", "54,000"],
    ["The route was 54 kilometres.", "We poured 27m3 of gravel; the route is 54.", "54"],
    ["The mill's output was 54,000 tonnes.", "See e.g. the annex. Output 54,000.", "54,000"],
    ["The route was 54 kilometres.", "Open from 9 a.m.; the route is 54.", "54"],
    ["The mill's output was 54,000 tonnes.", "T-shirt sales 54,000.", "54,000"],
    ["The mill's output was 54,000 tonnes.", "Output 54,000 — the t-test is valid", "54,000"],
    ["The mill's output was 54,000 tonnes.", "Grade A-t steel; output 54,000.", "54,000"],
    ["The tank held 54 litres.", "Smith L.P. holds a tank of 54.", "54"],
    ["The mill's output was 54,000 tonnes.", "We sold 5 T-shirts; output was 54,000.", "54,000"],
    ["The mill's output was 54,000 tonnes.", "We ran 2 t-tests; output was 54,000.", "54,000"],
    ["The tank held 54 litres.", "We fitted 3 L-brackets; the tank holds 54.", "54"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=a Han symbol is not the first character of a word after a figure, on a unit line or in a heading: 克 in 克服, 克林工厂, 克等级 and （克林工厂）, 米 in 大米, 米其林 and 一米的, 升 in 升迁 and 升等; fails_when="54,000吨" against "克服困难，产量54,000", "单位：克林工厂" or "（克林工厂）" passes; no_claim=the value.
  test.each([
    ["产量为54,000吨。", "克服困难，产量54,000", "54,000"],
    ["路线长54公里。", "大米\t54", "54"],
    ["产量为54,000吨。", "单位：克林工厂\n产量\t54,000", "54,000"],
    ["路线长54公里。", "单位：米其林轮胎\n路线长54", "54"],
    ["容量为54升。", "单位：升迁记录\n容量\t54", "54"],
    ["产量为54,000吨。", "（克林工厂）\t54,000", "54,000"],
    ["路线长54公里。", "统一米的价格，路线长54", "54"],
    ["产量为54,000吨。", "单位：克等级\n产量54,000", "54,000"],
    ["容量为54升。", "单位：升等记录\n容量54", "54"],
    ["产量为54,000吨。", "每克服一个困难，产量54,000", "54,000"],
    ["容量为54升。", "温度每升高1度，容量54", "54"],
    ["重量为54克。", "每克拉售价2万元，重量54", "54"],
    ["容量为54升。", "每升级一次，容量54", "54"],
    ["重量为54克。", "每克隆一次，重量54", "54"],
    ["路线长54公里。", "每米其林指南，路线长54", "54"],
    ["路线长54公里。", "第3单元/米兰站，路线长54", "54"],
    ["产量为54,000吨。", "第3单元/吨位分析，产量54,000", "54,000"],
    ["容量为54升。", "多元/升级转型，容量54", "54"],
    ["产量为54,000吨。", "报价540/吨左，产量54,000", "54,000"],
    ["容量为54升。", "美元/升级版，容量54", "54"],
    ["容量为54升。", "价格每升至新高，容量54", "54"],
    ["路线长54米。", "汤圆/米粉，路线长54", "54"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=a lone Chinese numeral does not turn a word into a figure's unit: 克 in 统一克服 and 万一克服 and 十克拉, 升 in 统一升级, 桶 in 第一桶金, 米 in 一米阳光; fails_when=any passes; no_claim=the value.
  test.each([
    ["产量为54,000吨。", "统一克服困难，产量54,000", "54,000"],
    ["产量为54,000吨。", "万一克服不了，产量54,000", "54,000"],
    ["容量为54升。", "系统统一升级，容量54", "54"],
    ["产量为54,000桶。", "赚到第一桶金，产量54,000", "54,000"],
    ["重量为54克。", "十克拉钻石，重量54", "54"],
    ["路线长54公里。", "一米阳光项目，路线长54", "54"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=a slash after a figure does not turn the start of a word into a unit: 克 in 2026/克林工厂, 米 in 2026/米兰公司; fails_when=an invented unit behind a year and a slash passes; no_claim=the value.
  test.each([
    ["产量为54,000吨。", "报表编号2026/克林工厂\n产量54,000", "54,000"],
    ["路线长54公里。", "报表编号2026/米兰公司\n路线长54", "54"],
  ])("%s against %j gives %s", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", amount });
  });

  // protects=a real unit Documents write beside a rate, a comma, a year or a label states the measure: "540 €/t", "$/t", "(USD per t)", "(t, 2024)", "(metric t)", "Output, t", "in t", "Unit of measure: t", "元/吨", "单位为吨", "单位：克", "10万t", "60,000t左右", "100万L", "540/吨的货物", "元/吨的货物", "每吨", "（吨）"; fails_when=any of these is Unsupported; no_claim=the value.
  test.each([
    ["The mill's output was 54,000 tonnes.", "Price 540 €/t; output 54,000"],
    ["The mill's output was 54,000 tonnes.", "Price $/t: 540\nOutput 54,000"],
    ["The mill's output was 54,000 tonnes.", "Cost (USD per t)\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output (t, 2024)\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Volume (metric t)\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output, t\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output in t: 54,000"],
    ["The mill's output was 54,000 tonnes.", "Unit of measure: t\nOutput 54,000"],
    ["The mill's output was 54,000 tonnes.", "Units: t\nOutput\t54,000"],
    ["产量为54,000吨。", "价格3,500元/吨；产量54,000"],
    ["产量为54,000吨。", "单位为吨\n产量54,000"],
    ["产量为54,000吨。", "单位是吨\n产量54,000"],
    ["重量为54克。", "单位：克\n重量\t54"],
    ["产量为54,000吨。", "（吨）\t54,000"],
    ["产量为54,000吨。", "年产10万t，产量54,000"],
    ["产量为54,000吨。", "运量达60,000t左右，产量54,000"],
    ["The mill's output was 54,000 tonnes.", "Capacity 5万t; output 54,000"],
    ["容量为54,000升。", "储量100万L，容量54,000"],
    ["产量为54,000吨。", "报价540/吨的货物，产量54,000"],
    ["产量为54,000吨。", "价格3,500元/吨的货物，产量54,000"],
    ["产量为54,000吨。", "按每吨3,500元计，产量54,000"],
    ["产量为54,000吨。", "每吨成本3,500元，产量54,000"],
    ["产量为54,000吨。", "每吨价格3,500元；产量54,000"],
    ["容量为54升。", "每升油价8元；容量54"],
    ["产量为54,000吨。", "价格3,500元/吨和运费，产量54,000"],
    ["产量为54,000吨。", "成本（元/吨钢）\t54,000"],
    ["产量为54,000吨。", "3,500美元/吨，产量54,000"],
    ["产量为54,000吨。", "报价540/吨左右，产量54,000"],
    ["The mill's output was 54,000 tonnes.", "Output 54,000 t-CO2e; output 54,000."],
    ["The mill's output was 54,000 tonnes.", "A 54-t crane lifted it; output 54,000."],
    ["产量为54,000吨。", "540/吨和运费，产量54,000"],
    ["产量为54,000吨。", "540/吨钢，产量54,000"],
    ["容量为54升。", "加注50升到油箱，容量54"],
    ["路线长54米。", "长3米其余为空地，路线长54"],
    ["重量为54克。", "重500克拉面，重量54"],
    ["产量为54,000吨。", "吨钢成本540元，产量54,000"],
    ["容量为54升。", "价格8元/升等，容量54"],
    ["容量为54升。", "价格8元/升至10元，容量54"],
    ["路线长54米。", "造价3万元/米其中含税，路线长54"],
    ["The plate was 5 millimetres thick.", "The plate is 5 mm-thick."],
    ["产量为54,000吨。", "产量54,000，另有一吨。"],
    ["容量为54升。", "容量54，另有十升。"],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=a unit already stated in any other shape stays stated: no space ("54,000t"), a scale word ("5.4万吨"), a fullwidth heading ("（T）"), a rate heading ("(t/yr)", "（吨/年）"), a capital letter, another figure's unit, a space before a Chinese character, or a volume as "27m3"; fails_when=any of these is Unsupported; no_claim=the value.
  test.each([
    ["The mill's output was 54,000 tonnes.", "Output was 54,000t."],
    ["The mill's output was 54,000 tonnes.", "Output （T）\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output (t/yr)\t54,000"],
    ["产量为54,000吨。", "产量（吨/年）\t54,000"],
    ["The mill's output was 54,000 tonnes.", "Output: 54,000. Last year: 42,000 t."],
    ["The route was 54 kilometres.", "Distance: 54. The return leg was 27 m."],
    ["产量为54,000吨。", "2025年产量5.4万吨\n2024年产量54,000"],
    ["产量为54,000吨。", "产量 54,000 吨"],
    ["产量为54,000吨。", "单位：吨\n产量\t54,000"],
    ["产量为54,000吨。", "单位：吨（万吨）\n产量\t54,000"],
    ["产量为54,000吨。", "单位：吨/年\n产量\t54,000"],
    ["The mill's output was 54,000 tonnes.", "The price was 54,000/t."],
    ["The mill's output was 54,000 tonnes.", "Cost ($/t)\t54,000"],
    ["产量为54,000吨。", "成本（¥/吨）\t54,000"],
    ["路线长54公里。", "今年新增路段54米，路线长54。"],
    ["The volume was 27 cubic metres.", "We poured 27m3 of gravel."],
  ])("%s against %j isn't flagged", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });
});

describe("A bare dollar beside a unit symbol (#2225, #2226)", () => {
  // protects=each rule finds its own figure and neither hides the other: a Document that gives the dollar and the unit passes, another figure's unit doesn't hide the bare dollar, a Document that gives only the dollar still finds the unit, and a "$" inside a rate heading states no dollar for the figure while the same heading states the measure; fails_when=either rule makes the other's problem pass; no_claim=which dollar it is, or whether the figure is right.
  test("the Document gives both the dollar and the unit", () => {
    expect(
      unitNotStated(
        "The fee was $54,000 for 54,000 tonnes.",
        read("The fee was $54,000 and the mass was 54,000 t."),
      ),
    ).toBeNull();
  });

  test("another figure's unit does not hide the bare dollar", () => {
    expect(
      unitNotStated(
        "The fee was $54,000 for 42,000 tonnes.",
        read("The fee was 54,000 and the mass was 42,000 t."),
      ),
    ).toMatchObject({ kind: "currency", amount: "54,000" });
  });

  test("the Document gives only the dollar", () => {
    expect(
      unitNotStated(
        "The fee was $54,000 for 54,000 tonnes.",
        read("The fee was $54,000 and the mass was 54,000."),
      ),
    ).toMatchObject({ kind: "unit", amount: "54,000" });
  });

  test("a rate heading states the measure but not which dollar", () => {
    expect(unitNotStated("The output was 54,000 tonnes.", read("Cost ($/t)\t54,000"))).toBeNull();
    expect(
      unitNotStated("The cost was $54,000 a tonne.", read("Cost ($/t)\t54,000")),
    ).toMatchObject({ kind: "currency", amount: "54,000" });
  });
});

describe("Checking a figure in another currency or unit", { timeout: 30_000 }, () => {
  const LETTER = {
    name: "Offer letter.txt",
    contents:
      "Offer letter\nAll amounts in this letter are in US dollars.\nThe annual salary is $54,000, paid monthly.\n",
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

  test("a slash after a year doesn't make the start of a word a unit", async () => {
    expect(
      await checkIn(
        "产量为54,000吨。",
        { name: "报表.txt", contents: "报表编号2026/克林工厂\n产量54,000\n" },
        "zh-CN",
      ),
    ).toMatchObject({
      verdict: "unsupported",
      unsupported: { reason: "文档写的是 54,000，不是 54,000吨。" },
    });
  });
});
