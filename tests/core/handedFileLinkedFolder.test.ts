/**
 * A file an outside agent hands over from a Linked folder (#3499): it is one Document, the folder's
 * own, never a copy beside it, whichever comes first, the hand-over or the folder's scan. Handing it
 * over is the agent saying it made the file, so that Document is Not cited and no source, unless what
 * IncarnaMind recorded says the User had it first: the Library held it before the agent was first
 * connected, or the file was last modified before then. The folder's scan is called directly (its
 * watching is proved in CI); the agent calls through the shim the app ships.
 */
import { rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import { agentMadeIt } from "../../src/core/agentFiles/handOver";
import { verificationOf } from "../../src/shared/verification";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { waitForProcessing } from "../helpers/documents";
import { type Handed, handOver, refusal, started, structured } from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { plainDeck } from "../helpers/pptx";

const EAST = "The east quay holds 31 boats.";
const WEST = "The west quay holds 12 boats.";
const deck = (lines: string[] = [EAST]) => plainDeck([{ title: "Quay review" }, { lines }]);
const LONG_AGO = new Date(Date.UTC(2024, 2, 1, 9, 0));

/** The Documents holding the deck, ready, and whether a check's search finds its words. */
async function quay(core: Core) {
  const ids = (await core.listDocuments())
    .filter((each) => each.name.startsWith("Quay"))
    .map((each) => each.id);
  await waitForProcessing(core, ids);
  const documents = (await core.listDocuments()).filter((each) => each.name.startsWith("Quay"));
  const evidence = await core.searchEvidence("east quay boats");
  return {
    documents,
    searched: evidence.passages.some((passage) => passage.text.includes("east quay")),
  };
}

/** The Coast Library with its project folder linked; Claude Code connected before anything in it. */
async function linked() {
  const set = await started();
  const folder = await set.core.addLinkedFolder(set.files);
  const agent = await connectLegacyAgent(set.writer.launch);
  const path = join(set.files, "Quay review.pptx");
  return { ...set, folder, agent, path };
}

const after = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a file an agent hands over from a Linked folder", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a file handed over before the folder's scan finds it is one Document, the folder's own, Not cited and never searched; the scan after makes no second copy (#3499); fails_when=a copy in IncarnaMind's data folder sits beside the folder's Document, which is searched and cited
  it("handed over first: one Document, the folder's, Not cited, and the scan makes no copy", async () => {
    const { core, coast, agent, path, folder } = await linked();
    await writeFile(path, deck());
    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect(handed).toMatchObject({ version: 1, status: "checked" });
    await core.reconcileDocuments();

    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ linkedFolderId: folder.id, notCited: true, path });
    expect(searched).toBe(false);
  });

  // protects=the commonest flow: the agent's draft is scanned, then it edits and hands the file over: one Document, Not cited (#3499); fails_when=the hand-over is refused because the Library holds the file, or the file stays a source because the scan came first
  it("a draft scanned, then edited and handed over: one Document, Not cited", async () => {
    const { core, coast, agent, path } = await linked();
    await writeFile(path, deck());
    await core.reconcileDocuments();
    expect((await quay(core)).searched).toBe(true);

    await writeFile(path, deck([EAST, WEST]));
    expect(structured<Handed>(await handOver(agent, { path, folderId: coast.id }))).toMatchObject({
      version: 1,
      status: "checked",
    });
    await core.reconcileDocuments();
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.notCited).toBe(true);
    expect(searched).toBe(false);
  });

  // protects=a file the scan found first, handed over as it is, is taken as the agent's: no refusal, one Document, Not cited (#3499); fails_when=the hand-over is refused as a file the Library holds
  it("scanned first, then handed over unchanged: taken as the agent's, Not cited", async () => {
    const { core, coast, agent, path } = await linked();
    await writeFile(path, deck());
    await core.reconcileDocuments();
    await quay(core);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.notCited).toBe(true);
    expect(searched).toBe(false);
  });

  // protects=a file an agent writes into a Linked folder and never hands over is an ordinary Document: nothing says who wrote it, and no rule guesses (#3499)
  it("never handed over: an ordinary Document, a source", async () => {
    const { core, path } = await linked();
    await writeFile(path, deck());
    await core.reconcileDocuments();
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.notCited).toBe(false);
    expect(searched).toBe(true);
  });

  // protects=a Document the Library held before the agent was first connected stays a source whatever the agent hands over, unchanged or edited; the hand-over still keeps the version and its check (#3499); fails_when=an agent takes one of the User's own Documents out of the sources by handing it over
  it("the User's own file from before the agent was connected stays a source, with the handed version's check", async () => {
    const set = await started();
    const path = join(set.files, "Quay review.pptx");
    await writeFile(path, deck());
    await set.core.addLinkedFolder(set.files);
    await set.core.reconcileDocuments();
    await quay(set.core);
    await after();
    const later = await set.core.connectAgent({
      name: "Cursor",
      folderIds: [set.coast.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(later.launch);

    const unchanged = structured<Handed>(await handOver(agent, { path, folderId: set.coast.id }));
    expect(unchanged).toMatchObject({ version: 1, status: "checked" });
    expect(unchanged.mindId).not.toBeNull();
    let now = await quay(set.core);
    expect(now.documents).toHaveLength(1);
    expect(now.documents[0]?.notCited).toBe(false);
    expect(now.searched).toBe(true);

    await writeFile(path, deck([EAST, WEST]));
    const edited = structured<Handed>(await handOver(agent, { path }));
    expect(edited).toMatchObject({ version: 2, status: "checked" });
    expect(edited.mindId).not.toBe(unchanged.mindId);
    now = await quay(set.core);
    expect(now.documents).toHaveLength(1);
    expect(now.documents[0]?.notCited).toBe(false);
    const versions = await set.core.handedFileOf(edited.mindId ?? "");
    expect(versions?.file.documentId).toBe(now.documents[0]?.id);
    expect(versions?.versions.map((each) => each.number)).toEqual([1, 2]);
  });

  // protects=one of the User's older files copied into the folder after the agent was connected, handed over unchanged, stays a source: it was last modified before the agent was connected (#3499); fails_when=the file is taken as the agent's because the Library first saw it after the connection
  it("the User's older file copied in after the agent was connected stays a source, by its modified time", async () => {
    const { core, coast, agent, path } = await linked();
    await writeFile(path, deck());
    await utimes(path, LONG_AGO, LONG_AGO);
    await core.reconcileDocuments();
    await quay(core);
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.notCited).toBe(false);
    expect(searched).toBe(true);
  });

  // protects=a second version, a rename on disk and a second agent each keep the one Document; a renamed file's next version is the same handed file (#3499); fails_when=a version, a rename or another agent makes a second Document
  it("a second version, a rename and a second agent keep the one Document", async () => {
    const { core, coast, agent, path, files } = await linked();
    await writeFile(path, deck());
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await writeFile(path, deck([EAST, WEST]));
    expect(structured<Handed>(await handOver(agent, { path }))).toMatchObject({
      fileId: first.fileId,
      version: 2,
    });

    const renamed = join(files, "Quay review final.pptx");
    await rename(path, renamed);
    await core.reconcileDocuments();
    await writeFile(renamed, deck([EAST]));
    expect(structured<Handed>(await handOver(agent, { path: renamed }))).toMatchObject({
      fileId: first.fileId,
      version: 3,
    });

    const other = await core.connectAgent({
      name: "Cursor",
      folderIds: [coast.id],
      propose: true,
    });
    const cursor = await connectLegacyAgent(other.launch);
    await writeFile(renamed, deck([WEST, EAST]));
    structured<Handed>(await handOver(cursor, { path: renamed, folderId: coast.id }));
    await core.reconcileDocuments();
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.notCited).toBe(true);
    expect(searched).toBe(false);
  });

  // protects=the file deleted on disk leaves its versions and their checks; once the folder is unlinked, the next hand-over is a copy in IncarnaMind's data folder, still no source (#3499)
  it("deleted on disk, then the folder unlinked: the checks stay, and a later hand-over is a copy", async () => {
    const { core, coast, agent, path, folder } = await linked();
    await writeFile(path, deck());
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await rm(path);
    await core.reconcileDocuments();
    expect(await core.handedFileOf(first.mindId ?? "")).toMatchObject({ version: 1 });
    expect(refusal(await handOver(agent, { path }))).not.toBe("");

    await core.removeLinkedFolder(folder.id);
    await writeFile(path, deck([EAST, WEST]));
    expect(structured<Handed>(await handOver(agent, { path }))).toMatchObject({
      fileId: first.fileId,
      version: 2,
    });
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ linkedFolderId: null, notCited: true });
    expect(searched).toBe(false);
  });

  // protects=Cite this Document makes the handed file one of the User's sources, still one Document (#3499)
  it("cited by the User: a source, still one Document", async () => {
    const { core, coast, agent, path } = await linked();
    await writeFile(path, deck());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const [document] = (await quay(core)).documents;
    if (!document) throw new Error("No Document holds the deck.");
    await core.setNotCited(document.id, false);
    await core.reconcileDocuments();
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(searched).toBe(true);
  });
});

