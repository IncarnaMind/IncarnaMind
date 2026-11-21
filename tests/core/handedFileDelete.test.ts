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
import type { Core } from "../../src/core";
import type { Mind } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { type Handed, handOver, started, structured } from "../helpers/handedFiles";
import { plainDeck } from "../helpers/pptx";

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
      expect(told.at(-1)?.find((each) => each.id === id)?.supersededBy).toBeUndefined();
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
