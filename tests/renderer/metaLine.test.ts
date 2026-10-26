import { describe, expect, test } from "vitest";
import { dotAfter } from "../../src/renderer/src/components/metaDot";

describe("The dot between a meta line's parts", () => {
  // protects=after Chinese full-width punctuation, a closing bracket included (#1149), the dot sets with no space before it, and after anything else with one each side; fails_when=a line reads "）· " with a space, or English loses its spaces; no_claim=the line's look.
  test.each([
    ["来自 2 个文档（此笔记的范围，共 7 个）", "· "],
    ["我选了“Report 1”作为主要文档。", "· "],
    ["失败了！", "· "],
    ["From 2 of your 7 Documents (this Mind’s scope)", " · "],
    ["请先不要关闭 IncarnaMind", " · "],
  ])("after “%s”: “%s”", (part, dot) => {
    expect(dotAfter(part)).toBe(dot);
  });
});
