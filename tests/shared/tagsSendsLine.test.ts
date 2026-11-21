import { describe, expect, test } from "vitest";
import { approximateTokens } from "../../src/core/documents/passages";
import { EXCERPT_TOKENS } from "../../src/core/tags/classify";
import { translate } from "../../src/shared/i18n";

describe("What the sorting switch says before tagging sends a Document", () => {
  const required = {
    en: [
      "Suggestions for you to review",
      "Linked folders",
      "Anthropic receives the name, file type, page count",
      "opening text",
      "6,000 English characters",
      "1,500 Chinese characters",
      "slide titles or sheet names",
      "Document kinds",
      "names and descriptions of your Tags and Folders",
      "interface language",
      "existing Documents",
    ],
    "zh-CN": [
      "建议，由你确认",
      "关联文件夹",
      "Anthropic 会收到文档名称、文件类型、页数",
      "开头的一段文字",
      "1,500 个汉字",
      "6,000 个英文字符",
      "幻灯片标题",
      "工作表名称",
      "文档类别",
      "标签和文件夹的名称及描述",
      "界面语言",
      "已有文档",
    ],
  };
  test.each(["en", "zh-CN"] as const)(
    "names what goes, where it goes and what the User confirms (%s)",
    (language) => {
      const line = translate(language, "setup.sorting.sendsWhenOn", { service: "Anthropic" });
      for (const detail of required[language]) expect(line).toContain(detail);
    },
  );
  test("the displayed excerpt limits match the tagger's text budget", () => {
    expect(approximateTokens("a".repeat(6000))).toBe(EXCERPT_TOKENS);
    expect(approximateTokens("中".repeat(1500))).toBe(EXCERPT_TOKENS);
  });
});
