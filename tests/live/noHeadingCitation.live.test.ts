/**
 * A Document with no headings, cited by a real model (#1601): the Citations are found and name
 * the Document and the paragraph, never "§ Start". The model runs only when its key is in the
 * environment, so `npx vitest run` makes no request without one.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_REPORT          a file to keep what each Citation reads
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { CITATION_NODE, type CitationAttributes } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { citationSource } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { docxOf } from "../helpers/office";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

const NAME = "示例简历-设计师 2";
const RESUME = docxOf([
  { text: "示例员工" },
  { text: "资深视觉设计师，7年设计经验" },
  {
    text: "2019年至今：在一家电商公司担任视觉设计负责人，主导过三个品牌的视觉升级，带领五人设计团队。",
  },
  { text: "2016年至2019年：在广告公司担任设计师，负责海报、包装和线上活动页面的设计。" },
  { text: "擅长工具：Figma、Sketch、Photoshop 和 Illustrator。" },
  { text: "教育背景：2012年至2016年，本科，视觉传达设计。" },
]);

interface Cited {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: Cited[];
}

describe("A Document with no headings, live: Anthropic", () => {
  test.skipIf(KEY === undefined)(
    "its Citations name the Document and the paragraph, never '§ Start'",
    { timeout: 300_000 },
    async () => {
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY as string, modelId: MODEL });
      const sources = await createTempDataFolder();
      await addAndProcess(core, [await writeSourceFile(sources, `${NAME}.docx`, RESUME)]);
      const mind = await core.createMind({ title: "Summary" });

      const asked = await core.askInConversation({
        conversationId: null,
        text: "Summarise this person's experience in three sentences, citing the résumé.",
        mindId: mind.id,
      });
      if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
      await new Promise<void>((resolve) => {
        const stops = [
          core.on("answer.finished", ({ answerId }) => answerId === asked.answerId && done()),
          core.on("answer.failed", ({ answerId }) => answerId === asked.answerId && done()),
        ];
        function done() {
          for (const stop of stops) stop();
          resolve();
        }
      });
      const { messages } = await core.getConversation(asked.conversation.id);
      const answer = messages.find((message) => message.id === asked.answerId);
      if (answer?.kind !== "answer") throw new Error("No Answer.");

      const citations: Partial<CitationAttributes>[] = [];
      const visit = (node: Cited) => {
        if (node.type === CITATION_NODE)
          citations.push((node.attrs ?? {}) as Partial<CitationAttributes>);
        for (const child of node.content ?? []) visit(child);
      };
      for (const block of answerBlocks(answer) as Cited[]) visit(block);
      const reads = (language: "en" | "zh-CN") =>
        citations.map(
          (each) => citationSource(each, (key, params) => translate(language, key, params)).text,
        );

      const report = process.env.INCARNAMIND_LIVE_REPORT;
      if (report) {
        await appendFile(
          report,
          `- ${MODEL}: ${citations.length} Citations\n  ${reads("en").join("\n  ")}\n`,
        );
      }
      expect(citations.length).toBeGreaterThan(0);
      expect(citations.every((each) => each.check === "found")).toBe(true);
      for (const text of [...reads("en"), ...reads("zh-CN")]) {
        expect(text).not.toMatch(/Start|开头/);
        expect(text.startsWith(NAME)).toBe(true);
      }
      expect(reads("en").some((text) => /¶ \d/.test(text))).toBe(true);
    },
  );
});
