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

  test("a name is cut as every name is: one line, about sixty characters, no closing mark before its ellipsis", () => {
    const long =
      "How much cooler are large irrigated parks than the surrounding built-up streets during clear windless summer nights?";
    const name = nameFromAnswer([paragraph(SENTENCE)], `\n${long}\nsecond line`);
    expect(name.endsWith("…")).toBe(true);
    const kept = name.slice(0, -1);
    expect(kept.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(kept)).toBe(true);
    expect(kept).not.toMatch(/[\s?]$/);
  });

  test("a Question cut short says so, in English and Chinese, and one that fits does not (#3487)", () => {
    expect(
      nameFromAnswer(
        [paragraph(SENTENCE)],
        "What does the contract with Harlow Freight say about termination?",
      ),
    ).toBe("What does the contract with Harlow Freight say about…");
    const chinese =
      "和 Harlow Freight 签的这份供货合同里，关于合同终止、提前通知的期限、重大违约后的补救期以及双方各自的责任上限，条款分别是怎么规定的？";
    const named = nameFromAnswer([paragraph("数字以人民币百万元为单位。")], chinese);
    expect(named.endsWith("…")).toBe(true);
    expect(chinese.startsWith(named.slice(0, -1))).toBe(true);
    expect(Array.from(named).length).toBeLessThanOrEqual(61);
    expect(nameFromAnswer([paragraph(SENTENCE)], "How long is the notice period?")).toBe(
      "How long is the notice period",
    );
  });

  test("a heading is the Note's own first line, so its cut carries no ellipsis", () => {
    const long =
      "Termination, notice periods and the remedy period for a material breach by either party";
    const name = nameFromAnswer([heading(long)], QUESTION);
    expect(name.endsWith("…")).toBe(false);
    expect(long.startsWith(name)).toBe(true);
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
