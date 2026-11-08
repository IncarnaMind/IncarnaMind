import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel, proposedFor } from "../helpers/library";
import { scriptedModel } from "../helpers/models";

/** The example Documents the app ships. */
const EXAMPLES = resolve(__dirname, "../../resources/examples");

const FILES = [
  { name: "Lease.txt", contents: "The lease terms run for five years." },
  { name: "Tide.txt", contents: "The tide comes in twice a day." },
  { name: "Suggested.txt", contents: "The suggested wording is concise." },
];

/** Adds the files, each read and searchable. */
async function files(core: Core) {
  const sources = await createTempDataFolder();
  return addAndProcess(
    core,
    await Promise.all(FILES.map((file) => writeSourceFile(sources, file.name, file.contents))),
  );
}

const names = (found: readonly { documentName: string }[]) =>
  found.map((each) => each.documentName);

/** The Document a file made, by its name as the core shows it. */
function named(documents: readonly { id: string; name: string }[], wanted: string) {
  const found = documents.find((document) => document.name === wanted);
  if (!found) throw new Error(`No ${wanted} Document.`);
  return found;
}

describe("a search on this computer keeps to the Folder walls (#1934)", () => {
  test("reads a walled Folder's own work from inside it, and never the work outside", async () => {
    const core = startCore(await createTempDataFolder());
    const documents = await files(core);
    const wall = await core.createLibraryGroup({
      name: "Client work",
      description: "",
      keepInside: true,
    });
    await core.assignDocumentGroup(named(documents, "Lease").id, wall.id);
    const inside = await core.createMind({ title: "Inside", folderId: wall.id });
    const outside = await core.createMind({ title: "Outside" });
    const from = (mindId: string) => ({ kind: "turn" as const, mindId, conversationId: null });

    expect(
      names(await core.searchPassages("lease", { mode: "keyword", place: from(inside.id) })),
    ).toEqual(["Lease"]);
    expect(await core.searchPassages("tide", { mode: "keyword", place: from(inside.id) })).toEqual(
      [],
    );
    expect(
      names(await core.searchPassages("tide", { mode: "keyword", place: from(outside.id) })),
    ).toEqual(["Tide"]);
    expect(
      await core.searchPassages("lease", { mode: "keyword", place: from(outside.id) }),
    ).toEqual([]);
    core.close();
  });

  test("a wall reads its sub-Folders, and a wall inside it stops there", async () => {
    const core = startCore(await createTempDataFolder());
    const documents = await files(core);
    const wall = await core.createLibraryGroup({
      name: "Client work",
      description: "",
      keepInside: true,
    });
    const drafts = await core.createLibraryGroup({
      name: "Drafts",
      description: "",
      parentId: wall.id,
    });
    const nested = await core.createLibraryGroup({
      name: "Nested work",
      description: "",
      parentId: wall.id,
      keepInside: true,
    });
    await core.assignDocumentGroup(named(documents, "Lease").id, wall.id);
    await core.assignDocumentGroup(named(documents, "Suggested").id, drafts.id);
    await core.assignDocumentGroup(named(documents, "Tide").id, nested.id);
    const from = (mindId: string) => ({ kind: "turn" as const, mindId, conversationId: null });
    const at = async (mindId: string, word: string) =>
      names(await core.searchPassages(word, { mode: "keyword", place: from(mindId) }));

    // The outer wall reads its own work and its ordinary sub-Folder's, never the nested wall's.
    const outer = await core.createMind({ title: "Outer", folderId: wall.id });
    expect(await at(outer.id, "lease")).toEqual(["Lease"]);
    expect(await at(outer.id, "suggested")).toEqual(["Suggested"]);
    expect(await at(outer.id, "tide")).toEqual([]);
    // The nested wall reads its own work only.
    const inner = await core.createMind({ title: "Inner", folderId: nested.id });
    expect(await at(inner.id, "tide")).toEqual(["Tide"]);
    expect(await at(inner.id, "lease")).toEqual([]);
    expect(await at(inner.id, "suggested")).toEqual([]);
    // Outside every wall, none of the three is read.
    const outside = await core.createMind({ title: "Outside" });
    expect(await at(outside.id, "lease")).toEqual([]);
    expect(await at(outside.id, "suggested")).toEqual([]);
    expect(await at(outside.id, "tide")).toEqual([]);
    core.close();
  });

  test("does not read Organize's suggestion inside a wall until the User files it there", async () => {
    const dataDir = await createTempDataFolder();
    const fake = classifierModel();
    const core = startCore(dataDir, { createChatModel: () => fake.model });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const documents = await files(core);
    const lease = named(documents, "Lease");
    const suggested = named(documents, "Suggested");
    const wall = await core.createLibraryGroup({
      name: "Client work",
      description: "",
      keepInside: true,
    });
    await core.assignDocumentGroup(lease.id, wall.id);
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: "small-classifier" },
      },
      automatic: false,
    });
    await core.classifyDocuments([suggested.id]);
    await vi.waitFor(async () => expect(await proposedFor(core, suggested.id)).toBe(wall.id));
    const inside = await core.createMind({ title: "Inside", folderId: wall.id });
    const outside = await core.createMind({ title: "Outside" });
    const from = (mindId: string) => ({ kind: "turn" as const, mindId, conversationId: null });

    // Proposed for the wall, it is in no Folder until the User confirms it (#1569): the wall
    // doesn't read it, and work outside every wall does.
    expect(
      await core.searchPassages("suggested", { mode: "keyword", place: from(inside.id) }),
    ).toEqual([]);
    expect(
      names(await core.searchPassages("suggested", { mode: "keyword", place: from(outside.id) })),
    ).toEqual(["Suggested"]);
    expect(
      names(await core.searchPassages("lease", { mode: "keyword", place: from(inside.id) })),
    ).toEqual(["Lease"]);
    core.close();
  });

  test("an asked Question reads its Note while it can, and the Folder recorded with it after", async () => {
    const core = startCore(await createTempDataFolder());
    const documents = await files(core);
    const wall = await core.createLibraryGroup({
      name: "Client work",
      description: "",
      keepInside: true,
    });
    await core.assignDocumentGroup(named(documents, "Lease").id, wall.id);
    const inside = await core.createMind({ title: "Inside", folderId: wall.id });
    const outside = await core.createMind({ title: "Outside" });
    const asked = (mindId: string, folderAskedIn: string, deleted?: true) => ({
      kind: "asked" as const,
      askedFrom: { mindId, ...(deleted && { deleted }) },
      folderAskedIn,
    });
    const at = async (place: ReturnType<typeof asked>, word: string) =>
      names(await core.searchPassages(word, { mode: "keyword", place }));

    // Asked from the Note in the wall, recorded outside it: the Note is read, so only its wall.
    expect(await at(asked(inside.id, ""), "lease")).toEqual(["Lease"]);
    expect(await at(asked(inside.id, ""), "tide")).toEqual([]);

    // Asked from the Note outside, recorded inside: the Note is read, so never the wall.
    expect(await at(asked(outside.id, wall.id), "tide")).toEqual(["Tide"]);
    expect(await at(asked(outside.id, wall.id), "lease")).toEqual([]);

    // Recorded as deleted when it was asked: the Folder recorded with it decides, not the Note now.
    expect(await at(asked(outside.id, wall.id, true), "lease")).toEqual(["Lease"]);
    expect(await at(asked(outside.id, wall.id, true), "tide")).toEqual([]);
    core.close();
  });

  test("reads nothing when an asked Question's Folder wasn't recorded", async () => {
    const core = startCore(await createTempDataFolder());
    await files(core);
    const unknown = { kind: "asked" as const, askedFrom: null };
    expect(await core.searchPassages("tide", { mode: "keyword", place: unknown })).toEqual([]);

    // Recorded as outside every wall, the same words read the Documents outside them.
    expect(
      names(
        await core.searchPassages("tide", {
          mode: "keyword",
          place: { kind: "asked", askedFrom: null, folderAskedIn: "" },
        }),
      ),
    ).toEqual(["Tide"]);
    core.close();
  });

  test("follows the conversation a Question was typed in when no Note is open", async () => {
    const model = scriptedModel(() => ({ text: "Noted." }));
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { createChatModel: () => model });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const documents = await files(core);
    const wall = await core.createLibraryGroup({
      name: "Client work",
      description: "",
      keepInside: true,
    });
    await core.assignDocumentGroup(named(documents, "Lease").id, wall.id);
    const note = await core.createMind({ title: "Inside", folderId: wall.id });
    const asked = await askAssistant(core, { mindId: note.id, text: "What does the lease say?" });
    const conversation = (await core.listConversations()).find(
      (each) => each.id === asked.conversationId,
    );
    expect(conversation?.folderId).toBe(wall.id);
    const place = {
      kind: "turn" as const,
      mindId: null,
      conversationId: asked.conversationId,
    };
    expect(names(await core.searchPassages("lease", { mode: "keyword", place }))).toEqual([
      "Lease",
    ]);
    expect(await core.searchPassages("tide", { mode: "keyword", place })).toEqual([]);
    core.close();
  });

  test("an example's own Note searches every Document, the User's included", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { paths: { dataDir, examples: EXAMPLES } });
    const examples = await core.createExamples();
    if (examples.mindId === null) throw new Error("No example Note.");
    await vi.waitFor(
      async () => {
        expect((await core.listDocuments()).length).toBeGreaterThan(0);
      },
      { timeout: 30_000 },
    );
    const sources = await createTempDataFolder();
    const [own] = await addAndProcess(core, [
      await writeSourceFile(sources, "Own tide.txt", "The tide comes in twice a day."),
    ]);
    if (!own) throw new Error("No own Document.");
    const found = await core.searchPassages("tide", {
      mode: "keyword",
      place: { kind: "turn", mindId: examples.mindId, conversationId: null },
    });
    expect(found.some((passage) => passage.documentId === own.id)).toBe(true);
    core.close();
  });
});
