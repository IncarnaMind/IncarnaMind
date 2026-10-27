import { describe, expect, test } from "vitest";
import { addFilesLabelByPlatform } from "../../src/shared/addFilesAction";
import { translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/*
 * The plain words of #763: the sidebar's statuses, the empty states and the
 * quick fixes, in English and Simplified Chinese. A word from the issue's
 * glossary left column on these screens is a failure.
 */

const said = {
  en: (key: keyof typeof en, params?: Record<string, string | number>) =>
    translate("en", key, params),
  zh: (key: keyof typeof zhCN, params?: Record<string, string | number>) =>
    translate("zh-CN", key, params),
};

describe("the sidebar's statuses speak plainly (#763, item 25)", () => {
  test("reranking is Getting search ready, never a word from the model's trade", () => {
    expect(said.en("status.rerankDownloading")).toBe("Getting search ready");
    expect(said.zh("status.rerankDownloading")).toBe("正在准备搜索");
    expect(said.en("status.rerankDownloading.full", { downloaded: 3, total: 120 })).toContain(
      "Getting search ready: 3 of 120 MB",
    );
    expect(said.zh("status.rerankDownloading.full", { downloaded: 3, total: 120 })).toContain(
      "正在准备搜索：3 / 120 MB",
    );
  });

  test("reading a folder counts as the tie-out counts, so it fits the one status line", () => {
    expect(said.en("linkedFolders.state.indexing", { indexed: 3, files: 120 })).toBe(
      "Reading 3 of 120",
    );
    expect(said.zh("linkedFolders.state.indexing", { indexed: "3", files: "120" })).toBe(
      "正在读取 3/120 个文件",
    );
    expect(said.zh("linkedFolders.state.indexing", { indexed: "120", files: "3,214" })).toBe(
      "正在读取 120/3,214 个文件",
    );
  });

  test("Tags say they need a model, and the whole sentence waits in the tooltip", () => {
    expect(said.en("status.taggingWaiting")).toBe("Tags need an AI model");
    expect(said.zh("status.taggingWaiting")).toBe("打标签需要 AI 模型");
    expect(said.en("jev.waiting.notice")).toBe("Tags come once you choose an AI model.");
    expect(said.zh("jev.waiting.notice")).toBe("选择 AI 模型后会自动打标签。");
    expect(said.en("status.choose")).toBe("Choose…");
    expect(said.zh("status.choose")).toBe("选择…");
  });
});

describe("the empty states say what to do next, with the button that does it (#763, item 26)", () => {
  test("the Library and the sidebar say No Documents yet, then the next step", () => {
    expect(said.en("library.none")).toBe("No Documents yet");
    expect(said.zh("library.none")).toBe("还没有文档");
    expect(said.en("library.none.hint")).toBe("Add files or a folder.");
    expect(said.zh("library.none.hint")).toBe("添加文件或文件夹。");
    expect(said.en("startGuide.documents.linkFolder")).toBe("Link a folder…");
    expect(said.zh("startGuide.documents.linkFolder")).toBe("添加关联文件夹…");
  });

  test("the add action is the platform's one way in, never a bare Add files…", () => {
    for (const language of ["en", "zh-CN"] as const) {
      expect(translate(language, addFilesLabelByPlatform(true))).toBe(
        language === "en" ? "Add files or a folder…" : "添加文件或文件夹…",
      );
      expect(translate(language, addFilesLabelByPlatform(false))).toBe(
        language === "en" ? "Add files…" : "添加文件…",
      );
    }
  });

  test("an empty sheet says so and offers its file's own app", () => {
    expect(said.en("viewer.sheet.empty")).toBe("This sheet is empty.");
    expect(said.zh("viewer.sheet.empty")).toBe("这个工作表是空的。");
    expect(said.en("documents.copy.open")).toBe("Open in default app");
    expect(said.zh("documents.copy.open")).toBe("用默认应用打开");
  });
});

describe("the quick fixes keep one plain name for each thing (#763, item 27)", () => {
  test("Stop allowing is not Undo's word", () => {
    expect(said.en("consent.settings.revoke")).toBe("Stop allowing");
    expect(said.zh("consent.settings.revoke")).toBe("停止允许");
    expect(said.zh("privacy.flows.stopFlow", { flow: "打标签" })).toBe("停止允许“打标签”");
  });

  test("Keep everything on this computer is the one name, in both languages", () => {
    expect(said.en("embeddingProviders.localOnly.label")).toBe("Keep everything on this computer");
    expect(said.zh("embeddingProviders.localOnly.label")).toBe("所有内容都留在这台电脑上");
    expect(said.en("localMode.turnOff")).toBe("Allow cloud models");
    expect(said.zh("localMode.turnOff")).toBe("允许使用云端模型");
    // No string says the old names.
    expect(Object.values(en).filter((value) => /\blocal mode\b/i.test(value))).toEqual([]);
    expect(Object.values(zhCN).filter((value) => value.includes("本地模式"))).toEqual([]);
  });

  test("a verified document's Mind says it is checking, so it isn't mistaken for the document", () => {
    expect(said.en("verify.mindTitle", { name: "Lease" })).toBe("Checking: Lease");
    expect(said.zh("verify.mindTitle", { name: "租约" })).toBe("核对：租约");
  });
});

/**
 * A Passage is not something the User owns or manages on screen, so it reads
 * as an ordinary word, while Note, Document, Folder and Tag stay capitalised.
 * Only a word inside a sentence is tested: a sentence's first word is
 * capitalised by English, not because it names something the User has.
 */
const sentenceMedialPassage = (value: string): boolean =>
  [...value.matchAll(/\bPassages?\b/g)].some((match) => {
    const before = value.slice(0, match.index ?? 0).trimEnd();
    return before !== "" && !/[.!?:]$/.test(before);
  });

test("passages are lowercase inside sentences", () => {
  const offenders = Object.entries(en).filter(([, value]) => sentenceMedialPassage(value));
  expect(offenders).toEqual([]);
});
