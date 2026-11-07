import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Citation, CitationAttributes, ClaimCheckAttributes, Core } from "../../src/core";
import { readChangeLines } from "../../src/core/answers/checks/prompt";
import { REWRITE_INSTRUCTIONS, rewriteOf } from "../../src/core/answers/checks/rewrite";
import { setUpWithDocuments } from "../helpers/citations";
import { waitForProcessing } from "../helpers/documents";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, scriptedModel } from "../helpers/models";
import { REWRITE_CASES } from "../helpers/notFoundFixesHeldOut";

/*
 * Rewrite with what the Documents say (#1554): the model names the old words and the quote's,
 * and only a rewrite whose words and figures are all the quote's is kept.
 */

const LEASE = "The Tenant shall pay a monthly rent of $14,250, due on the first day of each month.";
const NO_DATE = () => null;

const quoted = (quote: string): Citation => ({
  passageId: "passage-lease",
  documentId: "lease",
  documentName: "Office lease",
  contentHash: "hash-lease",
  pageFrom: null,
  pageTo: null,
  location: null,
  quote,
  check: "found",
  checkReason: null,
});

const rewritten = (sentence: string, reply: string, quote = LEASE) =>
  rewriteOf(sentence, reply, quoted(quote), NO_DATE);

describe("A rewrite's reply", () => {
  test("is read as one change, its old words and the quote's", () => {
    expect(readChangeLines("Change 1: $12,500\nTo 1: $14,250")).toEqual({
      from: "$12,500",
      choices: [{ wording: "$14,250", marker: 1 }],
    });
    expect(readChangeLines("The lease gives another rent.")).toBeNull();
  });

  test("names the quote's words for the sentence's, as a correction does", () => {
    expect(REWRITE_INSTRUCTIONS).toContain('"Change 1: "');
    expect(REWRITE_INSTRUCTIONS).toContain('"To 1: "');
  });
});

describe("A rewrite is kept", () => {
  test("when the quote holds its words and every figure of the sentence it makes", () => {
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: $12,500\nTo 1: $14,250"),
    ).toEqual({
      kind: "rewritten",
      correction: { from: "$12,500", choices: [{ wording: "$14,250", evidence: quoted(LEASE) }] },
    });
  });

  test("when the line's one figure is a measure whose digits look like a year", () => {
    expect(
      rewritten(
        "The lot is 1,800 square feet.",
        "Change 1: 1,800\nTo 1: 2025",
        "The lot is 2025 square feet.",
      ),
    ).toMatchObject({ kind: "rewritten", correction: { choices: [{ wording: "2025" }] } });
  });

  test("in Chinese too", () => {
    expect(
      rewritten(
        "每位员工每年享有 10 天带薪年假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每年享有 15 天带薪年假。",
      ),
    ).toMatchObject({
      kind: "rewritten",
      correction: { from: "10", choices: [{ wording: "15" }] },
    });
  });
});

