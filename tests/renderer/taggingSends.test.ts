import { expect, test } from "vitest";
import type { TaggingDestination } from "../../src/renderer/src/taggingDestination";
import { taggingSends } from "../../src/renderer/src/taggingSends";
import { translate } from "../../src/shared/i18n";

const ANTHROPIC: TaggingDestination = {
  where: "cloud",
  service: { id: "https://api.anthropic.com", name: "Anthropic" },
  allowed: true,
};
const LOCAL: TaggingDestination = { where: "local" };
const UNKNOWN: TaggingDestination = { where: "unknown" };

const say = (
  destination: TaggingDestination,
  language: "en" | "zh-CN",
  options?: { folders?: boolean; scans?: boolean },
) => taggingSends(destination, (key, params) => translate(language, key, params), options);

test("a service is named, a model on this computer says so, and nothing is said before the flows are read", () => {
  expect(say(ANTHROPIC, "en")).toBe(
    "The names and descriptions of your Tags, and each Document’s name, outline and short excerpts, go to Anthropic.",
  );
  expect(say(ANTHROPIC, "zh-CN")).toBe(
    "标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 Anthropic。",
  );
  expect(say(LOCAL, "en")).toBe(
    "The names and descriptions of your Tags, and each Document’s name, outline and short excerpts, stay on this computer.",
  );
  expect(say(LOCAL, "zh-CN")).toBe(
    "标签的名称和描述，以及每个文档的名称、目录和简短摘录，都留在这台电脑上。",
  );
  expect(say(UNKNOWN, "en")).toBeNull();
  expect(say(UNKNOWN, "zh-CN")).toBeNull();
});

test("Organize adds the Folders it files by, and page images when it reads scans", () => {
  expect(say(ANTHROPIC, "en", { folders: true })).toBe(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to Anthropic.",
  );
  expect(say(ANTHROPIC, "zh-CN", { folders: true })).toBe(
    "文件夹和标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 Anthropic。",
  );
  expect(say(ANTHROPIC, "en", { folders: true, scans: true })).toBe(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to Anthropic. Page images of scans are included.",
  );
  expect(say(ANTHROPIC, "zh-CN", { folders: true, scans: true })).toBe(
    "文件夹和标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 Anthropic。包括扫描件的页面图片。",
  );
  expect(say(LOCAL, "en", { folders: true, scans: true })).toBe(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, stay on this computer. Page images of scans are included.",
  );
  expect(say(LOCAL, "zh-CN", { folders: true })).toBe(
    "文件夹和标签的名称和描述，以及每个文档的名称、目录和简短摘录，都留在这台电脑上。",
  );
});

test("a server named by its address is spaced from the Chinese around it", () => {
  expect(
    say(
      {
        where: "cloud",
        service: { id: "https://api.deepseek.com", name: "api.deepseek.com" },
        allowed: true,
      },
      "zh-CN",
    ),
  ).toBe("标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 api.deepseek.com。");
});
