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
    ["。\n7", "。7"],
    ["7\n。", "7。"],
    ["か\n7", "か7"],
    ["한\n7", "한 7"],
    ["7\n한", "7 한"],
  ])("joins when either side is CJK or full-width punctuation: %s", (before, after) => {
    expect(joinCjkLineWraps(before)).toBe(after);
  });

  test.each([
    ["한\n한", "한한"],
    ["한\n。", "한。"],
    ["。\n한", "。한"],
  ])("keeps the old no-space join between two CJK neighbours: %s", (before, after) => {
    expect(joinCjkLineWraps(before)).toBe(after);
  });

  test("keeps one space beside Hangul so normalized text does not change", () => {
    for (const [before, after] of [
      ["월\n7", "월 7"],
      ["7\n월", "7 월"],
      ["배송비는 증가했습니다. 7\n월부터", "배송비는 증가했습니다. 7 월부터"],
    ] as const) {
      expect(joinCjkLineWraps(before)).toBe(after);
      expect(normaliseText(before)).toBe(normaliseText(after));
    }
  });

  test("keeps a break between two Latin words", () => {
    expect(joinCjkLineWraps("delivery\ncosts")).toBe("delivery\ncosts");
    expect(joinCjkLineWraps("37.5% a year\nearlier")).toBe("37.5% a year\nearlier");
  });

  test("recognises only the new join rule, not another text change", () => {
    expect(onlyCjkLineWrapChange("配送成本上升，7\n月起免运费", "配送成本上升，7月起免运费")).toBe(
      true,
    );
    expect(onlyCjkLineWrapChange("配送成本上升，7\n月起免运费", "配送成本上升，8月起免运费")).toBe(
      false,
    );
    expect(onlyCjkLineWrapChange("배송비는\n증가했습니다", "배송비는증가했습니다")).toBe(true);
    expect(onlyCjkLineWrapChange("delivery\ncosts", "delivery costs")).toBe(false);
  });
});
