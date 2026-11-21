/**
 * A Folder bound to a folder on disk (ADR-0030, #3507): the folder's files are filed in it as they
 * arrive, as the User's own choice, unless the User filed one themselves; it keeps its work inside
 * it; and an agent given it reaches the files in the folder it works in, hands over from there and
 * has its Notes checked against them. The folder's scan is called directly (its watching is proved
 * in CI); the agent calls through the shim the app ships.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { waitForProcessing } from "../helpers/documents";
import { type Handed, handOver, NORTH, refusal, started, structured } from "../helpers/handedFiles";
import { plainDeck } from "../helpers/pptx";

const PLAN = "# Quay plan\n\nThe east quay holds 31 boats.\n";
const deck = (lines: string[]) => plainDeck([{ title: "Quay review" }, { lines }]);
const NOT_FOUND = translate("en", "agents.handOver.notFound");

/** Where each named Document is filed now, by its name, and as whose choice. */
async function filed(core: Core) {
  const [documents, library] = await Promise.all([core.listDocuments(), core.getLibrary()]);
  const by = new Map(library.assignments.map((each) => [each.documentId, each]));
  return (name: string) => {
    const document = documents.find((each) => each.name === name);
    const assignment = document ? by.get(document.id) : undefined;
    return { groupId: assignment?.groupId ?? null, source: assignment?.source ?? null };
  };
}

/** Every Document's assignment, without how far its tagging has got, which moves on by itself. */
async function placesOf(core: Core) {
  return (await core.getLibrary()).assignments
    .map(({ tagging: _tagging, ...place }) => place)
    .sort((a, b) => a.documentId.localeCompare(b.documentId));
}

/** The Coast Library with its project folder, holding the plan, linked and read. */
async function project() {
  const set = await started();
  await writeFile(join(set.files, "Quay plan.md"), PLAN);
  const linked = await set.core.addLinkedFolder(set.files);
  await set.core.reconcileDocuments();
  await waitForProcessing(
    set.core,
    (await set.core.listDocuments()).map((each) => each.id),
  );
  return { ...set, linked };
}

/** The disk Folder at `relative` in the Linked folder. */
async function diskFolder(core: Core, relative: string) {
  const folder = (await core.listFolders()).find((each) => each.relativePath === relative);
  if (!folder) throw new Error(`No Folder at "${relative}".`);
  return folder;
}

