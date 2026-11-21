/**
 * Deleting a file an outside agent handed over, for good (#3505): every copy IncarnaMind kept of
 * it in the data folder's "Handed files" goes with its Document, each version's and the
 * Document's own, and nothing of it is left to point at one. Another handed file's copies stay, and
 * so does the User's own file at the path the agent named. Moving the Document to Recently deleted
 * and back keeps every copy. Through the shim the app ships, on a temporary data folder.
 */
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import type { Mind } from "../../src/core/api";
import { openDatabase } from "../../src/core/storage";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { type Handed, handOver, started, structured } from "../helpers/handedFiles";
import { plainDeck } from "../helpers/pptx";

const during = vi.hoisted(() => ({
  mkdir: null as ((folder: string) => Promise<void>) | null,
  rename: null as ((to: string) => Promise<void>) | null,
}));

// What a test does as a copy's write is about to land, which it settles by the file's own path.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: async (folder: string, options?: { recursive?: boolean }) => {
      await during.mkdir?.(String(folder));
      return real.mkdir(folder, options);
    },
    rename: async (from: string, to: string) => {
      await during.rename?.(to);
      return real.rename(from, to);
    },
  };
});

const EAST = "The east quay holds 31 boats.";
const WEST = "The west quay holds 12 boats.";
const SLIPWAY = "The slipway closes at dusk in winter.";
const DAY_MS = 24 * 60 * 60 * 1000;

const deck = (title: string, lines: string[]) => plainDeck([{ title }, { lines }]);

