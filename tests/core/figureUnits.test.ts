/**
 * A figure keeps exactly the units its Document states (#1332): a currency the
 * Document doesn't state, added to a figure it does, leaves the sentence
 * unsupported, naming the currency as the part not found, and a written one is
 * cut before it lands; a percent where the Document gives percentage points,
 * or points where it gives a percent, is unsupported too; and the assistant is
 * told never to add one.
 */
import { describe, expect, test } from "vitest";
import { type CheckedText, unitNotStated } from "../../src/core/answers/checks/units";
import { documentInstructions } from "../../src/core/answers/prompt";
import { INLINE_NODE } from "../../src/shared/sentences";
import { askAssistant, changesIn } from "../helpers/assistant";
import {
  checkGenerate,
  checkingModel,
  checkReply,
  isCheckRun,
  sentenceOf,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { shownWithChanges } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const CONTRACT = {
  name: "Employment agreement.txt",
  contents:
    "Employment agreement between Harbourline Ltd and the Employee.\nThe annual salary is 54,000, paid monthly in arrears.\nThe notice period is three months.\n",
};
const STATED = "The annual salary is 54,000, paid monthly in arrears";

const read = (cited: string, document = cited): CheckedText[] => [
  { cited: () => cited, document: () => document },
];

describe("A currency the Document doesn't state", () => {
  test("a unit problem preserves two matching occurrences inside one cited page", () => {
    const [text] = read("The other balance is 600. Net debt is 600.0.");
    if (!text) throw new Error("Missing synthetic page.");
    const result = unitNotStated("Net debt is £600.", [text]);
    expect(result).toMatchObject({ kind: "currency", amount: "600" });
    expect(result?.matches).toEqual([
      { text, start: text.cited().indexOf("600") },
      { text, start: text.cited().lastIndexOf("600") },
    ]);
  });

  test("a unit problem keeps every matching source, including another spelling of the same value", () => {
    const texts = [...read("Net debt is 600."), ...read("The other balance is 600.0.")];
    const result = unitNotStated("Net debt is £600.", texts);
    expect(result).toMatchObject({ kind: "currency", amount: "600" });
    expect(result?.matches.map(({ text }) => text)).toEqual(texts);
  });

  // protects=a currency added to a figure the cited text states as a plain number, which the Document never names, is found, as the sentence writes it apart from the number, in English and Chinese, "¥" and Chinese numerals included; fails_when="£54,000" against "54,000" passes, "¥" passes, or "五万四千英镑" is named as the currency; no_claim=other units, which the model judges.
  test.each([
    ["The annual salary is £54,000.", "£"],
    ["年薪为 54,000英镑。", "英镑"],
    ["年薪为五万四千英镑。", "英镑"],
    ["The salary is GBP 54,000.", "GBP"],
    ["Salary: $54k a year.", "$"],
    ["The annual salary is ¥54,000.", "¥"],
    ["年薪为¥54,000。", "¥"],
  ])("%s adds %s", (claim, currency) => {
    expect(unitNotStated(claim, read(STATED, CONTRACT.contents))).toMatchObject({
      kind: "currency",
      currency,
      amount: "54,000",
    });
  });

  // protects=only a currency the Document names counts: "元" inside 单元, figures elsewhere in more than one currency ("$" and "HK$"), a lowercase "php" and a stated sign of another currency don't name the one the sentence adds, and a scale its table states ("in thousands") doesn't hide it; fails_when=any of these hides the added currency; no_claim=none beyond protects.
  test("a calculated ratio does not settle an added monetary unit or scale", () => {
    const claim =
      "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x covenant.";
    const cited = "Net debt at 30 June 2026 528.9";
    expect(unitNotStated(claim, read(cited))).toMatchObject({
      kind: "scale",
      figure: "£528.9m",
      amount: "528.9",
    });
    expect(unitNotStated(claim, read("Net debt at 30 June 2026 £528.9m"))).toBeNull();
    expect(
      unitNotStated(
        claim,
        read("All amounts are in GBP millions.\nNet debt at 30 June 2026 528.9"),
      ),
    ).toBeNull();
    expect(unitNotStated("Leverage was 2.82x.", read(cited))).toBeNull();
  });

  test("a scale statement belongs to the Document that supplies the figure", () => {
    const claim =
      "Net debt at 30 June 2026 was £528.9m, so leverage should still be inside the 3.25x covenant.";
    const plain = read("Net debt at 30 June 2026 528.9");
    const other = read("All amounts are in GBP millions.\nOther results 100.0");
    expect(unitNotStated(claim, [...plain, ...other])).toMatchObject({
      kind: "scale",
      figure: "£528.9m",
      amount: "528.9",
    });
  });

  test("a plain scale statement does not establish a currency", () => {
    const claim = "Net debt at 30 June 2026 was £528.9m.";
    const plain = "All amounts are in millions.\nNet debt at 30 June 2026 528.9";
    expect(unitNotStated(claim, read(plain))).toMatchObject({
      kind: "currency",
      currency: "£",
      amount: "528.9",
    });
    expect(
      unitNotStated("Net debt at 30 June 2026 was 528.9m.", read("Net debt at 30 June 2026 528.9")),
    ).toMatchObject({
      kind: "scale",
      figure: "528.9m",
      amount: "528.9",
    });
    expect(unitNotStated("Net debt at 30 June 2026 was 528.9m.", read(plain))).toBeNull();
    expect(
      unitNotStated(claim, read("All amounts are in millions.\nNet debt at 30 June 2026 £528.9")),
    ).toBeNull();
  });

  test("the same written number at another scale is not supported in Chinese either", () => {
    const claim = "2026年6月30日净负债为£528.9m，因此杠杆率仍应在3.25倍的契约上限之内。";
    expect(unitNotStated(claim, read("2026年6月30日净负债 528.9"))).toMatchObject({
      kind: "scale",
      figure: "£528.9m",
      amount: "528.9",
    });
  });

  test.each([
    ["第三单元 薪酬\n年薪为 54,000，按月支付。", "年薪为 54,000元。", "元"],
    [
      STATED,
      "The annual salary is $54,000.",
      "$",
      `The signing bonus is $5,000 and the relocation allowance HK$8,000.\n${STATED}.`,
    ],
    [STATED, "The annual salary is PHP 54,000.", "PHP", `The portal runs on php.\n${STATED}.`],
    [`All figures are in €.\n${STATED}`, "The annual salary is £54,000.", "£"],
    ["Revenue by region (in thousands)\nNorth\t54,000", "North's revenue was $54m.", "$"],
  ])("%j doesn't name it", (cited, claim, currency, document = cited) => {
    expect(unitNotStated(claim, read(cited, document))).toMatchObject({
      kind: "currency",
      currency,
    });
  });

  // protects=no false alarm when the Document names the currency, in the cited Passage or anywhere in the Document: in words in any case, by a dollar or 元 of its own that "$" or "元" stands for, by its sign or code stated as the unit, or as the one currency of its other figures, in English and Chinese; fails_when=a right "£", "$" or "元" is flagged; no_claim=none beyond protects.
  const named: [string, string][] = [
    ["All payments under this agreement are made in pounds sterling.", "£"],
    ["All payments under this agreement shall be made in Pounds Sterling.", "£"],
    ["ALL AMOUNTS ARE IN POUNDS STERLING.", "£"],
    ["All amounts in this agreement are in US dollars.", "$"],
    ["All amounts are in U.S. Dollars.", "$"],
    ["All amounts are in United States Dollars.", "$"],
    ["All amounts in this agreement are in Canadian dollars.", "$"],
    ["Amounts are in Australian dollars.", "$"],
    ["Amounts are in Hong Kong dollars.", "$"],
    ["Payments are made in euro.", "€"],
    ["Payments are made in Euros.", "€"],
    ["The Employer pays in dollars.", "$"],
    ["Paid in rupees.", "₹"],
    ["Paid in Indian Rupees.", "₹"],
    ["Fees are paid in Swiss francs.", "CHF "],
    ["All figures are in £.", "£"],
    ["Amounts in £'000", "£"],
    ["Name\tSalary (£)", "£"],
    ["The signing bonus is £5,000.", "£"],
  ];
  test.each(
    named.flatMap(([words, sign]) =>
      ["cited", "elsewhere"].map((where) => [where, words, `The annual salary is ${sign}54,000.`]),
    ),
  )("named %s: %s", (where, words, claim) => {
    const cited = where === "cited" ? `${words}\n${STATED}.` : STATED;
    expect(unitNotStated(claim, read(cited, `${words}\n${STATED}.`))).toBeNull();
  });

  test.each([
    [
      "All amounts in this agreement are in Canadian dollars.",
      "The annual salary is 54,000 dollars.",
    ],
    ["All amounts are in Hong Kong dollars.", "The annual salary is 54,000 Dollars."],
  ])("the word named elsewhere in %j: %s", (words, claim) => {
    expect(unitNotStated(claim, read(STATED, `${words}\n${STATED}.`))).toBeNull();
  });

  test.each([
    ["本合同所有款项以港币支付。", "年薪为 54,000元。"],
    ["本合同以新台币计价。", "年薪为 54,000元。"],
    ["本合同以日元支付。", "年薪为¥54,000。"],
    ["单位：元", "年薪为 54,000元。"],
    ["合同总价为人民币120,000元。", "年薪为 54,000元。"],
  ])("named elsewhere in %j", (words, claim) => {
    const cited = "年薪为 54,000，按月支付。";
    expect(unitNotStated(claim, read(cited, `${words}\n${cited}`))).toBeNull();
  });

  test.each([
    ["币种：人民币\n年薪为 54,000，按月支付。", "年薪为54,000元。"],
    ["年薪为 54,000，以人民币支付。", "年薪为人民币54,000元。"],
    ["年薪为 54,000，以人民币支付。", "年薪为¥54,000。"],
    ["Name\tSalary (GBP)\nAva Chen\t54,000", "Ava Chen's salary is £54,000."],
    ["Name\tSalary (£)\nAva Chen\t54,000", "Ava Chen's salary is £54,000."],
  ])("named in %j", (cited, claim) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=no false alarm: a figure written as the Document writes it, a currency on the cited figure, a Hong Kong dollar beside it that "$" may stand for, or a number the cited text doesn't state is left to the model; fails_when=any of these is flagged; no_claim=none beyond protects.
  test.each([
    ["the figure as written", "The annual salary is 54,000.", STATED],
    ["a currency on the cited figure", "The annual salary is £54,000.", "The salary is £54,000"],
    [
      "a Hong Kong dollar beside it",
      "The annual salary is $54,000.",
      `${STATED}. The relocation allowance is HK$8,000.`,
    ],
    ["a number the cited text doesn't state", "The bonus is £5,000.", STATED],
  ])("%s isn't flagged", (_, claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=every Citation counts, each with its own Document: the currency named by the second Citation's Document backs the first's figure; fails_when=only the first Citation is read; no_claim=none beyond protects.
  test("a currency another Citation's Document names counts", () => {
    const salary = "Grade 4 annual salary: 54,000";
    const pay = "Every salary at the company is paid in pounds sterling";
    const claim = "The Grade 4 annual salary is £54,000.";
    expect(unitNotStated(claim, read(salary))).not.toBeNull();
    expect(unitNotStated(claim, [...read(salary), ...read(pay)])).toBeNull();
  });
});

describe("A percent where the Document gives percentage points", () => {
  // protects=a percent against percentage points or basis points, and points against a percent, are found, in English and Chinese; fails_when="2%" passes against "2 percentage points", "2个百分点" or "200 bps"; no_claim=a plain number shown as a percent, which is a follow-up.
  test.each([
    ["The margin rose 2%.", "The margin rose 2 percentage points.", "2%", "2 percentage points"],
    ["毛利率上升了2%。", "毛利率上升了2个百分点。", "2%", "2个百分点"],
    ["The spread widened 0.5%.", "The spread widened 50 bps.", "0.5%", "50 bps"],
    ["The rate rose 2 percentage points.", "The rate rose 2%.", "2 percentage points", "2%"],
  ])("%s against %s", (claim, cited, figure, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "unit", figure, amount });
  });

  // protects=the same unit, or a figure the Document gives both ways, isn't flagged; fails_when=a right percent is flagged; no_claim=none beyond protects.
  test.each([
    ["The margin rose 2 percentage points.", "The margin rose 2 percentage points."],
    ["The margin was 2%.", "The margin was 2%, up 2 percentage points."],
    ["毛利率上升2.1pct。", "毛利率上升2.1个百分点。"],
  ])("%s against %s", (claim, cited) => {
    expect(unitNotStated(claim, read(cited))).toBeNull();
  });

  // protects=a percent another Citation gives backs it, so the sentence isn't told the Document gives points; fails_when="The Document gives 2 percentage points, not 2%" shows though [2] gives 2%; no_claim=none beyond protects.
  test("a percent another Citation gives counts", () => {
    const claim = "In 2025 inflation was 2% and Meridian's gross margin rose 2 percentage points.";
    const margin = "Meridian's gross margin rose 2 percentage points in 2025";
    const inflation = "Inflation in the euro area was 2% in 2025";
    expect(unitNotStated(claim, read(margin))).toMatchObject({ kind: "unit" });
    expect(unitNotStated(claim, [...read(margin), ...read(inflation)])).toBeNull();
  });
});

describe("How much a check reads", () => {
  // protects=a sentence without a currency, a percent or points reads nothing more; the cited Units are read only for one that has, and the Document's whole text only for a currency they don't name (#1332's review: a 2 MB Document took 2 s a sentence); fails_when=the Document is read for every sentence; no_claim=how long a read takes.
  test("reads the cited Units only for a figure with a unit, and the Document only for a currency they don't name", () => {
    const reads = { cited: 0, document: 0 };
    const counted = (cited: string): CheckedText[] => [
      {
        cited: () => {
          reads.cited += 1;
          return cited;
        },
        document: () => {
          reads.document += 1;
          return `${"Clause text with 1,234 and $5 or HK$5 in it. ".repeat(1000)}${cited}`;
        },
      },
    ];

    expect(unitNotStated("The notice period is three months.", counted(STATED))).toBeNull();
    expect(reads).toMatchObject({ cited: 0, document: 0 });
    expect(unitNotStated("The bonus is £5,000.", counted(STATED))).toBeNull();
    expect(reads).toMatchObject({ cited: 1, document: 0 });
    const inPounds = `${STATED}, in pounds sterling`;
    expect(unitNotStated("The annual salary is £54,000.", counted(inPounds))).toBeNull();
    expect(reads).toMatchObject({ cited: 2, document: 0 });
    expect(unitNotStated("The annual salary is £54,000.", counted(STATED))).not.toBeNull();
    expect(reads).toMatchObject({ cited: 3, document: 1 });
  });
});

const DOCUMENTS = [
  {
    name: "Harbourline agreement.txt",
    contents:
      "All payments under this agreement are made in pounds sterling.\nHarbourline pays the Employee an annual salary of 54,000, paid monthly.\n",
  },
  {
    name: "Kestrel agreement.txt",
    contents: "Kestrel Trading pays the Employee an annual salary of 54,000, paid monthly.\n",
  },
  { name: "明远合同.txt", contents: "明远公司向员工支付年薪 54,000，按月发放。\n" },
  { name: "华信合同.txt", contents: "第三单元 薪酬\n华信公司向员工支付年薪 63,000，按月发放。\n" },
  { name: "Meridian results.txt", contents: "Meridian's gross margin rose 2 percentage points.\n" },
];

describe("Checking a sentence that adds a unit", { timeout: 30_000 }, () => {
  const supported = (quote: string) => ({ verdict: "supported" as const, quote, says: quote });
  const PLANS = {
    "Harbourline pays an annual salary of £54,000.": supported(
      "Harbourline pays the Employee an annual salary of 54,000",
    ),
    "Kestrel Trading pays an annual salary of ¥54,000.": supported(
      "Kestrel Trading pays the Employee an annual salary of 54,000",
    ),
    "明远公司支付的年薪为五万四千英镑。": supported("支付年薪 54,000"),
    "华信公司支付的年薪为 63,000元。": supported("支付年薪 63,000"),
    "Meridian's gross margin rose 2%.": supported("gross margin rose 2 percentage points"),
    "The annual salary is £54,000.": supported(STATED),
  };

  // protects=through the core, a currency named in words stays supported, an added "¥", an added "英镑" after Chinese numerals and an added "元" beside a 单元 heading are Unsupported naming only the currency, and a percent for percentage points is Unsupported saying what the Document gives, in English and Chinese (#1332); fails_when=any of these checks the other way, or names the amount as the currency; no_claim=a real model's verdict.
  test("is Unsupported only for a unit the Document doesn't state, naming what it gives", async () => {
    const { core } = await setUpWithDocuments(checkingModel(PLANS), [CONTRACT, ...DOCUMENTS]);
    const check = (claim: string) => core.checkClaim({ claim });

    expect(await check("Harbourline pays an annual salary of £54,000.")).toMatchObject({
      verdict: "supported",
    });
    expect(await check("Kestrel Trading pays an annual salary of ¥54,000.")).toMatchObject({
      verdict: "unsupported",
      unsupported: { uncovered: "the currency (¥)" },
    });
    expect(await check("明远公司支付的年薪为五万四千英镑。")).toMatchObject({
      verdict: "unsupported",
      unsupported: { covered: "the amount, 54,000", uncovered: "the currency (英镑)" },
    });
    expect(await check("华信公司支付的年薪为 63,000元。")).toMatchObject({
      verdict: "unsupported",
      unsupported: { uncovered: "the currency (元)" },
    });
    expect(await check("Meridian's gross margin rose 2%.")).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: "The Document gives 2 percentage points, not 2%.",
        covered: null,
        uncovered: null,
      },
    });
    expect(await check("The annual salary is £54,000.")).toMatchObject({
      verdict: "unsupported",
      unsupported: {
        reason: "The Document gives 54,000 without a currency.",
        covered: "the amount, 54,000",
        uncovered: "the currency (£)",
      },
    });

    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await check("明远公司支付的年薪为五万四千英镑。")).toMatchObject({
      unsupported: {
        reason: "文档写的是 54,000，没有注明币种。",
        covered: "金额 54,000",
        uncovered: "币种（英镑）",
      },
    });
    expect(await check("Meridian's gross margin rose 2%.")).toMatchObject({
      unsupported: { reason: "文档写的是 2 percentage points，不是 2%。" },
    });
  });

  // protects=through the core, a correct currency stays supported when its Document names it in capitals, by a dollar or 元 of its own that the sign stands for, or by its sign stated as the unit (#1332's review); fails_when=any of these checks Unsupported, which would cut a right currency; no_claim=a real model's verdict.
  test("stays supported for a currency its Document names in any of its ways", async () => {
    const named = [
      [
        "Fenwick agreement.txt",
        "All payments under this agreement shall be made in Pounds Sterling.\nFenwick Ltd pays the Employee an annual salary of 54,000.\n",
        "Fenwick Ltd pays an annual salary of £54,000.",
        "Fenwick Ltd pays the Employee an annual salary of 54,000",
      ],
      [
        "Maple agreement.txt",
        "All amounts in this agreement are in Canadian dollars.\nMaple Freight pays the Employee an annual salary of 54,000.\n",
        "Maple Freight pays an annual salary of $54,000.",
        "Maple Freight pays the Employee an annual salary of 54,000",
      ],
      [
        "港湾合同.txt",
        "本合同所有款项以港币支付。\n港湾贸易公司向员工支付年薪 54,000。\n",
        "港湾贸易公司支付的年薪为 54,000元。",
        "港湾贸易公司向员工支付年薪 54,000",
      ],
      [
        "Harrow agreement.txt",
        "All figures are in £.\nHarrow Ltd pays the Employee an annual salary of 54,000.\n",
        "Harrow Ltd pays an annual salary of £54,000.",
        "Harrow Ltd pays the Employee an annual salary of 54,000",
      ],
    ] as const;
    const plans = Object.fromEntries(named.map(([, , claim, quote]) => [claim, supported(quote)]));
    const files = named.map(([name, contents]) => ({ name, contents }));
    const { core } = await setUpWithDocuments(checkingModel(plans), files);

    for (const [, , claim] of named) {
      expect(await core.checkClaim({ claim }), claim).toMatchObject({ verdict: "supported" });
    }
  });

  // protects=through the core, every Citation the check found counts, each with its own Document: a currency or a percent the second Citation backs leaves the sentence supported, and no false "The Document gives 2 percentage points, not 2%" (#1332's review); fails_when=only the first Citation is read; no_claim=a real model's verdict.
  test("reads every Citation the check found", async () => {
    const both: Record<string, [string, string]> = {
      "The Grade 4 annual salary is £54,000.": [
        "Grade 4 annual salary: 54,000",
        "Every salary at the company is paid in pounds sterling",
      ],
      "In 2025 inflation was 2% and Meridian's gross margin rose 2 percentage points.": [
        "Meridian's gross margin rose 2 percentage points in 2025",
        "Inflation in the euro area was 2% in 2025",
      ],
    };
    const model = scriptedModel(
      (call) => {
        if (!isCheckRun(call)) return checkReply(call, {});
        const quotes = both[sentenceOf(call)] ?? [];
        const searches = call.results.filter((result) => result.tool === "search_documents");
        const shown = searches.flatMap((result) => shownPassages(result.text));
        const missing = quotes.find((quote) => !shown.some((each) => each.text.includes(quote)));
        if (missing && searches.length < 3) {
          return { calls: [{ tool: "search_documents", input: { query: missing } }] };
        }
        if (!call.results.some((result) => result.tool === "cite")) {
          const citations = quotes.map((quote, index) => ({
            marker: index + 1,
            passage: shown.find((each) => each.text.includes(quote))?.id,
            quote,
          }));
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        return { text: "Verdict: supported\nAbsence: no\nBoth Passages say so. [^1] [^2]" };
      },
      { generate: checkGenerate({}) },
    );
    const { core } = await setUpWithDocuments(model, [
      { name: "Pay grades.txt", contents: "Pay grades\nGrade 4 annual salary: 54,000\n" },
      {
        name: "Pay policy.txt",
        contents: "Pay policy\nEvery salary at the company is paid in pounds sterling.\n",
      },
      {
        name: "Meridian results 2025.txt",
        contents: "Meridian's gross margin rose 2 percentage points in 2025.\n",
      },
      { name: "Euro area prices.txt", contents: "Inflation in the euro area was 2% in 2025.\n" },
    ]);

    for (const claim of Object.keys(both)) {
      expect(await core.checkClaim({ claim }), claim).toMatchObject({ verdict: "supported" });
    }
  });

  // protects=the same sentence written as the Document writes it stays supported; fails_when=the rule flags a figure that adds nothing; no_claim=none beyond protects.
  test("stays supported when it writes the figure as the Document does", async () => {
    const claim = "The annual salary is 54,000.";
    const { core } = await setUpWithDocuments(checkingModel({ [claim]: supported(STATED) }), [
      CONTRACT,
    ]);

    expect(await core.checkClaim({ claim })).toMatchObject({ verdict: "supported" });
  });
});

