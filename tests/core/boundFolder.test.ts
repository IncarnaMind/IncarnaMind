/**
 * A Folder bound to a folder on disk (ADR-0030, #3507, #3613): linking a folder makes one at once,
 * open to work outside it; the folder's files are filed in it as they arrive, as the User's own
 * choice, unless the User filed one themselves; turning that off, and Undo of each step, puts each
 * file back as it was; a folder linked before is bound by a migration; and an agent given it
 * reaches the files in the folder it works in. The folder's scan is called directly (its watching
 * is proved in CI); the agent calls through the shim the app ships.
 */
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AddedLinkedFolder,
  type Core,
  DATABASE_FILE,
  NOT_IN_A_FOLDER_ID,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import {
  createSourceFolder,
  linkWithoutFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
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

/** The Folder linking made; throws when it made none. */
function boundOf(linked: AddedLinkedFolder) {
  if (!linked.bound) throw new Error("Linking made no Folder.");
  return linked.bound;
}

/** Every file in the folder read to the end. */
async function processed(core: Core) {
  await core.reconcileDocuments();
  await waitForProcessing(
    core,
    (await core.listDocuments()).map((each) => each.id),
  );
}

/** The Coast Library with its project folder, holding the plan, linked and read: its Folder made by linking. */
async function project() {
  const set = await started();
  await writeFile(join(set.files, "Quay plan.md"), PLAN);
  const linked = await set.core.addLinkedFolder(set.files);
  await processed(set.core);
  return { ...set, linked, bound: boundOf(linked).folder };
}

/**
 * The project folder linked, its filing as one Folder turned off at once, with sorting by itself
 * off: the plan and the tide table with no filing at all, the harbour fees filed in Coast by the
 * User. `before` is every Document's place then.
 */
async function unsorted() {
  const set = await started();
  const { core, coast, files } = set;
  await core.saveLibrarySettings({ classifier: null, automatic: false, turnOn: false });
  const linked = await core.addLinkedFolder(files);
  const off = await core.unbindFolder(boundOf(linked).folder.id, boundOf(linked).filed);
  await writeFile(join(files, "Quay plan.md"), PLAN);
  await writeFile(join(files, "Tide table.md"), "# Tide table\n\nHigh water is at 06:40.\n");
  await writeFile(join(files, "Harbour fees.md"), "# Harbour fees\n\nA night costs 40 euros.\n");
  await processed(core);
  const fees = (await core.listDocuments()).find((each) => each.name === "Harbour fees");
  await core.assignDocumentGroup(fees?.id ?? "", coast.id);
  const where = await filed(core);
  expect([where("Quay plan"), where("Tide table")]).toEqual([
    { groupId: null, source: null },
    { groupId: null, source: null },
  ]);
  return { ...set, linked, off, before: await placesOf(core) };
}

/** A file written into the project folder and read. */
async function arrives(core: Core, files: string, name: string) {
  await writeFile(join(files, `${name}.md`), `# ${name}\n\nThe ferry was late.\n`);
  await core.reconcileDocuments();
}

/** The disk Folder at `relative` in the Linked folder. */
async function diskFolder(core: Core, relative: string) {
  const folder = (await core.listFolders()).find((each) => each.relativePath === relative);
  if (!folder) throw new Error(`No Folder at "${relative}".`);
  return folder;
}

const live = async (core: Core, id: string) =>
  (await core.getLibrary()).groups.some((each) => each.id === id);
const inRecentlyDeleted = async (core: Core, id: string) =>
  (await core.listDeleted()).some((each) => each.id === id);

describe("linking a folder makes a Folder bound to it (#3613)", () => {
  // protects=linking makes a Folder at once, named after the folder, bound to it and open to work outside it, and the folder's files are filed in it as they arrive, as the User's (#3613); fails_when=the files land in Not in a Folder, the Folder needs a menu step, or it keeps its work inside it unasked
  it("makes a Folder named after it, open to work outside it, and files its files in it", async () => {
    const { core, files, linked, bound } = await project();
    expect(bound).toMatchObject({
      name: basename(files),
      boundFolderId: linked.folderId,
      keepInside: false,
      parentId: null,
    });
    expect((await filed(core))("Quay plan")).toEqual({ groupId: bound.id, source: "user" });
    await arrives(core, files, "Late");
    expect((await filed(core))("Late")).toEqual({ groupId: bound.id, source: "user" });
  });

  // protects=a folder dropped on a Folder gets its Folder inside that one, and a name a Folder beside it has takes the next number (#3613); fails_when=its files are filed straight into the Folder dropped on, or linking fails on a name taken
  it("dropped on a Folder, its Folder is made inside it, under a free name", async () => {
    const { core, coast, files } = await started();
    await core.createLibraryGroup({ name: basename(files), description: "", parentId: coast.id });
    await writeFile(join(files, "Quay plan.md"), PLAN);
    const linked = await core.addLinkedFolder(files, { groupId: coast.id });
    await processed(core);
    const { folder } = boundOf(linked);
    expect(folder).toMatchObject({ name: `${basename(files)} 2`, parentId: coast.id });
    expect((await filed(core))("Quay plan").groupId).toBe(folder.id);
  });

  // protects=a folder inside one linked already adds no Folder: its files are already in that one's (#3613); fails_when=a second Folder is made for the same files
  it("a folder inside one linked already makes no Folder", async () => {
    const { core, files, bound } = await project();
    await mkdir(join(files, "work"));
    const inner = await core.addLinkedFolder(join(files, "work"));
    expect(inner.bound).toBeNull();
    expect((await core.getLibrary()).groups.filter((each) => each.boundFolderId)).toEqual([
      expect.objectContaining({ id: bound.id }),
    ]);
  });

  // protects=a folder linked around a linked one keeps that one's Folder bound to the same folder, inside the new Folder, its files and filings as they were, and new files go to the nearest Folder (#3613); fails_when=the merged Folder is no longer bound, its files move to the new Folder, or it stays at the top level
  it("a folder linked around a linked one nests that one's Folder, still bound", async () => {
    const { core, files } = await started();
    await mkdir(join(files, "work"));
    await writeFile(join(files, "work", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    const first = await core.addLinkedFolder(join(files, "work"));
    await processed(core);
    const work = boundOf(first).folder;
    expect((await filed(core))("Brief").groupId).toBe(work.id);

    await writeFile(join(files, "Quay plan.md"), PLAN);
    const outer = await core.addLinkedFolder(files);
    await processed(core);
    const outside = boundOf(outer).folder;
    expect(outer.merged).toEqual([{ path: join(files, "work"), groupId: work.id, parentId: null }]);
    const nested = (await core.getLibrary()).groups.find((each) => each.id === work.id);
    expect(nested).toMatchObject({
      parentId: outside.id,
      boundFolderId: (await diskFolder(core, "work")).id,
    });
    expect((await filed(core))("Brief").groupId).toBe(work.id);
    expect((await filed(core))("Quay plan").groupId).toBe(outside.id);
    await writeFile(join(files, "work", "Crew.md"), "# Crew\n\nSix people work the quay.\n");
    await core.reconcileDocuments();
    expect((await filed(core))("Crew").groupId).toBe(work.id);
  });

  // protects=files added onto a Folder linking made, and onto it once its filing is off and it stays, are filed in it, so a connection not given that Folder doesn't read them (#3613); fails_when=they land in Not in a Folder
  it("files added onto its Folder are filed there, also once its filing is off", async () => {
    const { core, bound } = await project();
    const sources = await createSourceFolder();
    const notes = await writeSourceFile(sources, "Harbour notes.md", "# Harbour notes\n\nBoats.\n");
    await core.addDocuments([notes], { groupId: bound.id });
    expect((await filed(core))("Harbour notes")).toEqual({ groupId: bound.id, source: "user" });

    await core.createMind({ title: "Quay notes", folderId: bound.id });
    await core.unbindFolder(bound.id, []);
    const log = await writeSourceFile(sources, "Harbour log.md", "# Harbour log\n\nThe tide.\n");
    await core.addDocuments([log], { groupId: bound.id });
    expect((await filed(core))("Harbour log")).toEqual({ groupId: bound.id, source: "user" });
  });

  // protects=linking is never refused for the limit on Folders, and a folder name with a space at its end takes a free name: the link and its Folder are made together (#3613); fails_when=the folder is linked with no Folder and no Undo
  it("links past the limit on Folders, and under a free name when its name ends in a space", async () => {
    const { core, files } = await started();
    await core.createLibraryGroup({ name: "Notes", description: "" });
    for (let n = (await core.getLibrary()).groups.length; n < 100; n++) {
      await core.createLibraryGroup({ name: `Folder ${n}`, description: "" });
    }
    const spaced = join(files, "Notes ");
    await mkdir(spaced);
    const linked = await core.addLinkedFolder(spaced);
    expect(boundOf(linked).folder.name).toBe("Notes 2");
    expect((await core.getLibrary()).groups).toHaveLength(101);
  });

  // protects=folders linked one around another twice keep each Folder bound to its own folder, so the innermost's new files go to its Folder (#3613); fails_when=the innermost Folder is bound to a folder gone, and its files go to the one around it
  it("linked around twice, the innermost Folder stays bound to its folder", async () => {
    const { core, files } = await started();
    await mkdir(join(files, "b", "c"), { recursive: true });
    await writeFile(join(files, "b", "c", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    await writeFile(join(files, "b", "Budget.md"), "# Budget\n\nThe quay costs 40.\n");
    const c = boundOf(await core.addLinkedFolder(join(files, "b", "c"))).folder;
    await processed(core);
    boundOf(await core.addLinkedFolder(join(files, "b")));
    await processed(core);
    boundOf(await core.addLinkedFolder(files));
    await processed(core);
    expect((await core.getLibrary()).groups.find((each) => each.id === c.id)?.boundFolderId).toBe(
      (await diskFolder(core, "b/c")).id,
    );
    await writeFile(join(files, "b", "c", "Crew.md"), "# Crew\n\nSix people.\n");
    await core.reconcileDocuments();
    expect((await filed(core))("Crew").groupId).toBe(c.id);
  });

  // protects=a bound Folder restored from Recently deleted while another Folder is bound to its folder comes back plain, so one Folder is bound to a folder (#3613); fails_when=two Folders are bound to one folder
  it("restored while another is bound to its folder, it comes back plain", async () => {
    const { core, linked, bound } = await project();
    await core.deleteLibraryGroup(bound.id);
    const again = await core.createBoundFolder(linked.folderId);
    await core.updateLibraryGroup(again.folder.id, { name: "Quay works", description: "" });
    await core.restore([{ kind: "folder", id: bound.id }]);
    const groups = (await core.getLibrary()).groups;
    expect(groups.find((each) => each.id === bound.id)?.boundFolderId).toBeNull();
    expect(groups.find((each) => each.id === again.folder.id)?.boundFolderId).toBe(linked.folderId);
  });

  // protects=removing a Document of a linked folder takes it out of IncarnaMind and leaves its file where it is (ADR-0010, #3613); fails_when=the file is deleted or moved
  it("removing a Document there leaves its file", async () => {
    const { core, files } = await project();
    const plan = (await core.listDocuments()).find((each) => each.name === "Quay plan");
    await core.deleteDocuments([plan?.id ?? ""]);
    expect((await core.listDocuments()).some((each) => each.name === "Quay plan")).toBe(false);
    await expect(access(join(files, "Quay plan.md"))).resolves.toBeUndefined();
  });
});

describe("a Folder bound to a folder on disk", () => {
  // protects=a new file in the bound folder is filed in it as it arrives, as the User's choice, so sorting leaves it alone; one the User filed elsewhere stays there (ADR-0030); fails_when=it lands in Not in a Folder or waits to be sorted, or a filing the User made is moved
  it("files a new file in it as it arrives; the User's own filing stays", async () => {
    const { core, coast, files, bound } = await project();
    await writeFile(join(files, "Harbour fees.md"), "# Harbour fees\n\nA night costs 40 euros.\n");
    await core.reconcileDocuments();
    const fees = (await core.listDocuments()).find((each) => each.name === "Harbour fees");
    await core.assignDocumentGroup(fees?.id ?? "", coast.id);
    await writeFile(join(files, "Quay crew.md"), "# Quay crew\n\nSix people work the east quay.\n");
    await core.reconcileDocuments();
    const where = await filed(core);
    expect(where("Quay crew")).toEqual({ groupId: bound.id, source: "user" });
    expect(where("Harbour fees")).toEqual({ groupId: coast.id, source: "user" });
  });

  // protects=a file moved into a bound folder inside the Linked folder is filed in it when it has no filing of its own; one the User filed elsewhere keeps its Folder (ADR-0030); fails_when=a move undoes the User's filing, or an unfiled file moved in stays in the outer Folder
  it("files a file moved in, unless the User filed it", async () => {
    const { core, coast, files } = await started();
    const off = boundOf(await core.addLinkedFolder(files));
    await core.unbindFolder(off.folder.id, off.filed);
    await mkdir(join(files, "work"));
    await writeFile(join(files, "work", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    await writeFile(join(files, "Loose notes.md"), "# Loose notes\n\nBoats queue at dawn.\n");
    await writeFile(join(files, "Coast notes.md"), "# Coast notes\n\nThe coast road is shut.\n");
    await processed(core);
    const coastNotes = (await core.listDocuments()).find((each) => each.name === "Coast notes");
    await core.assignDocumentGroup(coastNotes?.id ?? "", coast.id);
    const { folder: work } = await core.createBoundFolder((await diskFolder(core, "work")).id);
    expect((await filed(core))("Loose notes").groupId).toBeNull();

    await rename(join(files, "Loose notes.md"), join(files, "work", "Loose notes.md"));
    await rename(join(files, "Coast notes.md"), join(files, "work", "Coast notes.md"));
    await core.reconcileDocuments();
    const where = await filed(core);
    expect(where("Brief")).toEqual({ groupId: work.id, source: "user" });
    expect(where("Loose notes")).toEqual({ groupId: work.id, source: "user" });
    expect(where("Coast notes")).toEqual({ groupId: coast.id, source: "user" });
  });

  // protects=a folder bound inside a larger bound one takes its own new files; the rest stay the larger one's (ADR-0030); fails_when=a file goes to the outer Folder though a nearer one is bound to its folder
  it("a folder bound inside a bound one takes its own files", async () => {
    const { core, files, bound: outer } = await project();
    await mkdir(join(files, "work"));
    await writeFile(join(files, "work", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    await core.reconcileDocuments();
    const { folder: inner } = await core.createBoundFolder((await diskFolder(core, "work")).id);
    expect((await filed(core))("Brief").groupId).toBe(outer.id);

    await writeFile(join(files, "work", "Crew.md"), "# Crew\n\nSix people work the quay.\n");
    await writeFile(join(files, "Fees.md"), "# Fees\n\nA night costs 40 euros.\n");
    await core.reconcileDocuments();
    const where = await filed(core);
    expect(where("Crew").groupId).toBe(inner.id);
    expect(where("Fees").groupId).toBe(outer.id);
  });

  // protects=while the folder is paused nothing arrives; resumed, its new files are filed; unlinked, a Folder holding a Note stays with it, bound no more, so the folder linked again gets a Folder of its own (ADR-0030, #3613); fails_when=a file arrives while paused, a Folder stays bound to a folder no longer linked, or the User's Note goes with it
  it("paused, nothing arrives; unlinked, a Folder with a Note stays, bound no more", async () => {
    const { core, files, linked, bound } = await project();
    await core.setLinkedFolderPaused(linked.id, true);
    await writeFile(join(files, "Late.md"), "# Late\n\nThe ferry was late.\n");
    await core.reconcileDocuments();
    expect((await core.listDocuments()).some((each) => each.name === "Late")).toBe(false);
    await core.setLinkedFolderPaused(linked.id, false);
    await core.reconcileDocuments();
    expect((await filed(core))("Late").groupId).toBe(bound.id);

    const note = await core.createMind({ title: "Quay notes", folderId: bound.id });
    await core.removeLinkedFolder(linked.id);
    const kept = (await core.getLibrary()).groups.find((each) => each.id === bound.id);
    expect(kept?.boundFolderId).toBeNull();
    expect((await core.listMinds()).find((each) => each.id === note.id)?.folderId).toBe(bound.id);
    const again = boundOf(await core.addLinkedFolder(files));
    await core.reconcileDocuments();
    expect(again.folder.id).not.toBe(bound.id);
    expect((await filed(core))("Late").groupId).toBe(again.folder.id);
  });

  // protects=unlinked, a Folder that held only the folder's files goes, and not to Recently deleted; linked again into it, as Undo does, the same Folder comes back with its files (#3613); fails_when=an empty Folder stays behind, shows in Recently deleted though the User deleted nothing, or Undo makes another Folder
  it("unlinked, a Folder that held only the folder's files goes, not to Recently deleted", async () => {
    const { core, files, linked, bound } = await project();
    await core.removeLinkedFolder(linked.id);
    expect(await live(core, bound.id)).toBe(false);
    expect(await inRecentlyDeleted(core, bound.id)).toBe(false);

    const again = await core.addLinkedFolder(files, { rebind: bound.id });
    expect(boundOf(again).folder.id).toBe(bound.id);
    await processed(core);
    expect((await filed(core))("Quay plan")).toEqual({ groupId: bound.id, source: "user" });
  });
});

describe("filing as one Folder, turned off and on (#3613)", () => {
  // protects=a Folder its filing took away quietly is purged with the rest after 30 days and never comes back to life: turned on after that, a new Folder is made (#3613); fails_when=the purged Folder is brought back
  it("on again after the Folder was purged, a new Folder is made", async () => {
    const set = await project();
    const off = await set.core.unbindFolder(set.bound.id, []);
    await set.core.close();
    const db = openDatabase(join(set.dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE library_groups SET purged_at = deleted_at WHERE id = ?", [set.bound.id]);
    } finally {
      db.close();
    }
    const core = await set.restart();
    const on = await core.rebindFolder(off);
    expect(on.folder.id).not.toBe(set.bound.id);
    expect(await live(core, set.bound.id)).toBe(false);
    expect((await filed(core))("Quay plan")).toEqual({ groupId: on.folder.id, source: "user" });
  });

  // protects=turned off, the folder's files go back to no filing, not to Not in a Folder as the User's choice, so Organize may place them; the Folder that held nothing else goes, not to Recently deleted; on again, the same Folder comes back with them, and a file the User filed elsewhere stays (#3613); fails_when=the files stay filed, the Folder lands in Recently deleted, or turning it on makes another Folder
  it("off, the files go back to no filing and the empty Folder goes quietly; on, the same Folder", async () => {
    const { core, coast, files, bound } = await project();
    await writeFile(join(files, "Harbour fees.md"), "# Harbour fees\n\nA night costs 40 euros.\n");
    await core.reconcileDocuments();
    const fees = (await core.listDocuments()).find((each) => each.name === "Harbour fees");
    await core.assignDocumentGroup(fees?.id ?? "", coast.id);

    const off = await core.unbindFolder(bound.id, []);
    expect(off).toEqual({
      groupId: bound.id,
      boundFolderId: bound.boundFolderId,
      removed: true,
      refiled: [],
    });
    expect(await live(core, bound.id)).toBe(false);
    expect(await inRecentlyDeleted(core, bound.id)).toBe(false);
    let where = await filed(core);
    expect(where("Quay plan").groupId).toBeNull();
    expect(where("Quay plan").source).not.toBe("user");
    expect(where("Harbour fees")).toEqual({ groupId: coast.id, source: "user" });
    await arrives(core, files, "Late");
    expect((await filed(core))("Late").groupId).toBeNull();

    const on = await core.rebindFolder(off);
    expect(on.folder).toMatchObject({ id: bound.id, boundFolderId: bound.boundFolderId });
    where = await filed(core);
    expect(where("Quay plan")).toEqual({ groupId: bound.id, source: "user" });
    expect(where("Late")).toEqual({ groupId: bound.id, source: "user" });
    expect(where("Harbour fees")).toEqual({ groupId: coast.id, source: "user" });
  });

  // protects=turned off, a Folder holding a Note, or a Document the User put there from outside its folder, stays a plain Folder with them; only the folder's own files leave it (#3613); fails_when=the Folder goes with the User's Note, or the outside Document leaves it
  it("off, a Folder holding a Note or a Document from elsewhere stays, a plain Folder", async () => {
    const { core, added, bound } = await project();
    const survey = added[0]?.id ?? "";
    await core.assignDocumentGroup(survey, bound.id);
    const note = await core.createMind({ title: "Quay notes", folderId: bound.id });

    const off = await core.unbindFolder(bound.id, []);
    expect(off.removed).toBe(false);
    const plain = (await core.getLibrary()).groups.find((each) => each.id === bound.id);
    expect(plain?.boundFolderId).toBeNull();
    expect((await filed(core))("Quay plan").groupId).toBeNull();
    expect(
      (await core.getLibrary()).assignments.find((each) => each.documentId === survey)?.groupId,
    ).toBe(bound.id);
    expect((await core.listMinds()).find((each) => each.id === note.id)?.folderId).toBe(bound.id);

    await core.rebindFolder(off);
    expect((await filed(core))("Quay plan").groupId).toBe(bound.id);
  });

  // protects=turned off before the folder's first scan ends, a Folder that stays for its Note files none of what that scan finds (#3613); fails_when=the first scan files its files in a Folder no longer bound to the folder
  it("off during the first scan, the Folder that stays files none of what it finds", async () => {
    const { core, files } = await started();
    await writeFile(join(files, "Quay plan.md"), PLAN);
    const { folder } = boundOf(await core.addLinkedFolder(files));
    await core.createMind({ title: "Quay notes", folderId: folder.id });
    expect((await core.unbindFolder(folder.id, [])).removed).toBe(false);
    await processed(core);
    expect((await filed(core))("Quay plan").groupId).toBeNull();
  });

  // protects=a Folder bound inside a bound one, turned off, lets its files go to the one around it, and on again (Undo) takes them back from there (#3613); fails_when=its files stay in the Folder around it once it is on again
  it("off and on again, a Folder inside a bound one takes its files back from it", async () => {
    const { core, files } = await started();
    await mkdir(join(files, "work"));
    await writeFile(join(files, "work", "Brief.md"), "# Brief\n\nThe quay opens in May.\n");
    const work = boundOf(await core.addLinkedFolder(join(files, "work"))).folder;
    await processed(core);
    const outer = boundOf(await core.addLinkedFolder(files)).folder;
    await processed(core);
    expect((await filed(core))("Brief").groupId).toBe(work.id);

    const off = await core.unbindFolder(work.id, []);
    expect((await filed(core))("Brief").groupId).toBe(outer.id);
    await core.rebindFolder(off);
    expect((await filed(core))("Brief")).toEqual({ groupId: work.id, source: "user" });
  });

  // protects=Undo of turning it on leaves a file of its folder the User had filed in another Folder where they filed it (#3507); fails_when=Undo moves or unfiles a filing binding never made
  it("Undo of on leaves a file the User filed in another Folder where they filed it", async () => {
    const { core, coast, linked } = await unsorted();
    const made = await core.createBoundFolder(linked.folderId);
    expect((await filed(core))("Harbour fees")).toEqual({ groupId: coast.id, source: "user" });
    await core.unbindFolder(made.folder.id, made.filed);
    expect((await filed(core))("Harbour fees")).toEqual({ groupId: coast.id, source: "user" });
  });

  // protects=Undo of turning it on leaves a file that had no filing with none again, not in Not in a Folder as the User's choice, so turning it on again files it (#3507); fails_when=Undo leaves it in no Folder as the User's choice, which Organize never proposes a place for and binding again never files
  it("Undo of on leaves a file that had no filing with none; on again files it", async () => {
    const { core, linked, before } = await unsorted();
    const made = await core.createBoundFolder(linked.folderId);
    expect(made.filed).toHaveLength(2);
    expect((await filed(core))("Quay plan")).toEqual({ groupId: made.folder.id, source: "user" });

    const off = await core.unbindFolder(made.folder.id, made.filed);
    expect(await placesOf(core)).toEqual(before);
    expect(await live(core, made.folder.id)).toBe(false);
    const again = await core.rebindFolder(off);
    const where = await filed(core);
    expect([where("Quay plan").groupId, where("Tide table").groupId]).toEqual([
      again.folder.id,
      again.folder.id,
    ]);
  });

  // protects=Undo of turning it on gives a Document Organize had a row for that row back as it was: in no Folder, Organize's, with its state, model and time (#3507); fails_when=Undo leaves it filed by the User, or with no row
  it("Undo of on gives a Document Organize had read its row back", async () => {
    const { core, files } = await started();
    const linked = await core.addLinkedFolder(files);
    await core.unbindFolder(boundOf(linked).folder.id, boundOf(linked).filed);
    await writeFile(join(files, "Quay plan.md"), PLAN);
    await processed(core);
    const before = await placesOf(core);
    const plan = (await core.listDocuments()).find((each) => each.name === "Quay plan");
    expect(before.find((each) => each.documentId === plan?.id)).toMatchObject({
      groupId: null,
      source: "automatic",
    });

    const made = await core.createBoundFolder(linked.folderId);
    expect((await filed(core))("Quay plan")).toEqual({ groupId: made.folder.id, source: "user" });
    await core.unbindFolder(made.folder.id, made.filed);
    expect(await placesOf(core)).toEqual(before);
  });

  // protects=Undo of turning it on leaves a file that arrived in its folder since with no filing, as it had before it arrived (#3507); fails_when=Undo leaves it in no Folder as the User's choice
  it("Undo of on leaves a file that arrived since with no filing", async () => {
    const { core, files, linked, before } = await unsorted();
    const made = await core.createBoundFolder(linked.folderId);
    await arrives(core, files, "Late");
    expect((await filed(core))("Late")).toEqual({ groupId: made.folder.id, source: "user" });

    await core.unbindFolder(made.folder.id, made.filed);
    expect((await filed(core))("Late")).toEqual({ groupId: null, source: null });
    expect(await placesOf(core)).toEqual(before);
  });

  // protects=Redo of turning it on files its folder's files in it again, the one that arrived since too, and leaves the User's filing elsewhere; Undo again puts each back as it was (#3507, #3613); fails_when=the Folder comes back without its folder's files, or the second Undo leaves them in no Folder as the User's choice
  it("Redo files the folder's files in it again; Undo again puts them back", async () => {
    const { core, coast, files, linked, before } = await unsorted();
    const made = await core.createBoundFolder(linked.folderId);
    await arrives(core, files, "Late");
    const off = await core.unbindFolder(made.folder.id, made.filed);

    const redone = await core.rebindFolder(off);
    const where = await filed(core);
    expect(["Quay plan", "Tide table", "Late"].map((name) => where(name))).toEqual([
      { groupId: made.folder.id, source: "user" },
      { groupId: made.folder.id, source: "user" },
      { groupId: made.folder.id, source: "user" },
    ]);
    expect(where("Harbour fees").groupId).toBe(coast.id);

    await core.unbindFolder(made.folder.id, redone.filed);
    expect(await placesOf(core)).toEqual(before);
  });

  // protects=a bound Folder restored from Recently deleted files its folder's files in it again, the one that arrived since too (#3507); fails_when=it comes back without its folder's files
  it("restored from Recently deleted, it files the folder's files again", async () => {
    const { core, files, bound } = await project();
    await core.deleteLibraryGroup(bound.id);
    await arrives(core, files, "Late");
    await core.restore([{ kind: "folder", id: bound.id }]);
    const where = await filed(core);
    expect([where("Quay plan").groupId, where("Late").groupId]).toEqual([bound.id, bound.id]);
  });
});

describe("a folder linked before (#3613)", () => {
  type Edit = (db: ReturnType<typeof openDatabase>) => void;
  /** `set.core` closed, its database edited, and the data folder opened again. */
  async function reopened(set: Awaited<ReturnType<typeof started>>, edit: Edit) {
    await set.core.close();
    const db = openDatabase(join(set.dataDir, DATABASE_FILE));
    try {
      edit(db);
    } finally {
      db.close();
    }
    return set.restart();
  }
  /** The data folder opened again with the migration to run again, as on its first start. */
  const migratedAgain = (set: Awaited<ReturnType<typeof started>>, before: Edit = () => {}) =>
    reopened(set, (db) => {
      db.run("ALTER TABLE library_groups DROP COLUMN deleted_quietly");
      db.run("DELETE FROM schema_migrations WHERE version = 161");
      before(db);
    });
  /** A fault in the database: a Folder named "Broken" can't be made. */
  const broken: Edit = (db) =>
    db.run(`CREATE TRIGGER broken BEFORE INSERT ON library_groups WHEN NEW.name = 'Broken'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  const mended: Edit = (db) => db.run("DROP TRIGGER broken");
  const boundNames = async (core: Core) =>
    (await core.getLibrary()).groups
      .filter((each) => each.boundFolderId)
      .map((each) => each.name)
      .sort();
  /** A set with two folders linked before, "Quay" and "Broken", both with no Folder. */
  async function twoLinkedBefore() {
    const set = await started();
    for (const name of ["Quay", "Broken"]) {
      await mkdir(join(set.files, name));
      await linkWithoutFolder(set.core, join(set.files, name));
    }
    return set;
  }

  // protects=binding the folders linked before never stops a start: one that fails is logged and left with its filing as one Folder off, the others are bound, and it is bound at the next start that can (#3613); fails_when=the core doesn't start, the others stay unbound, or it is never tried again
  it("one that fails to bind stops neither the start nor the others, and is tried again", async () => {
    const set = await twoLinkedBefore();
    const first = await migratedAgain(set, broken);
    expect(await boundNames(first)).toEqual(["Quay"]);
    expect(await first.listLinkedFolders()).toHaveLength(2);

    const next = await reopened({ ...set, core: first }, mended);
    expect(await boundNames(next)).toEqual(["Broken", "Quay"]);
  });

  // protects=a folder that fails to bind at three starts is left with its filing as one Folder off, not tried at every start for ever (#3613); fails_when=it is tried again after the third
  it("one that fails at three starts is left with its filing off", async () => {
    const set = await twoLinkedBefore();
    let core = await migratedAgain(set, broken);
    for (let start = 2; start <= 3; start++) core = await reopened({ ...set, core }, () => {});
    const after = await reopened({ ...set, core }, mended);
    expect(await boundNames(after)).toEqual(["Quay"]);
  });

  // protects=a folder linked before gets a Folder bound to it at the next start, named after it, open to work outside it, holding its files with no filing; every filing the User made stays (#3613); fails_when=its files stay in Not in a Folder, a filing the User made moves, or the Folder keeps its work inside it
  it("gets a Folder holding the files it had not filed; the User's filings stay", async () => {
    const set = await unsorted();
    const core = await migratedAgain(set);
    const bound = (await core.getLibrary()).groups.filter((each) => each.boundFolderId !== null);
    expect(bound).toEqual([
      expect.objectContaining({
        name: basename(set.files),
        boundFolderId: set.linked.folderId,
        keepInside: false,
        parentId: null,
      }),
    ]);
    const where = await filed(core);
    expect(where("Quay plan")).toEqual({ groupId: bound[0]?.id, source: "user" });
    expect(where("Tide table")).toEqual({ groupId: bound[0]?.id, source: "user" });
    expect(where("Harbour fees")).toEqual({ groupId: set.coast.id, source: "user" });
    await arrives(core, set.files, "Late");
    expect((await filed(core))("Late").groupId).toBe(bound[0]?.id);
  });

  // protects=a folder linked before whose name a Folder has already, and one numbered after it, gets the next free number (#3613); fails_when=two Folders beside each other share a name
  it("named after it, past the names the User's Folders have", async () => {
    const set = await unsorted();
    const name = basename(set.files);
    await set.core.createLibraryGroup({ name, description: "" });
    await set.core.createLibraryGroup({ name: `${name} 2`, description: "" });
    const core = await migratedAgain(set);
    const [bound] = (await core.getLibrary()).groups.filter((each) => each.boundFolderId);
    expect(bound?.name).toBe(`${name} 3`);
  });

  // protects=a folder linked before is filed as linking files one now: with sorting by itself off, a Document Organize had left waiting, with an error, is filed as classified with the error gone (#3613); fails_when=it keeps waiting, is queued again at every start, or shows its old error
  it("leaves each Document as linking would: no old waiting state or error", async () => {
    const set = await unsorted();
    const plan = (await set.core.listDocuments()).find((each) => each.name === "Quay plan");
    const core = await migratedAgain(set, (db) => {
      db.run(
        `INSERT INTO document_groups (id, document_id, group_id, source, status, request_id,
           error_kind, error_message, created_at, updated_at)
         VALUES ('row-1', ?, NULL, 'automatic', 'waiting', 'request-1', 'model', 'No model.', ?, ?)`,
        [plan?.id ?? "", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
      );
    });
    const row = (await core.getLibrary()).assignments.find((each) => each.documentId === plan?.id);
    expect(row).toMatchObject({ source: "user", status: "classified", error: null });
    expect(row?.groupId).not.toBeNull();
  });

  // protects=folders linked before get Folder names no Folder beside them has, in any letter case, past a Folder the User made with that name (#3613); fails_when=two Folders side by side share a name
  it("get names no Folder beside them has", async () => {
    const set = await started();
    await set.core.createLibraryGroup({ name: "A", description: "" });
    await set.core.createLibraryGroup({ name: "ärger", description: "" });
    for (const name of ["A", "A 2", "Ärger"]) {
      await mkdir(join(set.files, name));
      await linkWithoutFolder(set.core, join(set.files, name));
    }
    const core = await migratedAgain(set);
    const top = (await core.getLibrary()).groups.filter((each) => each.parentId === null);
    const names = top.map((each) => each.name.toLocaleLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(top.filter((each) => each.boundFolderId).map((each) => each.name)).toHaveLength(3);
    expect(top.map((each) => each.name)).toContain("Ärger 2");
  });

  // protects=a folder linked before whose first scan never ended, so it has no record on disk yet, gets its Folder too (#3613); fails_when=it is left as if the User had turned filing off
  it("one whose first scan never ended gets its Folder too", async () => {
    const set = await unsorted();
    const core = await migratedAgain(set, (db) => {
      db.run("DELETE FROM folders WHERE linked_folder_id = ?", [set.linked.id]);
    });
    const bound = (await core.getLibrary()).groups.filter((each) => each.boundFolderId);
    expect(bound).toEqual([expect.objectContaining({ boundFolderId: set.linked.folderId })]);
  });

  // protects=a folder whose Project waits in Recently deleted gets no second Folder, and restored, the Project is the one bound (#3613); fails_when=two Folders end up bound to one folder
  it("one whose Project waits in Recently deleted gets none; restored, that one is bound", async () => {
    const set = await unsorted();
    const project = await set.core.createBoundFolder(set.linked.folderId);
    await set.core.deleteLibraryGroup(project.folder.id);
    await writeFile(join(set.files, "Crew.md"), "# Crew\n\nSix people.\n");
    await set.core.reconcileDocuments();
    await processed(set.core);
    const core = await migratedAgain(set);
    expect((await core.getLibrary()).groups.some((each) => each.boundFolderId)).toBe(false);
    await core.restore([{ kind: "folder", id: project.folder.id }]);
    const bound = (await core.getLibrary()).groups.filter((each) => each.boundFolderId);
    expect(bound.map((each) => each.id)).toEqual([project.folder.id]);
  });

  // protects=an agent that read Not in a Folder, where a folder linked before kept its files, reads them in their new Folder after the migration, and one that didn't is given nothing more (#3613); fails_when=the agent loses the folder's files, or a share widens
  it("an agent that read Not in a Folder keeps reaching the folder's files", async () => {
    const set = await unsorted();
    await set.core.updateAgent(set.writer.pairing.id, { folderIds: [NOT_IN_A_FOLDER_ID] });
    const core = await migratedAgain(set);
    const [bound] = (await core.getLibrary()).groups.filter((each) => each.boundFolderId);
    const shares = new Map(
      (await core.getAgents()).pairings.map((each) => [each.id, each.folderIds]),
    );
    expect(shares.get(set.writer.pairing.id)).toEqual([NOT_IN_A_FOLDER_ID, bound?.id]);
    expect(shares.get(set.reader.pairing.id)).toEqual([set.coast.id]);
  });

  // protects=a folder whose files the User had all filed already gets no Folder, so no empty one appears and its new files keep going to Not in a Folder; a folder bound already is left as it is (#3613); fails_when=an empty Folder appears, or a second Folder is bound to the same folder
  it("one whose files are all filed already gets none; one bound already stays as it is", async () => {
    const set = await unsorted();
    const documents = await set.core.listDocuments({ linkedFolderId: set.linked.id });
    for (const document of documents) await set.core.assignDocumentGroup(document.id, set.coast.id);
    const core = await migratedAgain(set);
    expect((await core.getLibrary()).groups.some((each) => each.boundFolderId !== null)).toBe(
      false,
    );

    const project = await core.createBoundFolder(set.linked.folderId);
    const again = await migratedAgain({ ...set, core });
    const bound = (await again.getLibrary()).groups.filter((each) => each.boundFolderId !== null);
    expect(bound.map((each) => each.id)).toEqual([project.folder.id]);
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
