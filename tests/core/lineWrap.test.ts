import { describe, expect, test } from "vitest";
import {
  isWrappedLine,
  joinCjkLineWraps,
  joinPrintedLines,
  onlyCjkLineWrapChange,
} from "../../src/core/documents/lineWrap";
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

describe("a line the page ended itself", () => {
  const line = (text: string, right: number, size = 11) => ({ text, right, size });

  test("a heading ends short of the line under it, which a wrapped line never does", () => {
    expect(
      isWrappedLine(
        line("北桥社区信托志愿者手册", 193),
        line("志愿者每次值班前都要在前台签到。", 248),
      ),
    ).toBe(false);
  });

  test("a wrapped line's next line stays under where it ended", () => {
    expect(
      isWrappedLine(
        line("志愿者每次值班前都要在前台签到，并由", 270),
        line("值班组长复核当天的记录。", 204),
      ),
    ).toBe(true);
  });

  test("a heading in a size of its own is no wrap, however far it reaches", () => {
    expect(
      isWrappedLine(
        line("北桥社区信托志愿者手册的说明与使用", 400, 16),
        line("志愿者每次值班前都要在前台签到。", 280),
      ),
    ).toBe(false);
  });

  test("beside Hangul, Latin or a number only the size tells, and a wrap may reach farther", () => {
    expect(
      isWrappedLine(
        line("배송비는 증가했습니다. 7", 226),
        line("월부터 물류비가 감소했습니다.", 248),
      ),
    ).toBe(true);
  });

  test("a blank line is no wrap", () => {
    expect(isWrappedLine(line("甲", 80), line("", 0))).toBe(false);
  });

  test("a heading no wider than its sentence, in the same size, cannot be told from a wrap", () => {
    expect(isWrappedLine(line("北桥社区信托志愿者手册", 193), line("请勿吸烟。", 120))).toBe(true);
  });

  test("the page's text names the newline it ended itself, and the wider join keeps that break", () => {
    const { text, kept } = joinPrintedLines([
      line("北桥社区信托志愿者手册", 193),
      line("志愿者每次值班前都要在前台签到，并由", 270),
      line("值班组长复核当天的记录。", 204),
    ]);
    expect(text).toBe(
      "北桥社区信托志愿者手册\n志愿者每次值班前都要在前台签到，并由值班组长复核当天的记录。",
    );
    expect([...kept]).toEqual([11]);
    expect(joinCjkLineWraps(text, kept)).toBe(text);
    expect(joinCjkLineWraps(text)).toBe(
      "北桥社区信托志愿者手册志愿者每次值班前都要在前台签到，并由值班组长复核当天的记录。",
    );
  });

  test("a kept break is one newline, not every line that reads the same", () => {
    const { text, kept } = joinPrintedLines([
      line("7", 92, 20),
      line("月是单位。", 127, 11),
      line("7", 83, 11),
      line("月起收入增长。", 149, 11),
    ]);
    expect(text).toBe("7\n月是单位。\n7\n月起收入增长。");
    expect([...kept]).toEqual([1]);
    expect(joinCjkLineWraps(text, kept)).toBe("7\n月是单位。\n7月起收入增长。");
  });

  test("a repeated line beside a blank line keeps only the break the page chose there", () => {
    const { text, kept } = joinPrintedLines([
      line("7", 92, 20),
      line("", 0),
      line("7", 83, 11),
      line("月", 94, 11),
    ]);
    expect(joinCjkLineWraps(text, kept)).toBe("7\n\n7月");
  });
});
