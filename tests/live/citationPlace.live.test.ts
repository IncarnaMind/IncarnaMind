/**
 * Where Citations go in a Word or PDF export (#1600) against a real model: an Answer with
 * Citations, added to a Mind, exported with its Citations as footnotes and in a list at the end.
 * The model runs only when its key is in the environment, so `npx vitest run` makes no request
 * without one.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_REPORT          a file to keep what was exported
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { answerBlocks } from "../../src/shared/answerBlocks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, unzip } from "../helpers/docx";
import { docxOf } from "../helpers/office";
import { fakePrinter } from "../helpers/printer";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
  (catalogProvider("anthropic")?.roles.quickTasks as string);

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

describe("Where Citations go, live: Anthropic", () => {
  test.skipIf(KEY === undefined)(
    "an Answer with Citations, added to a Mind, exports the same way in both modes",
    { timeout: 300_000 },
    async () => {
      const { printed, printer } = fakePrinter();
      const core = startCore(await createTempDataFolder(), {
        createChatModel: createAiSdkChatModel,
        printer,
      });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: KEY as string, modelId: MODEL });
      const sources = await createTempDataFolder();
      const docx = await writeSourceFile(sources, "示例简历-设计师 2.docx", RESUME);
      await addAndProcess(core, [docx]);
      const mind = await core.createMind({ title: "Summary" });

      const asked = await core.askInConversation({
        conversationId: null,
        text: "Summarise this person's experience in a short paragraph, citing the résumé.",
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
      await core.addToNote({
        mindId: mind.id,
        blocks: answerBlocks(answer) as unknown[],
        origin: null,
        model: null,
      });

      const exported = async (citationPlace: "footnotes" | "list") => {
        const { data, citations, citedDocuments } = await core.exportMind(mind.id, {
          format: "docx",
          citationPlace,
        });
        const files = unzip(data);
        const document = part(files, "word/document.xml");
        return {
          citations,
          citedDocuments,
          references: document.match(/<w:footnoteReference /g)?.length ?? 0,
          footnotes: Object.values(footnotesOf(part(files, "word/footnotes.xml"))),
          paragraphs: paragraphsOf(document).map((each) => each.text),
        };
      };
      const footnotes = await exported("footnotes");
      const list = await exported("list");
      await core.exportMind(mind.id, { format: "pdf", citationPlace: "list" });
      const pdf = printed.at(-1);

      expect(footnotes.citations).toBeGreaterThan(0);
      expect(footnotes.references).toBe(footnotes.citations);
      expect(list.references).toBe(0);
      expect(list.footnotes).toEqual([]);
      expect(list.citedDocuments).toBe(1);
      expect(list.paragraphs.filter((each) => /^\[\d+\]\t/.test(each))).toHaveLength(1);
      expect(list.paragraphs.some((each) => /\[1\]/.test(each))).toBe(true);
      expect(pdf?.notes).toEqual([]);
      expect(pdf?.body).toContain("[1]");

      const report = process.env.INCARNAMIND_LIVE_REPORT;
      if (report) {
        await appendFile(
          report,
          `- ${MODEL}: ${footnotes.citations} Citations from ${list.citedDocuments} Document\n  footnotes: ${footnotes.footnotes.join(" | ")}\n  list: ${list.paragraphs.slice(-3).join(" | ")}\n`,
        );
      }
    },
  );
});
