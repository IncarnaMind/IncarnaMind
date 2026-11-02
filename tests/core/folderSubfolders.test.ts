import { describe, expect, test } from "vitest";
import { InvalidInputError } from "../../src/core";
import type { LibraryGroup, SearchScope } from "../../src/core/api";
import { answerEnded, recordSearches, setUpWithDocuments } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { question, writeMind } from "../helpers/minds";
import { type ModelCall, scriptedModel } from "../helpers/models";

/**
 * Folders inside Folders (#246): a Folder holds Folders, a Mind in a Folder
 * searches the Documents in the ones inside it too, a Folder can't go inside
 * itself, and deleting a Folder takes the Folders inside it as one Recently
 * deleted item that comes back whole.
 */

const FILES = [
  { name: "Harbour.txt", contents: "Harbour tides rise twice a day along the quay.\n" },
  { name: "Moon.txt", contents: "The Moon's pull raises the tides on both sides of the Earth.\n" },
  { name: "Recipes.txt", contents: "Cook mussels at low tides, with garlic and white wine.\n" },
];

/** A model that searches once for tides, then answers without citing. */
function searchingModel() {
  return scriptedModel((call: ModelCall) => {
    if (!call.tools.includes("search_documents")) return { text: "No Tools were offered." };
    if (call.results.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
    }
    return { text: "Here is what your Documents say." };
  });
}

/** Three Documents, and the Folders a test names. */
async function setUp() {
  const { searches, answerSearch } = recordSearches();
  const setup = await setUpWithDocuments(searchingModel(), FILES, { answerSearch });
  const byName = new Map(setup.documents.map((each) => [each.name, each.id]));
  const documentId = (name: string) => {
    const id = byName.get(name);
    if (!id) throw new Error(`No Document named ${name}.`);
    return id;
  };
  const folder = async (name: string, parentId: string | null = null): Promise<LibraryGroup> =>
    setup.core.createLibraryGroup({ name, description: "", parentId });
  return { ...setup, searches, documentId, folder };
}

/** Asks a Question with a Search scope, as the composer sets one, and waits for its Answer. */
async function ask(
  core: Awaited<ReturnType<typeof setUp>>["core"],
  mindId: string,
  scope?: Partial<SearchScope>,
) {
  const client = await connectToMind(core, mindId);
  const asked = question("What do my Documents say about tides?", undefined, scope);
  writeMind(client, [asked]);
  await client.settled();
  const result = await core.askQuestion({ mindId, questionId: asked.attrs.id });
  if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
  const ended = await answerEnded(core, result.answerId);
  if (ended.event !== "finished") throw new Error(JSON.stringify(ended.payload));
}

