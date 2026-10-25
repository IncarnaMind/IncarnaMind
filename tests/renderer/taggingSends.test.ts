import { expect, test } from "vitest";
import { taggingSends } from "../../src/renderer/src/taggingSends";
import { translate } from "../../src/shared/i18n";

const say = (language: "en" | "zh-CN", service: string | null, scans = false) =>
  taggingSends(service, (key, params) => translate(language, key, params), scans);

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

test("scans add their page images, joined by each language, with no space after a full stop", () => {
  expect(say("en", "Anthropic", true)).toBe(
    "Each Document’s name, outline and short excerpts go to Anthropic. Page images of scans are included.",
  );
  expect(say("zh-CN", "Anthropic", true)).toBe(
    "每个文档的名称、目录和简短摘录都会发送到 Anthropic。包括扫描件的页面图片。",
  );
  expect(say("en", null, true)).toBe(
    "Each Document’s name, outline and short excerpts stay on this computer. Page images of scans are included.",
  );
  expect(say("zh-CN", null, true)).toBe(
    "每个文档的名称、目录和简短摘录都留在这台电脑上。包括扫描件的页面图片。",
  );
});

test("a server named by its address is spaced from the Chinese around it", () => {
  expect(say("zh-CN", "api.deepseek.com")).toBe(
    "每个文档的名称、目录和简短摘录都会发送到 api.deepseek.com。",
  );
});
