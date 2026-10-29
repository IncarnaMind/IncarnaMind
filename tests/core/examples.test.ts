import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  ANSWER_BLOCK,
  CITATION_NODE,
  CLAIM_CHECK_MARK,
  type Core,
  DATABASE_FILE,
  type ExampleGroup,
  QUESTION_BLOCK,
  type WindowLayout,
} from "../../src/core";
import { EXAMPLE_SETS } from "../../src/core/exampleSets";
import type { Language } from "../../src/core/language";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForDocuments, waitForProcessing } from "../helpers/documents";
import { appendParagraph, connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

/** The example Documents the app ships. */
const EXAMPLES = resolve(__dirname, "../../resources/examples");

async function startWithExamples(language: Language = "en") {
  const dataDir = await createTempDataFolder();
  return { core: startOn(dataDir, language), dataDir };
}

/** The core on a data folder, with the shipped examples. */
const startOn = (dataDir: string, language: Language = "en") =>
  startCore(dataDir, {
    paths: { dataDir, examples: EXAMPLES },
    systemLanguages: () => [language === "zh-CN" ? "zh-CN" : "en-US"],
  });

/** The Mind the window shows: the focused group's shown tab. */
function shownMind(layout: WindowLayout | null): string | null {
  const group = layout?.groups.find((each) => each.id === layout.focusedGroupId);
  const tab = group?.tabs.find((each) => each.id === group.activeTabId);
  return tab?.item.kind === "mind" ? tab.item.mindId : null;
}

/** The example Mind as the editor would read it. */
async function exampleMind(core: Core, mindId: string): Promise<ProseMirrorNode> {
  const client = await connectToMind(core, mindId);
  return readMind(client);
}

/** Each Citation's attributes, in order. */
function citationsOf(doc: ProseMirrorNode): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) found.push(node.attrs);
  });
  return found;
}

/** Puts a copy of each Citation of the example's Answer into a Mind, as Add to note does. */
async function copyCitations(core: Core, fromMindId: string, toMindId: string): Promise<number> {
  const from = await connectToMind(core, fromMindId);
  const to = await connectToMind(core, toMindId);
  const copies: Y.XmlElement[] = [];
  const collect = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === CITATION_NODE) copies.push(child.clone());
      else collect(child);
    }
  };
  collect(from.blocks);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, copies);
  to.blocks.push([paragraph]);
  await to.settled();
  return copies.length;
}

/** Each check's mark, once, with the text it marks. */
function checksOf(doc: ProseMirrorNode): { text: string; check: Record<string, unknown> }[] {
  const found = new Map<string, { text: string; check: Record<string, unknown> }>();
  doc.descendants((node) => {
    const mark = node.marks.find((each) => each.type.name === CLAIM_CHECK_MARK);
    const check = mark?.attrs as Record<string, unknown> | undefined;
    if (!node.isText || !check) return true;
    const id = String(check.id);
    found.set(id, { text: (found.get(id)?.text ?? "") + (node.text ?? ""), check });
    return true;
  });
  return [...found.values()];
}

