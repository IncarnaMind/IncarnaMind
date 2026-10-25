import { describe, expect, test } from "vitest";
import {
  type CitedPlace,
  continuesCitation,
  overlapsCitation,
} from "../../src/shared/citationOverlap";

const place = (quote: string | null, over: Partial<CitedPlace> = {}): CitedPlace => ({
  documentId: "lease",
  contentHash: "v1",
  pageFrom: 4,
  pageTo: 4,
  quote,
  ...over,
});

const overlap = (cited: string, found: string) => overlapsCitation(place(cited), place(found));

const CLAUSE =
  "The Tenant may work from the premises two days a week, agreed in advance with the Landlord.";
const CLAUSE_ZH = "员工每周最多可远程办公两天，须提前与经理商定。";

describe("a Citation and the Passage a check found overlap", () => {
  test("when they quote the same words", () => {
    expect(overlap(CLAUSE, CLAUSE)).toBe(true);
  });

  test("when the Passage found is longer than the Citation's quote, or shorter", () => {
    const slice = "may work from the premises two days a week";
    expect(overlap(slice, CLAUSE)).toBe(true);
    expect(overlap(CLAUSE, slice)).toBe(true);
  });

  test("whatever the case, punctuation, hyphenation or ligatures, and with an ellipsis for words left out", () => {
    expect(
      overlap("THE TENANT MAY WORK FROM THE PREMISES — two days a week; agreed in advance", CLAUSE),
    ).toBe(true);
    expect(overlap("The Tenant may work from the premises ... agreed in advance", CLAUSE)).toBe(
      true,
    );
    expect(
      overlap("inter-\nnational trade rules apply", "International trade rules apply to members."),
    ).toBe(true);
    expect(overlap("ﬁnance team approves all spend", "The finance team approves all spend.")).toBe(
      true,
    );
  });

  test("when a table's row is quoted against the prose that says it", () => {
    expect(overlap("| Water filter | 0.4 kg |", "The water filter weighs 0.4 kg.")).toBe(true);
  });

  test("not when only half the words of the shorter quote are in the other", () => {
    expect(overlap("Employee bonus", "The Employee may work from home two days a week.")).toBe(
      false,
    );
    expect(overlap("Tenant may work two days", "The Tenant may work from home on Fridays")).toBe(
      false,
    );
  });

  test("not when they are different clauses that share a phrase or a figure's shape", () => {
    const pairs = [
      ["Rent is £1,200 per month, payable in advance.", "Late rent incurs a fee of £50 per month."],
      ["Revenue was $4.2 million in 2024.", "Revenue was $5.1 million in 2023."],
      ["The term ends on 14 February 2029.", "The term ends on 14 February 2027."],
      [
        "The Company shall indemnify the Tenant against all claims.",
        "The Company shall maintain insurance against all claims.",
      ],
      ["The notice period is three months.", CLAUSE],
      [
        "The Tenant shall pay the rent monthly in advance.",
        "The Tenant shall keep the premises clean.",
      ],
    ] as const;
    for (const [cited, found] of pairs) {
      expect(overlap(cited, found), cited).toBe(false);
      expect(overlap(found, cited), found).toBe(false);
    }
  });

  test("when a clause is negated, which it can't tell: in doubt it counts as cited", () => {
    expect(overlap("The Tenant may not work remotely", "The Tenant may work remotely")).toBe(true);
  });

  test("not when they are in different Documents, or the Citation has none", () => {
    expect(overlapsCitation(place(CLAUSE, { documentId: "other" }), place(CLAUSE))).toBe(false);
    expect(overlapsCitation(place(CLAUSE, { documentId: null }), place(CLAUSE))).toBe(false);
  });
});

describe("the Passage a check found says more than the Citation's quote", () => {
  const continues = (cited: string, found: string, sentence: string) =>
    continuesCitation(place(cited), place(found), sentence);

  test("when the sentence says the rest of the clause too", () => {
    expect(continues("two days a week", CLAUSE, CLAUSE)).toBe(true);
    expect(
      continues(
        "may work from the premises two days a week",
        CLAUSE,
        "The Tenant may work from the premises two days a week, agreed in advance with the Landlord.",
      ),
    ).toBe(true);
  });

  test("not when the sentence doesn't say the rest, or the Citation quotes the whole of it", () => {
    expect(continues("two days a week", CLAUSE, "The Tenant may work two days a week.")).toBe(
      false,
    );
    expect(continues(CLAUSE, CLAUSE, CLAUSE)).toBe(false);
    expect(continues("may work from the premises two days a week", "two days a week", CLAUSE)).toBe(
      false,
    );
  });

  test("not for another clause, another Document, or a Place that doesn't meet", () => {
    expect(continues("two days a week", "The notice period is three months.", CLAUSE)).toBe(false);
    expect(
      continuesCitation(place("two days a week"), place(CLAUSE, { documentId: "other" }), CLAUSE),
    ).toBe(false);
    expect(
      continuesCitation(
        place("two days a week", { pageFrom: 3, pageTo: 3 }),
        place(CLAUSE, { pageFrom: 9, pageTo: 9 }),
        CLAUSE,
      ),
    ).toBe(false);
  });

  test("in Chinese, whatever the punctuation and width", () => {
    const part = "每周最多可远程办公两天";
    expect(continues(part, CLAUSE_ZH, CLAUSE_ZH)).toBe(true);
    expect(continues(part, CLAUSE_ZH, "员工每周最多可远程办公两天。")).toBe(false);
  });
});

