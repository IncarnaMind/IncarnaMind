import { describe, expect, test } from "vitest";
import { joinCjkLineWraps, onlyCjkLineWrapChange } from "../../src/core/documents/lineWrap";
import { normaliseText } from "../../src/shared/text";

describe("CJK PDF line wraps", () => {
  test("joins the film's digit-to-Han break without a space", () => {
    expect(joinCjkLineWraps("配送成本上升，7\n月起免运费门槛又下调至 40 英镑")).toBe(
      "配送成本上升，7月起免运费门槛又下调至 40 英镑",
    );
  });

  test.each([
    ["7\n月", "7月"],
    ["月\n7", "月7"],
    ["cost\n月", "cost月"],
    ["月\ncost", "月cost"],
    ["，\n7", "，7"],
    ["37.5%\n降至", "37.5%降至"],
    ["か\n7", "か7"],
    ["7\n한", "7 한"],
    ["한\n7", "한 7"],
    ["한\n中", "한中"],
    ["월\n부터", "월부터"],
  ])("joins a wrapped line beside Chinese, Japanese or Korean text: %s", (before, after) => {
    expect(joinCjkLineWraps(before)).toBe(after);
  });

  test("keeps one space beside Hangul where the old text had a space or a break", () => {
    for (const [before, after] of [
      ["7\n월", "7 월"],
      ["월\n7", "월 7"],
      ["배송비는 증가했습니다. 7\n월부터", "배송비는 증가했습니다. 7 월부터"],
    ] as const) {
      expect(joinCjkLineWraps(before)).toBe(after);
      expect(normaliseText(before)).toBe(normaliseText(after));
    }
  });

  test("keeps a break after a sentence or a list item ends", () => {
    for (const text of [
      "第一段结束了。\n第二段开始。",
      "问题？\n回答。",
      "如下：\n1. 第一项",
      "完了！\n下一句",
      "他说：“好。”\n下一段开始。",
      "（见附注）\n下一段开始。",
    ])
      expect(joinCjkLineWraps(text)).toBe(text);
  });

  test("keeps a break between two Latin words, and a blank line", () => {
    expect(joinCjkLineWraps("delivery\ncosts")).toBe("delivery\ncosts");
    expect(joinCjkLineWraps("37.5% a year\nearlier")).toBe("37.5% a year\nearlier");
    expect(joinCjkLineWraps("第一段。\n\n第二段。")).toBe("第一段。\n\n第二段。");
  });

  test.each(["甲\n\n乙", "Latin\n\n月", "甲\n \n乙"])("keeps a blank line's break: %s", (text) =>
    expect(joinCjkLineWraps(text)).toBe(text),
  );

  test("joins beyond the basic plane, and before a closing mark", () => {
    expect(joinCjkLineWraps("𠀀\n月")).toBe("𠀀月");
    expect(joinCjkLineWraps("7\n。")).toBe("7。");
    expect(joinCjkLineWraps("한\n。")).toBe("한。");
  });

  test("recognises only the new join rule, not another text change", () => {
    expect(onlyCjkLineWrapChange("配送成本上升，7\n月起免运费", "配送成本上升，7月起免运费")).toBe(
      true,
    );
    expect(onlyCjkLineWrapChange("配送成本上升，7\n月起免运费", "配送成本上升，8月起免运费")).toBe(
      false,
    );
    expect(onlyCjkLineWrapChange("delivery\ncosts", "delivery costs")).toBe(false);
    expect(onlyCjkLineWrapChange("배송비 7\n월부터", "배송비 7 월부터")).toBe(true);
    expect(onlyCjkLineWrapChange("배송비는\n증가했습니다", "배송비는증가했습니다")).toBe(true);
    expect(onlyCjkLineWrapChange("월부터", "월 부터")).toBe(false);
  });
});
