import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  type Document,
  InvalidInputError,
  type Mind,
  NotFoundError,
  type SearchScope,
} from "../../src/core";
import { migrate, migrations, openDatabase } from "../../src/core/storage";
import { answerEnded, recordSearches, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import type { MindClient } from "../helpers/mindClient";
import { question, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

/**
 * Folders are projects (#111): a Mind belongs to one Folder, or is Not in a
 * Folder. Minds and Documents move between Folders together; a deleted
 * Folder's Minds go to Not in a Folder, and its name is kept for the Search
 * scopes that name it.
 */

const FILES = [
  { name: "Harbour.txt", contents: "Harbour tides rise twice a day along the quay.\n" },
  { name: "Moon.txt", contents: "The Moon's pull raises the tides on both sides of the Earth.\n" },
  { name: "Recipes.txt", contents: "Cook mussels at low tides, with garlic and white wine.\n" },
];

/** A model that searches once for tides, then answers without citing. */
function searchingModel(): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall) => {
    if (!call.tools.includes("search_documents")) return { text: "No Tools were offered." };
    if (call.results.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
    }
    return { text: "Here is what your Documents say." };
  });
}

/** Three Documents and a Mind, in a core whose searches are recorded by the Documents searched. */
async function setUp() {
  const { searches, answerSearch } = recordSearches();
  const setup = await setUpWithDocuments(searchingModel(), FILES, { answerSearch });
  const byName = Object.fromEntries(setup.documents.map((each) => [each.name, each])) as Record<
    string,
    Document
  >;
  const id = (name: string) => (byName[name] as Document).id;
  return { ...setup, searches, id };
}

/** Writes a Question with a Search scope, asks it, and waits for its Answer. */
async function ask(core: Core, client: MindClient, mindId: string, scope: Partial<SearchScope>) {
  const asked = question("What do my Documents say about tides?", undefined, scope);
  writeMind(client, [asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(core, result.answerId);
  if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));
}

/** Each "minds.changed" list from now on. */
function mindsEvents(core: Core): Mind[][] {
  const seen: Mind[][] = [];
  core.on("minds.changed", (minds) => seen.push(minds));
  return seen;
}

