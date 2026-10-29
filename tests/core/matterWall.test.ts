import { describe, expect, test } from "vitest";
import type { Core, Document, SearchScope } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import {
  answerEnded,
  recordSearches,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { startCore } from "../helpers/core";
import type { MindClient } from "../helpers/mindClient";
import { editMind, question } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

const FILES = [
  { name: "Client A lease.txt", contents: "Termination notice: 90 days.\n" },
  { name: "Client B lease.txt", contents: "Termination notice: 30 days.\n" },
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
  const documentA = setup.documents.find((each) => each.name.includes("Client A")) as Document;
  const documentB = setup.documents.find((each) => each.name.includes("Client B")) as Document;
  await setup.core.assignDocumentGroup(documentA.id, clientA.id);
  await setup.core.assignDocumentGroup(documentB.id, clientB.id);
  await setup.core.moveToFolder({ mindIds: [setup.mind.id], folderId: clientA.id });
  const noteB = await setup.core.createMind({ title: "Client B note", folderId: clientB.id });
  return { ...setup, model, searches, clientA, clientB, documentA, documentB, noteB };
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

    expect(answer.text).toBe("This Folder keeps its work inside it.");

    const results = modelCalls
      .flatMap((call) => call.results.map((result) => result.text))
      .join("\n");
    expect(results).toContain("This Folder keeps its work inside it.");
    expect(results).not.toContain("Termination notice: 30 days.");
    expect(modelCalls.map((call) => call.system).join("\n")).not.toContain(noteB.title);
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