const RENT = "乙方每月向甲方支付租金人民币两万元。";
const flatLine = (tenant: string, rent: string) =>
  `甲方将明川路14号2室出租给乙方${tenant}，乙方${tenant}每月向甲方支付租金人民币${rent}元`;
const flat = (tenant: string, rent: string) => ({
  name: `员工宿舍协议 - ${tenant}.txt`,
  contents: `员工宿舍协议\n甲方：明川食品有限公司　乙方：${tenant}\n第一条　${flatLine(tenant, rent)}。\n第二条　租期为两年。\n`,
});
const AMOUNTS = [
  ["两万", "20,000", "林晓"],
  ["三千五百", "3,500", "王芳"],
  ["一万二", "12,000", "张伟"],
  ["十二万", "120,000", "李娜"],
  ["两千万", "20,000,000", "陈杰"],
] as const;

describe("A Chinese amount in words (#2189)", () => {
  // protects=an amount in Chinese numerals is the one amount it writes, against the same amount in digits on a page whose address holds "14号2室", each way round; fails_when="The Document gives 2, not 人民币两万元", or any amount is read as its first digits at another scale; no_claim=a real model's verdict.
  test.each(AMOUNTS)("%s is the amount %s", (words, digits, tenant) => {
    const inDigits = `第一条　${flatLine(tenant, digits)}。`;
    const inWords = `第一条　${flatLine(tenant, words)}。`;
    expect(unitNotStated(`乙方每月支付租金人民币${words}元。`, read(inDigits))).toBeNull();
    expect(unitNotStated(`乙方每月支付租金人民币${digits}元。`, read(inWords))).toBeNull();
    expect(unitNotStated(`乙方每月支付租金${words}元。`, read(inWords))).toBeNull();
  });

  // protects=a number with an address's, a room's, a floor's or a clause's word is never the amount at another scale, while a bare number still is, in digits or in words; fails_when=the "2" of "14号2室" or "2单元" gives "The Document gives 2", or a bare "2" no longer does; no_claim=whether a model calls the sentence supported.
  test("a number in an address, a room or a clause never stands in for an amount", () => {
    for (const cited of [
      "第一条　员工宿舍：甲方将明川路14号2室出租给乙方，甲方为出租方，乙方为承租方。",
      "甲方将5号楼2单元2室出租给乙方，该楼共2层。",
      "乙方住在2楼。",
      "详见第2条第2款。",
      "见2章。",
    ]) {
      expect(unitNotStated(RENT, read(cited)), cited).toBeNull();
    }
    expect(unitNotStated("乙方每月支付租金2万元。", read("租金\t2"))).toMatchObject({
      kind: "scale",
      amount: "2",
    });
    expect(unitNotStated(RENT, read("租金\t2"))).toMatchObject({ kind: "scale", amount: "2" });
  });

  // protects=an amount in another currency is still the same digits at another scale, either way round, and an equal amount elsewhere on the page doesn't cancel the reason; fails_when="2万美元" against "2千元", "2万元" against "2千美元", or "2万元" against "租金	2" beside "押金20,000元" comes back with no reason, or "£2.5m" names the Costs line; no_claim=none beyond protects.
  test.each([
    ["乙方每月支付租金2万美元。", "租金2千元", "2千元"],
    ["乙方每月支付租金2万元。", "租金2千美元", "2千美元"],
    ["乙方每月支付租金2千美元。", "租金2万元", "2万元"],
    ["乙方每月支付租金2千元。", "租金2万美元", "2万美元"],
    ["乙方每月支付租金2万元。", "共2页。押金20,000元。租金\t2", "2"],
    ["Revenue was £2.5m.", "Revenue\t2.5\nCosts 2,500,000", "2.5"],
  ])("%s against %j gives %s at another scale", (claim, cited, amount) => {
    expect(unitNotStated(claim, read(cited))).toMatchObject({ kind: "scale", amount });
  });

  // protects=a figure's row compares it only with the numbers it was bound to: the room number on the same page is not one of them; fails_when=the row says "The Document gives 2, not 人民币两万元"; no_claim=none beyond protects.
  test("a figure's row is compared only with the numbers it was bound to", () => {
    const page = flat("林晓", "20,000").contents;
    const bound = [
      { chars: "人民币20,000元", unit: { kind: "currency" as const, code: "CNY" }, scale: 1 },
    ];
    expect(unitNotStated("人民币两万元", read(page), bound)).toBeNull();
    expect(
      unitNotStated("人民币2万元", read("租金\t2"), [
        { chars: "2", unit: { kind: "plain" as const }, scale: 1 },
      ]),
    ).toMatchObject({ kind: "scale", amount: "2" });
  });
});

