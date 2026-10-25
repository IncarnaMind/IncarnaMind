import { expect, test } from "vitest";
import { taggingSends } from "../../src/renderer/src/taggingSends";
import { translate } from "../../src/shared/i18n";

const say = (language: "en" | "zh-CN", service: string | null) =>
  taggingSends(service, (key, params) => translate(language, key, params));

test("a service is named; a model on this computer sends nothing off it", () => {
  expect(say("en", "Anthropic")).toBe(
    "Each Document’s name, outline and short excerpts go to Anthropic.",
  );
  expect(say("zh-CN", "Anthropic")).toBe("每个文档的名称、目录和简短摘录都会发送到 Anthropic。");
  expect(say("en", null)).toBe(
    "Each Document’s name, outline and short excerpts stay on this computer.",
  );
  expect(say("zh-CN", null)).toBe("每个文档的名称、目录和简短摘录都留在这台电脑上。");
});

test("a server named by its address is spaced from the Chinese around it", () => {
  expect(say("zh-CN", "api.deepseek.com")).toBe(
    "每个文档的名称、目录和简短摘录都会发送到 api.deepseek.com。",
  );
});