describe("A Mind in a Folder", () => {
  test("a Mind is made in a Folder, or in none, and says which", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await core.createLibraryGroup({ name: "Vendor selection", description: "" });

    const inFolder = await core.createMind({ title: "Shortlist", folderId: folder.id });
    const loose = await core.createMind({ title: "Reading list" });

    expect(inFolder.folderId).toBe(folder.id);
    expect(loose.folderId).toBeNull();
    expect((await core.listMinds()).map((mind) => [mind.title, mind.folderId])).toEqual([
      ["Reading list", null],
      ["Shortlist", folder.id],
    ]);
  });

  test("a Mind can't be made in a Folder that doesn't exist: nothing is made", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await core.createLibraryGroup({ name: "Gone", description: "" });
    await core.deleteLibraryGroup(folder.id);

    await expect(core.createMind({ title: "Lost", folderId: folder.id })).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.createMind({ title: "Odd", folderId: 7 as never })).rejects.toThrow(
      InvalidInputError,
    );
    expect(await core.listMinds()).toEqual([]);
  });

  test("Minds and Documents move into a Folder together, and back again to undo", async () => {
    const { core, mind, id } = await setUp();
    const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
    const research = await core.createLibraryGroup({ name: "Research", description: "" });
    await core.assignDocumentGroup(id("Moon"), research.id);
    const filed = (await core.getLibrary()).assignments.find(
      (each) => each.documentId === id("Moon"),
    );
    const changes = mindsEvents(core);
    const assignments: string[][] = [];
    core.on("library.assignments", (changed) =>
      assignments.push(changed.map((each) => each.documentId).sort()),
    );

    const moonNow = (await core.listDocuments()).find((each) => each.id === id("Moon"));
    if (!moonNow) throw new Error("The Document is gone.");
    const move = await core.moveToFolder({
      mindIds: [mind.id],
      documentIds: [id("Moon"), id("Harbour")],
      folderId: finance.id,
    });

    // Where each was, for Undo: its assignment and the Document's own tagging row.
    expect(move).toEqual({
      folderId: finance.id,
      minds: [{ id: mind.id, from: null }],
      documents: [
        {
          id: id("Moon"),
          from: research.id,
          previous: {
            ...filed,
            tagging: { status: moonNow.tagging, error: moonNow.taggingError },
          },
        },
        { id: id("Harbour"), from: null, previous: null },
      ],
      conversations: [],
    });
    expect((await core.listMinds())[0]?.folderId).toBe(finance.id);
    // One event of each, whatever the number moved.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[0]?.folderId).toBe(finance.id);
    expect(assignments).toEqual([[id("Harbour"), id("Moon")].sort()]);
    // A move is the User's choice: Organize keeps it.
    const library = await core.getLibrary();
    const assigned = (documentId: string) =>
      library.assignments.find((each) => each.documentId === documentId);
    expect(assigned(id("Moon"))).toMatchObject({ groupId: finance.id, source: "user" });
    expect(assigned(id("Harbour"))).toMatchObject({ groupId: finance.id, source: "user" });

    // Undo: each back where it was, as it was.
    await core.moveToFolder({ mindIds: [mind.id], folderId: null });
    for (const document of move.documents)
      await core.restoreAssignment(document.id, document.previous);
    expect((await core.listMinds())[0]?.folderId).toBeNull();
    expect((await core.getLibrary()).assignments).toEqual([filed]);
  });

  test("a move with anything unknown moves nothing", async () => {
    const { core, mind, id } = await setUp();
    const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
    const changes = mindsEvents(core);

    await expect(
      core.moveToFolder({
        mindIds: [mind.id],
        documentIds: [id("Moon"), "no-such-document"],
        folderId: finance.id,
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      core.moveToFolder({ mindIds: [mind.id, "no-such-mind"], folderId: finance.id }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      core.moveToFolder({ mindIds: [mind.id], folderId: "no-such-folder" }),
    ).rejects.toThrow(NotFoundError);
    await expect(core.moveToFolder({ mindIds: "all" as never, folderId: null })).rejects.toThrow(
      InvalidInputError,
    );

    expect((await core.listMinds())[0]?.folderId).toBeNull();
    expect((await core.getLibrary()).assignments).toEqual([]);
    expect(changes).toEqual([]);
  });

  test("deleting a Folder moves its Minds and Documents to Not in a Folder, and keeps its name for scopes", async () => {
    const { core, mind, id } = await setUp();
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money" });
    await core.moveToFolder({
      mindIds: [mind.id],
      documentIds: [id("Moon")],
      folderId: finance.id,
    });
    const changes = mindsEvents(core);

    await core.deleteLibraryGroup(finance.id);

    expect((await core.listMinds())[0]?.folderId).toBeNull();
    expect(changes.at(-1)?.[0]?.folderId).toBeNull();
    const library = await core.getLibrary();
    expect(library.groups).toEqual([]);
    expect(library.deletedGroups.map((each) => [each.id, each.name])).toEqual([
      [finance.id, "Finance"],
    ]);
    expect(library.assignments.find((each) => each.documentId === id("Moon"))?.groupId).toBeNull();
    // Nothing can move into it any more.
    await expect(core.moveToFolder({ mindIds: [mind.id], folderId: finance.id })).rejects.toThrow(
      NotFoundError,
    );
  });

  test("a Mind made before Folders held Minds opens Not in a Folder, and can move into one", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 34),
    );
    const at = "2026-10-01T09:00:00.000Z";
    db.run("INSERT INTO minds (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      "e4d3c2b1-a0f9-4e8d-9c7b-6a5f4e3d2c10",
      "Tides",
      at,
      at,
    ]);
    db.close();

    const core = startCore(dataDir);
    expect(await core.listMinds()).toEqual([
      {
        id: "e4d3c2b1-a0f9-4e8d-9c7b-6a5f4e3d2c10",
        title: "Tides",
        autoTitle: "",
        kind: "mind",
        createdAt: at,
        updatedAt: at,
        folderId: null,
      },
    ]);
    const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
    await core.moveToFolder({
      mindIds: ["e4d3c2b1-a0f9-4e8d-9c7b-6a5f4e3d2c10"],
      folderId: folder.id,
    });
    core.close();

    // Kept across a restart.
    const reopened = startCore(dataDir);
    expect((await reopened.listMinds())[0]?.folderId).toBe(folder.id);
  });
});

describe("A Folder's Mind searches its Folder", { timeout: 30_000 }, () => {
  test("its Folder as the Search scope is resolved when asked: Documents filed in join, those filed out leave", async () => {
    const { core, client, mind, searches, id } = await setUp();
    const research = await core.createLibraryGroup({ name: "Research", description: "" });
    await core.moveToFolder({
      mindIds: [mind.id],
      documentIds: [id("Moon")],
      folderId: research.id,
    });

    await ask(core, client, mind.id, { folderIds: [research.id] });
    // Filed in by hand, as Organize would.
    await core.moveToFolder({ documentIds: [id("Harbour")], folderId: research.id });
    await ask(core, client, mind.id, { folderIds: [research.id] });
    // Filed out.
    await core.assignDocumentGroup(id("Moon"), null);
    await ask(core, client, mind.id, { folderIds: [research.id] });

    expect(searches).toEqual([["Moon"], ["Harbour", "Moon"], ["Harbour"]]);
  });

  test("with its Folder taken out of the scope, a Question searches everything", async () => {
    const { core, client, mind, searches, id } = await setUp();
    const research = await core.createLibraryGroup({ name: "Research", description: "" });
    await core.moveToFolder({
      mindIds: [mind.id],
      documentIds: [id("Moon")],
      folderId: research.id,
    });

    await ask(core, client, mind.id, {});

    expect(searches).toEqual([["Harbour", "Moon", "Recipes"]]);
  });

  test("once its Folder is deleted, a Question that named it searches nothing, never everything", async () => {
    const { core, client, mind, searches, id } = await setUp();
    const research = await core.createLibraryGroup({ name: "Research", description: "" });
    await core.moveToFolder({
      mindIds: [mind.id],
      documentIds: [id("Moon")],
      folderId: research.id,
    });
    await core.deleteLibraryGroup(research.id);

    await ask(core, client, mind.id, { folderIds: [research.id] });
    // The Mind is Not in a Folder now: its next Questions search everything.
    await ask(core, client, mind.id, {});

    expect(searches).toEqual([["Harbour", "Moon", "Recipes"]]);
  });
});
