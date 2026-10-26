import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { CitationAttributes, Core, CoreAdapters, Document } from "../../src/core";
import { citationState } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import {
  createTempDataFolder,
  manualClock,
  nextEvent,
  queryDatabase,
  startCore,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  documentAt,
  linkAndProcess,
  writeSourceFile,
} from "../helpers/documents";
import { createControlledEmbedder, turnOnEmbeddings } from "../helpers/embedding";
import { classifierModel } from "../helpers/library";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import { scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";
import { taggingModel, tagNamed, waitForTagging } from "../helpers/tags";

const DAY = 24 * 60 * 60 * 1000;

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const byId = <T extends { id: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));
/** Restoring is a change, so only `updatedAt` may differ from before the delete. */
const withoutTimes = <T extends { id: string; updatedAt: string }>(items: readonly T[]) =>
  byId(items).map((item) => ({ ...item, updatedAt: "" }));

/** A core on a clock that moves only when the test moves it, so each change has its own time. */
async function start(overrides: Partial<CoreAdapters> = {}, dataDir?: string) {
  const clock = manualClock();
  const directory = dataDir ?? (await createTempDataFolder());
  const core = startCore(directory, { now: clock.now, ...overrides });
  return { core, clock, dataDir: directory };
}

async function addText(core: Core, name: string, text: string): Promise<Document> {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), name, text),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

/** A core whose Organize files each Document in the Folder `fake.choose` names, as a suggestion. */
async function startOrganizing() {
  const fake = classifierModel();
  const { core, clock } = await start({ createChatModel: () => fake.model });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
  const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
  const research = await core.createLibraryGroup({ name: "Research", description: "Papers." });
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "classifier" } },
    automatic: false,
  });
  /** Organizes a Document into `folderId` and returns its assignment, a suggestion. */
  const suggest = async (documentId: string, folderId: string) => {
    fake.choose(folderId);
    await core.classifyDocuments([documentId]);
    return vi.waitFor(async () => {
      const assignment = await assignmentOf(core, documentId);
      expect(assignment).toMatchObject({ groupId: folderId, status: "classified" });
      return assignment;
    });
  };
  return { core, clock, finance, research, suggest };
}

const documentOf = async (core: Core, id: string) =>
  (await core.listDocuments()).find((each) => each.id === id);

const assignmentOf = async (core: Core, id: string) =>
  (await core.getLibrary()).assignments.find((each) => each.documentId === id);

