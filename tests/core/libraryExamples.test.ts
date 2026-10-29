import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ConversationAnswer } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";
import type { ModelCall } from "../helpers/models";
import { scriptedModel, scriptedModels } from "../helpers/models";

/** The example Documents the app ships. */
const EXAMPLES = resolve(__dirname, "../../resources/examples");

describe("the examples' Documents", () => {
  test("Organize files the User's Documents and leaves the example's alone (#1942)", async () => {
    const dataDir = await createTempDataFolder();
    const fake = classifierModel();
    const core = startCore(dataDir, {
      paths: { dataDir, examples: EXAMPLES },
      createChatModel: () => fake.model,
      systemLanguages: () => ["en-US"],
    });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const group = await core.createLibraryGroup({
      name: "Research",
      description: "Scientific research papers.",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: true,
    });
    const examples = await core.createExamples();
    const inExample = async () =>
      examples.linkedFolderId === null
        ? []
        : await core.listDocuments({ linkedFolderId: examples.linkedFolderId });
    await vi.waitFor(
      async () => {
        expect((await inExample()).length).toBeGreaterThan(0);
      },
      { timeout: 30_000 },
    );
    const exampleIds = (await inExample()).map((each) => each.id);
    await vi.waitFor(
      async () => {
        const read = (await core.listDocuments()).filter((each) => exampleIds.includes(each.id));
        expect(read.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 30_000 },
    );

    // A Document of the User's own is filed as Organize does; the example's stay as they are.
    const [own] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "thesis.txt",
        "A study of membranes and water filtration.",
      ),
    ]);
    if (!own) throw new Error("No Document added.");
    await vi.waitFor(async () => {
      const filed = (await core.getLibrary()).assignments.find(
        (each) => each.documentId === own.id,
      );
      expect(filed?.groupId).toBe(group.id);
    });
    const filed = (await core.getLibrary()).assignments.filter((each) =>
      exampleIds.includes(each.documentId),
    );
    expect(filed).toEqual([]);

    // Asking Organize for them by id leaves them alone too.
    await core.classifyDocuments(exampleIds);
    expect(
      (await core.getLibrary()).assignments.filter((each) => exampleIds.includes(each.documentId)),
    ).toEqual([]);
    expect(await core.isExampleDocument(own.id)).toBe(false);
    expect(await core.isExampleDocument(exampleIds[0] ?? "")).toBe(true);
  });

  test("a text search leaves the examples' Documents out before its limit, and holds at 200 (#1942)", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      paths: { dataDir, examples: EXAMPLES },
      systemLanguages: () => ["en-US"],
    });
    const examples = await core.createExamples();
    const inExample = async () =>
      examples.linkedFolderId === null
        ? []
        : await core.listDocuments({ linkedFolderId: examples.linkedFolderId });
    await vi.waitFor(
      async () => {
        const read = await inExample();
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 30_000 },
    );
    // A Document of the User's own that shares the example's words, so both ranks are in play.
    const [own] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "northwind-notes.txt",
        "Northwind Retail results and the facilities agreement, in my own words.",
      ),
    ]);
    if (!own) throw new Error("No Document added.");

    // One place: an example ranking first must not take it, nor leave it empty.
    const one = await core.searchDocumentText("Northwind Retail", { limit: 1 });
    expect(one.map((each) => each.documentId)).toEqual([own.id]);
    // Two places, and the full 200 the core takes: no error from asking for more than it allows.
    const two = await core.searchDocumentText("Northwind Retail", { limit: 2 });
    expect(two.map((each) => each.documentId)).toEqual([own.id]);
    const all = await core.searchDocumentText("Northwind Retail", { limit: 200 });
    expect(all.map((each) => each.documentId)).toEqual([own.id]);
  });

  test("a first search finds the examples' Documents, which the User's first Document leaves out (#1942)", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      paths: { dataDir, examples: EXAMPLES },
      systemLanguages: () => ["en-US"],
    });
    const examples = await core.createExamples();
    const inExample = async () =>
      examples.linkedFolderId === null
        ? []
        : await core.listDocuments({ linkedFolderId: examples.linkedFolderId });
    await vi.waitFor(
      async () => {
        const read = await inExample();
        expect(read.length).toBeGreaterThan(0);
        expect(read.every((each) => each.status === "ready")).toBe(true);
      },
      { timeout: 30_000 },
    );
    const exampleIds = (await inExample()).map((each) => each.id);

    // A fresh data folder: the Library lists the examples, so the search finds in them.
    const first = await core.searchDocumentText("Northwind Retail", { limit: 200 });
    expect(first.length).toBeGreaterThan(0);
    expect(exampleIds).toContain(first[0]?.documentId);

    // The User's first Document: theirs is found, and the example's are left out.
    const [own] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "northwind-notes.txt",
        "Northwind Retail results and the facilities agreement, in my own words.",
      ),
    ]);
    if (!own) throw new Error("No Document added.");
    const after = await core.searchDocumentText("Northwind Retail", { limit: 200 });
    expect(after.map((each) => each.documentId)).toEqual([own.id]);
  });

  test("an example assignment stored by an earlier version is not worked on again at startup (#1942)", async () => {
    const dataDir = await createTempDataFolder();
    const fake = classifierModel();
    const start = () =>
      startCore(dataDir, {
        paths: { dataDir, examples: EXAMPLES },
        createChatModel: () => fake.model,
        systemLanguages: () => ["en-US"],
      });
    const core = start();
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const group = await core.createLibraryGroup({
      name: "Research",
      description: "Scientific research papers.",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: true,
    });
    const examples = await core.createExamples();
    const inExample = async () =>
      examples.linkedFolderId === null
        ? []
        : await core.listDocuments({ linkedFolderId: examples.linkedFolderId });
    await vi.waitFor(
      async () => {
        expect((await inExample()).length).toBeGreaterThan(0);
      },
      { timeout: 30_000 },
    );
    const [exampleDocument] = await inExample();
    if (!exampleDocument) throw new Error("No example Document.");
    // Organize leaves the example's Documents alone, so it has no assignment to put back.
    const held = (await core.getLibrary()).assignments.find(
      (each) => each.documentId === exampleDocument.id,
    );
    expect(held).toBeUndefined();
    // As an earlier version left it: waiting to be filed, which nothing puts back.
    await core.restoreAssignment(
      exampleDocument.id,
      {
        assignment: {
          groupId: null,
          source: "automatic",
          suggested: false,
          status: "pending",
          error: null,
          model: null,
        },
        tagging: null,
      },
      { assignment: null, tagging: null },
    );
    core.close();

    const again = start();
    // Given the time a classification takes, it is still waiting: the resume left it alone.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stored = (await again.getLibrary()).assignments.find(
      (each) => each.documentId === exampleDocument.id,
    );
    expect(stored?.status).toBe("pending");
    expect(stored?.groupId).toBeNull();
    expect(group.id).toBeDefined();
    again.close();
  });

  test("a move that names the example's Document and the User's own moves the User's alone (#1942)", async () => {
    const dataDir = await createTempDataFolder();
    const steps = [
      { tool: "list_commands", input: { kind: "document", name: "northwind" } },
      "move",
    ] as const;
    const model = scriptedModel((call: ModelCall) => {
      const made = call.results.filter((each) =>
        /^(?:list_commands|run_command)$/.test(each.tool),
      ).length;
      if (made === 0) return { calls: [{ ...steps[0], input: steps[0].input }] };
      if (made === 1) {
        const listed =
          call.results.filter((each) => each.tool === "list_commands").at(-1)?.text ?? "";
        const ids = [...listed.matchAll(/^- (\S+): /gm)].map((match) => match[1] ?? "");
        return {
          calls: [
            { tool: "run_command", input: { command: "document.moveTo", folder: "Finance", ids } },
          ],
        };
      }
      return { text: "Done." };
    });
    const { createChatModel } = scriptedModels(model);
    const core = startCore(dataDir, {
      paths: { dataDir, examples: EXAMPLES },
      createChatModel,
      systemLanguages: () => ["en-US"],
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const examples = await core.createExamples();
    const inExample = async () =>
      examples.linkedFolderId === null
        ? []
        : await core.listDocuments({ linkedFolderId: examples.linkedFolderId });
    await vi.waitFor(
      async () => {
        expect((await inExample()).length).toBeGreaterThan(0);
      },
      { timeout: 30_000 },
    );
    const exampleIds = (await inExample()).map((each) => each.id);
    const [own] = await addAndProcess(core, [
      await writeSourceFile(
        await createTempDataFolder(),
        "northwind-notes.txt",
        "Northwind Retail results, in my own words.",
      ),
    ]);
    if (!own) throw new Error("No Document added.");
    const mind = await core.createMind({ title: "Tides" });

    const answer: ConversationAnswer = await askAssistant(core, {
      text: "Move the Northwind papers into Finance",
      mindId: mind.id,
    });
    const library = await core.getLibrary();
    const folder = library.groups.find((each) => each.name === "Finance");
    expect(folder).toBeDefined();
    expect(library.assignments.filter((each) => each.groupId === folder?.id)).toEqual([
      expect.objectContaining({ documentId: own.id }),
    ]);
    expect(library.assignments.filter((each) => exampleIds.includes(each.documentId))).toEqual([]);
    const lastCommand = answer.toolCalls
      .filter((call) => call.source === "commands")
      .at(-1)?.command;
    expect(lastCommand?.items.map((item) => item.id)).toEqual([own.id]);
    core.close();
  });
});
