import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { foldedLine } from "../../src/renderer/src/answerSteps";
import { foldedWords } from "../../src/renderer/src/answerStepWords";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

/*
 * What an Answer counts as read (#894): the Documents the User added, and the example's apart
 * from them. A Question from the User's own Note reads only theirs; one from the example's Note
 * reads the example's too, and says so as example Documents, so its count of the User's own
 * agrees with the Library's.
 */

const EXAMPLES = resolve(__dirname, "../../resources/examples");

const WALKS = {
  en: {
    system: "en-US",
    own: [
      {
        file: "Harbour lease.md",
        name: "Harbour lease",
        text: "Northwind's lease for the Harbour Road flat ends on 30 June 2027.",
      },
      {
        file: "Contents insurance.md",
        name: "Contents insurance",
        text: "The flat's contents insurance renews on 1 March each year.",
      },
    ],
    example: [
      "Northwind Retail · Q3 2026 results",
      "Northwind Retail · Senior facilities agreement (excerpt)",
    ],
    ownNote: "My flat",
    exampleNote: "Draft: credit committee paper",
    question: "When does my lease end?",
    inOwn: "Read “My flat” and 2 Documents",
    inExample: "Read “Draft: credit committee paper” and 2 Documents, plus 2 example Documents",
  },
  "zh-CN": {
    system: "zh-CN",
    own: [
      {
        file: "海港租约.md",
        name: "海港租约",
        text: "Northwind 的海港路公寓租约于 2027 年 6 月 30 日到期。",
      },
      { file: "家财保险.md", name: "家财保险", text: "公寓的家财保险每年 3 月 1 日续保。" },
    ],
    example: [
      "Northwind Retail · 2026 年第三季度业绩",
      "Northwind Retail · 优先级贷款协议（节选）",
    ],
    ownNote: "我的公寓",
    exampleNote: "授信委员会报告（草稿）",
    question: "我的租约什么时候到期？",
    inOwn: "读了“我的公寓”，还读了 2 个文档",
    inExample: "读了“授信委员会报告（草稿）”，还读了 2 个文档，外加 2 个示例文档",
  },
} as const;

async function examplesReady(core: Core) {
  const { linkedFolderId } = await core.getExamples();
  await vi.waitFor(
    async () => {
      const read = await core.listDocuments({ linkedFolderId: linkedFolderId ?? "" });
      expect(read).toHaveLength(2);
      expect(read.every((each) => each.status === "ready")).toBe(true);
    },
    { timeout: 30_000 },
  );
}

for (const language of ["en", "zh-CN"] as const) {
  const walk = WALKS[language];

  describe(`a Question after the User added two Documents (${language})`, () => {
    // protects=with two of the User's own Documents beside the example, a Question from their own Note reads those two and the line says "2 Documents", while one from the example's Note reads the example's two as well and the line counts them apart as example Documents; the local matches follow the same sides; fails_when=the example's Documents are read or listed from the User's Note, are left out of the example's Note, or the line counts the four as the User's; no_claim=how the line looks, which e2e/waitingQuestion.spec.ts shows.
    test("their own Note reads their two, the example's Note reads the example's two as well", async () => {
      const core = startCore(await createTempDataFolder(), {
        paths: { dataDir: await createTempDataFolder(), examples: EXAMPLES },
        systemLanguages: () => [walk.system],
        createChatModel: () => scriptedModel(() => ({ text: "It is in your own file." })),
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const exampleMindId = (await core.offerExamples())?.mindId;
      if (!exampleMindId) throw new Error("The example Note wasn't made.");
      await examplesReady(core);
      const sources = await createSourceFolder();
      await addAndProcess(
        core,
        await Promise.all(walk.own.map((each) => writeSourceFile(sources, each.file, each.text))),
      );
      const ownNote = await core.createMind({ title: walk.ownNote });
      const client = await connectToMind(core, ownNote.id);
      writeMind(client, [heading(1, walk.ownNote), note("Notes on the flat.")]);
      await client.settled();

      const documents = await core.listDocuments();
      const examples = await core.getExamples();
      const nameOf = new Map(documents.map((each) => [each.id, each.name]));
      const isExample = (documentId: string) => {
        const found = documents.find((each) => each.id === documentId);
        return (
          found !== undefined &&
          found.linkedFolderId !== null &&
          found.linkedFolderId === examples.linkedFolderId
        );
      };
      const sentNames = (answer: ConversationAnswer) =>
        (answer.steps?.sent?.documents ?? []).map((id) => nameOf.get(id)).toSorted();
      const line = (answer: ConversationAnswer, mindId: string, name: string) => {
        const folded = foldedLine({
          answer,
          askedFrom: { mindId, name, deleted: false },
          meeting: false,
        });
        if (!folded) throw new Error("The Answer has no line.");
        return foldedWords((key, params) => translate(language, key, params), folded, {
          scope: () => "",
          modelOf: (id) => id,
          documentOf: (document) => nameOf.get(document.documentId) ?? document.name,
          isExample: (document) => isExample(document.documentId),
        });
      };

      const ownNames = walk.own.map((each) => each.name);
      const inOwn = await askAssistant(core, { text: walk.question, mindId: ownNote.id });
      expect(sentNames(inOwn)).toEqual(ownNames.toSorted());
      expect(line(inOwn, ownNote.id, walk.ownNote)).toBe(walk.inOwn);

      const inExample = await askAssistant(core, { text: walk.question, mindId: exampleMindId });
      expect(sentNames(inExample)).toEqual([...ownNames, ...walk.example].toSorted());
      expect(line(inExample, exampleMindId, walk.exampleNote)).toBe(walk.inExample);

      const found = async (mindId: string) =>
        new Set(
          (
            await core.searchPassages("Northwind", {
              mode: "keyword",
              limit: 20,
              place: { kind: "turn", mindId, conversationId: null },
            })
          ).map((passage) => passage.documentName),
        );
      expect(await found(ownNote.id)).toEqual(new Set([walk.own[0].name]));
      const inExampleNote = await found(exampleMindId);
      expect(inExampleNote.has(walk.own[0].name)).toBe(true);
      expect(walk.example.some((name) => inExampleNote.has(name))).toBe(true);
      core.close();
    }, 90_000);
  });
}
