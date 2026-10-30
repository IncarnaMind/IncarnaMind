import { describe, expect, test } from "vitest";
import { INLINE_NODE, isClaim, sentenceSpans } from "../../src/shared/sentences";

const sentences = (text: string) => sentenceSpans(text).map(({ from, to }) => text.slice(from, to));

describe("The sentences of a paragraph", () => {
  test("are split at their full stops, and keep their figures whole", () => {
    expect(
      sentences(
        `Net leverage was 3.1× at the end of the quarter, ${INLINE_NODE} inside the 3.5× limit in clause 7.1. Online sales grew 12% in the quarter.`,
      ),
    ).toEqual([
      `Net leverage was 3.1× at the end of the quarter, ${INLINE_NODE} inside the 3.5× limit in clause 7.1.`,
      "Online sales grew 12% in the quarter.",
    ]);
  });

  test("a Citation right after a full stop belongs to the sentence before it", () => {
    expect(
      sentences(`Spring tides come at full moon.${INLINE_NODE} Neap tides come between.`),
    ).toEqual([`Spring tides come at full moon.${INLINE_NODE}`, "Neap tides come between."]);
  });

  test("a court decision's citation stays in one sentence, with its court and year", () => {
    expect(
      sentences(
        "See Hallmark Builders v. Rio Grande Supply, 512 S.W.3d 101 (Tex. 2017). Penguins nest here. Cf. Acme Corp. v. Widget Co., 25 F. Supp. 2d 345, 350 (S.D.N.Y. 1998). Donoghue v Stevenson [1932] AC 562 is older.",
      ),
    ).toEqual([
      "See Hallmark Builders v. Rio Grande Supply, 512 S.W.3d 101 (Tex. 2017).",
      "Penguins nest here.",
      "Cf. Acme Corp. v. Widget Co., 25 F. Supp. 2d 345, 350 (S.D.N.Y. 1998).",
      "Donoghue v Stevenson [1932] AC 562 is older.",
    ]);
  });

  test.each([
    ["The duty arises under the Act.", "See Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."],
    ["The lien attached in Texas.", "See Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."],
    ["Revenue fell in Q3.", "See Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."],
    ["The supplier was owned by IBM.", "See Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."],
    ["Yes.", "See Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."],
    [
      "It was formed in Delaware.",
      "Under Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017), it attaches.",
    ],
    [
      "The plan is Plan A.",
      "In Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017), it was upheld.",
    ],
    ["The case arose in the U.S.", "Brown v. Board of Education, 347 U.S. 483 (1954), decided it."],
    ["The buyer was Acme Co.", "Smith v. Jones, 12 F.3d 5 (1st Cir. 1994), is cited."],
  ])("the sentence before a citation stays apart from it: %j", (before, cited) => {
    expect(sentences(`${before} ${cited}`)).toEqual([before, cited]);
  });

  test.each([
    "Smith Dep. 45:3–12",
    "Compl. ¶ 14",
    "Smith Decl. ¶¶ 3–5",
    "Pl.'s Ex. 7, p. 3",
    "Dep. Tr. 45:3–12",
  ])("a record cite stays in one sentence: %s", (raw) => {
    expect(sentences(`See ${raw}. Next sentence stays apart.`)).toEqual([
      `See ${raw}.`,
      "Next sentence stays apart.",
    ]);
  });

  test("a parenthesized record cite stays in its English or Chinese sentence", () => {
    expect(
      sentences("The witness denied it (Smith Dep. 45:3–12). Next sentence stays apart."),
    ).toEqual(["The witness denied it (Smith Dep. 45:3–12).", "Next sentence stays apart."]);
    expect(sentences("笔录确认证人否认了这一点 (Smith Dep. 45:3–12)。下一句仍然独立。")).toEqual([
      "笔录确认证人否认了这一点 (Smith Dep. 45:3–12)。",
      "下一句仍然独立。",
    ]);
  });

  test("a record cite starts after the sentence before it", () => {
    expect(sentences("The testimony ended. Smith Dep. 45:3–12 is the cited passage.")).toEqual([
      "The testimony ended.",
      "Smith Dep. 45:3–12 is the cited passage.",
    ]);
  });

  test("a sentence of record cites alone belongs to the sentence it supports", () => {
    expect(sentences("Plaintiff left at noon. Smith Dep. 45:3–12. The next fact.")).toEqual([
      "Plaintiff left at noon. Smith Dep. 45:3–12.",
      "The next fact.",
    ]);
    expect(sentences("He signed it. See also Def.'s Ex. 7 at 3; Id. at 4.")).toEqual([
      "He signed it. See also Def.'s Ex. 7 at 3; Id. at 4.",
    ]);
    expect(sentences("原告中午离开。（Smith Dep. 45:3–12）。下一句。")).toEqual([
      "原告中午离开。（Smith Dep. 45:3–12）。",
      "下一句。",
    ]);
    expect(sentences("Smith Dep. 45:3–12. The first sentence cites only.")).toEqual([
      "Smith Dep. 45:3–12.",
      "The first sentence cites only.",
    ]);
  });

  test("a court decision's citation sentence stays a sentence of its own", () => {
    expect(
      sentences("The rule is settled. Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."),
    ).toEqual(["The rule is settled.", "Hallmark v. Rio Grande, 512 S.W.3d 101 (Tex. 2017)."]);
  });

  test.each(["Dep.", "Compl.", "Decl.", "p.", "Tr."])(
    "an incomplete record abbreviation does not join sentences: %s",
    (abbreviation) => {
      expect(
        sentences(`The note ends with ${abbreviation} Next sentence remains separate.`),
      ).toEqual([`The note ends with ${abbreviation}`, "Next sentence remains separate."]);
    },
  );

  test("Chinese sentences end at 。！？", () => {
    expect(sentences("今天的潮水很高。明天会更高！真的吗？")).toEqual([
      "今天的潮水很高。",
      "明天会更高！",
      "真的吗？",
    ]);
  });

  test("a title doesn't end a sentence, and a line break does", () => {
    expect(sentences("Mr. Smith signed it. Fig. 2 shows why.\nNext line")).toEqual([
      "Mr. Smith signed it.",
      "Fig. 2 shows why.",
      "Next line",
    ]);
  });

  test("nothing but spaces or a lone Citation is no sentence", () => {
    expect(sentences("   ")).toEqual([]);
    expect(sentences(` ${INLINE_NODE} `)).toEqual([]);
  });
});

describe("A sentence that makes a claim", () => {
  test("has three words, or four characters of Chinese", () => {
    expect(isClaim("Online sales grew 12% in the quarter.")).toBe(true);
    expect(isClaim("Next steps")).toBe(false);
    expect(isClaim("Thanks!")).toBe(false);
    expect(isClaim("销售额增长了。")).toBe(true);
    expect(isClaim("谢谢。")).toBe(false);
  });
});
