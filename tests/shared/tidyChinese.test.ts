import { describe, expect, test } from "vitest";
import { tidyChinese } from "../../src/shared/tidyChinese";

describe("tidyChinese", () => {
  test("puts one space between Chinese and Latin letters or digits", () => {
    expect(tidyChinese("导出为Word文件")).toBe("导出为 Word 文件");
    expect(tidyChinese("第3页，共12页")).toBe("第 3 页，共 12 页");
    expect(tidyChinese("约135MB")).toBe("约 135MB");
    expect(tidyChinese("用Mind记录潮汐")).toBe("用 Mind 记录潮汐");
  });

  test("keeps a number's marks and an address as they are", () => {
    expect(tidyChinese("1,000个")).toBe("1,000 个");
    expect(tidyChinese("3.14是圆周率")).toBe("3.14 是圆周率");
    expect(tidyChinese("15:20开会")).toBe("15:20 开会");
    expect(tidyChinese("https://example.com/a?b=1打开")).toBe("https://example.com/a?b=1 打开");
  });

  test("full-width punctuation in Chinese sentences, and never inside English or numbers", () => {
    expect(tidyChinese("你好,世界")).toBe("你好，世界");
    expect(tidyChinese("注意:这里;那里?真的!")).toBe("注意：这里；那里？真的！");
    expect(tidyChinese("Hello, world. Really?")).toBe("Hello, world. Really?");
    expect(tidyChinese("第一.第二")).toBe("第一。第二");
  });

  test("parentheses are full-width in a Chinese paragraph, even around Latin text", () => {
    expect(tidyChinese("导出为Word(.docx)文件")).toBe("导出为 Word（.docx）文件");
    expect(tidyChinese("导出 Word(.docx)")).toBe("导出 Word（.docx）");
    expect(tidyChinese("An English (aside) stays")).toBe("An English (aside) stays");
  });

  test("Chinese quotation marks, with no space beside them", () => {
    expect(tidyChinese('他说"你好"，然后走了')).toBe("他说“你好”，然后走了");
    expect(tidyChinese("“ Lease ”的文件")).toBe("“Lease”的文件");
    expect(tidyChinese("「潮汐」与『月相』")).toBe("“潮汐”与‘月相’");
    expect(tidyChinese("don't change English 'quotes'")).toBe("don't change English 'quotes'");
  });

  test("no space next to full-width punctuation", () => {
    expect(tidyChinese("保存 。然后离开")).toBe("保存。然后离开");
    expect(tidyChinese("保存。 然后离开")).toBe("保存。然后离开");
    expect(tidyChinese("前（ 后 ）")).toBe("前（后）");
  });

  test("the characters just outside a run decide its edges", () => {
    expect(tidyChinese("潮汐", { before: "e" })).toBe(" 潮汐");
    expect(tidyChinese("tide", { before: "潮" })).toBe(" tide");
    expect(tidyChinese("潮汐", { after: "2" })).toBe("潮汐 ");
    expect(tidyChinese("。", { before: "汐" })).toBe("。");
    expect(tidyChinese(".", { before: "汐" })).toBe("。");
    expect(tidyChinese(" ", { before: "。", after: "潮" })).toBe("");
  });

  test("an empty string stays empty", () => {
    expect(tidyChinese("")).toBe("");
  });
});
