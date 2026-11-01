/**
 * The line shown where choosing a model for Tags turns tagging on (#2308, ADR-0022's amendment):
 * it names what goes for each new Document and how much, in Settings › Privacy's own words, to
 * which service, that a Linked folder's new Documents go too, and that those already in the
 * Library don't.
 */
import { describe, expect, test } from "vitest";
import { EXCERPT_TOKENS } from "../../src/core/tags/classify";
import { translate } from "../../src/shared/i18n";

describe("What choosing a model for Tags says it sends", () => {
  test("English", () => {
    const line = translate("en", "setup.sorting.sends", { service: "Anthropic" });
    expect(line).toContain("name and type and an excerpt of its start (about 1,500 tokens)");
    expect(translate("en", "consent.data.document-excerpts")).toContain(
      "name and type and an excerpt of its start (about 1,500 tokens)",
    );
    expect(line).toContain("go to Anthropic");
    expect(line).toContain("new ones in your Linked folders too");
    expect(line).toContain("Documents already in the Library go only when you run Organize");
  });

  test("Simplified Chinese", () => {
    const line = translate("zh-CN", "setup.sorting.sends", { service: "Anthropic" });
    expect(line).toContain("名称、类型和开头的一段摘录（约 1,500 token）");
    expect(translate("zh-CN", "consent.data.document-excerpts")).toContain(
      "名称、类型和开头的一段摘录（约 1,500 token）",
    );
    expect(line).toContain("发送给 Anthropic");
    expect(line).toContain("包括关联文件夹中的新文档");
    expect(line).toContain("资料库中已有的文档，只有在你运行“整理”时才会发送");
  });

  test("once tagging is on, in both languages, without naming a Settings page that isn't one", () => {
    const en = translate("en", "setup.sorting.sendsWhenOn", { service: "Anthropic" });
    expect(en).toContain("name and type and an excerpt of its start (about 1,500 tokens)");
    expect(en).toContain("to Anthropic");
    expect(en).toContain("new ones in your Linked folders too");
    expect(en).toContain("Documents already in the Library go only when you run Organize");
    expect(en).not.toContain("Settings › Tagging");
    const zh = translate("zh-CN", "setup.sorting.sendsWhenOn", { service: "Anthropic" });
    expect(zh).toContain("名称、类型和开头的一段摘录（约 1,500 token）");
    expect(zh).toContain("发送给 Anthropic");
    expect(zh).toContain("包括关联文件夹中的新文档");
    expect(zh).toContain("资料库中已有的文档，只有在你运行“整理”时才会发送");
    expect(zh).not.toContain("设置 → 自动打标签");
  });

  test("the number is the excerpt the tagger sends", () => {
    expect(EXCERPT_TOKENS).toBe(1500);
  });
});
