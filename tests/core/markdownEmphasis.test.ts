import { describe, expect, test } from "vitest";
import type { NodeJSON } from "../../src/core/answers/blocks";
import { emphasisOf, markdownToBlocks } from "../../src/core/answers/markdown";

interface Run {
  text: string;
  marks: string[];
}

/** Every text node under `nodes`, in order, with the names of its marks. */
const textRuns = (nodes: readonly NodeJSON[]): Run[] =>
  nodes.flatMap((node) =>
    node.type === "text"
      ? [{ text: node.text ?? "", marks: (node.marks ?? []).map((mark) => mark.type) }]
      : textRuns(node.content ?? []),
  );

const runs = (markdown: string, streaming = false): Run[] =>
  textRuns(markdownToBlocks(markdown, { streaming }));

const plain = (text: string): Run => ({ text, marks: [] });
const bold = (text: string): Run => ({ text, marks: ["bold"] });
const italic = (text: string): Run => ({ text, marks: ["italic"] });
const code = (text: string): Run => ({ text, marks: ["code"] });

describe("emphasis beside Chinese punctuation", () => {
  test("bold that ends with full-width punctuation and is followed by Chinese", () => {
    expect(runs("**仍未确定：**下一步")).toEqual([bold("仍未确定："), plain("下一步")]);
  });

  test("bold followed by full-width punctuation", () => {
    expect(runs("结论是**三十天**。")).toEqual([plain("结论是"), bold("三十天"), plain("。")]);
    expect(runs("**注意**：详见下文")).toEqual([bold("注意"), plain("：详见下文")]);
  });

  test("the same bold after Chinese text", () => {
    expect(runs("下一步**仍未确定：**")).toEqual([plain("下一步"), bold("仍未确定：")]);
    expect(runs("下一步**仍未确定：**，然后")).toEqual([
      plain("下一步"),
      bold("仍未确定："),
      plain("，然后"),
    ]);
  });

  test("bold that starts with punctuation, after Chinese text", () => {
    expect(runs("价格**（含税）**为100")).toEqual([
      plain("价格"),
      bold("（含税）"),
      plain("为100"),
    ]);
    expect(runs("他说**“重点”**。")).toEqual([plain("他说"), bold("“重点”"), plain("。")]);
  });

  test("bold that ends with punctuation, before Chinese text", () => {
    expect(runs("**“重点”**才是答案")).toEqual([bold("“重点”"), plain("才是答案")]);
    expect(runs("他说：**重点（括号）**然后")).toEqual([
      plain("他说："),
      bold("重点（括号）"),
      plain("然后"),
    ]);
  });

  test("italic and strikethrough", () => {
    expect(runs("*斜体：*下一步")).toEqual([italic("斜体："), plain("下一步")]);
    expect(runs("这是*斜体：*下一步")).toEqual([plain("这是"), italic("斜体："), plain("下一步")]);
    expect(runs("~~作废：~~下一步")).toEqual([
      { text: "作废：", marks: ["strike"] },
      plain("下一步"),
    ]);
  });

  test("Japanese and Korean text the same way", () => {
    expect(runs("**注意：**次へ")).toEqual([bold("注意："), plain("次へ")]);
    expect(runs("**주의:**다음")).toEqual([bold("주의:"), plain("다음")]);
  });

  test("in a heading, a list item and a table cell", () => {
    expect(runs("## **结论：**如下")).toEqual([bold("结论："), plain("如下")]);
    expect(runs("- **仍未确定：**下一步")).toEqual([bold("仍未确定："), plain("下一步")]);
    expect(runs("| 项目 |\n| --- |\n| **仍未确定：**下一步 |")).toEqual([
      plain("项目"),
      bold("仍未确定："),
      plain("下一步"),
    ]);
  });

  test("inline code is left as it is", () => {
    expect(runs("`**x：**`下一步")).toEqual([code("**x：**"), plain("下一步")]);
    expect(runs("**写成 `**x：**`**，然后")).toEqual([
      bold("写成 "),
      code("**x：**"),
      plain("，然后"),
    ]);
  });

  test("while the Answer streams", () => {
    expect(runs("**仍未确定：**下一", true)).toEqual([bold("仍未确定："), plain("下一")]);
    expect(runs("**仍未确定：**", true)).toEqual([bold("仍未确定：")]);
  });
});

describe("emphasis in English", () => {
  test("bold and italic", () => {
    expect(runs("Some **bold** and *italic* text.")).toEqual([
      plain("Some "),
      bold("bold"),
      plain(" and "),
      italic("italic"),
      plain(" text."),
    ]);
  });

  test("punctuation inside the delimiters still needs a space or punctuation beyond them", () => {
    expect(runs("**Note:**text")).toEqual([plain("**Note:**text")]);
    expect(runs("**Note:** text")).toEqual([bold("Note:"), plain(" text")]);
    expect(runs("a**(b)**c")).toEqual([plain("a**(b)**c")]);
    expect(runs("Note**:**text")).toEqual([plain("Note**:**text")]);
  });

  test("an underscore inside a word is not emphasis", () => {
    expect(runs("Use snake_case_name here")).toEqual([plain("Use snake_case_name here")]);
    expect(runs("Use __init__ here")).toEqual([plain("Use "), bold("init"), plain(" here")]);
  });

  test("a star between spaces is not emphasis", () => {
    expect(runs("2 * 3 * 4")).toEqual([plain("2 * 3 * 4")]);
  });

  test("inline code is left as it is", () => {
    expect(runs("`**x:**`text")).toEqual([code("**x:**"), plain("text")]);
  });
});

