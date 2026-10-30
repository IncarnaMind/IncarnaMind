import { expect, test } from "vitest";
import type { RegisteredDataFlow, TaggingRoute } from "../../src/core/api";
import {
  type FlowRoute,
  pageImagesSent,
  serviceOf,
} from "../../src/renderer/src/taggingDestination";
import { taggingSends } from "../../src/renderer/src/taggingSends";
import { translate } from "../../src/shared/i18n";

const ANTHROPIC: FlowRoute = {
  where: "cloud",
  service: { id: "https://api.anthropic.com", name: "Anthropic" },
};
const LOCAL: FlowRoute = { where: "local" };
const UNKNOWN: FlowRoute = { where: "unknown" };
const NONE: FlowRoute = { where: "none" };

const say = (
  route: FlowRoute,
  language: "en" | "zh-CN",
  options?: { folders?: boolean; scans?: FlowRoute | null },
) => taggingSends(route, (key, params) => translate(language, key, params), options);

test("a service is named, a model on this computer says so, and nothing is said otherwise", () => {
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
  expect(say(NONE, "zh-CN")).toBeNull();
});

test("Organize adds the Folders it files by, and page images when it reads scans", () => {
  expect(say(ANTHROPIC, "en", { folders: true })).toBe(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to Anthropic.",
  );
  expect(say(ANTHROPIC, "zh-CN", { folders: true })).toBe(
    "文件夹和标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 Anthropic。",
  );
  expect(say(ANTHROPIC, "en", { folders: true, scans: ANTHROPIC })).toBe(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to Anthropic. Page images of scans are included.",
  );
  expect(say(ANTHROPIC, "zh-CN", { folders: true, scans: ANTHROPIC })).toBe(
    "文件夹和标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 Anthropic。包括扫描件的页面图片。",
  );
  expect(say(LOCAL, "en", { folders: true, scans: LOCAL })).toBe(
    "The names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, stay on this computer. Page images of scans are included.",
  );
  expect(say(LOCAL, "zh-CN", { folders: true })).toBe(
    "文件夹和标签的名称和描述，以及每个文档的名称、目录和简短摘录，都留在这台电脑上。",
  );
});

test("a server named by its address is spaced from the Chinese around it", () => {
  const route: TaggingRoute = {
    where: "cloud",
    service: { id: "https://api.deepseek.com", name: "api.deepseek.com" },
  };
  expect(say(route, "zh-CN")).toBe(
    "标签的名称和描述，以及每个文档的名称、目录和简短摘录，都会发送到 api.deepseek.com。",
  );
});

test.each(["en", "zh-CN"] as const)(
  "Organize names the separate scan recipient and its context (%s)",
  (language) => {
    const text: FlowRoute = {
      where: "cloud",
      service: { id: "https://api.openai.com", name: "OpenAI" },
    };
    const expected = {
      en: "For text Documents, the names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to OpenAI. For scans, page images, the Document’s name and type, and the names and descriptions of your Folders and Tags go to Anthropic.",
      "zh-CN":
        "对于有文本的文档，文件夹和标签的名称和描述，以及文档的名称、目录和简短摘录，都会发送到 OpenAI。扫描件的页面图片、文档名称和类型，以及文件夹和标签的名称和描述，都会发送到 Anthropic。",
    };
    expect(
      taggingSends(text, (key, params) => translate(language, key, params), {
        folders: true,
        scans: ANTHROPIC,
      }),
    ).toBe(expected[language]);
  },
);

test.each([
  {
    language: "en" as const,
    text: LOCAL,
    images: ANTHROPIC,
    expected:
      "For text Documents, the names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, stay on this computer. For scans, page images, the Document’s name and type, and the names and descriptions of your Folders and Tags go to Anthropic.",
  },
  {
    language: "zh-CN" as const,
    text: LOCAL,
    images: ANTHROPIC,
    expected:
      "对于有文本的文档，文件夹和标签的名称和描述，以及文档的名称、目录和简短摘录，都留在这台电脑上。扫描件的页面图片、文档名称和类型，以及文件夹和标签的名称和描述，都会发送到 Anthropic。",
  },
  {
    language: "en" as const,
    text: ANTHROPIC,
    images: LOCAL,
    expected:
      "For text Documents, the names and descriptions of your Folders and Tags, and each Document’s name, outline and short excerpts, go to Anthropic. For scans, page images, the Document’s name and type, and the names and descriptions of your Folders and Tags stay on this computer.",
  },
  {
    language: "zh-CN" as const,
    text: ANTHROPIC,
    images: LOCAL,
    expected:
      "对于有文本的文档，文件夹和标签的名称和描述，以及文档的名称、目录和简短摘录，都会发送到 Anthropic。扫描件的页面图片、文档名称和类型，以及文件夹和标签的名称和描述，都留在这台电脑上。",
  },
])("only the local payload stays here ($language)", ({ language, text, images, expected }) => {
  expect(say(text, language, { folders: true, scans: images })).toBe(expected);
});

for (const language of ["en", "zh-CN"] as const) {
  test.each([
    { images: "accepted", context: "accepted", sends: true },
    { images: "accepted", context: "declined", sends: false },
    { images: "declined", context: "accepted", sends: false },
    { images: "not-asked", context: "accepted", sends: false },
  ] as const)(
    `scan disclosure needs both permissions (${language}, $images/$context)`,
    ({ images, context, sends }) => {
      if (ANTHROPIC.where !== "cloud") throw new Error("The reader must be a service.");
      const flows: RegisteredDataFlow[] = (["scan-images", "classification"] as const).map(
        (id) => ({
          id,
          sends: [],
          services: [
            {
              flow: { id, service: ANTHROPIC.service, sends: [] },
              consent: id === "scan-images" ? images : context,
              chosen: false,
              decidedAt: null,
            },
          ],
        }),
      );
      const reader = serviceOf("scan-images", ANTHROPIC, flows);
      expect(reader.allowed).toBe(images === "accepted");
      expect(reader.classificationAllowed).toBe(context === "accepted");
      expect(pageImagesSent(true, reader)).toBe(sends);
      const text: FlowRoute = {
        where: "cloud",
        service: { id: "https://api.openai.com", name: "OpenAI" },
      };
      const said = say(text, language, {
        folders: true,
        scans: pageImagesSent(true, reader) ? reader.route : null,
      });
      expect(said).toContain("OpenAI");
      if (sends) expect(said).toContain("Anthropic");
      else expect(said).not.toContain("Anthropic");
    },
  );

  test(`a local scan reader needs no cloud permissions (${language})`, () => {
    const reader = serviceOf("scan-images", { where: "local" }, [
      {
        id: "scan-images",
        sends: [],
        services: [],
      },
    ]);
    expect(reader.allowed).toBeNull();
    expect(pageImagesSent(true, reader)).toBe(true);
    const said = say(ANTHROPIC, language, { folders: true, scans: reader.route });
    expect(said).toContain("Anthropic");
    expect(said).toContain(
      language === "en"
        ? "For scans, page images, the Document’s name and type, and the names and descriptions of your Folders and Tags stay on this computer."
        : "扫描件的页面图片、文档名称和类型，以及文件夹和标签的名称和描述，都留在这台电脑上。",
    );
  });
}
