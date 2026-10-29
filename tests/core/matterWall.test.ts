import { describe, expect, test, vi } from "vitest";
import type { Core, Document, SearchScope } from "../../src/core";
import { folderScope, NO_SCOPE } from "../../src/shared/searchScope";
import { askAssistant } from "../helpers/assistant";
import {
  answerEnded,
  recordSearches,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";
import type { MindClient } from "../helpers/mindClient";
import { editMind, question } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const FILES = [
  { name: "Client A lease.txt", contents: "Termination notice: 90 days.\n" },
  { name: "Client B lease.txt", contents: "Termination notice: 30 days.\n" },
  { name: "Other lease.txt", contents: "Termination notice: 60 days.\n" },
];

async function setUp(
  behavior: Parameters<typeof scriptedModel>[0] = (call: ModelCall) => {
    if (call.results.length === 0)
      return { calls: [{ tool: "search_documents", input: { query: "notice" } }] };
    return { text: "Here is what your Documents say." };
  },
) {
  const { searches, answerSearch } = recordSearches();
  const model = scriptedModel(behavior);
  const setup = await setUpWithDocuments(model, FILES, { answerSearch });
  const clientA = await setup.core.createLibraryGroup({ name: "Client A", description: "" });
  const clientB = await setup.core.createLibraryGroup({ name: "Client B", description: "" });
  const otherFolder = await setup.core.createLibraryGroup({ name: "Other work", description: "" });
  const documentA = setup.documents.find((each) => each.name.includes("Client A")) as Document;
  const documentB = setup.documents.find((each) => each.name.includes("Client B")) as Document;
  const otherDocument = setup.documents.find((each) =>
    each.name.includes("Other lease"),
  ) as Document;
  await setup.core.assignDocumentGroup(documentA.id, clientA.id);
  await setup.core.assignDocumentGroup(documentB.id, clientB.id);
  await setup.core.assignDocumentGroup(otherDocument.id, otherFolder.id);
  await setup.core.moveToFolder({ mindIds: [setup.mind.id], folderId: clientA.id });
  const noteB = await setup.core.createMind({ title: "Client B note", folderId: clientB.id });
  const looseMind = await setup.core.createMind({ title: "Outside note" });
  return {
    ...setup,
    model,
    searches,
    clientA,
    clientB,
    otherFolder,
    documentA,
    documentB,
    otherDocument,
    noteB,
    looseMind,
  };
}

async function ask(core: Core, client: MindClient, mindId: string, scope?: Partial<SearchScope>) {
  const asked = question("What do my Documents say about tides?", undefined, scope);
  editMind(client, (blocks) => [...blocks, asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
}

describe("A Folder that keeps its work inside it", () => {
  test("is off by default, then clamps the requested scope and restores when turned off", async () => {
    const { core, client, mind, clientA, clientB, documentA, documentB, searches } = await setUp();
    expect(clientA.keepInside).toBe(false);
    const widened = { folderIds: [clientB.id], tagIds: [], documentIds: [] };
    await ask(core, client, mind.id, widened);
    expect(searches.at(-1)).toEqual([documentB.name]);

    const walled = await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    expect(walled.keepInside).toBe(true);
    await ask(core, client, mind.id, widened);
    expect(searches.at(-1)).toEqual([documentA.name]);

    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: false,
    });
    await ask(core, client, mind.id, widened);
    expect(searches.at(-1)).toEqual([documentB.name]);
  });

  test("does not fall back to every Document when the walled Folder is empty", async () => {
    const { core, client, mind, clientA, clientB, documentA } = await setUp();
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    await core.assignDocumentGroup(documentA.id, clientB.id);

    await ask(core, client, mind.id);

    expect(
      await core.countScopeDocuments({ folderIds: [clientA.id], tagIds: [], documentIds: [] }),
    ).toBe(0);
  });

  test("refuses to read another Folder's Note and names only its own", async () => {
    const modelCalls: ModelCall[] = [];
    const { core, mind, clientA, noteB } = await setUp((call) => {
      modelCalls.push(call);
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "notice" } }] };
      }
      if (!call.results.some((result) => result.tool === "read_mind")) {
        return { calls: [{ tool: "read_mind", input: { mind: "Client B note" } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(
          call.results.find((result) => result.tool === "search_documents")?.text ?? "",
        )[0];
        if (!passage) throw new Error("The search gave no Passage.");
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: passage.text }] },
            },
          ],
        };
      }
      return { text: "Done [^1]." };
    });
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    const answer = await askAssistant(core, { text: "Read Client B note", mindId: mind.id });

    expect(answer.text).toBe("Done [^1].\n\nThis Folder keeps its work inside it.");

    const results = modelCalls
      .flatMap((call) => call.results.map((result) => result.text))
      .join("\n");
    expect(results).toContain("This Folder keeps its work inside it.");
    expect(results).not.toContain("Termination notice: 30 days.");
    expect(modelCalls.map((call) => call.system).join("\n")).not.toContain(noteB.title);
  });

  test("leaves earlier turns and the last Answer on the other side of a wall", async () => {
    const modelCalls: ModelCall[] = [];
    const { core, mind, clientA, noteB } = await setUp((call) => {
      modelCalls.push(call);
      if (call.results.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "notice" } }] };
      return { text: "Outside 60 days" };
    });
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    const first = await askAssistant(core, { text: "Summarize this", mindId: noteB.id });
    await askAssistant(core, {
      text: "Add that answer here",
      mindId: mind.id,
      conversationId: first.conversationId,
    });

    expect(modelCalls.map((call) => call.prompt).join("\n")).not.toContain("Outside 60 days");
    const tools = JSON.stringify(modelCalls.at(-1)?.options.tools ?? []);
    expect(tools).not.toContain('"answer":{"type":"boolean"');
  });

  test("leaves a quoted Document outside the current wall", async () => {
    const modelCalls: ModelCall[] = [];
    const { core, mind, clientA, documentB } = await setUp((call) => {
      modelCalls.push(call);
      if (call.results.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: "notice" } }] };
      return { text: "Answer" };
    });
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });

    const asked = await core.askInConversation({
      text: "Check this quote",
      mindId: mind.id,
      quotes: [
        {
          documentId: documentB.id,
          documentName: documentB.name,
          quote: "Termination notice: 30 days.",
          pageFrom: null,
          pageTo: null,
          location: null,
        },
      ],
    });
    if (!asked.asked) throw new Error("The Question wasn't asked.");
    expect(asked.leftOut).toHaveLength(1);
    await answerEnded(core, asked.answerId);
    expect(modelCalls.map((call) => call.prompt).join("\n")).not.toContain("30 days");
  });

  test("does not list or move another Folder's Document with an assistant command", async () => {
    const { core, mind, clientA, clientB, documentB } = await setUp((call) => {
      if (!call.results.some((result) => result.tool === "list_commands")) {
        return {
          calls: [{ tool: "list_commands", input: { kind: "document", name: "Client B lease" } }],
        };
      }
      if (!call.results.some((result) => result.tool === "run_command")) {
        return {
          calls: [
            {
              tool: "run_command",
              input: { command: "document.moveTo", ids: [documentB.id], folder: "Client A" },
            },
          ],
        };
      }
      return { text: "Done" };
    });
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });

    await askAssistant(core, { text: "Move Client B lease here", mindId: mind.id });

    const library = await core.getLibrary();
    expect(library.assignments.find((each) => each.documentId === documentB.id)?.groupId).toBe(
      clientB.id,
    );
  });

  test("uses a conversation's Folder wall when no Note is open", async () => {
    const { core, mind, clientA, documentA, searches } = await setUp();
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    const first = await askAssistant(core, { text: "Summarize this", mindId: mind.id });
    await askAssistant(core, {
      text: "Follow up",
      conversationId: first.conversationId,
    });

    expect(searches.at(-1)).toEqual([documentA.name]);
  });

  test("refuses a Research target on the other side of a wall", async () => {
    const { core, mind, clientA, noteB } = await setUp();
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });

    await expect(
      core.startResearch({
        mindId: mind.id,
        topic: "Lease terms",
        plan: { title: "Lease terms", steps: ["Search the lease"] },
        sources: { web: false, library: true },
        writeInto: { mindId: noteB.id },
        scope: NO_SCOPE,
      }),
    ).rejects.toThrow("This Folder keeps its work inside it.");
  });

  test("leaves both walled Folders out of an outside Note's All Documents scope", async () => {
    const { core, looseMind, clientA, clientB, otherDocument } = await setUp();
    for (const folder of [clientA, clientB]) {
      await core.updateLibraryGroup(folder.id, {
        name: folder.name,
        description: folder.description,
        keepInside: true,
      });
    }

    expect(await core.countScopeDocuments(NO_SCOPE)).toBe(1);
    await expect(
      core.compareDocuments({
        mindId: looseMind.id,
        documentIds: [otherDocument.id],
        questions: ["What is the notice?"],
      }),
    ).resolves.toMatchObject({ started: true });
  });

  test("does not turn a Note that exists nowhere into a wall refusal", async () => {
    const { core, mind, clientA } = await setUp((call) => {
      if (!call.results.some((result) => result.tool === "read_mind")) {
        return { calls: [{ tool: "read_mind", input: { mind: "No such note" } }] };
      }
      return { text: "Good answer" };
    });
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });

    const answer = await askAssistant(core, { text: "Read No such note", mindId: mind.id });
    expect(answer.text).toContain("Good answer");
    expect(answer.text).not.toContain("This Folder keeps its work inside it.");
  });

  test("Compare cannot bring another Folder's Document into a walled Note", async () => {
    const { core, mind, clientA, documentB } = await setUp();
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });

    await expect(
      core.compareDocuments({
        mindId: mind.id,
        documentIds: [documentB.id],
        questions: ["What is the termination notice?"],
      }),
    ).rejects.toThrow();
  });

  test("keeps walled Notes out of an outside assistant and check", async () => {
    const modelCalls: ModelCall[] = [];
    const { core, looseMind, clientA, clientB, noteB } = await setUp((call) => {
      modelCalls.push(call);
      if (!call.results.some((result) => result.tool === "read_mind")) {
        return { calls: [{ tool: "read_mind", input: { mind: "Client B note" } }] };
      }
      return { text: "Outside answer" };
    });
    for (const folder of [clientA, clientB]) {
      await core.updateLibraryGroup(folder.id, {
        name: folder.name,
        description: folder.description,
        keepInside: true,
      });
    }

    await askAssistant(core, { text: "Read Client B note", mindId: looseMind.id });
    expect(modelCalls.map((call) => call.system).join("\n")).not.toContain(noteB.title);
    expect(modelCalls.map((call) => call.prompt).join("\n")).not.toContain("30 days");

    const checked = await core.checkClaim({
      claim: "Termination notice: 30 days.",
      scope: NO_SCOPE,
    });
    expect(checked.verdict).not.toBe("supported");
  });

  test("only the User's own filings count in a walled Folder", async () => {
    const fake = classifierModel();
    const core = startCore(await createTempDataFolder(), { createChatModel: () => fake.model });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const folder = await core.createLibraryGroup({ name: "Client A", description: "" });
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: "small-classifier" },
      },
      automatic: false,
    });
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "Client A lease.txt",
        "Termination notice: 90 days.",
      ),
    ]);
    if (!document) throw new Error("The lease wasn't added.");
    await core.updateLibraryGroup(folder.id, {
      name: folder.name,
      description: folder.description,
      keepInside: true,
    });

    await core.classifyDocuments([document.id]);
    await vi.waitFor(async () => {
      const assignment = (await core.getLibrary()).assignments.find(
        (each) => each.documentId === document.id,
      );
      expect(assignment?.status).toBe("classified");
      expect(assignment?.source).toBe("automatic");
    });
    expect(await core.countScopeDocuments(folderScope(folder.id))).toBe(0);

    await core.assignDocumentGroup(document.id, folder.id);
    expect(await core.countScopeDocuments(folderScope(folder.id))).toBe(1);
  });

  test("keeps the wall after a restart", async () => {
    const { core, dataDir, clientA } = await setUp();
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    core.close();

    const restarted = startCore(dataDir);
    expect(
      (await restarted.getLibrary()).groups.find((group) => group.id === clientA.id)?.keepInside,
    ).toBe(true);
    restarted.close();
  });

  test("restores a Folder's wall with the Folder", async () => {
    const { core, clientA } = await setUp();
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: clientA.description,
      keepInside: true,
    });
    await core.deleteLibraryGroup(clientA.id);
    await core.restore([{ kind: "folder", id: clientA.id }]);
    expect(
      (await core.getLibrary()).groups.find((each) => each.id === clientA.id)?.keepInside,
    ).toBe(true);
  });
});