describe("the example Mind", { timeout: 30_000 }, () => {
  test("is made on a first run, once: its Citations quote its Documents and are found, and its draft's wrong figure is marked contradicted, quoting the results", async () => {
    const { core } = await startWithExamples();

    const made = await core.offerExamples();
    expect(made).toMatchObject({
      available: true,
      mindId: expect.any(String),
      answerId: expect.any(String),
    });
    // Offered once only, even after the example Mind is gone.
    expect(await core.offerExamples()).toBeNull();

    const mindId = made?.mindId as string;
    const [mind] = await core.listMinds();
    expect(mind).toMatchObject({ id: mindId, title: "Draft: credit committee paper" });
    // Its Documents appear once the folder is scanned.
    await vi.waitFor(async () => {
      const documents = await core.listDocuments({ linkedFolderId: made?.linkedFolderId });
      expect(documents.map((each) => each.name).sort()).toEqual([
        "Northwind Retail · Q3 2026 results",
        "Northwind Retail · Senior facilities agreement (excerpt)",
      ]);
    });

    // Its blocks: its title (#908), a Note, the draft, the Question (scoped to the examples' folder), its Answer, an empty line.
    const doc = await exampleMind(core, mindId);
    expect(doc.content.content.map((block) => block.type.name)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      QUESTION_BLOCK,
      ANSWER_BLOCK,
      "paragraph",
    ]);
    expect(doc.child(0).textContent).toBe("Draft: credit committee paper");
    expect(doc.child(6).textContent).toBe("Is Northwind inside its leverage covenant?");

    // Once both Documents are read, both Citations are checked: found, on the pages they quote.
    await vi.waitFor(
      async () => {
        const checks = citationsOf(await exampleMind(core, mindId)).map((each) => each.check);
        expect(checks).toEqual(["found", "found"]);
      },
      { timeout: 20_000, interval: 100 },
    );
    const read = await exampleMind(core, mindId);
    const [results, agreement] = citationsOf(read);
    expect(results).toMatchObject({
      documentName: "Northwind Retail · Q3 2026 results",
      quote:
        "Net debt to EBITDA was 3.1 times at the end of the quarter, up from 2.7 times at the half year.",
      pageFrom: 1,
    });
    expect(agreement).toMatchObject({
      documentName: "Northwind Retail · Senior facilities agreement (excerpt)",
      pageFrom: 1,
    });

    // The draft's wrong figure is marked contradicted, quoting the results where the check found it.
    expect(checksOf(read)).toEqual([
      {
        text: "Gross margin fell to 36.8% in Q3, mostly in online.",
        check: expect.objectContaining({
          state: "contradicted",
          text: "Gross margin fell to 36.8% in Q3, mostly in online.",
          says: "The Q3 results say gross margin was 38.6%, not 36.8%.",
          evidence: expect.objectContaining({
            documentName: "Northwind Retail · Q3 2026 results",
            quote:
              "Group gross margin was 38.6%, down from 40.3% a year earlier, with online the main drag.",
            check: "found",
            pageFrom: 1,
          }),
          versions: expect.arrayContaining([
            expect.objectContaining({ documentId: results?.documentId }),
          ]),
        }),
      },
    ]);
  });

  test("its ready Question starts a conversation with its Answer written in advance and its Citations found, asking no model (#123)", async () => {
    const { core } = await startWithExamples();
    const made = await core.offerExamples();
    const mindId = made?.mindId as string;
    expect((await core.readyQuestion())?.question).toBe("What leverage does the agreement allow?");
    const answerEvents = vi.fn();
    core.on("answer.started", answerEvents);
    core.on("answer.finished", answerEvents);
    await vi.waitFor(
      async () => {
        const checks = citationsOf(await exampleMind(core, mindId)).map((each) => each.check);
        expect(checks).toEqual(["found", "found"]);
      },
      { timeout: 20_000, interval: 100 },
    );

    const asked = await core.askExampleReadyQuestion();

    const { conversation, messages } = await core.getConversation(asked.conversationId);
    expect(conversation.askedFrom.map((each) => each.mindId)).toEqual([mindId]);
    const [question, answer] = messages;
    expect(question).toMatchObject({
      kind: "question",
      text: "What leverage does the agreement allow?",
      askedFrom: expect.objectContaining({ mindId }),
    });
    expect(answer).toMatchObject({
      kind: "answer",
      id: asked.answerId,
      status: "done",
      model: null,
      text: EXAMPLE_SETS.credit.en.ready?.answer,
      steps: expect.objectContaining({ example: true, sentAt: null }),
    });
    expect(answer?.kind === "answer" && answer.citations).toEqual([
      expect.objectContaining({
        marker: 1,
        documentName: "Northwind Retail · Senior facilities agreement (excerpt)",
        check: "found",
        pageFrom: 1,
      }),
      expect.objectContaining({
        marker: 2,
        documentName: "Northwind Retail · Q3 2026 results",
        check: "found",
        pageFrom: 1,
      }),
    ]);
    expect(answerEvents).not.toHaveBeenCalled();
  });

  test.each(["en", "zh-CN"] as const)(
    "%s: the ready Answer does not place a repeated source quote at its first occurrence",
    async (language) => {
      const { core } = await startWithExamples(language);
      await core.offerExamples();
      const listed = await waitForDocuments(core, (documents) => {
        expect(documents).toHaveLength(2);
      });
      const documents = await waitForProcessing(
        core,
        listed.map((document) => document.id),
      );
      expect(documents.map((document) => document.status)).toEqual(["ready", "ready"]);
      const quote = EXAMPLE_SETS.credit[language].ready?.quotes[0];
      const document = documents.find((document) => document.name === quote?.document);
      if (!document || !quote) throw new Error("The ready Answer's Document is missing.");
      await writeFile(
        document.path,
        buildPdf([{ printed: [{ text: quote.quote }, { text: quote.quote }] }]),
      );
      await core.reconcileDocuments();
      await waitForProcessing(core, [document.id]);

      const asked = await core.askExampleReadyQuestion();
      const { messages } = await core.getConversation(asked.conversationId);
      const answer = messages.find((message) => message.id === asked.answerId);
      expect(answer?.kind === "answer" && answer.citations[0]).toMatchObject({
        check: "not-found",
        pageFrom: null,
        pageTo: null,
      });
      core.close();
    },
  );

  test("there is no ready Question without the credit paper", async () => {
    const core = startCore(await createTempDataFolder());
    expect(await core.readyQuestion()).toBeNull();
    await expect(core.askExampleReadyQuestion()).rejects.toThrow(
      "The example isn’t there any more. Add a file of your own to ask about it.",
    );
    expect(await core.listConversations()).toEqual([]);
  });

  test("are removed with their Documents and the copies of their files, and can be made again", async () => {
    const { core, dataDir } = await startWithExamples();
    const made = await core.createExamples();
    const folder = join(dataDir, "Examples");
    expect((await readdir(folder)).sort()).toEqual([
      "LICENSE",
      "Northwind Retail · Q3 2026 results.pdf",
      "Northwind Retail · Senior facilities agreement (excerpt).pdf",
    ]);

    await core.removeExamples();
    expect(await core.getExamples()).toEqual({
      group: "credit",
      available: true,
      mindId: null,
      linkedFolderId: null,
      answerId: null,
      more: expect.any(Array),
    });
    expect(await core.listMinds()).toEqual([]);
    expect(await core.listLinkedFolders()).toEqual([]);
    await expect(access(folder)).rejects.toThrow();

    const again = await core.createExamples();
    expect(again.mindId).not.toBe(made.mindId);
    expect(await core.listMinds()).toHaveLength(1);
  });

  test("Undo after Remove the examples puts the example Note's tab back, on screen (#2195)", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    const mindId = made.mindId as string;
    await core.changeLayout("main", { type: "open", item: { kind: "mind", mindId } });
    expect(shownMind(await core.getLayout("main"))).toBe(mindId);

    await core.removeExamples();
    expect((await core.getLayout("main")).groups.flatMap((group) => group.tabs)).toEqual([]);

    await core.restoreExamples();
    expect(shownMind(await core.getLayout("main"))).toBe(mindId);
  });

  test("Undo after Remove the examples brings back the same Mind, its writing and its Documents, and leaves nothing in Recently deleted (#1292)", async () => {
    const { core, dataDir } = await startWithExamples();
    const made = await core.createExamples();
    const mindId = made.mindId as string;
    const folder = join(dataDir, "Examples");
    // The User writes in the example: that comes back too.
    const client = await connectToMind(core, mindId);
    appendParagraph(client, "Our note on the numbers below.");
    await client.settled();
    await vi.waitFor(
      async () => {
        const checks = citationsOf(await exampleMind(core, mindId)).map((each) => each.check);
        expect(checks).toEqual(["found", "found"]);
      },
      { timeout: 20_000, interval: 100 },
    );
    const documents = await core.listDocuments({ linkedFolderId: made.linkedFolderId });
    expect(documents).toHaveLength(2);

    await core.removeExamples();
    expect((await core.listDeleted()).map((item) => item.id)).toEqual([mindId]);
    expect(await core.listMinds()).toEqual([]);
    await expect(access(folder)).rejects.toThrow();

    const back = await core.restoreExamples();
    expect(back).toMatchObject({
      mindId,
      linkedFolderId: made.linkedFolderId,
      answerId: made.answerId,
    });
    // Nothing from it waits in Recently deleted, and it is the same Mind, not a copy.
    expect(await core.listDeleted()).toEqual([]);
    expect((await core.listMinds()).map((mind) => mind.id)).toEqual([mindId]);
    expect((await core.listLinkedFolders()).map((linked) => linked.id)).toEqual([
      made.linkedFolderId,
    ]);
    expect((await readdir(folder)).sort()).toEqual([
      "LICENSE",
      "Northwind Retail · Q3 2026 results.pdf",
      "Northwind Retail · Senior facilities agreement (excerpt).pdf",
    ]);
    // Its Documents are the documents they were, so its Citations still open them.
    await vi.waitFor(
      async () => {
        const restored = await core.listDocuments({ linkedFolderId: made.linkedFolderId });
        expect(restored).toHaveLength(documents.length);
        expect(restored.map((each) => each.id)).toEqual(documents.map((each) => each.id));
        expect(restored.map((each) => each.status)).toEqual(documents.map(() => "ready"));
      },
      { timeout: 20_000, interval: 100 },
    );
    const read = await exampleMind(core, mindId);
    expect(read.textContent).toContain("Our note on the numbers below.");
    const citations = citationsOf(read);
    expect(citations.map((each) => each.check)).toEqual(["found", "found"]);
    expect(new Set(citations.map((each) => each.documentId))).toEqual(
      new Set(documents.map((each) => each.id)),
    );
  });

  test("Undo after the removed Mind was also deleted for good says so rather than bringing back copies (#1292)", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    await core.removeExamples();
    await core.deletePermanently([{ kind: "mind", id: made.mindId as string }]);

    await expect(core.restoreExamples()).rejects.toThrow(/deleted permanently/);
    expect(await core.listMinds()).toEqual([]);
    expect(await core.listLinkedFolders()).toEqual([]);
  });

  test("Undo is all or nothing: a Document that can't come back takes the restored Mind and files with it (#1292)", async () => {
    const { core, dataDir } = await startWithExamples();
    const made = await core.createExamples();
    const mindId = made.mindId as string;
    const folder = join(dataDir, "Examples");
    await vi.waitFor(
      async () => {
        const documents = await core.listDocuments();
        expect(documents).toHaveLength(2);
        expect(documents.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );
    const [first] = await core.listDocuments();
    if (!first) throw new Error("The example's Documents never appeared.");

    await core.removeExamples();
    await core.deletePermanently([{ kind: "document", id: first.id }]);

    await expect(core.restoreExamples()).rejects.toThrow(/deleted permanently/);
    expect(await core.listMinds()).toEqual([]);
    expect((await core.listDeleted()).map((each) => each.id)).toEqual([mindId]);
    expect(await core.listLinkedFolders()).toEqual([]);
    expect(await core.listDocuments()).toEqual([]);
    await expect(access(folder)).rejects.toThrow();
  });

  test("Undo after the examples were removed, their Mind deleted before, brings back the Documents and leaves the User's own delete alone (#1292)", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    await core.deleteMind(made.mindId as string);

    await core.removeExamples();
    const back = await core.restoreExamples();
    expect(back).toMatchObject({ mindId: null, linkedFolderId: made.linkedFolderId });
    // Their own delete still waits in Recently deleted, to restore or not.
    expect((await core.listDeleted()).map((item) => item.id)).toEqual([made.mindId]);
    await vi.waitFor(async () => {
      expect(await core.listDocuments({ linkedFolderId: made.linkedFolderId })).toHaveLength(2);
    });
  });

  test("Undo after the examples were removed, their folder unlinked before, brings back the Mind and leaves the folder unlinked (#1292)", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    await core.removeLinkedFolder(made.linkedFolderId as string);

    await core.removeExamples();
    const back = await core.restoreExamples();
    expect(back).toMatchObject({ mindId: made.mindId, linkedFolderId: null });
    // Their own unlink stands: the removal didn't take the folder.
    expect(await core.listLinkedFolders()).toEqual([]);
    expect(await core.listDocuments()).toEqual([]);
  });

  test("a Conversation's Citations open the examples' Documents again after Undo (#1292)", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    const mindId = made.mindId as string;
    await vi.waitFor(
      async () => {
        const checks = citationsOf(await exampleMind(core, mindId)).map((each) => each.check);
        expect(checks).toEqual(["found", "found"]);
      },
      { timeout: 20_000, interval: 100 },
    );
    const asked = await core.askExampleReadyQuestion();
    const cited = async () => {
      const { messages } = await core.getConversation(asked.conversationId);
      const answer = messages.find((each) => each.kind === "answer");
      if (answer?.kind !== "answer") throw new Error("The Conversation has no Answer.");
      return answer.citations;
    };
    const before = await cited();
    expect(before.map((each) => each.documentId).sort()).toEqual(
      (await core.listDocuments()).map((each) => each.id).sort(),
    );

    await core.removeExamples();
    await core.restoreExamples();

    const after = await cited();
    expect(after.map((each) => each.documentId)).toEqual(before.map((each) => each.documentId));
    await vi.waitFor(
      async () => {
        expect((await core.listDocuments()).map((each) => each.status)).toEqual(["ready", "ready"]);
      },
      { timeout: 20_000, interval: 100 },
    );
    for (const citation of after) {
      expect(
        (
          await core.recheckCitation({
            documentId: citation.documentId,
            pageFrom: citation.pageFrom,
            pageTo: citation.pageTo,
            quote: citation.quote,
          })
        ).check,
      ).toBe("found");
    }
  });

  test("Undo brings back both examples when two were removed at once (#1292)", async () => {
    const { core } = await startWithExamples();
    const credit = await core.createExamples();
    const papers = await core.createExamples("papers");
    const ready = async () => {
      const documents = await core.listDocuments();
      expect(documents).toHaveLength(5);
      expect(documents.every((each) => each.status === "ready")).toBe(true);
      return documents;
    };
    const documents = (await vi.waitFor(ready, { timeout: 20_000, interval: 100 })).map(
      (each) => each.id,
    );
    const minds = [credit.mindId as string, papers.mindId as string].sort();
    const folders = [credit.linkedFolderId as string, papers.linkedFolderId as string].sort();

    await core.removeExamples();
    await core.removeExamples("papers");
    expect(await core.listMinds()).toEqual([]);
    expect((await core.listDeleted()).map((each) => each.id).sort()).toEqual(minds);

    await core.restoreExamples();
    await core.restoreExamples("papers");
    expect((await core.listMinds()).map((each) => each.id).sort()).toEqual(minds);
    expect((await core.listLinkedFolders()).map((each) => each.id).sort()).toEqual(folders);
    expect(await core.listDeleted()).toEqual([]);
    await vi.waitFor(
      async () => {
        const restored = await core.listDocuments();
        expect(restored.map((each) => each.id).sort()).toEqual([...documents].sort());
        expect(restored.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );
  });

  test("Undo after the examples are removed a second time brings back the same ones again (#1292)", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    const mindId = made.mindId as string;
    await vi.waitFor(
      async () => {
        const documents = await core.listDocuments();
        expect(documents).toHaveLength(2);
        expect(documents.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );
    const documents = (await core.listDocuments()).map((each) => each.id);

    await core.removeExamples();
    await core.restoreExamples();
    await core.removeExamples();
    expect((await core.listDeleted()).map((each) => each.id)).toEqual([mindId]);

    const twice = await core.restoreExamples();
    expect(twice).toMatchObject({ mindId, linkedFolderId: made.linkedFolderId });
    expect(await core.listDeleted()).toEqual([]);
    expect((await core.listMinds()).map((each) => each.id)).toEqual([mindId]);
    await vi.waitFor(
      async () => {
        const restored = await core.listDocuments();
        expect(restored.map((each) => each.id)).toEqual(documents);
        expect(restored.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );
  });

  test("deleting the example Mind on its own leaves its Linked folder marked, and making them again starts afresh", async () => {
    const { core } = await startWithExamples();
    const made = await core.createExamples();
    await core.deleteMind(made.mindId as string);
    expect(await core.getExamples()).toEqual({
      group: "credit",
      available: true,
      mindId: null,
      linkedFolderId: made.linkedFolderId,
      answerId: null,
      more: expect.any(Array),
    });

    const again = await core.createExamples();
    expect(again.mindId).not.toBe(made.mindId);
    expect(again.linkedFolderId).not.toBe(made.linkedFolderId);
    expect((await core.listLinkedFolders()).map((linked) => linked.id)).toEqual([
      again.linkedFolderId,
    ]);
    expect(await core.listMinds()).toHaveLength(1);
  });

  // protects=the tea example an earlier version made (alpha.1) is still shown and removed as the example, and the credit paper is offered once it is gone; fails_when=the old example is orphaned (no "Example", not removable) or the credit paper is never offered; no_claim=it is never remade or swapped, as its files no longer ship.
  test("the tea example an earlier version made is still the example until removed, and then the credit paper is offered", async () => {
    const { core, dataDir } = await startWithExamples();
    const made = await core.offerExamples();
    core.close();
    // Stored as an earlier version stored it, under "examples": a Mind and Linked folder of its own.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE device_settings SET key = 'examples' WHERE key = 'examples.credit'");
    } finally {
      db.close();
    }

    const again = startOn(dataDir);
    expect(await again.getExamples()).toEqual({
      group: "tea",
      available: true,
      mindId: made?.mindId,
      linkedFolderId: made?.linkedFolderId,
      answerId: made?.answerId,
      more: expect.arrayContaining(["papers", "contracts", "meetings"]),
    });
    // Offered already: nothing is made while it is there, and a change of language leaves it be.
    expect(await again.offerExamples()).toBeNull();
    await again.updateSettings({ user: { language: "zh-CN" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await again.listMinds()).map((mind) => mind.id)).toEqual([made?.mindId]);

    // Remove the examples removes it, its Documents and its files.
    await again.removeExamples();
    expect(await again.getExamples()).toEqual({
      group: "credit",
      available: true,
      mindId: null,
      linkedFolderId: null,
      answerId: null,
      more: expect.any(Array),
    });
    expect(await again.listMinds()).toEqual([]);
    expect(await again.listLinkedFolders()).toEqual([]);
    await expect(access(join(dataDir, "Examples"))).rejects.toThrow();

    // The credit paper is offered then, as on a first run, in the language now chosen.
    const offered = await again.offerExamples();
    expect(offered).toMatchObject({ group: "credit", mindId: expect.any(String) });
    expect((await again.listMinds()).map((mind) => mind.title)).toEqual([
      EXAMPLE_SETS.credit["zh-CN"].title,
    ]);
  });

  test("aren't offered when there are Minds already, nor when the app ships none", async () => {
    const { core } = await startWithExamples();
    await core.createMind({ title: "Mine" });
    expect(await core.offerExamples()).toBeNull();
    expect(await core.listMinds()).toHaveLength(1);

    const dataDir = await createTempDataFolder();
    const without = startCore(dataDir);
    expect(await without.offerExamples()).toBeNull();
    expect(await without.getExamples()).toEqual({
      group: "credit",
      available: false,
      mindId: null,
      linkedFolderId: null,
      answerId: null,
      more: expect.any(Array),
    });
  });
});

describe("the example Mind follows the interface language (#709)", { timeout: 60_000 }, () => {
  const foundIn = async (core: Core, mindId: string, quoteStart: string) =>
    vi.waitFor(
      async () => {
        const citations = citationsOf(await exampleMind(core, mindId));
        expect(citations.map((each) => each.check)).toEqual(["found", "found"]);
        expect(String(citations[0]?.quote)).toContain(quoteStart);
      },
      { timeout: 20_000, interval: 100 },
    );

  // protects=an example nobody changed is swapped, in place, for the same one in the new language, with its Documents, and back again; fails_when=the Mind stays in the old language, is replaced by a new Mind, keeps the old Documents, or a Citation isn't found; no_claim=the interface's own words.
  test("an untouched example becomes the other language's, in place, and back", async () => {
    const { core, dataDir } = await startWithExamples("en");
    const made = await core.createExamples();
    await foundIn(core, made.mindId as string, "Net debt to EBITDA");
    // Its draft's check is there: the example is still as it was made, so it follows the language.
    expect(checksOf(await exampleMind(core, made.mindId as string))).toHaveLength(1);

    await core.updateSettings({ user: { language: "zh-CN" } });
    await vi.waitFor(async () => {
      expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
        EXAMPLE_SETS.credit["zh-CN"].title,
      ]);
    });
    await foundIn(
      core,
      made.mindId as string,
      EXAMPLE_SETS.credit["zh-CN"].quotes[0]?.quote.slice(0, 6) ?? "",
    );
    const doc = await exampleMind(core, made.mindId as string);
    expect(doc.child(0).textContent).toBe(EXAMPLE_SETS.credit["zh-CN"].title);
    expect(doc.child(6).textContent).toBe(EXAMPLE_SETS.credit["zh-CN"].question);
    expect(checksOf(doc)).toEqual([
      {
        text: "第三季度毛利率降至 36.8%，主要拖累来自线上业务。",
        check: expect.objectContaining({
          state: "contradicted",
          says: "第三季度业绩写的是毛利率 38.6%，不是 36.8%。",
          evidence: expect.objectContaining({
            quote: "集团毛利率为 38.6%，上年同期为 40.3%，主要受线上业务拖累。",
            check: "found",
          }),
        }),
      },
    ]);
    expect((await core.listMinds()).length).toBe(1);
    expect((await core.listLinkedFolders()).length).toBe(1);
    await expect(access(join(dataDir, "Examples"))).rejects.toThrow();
    expect((await readdir(join(dataDir, "示例文档"))).length).toBeGreaterThan(1);

    await core.updateSettings({ user: { language: "en" } });
    await vi.waitFor(async () => {
      expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
        "Draft: credit committee paper",
      ]);
    });
    await foundIn(core, made.mindId as string, "Net debt to EBITDA");
    await expect(access(join(dataDir, "示例文档"))).rejects.toThrow();
  });

  // protects=an example made before it had a heading of its title (#908) still counts as untouched and follows the language; fails_when=it stays in the old language; no_claim=none beyond protects.
  test("an example made before its title heading still follows the language", async () => {
    const { core } = await startWithExamples("en");
    const made = await core.createExamples();
    const client = await connectToMind(core, made.mindId as string);
    client.blocks.delete(0, 1);
    await client.settled();
    await core.updateSettings({ user: { language: "zh-CN" } });
    await vi.waitFor(async () => {
      expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
        EXAMPLE_SETS.credit["zh-CN"].title,
      ]);
    });
  });

  // protects=an example the User wrote in or changed keeps its language and its Documents; fails_when=it is replaced and their words are lost; no_claim=none beyond protects.
  test("an example the User changed stays as it is", async () => {
    const { core } = await startWithExamples("en");
    const made = await core.createExamples();
    const client = await connectToMind(core, made.mindId as string);
    appendParagraph(client, "My own note.");
    await client.settled();
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
      "Draft: credit committee paper",
    ]);
  });

  // protects=an example whose Documents a check result relies on keeps them when the language changes, so that result isn't left needing a check for a change the User didn't make (#819); fails_when=the Documents are swapped and the check goes stale; no_claim=none beyond protects.
  test("an example whose Documents a check relies on keeps its language and Documents", async () => {
    const { core } = await startWithExamples("en");
    const made = await core.createExamples();
    await foundIn(core, made.mindId as string, "Net debt to EBITDA");
    const [results] = await core.listDocuments({ linkedFolderId: made.linkedFolderId as string });
    core.retention.retain("check-result", "a-mind-of-the-users", [
      { documentId: results?.id as string, contentHash: results?.contentHash as string },
    ]);

    // updateSettings returns once the examples have followed the language, or not.
    await core.updateSettings({ user: { language: "zh-CN" } });

    expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
      "Draft: credit committee paper",
    ]);
    expect((await core.listDocuments()).map((each) => each.id)).toContain(results?.id);

    // Once nothing relies on them, the next change of language swaps them.
    core.retention.release("check-result", "a-mind-of-the-users");
    await core.updateSettings({ user: { language: "en" } });
    await core.updateSettings({ user: { language: "zh-CN" } });
    await vi.waitFor(async () => {
      expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
        EXAMPLE_SETS.credit["zh-CN"].title,
      ]);
    });
  });

  // protects=an example whose Documents a Conversation Citation quotes keeps its language and Documents when the interface language changes (#1794), so the Citation still opens its page; fails_when=the Documents are swapped and the Citation says its Linked folder was removed; no_claim=what the viewer draws.
  test("an example whose Documents a Conversation Citation uses keeps its language and Documents", async () => {
    const { core } = await startWithExamples("en");
    const made = await core.createExamples();
    await foundIn(core, made.mindId as string, "Net debt to EBITDA");

    const { conversationId } = await core.askExampleReadyQuestion();
    const cited = await core.listDocuments({ linkedFolderId: made.linkedFolderId as string });
    expect(cited).toHaveLength(2);

    // updateSettings returns once the examples have followed the language, or not.
    await core.updateSettings({ user: { language: "zh-CN" } });

    expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
      "Draft: credit committee paper",
    ]);
    const stillThere = (await core.listDocuments()).map((each) => each.id);
    for (const document of cited) expect(stillThere).toContain(document.id);
    const messages = (await core.getConversation(conversationId)).messages;
    const answer = messages.find((message) => message.kind === "answer");
    if (answer?.kind !== "answer") throw new Error("The ready Question's Answer is gone.");
    expect(new Set(answer.citations.map((each) => each.documentId))).toEqual(
      new Set(cited.map((each) => each.id)),
    );

    // Once the Citation is gone, the next change of language swaps the example as usual.
    await core.deleteConversation(conversationId);
    await core.deletePermanently([{ kind: "conversation", id: conversationId }]);
    await core.updateSettings({ user: { language: "en" } });
    await core.updateSettings({ user: { language: "zh-CN" } });
    await vi.waitFor(async () => {
      expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
        EXAMPLE_SETS.credit["zh-CN"].title,
      ]);
    });
  });

  // protects=a Chinese example a Conversation cites keeps its Documents and files when the interface language becomes English, and after a restart; fails_when=the Chinese example is swapped for the English one, or a restart loses it; no_claim=none beyond protects.
  test("a Chinese example a Conversation cites keeps its Documents when the language becomes English, and after a restart", async () => {
    const set = EXAMPLE_SETS.credit["zh-CN"];
    const { core, dataDir } = await startWithExamples("zh-CN");
    const made = await core.createExamples();
    await foundIn(core, made.mindId as string, set.quotes[0]?.quote.slice(0, 6) ?? "");
    await core.askExampleReadyQuestion();
    const cited = await core.listDocuments({ linkedFolderId: made.linkedFolderId as string });
    expect(cited).toHaveLength(2);

    const expectKept = async (current: Core) => {
      expect((await current.listMinds()).map((mind) => mind.title)).toEqual([set.title]);
      expect(await current.getExamples()).toMatchObject({
        linkedFolderId: made.linkedFolderId,
      });
      expect((await current.readyQuestion())?.question).toBe(set.ready?.question);
      const stillThere = (await current.listDocuments()).map((each) => each.id);
      for (const document of cited) expect(stillThere).toContain(document.id);
      await expect(access(join(dataDir, set.folder))).resolves.toBeUndefined();
    };

    await core.updateSettings({ user: { language: "en" } });
    await expectKept(core);

    core.close();
    await expectKept(startOn(dataDir, "en"));
  });

  // protects=a Conversation in Recently deleted can come back with Citations that open, so the example it cites stays as it is meanwhile; fails_when=the example is swapped while only a deleted Conversation cites it; no_claim=none beyond protects.
  test("an example stays as it is while the Conversation citing it waits in Recently deleted", async () => {
    const { core } = await startWithExamples("en");
    const made = await core.createExamples();
    await foundIn(core, made.mindId as string, "Net debt to EBITDA");
    const { conversationId } = await core.askExampleReadyQuestion();
    const cited = await core.listDocuments({ linkedFolderId: made.linkedFolderId as string });
    await core.deleteConversation(conversationId);

    await core.updateSettings({ user: { language: "zh-CN" } });

    expect((await core.listMinds()).map((mind) => mind.title)).toEqual([
      "Draft: credit committee paper",
    ]);
    const stillThere = (await core.listDocuments()).map((each) => each.id);
    for (const document of cited) expect(stillThere).toContain(document.id);
  });

  const DIRECTIONS = [
    { from: "en", to: "zh-CN" },
    { from: "zh-CN", to: "en" },
  ] as const satisfies { from: Language; to: Language }[];

  const exampleCitedInAnotherMind = async (language: Language) => {
    const set = EXAMPLE_SETS.credit[language];
    const started = await startWithExamples(language);
    const made = await started.core.createExamples();
    await foundIn(started.core, made.mindId as string, set.quotes[0]?.quote.slice(0, 6) ?? "");
    const documents = await started.core.listDocuments({
      linkedFolderId: made.linkedFolderId as string,
    });
    expect(documents).toHaveLength(2);
    const mine = await started.core.createMind({ title: "Mine" });
    expect(await copyCitations(started.core, made.mindId as string, mine.id)).toBe(2);
    return { ...started, made, mine, documents, set };
  };

  const titles = async (core: Core) => (await core.listMinds()).map((mind) => mind.title).sort();

  for (const { from, to } of DIRECTIONS) {
    // protects=an example whose Documents a Citation copied into another Mind quotes keeps its language and Documents when the interface language changes, so that Citation still opens its original page, and the example follows the language again once no Mind or Conversation quotes them; fails_when=the Documents are swapped and the copied Citation says its Linked folder was removed, or the example's own Answer keeps it from ever following the language; no_claim=what the viewer draws.
    test(`an example whose Documents a Citation in another Mind quotes keeps its language and Documents (${from} to ${to})`, async () => {
      const { core, made, mine, documents, set } = await exampleCitedInAnotherMind(from);
      const swapped = EXAMPLE_SETS.credit[to].title;

      // updateSettings returns once the examples have followed the language, or not.
      await core.updateSettings({ user: { language: to } });

      expect(await titles(core)).toEqual([set.title, "Mine"].sort());
      const stillThere = (await core.listDocuments()).map((each) => each.id);
      for (const document of documents) expect(stillThere).toContain(document.id);
      const copied = citationsOf(await exampleMind(core, mine.id));
      expect(copied.map((each) => each.documentId).sort()).toEqual(
        documents.map((each) => each.id).sort(),
      );
      for (const citation of copied) expect(stillThere).toContain(citation.documentId);
      expect(await core.getExamples()).toMatchObject({ linkedFolderId: made.linkedFolderId });

      // The example's own Answer quotes them too, and does not keep it: only the copy does.
      await core.deleteMind(mine.id);
      await core.deletePermanently([{ kind: "mind", id: mine.id }]);
      await core.updateSettings({ user: { language: from } });
      await core.updateSettings({ user: { language: to } });
      await vi.waitFor(async () => expect(await titles(core)).toEqual([swapped]));
    });
  }

  // protects=a Mind that waits in Recently deleted can come back with Citations that open, so the example it quotes stays as it is meanwhile, and goes on following the language once that Mind is deleted permanently; fails_when=the example is swapped while only a deleted Mind quotes it, or a Mind deleted permanently still keeps it; no_claim=none beyond protects.
  test("an example stays as it is while the Mind quoting it waits in Recently deleted", async () => {
    const { core, mine, documents, set } = await exampleCitedInAnotherMind("en");
    await core.deleteMind(mine.id);

    await core.updateSettings({ user: { language: "zh-CN" } });

    expect(await titles(core)).toEqual([set.title]);
    const stillThere = (await core.listDocuments()).map((each) => each.id);
    for (const document of documents) expect(stillThere).toContain(document.id);

    await core.deletePermanently([{ kind: "mind", id: mine.id }]);
    await core.updateSettings({ user: { language: "en" } });
    await core.updateSettings({ user: { language: "zh-CN" } });
    await vi.waitFor(async () =>
      expect(await titles(core)).toEqual([EXAMPLE_SETS.credit["zh-CN"].title]),
    );
  });

  // protects=an example a Mind quotes still stays as it is when a language change comes after the app restarts; fails_when=the rule is held in memory, so a restart lets the next change of language swap the Documents; no_claim=none beyond protects.
  test("an example a Mind quotes stays as it is on a language change after a restart", async () => {
    const { core, dataDir, documents, set } = await exampleCitedInAnotherMind("en");
    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await titles(core)).toEqual([set.title, "Mine"].sort());
    core.close();

    const again = startOn(dataDir, "zh-CN");
    await again.updateSettings({ user: { language: "en" } });
    await again.updateSettings({ user: { language: "zh-CN" } });

    expect(await titles(again)).toEqual([set.title, "Mine"].sort());
    const stillThere = (await again.listDocuments()).map((each) => each.id);
    for (const document of documents) expect(stillThere).toContain(document.id);
  });
});