describe("Checking a Chinese amount in words", { timeout: 30_000 }, () => {
  const supportedBy = (tenant: string, digits: string) => ({
    verdict: "supported" as const,
    quote: flatLine(tenant, digits),
    number: digits,
    says: flatLine(tenant, digits),
  });

  // protects=through the core, with the flat agreement in the Library, a sentence stating the rent correctly as 人民币两万元 is Supported and neither its sentence nor its figure's row gives a reason from the room number, in English and Chinese (#2189); fails_when="The Document gives 2, not 人民币两万元" or "文档写的是 2" appears, or the verdict isn't Supported; no_claim=a real model's verdict.
  test("a rent stated correctly as 人民币两万元 is Supported, with no reason from the room number", async () => {
    const claim = "乙方林晓每月向甲方支付租金人民币两万元。";
    const { core } = await setUpWithDocuments(
      checkingModel({ [claim]: supportedBy("林晓", "20,000") }),
      [flat("林晓", "20,000")],
    );

    const result = await core.checkClaim({ claim });
    expect(result).toMatchObject({ verdict: "supported", unsupported: null });
    expect(JSON.stringify(result)).not.toContain("gives 2");

    await core.updateSettings({ user: { language: "zh-CN" } });
    const zh = await core.checkClaim({ claim });
    expect(zh).toMatchObject({ verdict: "supported", unsupported: null });
    expect(JSON.stringify(zh)).not.toContain("写的是 2");
  });

  // protects=through the core, each of 两万, 三千五百, 一万二, 十二万 and 两千万 is checked as the one amount it writes against the flat agreement that gives it in digits; fails_when=any is Unsupported for a scale or a currency; no_claim=a real model's verdict.
  test("each amount in words is checked as one amount", async () => {
    const plans = Object.fromEntries(
      AMOUNTS.map(([words, digits, tenant]) => [
        `乙方${tenant}每月向甲方支付租金人民币${words}元。`,
        supportedBy(tenant, digits),
      ]),
    );
    const { core } = await setUpWithDocuments(
      checkingModel(plans),
      AMOUNTS.map(([, digits, tenant]) => flat(tenant, digits)),
    );

    for (const claim of Object.keys(plans)) {
      expect(await core.checkClaim({ claim }), claim).toMatchObject({
        verdict: "supported",
        unsupported: null,
      });
    }
  });
});