describe("a Citation's place", () => {
  test("is another place when the same words are on a page that doesn't meet", () => {
    const here = place(CLAUSE, { pageFrom: 3, pageTo: 3 });
    expect(overlapsCitation(here, place(CLAUSE, { pageFrom: 9, pageTo: 9 }))).toBe(false);
    expect(overlapsCitation(here, place(CLAUSE, { pageFrom: 4, pageTo: 4 }))).toBe(false);
    expect(overlapsCitation(here, place(CLAUSE, { pageFrom: 3, pageTo: 3 }))).toBe(true);
    expect(overlapsCitation(here, place(CLAUSE, { pageFrom: 3, pageTo: 4 }))).toBe(true);
    expect(overlapsCitation(here, place(CLAUSE, { pageFrom: 2, pageTo: 5 }))).toBe(true);
  });

  test("is left to the words where a side has no page, or the Document's version differs", () => {
    const here = place(CLAUSE, { pageFrom: 3, pageTo: 3 });
    expect(overlapsCitation(here, place(CLAUSE, { pageFrom: null, pageTo: null }))).toBe(true);
    expect(overlapsCitation(place(CLAUSE, { pageFrom: null, pageTo: null }), here)).toBe(true);
    expect(
      overlapsCitation(here, place(CLAUSE, { pageFrom: 9, pageTo: 9, contentHash: "v2" })),
    ).toBe(true);
    expect(
      overlapsCitation(here, place(CLAUSE, { pageFrom: 9, pageTo: 9, contentHash: null })),
    ).toBe(true);
    expect(
      overlapsCitation(
        place("Late rent incurs a fee", { contentHash: "v2" }),
        place(CLAUSE, { pageFrom: 9, pageTo: 9 }),
      ),
    ).toBe(false);
  });

  test("decides alone when a quote has no words: the pages meeting, or in doubt a side with no page", () => {
    expect(overlapsCitation(place(null), place(CLAUSE))).toBe(true);
    expect(overlapsCitation(place(null, { pageFrom: 3, pageTo: 5 }), place(CLAUSE))).toBe(true);
    expect(overlapsCitation(place(null, { pageFrom: 9, pageTo: 9 }), place(CLAUSE))).toBe(false);
    expect(overlapsCitation(place(null, { pageFrom: null, pageTo: null }), place(CLAUSE))).toBe(
      true,
    );
    expect(
      overlapsCitation(
        place(null, { pageFrom: null, pageTo: null }),
        place(CLAUSE, { pageFrom: null, pageTo: null }),
      ),
    ).toBe(true);
  });
});

describe("in Chinese", () => {
  test("a Citation overlaps whatever the punctuation, width and script, and however much it quotes", () => {
    expect(overlap(CLAUSE_ZH, CLAUSE_ZH)).toBe(true);
    expect(overlap("员工每周最多可远程办公两天,须提前与经理商定.", CLAUSE_ZH)).toBe(true);
    expect(overlap("员工每周最多可远程办公两天、须提前与经理商定", CLAUSE_ZH)).toBe(true);
    expect(overlap("員工每週最多可遠程辦公兩天，須提前與經理商定。", CLAUSE_ZH)).toBe(true);
    expect(overlap("每周最多可远程办公两天", CLAUSE_ZH)).toBe(true);
    expect(overlap(CLAUSE_ZH, "每周最多可远程办公两天")).toBe(true);
    expect(overlap(`第 4 条：${CLAUSE_ZH}`, CLAUSE_ZH)).toBe(true);
  });

  test("a Citation to a different clause, a different figure or a different Document doesn't", () => {
    const pairs = [
      [CLAUSE_ZH, "试用期为三个月，期间任何一方可随时解除合同。"],
      [CLAUSE_ZH, "员工每周最多可远程办公三天，须提前与经理商定。"],
      ["租金为每月 1,200 元，须提前支付。", "逾期支付租金须缴纳每月 50 元的滞纳金。"],
      ["2024 年收入为 4.2 亿元。", "2023 年收入为 5.1 亿元。"],
      ["合同于 2029 年 2 月 14 日终止。", "合同于 2027 年 2 月 14 日终止。"],
      ["公司应赔偿租户的全部索赔。", "公司应为租户的房屋购买财产保险。"],
    ] as const;
    for (const [cited, found] of pairs) {
      expect(overlap(cited, found), cited).toBe(false);
      expect(overlap(found, cited), found).toBe(false);
    }
    expect(overlapsCitation(place(CLAUSE_ZH, { documentId: "other" }), place(CLAUSE_ZH))).toBe(
      false,
    );
  });

  test("the same words on a page that doesn't meet are another place", () => {
    expect(
      overlapsCitation(
        place(CLAUSE_ZH, { pageFrom: 3, pageTo: 3 }),
        place(CLAUSE_ZH, { pageFrom: 9, pageTo: 9 }),
      ),
    ).toBe(false);
  });
});