const GROUPS = [
  "credit",
  "papers",
  "reports",
  "contracts",
  "meetings",
] as const satisfies ExampleGroup[];
const LANGUAGES = ["en", "zh-CN"] as const satisfies Language[];

describe("the example Minds of each group", { timeout: 90_000 }, () => {
  for (const group of GROUPS) {
    for (const language of LANGUAGES) {
      test(`${group} in ${language}: every Citation is found in its own Document, and every Document's licence is listed`, async () => {
        const set = EXAMPLE_SETS[group][language];
        const { core, dataDir } = await startWithExamples(language);

        const made = await core.createExamples(group);
        expect(made).toMatchObject({ group, available: true, mindId: expect.any(String) });
        const [mind] = await core.listMinds();
        expect(mind).toMatchObject({ id: made.mindId, title: set.title });

        // Its Documents are what the folder holds, plus the licence that travels with them.
        const shipped = (await readdir(join(EXAMPLES, set.source))).sort();
        const copied = (await readdir(join(dataDir, set.folder))).sort();
        expect(copied).toEqual([...shipped, "LICENSE"].sort());

        // Every Document has its source and licence recorded.
        const licence = (await readFile(join(EXAMPLES, "LICENSE"), "utf8")).replace(/\s+/g, " ");
        for (const file of shipped) expect(licence, file).toContain(file);

        // All its Documents are read, and every Citation is found.
        await vi.waitFor(
          async () => {
            const documents = await core.listDocuments({ linkedFolderId: made.linkedFolderId });
            expect(documents).toHaveLength(shipped.length);
            const checks = citationsOf(await exampleMind(core, made.mindId as string)).map(
              (each) => each.check,
            );
            expect(checks).toEqual(set.quotes.map(() => "found"));
          },
          { timeout: 60_000, interval: 200 },
        );
        const citations = citationsOf(await exampleMind(core, made.mindId as string));
        expect(citations.map((each) => each.quote)).toEqual(set.quotes.map((each) => each.quote));
        expect(citations.map((each) => each.documentName)).toEqual(
          set.quotes.map((each) => each.document),
        );

        // The first Question is there for the User to ask.
        const doc = await exampleMind(core, made.mindId as string);
        const question = doc.content.content.find((block) => block.type.name === QUESTION_BLOCK);
        expect(question?.textContent).toBe(set.question);

        // The first open's ready Question quotes the same Documents, every Citation found.
        if (set.ready) {
          expect((await core.readyQuestion())?.question).toBe(set.ready.question);
          const asked = await core.askExampleReadyQuestion();
          const { messages } = await core.getConversation(asked.conversationId);
          const answer = messages.find((each) => each.kind === "answer");
          expect(
            answer?.kind === "answer" &&
              answer.citations.map(({ documentName, quote, check }) => ({
                document: documentName,
                quote,
                check,
              })),
          ).toEqual(set.ready.quotes.map((quote) => ({ ...quote, check: "found" })));
        } else {
          expect(await core.readyQuestion()).toBeNull();
        }
      });
    }
  }

  test("each group's example is its own: making one leaves the others alone", async () => {
    const { core } = await startWithExamples();
    const papers = await core.createExamples("papers");
    const meetings = await core.createExamples("meetings");
    expect(papers.mindId).not.toBe(meetings.mindId);
    expect(await core.listMinds()).toHaveLength(2);
    expect((await core.getExamples()).mindId).toBeNull();

    await core.removeExamples("papers");
    expect((await core.getExamples("papers")).mindId).toBeNull();
    expect((await core.getExamples("meetings")).mindId).toBe(meetings.mindId);
    expect(await core.listMinds()).toHaveLength(1);
  });
});