describe("What the assistant writes", { timeout: 30_000 }, () => {
  const WRITTEN = "The annual salary is £54,000";
  const CUT = /<task action="cut-unsupported">/;

  // protects=the flow #1332 reports: the assistant writes "£54,000" into a Mind against the plain "54,000", its check calls it supported, and the "£" is cut before it lands, the Citation kept; fails_when=the page keeps "£54,000", or the cut is told to take more than the currency; no_claim=how well a real model cuts.
  test("a currency it adds to a figure is cut before it lands", async () => {
    const calls: ModelCall[] = [];
    const plans = {
      [`${WRITTEN} ${INLINE_NODE}.`]: {
        verdict: "supported" as const,
        quote: STATED,
        says: STATED,
      },
      // The cut, checked once as it would land.
      [`The annual salary is 54,000 ${INLINE_NODE}.`]: {
        verdict: "supported" as const,
        quote: STATED,
        says: STATED,
      },
    };
    const model = scriptedModel((call) => {
      calls.push(call);
      if (isCheckRun(call)) return checkReply(call, plans);
      if (CUT.test(call.prompt)) return { text: "The annual salary is 54,000 [1]." };
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "salary" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        const record = { marker: 1, passage: passage?.id, quote: STATED };
        return { calls: [{ tool: "cite", input: { citations: [record] } }] };
      }
      if (!call.results.some((result) => result.tool === "create_mind")) {
        const input = { title: "Pay", content: `${WRITTEN} [^1].` };
        return { calls: [{ tool: "create_mind", input }] };
      }
      return { text: "Wrote it from your Documents." };
    });
    const { core } = await setUpWithDocuments(model, [CONTRACT]);

    const answer = await askAssistant(core, { text: "Write a note on the pay" });
    const [change] = changesIn(answer);
    const page = await connectToMind(core, change?.mindId ?? "");
    await page.settled();

    process.stdout.write(
      `SHOWN ${JSON.stringify(shownWithChanges(page))} SELF ${JSON.stringify(changesIn(answer)[0]?.selfCheck)}\n`,
    );
    for (const call of calls.filter(isCheckRun))
      process.stdout.write(
        `CHK ${JSON.stringify(call.results.map((r) => [r.tool, r.text.slice(0, 200)]))}\n`,
      );
    expect(shownWithChanges(page)).toContain("+ The annual salary is 54,000 ⟨found⟩.");
    const cuts = calls.filter((call) => CUT.test(call.prompt));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.prompt).toContain("the currency (£)");
  });
});

describe("What the assistant is told", () => {
  // protects=every way of citing tells the model to keep each figure's currency, unit and scale as its Document gives them, with the currency example in English and Chinese and the points example; fails_when=a mode leaves it out; no_claim=what a real model writes, which the pull request's hand check covers.
  test.each(["tools", "structured-output", "none"] as const)("in %s", (mode) => {
    const told = documentInstructions(mode, { total: 1, names: ["Employment agreement"] });
    expect(told).toContain(
      "A figure taken from a Passage keeps exactly the currency, unit and scale its Document gives it",
    );
    expect(told).toContain("54,000（未注明币种）");
    expect(told).toContain('"2 percentage points" never becomes "2%"');
  });
});