describe("Restoring what was deleted", { timeout: 30_000 }, () => {
  test("Minds come back with their content", async () => {
    const { core, clock } = await start();
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [note("Spring tides follow the new moon.")]);
    await client.settled();
    await core.closeMind(mind.id);
    const other = await core.createMind({ title: "Ask about tides" });
    const before = withoutTimes(await core.listMinds());

    clock.advance(1000);
    await core.deleteMind(mind.id);
    clock.advance(1000);
    await core.deleteMind(other.id);
    expect(await core.listMinds()).toEqual([]);
    expect((await core.listDeleted()).map((item) => [item.kind, item.name])).toEqual([
      ["mind", "Ask about tides"],
      ["mind", "Tides"],
    ]);

    const changed = nextEvent(core, "minds.changed");
    clock.advance(1000);
    await core.restore([
      { kind: "mind", id: mind.id },
      { kind: "mind", id: other.id },
    ]);

    expect(ids(byId(await changed))).toEqual(ids(byId([mind, other])));
    expect(withoutTimes(await core.listMinds())).toEqual(before);
    expect(readMind(await connectToMind(core, mind.id)).textContent).toBe(
      "Spring tides follow the new moon.",
    );
    expect(await core.listDeleted()).toEqual([]);
    // Restoring what isn't deleted changes nothing.
    await core.restore([{ kind: "mind", id: mind.id }]);
    expect(withoutTimes(await core.listMinds())).toEqual(before);
  });

  test("a Document added on its own comes back with its text, vectors, Tags and Folder, and its file isn't touched", async () => {
    const embedder = createControlledEmbedder();
    const { core, clock } = await start({ embedder });
    await turnOnEmbeddings(core);
    const path = await writeSourceFile(
      await createSourceFolder(),
      "Tides.md",
      "# Tides\n\nSpring tides follow the new moon and the full moon.\n",
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");
    const paper = await tagNamed(core, "Paper");
    await core.addDocumentTag(document.id, paper.id);
    const ocean = await core.createLibraryGroup({ name: "Ocean", description: "The sea." });
    await core.assignDocumentGroup(document.id, ocean.id);
    const before = { ...(await documentOf(core, document.id)), updatedAt: "" };
    const assignment = await assignmentOf(core, document.id);
    const file = { bytes: await readFile(path), mtimeMs: (await stat(path)).mtimeMs };

    clock.advance(1000);
    await core.deleteDocument(document.id);
    expect(await core.searchPassages("spring tides")).toEqual([]);
    expect(await core.listDeleted()).toEqual([
      {
        kind: "document",
        id: document.id,
        name: "Tides",
        deletedAt: "2026-10-06T09:00:01.000Z",
        documentKind: "markdown",
        groupId: ocean.id,
        linkedFolderId: null,
      },
    ]);

    const status = nextEvent(core, "document.status");
    const assigned = nextEvent(core, "library.assignments");
    const embedded = embedder.texts.length;
    clock.advance(1000);
    await core.restore([{ kind: "document", id: document.id }]);

    expect((await status).id).toBe(document.id);
    expect(await assigned).toEqual([assignment]);
    expect({ ...(await documentOf(core, document.id)), updatedAt: "" }).toEqual(before);
    expect(await assignmentOf(core, document.id)).toEqual(assignment);
    expect(ids(await core.listDocuments({ tagId: paper.id }))).toEqual([document.id]);
    expect((await core.searchPassages("spring tides"))[0]?.documentId).toBe(document.id);
    expect((await core.searchPassages("moon", { mode: "vector" }))[0]?.documentId).toBe(
      document.id,
    );
    // Its vectors were kept: none of its text is embedded again.
    expect(embedder.texts.slice(embedded).some((text) => text.includes("full moon"))).toBe(false);
    expect(await readFile(path)).toEqual(file.bytes);
    expect((await stat(path)).mtimeMs).toBe(file.mtimeMs);
  });

  test("a Document restored outside any Folder comes back with no Organize assignment to wait for (#1433)", async () => {
    const { core, clock } = await start();
    const tides = await addText(core, "Tides.txt", "Spring tides follow the new moon.");
    // A Folder for Organize to file into: without one it claims nothing.
    await core.createLibraryGroup({ name: "Finance", description: "Money." });
    expect(await assignmentOf(core, tides.id)).toBeUndefined();

    clock.advance(1000);
    await core.deleteDocument(tides.id);
    clock.advance(1000);
    await core.restore([{ kind: "document", id: tides.id }]);

    expect(await assignmentOf(core, tides.id)).toBeUndefined();
    expect((await core.getLibrary()).assignments).toEqual([]);
  });

  test("a Document restored outside any Folder has no assignment again, and ones in a Folder or with a suggestion keep theirs whole (#1433)", async () => {
    const fake = classifierModel();
    const { core, clock } = await start({ createChatModel: () => fake.model });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    // Added before any Folder exists, so none is filed or waits.
    const tides = await addText(core, "Tides.txt", "Spring tides follow the new moon.");
    const invoice = await addText(core, "Invoice.txt", "Invoice for the harbour dues.");
    const paper = await addText(core, "Paper.txt", "A paper about tides.");
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    const research = await core.createLibraryGroup({ name: "Research", description: "Papers." });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "classifier" } },
      automatic: true,
    });
    await core.assignDocumentGroup(invoice.id, finance.id);
    fake.choose(research.id);
    await core.classifyDocuments([paper.id]);
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, paper.id)).toMatchObject({
        groupId: research.id,
        source: "automatic",
        suggested: true,
        status: "classified",
      }),
    );
    const before = (await core.getLibrary()).assignments.toSorted((a, b) =>
      a.documentId.localeCompare(b.documentId),
    );
    expect(before).toHaveLength(2);

    clock.advance(1000);
    await core.deleteDocuments([tides.id, invoice.id, paper.id]);
    clock.advance(1000);
    await core.restore([
      { kind: "document", id: tides.id },
      { kind: "document", id: invoice.id },
      { kind: "document", id: paper.id },
    ]);

    expect(
      (await core.getLibrary()).assignments.toSorted((a, b) =>
        a.documentId.localeCompare(b.documentId),
      ),
    ).toEqual(before);
    expect(await assignmentOf(core, tides.id)).toBeUndefined();
  });

  test("a Document embedded again after a restore isn't claimed by Organize (#1433)", async () => {
    const embedder = createControlledEmbedder();
    const { core, clock } = await start({ embedder });
    const tides = await addText(core, "Tides.txt", "Spring tides follow the new moon.");
    await core.createLibraryGroup({ name: "Finance", description: "Money." });
    clock.advance(1000);
    await core.deleteDocument(tides.id);

    // Embeddings come on while it waits, so it is embedded again once it is back.
    await turnOnEmbeddings(core);
    clock.advance(1000);
    await core.restore([{ kind: "document", id: tides.id }]);
    await vi.waitFor(async () => expect((await documentOf(core, tides.id))?.status).toBe("ready"));

    expect((await core.searchPassages("new moon", { mode: "vector" }))[0]?.documentId).toBe(
      tides.id,
    );
    expect(await assignmentOf(core, tides.id)).toBeUndefined();
    expect((await core.getLibrary()).assignments).toEqual([]);
  });

  test("a Document waiting for Organize when it was deleted goes on once it is back (#1433)", async () => {
    const fake = classifierModel();
    const { core, clock } = await start({ createChatModel: () => fake.model });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    // No Organize model yet: the new Document waits for one.
    const invoice = await addText(core, "Invoice.txt", "Invoice for the harbour dues.");
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, invoice.id)).toMatchObject({
        groupId: null,
        status: "waiting",
      }),
    );

    clock.advance(1000);
    await core.deleteDocument(invoice.id);
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "classifier" } },
      automatic: true,
    });

    clock.advance(1000);
    await core.restore([{ kind: "document", id: invoice.id }]);
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, invoice.id)).toMatchObject({
        groupId: finance.id,
        suggested: true,
        status: "classified",
      }),
    );
  });

  test("a Document in a Linked folder comes back, and the next scan keeps it", async () => {
    const { core, clock } = await start();
    const folder = await createSourceFolder();
    await writeSourceFile(folder, "Harbour.txt", "Notes about harbours and their tides.");
    await writeSourceFile(folder, join("Deep", "Trench.txt"), "Notes about the deepest trench.");
    const linked = await linkAndProcess(core, folder);
    const trench = documentAt(linked, join(folder, "Deep", "Trench.txt"));
    const before = withoutTimes(await core.listDocuments());
    const folders = ids(await core.listFolders());

    clock.advance(1000);
    await core.deleteDocument(trench.id);
    await core.reconcileDocuments();
    expect(ids(await core.listDocuments())).not.toContain(trench.id);
    expect((await core.listDeleted())[0]).toMatchObject({
      id: trench.id,
      linkedFolderId: trench.linkedFolderId,
    });

    clock.advance(1000);
    await core.restore([{ kind: "document", id: trench.id }]);
    await core.reconcileDocuments();

    expect(withoutTimes(await core.listDocuments())).toEqual(before);
    expect(ids(await core.listFolders())).toEqual(folders);
  });

  test("a Folder comes back with the Documents its deletion took out, but not one filed since", async () => {
    const { core, clock } = await start();
    const invoice = await addText(core, "Invoice.txt", "Invoice for the harbour dues.");
    const budget = await addText(core, "Budget.txt", "The budget for next year.");
    const paper = await addText(core, "Paper.txt", "A paper about tides.");
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    const research = await core.createLibraryGroup({ name: "Research", description: "Papers." });
    await core.assignDocumentGroup(invoice.id, finance.id);
    await core.assignDocumentGroup(budget.id, finance.id);
    await core.assignDocumentGroup(paper.id, research.id);
    const before = await core.getLibrary();

    clock.advance(1000);
    const deletion = await core.deleteLibraryGroup(finance.id);
    expect(deletion.assignments.map((each) => each.documentId).sort()).toEqual(
      [invoice.id, budget.id].sort(),
    );
    expect(await assignmentOf(core, invoice.id)).toMatchObject({ groupId: null });
    expect((await core.listDeleted()).map((item) => [item.kind, item.name])).toEqual([
      ["folder", "Finance"],
    ]);
    const changed = nextEvent(core, "library.changed");
    clock.advance(1000);
    await core.restore([{ kind: "folder", id: finance.id }]);
    await changed;
    const after = await core.getLibrary();
    expect(withoutTimes(after.groups)).toEqual(withoutTimes(before.groups));
    expect(after.assignments).toEqual(before.assignments);

    clock.advance(1000);
    await core.deleteLibraryGroup(finance.id);
    await core.assignDocumentGroup(budget.id, research.id);
    clock.advance(1000);
    await core.restore([{ kind: "folder", id: finance.id }]);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({ groupId: finance.id });
    expect(await assignmentOf(core, budget.id)).toMatchObject({ groupId: research.id });
  });

  test("a Folder that holds Minds and Documents comes back with all of them in it", async () => {
    const { core, clock } = await start();
    const finance = await core.createLibraryGroup({ name: "Finance", description: "Money." });
    const budget = await addText(core, "Budget.txt", "The budget for next year.");
    const plan = await core.createMind({ title: "Plan", folderId: finance.id });
    const ask = await core.createMind({ title: "Ask", folderId: finance.id });
    const old = await core.createMind({ title: "Old notes", folderId: finance.id });
    await core.moveToFolder({ documentIds: [budget.id], folderId: finance.id });
    const before = {
      minds: withoutTimes(await core.listMinds()),
      assignments: (await core.getLibrary()).assignments,
    };
    clock.advance(1000);
    await core.deleteMind(old.id);

    clock.advance(1000);
    const deletion = await core.deleteLibraryGroup(finance.id);
    expect(deletion.mindIds.sort()).toEqual([plan.id, ask.id].sort());
    expect(deletion.assignments.map((each) => each.documentId)).toEqual([budget.id]);
    expect((await core.listMinds()).map((mind) => mind.folderId)).toEqual([null, null]);
    expect(await assignmentOf(core, budget.id)).toMatchObject({ groupId: null });

    const changed = nextEvent(core, "minds.changed");
    clock.advance(1000);
    await core.restore([
      { kind: "folder", id: finance.id },
      { kind: "mind", id: old.id },
    ]);

    expect(ids(byId(await changed))).toEqual(ids(byId([plan, ask, old])));
    expect(withoutTimes(await core.listMinds())).toEqual(before.minds);
    expect((await core.getLibrary()).assignments).toEqual(before.assignments);
  });

  test("a Folder holding a suggested and a chosen Document gives each back as it was", async () => {
    const { core, clock, finance, suggest } = await startOrganizing();
    const invoice = await addText(core, "Invoice.txt", "Invoice for the harbour dues.");
    const budget = await addText(core, "Budget.txt", "The budget for next year.");
    await suggest(invoice.id, finance.id);
    await core.assignDocumentGroup(budget.id, finance.id);
    const before = (await core.getLibrary()).assignments;
    expect(before.map((each) => [each.documentId, each.source, each.suggested])).toEqual([
      [invoice.id, "automatic", true],
      [budget.id, "user", false],
    ]);

    clock.advance(1000);
    await core.deleteLibraryGroup(finance.id);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({ groupId: null, suggested: false });
    clock.advance(1000);
    await core.restore([{ kind: "folder", id: finance.id }]);

    expect((await core.getLibrary()).assignments).toEqual(before);
    // Still a suggestion: the User can accept it.
    expect(await core.acceptAssignments([invoice.id])).toHaveLength(1);
  });

  test("a Tag comes back with its links", async () => {
    const { core, clock } = await start();
    const a = await addText(core, "A.txt", "Notes about the first harbour.");
    const b = await addText(core, "B.txt", "Notes about the second harbour.");
    const paper = await tagNamed(core, "Paper");
    const report = await tagNamed(core, "Report");
    await core.addTagToDocuments([a.id, b.id], paper.id);
    await core.addDocumentTag(a.id, report.id);
    const before = {
      tags: withoutTimes(await core.listTags()),
      documents: await core.listDocuments(),
    };

    clock.advance(1000);
    await core.deleteTag(paper.id);
    expect((await documentOf(core, a.id))?.tags.map((link) => link.tagId)).toEqual([report.id]);

    const tagsChanged = nextEvent(core, "tags.changed");
    const tagged = nextEvent(core, "documents.tagged");
    clock.advance(1000);
    await core.restore([{ kind: "tag", id: paper.id }]);

    expect(ids(await tagsChanged)).toContain(paper.id);
    expect(ids(byId(await tagged))).toEqual(ids(byId([a, b])));
    expect(withoutTimes(await core.listTags())).toEqual(before.tags);
    expect((await core.listDocuments()).map((each) => each.tags)).toEqual(
      before.documents.map((each) => each.tags),
    );
  });

  test("restoring is all or none, and says why it can't in plain words, as a wording for either language", async () => {
    const { core, clock } = await start();
    const mind = await core.createMind({ title: "Tides" });
    const paper = await tagNamed(core, "Paper");
    clock.advance(1000);
    await core.deleteMind(mind.id);
    await core.deleteTag(paper.id);
    await core.createTag({ name: "paper" });

    const both = [
      { kind: "mind", id: mind.id },
      { kind: "tag", id: paper.id },
    ] as const;
    const refused = await core.restore([...both]).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      message: "There is another Tag named “Paper” now. Rename it, then restore this one.",
      wording: { key: "error.restore.tagNameTaken", values: { name: "Paper" } },
    });
    expect(await core.listMinds()).toEqual([]);
    await core.updateSettings({ user: { language: "zh-CN" } });
    const wording = (refused as { wording: { key: "error.restore.tagNameTaken" } }).wording;
    expect(translate("zh-CN", wording.key, { name: "Paper" })).toBe(
      "已有同名标签“Paper”，请先将其重命名，再恢复。",
    );
    await expect(core.restore([{ kind: "tag", id: "no-such-tag" }])).rejects.toMatchObject({
      message: "That isn’t in Recently deleted.",
      wording: { key: "error.restore.unknown" },
    });
  });
});