describe("the User's choice, and a scan that meets a handed file", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=Not cited is set once, when a handed copy first takes its Document: the User citing it stands through the next version (#3492, #3499); fails_when=a version handed over after the User cited the file makes it Not cited again
  it("a copy outside any Linked folder: the User's citing stands through the next version", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const [copy] = (await quay(core)).documents;
    if (!copy) throw new Error("No Document holds the deck.");
    expect(copy.notCited).toBe(true);
    await core.setNotCited(copy.id, false);

    await writeFile(path, deck([EAST, WEST]));
    expect(structured<Handed>(await handOver(agent, { path }))).toMatchObject({ version: 2 });
    const { documents, searched } = await quay(core);
    expect(documents.map((each) => [each.id, each.notCited])).toEqual([[copy.id, false]]);
    expect(searched).toBe(true);
  });

  // protects=in a Linked folder too, the User citing the handed file stands through its next version and through another agent handing the same file over (#3499); fails_when=an agent's hand-over undoes the User's choice
  it("in a Linked folder: the User's citing stands through a new version and another agent", async () => {
    const { core, coast, agent, path } = await linked();
    await writeFile(path, deck());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const [document] = (await quay(core)).documents;
    if (!document) throw new Error("No Document holds the deck.");
    await core.setNotCited(document.id, false);

    await writeFile(path, deck([EAST, WEST]));
    structured<Handed>(await handOver(agent, { path }));
    const other = await core.connectAgent({
      name: "Cursor",
      folderIds: [coast.id],
      propose: true,
    });
    await writeFile(path, deck([WEST, EAST]));
    structured<Handed>(
      await handOver(await connectLegacyAgent(other.launch), { path, folderId: coast.id }),
    );
    const { documents, searched } = await quay(core);
    expect(documents.map((each) => [each.id, each.notCited])).toEqual([[document.id, false]]);
    expect(searched).toBe(true);
  });

  // protects=a file handed over from a folder the User links later is that handed file's Document when the scan finds it: one Document, Not cited as its copy was, the copy gone and its check pointed at the folder's Document (#3499); fails_when=the scan makes an ordinary Document beside the copy
  it("a folder linked after the hand-over: the scan's Document is the handed file's, and the copy goes", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck());
    const handed = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    const [copy] = (await quay(core)).documents;

    const folder = await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ linkedFolderId: folder.id, notCited: true });
    expect(documents[0]?.id).not.toBe(copy?.id);
    expect(searched).toBe(false);
    const kept = await core.handedFileOf(handed.mindId ?? "");
    expect(kept?.file.documentId).toBe(documents[0]?.id);
    expect(kept?.versions.map((each) => each.mindId)).toEqual([handed.mindId]);
  });

  // protects=the copy a scan's Document takes the place of goes for good, never to Recently deleted: the User didn't delete it, and restoring it would bring the second Document back; each version's check Note still opens, on the folder's Document (#3499); fails_when=Recently deleted lists the copy, or a version's Note checks the copy
  it("the copy that goes isn't in Recently deleted, and each version's check still opens", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck());
    const first = structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await writeFile(path, deck([EAST, WEST]));
    const second = structured<Handed>(await handOver(agent, { path }));
    const [copy] = (await quay(core)).documents;

    const folder = await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    const { documents } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ linkedFolderId: folder.id, notCited: true });
    expect((await core.listDeleted()).map((each) => each.id)).not.toContain(copy?.id);
    for (const [handed, words] of [
      [first, EAST],
      [second, WEST],
    ] as const) {
      const kept = await core.handedFileOf(handed.mindId ?? "");
      expect(kept?.file.documentId).toBe(documents[0]?.id);
      expect(kept?.versions.map((each) => each.mindId)).toEqual([first.mindId, second.mindId]);
      const note = await connectToMind(core, handed.mindId ?? "");
      expect(verificationOf(note.doc)?.documentId).toBe(documents[0]?.id);
      expect(note.blocks.toString()).toContain(words);
    }
  });

  // protects=a file handed over while its Linked folder is paused is a copy; once resumed, the scan's Document is the handed file's (#3499)
  it("a paused folder resumed: the scan's Document is the handed file's", async () => {
    const { core, coast, agent, path, folder } = await linked();
    await core.setLinkedFolderPaused(folder.id, true);
    await writeFile(path, deck());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    expect((await quay(core)).documents[0]?.linkedFolderId).toBeNull();

    await core.setLinkedFolderPaused(folder.id, false);
    await core.reconcileDocuments();
    const { documents, searched } = await quay(core);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ linkedFolderId: folder.id, notCited: true });
    expect(searched).toBe(false);
  });

  // protects=a file edited since it was handed over holds bytes no version has: the scan makes an ordinary Document of it, since nothing says who changed it (#3499)
  it("edited since it was handed over: an ordinary Document beside the copy", async () => {
    const { core, coast, writer, files } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    await writeFile(path, deck([EAST, WEST]));
    await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    const { documents } = await quay(core);
    expect(documents.map((each) => [each.linkedFolderId !== null, each.notCited]).sort()).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  // protects=a copy the Library kept beside the folder's Document before #3499 is joined at the next start, when the folder's file holds a version the agent handed over (#3499)
  it("a copy kept beside the folder's Document from before: joined at the next start", async () => {
    const { core, coast, writer, files, restart } = await started();
    const agent = await connectLegacyAgent(writer.launch);
    const path = join(files, "Quay review.pptx");
    await writeFile(path, deck());
    structured<Handed>(await handOver(agent, { path, folderId: coast.id }));
    // The folder's Document made from other bytes, then given the handed ones: no scan finds it new.
    await writeFile(path, deck([EAST, WEST]));
    await core.addLinkedFolder(files);
    await core.reconcileDocuments();
    await quay(core);
    await writeFile(path, deck());
    await core.reconcileDocuments();
    expect((await quay(core)).documents).toHaveLength(2);

    const again = await restart();
    const { documents, searched } = await quay(again);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.linkedFolderId).not.toBeNull();
    expect(documents[0]?.notCited).toBe(true);
    expect(searched).toBe(false);
    expect(await again.listDeleted()).toEqual([]);
    again.close();
  });
});

describe("whether a file in a Linked folder is the agent's (#3499)", () => {
  const connectedAt = "2026-11-20T10:00:00.000Z";
  // protects=the agent's word stands unless a recorded fact says the User had the file first: the Library held it before the connection, or it was last modified before then; a file whose modified time isn't known is the agent's
  it("takes the agent's word unless the Library held it first or it was modified before", () => {
    expect(
      agentMadeIt(
        { createdAt: "2026-11-20T10:05:00.000Z", modifiedAt: "2026-11-20T10:04:00.000Z" },
        connectedAt,
      ),
    ).toBe(true);
    expect(
      agentMadeIt({ createdAt: "2026-11-20T10:05:00.000Z", modifiedAt: null }, connectedAt),
    ).toBe(true);
    expect(
      agentMadeIt(
        { createdAt: "2026-11-20T09:00:00.000Z", modifiedAt: "2026-11-20T10:30:00.000Z" },
        connectedAt,
      ),
    ).toBe(false);
    expect(
      agentMadeIt(
        { createdAt: "2026-11-20T10:05:00.000Z", modifiedAt: "2024-03-01T09:00:00.000Z" },
        connectedAt,
      ),
    ).toBe(false);
  });
});
