import { describe, expect, test } from "vitest";
import { gap, translate } from "../../src/shared/i18n";

describe("The gap between two pieces of text on a screen", () => {
  test("is a space in English", () => {
    expect(gap("en", "Audio stays here.", "Learn more")).toBe(" ");
  });

  test("is none in Chinese after or before full-width punctuation, or between Chinese characters", () => {
    expect(gap("zh-CN", "会议中其他人的声音。", "音频只保存在这台 Mac 上")).toBe("");
    expect(gap("zh-CN", "数据使用：", "除非你选择加入")).toBe("");
    expect(gap("zh-CN", "无需密钥。", "了解更多")).toBe("");
    expect(gap("zh-CN", "更多信息见", "了解更多")).toBe("");
    expect(gap("zh-CN", "开始使用", "")).toBe("");
  });

  test("is a space in Chinese between Chinese and Latin letters, numbers or symbols", () => {
    expect(gap("zh-CN", "格式来自项目", "citationstyles.org")).toBe(" ");
    expect(gap("zh-CN", "开始使用", "· 0/5")).toBe(" ");
    expect(gap("zh-CN", "Mac", "上的音频")).toBe(" ");
  });

  test("joins the recording notice as the interface language says", () => {
    const join = (language: "en" | "zh-CN") => {
      const before = translate(language, "meetings.notice.both");
      const after = translate(language, "meetings.audio.kept");
      return `${before}${gap(language, before, after)}${after}`;
    };
    expect(join("zh-CN")).toContain("所有人。音频");
    expect(join("en")).toContain("call. Audio stays");
  });

  test("is none beside a space already there, so a name in a spaced template keeps one space", () => {
    expect(gap("zh-CN", "发送给 ", "OpenAI")).toBe("");
    expect(gap("zh-CN", "OpenAI", " 拒绝了这个密钥。")).toBe("");
  });

  test("puts a provider's name in a Chinese sentence by its script (#890)", () => {
    const title = (provider: string) => translate("zh-CN", "providers.form.title", { provider });
    expect(title("Anthropic")).toBe("粘贴 Anthropic 密钥");
    expect(title("通义千问")).toBe("粘贴通义千问密钥");
    expect(translate("en", "providers.form.title", { provider: "Anthropic" })).toBe(
      "Paste your Anthropic key",
    );
    expect(translate("zh-CN", "providers.form.keyRefusedNow", { provider: "OpenAI" })).toBe(
      "OpenAI 拒绝了这个密钥。",
    );
  });
});

test("a table row's label sits a space from the Chinese around it when it is Latin, and none when it is Chinese", () => {
  expect(translate("zh-CN", "figures.tableRow", { label: "Groceries" })).toBe("表格，Groceries 行");
  expect(translate("zh-CN", "figures.tableRow", { label: "日用食品" })).toBe("表格，日用食品行");
  expect(translate("zh-CN", "figures.tableCell", { label: "Fuel", column: "Q3 2026" })).toBe(
    "表格，Fuel 行，Q3 2026",
  );
});