describe("Moving back and untagging", { timeout: 30_000 }, () => {
  test("a Document filed automatically and moved by hand goes back to its Folder, still automatic", async () => {
    const { core, finance, research, suggest } = await startOrganizing();
    const invoice = await addText(core, "Invoice.txt", "Invoice for the harbour dues.");
    const filed = await suggest(invoice.id, finance.id);
    expect(filed).toMatchObject({ source: "automatic", suggested: true });

    const previous = await core.assignDocumentGroup(invoice.id, research.id);
    expect(previous).toEqual(filed);
    const assigned = nextEvent(core, "library.assignments");
    await core.restoreAssignment(invoice.id, previous);
    expect(await assigned).toEqual([filed]);
    expect(await assignmentOf(core, invoice.id)).toEqual(filed);

    // The same through a move, as the sidebar's drag and "Move to…" make one.
    const move = await core.moveToFolder({ documentIds: [invoice.id], folderId: research.id });
    expect(move.documents).toEqual([{ id: invoice.id, from: finance.id, previous: filed }]);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({ source: "user" });
    await core.restoreAssignment(invoice.id, move.documents[0]?.previous ?? null);
    expect(await assignmentOf(core, invoice.id)).toEqual(filed);

    // Still automatic: Organize may file it elsewhere.
    expect(await suggest(invoice.id, research.id)).toMatchObject({ source: "automatic" });

    // One that had no assignment has none again.
    const budget = await addText(core, "Budget.txt", "The budget for next year.");
    expect(await core.assignDocumentGroup(budget.id, finance.id)).toBeNull();
    await core.restoreAssignment(budget.id, null);
    expect(await assignmentOf(core, budget.id)).toBeUndefined();
  });

  test("a suggestion moved by hand comes back a suggestion, which the User can still turn down", async () => {
    const { core, finance, research, suggest } = await startOrganizing();
    const invoice = await addText(core, "Invoice.txt", "Invoice for the harbour dues.");
    const suggested = await suggest(invoice.id, finance.id);

    const move = await core.moveToFolder({ documentIds: [invoice.id], folderId: research.id });
    expect(await assignmentOf(core, invoice.id)).toMatchObject({ suggested: false });
    await core.restoreAssignment(invoice.id, move.documents[0]?.previous ?? null);
    expect(await assignmentOf(core, invoice.id)).toEqual(suggested);

    expect(await core.rejectAssignments([invoice.id])).toHaveLength(1);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: null,
      suggested: false,
    });
  });

  test("Tags put back as they were record no removal, so automatic tagging can still add them", async () => {
    const tagging = taggingModel([]);
    const { core } = await start({
      createChatModel: scriptedModels(tagging.model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const document = await addText(core, "Attention.md", "Attention is all you need.");
    await waitForTagging(core, [document.id]);
    const paper = await tagNamed(core, "Paper");

    await core.addTagToDocuments([document.id], paper.id);
    const tagged = nextEvent(core, "documents.tagged");
    const [reverted] = await core.revertDocumentTags([
      { documentId: document.id, tagId: paper.id, link: null },
    ]);
    expect(reverted?.tags).toEqual([]);
    expect(ids(await tagged)).toEqual([document.id]);

    tagging.choose(["Paper"]);
    await core.retagDocuments([document.id]);
    const [automatic] = await waitForTagging(core, [document.id], (each) =>
      each.tags.some((link) => link.tagId === paper.id),
    );
    const link = automatic?.tags[0];
    expect(link).toMatchObject({ tagId: paper.id, source: "automatic" });

    await core.removeTagFromDocuments([document.id], paper.id);
    await core.revertDocumentTags([
      { documentId: document.id, tagId: paper.id, link: link ?? null },
    ]);
    expect((await documentOf(core, document.id))?.tags).toEqual(automatic?.tags);

    // Still automatic, and not the User's: a re-tag takes it off again.
    tagging.choose([]);
    await core.retagDocuments([document.id]);
    await waitForTagging(core, [document.id], (each) => each.tags.length === 0);
  });

  test("restoring a merged Tag undoes the merge: both Tags and their links are as they were", async () => {
    const tagging = taggingModel([]);
    const { core, clock } = await start({
      createChatModel: scriptedModels(tagging.model).createChatModel,
    });
    tagging.choose((request) => (request.text.includes("Attention") ? ["Report"] : []));
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const auto = await addText(core, "Auto.md", "Attention is all you need.");
    const user = await addText(core, "User.txt", "Notes about the user, kept for later.");
    const both = await addText(core, "Both.txt", "Notes about both, kept for later.");
    const removed = await addText(core, "Removed.txt", "Notes about removal, kept.");
    await waitForTagging(core, [auto.id, user.id, both.id, removed.id]);
    const report = await tagNamed(core, "Report");
    const findings = await core.createTag({ name: "Findings", description: "Results" });
    await core.addDocumentTag(removed.id, report.id);
    await core.addDocumentTag(user.id, findings.id);
    await core.addDocumentTag(both.id, findings.id);
    await core.addDocumentTag(both.id, report.id);
    await core.removeDocumentTag(removed.id, report.id);
    const before = {
      tags: withoutTimes(await core.listTags()),
      documents: await core.listDocuments(),
    };

    clock.advance(1000);
    const merge = await core.mergeTags(report.id, findings.id);
    expect(merge.tag).toMatchObject({ id: findings.id, name: "Findings" });
    expect(merge.merged).toMatchObject({ kind: "tag", id: report.id });

    const tagsChanged = nextEvent(core, "tags.changed");
    const tagged = nextEvent(core, "documents.tagged");
    clock.advance(1000);
    await core.restore([merge.merged]);
    expect(ids(await tagsChanged)).toContain(report.id);
    expect(ids(await tagged).length).toBeGreaterThan(0);
    expect(withoutTimes(await core.listTags())).toEqual(before.tags);
    expect((await core.listDocuments()).map((each) => [each.id, each.tags])).toEqual(
      before.documents.map((each) => [each.id, each.tags]),
    );

    // The removal the merge carried over to Findings is gone; the User's of Report stays.
    tagging.choose(["Findings", "Report"]);
    await core.retagDocuments([removed.id]);
    await waitForTagging(core, [removed.id], (each) =>
      each.tags.some((link) => link.tagId === findings.id),
    );
    expect((await documentOf(core, removed.id))?.tags.map((link) => link.tagId)).toEqual([
      findings.id,
    ]);
  });

  test("a merge and a Document deleted after it come back together, whatever the order", async () => {
    const { core, clock } = await start();
    const kept = await addText(core, "Kept.txt", "Notes kept for later.");
    const report = await tagNamed(core, "Report");
    const findings = await core.createTag({ name: "Findings" });
    await core.addDocumentTag(kept.id, report.id);
    const before = (await core.listDocuments()).map((each) => [each.id, each.tags]);

    clock.advance(1000);
    const merge = await core.mergeTags(report.id, findings.id);
    clock.advance(1000);
    await core.deleteDocument(kept.id);
    clock.advance(1000);
    await core.restore([merge.merged, { kind: "document", id: kept.id }]);

    expect((await core.listDocuments()).map((each) => [each.id, each.tags])).toEqual(before);
  });

  test("a merge leaves deleted Documents as they were, so it can be undone and they restored", async () => {
    const { core, clock } = await start();
    const kept = await addText(core, "Kept.txt", "Notes kept for later.");
    const removed = await addText(core, "Removed.txt", "Notes about removal, kept.");
    const carried = await addText(core, "Carried.txt", "Notes carried away.");
    const report = await tagNamed(core, "Report");
    const findings = await core.createTag({ name: "Findings" });
    await core.addTagToDocuments([kept.id, removed.id, carried.id], report.id);
    await core.removeDocumentTag(removed.id, report.id);
    const before = (await core.listDocuments()).map((each) => [each.id, each.tags]);
    clock.advance(1000);
    await core.deleteDocument(removed.id);
    await core.deleteDocument(carried.id);

    clock.advance(1000);
    const merge = await core.mergeTags(report.id, findings.id);
    expect(merge.merged.links?.map((link) => link.documentId)).toEqual([kept.id]);
    clock.advance(1000);
    await core.restore([
      merge.merged,
      { kind: "document", id: removed.id },
      { kind: "document", id: carried.id },
    ]);

    expect((await core.listDocuments()).map((each) => [each.id, each.tags])).toEqual(before);
  });
});

describe("Recently deleted", { timeout: 30_000 }, () => {
  test("lists only the last 30 days' deletions, newest first", async () => {
    const { core, clock } = await start();
    const old = await core.createMind({ title: "Old" });
    await core.deleteMind(old.id);
    clock.advance(20 * DAY);
    const recent = await core.createMind({ title: "Recent" });
    await core.deleteMind(recent.id);
    const tag = await tagNamed(core, "Slides");
    clock.advance(DAY);
    await core.deleteTag(tag.id);
    expect(ids(await core.listDeleted())).toEqual([tag.id, recent.id, old.id]);

    clock.advance(10 * DAY);
    expect(ids(await core.listDeleted())).toEqual([tag.id, recent.id]);
    await expect(core.restore([{ kind: "mind", id: old.id }])).rejects.toThrow(
      "“Old” was deleted more than 30 days ago, so it can’t be restored.",
    );
    await core.restore([{ kind: "mind", id: recent.id }]);
    expect(ids(await core.listMinds())).toEqual([recent.id]);
  });

  test("deleting permanently keeps the tombstone, drops the content and leaves the file", async () => {
    const { core, clock, dataDir } = await start();
    const path = await writeSourceFile(
      await createSourceFolder(),
      "Tides.txt",
      "Spring tides follow the new moon.",
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");
    const bytes = await readFile(path);
    clock.advance(1000);
    await core.deleteDocument(document.id);
    await expect(core.deletePermanently([{ kind: "mind", id: "no-such-mind" }])).rejects.toThrow(
      "That isn’t in Recently deleted.",
    );
    const mind = await core.createMind({ title: "Kept" });
    await expect(core.deletePermanently([{ kind: "mind", id: mind.id }])).rejects.toThrow(
      "“Kept” isn’t deleted, so it can’t be deleted permanently.",
    );

    clock.advance(1000);
    await core.deletePermanently([{ kind: "document", id: document.id }]);

    expect(
      queryDatabase(dataDir, "SELECT id, deleted_at, purged_at FROM documents WHERE id = ?", [
        document.id,
      ]),
    ).toEqual([
      {
        id: document.id,
        deleted_at: "2026-10-06T09:00:01.000Z",
        purged_at: "2026-10-06T09:00:02.000Z",
      },
    ]);
    for (const table of ["passages", "document_pages", "document_tags"]) {
      expect(
        queryDatabase(dataDir, `SELECT 1 FROM ${table} WHERE document_id = ?`, [document.id]),
      ).toEqual([]);
    }
    expect(await core.listDeleted()).toEqual([]);
    await expect(core.restore([{ kind: "document", id: document.id }])).rejects.toThrow(
      "“Tides” was deleted permanently, so it can’t be restored.",
    );
    expect(await readFile(path)).toEqual(bytes);
  });

  test("the start-up purge drops the content of what was deleted more than 30 days ago", async () => {
    const { core, clock, dataDir } = await start();
    const old = await core.createMind({ title: "Old" });
    const client = await connectToMind(core, old.id);
    writeMind(client, [note("Neap tides come at the quarter moons.")]);
    await client.settled();
    await core.closeMind(old.id);
    await core.deleteMind(old.id);
    clock.advance(25 * DAY);
    const recent = await core.createMind({ title: "Recent" });
    await core.deleteMind(recent.id);
    core.close();

    clock.advance(6 * DAY);
    const reopened = startCore(dataDir, { now: clock.now });
    expect(
      queryDatabase<{ id: string; purged: number }>(
        dataDir,
        "SELECT id, purged_at IS NOT NULL AS purged FROM minds ORDER BY created_at",
      ),
    ).toEqual([
      { id: old.id, purged: 1 },
      { id: recent.id, purged: 0 },
    ]);
    expect(
      queryDatabase(dataDir, "SELECT 1 FROM mind_updates WHERE mind_id = ?", [old.id]),
    ).toEqual([]);
    await expect(reopened.restore([{ kind: "mind", id: old.id }])).rejects.toThrow(
      "“Old” was deleted permanently, so it can’t be restored.",
    );
    await reopened.restore([{ kind: "mind", id: recent.id }]);
    expect(ids(await reopened.listMinds())).toEqual([recent.id]);
  });
});

describe("Deleting permanently keeps the text Citations quote", { timeout: 30_000 }, () => {
  const SPRING = "Spring tides happen at new moon and at full moon.";
  const TIDES = buildPdf([
    { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
    { lines: ["Spring and neap tides", SPRING] },
    { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
  ]);

  /** A Document whose page 2 a Note in a closed Mind cites, and the Document deleted. */
  async function citedThenDeleted() {
    const { core, clock, dataDir } = await start();
    const path = await writeSourceFile(await createSourceFolder(), "Tides.pdf", TIDES);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");
    const mind = await core.createMind({ title: "Reading notes" });
    const client = await connectToMind(core, mind.id);
    const cited = note("Spring tides");
    const citation: CitationAttributes = {
      passageId: "passage",
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      pageFrom: 2,
      pageTo: 2,
      location: null,
      quote: SPRING,
      check: "found",
      checkReason: null,
    };
    cited.content?.push({ type: "citation", attrs: citation });
    writeMind(client, [cited]);
    await client.settled();
    await core.closeMind(mind.id);
    clock.advance(1000);
    await core.deleteDocument(document.id);
    return { core, clock, dataDir, document, mind, path, citation };
  }

  const pagesOf = (dataDir: string, documentId: string) =>
    queryDatabase<{ page: number; live: number }>(
      dataDir,
      "SELECT page, deleted_at IS NULL AS live FROM document_pages WHERE document_id = ? ORDER BY page",
      [documentId],
    );

  test("by the User: the cited page stays and the Citation can still be checked; the file stays too", async () => {
    const { core, dataDir, document, path, citation } = await citedThenDeleted();
    const bytes = await readFile(path);
    const kept = nextEvent(core, "keptCitationTexts.changed");

    await core.deletePermanently([{ kind: "document", id: document.id }]);

    expect(await kept).toEqual([
      { documentId: document.id, contentHash: document.contentHash, units: [2] },
    ]);
    expect(pagesOf(dataDir, document.id)).toEqual([{ page: 2, live: 1 }]);
    expect(await core.listDeleted()).toEqual([]);
    expect(
      citationState(citation, await core.listDocuments(), await core.listKeptCitationTexts()),
    ).toMatchObject({ check: "found" });
    expect(await readFile(path)).toEqual(bytes);
  });

  test("by the 30 days: the same, at the next start", async () => {
    const { core, clock, dataDir, document } = await citedThenDeleted();
    core.close();
    clock.advance(31 * DAY);

    const reopened = startCore(dataDir, { now: clock.now });

    expect(pagesOf(dataDir, document.id)).toEqual([{ page: 2, live: 1 }]);
    expect(await reopened.listKeptCitationTexts()).toEqual([
      { documentId: document.id, contentHash: document.contentHash, units: [2] },
    ]);
    expect(queryDatabase(dataDir, "SELECT purged_at IS NOT NULL AS purged FROM documents")).toEqual(
      [{ purged: 1 }],
    );
  });

  test("by the User while the Mind that cites it waits in Recently deleted: the cited page stays, and the restored Mind's Citation can still be checked", async () => {
    const { core, clock, dataDir, document, mind, citation } = await citedThenDeleted();
    // Deleted after the Document: it waits in Recently deleted when the Document goes for good.
    clock.advance(1000);
    await core.deleteMind(mind.id);

    await core.deletePermanently([{ kind: "document", id: document.id }]);

    expect(pagesOf(dataDir, document.id)).toEqual([{ page: 2, live: 1 }]);
    await core.restore([{ kind: "mind", id: mind.id }]);
    expect(
      citationState(citation, await core.listDocuments(), await core.listKeptCitationTexts()),
    ).toMatchObject({ check: "found" });
  });

  test("by the 30 days while the Mind that cites it still waits: the same, at the next start", async () => {
    const { core, clock, dataDir, document, mind } = await citedThenDeleted();
    clock.advance(20 * DAY);
    await core.deleteMind(mind.id);
    core.close();
    clock.advance(11 * DAY);

    const reopened = startCore(dataDir, { now: clock.now });

    expect(pagesOf(dataDir, document.id)).toEqual([{ page: 2, live: 1 }]);
    expect(await reopened.listKeptCitationTexts()).toEqual([
      { documentId: document.id, contentHash: document.contentHash, units: [2] },
    ]);
  });

  test("one the Mind cites loses its text once the Mind is deleted permanently too", async () => {
    const { core, dataDir, document, mind } = await citedThenDeleted();
    await core.deleteMind(mind.id);
    await core.deletePermanently([{ kind: "mind", id: mind.id }]);

    await core.deletePermanently([{ kind: "document", id: document.id }]);

    expect(pagesOf(dataDir, document.id)).toEqual([]);
    expect(await core.listKeptCitationTexts()).toEqual([]);
  });

  test("one nothing cites loses all its text", async () => {
    const { core, dataDir } = await start();
    const path = await writeSourceFile(await createSourceFolder(), "Tides.pdf", TIDES);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("Nothing was added.");
    await core.deleteDocument(document.id);
    await core.deletePermanently([{ kind: "document", id: document.id }]);
    expect(pagesOf(dataDir, document.id)).toEqual([]);
    expect(await core.listKeptCitationTexts()).toEqual([]);
  });
});