describe("Folders inside Folders", () => {
  test("a Mind in a Folder searches the Documents in the Folders inside it", async () => {
    const { core, searches, documentId, folder } = await setUp();
    const thesis = await folder("Thesis: urban heat");
    const chapter = await folder("Chapter 2", thesis.id);
    await core.assignDocumentGroup(documentId("Moon"), chapter.id);
    expect((await core.getLibrary()).groups.find((each) => each.id === chapter.id)?.parentId).toBe(
      thesis.id,
    );

    const mind = await core.createMind({ title: "Lit review", folderId: thesis.id });
    await ask(core, mind.id, { folderIds: [thesis.id] });

    expect(searches.at(-1)).toEqual(["Moon"]);
  });

  test("a Folder can go into another, out to the top level, but not into itself or a Folder inside it", async () => {
    const { core, folder } = await setUp();
    const thesis = await folder("Thesis");
    const chapter = await folder("Chapter 2", thesis.id);
    const source = await folder("Sources", chapter.id);
    const parentOf = async (id: string) =>
      (await core.getLibrary()).groups.find((each) => each.id === id)?.parentId ?? null;

    // Into itself, and into one of its own sub-Folders, is refused.
    await expect(
      core.updateLibraryGroup(thesis.id, {
        name: thesis.name,
        description: "",
        parentId: thesis.id,
      }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.updateLibraryGroup(thesis.id, {
        name: thesis.name,
        description: "",
        parentId: source.id,
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(await parentOf(thesis.id)).toBeNull();

    // Out to the top level, and into another Folder, are allowed.
    await core.updateLibraryGroup(chapter.id, {
      name: chapter.name,
      description: "",
      parentId: null,
    });
    expect(await parentOf(chapter.id)).toBeNull();
    await core.updateLibraryGroup(chapter.id, {
      name: chapter.name,
      description: "",
      parentId: thesis.id,
    });
    expect(await parentOf(chapter.id)).toBe(thesis.id);
    expect(await parentOf(source.id)).toBe(chapter.id);
  });

  test("deleting a Folder takes its sub-Folders as one Recently deleted item, and restoring it brings them all back", async () => {
    const { core, documentId, folder } = await setUp();
    const thesis = await folder("Thesis: urban heat");
    const chapter = await folder("Chapter 2", thesis.id);
    const field = await folder("Field data", chapter.id);
    await core.assignDocumentGroup(documentId("Moon"), chapter.id);
    await core.assignDocumentGroup(documentId("Harbour"), field.id);
    const inChapter = await core.createMind({ title: "Chapter notes", folderId: chapter.id });
    const inField = await core.createMind({ title: "Field notes", folderId: field.id });
    const before = await core.getLibrary();

    const deletion = await core.deleteLibraryGroup(thesis.id);
    expect(deletion.assignments.map((each) => each.documentId).sort()).toEqual(
      [documentId("Harbour"), documentId("Moon")].sort(),
    );
    // One item, the Folder that was deleted: the Folders inside it wait as part of it.
    expect((await core.listDeleted()).map((item) => [item.kind, item.name])).toEqual([
      ["folder", "Thesis: urban heat"],
    ]);
    const library = await core.getLibrary();
    expect(library.groups).toEqual([]);
    expect(library.assignments.every((each) => each.groupId === null)).toBe(true);
    expect((await core.listMinds()).every((mind) => mind.folderId === null)).toBe(true);

    await core.restore([{ kind: "folder", id: thesis.id }]);
    const after = await core.getLibrary();
    const byId = new Map(after.groups.map((group) => [group.id, group]));
    expect(byId.get(thesis.id)?.parentId).toBeNull();
    expect(byId.get(chapter.id)?.parentId).toBe(thesis.id);
    expect(byId.get(field.id)?.parentId).toBe(chapter.id);
    const groupOf = (documentId: string) =>
      after.assignments.find((each) => each.documentId === documentId)?.groupId;
    expect(groupOf(documentId("Moon"))).toBe(chapter.id);
    expect(groupOf(documentId("Harbour"))).toBe(field.id);
    const minds = await core.listMinds();
    expect(minds.find((mind) => mind.id === inChapter.id)?.folderId).toBe(chapter.id);
    expect(minds.find((mind) => mind.id === inField.id)?.folderId).toBe(field.id);
    // Restoring it changed the Folders back to what they were.
    expect(after.groups.map((group) => [group.id, group.name, group.parentId]).sort()).toEqual(
      before.groups.map((group) => [group.id, group.name, group.parentId]).sort(),
    );
  });

  test("a sub-Folder deleted on its own waits alone, and restores into the Folder it was in", async () => {
    const { core, folder } = await setUp();
    const thesis = await folder("Thesis");
    const chapter = await folder("Chapter 2", thesis.id);

    await core.deleteLibraryGroup(chapter.id);
    expect((await core.listDeleted()).map((item) => [item.kind, item.name])).toEqual([
      ["folder", "Chapter 2"],
    ]);
    expect((await core.getLibrary()).groups.map((group) => group.id)).toEqual([thesis.id]);

    await core.restore([{ kind: "folder", id: chapter.id }]);
    const restored = (await core.getLibrary()).groups.find((group) => group.id === chapter.id);
    expect(restored?.parentId).toBe(thesis.id);
  });

  test("a wall inside a wall is the inner wall's: the outer wall's Note never reaches it", async () => {
    const { core, searches, documentId, folder } = await setUp();
    const clientA = await folder("Client A");
    const clientB = await folder("Client B");
    await core.updateLibraryGroup(clientA.id, {
      name: clientA.name,
      description: "",
      keepInside: true,
    });
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: "",
      keepInside: true,
    });
    const drafts = await folder("Drafts", clientB.id);
    await core.assignDocumentGroup(documentId("Harbour"), clientA.id);
    await core.assignDocumentGroup(documentId("Moon"), drafts.id);
    // The inner wall moves inside the outer one.
    await core.updateLibraryGroup(clientB.id, {
      name: clientB.name,
      description: "",
      keepInside: true,
      parentId: clientA.id,
    });

    const outer = await core.createMind({ title: "Outer", folderId: clientA.id });
    await ask(core, outer.id);
    expect(searches.at(-1)).toEqual(["Harbour"]);

    const inner = await core.createMind({ title: "Inner", folderId: drafts.id });
    await ask(core, inner.id);
    expect(searches.at(-1)).toEqual(["Moon"]);
  });

  test("two sub-Folders of one wall are one wall's scope, not none", async () => {
    const { core, documentId, folder } = await setUp();
    const client = await folder("Client A");
    await core.updateLibraryGroup(client.id, {
      name: client.name,
      description: "",
      keepInside: true,
    });
    const drafts = await folder("Drafts", client.id);
    const filed = await folder("Filed", client.id);
    await core.assignDocumentGroup(documentId("Harbour"), drafts.id);
    await core.assignDocumentGroup(documentId("Moon"), filed.id);
    expect(
      await core.countScopeDocuments({
        folderIds: [drafts.id, filed.id],
        tagIds: [],
        documentIds: [],
      }),
    ).toBe(2);
  });

  test("moving several Folders keeps a sub-Folder in its parent, and a refused move changes nothing", async () => {
    const { core, folder } = await setUp();
    const thesis = await folder("Thesis");
    const chapter = await folder("Chapter 2", thesis.id);
    const archive = await folder("Archive");

    // Chapter 2 goes with Thesis rather than out of it, as Finder moves a whole tree.
    expect(
      await core.moveLibraryGroups([
        { id: thesis.id, parentId: archive.id },
        { id: chapter.id, parentId: archive.id },
      ]),
    ).toEqual([thesis.id]);
    const groups = (await core.getLibrary()).groups;
    expect(groups.find((group) => group.id === thesis.id)?.parentId).toBe(archive.id);
    expect(groups.find((group) => group.id === chapter.id)?.parentId).toBe(thesis.id);

    // One move that would put a Folder inside itself moves none of them.
    await expect(
      core.moveLibraryGroups([
        { id: archive.id, parentId: null },
        { id: thesis.id, parentId: chapter.id },
      ]),
    ).rejects.toThrow(InvalidInputError);
    const after = (await core.getLibrary()).groups;
    expect(after.find((group) => group.id === archive.id)?.parentId).toBeNull();
    expect(after.find((group) => group.id === thesis.id)?.parentId).toBe(archive.id);
  });

  test("a sub-Folder restored while its parent is still deleted goes to the top level", async () => {
    const { core, folder } = await setUp();
    const thesis = await folder("Thesis");
    const chapter = await folder("Chapter 2", thesis.id);
    await core.deleteLibraryGroup(chapter.id);
    await core.deleteLibraryGroup(thesis.id);

    await core.restore([{ kind: "folder", id: chapter.id }]);
    const restored = (await core.getLibrary()).groups.find((group) => group.id === chapter.id);
    expect(restored?.parentId).toBeNull();
    // Restoring Thesis later does not pull it back inside.
    await core.restore([{ kind: "folder", id: thesis.id }]);
    const after = (await core.getLibrary()).groups.find((group) => group.id === chapter.id);
    expect(after?.parentId).toBeNull();
  });

  test("inside a wall, the assistant files into a sub-Folder of the wall, never outside it", async () => {
    const { core, documentId, folder } = await setUp();
    const client = await folder("Client A");
    await core.updateLibraryGroup(client.id, {
      name: client.name,
      description: "",
      keepInside: true,
    });
    const drafts = await folder("Drafts", client.id);
    const outside = await folder("Outside");
    const document = documentId("Harbour");
    await core.assignDocumentGroup(document, client.id);

    const filed = await core.moveToFolder({
      documentIds: [document],
      folderId: drafts.id,
      wall: client.id,
    });
    expect(filed.folderId).toBe(drafts.id);
    expect(filed.documents.map((item) => item.id)).toEqual([document]);
    expect(
      (await core.getLibrary()).assignments.find((each) => each.documentId === document)?.groupId,
    ).toBe(drafts.id);

    await expect(
      core.moveToFolder({ documentIds: [document], folderId: outside.id, wall: client.id }),
    ).rejects.toThrow(InvalidInputError);
  });

  test("a Folder that keeps its work inside it keeps the Folders inside it inside the wall too", async () => {
    const { core, searches, documentId, folder } = await setUp();
    const finance = await folder("Finance");
    const invoices = await folder("Invoices", finance.id);
    await core.updateLibraryGroup(finance.id, {
      name: finance.name,
      description: "",
      keepInside: true,
    });
    await core.assignDocumentGroup(documentId("Moon"), invoices.id);

    // Outside it, a Mind in no Folder searches the Library but not behind the wall.
    const outside = await core.createMind({ title: "Elsewhere" });
    await ask(core, outside.id);
    expect(searches.at(-1)).toEqual(["Harbour", "Recipes"]);

    // Inside it, a Mind in the sub-Folder searches what the wall holds.
    const inside = await core.createMind({ title: "Payments", folderId: invoices.id });
    await ask(core, inside.id, { folderIds: [invoices.id] });
    expect(searches.at(-1)).toEqual(["Moon"]);
  });
});
