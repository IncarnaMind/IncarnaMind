import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { foldedLine, stepRows } from "../../src/renderer/src/answerSteps";
import { documentsReadText, foldedWords } from "../../src/renderer/src/answerStepWords";
import { translate } from "../../src/shared/i18n";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

/*
 * What an Answer counts as read (#894, #3487), through the core as the app uses it: a Question in
 * the assistant reads only the User's Documents once they have one, whichever Note is in focus, the
 * example's too; before that, the example's. The User points at an example's Documents by naming
 * them in the Search scope, and the line then tells them apart from their own, "your" Documents
 * counted as the Library counts them, the total what was read.
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
    lines: {
      exampleOnly: "Read “Draft: credit committee paper” and 2 example Documents",
      one: "Read “Draft: credit committee paper” and “Harbour lease”",
      two: "Read “Draft: credit committee paper” and 2 Documents",
      pointed: "Read “Draft: credit committee paper”, 1 of your Documents and 1 example Document",
      named: "Read “My flat”, 1 of your Documents and 1 example Document",
      none: "Read “My flat” and 2 Documents",
    },
    rows: {
      two: "Read 2 Documents",
      exampleOnly: "Read 2 example Documents",
    },
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
    lines: {
      exampleOnly: "读了“授信委员会报告（草稿）”和 2 个示例文档",
      one: "读了“授信委员会报告（草稿）”，还读了“海港租约”",
      two: "读了“授信委员会报告（草稿）”，还读了 2 个文档",
      pointed: "读了“授信委员会报告（草稿）”、你的 1 个文档和 1 个示例文档",
      named: "读了“我的公寓”、你的 1 个文档和 1 个示例文档",
      none: "读了“我的公寓”，还读了 2 个文档",
    },
    rows: {
      two: "读了 2 个文档",
      exampleOnly: "读了 2 个示例文档",
    },
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
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);

  describe(`a Question after the User added Documents (${language})`, () => {
    // protects=with the example's Note in focus the assistant reads the example's Documents until the User has one of their own, and then only theirs, as from their own Note; naming an example's Document in the Search scope reads it, counted as an example's beside theirs; a Question written in the example's Note itself still searches both; fails_when=the example's two are sent, counted or named once the User has a Document, the User's own Note's line changes, or pointing at an example reads none; no_claim=how the line looks, which e2e/answerSteps.spec.ts shows.
    test("with the example's Note in focus, the assistant reads the User's Documents alone once they have one, and the example's when they point at them", async () => {
      const core = startCore(await createTempDataFolder(), {
        paths: { dataDir: await createTempDataFolder(), examples: EXAMPLES },
        systemLanguages: () => [walk.system],
        createChatModel: () => scriptedModel(() => ({ text: "It is in your own file." })),
      });
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const exampleMindId = (await core.offerExamples())?.mindId;
      if (!exampleMindId) throw new Error("The example Note wasn't made.");
      await examplesReady(core);
      const ownNote = await core.createMind({ title: walk.ownNote });
      const client = await connectToMind(core, ownNote.id);
      writeMind(client, [heading(1, walk.ownNote), note("Notes on the flat.")]);
      await client.settled();
      const sources = await createSourceFolder();
      const addOwn = async (at: number) => {
        const file = walk.own[at];
        if (!file) throw new Error("No such file.");
        await addAndProcess(core, [await writeSourceFile(sources, file.file, file.text)]);
      };

      /** The Answer's line and its timeline row, as the app words them from the Library as it is now. */
      const wording = async (answer: ConversationAnswer, mindId: string, name: string) => {
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
        const steps = {
          answer,
          askedFrom: { mindId, name, deleted: false },
          meeting: false,
        };
        const folded = foldedLine(steps);
        const row = stepRows(steps).find((each) => each.kind === "read-documents");
        if (!folded || row?.kind !== "read-documents") throw new Error("The Answer has no line.");
        return {
          sent: (answer.steps?.sent?.documents ?? []).map((id) => nameOf.get(id)).toSorted(),
          line: foldedWords(t, folded, {
            scope: () => "",
            modelOf: (id) => id,
            documentOf: (document) => nameOf.get(document.documentId) ?? document.name,
            isExample: (document) => isExample(document.documentId),
          }),
          row: documentsReadText(
            t,
            row.documents,
            (document) => nameOf.get(document.documentId) ?? document.name,
            null,
            (document) => isExample(document.documentId),
          ),
        };
      };
      const fromExample = async () =>
        wording(
          await askAssistant(core, { text: walk.question, mindId: exampleMindId }),
          exampleMindId,
          walk.exampleNote,
        );
      const ownNames = walk.own.map((each) => each.name);

      const exampleOnly = await fromExample();
      expect(exampleOnly.sent).toEqual([...walk.example].toSorted());
      expect(exampleOnly.line).toBe(walk.lines.exampleOnly);
      expect(exampleOnly.row).toBe(walk.rows.exampleOnly);

      await addOwn(0);
      const one = await fromExample();
      expect(one.sent).toEqual([ownNames[0]]);
      expect(one.line).toBe(walk.lines.one);

      await addOwn(1);
      const two = await fromExample();
      expect(two.sent).toEqual([...ownNames].toSorted());
      expect(two.line).toBe(walk.lines.two);
      expect(two.row).toBe(walk.rows.two);

      const inOwn = await wording(
        await askAssistant(core, { text: walk.question, mindId: ownNote.id }),
        ownNote.id,
        walk.ownNote,
      );
      expect(inOwn.sent).toEqual([...ownNames].toSorted());
      expect(inOwn.line).toBe(walk.lines.none);

      const documents = await core.listDocuments();
      const idOf = (name: string) => documents.find((each) => each.name === name)?.id ?? "";
      const named = await wording(
        await askAssistant(core, {
          text: walk.question,
          mindId: ownNote.id,
          scope: {
            folderIds: [],
            tagIds: [],
            documentIds: [idOf(ownNames[0] ?? ""), idOf(walk.example[0] ?? "")],
          },
        }),
        ownNote.id,
        walk.ownNote,
      );
      expect(named.sent).toEqual([ownNames[0], walk.example[0]].toSorted());
      expect(named.line).toBe(walk.lines.named);

      const pointed = await wording(
        await askAssistant(core, {
          text: walk.question,
          mindId: exampleMindId,
          scope: {
            folderIds: [],
            tagIds: [],
            documentIds: [idOf(ownNames[0] ?? ""), idOf(walk.example[0] ?? "")],
          },
        }),
        exampleMindId,
        walk.exampleNote,
      );
      expect(pointed.sent).toEqual([ownNames[0], walk.example[0]].toSorted());
      expect(pointed.line).toBe(walk.lines.pointed);

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
      expect(await found(ownNote.id)).toEqual(new Set([ownNames[0]]));
      const inExampleNote = await found(exampleMindId);
      expect(inExampleNote.has(ownNames[0] ?? "")).toBe(true);
      expect(walk.example.some((name) => inExampleNote.has(name))).toBe(true);
      // The same Note in focus of a Question in the assistant reads what the assistant did.
      const askedFromExample = new Set(
        (
          await core.searchPassages("Northwind", {
            mode: "keyword",
            limit: 20,
            place: { kind: "asked", askedFrom: { mindId: exampleMindId }, folderAskedIn: "" },
          })
        ).map((passage) => passage.documentName),
      );
      expect(askedFromExample).toEqual(new Set([ownNames[0]]));
      core.close();
    }, 120_000);
  });
}