describe("a Folder bound to a folder on disk", () => {
  // protects=binding files the folder's Documents with no filing of their own in the new Folder, as the User's, named after the folder and keeping its work inside it; a Document the User filed elsewhere stays there; binding again gives the same Folder (ADR-0030); fails_when=a filing the User made is moved, or the Folder is open to work outside it
  it("files what is there with no filing of its own; the User's own filing stays", async () => {
    const { core, coast, files, linked } = await project();
    await writeFile(join(files, "Harbour fees.md"), "# Harbour fees\n\nA night costs 40 euros.\n");
    await core.reconcileDocuments();
    const fees = (await core.listDocuments()).find((each) => each.name === "Harbour fees");
    await core.assignDocumentGroup(fees?.id ?? "", coast.id);

    const { folder: bound } = await core.createBoundFolder(linked.folderId);
    expect(bound).toMatchObject({ name: basename(files), keepInside: true });
    const where = await filed(core);
    expect(where("Quay plan")).toEqual({ groupId: bound.id, source: "user" });
    expect(where("Harbour fees")).toEqual({ groupId: coast.id, source: "user" });
    expect((await core.createBoundFolder(linked.folderId)).folder.id).toBe(bound.id);
  });

  // protects=an empty folder made a Project at once, before a scan has made its Folder, files its first file as it arrives; unlinked, it is bound no more (ADR-0030); fails_when=it can't be made a Project until a file is read, or stays bound once unlinked
  it("an empty folder made a Project at once files its first file; unlinked, bound no more", async () => {
    const { core, files } = await started();
    const linked = await core.addLinkedFolder(files);
    const { folder: bound } = await core.createBoundFolder(linked.folderId);
    expect(bound).toMatchObject({ name: basename(files), boundFolderId: linked.folderId });
    await writeFile(join(files, "Quay plan.md"), PLAN);
    await core.reconcileDocuments();
    expect((await filed(core))("Quay plan").groupId).toBe(bound.id);

    await core.removeLinkedFolder(linked.id);
    const after = (await core.getLibrary()).groups.find((each) => each.id === bound.id);
    expect(after?.boundFolderId).toBeNull();
  });

  // protects=a new file in the bound folder is filed in it as it arrives, as the User's choice, so sorting leaves it alone (ADR-0030); fails_when=it lands in Not in a Folder or waits to be sorted
  it("files a new file in it as it arrives", async () => {
    const { core, files, linked } = await project();
    const { folder: bound } = await core.createBoundFolder(linked.folderId);
    await writeFile(join(files, "Quay crew.md"), "# Quay crew\n\nSix people work the east quay.\n");
    await core.reconcileDocuments();
    expect((await filed(core))("Quay crew")).toEqual({ groupId: bound.id, source: "user" });
  });

  // protects=a file moved into a bound folder inside the Linked folder is filed in it when it has no filing of its own; one the User filed elsewhere keeps its Folder (ADR-0030); fails_when=a move undoes the User's filing, or an unfiled file moved in stays in Not in a Folder
  it("files a file moved in, unless the User filed it", async () => {
    const { core, coast, files } = await project();
    await mkdir(join(files, "work"));
    await writeFile(join(files, "work", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    await writeFile(join(files, "Loose notes.md"), "# Loose notes\n\nBoats queue at dawn.\n");
    await writeFile(join(files, "Coast notes.md"), "# Coast notes\n\nThe coast road is shut.\n");
    await core.reconcileDocuments();
    const coastNotes = (await core.listDocuments()).find((each) => each.name === "Coast notes");
    await core.assignDocumentGroup(coastNotes?.id ?? "", coast.id);
    const { folder: work } = await core.createBoundFolder((await diskFolder(core, "work")).id);
    expect((await filed(core))("Quay plan").groupId).toBeNull();

    await rename(join(files, "Loose notes.md"), join(files, "work", "Loose notes.md"));
    await rename(join(files, "Coast notes.md"), join(files, "work", "Coast notes.md"));
    await core.reconcileDocuments();
    const where = await filed(core);
    expect(where("Brief")).toEqual({ groupId: work.id, source: "user" });
    expect(where("Loose notes")).toEqual({ groupId: work.id, source: "user" });
    expect(where("Coast notes")).toEqual({ groupId: coast.id, source: "user" });
  });

  // protects=a folder bound inside a larger bound one takes its own files, old and new; the rest stay the larger one's (ADR-0030); fails_when=a file goes to the outer Folder though a nearer one is bound to its folder
  it("a folder bound inside a bound one takes its own files", async () => {
    const { core, files, linked } = await project();
    await mkdir(join(files, "work"));
    await writeFile(join(files, "work", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    await core.reconcileDocuments();
    const { folder: outer } = await core.createBoundFolder(linked.folderId);
    const { folder: inner } = await core.createBoundFolder((await diskFolder(core, "work")).id);
    expect((await filed(core))("Brief").groupId).toBe(outer.id);

    await writeFile(join(files, "work", "Crew.md"), "# Crew\n\nSix people work the quay.\n");
    await writeFile(join(files, "Fees.md"), "# Fees\n\nA night costs 40 euros.\n");
    await core.reconcileDocuments();
    const where = await filed(core);
    expect(where("Crew").groupId).toBe(inner.id);
    expect(where("Fees").groupId).toBe(outer.id);
  });

  // protects=while the folder is paused nothing arrives; resumed, its new files are filed; unlinked, the Folder keeps its Notes and is bound no more, so the folder linked again files nothing in it (ADR-0030); fails_when=a file arrives while paused, or a Folder stays bound to a folder no longer linked
  it("paused, nothing arrives; unlinked, the Folder stays with its Notes, bound no more", async () => {
    const { core, files, linked } = await project();
    const { folder: bound } = await core.createBoundFolder(linked.folderId);
    await core.setLinkedFolderPaused(linked.id, true);
    await writeFile(join(files, "Late.md"), "# Late\n\nThe ferry was late.\n");
    await core.reconcileDocuments();
    expect((await core.listDocuments()).some((each) => each.name === "Late")).toBe(false);
    await core.setLinkedFolderPaused(linked.id, false);
    await core.reconcileDocuments();
    expect((await filed(core))("Late").groupId).toBe(bound.id);

    const note = await core.createMind({ title: "Quay notes", folderId: bound.id });
    await core.removeLinkedFolder(linked.id);
    expect((await core.getLibrary()).groups.map((each) => each.id)).toContain(bound.id);
    expect((await core.listMinds()).find((each) => each.id === note.id)?.folderId).toBe(bound.id);
    await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    expect((await filed(core))("Late").groupId).toBeNull();
  });

  // protects=Undo of making a Project puts each of the folder's Documents back as it was: one in no Folder with no filing at all has none again, one the User filed elsewhere stays there, one that arrived since has none; done again, they are filed in the same Folder; made again after Undo, it files them (#3507); fails_when=Undo leaves a Document filed in no Folder as the User's choice, which Organize then never proposes a place for and a Project made again never files
  it("Undo puts the folder's Documents back as they were; done again, they are filed again", async () => {
    const set = await started();
    const { core, coast, files } = set;
    // As the app's own spec sets it: sorting by itself off, so the folder's files have no filing.
    await core.saveLibrarySettings({ classifier: null, automatic: false, turnOn: false });
    await writeFile(join(files, "Quay plan.md"), PLAN);
    await writeFile(join(files, "Tide table.md"), "# Tide table\n\nHigh water is at 06:40.\n");
    await writeFile(join(files, "Harbour fees.md"), "# Harbour fees\n\nA night costs 40 euros.\n");
    const linked = await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    await waitForProcessing(
      core,
      (await core.listDocuments()).map((each) => each.id),
    );
    const fees = (await core.listDocuments()).find((each) => each.name === "Harbour fees");
    await core.assignDocumentGroup(fees?.id ?? "", coast.id);
    const before = await placesOf(core);
    expect((await filed(core))("Quay plan")).toEqual({ groupId: null, source: null });

    const made = await core.createBoundFolder(linked.folderId);
    const project = made.folder.id;
    await writeFile(join(files, "Late.md"), "# Late\n\nThe ferry was late.\n");
    await core.reconcileDocuments();
    const inIt = ["Quay plan", "Tide table", "Late"];
    let where = await filed(core);
    expect(inIt.map((name) => where(name).groupId)).toEqual([project, project, project]);
    expect(made.filed).toHaveLength(2);

    await core.undoBoundFolder(project, made.filed);
    expect(await placesOf(core)).toEqual(before);
    expect((await core.getLibrary()).groups.some((each) => each.id === project)).toBe(false);

    // Redo, as the app does it: the Folder restored, then its folder's files filed in it again.
    await core.restore([{ kind: "folder", id: project }]);
    const again = await core.createBoundFolder(linked.folderId);
    expect(again.folder.id).toBe(project);
    where = await filed(core);
    expect(inIt.map((name) => where(name).groupId)).toEqual([project, project, project]);
    expect(where("Harbour fees").groupId).toBe(coast.id);

    await core.undoBoundFolder(project, again.filed);
    expect(await placesOf(core)).toEqual(before);
    const remade = await core.createBoundFolder(linked.folderId);
    where = await filed(core);
    expect(inIt.map((name) => where(name).groupId)).toEqual([
      remade.folder.id,
      remade.folder.id,
      remade.folder.id,
    ]);
  });

  // protects=Undo of making a Project gives a Document Organize had a row for that row back as it was: in no Folder, Organize's, with its state, model and time (#3507); fails_when=Undo leaves it filed by the User, or with no row
  it("Undo gives a Document Organize had read its row back", async () => {
    const { core, linked } = await project();
    const before = await placesOf(core);
    const plan = (await core.listDocuments()).find((each) => each.name === "Quay plan");
    expect(before.find((each) => each.documentId === plan?.id)).toMatchObject({
      groupId: null,
      source: "automatic",
    });

    const made = await core.createBoundFolder(linked.folderId);
    expect((await filed(core))("Quay plan")).toEqual({ groupId: made.folder.id, source: "user" });
    await core.undoBoundFolder(made.folder.id, made.filed);
    expect(await placesOf(core)).toEqual(before);
  });
});

describe("an agent given a bound Folder (#3507)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  /** The project folder bound, and Claude Code given that Folder alone. */
  async function given(options: Parameters<typeof started>[1] = {}) {
    const set = await started([], options);
    await writeFile(join(set.files, "Quay plan.md"), PLAN);
    const linked = await set.core.addLinkedFolder(set.files);
    await set.core.reconcileDocuments();
    await waitForProcessing(
      set.core,
      (await set.core.listDocuments()).map((each) => each.id),
    );
    const { folder: bound } = await set.core.createBoundFolder(linked.folderId);
    await set.core.updateAgent(set.writer.pairing.id, { folderIds: [bound.id] });
    const agent = await connectLegacyAgent(set.writer.launch);
    return { ...set, bound, agent };
  }

  // protects=an agent given only the bound Folder reaches the files in the folder it works in: it finds them, and a file it makes there and hands over is that folder's Document, filed in the Folder, Not cited, its check made there (#3507, #3499); fails_when=the hand-over is refused for lack of reach, or the file is a copy or a source
  it("reaches the folder's files and hands over a file it made there", async () => {
    const { core, files, bound, agent } = await given();
    const found = JSON.stringify(
      structured(await agent.callTool({ name: "search", arguments: { query: "east quay boats" } })),
    );
    expect(found).toContain("Quay plan");

    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck([NORTH]));
    const handed = structured<Handed>(await handOver(agent, { path, folderId: bound.id }));
    expect(handed).toMatchObject({ version: 1, status: "checked" });
    const review = (await core.listDocuments()).filter((each) => each.name === "Quay review");
    expect(review).toEqual([expect.objectContaining({ notCited: true })]);
    expect(review[0]?.linkedFolderId).not.toBeNull();
    expect((await filed(core))("Quay review").groupId).toBe(bound.id);
    const note = (await core.listMinds()).find((each) => each.id === handed.mindId);
    expect(note?.folderId).toBe(bound.id);
  });

  // protects=reach is still the Folder's id, read again after the wait for the file: the User taking the bound Folder back while the agent's file is read refuses the hand-over (#3458, #3507); fails_when=a version is kept after the User took the Folder back
  it("is refused when the User takes the Folder back while the file is read", async () => {
    let takeBack = async () => {};
    const { core, coast, writer, files, bound, agent } = await given({
      reading: () => takeBack(),
    });
    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck([NORTH]));
    takeBack = async () => {
      await core.updateAgent(writer.pairing.id, { folderIds: [coast.id] });
    };
    expect(refusal(await handOver(agent, { path, folderId: bound.id }))).toBe(NOT_FOUND);
    expect((await core.listDocuments()).some((each) => each.name === "Quay review")).toBe(false);
  });
});