describe("A rewrite is refused, and the sentence kept", () => {
  test("when the sentence it makes still gives a figure the quote doesn't, in another clause too", () => {
    expect(
      rewritten(
        "The Tenant pays a monthly rent of $12,500; the building has 3 floors.",
        "Change 1: $12,500\nTo 1: $14,250",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "每位员工每年享有 10 天带薪年假，另有 5 天病假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每年享有 15 天带薪年假。",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The Tenant pays a monthly rent of $12,500 for 3 floors.",
        "Change 1: $12,500\nTo 1: $14,250",
      ),
    ).toEqual({ kind: "kept" });
    // The quote's number in another currency is not the quote's figure.
    expect(
      rewritten(
        "The Tenant pays a monthly rent of $12,500; the deposit is €14,250.",
        "Change 1: $12,500\nTo 1: $14,250",
      ),
    ).toEqual({ kind: "kept" });
    // The same change, with no other figure, is kept.
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: $12,500\nTo 1: $14,250"),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("when its words aren't the quote's", () => {
    expect(
      rewritten("The Tenant pays a monthly rent of $12,500.", "Change 1: $12,500\nTo 1: $15,000"),
    ).toEqual({ kind: "kept" });
  });

  test("when the words it writes are a name the quote doesn't hold", () => {
    const quote = "The Landlord is Sampleford Commercial Property Investments Limited.";
    expect(
      rewritten(
        "The Landlord is Exampleton Holdings.",
        "Change 1: Exampleton Holdings\nTo 1: Testbury Holdings",
        quote,
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The Landlord is Exampleton Holdings.",
        "Change 1: Exampleton Holdings\nTo 1: Sampleford Commercial Property Investments Limited",
        quote,
      ),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("when the sentence names a period the quote doesn't", () => {
    expect(
      rewritten("In 2025 the monthly rent was $12,500.", "Change 1: $12,500\nTo 1: $14,250"),
    ).toEqual({ kind: "kept" });
  });

  test("when the reply gives two choices", () => {
    expect(
      rewritten(
        "The rent is $12,500.",
        "Change 1: $12,500\nTo 1: $14,250\nChange 2: $12,500\nTo 2: $42,750",
        "The rent is $14,250 and the deposit is $42,750.",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten("The rent is $12,500.", "Change 1: $12,500\nTo 1: $14,250", "The rent is $14,250."),
    ).toMatchObject({ kind: "rewritten" });
  });
});

describe("A reply that names nothing to change", () => {
  const NONE = "Change 1: none\nTo 1: none";

  test("is the same value only when the sentence gives the quote's figure, of what the quote gives it for", () => {
    expect(rewritten("The Tenant pays a monthly rent of $14,250.", NONE)).toEqual({ kind: "same" });
    expect(
      rewritten("每位员工每年享有 15 天带薪年假。", NONE, "每位员工每年享有 15 天带薪年假。"),
    ).toEqual({ kind: "same" });
  });

  test.each([
    ["another figure", "The Tenant pays a monthly rent of $12,500.", LEASE],
    ["the figure of another thing", "The deposit is $14,250.", "The rent is $14,250."],
    [
      "the figure for another period",
      "每位员工每月享有 15 天带薪年假。",
      "每位员工每年享有 15 天带薪年假。",
    ],
    [
      "no figure",
      "The Landlord is Exampleton Holdings.",
      "The Landlord is Sampleford Commercial Property Investments Limited.",
    ],
  ])("is the model's alone for %s, and the sentence stays", (_, sentence, quote) => {
    expect(rewritten(sentence, NONE, quote)).toEqual({ kind: "none" });
  });
});

describe("Nothing to change is the same value only by the code's own reading", () => {
  const NONE = "Change 1: none\nTo 1: none";

  test.each([
    ["a rate only the sentence names", "Rent is $14,250, paid monthly.", "Rent is $14,250."],
    ["another currency", "The rent is €14,250.", "The rent is $14,250."],
    ["a negation only the quote says", "The rent is $14,250.", "The rent is not $14,250."],
    ["a bound only the quote says", "租金为15万元。", "租金不超过15万元。"],
    ["another thing in a label", "Rent: $14,250.", "Deposit: $14,250."],
  ])("is the model's alone against %s", (_, sentence, quote) => {
    expect(rewritten(sentence, NONE, quote)).toEqual({ kind: "none" });
    expect(rewritten(quote, NONE, quote)).toEqual({ kind: "same" });
  });

  test("is the model's alone where the quote gives the value among others", () => {
    expect(
      rewritten("The rent is $42,750.", NONE, "The rent is $14,250 and the deposit is $42,750."),
    ).toEqual({ kind: "none" });
    expect(rewritten("租金为42750元。", NONE, "租金为14250元，押金为42750元。")).toEqual({
      kind: "none",
    });
    expect(rewritten("The rent is $42,750.", NONE, "The rent is $14,250 or $42,750.")).toEqual({
      kind: "none",
    });
    expect(rewritten("The rent is $42,750.", NONE, "The rent is $42,750.")).toEqual({
      kind: "same",
    });
  });
});

/** The old figure of each held-out sentence, and the line's figure a careful reader writes for it. */
const HELD_OUT_CHANGES: readonly [string, string, string][] = [
  ["rent", "$12,500", "$14,250"],
  ["notice", "60", "90"],
  ["deposit", "$40,000", "$42,750"],
  ["rent-other-year", "$12,500", "$14,250"],
  ["rent-extra-figure", "$12,500", "$14,250"],
  ["leave", "10", "15"],
  ["payday", "15", "10"],
  ["hotel", "500", "600"],
  ["leave-other-year", "10", "15"],
  ["leave-extra-figure", "10", "15"],
];

describe("The held-out rewrites", () => {
  test("are each rewritten to the line's figure, and each control kept", () => {
    expect(REWRITE_CASES.filter((each) => each.rewrites)).toHaveLength(6);
    expect(HELD_OUT_CHANGES.map(([id]) => id).sort()).toEqual(
      REWRITE_CASES.map((each) => each.id).sort(),
    );
    for (const [id, from, to] of HELD_OUT_CHANGES) {
      const each = REWRITE_CASES.find((one) => one.id === id);
      if (!each) throw new Error(`No held-out case ${id}.`);
      const result = rewritten(each.sentence, `Change 1: ${from}\nTo 1: ${to}`, each.line);
      expect(result, id).toMatchObject(
        each.rewrites
          ? { kind: "rewritten", correction: { choices: [{ wording: each.figure }] } }
          : { kind: "kept" },
      );
    }
  });
});

describe("A party said again before a figure says whose figure it is", () => {
  const NONE = "Change 1: none\nTo 1: none";
  const QUOTE = "The Tenant pays the Landlord before the Landlord receives $700.";

  test("so another party's keeps the sentence, as the same value and as a rewrite", () => {
    expect(
      rewritten("The Tenant pays the Landlord before the Tenant receives $700.", NONE, QUOTE),
    ).toEqual({ kind: "none" });
    expect(
      rewritten(
        "The Tenant pays the Landlord before the Tenant receives $500.",
        "Change 1: $500\nTo 1: $700",
        QUOTE,
      ),
    ).toMatchObject({ kind: "kept" });
  });

  test("and the same party's is the same value, or rewritten", () => {
    expect(rewritten(QUOTE, NONE, QUOTE)).toEqual({ kind: "same" });
    expect(
      rewritten(
        "The Tenant pays the Landlord before the Landlord receives $500.",
        "Change 1: $500\nTo 1: $700",
        QUOTE,
      ),
    ).toMatchObject({ kind: "rewritten", correction: { choices: [{ wording: "$700" }] } });
  });
});

describe("A rewritten figure keeps the words before it", () => {
  test.each([
    [
      "a lower bound for an upper one",
      "The rent is at least $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is at most $14,250.",
      "The rent is at most $12,500.",
    ],
    [
      "below for above",
      "The rent is below $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is above $14,250.",
      "The rent is above $12,500.",
    ],
    [
      "more than for less than",
      "The lease runs for more than 10 years.",
      "Change 1: 10\nTo 1: 12",
      "The lease runs for less than 12 years.",
      "The lease runs for less than 10 years.",
    ],
    [
      "不超过 for 不少于",
      "出差住宿标准为每晚不超过 500 元。",
      "Change 1: 500\nTo 1: 600",
      "出差住宿标准为每晚不少于 600 元。",
      "出差住宿标准为每晚不少于 500 元。",
    ],
    [
      "至少 for 最多",
      "每位员工每年至少享有 10 天带薪年假。",
      "Change 1: 10\nTo 1: 15",
      "每位员工每年最多享有 15 天带薪年假。",
      "每位员工每年最多享有 10 天带薪年假。",
    ],
    [
      "a negation",
      "The rent is not $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is $14,250.",
      "The rent is $12,500.",
    ],
    [
      "a negation, in Chinese",
      "租金不是12万元。",
      "Change 1: 12万元\nTo 1: 15万元",
      "租金是15万元。",
      "租金是12万元。",
    ],
    [
      "another thing's figure",
      "Revenue was $1.2 million.",
      "Change 1: $1.2 million\nTo 1: $1.5 million",
      "Costs were $1.5 million.",
      "Costs were $1.2 million.",
    ],
    [
      "net for gross",
      "Net revenue was $1.2 million.",
      "Change 1: $1.2 million\nTo 1: $1.5 million",
      "Gross revenue was $1.5 million.",
      "Gross revenue was $1.2 million.",
    ],
    [
      "营收 for 成本",
      "公司去年营收 1.2亿元。",
      "Change 1: 1.2亿元\nTo 1: 1.5亿元",
      "公司去年成本 1.5亿元。",
      "公司去年成本 1.2亿元。",
    ],
    [
      "税后 for 税前",
      "税后利润为1.2亿元。",
      "Change 1: 1.2亿元\nTo 1: 1.5亿元",
      "税前利润为1.5亿元。",
      "税前利润为1.2亿元。",
    ],
    [
      "another thing's figure, from a line that gives only the one",
      "The deposit is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is $14,250.",
      "The rent is $12,500.",
    ],
  ])("refuses %s, and rewrites the quote's own thing", (_, sentence, reply, quote, same) => {
    expect(rewritten(sentence, reply, quote)).toEqual({ kind: "kept" });
    expect(rewritten(same, reply, quote)).toMatchObject({ kind: "rewritten" });
  });
});

describe("A rewritten figure keeps every word before it that the quote says", () => {
  test.each([
    [
      "a bound only the quote has",
      "The rent is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is at most $14,250.",
      "The rent is at most $12,500.",
    ],
    [
      "a negation only the quote has",
      "The rent is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is not $14,250.",
      "The rent is not $12,500.",
    ],
    [
      "a negation in short only the quote has",
      "The rent is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent isn't $14,250.",
      "The rent isn't $12,500.",
    ],
    [
      "an expectation only the quote has",
      "The rent is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "The rent is expected to be $14,250.",
      "The rent is expected to be $12,500.",
    ],
    [
      "a cap only the quote has",
      "Interest is 6%.",
      "Change 1: 6%\nTo 1: 8%",
      "Interest is capped at 8%.",
      "Interest is capped at 6%.",
    ],
    [
      "an earlier period in the quote's first clause",
      "The rent is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "Before the amendment, the rent was $14,250.",
      "Before the amendment, the rent was $12,500.",
    ],
    [
      "another thing in a label",
      "Rent: $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "Deposit: $14,250.",
      "Deposit: $12,500.",
    ],
    [
      "another lease in the first clause",
      "Under the new lease, the rent is $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "Under the old lease, the rent is $14,250.",
      "Under the old lease, the rent is $12,500.",
    ],
    [
      "不超过 only the quote has",
      "租金为12000元。",
      "Change 1: 12000\nTo 1: 14250",
      "租金不超过14250元。",
      "租金不超过12000元。",
    ],
    [
      "不是 only the quote has",
      "租金是12万元。",
      "Change 1: 12万元\nTo 1: 15万元",
      "租金不是15万元。",
      "租金不是12万元。",
    ],
    [
      "预计 only the quote has",
      "租金为12000元。",
      "Change 1: 12000\nTo 1: 14250",
      "预计租金为14250元。",
      "预计租金为12000元。",
    ],
    [
      "最长 only the quote has",
      "工期为40天。",
      "Change 1: 40\nTo 1: 45",
      "工期最长为45天。",
      "工期最长为40天。",
    ],
    [
      "another thing in a Chinese label",
      "租金：12000元。",
      "Change 1: 12000\nTo 1: 14250",
      "押金：14250元。",
      "押金：12000元。",
    ],
    [
      "another lease in the first Chinese clause",
      "新租约下，租金为12000元。",
      "Change 1: 12000\nTo 1: 14250",
      "旧租约下，租金为14250元。",
      "旧租约下，租金为12000元。",
    ],
  ])("refuses %s, and rewrites a sentence that says it too", (_, sentence, reply, quote, same) => {
    expect(rewritten(sentence, reply, quote)).toEqual({ kind: "kept" });
    expect(rewritten(same, reply, quote)).toMatchObject({ kind: "rewritten" });
  });

  test('keeps a Chinese figure where only the sentence says 为, which may say "to", and rewrites one where both do', () => {
    const reply = "Change 1: 1.2亿元\nTo 1: 1.5亿元";
    expect(rewritten("公司去年营收为1.2亿元。", reply, "公司去年营收 1.5亿元。")).toEqual({
      kind: "kept",
    });
    expect(rewritten("公司去年营收为1.2亿元。", reply, "公司去年营收为 1.5亿元。")).toMatchObject({
      kind: "rewritten",
      correction: { choices: [{ wording: "1.5亿元" }] },
    });
  });
});

describe("A rewritten figure is said of the same thing in the same words, either side's", () => {
  test.each([
    [
      "a narrower thing",
      "Income was $2.1 million.",
      "Change 1: $2.1 million\nTo 1: $2.4 million",
      "Operating income was $2.4 million.",
      "Operating income was $2.1 million.",
    ],
    [
      "a narrower thing after it",
      "The rent is $12,000.",
      "Change 1: $12,000\nTo 1: $13,500",
      "The rent for the parking space is $13,500.",
      "The rent for the parking space is $12,000.",
    ],
    [
      "a narrower thing, in Chinese",
      "营收为3.3亿元。",
      "Change 1: 3.3亿元\nTo 1: 3.6亿元",
      "海外营收为3.6亿元。",
      "海外营收为3.3亿元。",
    ],
    [
      "may",
      "The rent is $12,000.",
      "Change 1: $12,000\nTo 1: $13,500",
      "The Landlord may raise the rent to $13,500.",
      "The Landlord may raise the rent to $12,000.",
    ],
    [
      "a condition",
      "The rent is $12,000.",
      "Change 1: $12,000\nTo 1: $13,500",
      "Upon renewal, the rent is $13,500.",
      "Upon renewal, the rent is $12,000.",
    ],
    [
      "a hedge on no list",
      "The rent is $12,000.",
      "Change 1: $12,000\nTo 1: $13,500",
      "The rent is in excess of $13,500.",
      "The rent is in excess of $12,000.",
    ],
    [
      "a cap, in Chinese",
      "租金为2400元。",
      "Change 1: 2400\nTo 1: 2600",
      "租金上限为2600元。",
      "租金上限为2400元。",
    ],
    [
      "a change for a level",
      "Revenue was $1.2 million.",
      "Change 1: $1.2 million\nTo 1: $1.5 million",
      "Revenue fell $1.5 million.",
      "Revenue fell $1.2 million.",
    ],
    [
      "to for by",
      "Revenue rose by 8%.",
      "Change 1: 8%\nTo 1: 12%",
      "Revenue rose to 12%.",
      "Revenue rose to 8%.",
    ],
    [
      "至 for none, in Chinese",
      "营收增长8%。",
      "Change 1: 8%\nTo 1: 12%",
      "营收增长至12%。",
      "营收增长至8%。",
    ],
    [
      "another party by one letter",
      "Party A pays $900.",
      "Change 1: $900\nTo 1: $1,200",
      "Party B pays $1,200.",
      "Party B pays $900.",
    ],
    [
      "the parties the other way round",
      "The Landlord pays the Tenant $5,000.",
      "Change 1: $5,000\nTo 1: $6,000",
      "The Tenant pays the Landlord $6,000.",
      "The Tenant pays the Landlord $5,000.",
    ],
    [
      "the parties the other way round, in Chinese",
      "甲方向乙方支付5000元。",
      "Change 1: 5000\nTo 1: 6000",
      "乙方向甲方支付6000元。",
      "乙方向甲方支付5000元。",
    ],
  ])(
    "refuses %s only the quote says, and rewrites a sentence that says it too",
    (_, sentence, reply, quote, same) => {
      expect(rewritten(sentence, reply, quote)).toEqual({ kind: "kept" });
      expect(rewritten(same, reply, quote)).toMatchObject({ kind: "rewritten" });
    },
  );

  test.each([
    ["shall", "The Tenant pays a fee of $250.", "The Tenant shall pay a fee of $300."],
    ["every", "Tenants pay $40 a month.", "Every tenant pays $55 a month."],
    [
      "a verb after by",
      "Either party may end it with 30 days' notice.",
      "Either party may end it by giving 45 days' notice.",
    ],
    ["annual beside a year", "The levy is $40 a year.", "The annual levy is $55 a year."],
    ["应", "乙方支付押金500元。", "乙方应支付押金600元。"],
  ])("rewrites where only the quote adds %s", (_, sentence, quote) => {
    const [from] = sentence.match(/\d[\d,]*/u) ?? [];
    const [to] = quote.match(/\d[\d,]*/u) ?? [];
    expect(rewritten(sentence, `Change 1: ${from}\nTo 1: ${to}`, quote)).toMatchObject({
      kind: "rewritten",
    });
  });

  test("refuses a figure the quote alone says rose, after it, and rewrites one that says so too", () => {
    const reply = "Change 1: $1.2 million\nTo 1: $1.5 million";
    const quote = "Revenue was $1.5 million, an increase.";
    expect(rewritten("Revenue was $1.2 million.", reply, quote)).toEqual({ kind: "kept" });
    expect(rewritten("Revenue was $1.2 million, an increase.", reply, quote)).toMatchObject({
      kind: "rewritten",
    });
    expect(rewritten("Revenue was $1.5 million.", "Change 1: none\nTo 1: none", quote)).toEqual({
      kind: "none",
    });
  });

  test("refuses annual where the sentence names no year", () => {
    expect(
      rewritten("The levy is $40.", "Change 1: $40\nTo 1: $55", "The annual levy is $55."),
    ).toEqual({ kind: "kept" });
  });
});

describe("A rewritten name keeps whose name it is", () => {
  test("refuses the other party's name, told by the words after it", () => {
    expect(
      rewritten(
        "Exampleton Holdings is the Landlord.",
        "Change 1: Exampleton Holdings\nTo 1: Sampleford Limited",
        "Sampleford Limited is the Tenant.",
      ),
    ).toEqual({ kind: "kept" });
    const reply = "Change 1: Exampleton Holdings\nTo 1: Sampleford Limited";
    expect(
      rewritten(
        "The lease is signed by Exampleton Holdings as the Landlord.",
        reply,
        "The lease is signed by Sampleford Limited as the Tenant.",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The lease is signed by Exampleton Holdings as the Landlord.",
        reply,
        "The lease is signed by Sampleford Limited as the Landlord.",
      ),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("refuses a subject in capitals for another, and writes a name after a linking word", () => {
    expect(
      rewritten("The Deposit is $14,250.", "Change 1: Deposit\nTo 1: Rent", "The Rent is $14,250."),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The rent is paid to Exampleton Holdings.",
        "Change 1: Exampleton Holdings\nTo 1: Sampleford Limited",
        "The rent is paid to Sampleford Limited.",
      ),
    ).toMatchObject({ kind: "rewritten" });
  });

  test.each([
    ["王先生", "项目负责人为王先生。"],
    ["王女士", "项目负责人为王女士。"],
    ["王博士", "项目负责人为王博士。"],
    ["王教授", "项目负责人为王教授。"],
    ["王主任", "项目负责人为王主任。"],
    ["王董", "项目负责人为王董。"],
    ["王工", "项目负责人为王工。"],
    ["张医生", "项目负责人为张医生。"],
    ["李太太", "项目负责人为李太太。"],
    ["王某", "项目负责人为王某。"],
    ["王师傅", "项目负责人为王师傅。"],
    ["王某某", "项目负责人为王某某。"],
    ["李阿姨", "项目负责人为李阿姨。"],
    ["王姐", "项目负责人为王姐。"],
    ["王哥", "项目负责人为王哥。"],
    ["王叔", "项目负责人为王叔。"],
    ["陈伯", "项目负责人为陈伯。"],
    ["王老", "项目负责人为王老。"],
    ["刘律", "项目负责人为刘律。"],
    ["李同学", "项目负责人为李同学。"],
  ])("refuses %s in Chinese: a surname and a title", (name, quote) => {
    expect(rewritten("项目负责人为李乙。", `Change 1: 李乙\nTo 1: ${name}`, quote)).toEqual({
      kind: "kept",
    });
  });

  test.each([
    ["a Chinese label", "出租人：张甲。", "承租人：李乙。", "出租人：李乙。"],
    [
      "a Chinese clause",
      "出租人，张甲，签署本合同。",
      "承租人，李乙，签署本合同。",
      "出租人，李乙，签署本合同。",
    ],
  ])(
    "refuses the other party's name through %s, and writes the same party's",
    (_, sentence, other, same) => {
      const reply = "Change 1: 张甲\nTo 1: 李乙";
      expect(rewritten(sentence, reply, other)).toEqual({ kind: "kept" });
      expect(rewritten(sentence, reply, same)).toMatchObject({ kind: "rewritten" });
    },
  );

  test("refuses the other party's name through an English clause, and writes the same party's", () => {
    const sentence = "For the Tenant, the signatory is Exampleton Holdings.";
    const reply = "Change 1: Exampleton Holdings\nTo 1: Sampleford Limited";
    expect(
      rewritten(sentence, reply, "For the Landlord, the signatory is Sampleford Limited."),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(sentence, reply, "For the Tenant, the signatory is Sampleford Limited."),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("refuses a place for a place in Chinese", () => {
    expect(rewritten("地点为王府。", "Change 1: 王府\nTo 1: 张家", "地点为张家。")).toEqual({
      kind: "kept",
    });
  });

  test("writes one of two Chinese names, the other kept", () => {
    expect(
      rewritten("签字人为张甲和李乙。", "Change 1: 张甲\nTo 1: 王丙", "签字人为王丙和李乙。"),
    ).toMatchObject({
      kind: "rewritten",
      correction: { from: "张甲", choices: [{ wording: "王丙" }] },
    });
  });
});

describe("A rewrite changes only the value that differs", () => {
  test.each([
    [
      "a condition after the figure",
      "The Tenant pays a monthly rent of $12,500.",
      "Change 1: $12,500.\nTo 1: $14,250, due on the first day of each month.",
      LEASE,
    ],
    [
      "a condition after the words",
      "Each tenant may keep one cat.",
      "Change 1: one cat\nTo 1: two cats if they keep them on a lead",
      "Each tenant may keep two cats if they keep them on a lead.",
    ],
    [
      "words after the figure's unit",
      "Invoices are paid within 30 days.",
      "Change 1: 30 days\nTo 1: 45 days after the invoice is received",
      "Invoices are paid within 45 days after the invoice is received.",
    ],
    [
      "a clause after the figure, in Chinese",
      "货款应在30日内支付。",
      "Change 1: 30日内支付\nTo 1: 45日内支付，逾期按日加收万分之五滞纳金",
      "货款应在45日内支付，逾期按日加收万分之五滞纳金。",
    ],
    [
      "a condition after a Chinese name",
      "项目负责人为李乙。",
      "Change 1: 李乙\nTo 1: 王丙但须经董事会批准",
      "项目负责人为王丙但须经董事会批准。",
    ],
    [
      "a negation",
      "The Landlord may enter the premises.",
      "Change 1: may enter\nTo 1: may not enter",
      "The Landlord may not enter the premises without notice.",
    ],
    [
      "another thing's name with its figure",
      "The deposit is $40,000.",
      "Change 1: deposit is $40,000\nTo 1: rent is $14,250",
      "The monthly rent is $14,250.",
    ],
    ["a role in Chinese", "合同由董事签署。", "Change 1: 董事\nTo 1: 经理", "合同由经理签署。"],
    [
      "a name with a title, in Chinese",
      "合同由李乙签署。",
      "Change 1: 李乙\nTo 1: 张经理",
      "合同由张经理签署。",
    ],
    [
      "a name with words after it, in Chinese",
      "项目负责人为李乙。",
      "Change 1: 李乙\nTo 1: 王丙女士",
      "项目负责人为王丙女士。",
    ],
    [
      "a company's name, in Chinese",
      "承租方为示例甲。",
      "Change 1: 示例甲\nTo 1: 示例乙",
      "承租方为示例乙。",
    ],
    [
      "a name of more than 8 words",
      "The Landlord is Exampleton Holdings.",
      "Change 1: Exampleton Holdings\nTo 1: Sampleford Commercial Property Investments Limited Trading As Sampleford Lettings",
      "The Landlord is Sampleford Commercial Property Investments Limited Trading As Sampleford Lettings.",
    ],
    [
      "a name with a word in capitals that isn't a company's",
      "The Landlord is Exampleton Holdings.",
      "Change 1: Exampleton Holdings\nTo 1: Examplegate Lettings UNLESS Ended",
      "The Landlord is Examplegate Lettings UNLESS Ended.",
    ],
    [
      "a Chinese name and others",
      "项目负责人为李乙。",
      "Change 1: 李乙\nTo 1: 王丙等",
      "项目负责人为王丙等。",
    ],
    [
      "a Chinese surname and title",
      "项目负责人为李乙。",
      "Change 1: 李乙\nTo 1: 王总",
      "项目负责人为王总。",
    ],
    [
      "two words that only start with a surname",
      "价格以黄金计。",
      "Change 1: 黄金\nTo 1: 林木",
      "价格以林木计。",
    ],
  ])("refuses %s", (_, sentence, reply, quote) => {
    expect(rewritten(sentence, reply, quote)).toEqual({ kind: "kept" });
  });

  test.each([
    [
      "another unit after the figure",
      "The engineer works 40 hours a week.",
      "Change 1: 40\nTo 1: 5",
      "The engineer works 5 days a week.",
    ],
    [
      "another area after the figure",
      "Rent is $40 per square foot.",
      "Change 1: $40\nTo 1: $45",
      "Rent is $45 per square metre.",
    ],
    [
      "another rate in short",
      "Rent is $12,000/yr.",
      "Change 1: $12,000\nTo 1: $14,250",
      "Rent is $14,250/month.",
    ],
    [
      "another rate per annum",
      "Interest is 5% p.a.",
      "Change 1: 5%\nTo 1: 6%",
      "Interest is 6% per month.",
    ],
    [
      "another rate in the subject, in Chinese",
      "年租金为12万元。",
      "Change 1: 12万元\nTo 1: 1.5万元",
      "月租金为1.5万元。",
    ],
    [
      "another rate before the figure, in Chinese",
      "租金按年支付，为12万元。",
      "Change 1: 12万元\nTo 1: 1万元",
      "租金按月支付，为1万元。",
    ],
    ["a fall for a rise", "Revenue fell by 5%.", "Change 1: 5%\nTo 1: 8%", "Revenue rose by 8%."],
    [
      "a loss for a profit",
      "The company made a loss of $2 million.",
      "Change 1: $2 million\nTo 1: $3 million",
      "The company made a profit of $3 million.",
    ],
    ["a fall for a rise, in Chinese", "营收下降5%。", "Change 1: 5%\nTo 1: 8%", "营收增长8%。"],
    [
      "another thing's name, whose quote names both",
      "The Deposit is $14,250.",
      "Change 1: Deposit\nTo 1: Rent",
      "The Rent is $14,250 and the Deposit is $42,750.",
    ],
    [
      "the other party's name, in Chinese",
      "出租人为张甲。",
      "Change 1: 张甲\nTo 1: 李乙",
      "出租人为王丙，承租人为李乙。",
    ],
  ])("refuses %s, from the words beside the value", (_, sentence, reply, quote) => {
    expect(rewritten(sentence, reply, quote)).toEqual({ kind: "kept" });
  });

  test.each([
    [
      "a figure",
      "The Tenant pays a monthly rent of $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      LEASE,
    ],
    [
      "a figure with its scale, in Chinese",
      "公司去年营收 1.2亿元。",
      "Change 1: 1.2亿元\nTo 1: 1.5亿元",
      "公司去年营收 1.5亿元。",
    ],
    [
      "a name",
      "The Landlord is Exampleton Holdings.",
      "Change 1: Exampleton Holdings\nTo 1: Sampleford Commercial Property Investments Limited",
      "The Landlord is Sampleford Commercial Property Investments Limited.",
    ],
    ["a Chinese name", "项目负责人为李乙。", "Change 1: 李乙\nTo 1: 王丙", "项目负责人为王丙。"],
    [
      "a Chinese name of the same surname",
      "项目负责人为李乙。",
      "Change 1: 李乙\nTo 1: 李丁",
      "项目负责人为李丁。",
    ],
    [
      "a figure from a numbered clause, whose number is no figure of it",
      "The Tenant pays a monthly rent of $12,500.",
      "Change 1: $12,500\nTo 1: $14,250",
      "1. The Tenant shall pay a monthly rent of $14,250.",
    ],
    ["a rise for a rise", "Revenue rose by 5%.", "Change 1: 5%\nTo 1: 8%", "Revenue rose by 8%."],
  ])("keeps %s for one", (_, sentence, reply, quote) => {
    expect(rewritten(sentence, reply, quote)).toMatchObject({ kind: "rewritten" });
  });

  test("refuses a figure for another rate", () => {
    expect(
      rewritten(
        "Rent is $12,000 per year.",
        "Change 1: $12,000\nTo 1: $14,250",
        "Rent is $14,250 per month.",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "每位员工每年享有 10 天带薪年假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每月享有 15 天带薪年假。",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "Rent is $12,000 per month.",
        "Change 1: $12,000\nTo 1: $14,250",
        "Rent is $14,250 per month.",
      ),
    ).toMatchObject({ kind: "rewritten" });
  });

  test("refuses a figure from a quote that gives two, which may be another thing's", () => {
    const line = "The monthly rent is $14,250 and the deposit is $42,750.";
    expect(rewritten("The deposit is $40,000.", "Change 1: $40,000\nTo 1: $14,250", line)).toEqual({
      kind: "kept",
    });
    expect(rewritten("The deposit is $40,000.", "Change 1: $40,000\nTo 1: $42,750", line)).toEqual({
      kind: "kept",
    });
    expect(
      rewritten(
        "每位员工每年享有 10 天病假。",
        "Change 1: 10\nTo 1: 15",
        "每位员工每年享有 15 天带薪年假和 5 天病假。",
      ),
    ).toEqual({ kind: "kept" });
    expect(
      rewritten(
        "The security deposit is $40,000.",
        "Change 1: $40,000\nTo 1: $42,750",
        "The security deposit is $42,750, held by the Landlord until the lease ends.",
      ),
    ).toMatchObject({ kind: "rewritten" });
  });
});

const SENTENCE = "Rent is 1100 dollars monthly.";
const LINE = "Rent is 1250 dollars monthly.";

/** A Note whose one sentence carries a check that found `line` saying something different. */
async function noteWithCheck(
  generate: (call: GenerateCall) => { text: string },
  change:
    | Partial<ClaimCheckAttributes>
    | ((evidence: CitationAttributes) => Partial<ClaimCheckAttributes>) = {},
  text = SENTENCE,
  cites = false,
  line = LINE,
) {
  const calls: GenerateCall[] = [];
  const model = scriptedModel(() => ({ text: "" }), {
    generate: (call) => {
      // Automatic tagging asks too, in the background: only the rewrite's requests count.
      if (call.system === REWRITE_INSTRUCTIONS) calls.push(call);
      return generate(call);
    },
  });
  const { core, client, mind, documents } = await setUpWithDocuments(model, [
    { name: "Rent.md", contents: `# Rent\n\n${line}` },
  ]);
  const [rent] = documents;
  if (!rent) throw new Error("The Document wasn't added.");
  const cited = await core.citeSelection({
    documentId: rent.id,
    parts: [{ unit: null, text: line }],
  });
  const evidence: CitationAttributes = {
    ...cited,
    documentId: rent.id,
    documentName: rent.name,
    check: "found",
    checkReason: null,
  };
  const check: ClaimCheckAttributes = {
    id: "check-rent",
    request: "request-rent",
    action: "check-against-documents",
    state: "unsupported",
    reason: null,
    detail: null,
    providerId: "ollama",
    modelId: "local-model",
    text: SENTENCE,
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: "2026-11-04T00:00:00.000Z",
    ...(typeof change === "function" ? change(evidence) : change),
  };
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "rent-block" },
      content: cites
        ? [
            {
              type: "text",
              text: text.slice(0, -1),
              marks: [{ type: "claimCheck", attrs: check }],
            },
            { type: "citation", attrs: evidence },
            { type: "text", text: text.slice(-1), marks: [{ type: "claimCheck", attrs: check }] },
          ]
        : [{ type: "text", text, marks: [{ type: "claimCheck", attrs: check }] }],
    },
  ]);
  await client.settled();
  return { core, mindId: mind.id, calls, cited, documentId: rent.id, path: rent.path };
}

/** Files the Document in a Folder that keeps its work inside it, which the Note is outside. */
async function wallOff(core: Core, documentId: string): Promise<string> {
  const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.assignDocumentGroup(documentId, folder.id);
  await core.updateLibraryGroup(folder.id, { name: "Client A", description: "", keepInside: true });
  return folder.id;
}

describe("rewriteFromDocuments", () => {
  test("asks the check's model about the Passage it found and gives back the correction", async () => {
    const { core, mindId, calls, cited } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    const result = await core.rewriteFromDocuments({ mindId, checkId: "check-rent" });
    expect(result).toMatchObject({
      kind: "rewritten",
      correction: {
        from: "1100",
        choices: [{ wording: "1250", evidence: { quote: cited.quote, check: "found" } }],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe(REWRITE_INSTRUCTIONS);
    expect(calls[0]?.prompt).toContain(SENTENCE);
    expect(calls[0]?.prompt).toContain(LINE);
  });

  test("says the value is the same only when the sentence gives the Passage's, else that the model found nothing", async () => {
    const none = () => ({ text: "Change 1: none\nTo 1: none" });
    const other = await noteWithCheck(none);
    expect(
      await other.core.rewriteFromDocuments({ mindId: other.mindId, checkId: "check-rent" }),
    ).toEqual({ kind: "none" });
    expect(other.calls).toHaveLength(1);
    const same = await noteWithCheck(none, { text: LINE }, LINE);
    expect(
      await same.core.rewriteFromDocuments({ mindId: same.mindId, checkId: "check-rent" }),
    ).toEqual({ kind: "same" });
    expect(same.calls).toHaveLength(1);
  });

  test("keeps an amount the Passage gives a year for, and writes a measure whose digits look like one", async () => {
    const year = await noteWithCheck(
      () => ({ text: "Change 1: 500\nTo 1: 2025" }),
      { text: "The grant was 500." },
      "The grant was 500.",
      false,
      "The grant was in 2025.",
    );
    expect(
      await year.core.rewriteFromDocuments({ mindId: year.mindId, checkId: "check-rent" }),
    ).toEqual({ kind: "kept" });
    const measure = await noteWithCheck(
      () => ({ text: "Change 1: 1,800\nTo 1: 2025" }),
      { text: "The lot is 1,800 square feet." },
      "The lot is 1,800 square feet.",
      false,
      "The lot is 2025 square feet.",
    );
    expect(
      await measure.core.rewriteFromDocuments({ mindId: measure.mindId, checkId: "check-rent" }),
    ).toMatchObject({ kind: "rewritten", correction: { choices: [{ wording: "2025" }] } });
  });

  test.each([
    ["The grant was 500 after approval.", "The grant was in 2025 after approval.", "500", "2025"],
    [
      "The grant was paid 500 after approval.",
      "The grant was paid in 2025 after approval.",
      "500",
      "2025",
    ],
    ["合同期限为 3 财年。", "合同期限为 2025 财年。", "3", "2025"],
    ["The grant was 500.", "The grant was in ２０２５.", "500", "２０２５"],
    [
      "The grant was paid 500 under the scheme.",
      "The grant was paid in 2025 under the scheme.",
      "500",
      "2025",
    ],
    ["预算期为 3 会计年度。", "预算期为 2025 会计年度。", "3", "2025"],
    ["数据来自 300 家庭调查。", "数据来自 2024 家庭调查。", "300", "2024"],
    ["The fee was paid 500 monthly.", "The fee was paid in 2025 monthly.", "500", "2025"],
    ["The grant was paid 500 in person.", "The grant was paid in 2025 in person.", "500", "2025"],
    ["The grant was paid 500 in shares.", "The grant was paid in 2025 in shares.", "500", "2025"],
    ["The award was 500.", "The award was 2025.", "500", "2025"],
    ["The award was 500.", "The award was ２０２５.", "500", "２０２５"],
    [
      "The hall seats 1800 people on the ground floor.",
      "The hall seats 2020 people on the ground floor.",
      "1800",
      "2020",
    ],
    [
      "The grant was 500 pending approval.",
      "The grant was in 2025 pending approval.",
      "500",
      "2025",
    ],
    [
      "The grant was paid 500 shortly after approval.",
      "The grant was paid in 2025 shortly after approval.",
      "500",
      "2025",
    ],
    [
      "The grant was paid 500 per the agreement.",
      "The grant was paid in 2025 per the agreement.",
      "500",
      "2025",
    ],
    [
      "The fee was agreed at 500 in long negotiations.",
      "The fee was agreed in 2025 in long negotiations.",
      "500",
      "2025",
    ],
    [
      "The grant was paid 500 in long-term instalments.",
      "The grant was paid in 2025 in long-term instalments.",
      "500",
      "2025",
    ],
    ["The grant was paid 500 in full.", "The grant was paid in 2025 in full.", "500", "2025"],
    [
      "The grant was paid 500 per head office instructions.",
      "The grant was paid in 2025 per head office instructions.",
      "500",
      "2025",
    ],
    [
      "The fee was agreed at 500 in long, difficult negotiations.",
      "The fee was agreed in 2025 in long, difficult negotiations.",
      "500",
      "2025",
    ],
    [
      "The cost was stated as a constant 500 dollars.",
      "The cost was stated in constant 2025 dollars.",
      "500",
      "2025",
    ],
    [
      "The fee was agreed at about 500 in long negotiations.",
      "The fee was agreed in about 2025 in long negotiations.",
      "500",
      "2025",
    ],
    [
      "The fee was agreed in about 500 in long negotiations.",
      "The fee was agreed in about 2025 in long negotiations.",
      "500",
      "2025",
    ],
  ])("keeps %s where the Passage gives a year: %s", async (sentence, line, from, to) => {
    const { core, mindId } = await noteWithCheck(
      () => ({ text: `Change 1: ${from}\nTo 1: ${to}` }),
      { text: sentence },
      sentence,
      false,
      line,
    );
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "kept",
    });
  });

  test.each([
    ["The fee is $1,800.", "The fee is $2025.", "$1,800", "$2025"],
    ["The track is 1800 m long.", "The track is 2025 m long.", "1800", "2025"],
    ["The pipe is 1100 in long.", "The pipe is 2025 in long.", "1100", "2025"],
    ["The hire costs 1100 per day.", "The hire costs 2025 per day.", "1100", "2025"],
    ["Catering costs 1500 per head.", "Catering costs 2024 per head.", "1500", "2024"],
    ["Scrap sells at 1800 per kg.", "Scrap sells at 2025 per kg.", "1800", "2025"],
    [
      "The hall seats 1800 people.",
      "The hall seats 2020 people. It opened last year.",
      "1800",
      "2020",
    ],
    [
      "The cost was stated as a constant 500 dollars.",
      "The cost was stated as a constant 2025 dollars.",
      "500",
      "2025",
    ],
  ])(
    "writes %s's figure from a measure whose digits look like a year: %s",
    async (sentence, line, from, to) => {
      const { core, mindId } = await noteWithCheck(
        () => ({ text: `Change 1: ${from}\nTo 1: ${to}` }),
        { text: sentence },
        sentence,
        false,
        line,
      );
      expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
        kind: "rewritten",
      });
    },
  );

  test.each([
    ["Revenue rose by about 8%.", "Revenue rose to about 12%.", "kept"],
    ["Revenue rose to about 8%.", "Revenue rose to about 12%.", "rewritten"],
    ["营收增长约8%。", "营收增长至约12%。", "kept"],
    ["营收增长至约8%。", "营收增长至约12%。", "rewritten"],
  ])(
    "reads the word that makes %s's figure a change or a level past the word after it, from %s: %s",
    async (sentence, line, kind) => {
      const { core, mindId } = await noteWithCheck(
        () => ({ text: "Change 1: 8%\nTo 1: 12%" }),
        { text: sentence },
        sentence,
        false,
        line,
      );
      expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
        kind,
      });
    },
  );

  test.each([
    [
      "Total spending by Marketing was $1.2 million.",
      "Total spending by Engineering was $8.1 million.",
      "1.2",
      "8.1",
      "kept",
    ],
    [
      "Total spending by Sales was $1.2 million.",
      "Total spending by Sales was $8.1 million.",
      "1.2",
      "8.1",
      "rewritten",
    ],
    [
      "Sales by Beijing rose to 500 units.",
      "Sales by Nanjing rose to 600 units.",
      "500",
      "600",
      "kept",
    ],
    ["Revenue earned by Consulting was $500.", "Revenue earned was $600.", "500", "600", "kept"],
    ["Costs covered by financing were 500.", "Costs covered were 600.", "500", "600", "kept"],
    ["Funds raised by giving circles were 500.", "Funds raised were 600.", "500", "600", "kept"],
    ["The rent paid by the Tenant is $500.", "The rent paid is $600.", "500", "600", "kept"],
    [
      "The rent paid by the Tenant is $500.",
      "The rent paid by the Tenant is $600.",
      "500",
      "600",
      "rewritten",
    ],
    [
      "Either party may end it with 30 days' notice.",
      "Either party may end it by giving 45 days' notice.",
      "30",
      "45",
      "rewritten",
    ],
    [
      "The project was funded by borrowing 500 million.",
      "The project was funded by issuing 600 million.",
      "500",
      "600",
      "kept",
    ],
    ["项目通过借款筹集5亿元。", "项目通过发债筹集6亿元。", "5", "6", "kept"],
    ["由市场部承担的费用为120万元。", "由工程部承担的费用为810万元。", "120", "810", "kept"],
    ["由市场部承担的费用为120万元。", "由市场部承担的费用为810万元。", "120", "810", "rewritten"],
  ])(
    "reads the word after by in %s as whose figure it is, from %s",
    async (sentence, line, from, to, kind) => {
      const { core, mindId } = await noteWithCheck(
        () => ({ text: `Change 1: ${from}\nTo 1: ${to}` }),
        { text: sentence },
        sentence,
        false,
        line,
      );
      expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
        kind,
      });
    },
  );

  test.each([
    ["注册资本增加1000万元。", "注册资本增加为2000万元。", "1000", "2000", "kept"],
    ["租金上调500元。", "租金上调为3000元。", "500", "3000", "kept"],
    ["租金提高500元。", "租金提高为3000元。", "500", "3000", "kept"],
    ["租金上涨500元。", "租金上涨为3000元。", "500", "3000", "kept"],
    ["营收减少2亿元。", "营收减少为5亿元。", "2", "5", "kept"],
    ["注册资本增加1000万元。", "注册资本增加至2000万元。", "1000", "2000", "kept"],
    ["注册资本增加至1000万元。", "注册资本增加至2000万元。", "1000", "2000", "rewritten"],
    ["注册资本增加为1000万元。", "注册资本增加为2000万元。", "1000", "2000", "rewritten"],
    ["Rent rose 500 dollars.", "Rent rose to 3000 dollars.", "500", "3000", "kept"],
    ["Rent rose to 2500 dollars.", "Rent rose to 3000 dollars.", "2500", "3000", "rewritten"],
  ])(
    "reads 为 after a change verb in %s as a level, as 至 is, from %s",
    async (sentence, line, from, to, kind) => {
      const { core, mindId } = await noteWithCheck(
        () => ({ text: `Change 1: ${from}\nTo 1: ${to}` }),
        { text: sentence },
        sentence,
        false,
        line,
      );
      expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
        kind,
      });
    },
  );

  test.each([
    ["租赁期限延长2年。", "租赁期限延长为5年。", "2", "5", "kept"],
    ["付款期限缩短10天。", "付款期限缩短为30天。", "10", "30", "kept"],
    ["成本压缩500万元。", "成本压缩为2000万元。", "500", "2000", "kept"],
    ["亏损收窄2000万元。", "亏损收窄为500万元。", "2000", "500", "kept"],
    ["授信额度放宽1000万元。", "授信额度放宽为5000万元。", "1000", "5000", "kept"],
    ["管道加长20米。", "管道加长为50米。", "20", "50", "kept"],
    ["租赁期限延长为2年。", "租赁期限延长为5年。", "2", "5", "rewritten"],
    [
      "乙方以设备作抵押，借款500万元。",
      "乙方以设备作为抵押，借款600万元。",
      "500",
      "600",
      "rewritten",
    ],
    ["因乙方逾期，违约金为500元。", "因为乙方逾期，违约金为700元。", "500", "700", "rewritten"],
    ["董事会认为损失为500万元。", "董事会认为损失为800万元。", "500", "800", "rewritten"],
    ["公司为客户垫付500元。", "公司为客户垫付600元。", "500", "600", "rewritten"],
    ["The lease was extended by 2 years.", "The lease was extended to 5 years.", "2", "5", "kept"],
    [
      "The lease was extended to 2 years.",
      "The lease was extended to 5 years.",
      "2",
      "5",
      "rewritten",
    ],
  ])(
    'compares 为 in %s unless its word says no "to", from %s',
    async (sentence, line, from, to, kind) => {
      const { core, mindId } = await noteWithCheck(
        () => ({ text: `Change 1: ${from}\nTo 1: ${to}` }),
        { text: sentence },
        sentence,
        false,
        line,
      );
      expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
        kind,
      });
    },
  );

  test("keeps the sentence when the model's words aren't the Passage's", async () => {
    const { core, mindId, calls } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1300",
    }));
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "kept",
    });
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["its check isn't unsupported", { state: "supported" as const }, SENTENCE, false],
    ["its check found no Passage", { evidence: null }, SENTENCE, false],
    ["its words changed since the check", {}, "Rent is 1100 dollars a month.", false],
    ["it has a Citation now", {}, SENTENCE, true],
  ])("sends nothing when %s", async (_, change, text, cites) => {
    const { core, mindId, calls } = await noteWithCheck(
      () => ({ text: "Change 1: 1100\nTo 1: 1250" }),
      change,
      text,
      cites,
    );
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(0);
  });

  test("sends nothing when the Passage's quote isn't in the Document any more", async () => {
    const moved = await noteWithCheck(
      () => ({ text: "Change 1: 1100\nTo 1: 1250" }),
      (evidence) => ({ evidence: { ...evidence, quote: "Rent is 1250 euros monthly." } }),
    );
    expect(
      await moved.core.rewriteFromDocuments({ mindId: moved.mindId, checkId: "check-rent" }),
    ).toEqual({ kind: "changed" });
    expect(moved.calls).toHaveLength(0);
    // The same Note with the Document's own quote is asked.
    const held = await noteWithCheck(() => ({ text: "Change 1: 1100\nTo 1: 1250" }));
    expect(
      await held.core.rewriteFromDocuments({ mindId: held.mindId, checkId: "check-rent" }),
    ).toMatchObject({ kind: "rewritten" });
    expect(held.calls).toHaveLength(1);
  });

  test("sends nothing once the Passage's Document is behind a Folder wall the Note is outside", async () => {
    const { core, mindId, calls, documentId } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toMatchObject({
      kind: "rewritten",
    });
    expect(calls).toHaveLength(1);
    await wallOff(core, documentId);
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(1);
  });

  test("sends nothing once a new version of the Document came, even one that still holds the quote", async () => {
    const { core, mindId, calls, documentId, path } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    await writeFile(path, `# Rent\n\nThe flat is on the second floor.\n\n${LINE}`);
    await core.reconcileDocuments();
    const [processed] = await waitForProcessing(core, [documentId]);
    expect(processed?.status).toBe("ready");
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["its Document went to Recently deleted", "deleted"],
    ["its Document is the User's own workings, never cited", "not cited"],
  ])("sends nothing when %s", async (_, change) => {
    const { core, mindId, calls, documentId } = await noteWithCheck(() => ({
      text: "Change 1: 1100\nTo 1: 1250",
    }));
    if (change === "deleted") await core.deleteDocument(documentId);
    else await core.setNotCited(documentId, true);
    expect(await core.rewriteFromDocuments({ mindId, checkId: "check-rent" })).toEqual({
      kind: "changed",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("A Citation chosen in a Document's viewer", () => {
  test("is refused for a Note outside the Folder wall the Document is behind", async () => {
    const { core, mindId, documentId } = await noteWithCheck(() => ({ text: "" }));
    const parts = [{ unit: null, text: LINE }];
    expect(await core.citeSelection({ documentId, parts, mindId })).toMatchObject({
      quote: LINE,
    });
    const folderId = await wallOff(core, documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "This Folder keeps its work inside it.",
    );
    // Inside the wall, the same words are cited.
    const inside = await core.createMind({ title: "Client A note", folderId });
    expect(await core.citeSelection({ documentId, parts, mindId: inside.id })).toMatchObject({
      quote: LINE,
    });
  });

  test("is refused while its Document is in Recently deleted, behind a wall or not", async () => {
    const { core, mindId, documentId } = await noteWithCheck(() => ({ text: "" }));
    const parts = [{ unit: null, text: LINE }];
    await core.deleteDocument(documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "That Document no longer exists.",
    );
    await core.restore([{ kind: "document", id: documentId }]);
    expect(await core.citeSelection({ documentId, parts, mindId })).toMatchObject({ quote: LINE });
    await wallOff(core, documentId);
    await core.deleteDocument(documentId);
    await expect(core.citeSelection({ documentId, parts, mindId })).rejects.toThrow(
      "That Document no longer exists.",
    );
  });
});
