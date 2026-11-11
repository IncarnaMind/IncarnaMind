import { describe, expect, test } from "vitest";
import type { DataKind } from "../../src/core/api";
import { CHOSEN_PROVIDER_FLOWS } from "../../src/core/api";
import { chosenFlowLines } from "../../src/renderer/src/chosenFlows";
import { translate } from "../../src/shared/i18n";
import type { Translate } from "../../src/shared/locations";
import { createTempDataFolder, startCore } from "../helpers/core";

type Language = "en" | "zh-CN";
const t =
  (language: Language): Translate =>
  (key, params) =>
    translate(language, key, params);

const FULL = {
  en: [
    "your Questions, earlier Questions and Answers, the note you’re in or one you name, the names of up to 30 of your most recently changed notes, noting which an Answer wrote, matching passages with their Document names and pages, the names, Folders and Tags of the Documents and notes a Question or a command finds (up to 50), a Meeting’s Transcript, a picture you select in a note to ask about, the names and descriptions of Skills that are on and the instructions and files of Skills an Answer loads, and the capped reports of Analyses it runs; and, for a quick-tasks model that finds the quotes behind an Answer’s Citations, the Answer and its passages, or that checks what the assistant’s reply says it changed, the reply, the Question it answers and the record of what its Tools did",
    "each sentence you check, with its paragraph and figures, and the passages it’s checked against with their Document names, pages or locations and which of a workbook’s rows hold values its formulas worked out; every sentence of a note or file you check whole, to find its claims; whole Documents in the scope, up to 40 pages, for a sentence that says something is absent; a file’s name, dates, author, page count and size, for a sentence about the file; the heading above a sentence the assistant wrote; after a new version of a Document, the cited sentences of the notes in its Folder; and for a sentence about your Library, its counts, the name of the Folder, Tag or Document the note searches with how many more items its search has, and the names, kinds and counts of the Documents, Folders and Tags, and the names of notes, that match the sentence’s words, with how many more matched",
    "the paragraph you pause on and up to 8 matching passages, each with its Document name and location, for writing suggestions",
    "the text you ask the assistant to change, the paragraphs it is in and, when the change rewrites or removes cited text, that Citation’s quote",
  ],
  "zh-CN": [
    "你的问题、此前的问答、当前笔记或你指定的笔记、最近修改的最多 30 篇笔记的名称（标出由回答写成的）、匹配的段落及其文档名称和页码、问题或命令找到的文档和笔记（最多 50 个）的名称、文件夹和标签、会议的转写稿、你在笔记中选中提问的图片、已开启技能的名称和描述、回答加载的技能的说明和文件，以及回答运行的数据分析报告（有上限）；快速任务模型为回答中的引用找出对应引文时，该回答及其段落；核对助手回复中说做了的改动时，该回复、它回答的问题，以及工具实际做了什么的记录",
    "你核对的每一句话及其所在段落和数字，以及用于核对的段落、其文档名称、页码或位置和工作簿中哪些行的数值由公式算出；整篇核对笔记或文件时，其中每一句话（用于找出说法）；句子说某处没有某内容时，范围内的整份文档（最多 40 页）；句子说的是文件本身时，文件的名称、日期、作者、页数和大小；助手所写句子上方的标题；文档有新版本后，所在文件夹中笔记里带引用的句子；句子说的是你的资料库时，资料库的数量、笔记搜索的文件夹、标签或文档名称及其搜索范围中其余项目的数量，以及与句中词语相符的文档、文件夹和标签的名称、类型和数量、笔记的名称，和其余相符名称的数量",
    "写作建议时你停下的那一段，以及最多 8 个匹配的段落（含文档名称和位置）",
    "你让助手修改的文字及其所在段落；修改会改写或删除带引用的文字时，还有该引用的引文",
  ],
} as const;

/** The kinds of data each item of the line names, so a kind a flow starts sending fails until one does. */
const NAMED_BY: Record<string, readonly DataKind[]> = {
  chat: [
    "blocks",
    "passages",
    "document-names",
    "other-minds",
    "note-catalogue",
    "live-transcript",
    "pictures",
    "skill-files",
    "analysis-results",
  ],
  checks: [
    "verified-document",
    "library-counts",
    "library-names",
    "file-properties",
    "absence-documents",
    "watched-sentences",
  ],
  suggestions: ["writing", "writing-passages"],
  edits: ["selection", "source-quotes"],
};

describe("the lines that say what choosing a provider sends (ADR-0022)", () => {
  test.each(["en", "zh-CN"] as const)("the list behind Details, in %s", (language) => {
    expect(chosenFlowLines().map((line) => t(language)(line))).toEqual(FULL[language]);
  });

  test("what the line leaves out, tagging and sorting, it says goes only on the User's word", () => {
    expect(translate("en", "providers.sends.onRequest")).toContain("only when you turn them on");
    expect(translate("zh-CN", "providers.sends.onRequest")).toContain(
      "只有在你开启或要求时才会发送",
    );
  });

  test("the one line where a service is chosen names it, and Details holds the list above", () => {
    expect(translate("en", "providers.sendsLine", { provider: "OpenAI" })).toBe(
      "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to OpenAI.",
    );
    expect(translate("zh-CN", "providers.sendsLine", { provider: "OpenAI" })).toBe(
      "你提问、修改或核对的内容，连同所需的笔记和文档内容，会发送给 OpenAI。",
    );
    expect(translate("en", "details.label")).toBe("Details");
    expect(translate("zh-CN", "details.label")).toBe("详情");
  });

  test.each([
    ["OpenAI", { kind: "openai", apiKey: "sk-test-openai", modelId: "gpt-5.4-mini" }],
    ["Anthropic", { kind: "anthropic", apiKey: "sk-ant-test", modelId: "claude-sonnet-4-6" }],
  ] as const)(
    "names every flow that choosing %s allows, and every kind of data they send",
    async (name, input) => {
      const core = startCore(await createTempDataFolder());
      await core.saveChatProvider(input);

      const toService = (await core.listDataFlows()).filter(
        (status) => status.flow.service.name === name && status.chosen,
      );

      expect(toService.map((status) => status.flow.id).sort()).toEqual(
        [...CHOSEN_PROVIDER_FLOWS].sort(),
      );
      expect(toService.every((status) => status.chosen)).toBe(true);
      const named = Object.values(NAMED_BY).flat();
      const sent = new Set(toService.flatMap((status) => status.flow.sends));
      // What a Connector's Tools return isn't named: with one on, the first Question asks.
      sent.delete("tool-results");
      expect([...sent].filter((kind) => !named.includes(kind))).toEqual([]);
    },
  );
});
