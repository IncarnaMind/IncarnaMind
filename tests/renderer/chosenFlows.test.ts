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
    "your Questions, the Mind you’re in or one you name, matching passages with their Document names and pages, the names, Folders and Tags of the Documents a Question or a command finds (up to 50), and a Meeting’s Transcript",
    "each sentence you check",
    "the paragraph you pause on, for writing suggestions",
    "the text you ask the assistant to change",
  ],
  "zh-CN": [
    "你的问题、你所在或在问题中提到的 Mind、相关段落及其文档名称和页码、问题或命令找到的文档的名称、文件夹和标签（最多 50 个），以及会议的转写稿",
    "你核对的每一句话",
    "写作建议时你停下的那一段",
    "你让助手修改的文字",
  ],
} as const;

/** The kinds of data each item of the line names, so a kind a flow starts sending fails until one does. */
const NAMED_BY: Record<string, readonly DataKind[]> = {
  chat: ["blocks", "passages", "document-names", "other-minds", "live-transcript"],
  checks: ["verified-document"],
  suggestions: ["writing", "writing-passages"],
  edits: ["selection"],
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
      "Sends your questions and document text to OpenAI.",
    );
    expect(translate("zh-CN", "providers.sendsLine", { provider: "OpenAI" })).toBe(
      "会把你的问题和文档内容发送给 OpenAI。",
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
