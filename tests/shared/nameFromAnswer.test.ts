import { describe, expect, test } from "vitest";
import type { NodeJSON } from "../../src/shared/blockJson";
import { nameFromAnswer } from "../../src/shared/noteBlocks";

const text = (value: string): NodeJSON => ({ type: "text", text: value });
const paragraph = (value: string): NodeJSON => ({ type: "paragraph", content: [text(value)] });
const heading = (value: string, level = 2): NodeJSON => ({
  type: "heading",
  attrs: { level },
  content: [text(value)],
});
const table = (first: string): NodeJSON => ({
  type: "table",
  content: [
    {
      type: "tableRow",
      content: [{ type: "tableHeader", content: [paragraph(first)] }],
    },
  ],
});

const QUESTION = "What are the revenue and adjusted EBITDA?";
const SENTENCE = "Figures are in GBP million, as the Harbourline documents state them.";

describe("what a Note made from an Answer is called (#2870)", () => {
  test("an Answer with no heading is named from its Question, not a sentence from its middle", () => {
    expect(nameFromAnswer([paragraph(SENTENCE), paragraph("Revenue was 668.3.")], QUESTION)).toBe(
      "What are the revenue and adjusted EBITDA",
    );
  });

  test("a table's first cell is no name either", () => {
    expect(nameFromAnswer([table("Metric")], QUESTION)).toBe(
      "What are the revenue and adjusted EBITDA",
    );
  });

  test("an Answer's first heading comes before its Question, wherever the heading falls", () => {
    expect(
      nameFromAnswer(
        [paragraph(SENTENCE), heading("Harbourline key figures"), heading("Risks")],
        QUESTION,
      ),
    ).toBe("Harbourline key figures");
    expect(nameFromAnswer([heading("Summary", 1), paragraph("The parties agree.")], QUESTION)).toBe(
      "Summary",
    );
  });

  test("a heading with no words is passed over", () => {
    expect(nameFromAnswer([heading("  "), heading("Key figures")], QUESTION)).toBe("Key figures");
    expect(nameFromAnswer([heading(" "), paragraph(SENTENCE)], QUESTION)).toBe(
      "What are the revenue and adjusted EBITDA",
    );
  });

  test("a name is cut as every name is: one line, about sixty characters, no closing mark", () => {
    const long =
      "How much cooler are large irrigated parks than the surrounding built-up streets during clear windless summer nights?";
    const name = nameFromAnswer([paragraph(SENTENCE)], `\n${long}\nsecond line`);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(name)).toBe(true);
    expect(name).not.toMatch(/[\s?]$/);
  });

  test("Chinese is named the same way", () => {
    expect(
      nameFromAnswer([paragraph("数字以人民币百万元为单位。")], "收入和调整后 EBITDA 是多少？"),
    ).toBe("收入和调整后 EBITDA 是多少");
    expect(
      nameFromAnswer(
        [paragraph("数字以人民币百万元为单位。"), heading("华岭食品的主要数字")],
        "收入是多少？",
      ),
    ).toBe("华岭食品的主要数字");
  });

  test("with no heading and no Question, the Answer's own first line is the last resort", () => {
    expect(nameFromAnswer([paragraph("Revenue was 668.3.")], "")).toBe("Revenue was 668.3");
    expect(nameFromAnswer([], "")).toBe("");
  });
});
