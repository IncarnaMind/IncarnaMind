import { describe, expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

describe("the line above a summary of the Documents in scope", () => {
  // protects=the capped summary's line and its button, in English and Chinese, as the issue gives them; fails_when=a word or a count changes; no_claim=what the model writes.
  test("the largest few, and the button for the rest, in English and Chinese", () => {
    expect(translate("en", "coverage.largest", { count: 8, total: 14 })).toBe(
      "I’ll summarize the 8 largest of your 14 Documents now.",
    );
    expect(translate("en", "coverage.largest.rest", { count: 6 })).toBe("Summarize the other 6");
    expect(translate("zh-CN", "coverage.largest", { count: 8, total: 14 })).toBe(
      "先总结你 14 个文档中最大的 8 个。",
    );
    expect(translate("zh-CN", "coverage.largest.rest", { count: 6 })).toBe("总结其余 6 个");
  });

  // protects=the two main Documents' line and its button, in English and Chinese; fails_when=a word or a quotation mark changes; no_claim=which Documents a model picks.
  test("the main few, and the button for others, in English and Chinese", () => {
    expect(
      translate("en", "coverage.main", { documents: "“10-K” and “Facility agreement”" }),
    ).toBe("I took “10-K” and “Facility agreement” as the main ones.");
    expect(translate("en", "coverage.main.others")).toBe("Use others");
    expect(translate("zh-CN", "coverage.main", { documents: "“10-K”和“贷款协议”" })).toBe(
      "我选了“10-K”和“贷款协议”作为主要文档。",
    );
    expect(translate("zh-CN", "coverage.main.others")).toBe("换别的");
  });
});
