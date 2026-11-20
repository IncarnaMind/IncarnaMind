import { describe, expect, test } from "vitest";
import { shownPair } from "../../src/renderer/src/editor/formulaShown";

describe("A formula's saved result beside the one worked out again (#3493)", () => {
  // protects=a ratio's saved result and the one worked out again show to the fewest decimals that still tell them apart, grouped as the interface language groups numbers; fails_when=twelve digits of a ratio show, or the two read the same though they differ
  test("show as few decimals as still tell them apart", () => {
    expect(shownPair("0.06896551724137938", "-0.08823529411764701", "en")).toEqual({
      saved: "0.07",
      worked: "-0.09",
    });
    expect(shownPair("0.069", "0.06896551724137938", "en")).toEqual({
      saved: "0.069",
      worked: "0.068966",
    });
    expect(shownPair("23800", "22800", "en")).toEqual({ saved: "23,800", worked: "22,800" });
    expect(shownPair("0.8", "-1.1999999999999993", "zh-CN")).toEqual({
      saved: "0.8",
      worked: "-1.2",
    });
  });

  // protects=a result that isn't a number shows as the workbook saved it
  test("leave what isn't a number as it is", () => {
    expect(shownPair("#DIV/0!", "0", "en")).toEqual({ saved: "#DIV/0!", worked: "0" });
  });
});