describe("the strings of #1774", () => {
  test.each([
    ["**上限：**每月五千元", [bold("上限："), plain("每月五千元")]],
    ["**上限**：每月五千元", [bold("上限"), plain("：每月五千元")]],
    ["每月五千元**（含税）**", [plain("每月五千元"), bold("（含税）")]],
    ["**上限，**五千元", [bold("上限，"), plain("五千元")]],
    ["**上限。**五千元", [bold("上限。"), plain("五千元")]],
    ["**上限**，五千元", [bold("上限"), plain("，五千元")]],
    ["**上限**。五千元", [bold("上限"), plain("。五千元")]],
  ])("%s", (markdown, expected) => {
    expect(runs(markdown)).toEqual(expected);
  });
});

describe("emphasis beside full-width punctuation with a number or a Latin word beyond it", () => {
  test.each([
    ["**上限：**5000 元", [bold("上限："), plain("5000 元")]],
    ["**金额（万元）：**1,200", [bold("金额（万元）："), plain("1,200")]],
    ["每月5000**（含税）**", [plain("每月5000"), bold("（含税）")]],
    ["**期限：**2026 年 3 月", [bold("期限："), plain("2026 年 3 月")]],
    ["**上限：**USD 5,000", [bold("上限："), plain("USD 5,000")]],
    ["**风险：**Brexit 影响", [bold("风险："), plain("Brexit 影响")]],
    ["每月5000**（含税）**。", [plain("每月5000"), bold("（含税）"), plain("。")]],
    ["见**《合同法》**5条", [plain("见"), bold("《合同法》"), plain("5条")]],
    ["**Total：**5,000 元", [bold("Total："), plain("5,000 元")]],
  ])("%s", (markdown, expected) => {
    expect(runs(markdown)).toEqual(expected);
  });

  test("the rewrite reader reads the same words with the same looks", () => {
    const read = emphasisOf("**上限：**5000 元");
    expect(read?.plain).toBe("上限：5000 元");
    expect(read?.looks.slice(0, 3)).toEqual([{ bold: true }, { bold: true }, { bold: true }]);
    expect(read?.looks[3]).toEqual({});
  });

  test("stars that are not emphasis stay as written", () => {
    expect(runs("2**10")).toEqual([plain("2**10")]);
    expect(runs("5 * 3 * 2")).toEqual([plain("5 * 3 * 2")]);
    expect(runs("*.txt")).toEqual([plain("*.txt")]);
    expect(runs("* item")).toEqual([plain("item")]);
    expect(runs("3*（2+1）*4")).toEqual([plain("3*（2+1）*4")]);
    expect(runs("a*（b）*c")).toEqual([plain("a*（b）*c")]);
    expect(runs("x*「y」*z")).toEqual([plain("x*「y」*z")]);
    expect(runs("`**上限：**5000 元`")).toEqual([code("**上限：**5000 元")]);
  });
});

describe("underscore emphasis beside full-width punctuation", () => {
  test.each([
    ["（_强调_）", [plain("（"), italic("强调"), plain("）")]],
    ["「_x_」", [plain("「"), italic("x"), plain("」")]],
    ["注意：__重要__。", [plain("注意："), bold("重要"), plain("。")]],
    ["（__重要__）", [plain("（"), bold("重要"), plain("）")]],
  ])("%s", (markdown, expected) => {
    expect(runs(markdown)).toEqual(expected);
  });

  test("underscores inside words stay as written", () => {
    expect(runs("snake_case_name")).toEqual([plain("snake_case_name")]);
    expect(runs("a_b_c")).toEqual([plain("a_b_c")]);
  });
});

describe("emphasisOf", () => {
  test("gives the plain words and the look of each character", () => {
    const read = emphasisOf("**Role.** The *post* is senior");
    expect(read?.plain).toBe("Role. The post is senior");
    expect(read?.looks[0]).toEqual({ bold: true });
    expect(read?.looks[6]).toEqual({});
    expect(read?.looks[11]).toEqual({ italic: true });
  });

  test("keeps stars that pair with nothing and formulas as written", () => {
    expect(emphasisOf("2 * 3 and $x^2$")?.plain).toBe("2 * 3 and $x^2$");
  });

  test("reads an escaped star, underscore, tilde or backslash as itself, beside real emphasis", () => {
    expect(emphasisOf("price\\*volume\\*margin")).toEqual({
      plain: "price*volume*margin",
      looks: Array.from({ length: 19 }, () => ({})),
    });
    expect(emphasisOf("a\\_b\\_c \\~\\~ \\\\ **d**")?.plain).toBe("a_b_c ~~ \\ d");
    expect(emphasisOf("第3\\*4项 **总额**")?.plain).toBe("第3*4项 总额");
  });

  test("leaves a line with code or a link as it was written", () => {
    expect(emphasisOf("`**x**` here")).toBeNull();
    expect(emphasisOf("[a](https://example.com) **b**")).toBeNull();
  });
});
