import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";

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
});