/** Every file under the data folder's "Handed files", relative to it, "/" between names, sorted. */
async function kept(dataDir: string): Promise<string[]> {
  const root = join(dataDir, "Handed files");
  const found: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

/** The copies kept of an item: its Documents' own files, and a file for each of its versions. */
const copiesOf = (fileId: string, title: string, versions: number, documents = ["file-1.pptx"]) =>
  [
    ...documents.map((name) => `${fileId}/${name}`),
    ...Array.from({ length: versions }, (_, at) => `${fileId}/v${at + 1}/${title}.pptx`),
  ].sort();

const together = (...groups: string[][]) => groups.flat().sort();

/** Two handed-over files: "Quay review", handed over twice, and "Slip review", once. */
async function handedTwo() {
  const set = await started();
  const agent = await connectLegacyAgent(set.writer.launch);
  const quay = join(set.files, "Quay review.pptx");
  const slip = join(set.files, "Slip review.pptx");
  const bytes = [deck("Quay review", [EAST]), deck("Quay review", [EAST, WEST])] as const;
  await writeFile(quay, bytes[0]);
  const first = structured<Handed>(await handOver(agent, { path: quay, folderId: set.coast.id }));
  await writeFile(quay, bytes[1]);
  const second = structured<Handed>(await handOver(agent, { path: quay }));
  await writeFile(slip, deck("Slip review", [SLIPWAY]));
  const other = structured<Handed>(await handOver(agent, { path: slip, folderId: set.coast.id }));
  const [document] = (await set.core.listDocuments()).filter((each) => each.name === "Quay review");
  if (!document || !first.mindId || !second.mindId || !other.mindId) {
    throw new Error("The hand-overs made no Documents or Notes.");
  }
  const mindIds = { first: first.mindId, second: second.mindId, other: other.mindId };
  const copies = {
    quay: copiesOf(first.fileId, "Quay review", 2),
    slip: copiesOf(other.fileId, "Slip review", 1),
  };
  return { ...set, agent, quay, slip, bytes, first, other, document, mindIds, copies };
}

const documentNamed = async (core: Core, name: string) => {
  const [found] = (await core.listDocuments()).filter((each) => each.name === name);
  if (!found) throw new Error(`No Document is named ${name}.`);
  return found;
};

const forGood = async (core: Core, documentId: string) => {
  await core.deleteDocument(documentId);
  await core.deletePermanently([{ kind: "document", id: documentId }]);
};

describe("deleting a handed-over file for good", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=moving a handed file's Document to Recently deleted and back changes nothing in the data folder: every version's copy and the Document's own file stay, and the restored file is whole, the next version carrying on the same item and Document (#3505); fails_when=a delete or a restore removes or writes a copy, or the restored Document is no longer the item's
  it("keeps every copy while the Document waits in Recently deleted, and a restore brings it back whole", async () => {
    const { core, dataDir, agent, quay, document, first, mindIds, copies } = await handedTwo();
    const before = together(copies.quay, copies.slip);
    expect(await kept(dataDir)).toEqual(before);

    await core.deleteDocument(document.id);
    expect((await core.listDeleted()).map((each) => each.id)).toEqual([document.id]);
    expect(await kept(dataDir)).toEqual(before);
    expect(await core.handedFileOf(mindIds.second)).toMatchObject({ version: 2 });

    await core.restore([{ kind: "document", id: document.id }]);
    expect(await core.listDeleted()).toEqual([]);
    expect(await kept(dataDir)).toEqual(before);
    await waitForProcessing(core, [document.id]);

    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    const third = structured<Handed>(await handOver(agent, { path: quay }));
    expect(third).toMatchObject({ fileId: first.fileId, version: 3, status: "checked" });
    expect((await core.handedFileOf(third.mindId ?? ""))?.file.documentId).toBe(document.id);
    expect(await kept(dataDir)).toEqual(
      together(copiesOf(first.fileId, "Quay review", 3), copies.slip),
    );
  });

  // protects=deleting the Document for good removes every version's copy and the Document's own file, nothing else: the other handed file keeps its copies and its check, the User's file at the path the agent named is untouched, no version reads as a handed file's any more, the check Notes of its versions stay as Notes and are listed as such at once, and the same path handed over again is a new item (#3505); fails_when=a copy of the deleted file is left in the data folder, the other file loses a copy, the User's file is touched, a version's Note still reads as a handed file's, or the new hand-over carries on the deleted item
  it("removes every copy kept of it, and only of it", async () => {
    const { core, dataDir, agent, quay, coast, document, first, other, mindIds, copies, bytes } =
      await handedTwo();
    const told: Mind[][] = [];
    core.on("minds.changed", (minds) => told.push(minds));
    expect((await core.listMinds()).find((each) => each.id === mindIds.first)).toMatchObject({
      supersededBy: mindIds.second,
    });

    await forGood(core, document.id);

    expect(await kept(dataDir)).toEqual(copies.slip);
    expect(await readFile(quay)).toEqual(bytes[1]);
    expect(await core.listDeleted()).toEqual([]);
    expect(await core.handedFileOf(mindIds.first)).toBeNull();
    expect(await core.handedFileOf(mindIds.second)).toBeNull();
    expect(await core.handedFileOf(mindIds.other)).toMatchObject({ version: 1 });
    for (const id of [mindIds.first, mindIds.second]) {
      expect((await core.listMinds()).find((each) => each.id === id)).toMatchObject({ id });
      expect((await core.listMinds()).find((each) => each.id === id)?.supersededBy).toBeUndefined();
      const sent = told.at(-1)?.find((each) => each.id === id);
      expect(sent, "the Notes list sent again has the Note").toMatchObject({ id });
      expect(sent?.supersededBy).toBeUndefined();
    }

    await writeFile(quay, deck("Quay review", [WEST]));
    const again = structured<Handed>(await handOver(agent, { path: quay, folderId: coast.id }));
    expect(again.fileId).not.toBe(first.fileId);
    expect(again).toMatchObject({ version: 1, status: "checked" });
    expect(await kept(dataDir)).toEqual(
      together(copies.slip, copiesOf(again.fileId, "Quay review", 1)),
    );
    expect(other.fileId).not.toBe(again.fileId);
  });

  // protects=a handed file's Document that waited its 30 days in Recently deleted is deleted for good at the next start, and its copies go as they do when the User deletes it for good (#3505); fails_when=the start leaves the copies in the data folder, or takes the other handed file's
  it("removes the copies at start when its Document has waited 30 days", async () => {
    const { core, dataDir, document, copies, mindIds, restart } = await handedTwo();
    await core.deleteDocument(document.id);
    expect(await kept(dataDir)).toEqual(together(copies.quay, copies.slip));

    const later = await restart(() => new Date(Date.now() + 31 * DAY_MS));
    await vi.waitFor(async () => expect(await kept(dataDir)).toEqual(copies.slip));
    expect(await later.listDeleted()).toEqual([]);
    expect(await later.handedFileOf(mindIds.second)).toBeNull();
    expect(await later.handedFileOf(mindIds.other)).toMatchObject({ version: 1 });
  });

  // protects=a handed file that went on with a newer Document after the User deleted the first keeps its versions and the newer Document's file when the first is deleted for good: only the first Document's own file goes (#3505); fails_when=the item's versions or the live Document's file go with the earlier Document, or the earlier Document's own file stays
  it("takes only the deleted Document's own file when the file went on with a newer Document", async () => {
    const { core, dataDir, agent, quay, document, first, copies, mindIds } = await handedTwo();
    await core.deleteDocument(document.id);
    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    const third = structured<Handed>(await handOver(agent, { path: quay }));
    expect(third).toMatchObject({ fileId: first.fileId, version: 3 });
    const both = ["file-1.pptx", "file-3.pptx"];
    expect(await kept(dataDir)).toEqual(
      together(copiesOf(first.fileId, "Quay review", 3, both), copies.slip),
    );

    await core.deletePermanently([{ kind: "document", id: document.id }]);
    expect(await kept(dataDir)).toEqual(
      together(copiesOf(first.fileId, "Quay review", 3, ["file-3.pptx"]), copies.slip),
    );
    expect(await core.handedFileOf(third.mindId ?? "")).toMatchObject({ version: 3 });
    expect(await core.handedFileOf(mindIds.first)).toMatchObject({ version: 1 });
  });

  // protects=a Document that can still come back keeps its own file when the handed file's newer Document is deleted for good: the rest of the item's folder goes, the restored file is whole, and the folder goes once that Document is deleted for good too (#3505); fails_when=a restorable Document's file is removed with the newer Document's item, or the folder is left once nothing can come back
  it("keeps the file of an earlier Document that can still come back, until it is deleted for good too", async () => {
    const { core, dataDir, agent, quay, document, first, other, bytes, copies } = await handedTwo();
    await core.deleteDocument(document.id);
    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    structured<Handed>(await handOver(agent, { path: quay }));
    const newer = (await core.listDocuments()).find(
      (each) => each.name === "Quay review" && each.id !== document.id,
    );
    if (!newer) throw new Error("The third version made no Document.");

    await forGood(core, newer.id);
    expect(await kept(dataDir)).toEqual(together([`${first.fileId}/file-1.pptx`], copies.slip));

    await core.restore([{ kind: "document", id: document.id }]);
    expect(await readFile(join(dataDir, "Handed files", first.fileId, "file-1.pptx"))).toEqual(
      bytes[1],
    );

    await forGood(core, document.id);
    expect(await kept(dataDir)).toEqual(copies.slip);
    expect(await readdir(join(dataDir, "Handed files"))).toEqual([other.fileId]);
  });

  // protects=a handed file whose Document was deleted for good before this version of IncarnaMind (its item's rows still live, its folder on disk) is ended at the next start and its copies go, while an item whose Document is only in Recently deleted keeps its rows and its copies (#3505); fails_when=the old item's rows stay live, its copies stay, or the item that can still come back is touched
  it("ends at start the items of Documents deleted for good before, and takes their copies", async () => {
    const { core, dataDir, document, first, other, copies, mindIds, restart } = await handedTwo();
    const slip = await documentNamed(core, "Slip review");
    await core.deleteDocument(document.id);
    await core.deleteDocument(slip.id);
    await core.close();
    const before = openDatabase(join(dataDir, DATABASE_FILE));
    const at = new Date().toISOString();
    before.run("UPDATE documents SET purged_at = ?, updated_at = ? WHERE id = ?", [
      at,
      at,
      document.id,
    ]);
    before.close();

    const later = await restart();
    await vi.waitFor(async () => expect(await kept(dataDir)).toEqual(copies.slip));
    expect(await later.handedFileOf(mindIds.second)).toBeNull();
    expect(await later.handedFileOf(mindIds.other)).toMatchObject({ version: 1 });
    await later.close();

    const after = openDatabase(join(dataDir, DATABASE_FILE));
    const marked = (table: string, column: string, id: string) =>
      after
        .all<{ deleted_at: string | null }>(`SELECT deleted_at FROM ${table} WHERE ${column} = ?`, [
          id,
        ])
        .map((row) => row.deleted_at !== null);
    expect([
      marked("agent_files", "id", first.fileId),
      marked("agent_file_versions", "file_id", first.fileId),
      marked("agent_files", "id", other.fileId),
      marked("agent_file_versions", "file_id", other.fileId),
    ]).toEqual([[true], [true, true], [false], [false]]);
    after.close();
  });

  // protects=a delete for good that lands while a hand-over is writing a version's copy: the hand-over is as if it came after the delete, a new item at version 1 (what any path handed over after a delete is), and nothing of the deleted item is left, not even the copy being written (#3505); fails_when=the copy lands in the deleted item's folder and stays, the version is recorded on the deleted item, or the agent gets an error
  it("a delete for good during a version's write: the hand-over starts a new item and leaves no copy behind", async () => {
    const { core, dataDir, agent, quay, document, first, copies, mindIds } = await handedTwo();
    await core.deleteDocument(document.id);
    during.rename = async (to) => {
      if (!to.includes(join(first.fileId, "v3"))) return;
      during.rename = null;
      await core.deletePermanently([{ kind: "document", id: document.id }]);
    };
    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    const handed = structured<Handed>(await handOver(agent, { path: quay }));
    during.rename = null;

    expect(handed).toMatchObject({ version: 1, status: "checked" });
    expect(handed.fileId).not.toBe(first.fileId);
    expect(await kept(dataDir)).toEqual(
      together(copies.slip, copiesOf(handed.fileId, "Quay review", 1)),
    );
    expect(await core.handedFileOf(mindIds.second)).toBeNull();
    expect(await core.handedFileOf(handed.mindId ?? "")).toMatchObject({ version: 1 });
    expect((await core.listDocuments()).filter((each) => each.name === "Quay review")).toHaveLength(
      1,
    );
  });

  // protects=a delete for good, and its cleanup, that finish before a hand-over's write has made its folder: the copy then lands in a folder the cleanup had removed, and is found and removed, the hand-over a new item at version 1 (#3505); fails_when=the copy stays in the deleted item's folder
  it("a delete for good before the version's folder is made: the copy that lands after the cleanup is removed", async () => {
    const { core, dataDir, agent, quay, document, first, copies } = await handedTwo();
    await core.deleteDocument(document.id);
    during.mkdir = async (folder) => {
      if (!folder.endsWith(join(first.fileId, "v3"))) return;
      during.mkdir = null;
      await core.deletePermanently([{ kind: "document", id: document.id }]);
    };
    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    const handed = structured<Handed>(await handOver(agent, { path: quay }));
    during.mkdir = null;

    expect(handed).toMatchObject({ version: 1, status: "checked" });
    expect(handed.fileId).not.toBe(first.fileId);
    expect(await kept(dataDir)).toEqual(
      together(copies.slip, copiesOf(handed.fileId, "Quay review", 1)),
    );
  });

  // protects=a delete for good that lands while a hand-over is writing the file's new Document (the earlier one was deleted): no Document is made in the deleted item's folder, and the hand-over is a new item at version 1 (#3505); fails_when=a live Document is made in the folder the cleanup removes, or a copy is left after the cleanup ran
  it("a delete for good during the new Document's write: the hand-over starts a new item", async () => {
    const { core, dataDir, agent, quay, document, first, copies, mindIds } = await handedTwo();
    await core.deleteDocument(document.id);
    during.rename = async (to) => {
      if (!to.endsWith(join(first.fileId, "file-3.pptx"))) return;
      during.rename = null;
      await core.deletePermanently([{ kind: "document", id: document.id }]);
    };
    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    const handed = structured<Handed>(await handOver(agent, { path: quay }));
    during.rename = null;

    expect(handed).toMatchObject({ version: 1, status: "checked" });
    expect(handed.fileId).not.toBe(first.fileId);
    expect(await kept(dataDir)).toEqual(
      together(copies.slip, copiesOf(handed.fileId, "Quay review", 1)),
    );
    expect(await core.handedFileOf(mindIds.second)).toBeNull();
    expect((await core.listDocuments()).filter((each) => each.name === "Quay review")).toHaveLength(
      1,
    );
  });

  // protects=a delete for good that lands while a hand-over is writing a new version into the file's own Document: the hand-over starts a new item, and the Document's file is not written again in the deleted item's folder (#3505); fails_when=the rewritten file stays in the deleted item's folder, or the version is recorded on it
  it("a delete for good during the Document's own file's write: the hand-over starts a new item", async () => {
    const { core, dataDir, agent, quay, document, first, copies } = await handedTwo();
    during.rename = async (to) => {
      if (!to.endsWith(join(first.fileId, "file-1.pptx"))) return;
      during.rename = null;
      await core.deleteDocument(document.id);
      await core.deletePermanently([{ kind: "document", id: document.id }]);
    };
    await writeFile(quay, deck("Quay review", [EAST, WEST, SLIPWAY]));
    const handed = structured<Handed>(await handOver(agent, { path: quay }));
    during.rename = null;

    expect(handed).toMatchObject({ version: 1, status: "checked" });
    expect(handed.fileId).not.toBe(first.fileId);
    expect(await kept(dataDir)).toEqual(
      together(copies.slip, copiesOf(handed.fileId, "Quay review", 1)),
    );
  });

  // protects=a file handed over before the User linked its folder, taken over by the folder's scan as the same Document, leaves only the versions' copies in the data folder, no second copy of the newest bytes beside them; deleting that Document for good removes them while the User's file in the Linked folder stays (#3505, #3499); fails_when=the retired copy's own file is still in the data folder, a version's copy outlives the Document, or the file in the Linked folder is touched
  it("a folder linked after the hand-over leaves no duplicate, and its Document deleted for good takes the versions", async () => {
    const { core, dataDir, writer, files, coast } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Quay review.pptx");
    const bytes = [deck("Quay review", [EAST]), deck("Quay review", [EAST, WEST])] as const;
    await writeFile(path, bytes[0]);
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await writeFile(path, bytes[1]);
    const second = structured<Handed>(await handOver(agent, { path }));
    expect(await kept(dataDir)).toEqual(copiesOf(first.fileId, "Quay review", 2));

    const folder = await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    const document = await documentNamed(core, "Quay review");
    expect(document).toMatchObject({
      linkedFolderId: folder.id,
      path: join(folder.path, "Quay review.pptx"),
    });
    expect(await kept(dataDir)).toEqual(copiesOf(first.fileId, "Quay review", 2, []));

    await forGood(core, document.id);
    expect(await kept(dataDir)).toEqual([]);
    expect(await readdir(join(dataDir, "Handed files"))).toEqual([]);
    expect(await readFile(path)).toEqual(bytes[1]);
    expect(await core.handedFileOf(second.mindId ?? "")).toBeNull();
  });

  // protects=nothing inside a Linked folder is removed, though IncarnaMind's own copies are there: an item's folder the User linked keeps every file when its Document is deleted for good, and the failure is reported (#3505, ADR-0010); fails_when=a file in the Linked folder is deleted
  it("never removes a file in a Linked folder: the item's own folder linked", async () => {
    const { core, dataDir, document, first, copies } = await handedTwo();
    await core.addLinkedFolder(join(dataDir, "Handed files", first.fileId));
    await core.reconcileDocuments();
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await forGood(core, document.id);

    expect(await kept(dataDir)).toEqual(together(copies.quay, copies.slip));
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Linked folder") }),
    );
    reported.mockRestore();
  });

  // protects=the whole of "Handed files" linked: every file there stays, the other handed file's too, and the failure is reported (#3505, ADR-0010); fails_when=a file in the Linked folder is deleted
  it("never removes a file in a Linked folder: Handed files linked as a whole", async () => {
    const { core, dataDir, document, copies } = await handedTwo();
    await core.addLinkedFolder(join(dataDir, "Handed files"));
    await core.reconcileDocuments();
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await forGood(core, document.id);

    expect(await kept(dataDir)).toEqual(together(copies.quay, copies.slip));
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Linked folder") }),
    );
    reported.mockRestore();
  });

  // protects=a Linked folder inside an item's folder: the folder around it is not removed whole, only what is outside the Linked folder goes, and the Linked folder's files stay, reported (#3505, ADR-0010); fails_when=the item's folder is removed whole and the Linked folder's files with it
  it("removes only what is outside a Linked folder inside the item's folder", async () => {
    const { core, dataDir, document, first, copies } = await handedTwo();
    await core.addLinkedFolder(join(dataDir, "Handed files", first.fileId, "v1"));
    await core.reconcileDocuments();
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await forGood(core, document.id);

    expect(await kept(dataDir)).toEqual(
      together([`${first.fileId}/v1/Quay review.pptx`], copies.slip),
    );
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Linked folder") }),
    );
    reported.mockRestore();
  });

  // protects=a Linked folder somewhere else changes nothing: the copies go, nothing is reported, and its own files stay (#3505); fails_when=a Linked folder elsewhere stops the removal, or is reported as if a file in it were in the way
  it("a Linked folder elsewhere changes nothing", async () => {
    const { core, dataDir, document, copies } = await handedTwo();
    const elsewhere = await createSourceFolder();
    const own = await writeSourceFile(
      elsewhere,
      "Notes.md",
      "# Notes\n\nThe tide table is on the quay.\n",
    );
    await core.addLinkedFolder(elsewhere);
    await core.reconcileDocuments();
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await forGood(core, document.id);

    expect(await kept(dataDir)).toEqual(copies.slip);
    expect(reported).not.toHaveBeenCalled();
    expect(await readFile(own, "utf8")).toContain("The tide table");
    reported.mockRestore();
  });

  // protects=a link inside a handed file's folder is removed as a link and never followed: what it points at, in a folder of the User's, stays (#3505); fails_when=a file or folder a link points at is deleted
  it("never follows a link inside the folder it removes", async () => {
    const { core, dataDir, document, first } = await handedTwo();
    const outside = await createTempDataFolder();
    await writeFile(join(outside, "own.txt"), "the User's own file");
    await mkdir(join(outside, "folder"));
    await writeFile(join(outside, "folder", "inner.txt"), "inside a folder");
    const version = join(dataDir, "Handed files", first.fileId, "v1");
    await symlink(join(outside, "own.txt"), join(version, "link to a file"));
    await symlink(join(outside, "folder"), join(version, "link to a folder"), "dir");

    await forGood(core, document.id);

    expect(await readdir(join(dataDir, "Handed files"))).not.toContain(first.fileId);
    expect(await readFile(join(outside, "own.txt"), "utf8")).toBe("the User's own file");
    expect(await readFile(join(outside, "folder", "inner.txt"), "utf8")).toBe("inside a folder");
  });

  // protects=an item's folder that has become a link to somewhere else is not removed through it: what it points at stays, and the failure is reported, not swallowed (#3505); fails_when=the folder the link points at is emptied, or nothing says the copies were not removed
  it("leaves a folder that is a link alone and says so", async () => {
    const { core, dataDir, document, first } = await handedTwo();
    const outside = await createTempDataFolder();
    await writeFile(join(outside, "own.txt"), "the User's own file");
    const folder = join(dataDir, "Handed files", first.fileId);
    await rm(folder, { recursive: true });
    await symlink(outside, folder, "dir");
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await forGood(core, document.id);

    expect(await readFile(join(outside, "own.txt"), "utf8")).toBe("the User's own file");
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(first.fileId) }),
    );
    reported.mockRestore();
  });
});
