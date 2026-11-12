/**
 * A Mind used as a source (#335): a snapshot saved as a Document marked
 * "Your note", which keeps what a Citation quoted when the Mind changes,
 * never supports its own Mind, and goes to Recently deleted with Undo.
 */
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { citationNode } from "../../src/shared/blockJson";
import { citationSource, citationState, newVersionCitation } from "../../src/shared/citations";
import { translate } from "../../src/shared/i18n";
import { checkReply } from "../helpers/checks";
import { answerEnded, citationsIn, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, heading, note, question, readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

const CLAIM = "Harbours publish the times of high water every week.";
const CHANGED = "Harbours publish the times of high water every month.";

async function mindWith(core: Core, title: string, text: string, folderId?: string) {
  const mind = await core.createMind({ title, ...(folderId && { folderId }) });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(1, title), note(text)]);
  await client.settled();
  return { mind, client };
}

/** The Mind's text in a paragraph with a known Block id, for a check named by its place. */
async function mindWithBlock(core: Core, title: string, text: string) {
  const mind = await core.createMind({ title });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", attrs: { id: "one" }, content: [{ type: "text", text }] },
  ]);
  await client.settled();
  return { mind, client };
}

async function setUp(start = "2026-10-12T10:00:00.000Z") {
  const dataDir = await createTempDataFolder();
  const clock = manualClock(start);
  const models = scriptedModels(
    scriptedModel((call) => checkReply(call, { [CLAIM]: { verdict: "supported", quote: CLAIM } })),
  );
  const core = startCore(dataDir, {
    createChatModel: models.createChatModel,
    now: clock.now,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, dataDir, clock };
}

const ready = async (core: Core, documentId: string): Promise<Document> =>
  (await waitForProcessing(core, [documentId]))[0] as Document;

const textOf = async (core: Core, documentId: string): Promise<string> =>
  (await core.readDocumentText(documentId)).pages.map((page) => page.text).join("\n");

describe("Using a Mind as a source", () => {
  test("saves a snapshot named after the Mind, in its Folder, marked Your note", async () => {
    const { core, dataDir } = await setUp();
    const folder = await core.createLibraryGroup({ name: "Field", description: "" });
    const { mind } = await mindWith(core, "Field visit", CLAIM, folder.id);

    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);

    expect(document.name).toBe("Field visit");
    expect(document.kind).toBe("markdown");
    expect((await stat(join(dataDir, "Notes", `${document.id}.md`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, "Notes"))).mode & 0o777).toBe(0o700);
    expect(document.yourNote).toMatchObject({ mindId: mind.id });
    expect(document.yourNote?.snapshotAt).not.toBeNull();
    const text = await textOf(core, document.id);
    expect(text).toContain(CLAIM);
    expect(text).toContain("Snapshot of your note");
    // Its Location is the Mind's heading, so a Citation points inside it.
    expect((await core.readDocumentText(document.id)).pages[0]?.label).toMatchObject({
      path: ["Field visit"],
    });
    const library = await core.getLibrary();
    expect(
      library.assignments.find((assignment) => assignment.documentId === document.id)?.groupId,
    ).toBe(folder.id);
  });

  test("using an empty Mind twice makes one snapshot, and using a Mind again updates it", async () => {
    const { core } = await setUp();
    const mind = await core.createMind({});
    const first = await core.saveMindAsSource(mind.id);
    await ready(core, first.id);
    const second = await core.saveMindAsSource(mind.id);
    expect(second.id).toBe(first.id);
    const snapshots = (await core.listDocuments()).filter(
      (document) => document.yourNote?.mindId === mind.id,
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.name).toBe("Untitled");
  });

  test("a Chinese Mind's snapshot keeps its title, heading and words", async () => {
    const { core } = await setUp();
    const mind = await core.createMind({ title: "实地走访" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [heading(1, "实地走访"), note("港口每周公布高潮时间。")]);
    await client.settled();
    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);
    expect(document.name).toBe("实地走访");
    expect(await textOf(core, document.id)).toContain("港口每周公布高潮时间。");
    expect((await core.readDocumentText(document.id)).pages[0]?.label).toMatchObject({
      path: ["实地走访"],
    });
  });

  test("a snapshot is a copy: editing the Mind leaves it, and the Citation still quotes it", async () => {
    const { core } = await setUp();
    const { mind, client } = await mindWith(core, "Field visit", CLAIM);
    const other = await mindWith(core, "Draft", "The tide table is checked each week.");
    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);
    const [passage] = await core.searchPassages("Harbours publish high water", {
      documentIds: [document.id],
    });
    const quote = passage?.text.includes(CLAIM) ? CLAIM : (passage?.text.slice(0, 40) ?? CLAIM);

    writeMind(other.client, [heading(1, "Draft"), note("The tide table is checked each week.")]);
    await other.client.settled();
    // The Mind edited: the snapshot keeps the words it was made from.
    editMind(client, (blocks) => blocks.map((block, at) => (at === 1 ? note(CHANGED) : block)));
    await client.settled();

    expect(await textOf(core, document.id)).toContain(CLAIM);
    expect(await textOf(core, document.id)).not.toContain(CHANGED);
    const before = await core.recheckCitation({
      documentId: document.id,
      contentHash: document.contentHash,
      pageFrom: passage?.pageFrom ?? null,
      pageTo: passage?.pageTo ?? null,
      quote,
      mindId: null,
    });
    expect(before).toMatchObject({ check: "found" });

    // Update writes the Mind's words again, a new version; the Citation keeps the old one.
    const update = await core.updateMindSourceSnapshot(mind.id);
    const updated = await ready(core, document.id);
    expect(updated.contentHash).not.toBe(document.contentHash);
    expect(update.previousText).toContain(CLAIM);
    expect(update.snapshotText).toContain(CHANGED);
    expect(await textOf(core, document.id)).toContain(CHANGED);
    const after = await core.recheckCitation({
      documentId: document.id,
      contentHash: document.contentHash,
      pageFrom: passage?.pageFrom ?? null,
      pageTo: passage?.pageTo ?? null,
      quote,
      mindId: null,
    });
    // The Document's new version says otherwise; the version the Citation quotes still holds it.
    expect(after).toMatchObject({ check: "not-found", inQuotedVersion: { check: "found" } });
  });

  test("a check of the Mind itself never uses its own snapshot as evidence", async () => {
    const { core } = await setUp();
    const { mind, client } = await mindWithBlock(core, "Field visit", CLAIM);
    const sources = await createTempDataFolder();
    const control = await writeSourceFile(
      sources,
      "Tides.txt",
      "Spring tides come at the new moon and the full moon.",
    );
    await addAndProcess(core, [control]);
    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);

    await core.checkSentences({
      requestId: "own-note",
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "one", offset: 0 },
      to: { blockId: "one", offset: CLAIM.length },
    });
    await client.settled();
    const mark = claimSpans(readMind(client))[0];
    expect(mark?.check.state).not.toBe("supported");
    expect(mark?.check.excluded).toContainEqual(
      expect.objectContaining({ documentId: document.id, reason: "own-note" }),
    );
  });

  test("a new Citation of an old version's passage keeps that version's date", async () => {
    const clock = manualClock("2026-10-12T10:00:00.000Z");
    const model = scriptedModel((call) => {
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: "It says so [^1]." };
      }
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: "C1", quote: CLAIM }] },
          },
        ],
      };
    });
    const { core, mind, client } = await setUpWithDocuments(model, [], { now: clock.now });
    const source = await mindWith(core, "Field visit", CLAIM);
    const saved = await core.saveMindAsSource(source.mind.id);
    const document = await ready(core, saved.id);
    const [passage] = await core.searchPassages("Harbours publish high water", {
      documentIds: [document.id],
    });
    if (!passage) throw new Error("The snapshot has no Passage to cite.");

    // The Mind changes, so the new version no longer holds the old words.
    editMind(source.client, (blocks) =>
      blocks.map((block, at) => (at === 1 ? note("The tide table is checked each week.") : block)),
    );
    await source.client.settled();
    clock.advance(2 * 24 * 60 * 60 * 1000);
    await core.updateMindSourceSnapshot(source.mind.id);
    const updated = await ready(core, document.id);
    expect(updated.contentHash).not.toBe(document.contentHash);

    // The Mind's Citation quotes the old version; the Answer keeps it as its own.
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "one" },
        content: [
          { type: "text", text: "It says so " },
          citationNode({
            passageId: passage.passageId,
            documentId: document.id,
            documentName: "Field visit",
            contentHash: document.contentHash,
            pageFrom: passage.pageFrom,
            pageTo: passage.pageTo,
            location: null,
            quote: CLAIM,
            check: "found",
            checkReason: null,
          }),
        ],
      },
    ]);
    await client.settled();
    const asked = question("What does the note say?");
    editMind(client, (blocks) => [...blocks, asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    const { answerId } = result;
    await answerEnded(core, answerId);
    const cited = citationsIn(client, answerId).find((citation) => citation.yourNoteAt);
    expect(cited?.yourNoteAt).toBe("2026-10-12T10:00:00.000Z");
  });

  test("a check finds support in another Mind's note and never in its own", async () => {
    const { core } = await setUp();
    const source = await mindWith(core, "Field visit", CLAIM);
    const target = await mindWith(core, "Draft", CLAIM);
    const sources = await createTempDataFolder();
    const control = await writeSourceFile(
      sources,
      "Tides.txt",
      "Spring tides come at the new moon and the full moon.",
    );
    await addAndProcess(core, [control]);
    const saved = await core.saveMindAsSource(source.mind.id);
    const document = await ready(core, saved.id);

    // Checked from another Mind: the snapshot is evidence, marked as the User's own note.
    const supported = await core.checkClaim({
      claim: CLAIM,
      checked: { ownNoteMindIds: [target.mind.id] },
    });
    expect(supported.verdict).toBe("supported");
    if (!("evidence" in supported)) throw new Error("The supported check has no evidence.");
    expect(supported.evidence).toMatchObject({
      documentId: document.id,
      documentName: "Field visit",
    });
    expect(supported.evidence?.yourNoteAt).toBeTruthy();

    // Checked by its own Mind: its snapshot is never its evidence.
    const own = await core.checkClaim({
      claim: CLAIM,
      checked: { ownNoteMindIds: [source.mind.id] },
    });
    expect(own.verdict).not.toBe("supported");
    expect(own.excluded).toContainEqual(
      expect.objectContaining({ documentId: document.id, reason: "own-note" }),
    );
  });

  test("Remove as a source sends the snapshot to Recently deleted, and Undo brings it back", async () => {
    const { core } = await setUp();
    const { mind } = await mindWith(core, "Field visit", CLAIM);
    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);

    await core.removeMindSource(mind.id);
    expect((await core.listDocuments()).some((each) => each.id === document.id)).toBe(false);
    const deleted = await core.listDeleted();
    expect(deleted).toContainEqual(
      expect.objectContaining({ kind: "document", id: document.id, name: "Field visit" }),
    );
    // A Citation to it now finds no Document: its source was removed.
    const state = citationState(
      { ...documentCitation(document), yourNoteAt: document.yourNote?.snapshotAt },
      [],
      [],
    );
    expect(state.reason).toBe("document-removed");

    await core.restore([{ kind: "document", id: document.id }]);
    const back = (await core.listDocuments()).find((each) => each.id === document.id);
    expect(back?.yourNote?.mindId).toBe(mind.id);
  });

  test("Undo of an update writes the version before it back, dated when it was taken", async () => {
    const { core, clock } = await setUp();
    const { mind, client } = await mindWith(core, "Field visit", CLAIM);
    const saved = await core.saveMindAsSource(mind.id);
    await ready(core, saved.id);
    const first = await core.citeSelection({
      documentId: saved.id,
      parts: [{ unit: null, text: CLAIM }],
    });
    expect(first.yourNoteAt).toBe("2026-10-12T10:00:00.000Z");

    editMind(client, (blocks) => blocks.map((block, at) => (at === 1 ? note(CHANGED) : block)));
    await client.settled();
    clock.advance(2 * 24 * 60 * 60 * 1000);
    const update = await core.updateMindSourceSnapshot(mind.id);
    await ready(core, saved.id);
    const updated = await core.citeSelection({
      documentId: saved.id,
      parts: [{ unit: null, text: CHANGED }],
    });
    expect(updated.yourNoteAt).toBe("2026-10-14T10:00:00.000Z");

    await core.restoreMindSourceSnapshot(saved.id, {
      text: update.previousText,
      snapshotAt: update.previousSnapshotAt,
    });
    await ready(core, saved.id);
    expect(await textOf(core, saved.id)).toContain(CLAIM);
    expect(await textOf(core, saved.id)).not.toContain(CHANGED);
    const undone = await core.citeSelection({
      documentId: saved.id,
      parts: [{ unit: null, text: CLAIM }],
    });
    expect(undone.yourNoteAt).toBe("2026-10-12T10:00:00.000Z");
  });

  test("a Citation moved to a new version takes that version's date", async () => {
    const { core, clock } = await setUp();
    const { mind, client } = await mindWith(core, "Field visit", CLAIM);
    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);
    const old = await core.citeSelection({
      documentId: document.id,
      parts: [{ unit: null, text: CLAIM }],
    });
    expect(old.yourNoteAt).toBe("2026-10-12T10:00:00.000Z");

    editMind(client, (blocks) => blocks.map((block, at) => (at === 1 ? note(CHANGED) : block)));
    await client.settled();
    clock.advance(2 * 24 * 60 * 60 * 1000);
    await core.updateMindSourceSnapshot(mind.id);
    await ready(core, document.id);

    const recheck = await core.recheckCitation({
      documentId: document.id,
      contentHash: document.contentHash,
      pageFrom: old.pageFrom,
      pageTo: old.pageTo,
      quote: CLAIM,
      mindId: null,
    });
    if ("keptInside" in recheck) throw new Error("The snapshot was read as kept inside a Folder.");
    expect(recheck.changed?.now.yourNoteAt).toBe("2026-10-14T10:00:00.000Z");
    expect(newVersionCitation(old, recheck)?.yourNoteAt).toBe("2026-10-14T10:00:00.000Z");
  });

  test("a new Citation made from the viewer carries the snapshot's date", async () => {
    const { core } = await setUp();
    const { mind } = await mindWith(core, "Field visit", CLAIM);
    const saved = await core.saveMindAsSource(mind.id);
    await ready(core, saved.id);
    const cited = await core.citeSelection({
      documentId: saved.id,
      parts: [{ unit: null, text: "Harbours publish the times" }],
    });
    expect(cited.yourNoteAt).toBe("2026-10-12T10:00:00.000Z");
  });

  test("deleting the snapshot permanently removes its words from the data folder", async () => {
    const { core, dataDir } = await setUp();
    const { mind } = await mindWith(core, "Field visit", CLAIM);
    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);
    const file = join(dataDir, "Notes", `${document.id}.md`);
    await expect(access(file)).resolves.toBeUndefined();
    await core.deleteDocument(document.id);
    // A soft delete keeps the file, so Undo can bring the snapshot back.
    await expect(access(file)).resolves.toBeUndefined();
    await core.deletePermanently([{ kind: "document", id: document.id }]);
    await expect(stat(file)).rejects.toThrow();
  });

  test("a search with the Mind's id leaves its snapshot out, and another Mind's id finds it", async () => {
    const { core } = await setUp();
    const { mind } = await mindWith(core, "Field visit", CLAIM);
    const other = await mindWith(core, "Draft", "The tide table is checked each week.");
    const saved = await core.saveMindAsSource(mind.id);
    const snapshot = await ready(core, saved.id);

    const own = await core.searchEvidence("Harbours publish high water", { mindId: mind.id });
    expect(own.passages.some((each) => each.documentId === snapshot.id)).toBe(false);
    expect(own.excluded).toContainEqual(
      expect.objectContaining({ documentId: snapshot.id, reason: "own-note" }),
    );

    const theirs = await core.searchEvidence("Harbours publish high water", {
      mindId: other.mind.id,
    });
    expect(theirs.passages.some((each) => each.documentId === snapshot.id)).toBe(true);
  });

  test("a copy of a Mind never uses its source Mind's snapshot as evidence", async () => {
    const { core } = await setUp();
    const { mind } = await mindWithBlock(core, "Field visit", CLAIM);
    const sources = await createTempDataFolder();
    const control = await writeSourceFile(
      sources,
      "Tides.txt",
      "Spring tides come at the new moon and the full moon.",
    );
    await addAndProcess(core, [control]);
    const saved = await core.saveMindAsSource(mind.id);
    const snapshot = await ready(core, saved.id);
    const copy = await core.duplicateMind(mind.id);
    const client = await connectToMind(core, copy.id);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "two" }, content: [{ type: "text", text: CLAIM }] },
    ]);
    await client.settled();
    await core.checkSentences({
      requestId: "copy-check",
      mindId: copy.id,
      action: "check-against-documents",
      from: { blockId: "two", offset: 0 },
      to: { blockId: "two", offset: CLAIM.length },
    });
    await client.settled();
    const mark = claimSpans(readMind(client))[0];
    expect(mark?.check.excluded).toContainEqual(
      expect.objectContaining({ documentId: snapshot.id, reason: "own-note" }),
    );
  });

  test("a copy of a copy leaves the first Mind's snapshot out too", async () => {
    const { core } = await setUp();
    const { mind } = await mindWithBlock(core, "Field visit", CLAIM);
    const sources = await createTempDataFolder();
    const control = await writeSourceFile(
      sources,
      "Tides.txt",
      "Spring tides come at the new moon and the full moon.",
    );
    await addAndProcess(core, [control]);
    const saved = await core.saveMindAsSource(mind.id);
    const snapshot = await ready(core, saved.id);
    const copy = await core.duplicateMind(mind.id);
    const grand = await core.duplicateMind(copy.id);
    const client = await connectToMind(core, grand.id);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "three" }, content: [{ type: "text", text: CLAIM }] },
    ]);
    await client.settled();
    await core.checkSentences({
      requestId: "grand-check",
      mindId: grand.id,
      action: "check-against-documents",
      from: { blockId: "three", offset: 0 },
      to: { blockId: "three", offset: CLAIM.length },
    });
    await client.settled();
    const mark = claimSpans(readMind(client))[0];
    expect(mark?.check.excluded).toContainEqual(
      expect.objectContaining({ documentId: snapshot.id, reason: "own-note" }),
    );
  });

  test("the words for a source, its menu foot, Get info and its check", () => {
    expect(translate("en", "mind.updateSnapshot")).toBe("Update the snapshot");
    expect(translate("zh-CN", "mind.updateSnapshot")).toBe("更新快照");
    expect(translate("en", "mind.removeAsSource")).toBe("Remove as a source");
    expect(translate("zh-CN", "mind.removeAsSource")).toBe("不再作为来源");
    expect(translate("zh-CN", "mind.removeAsSourceMany", { count: 2 })).toBe(
      "不再将 2 篇笔记作为来源",
    );
    expect(translate("en", "mind.sourceFoot", { date: "12 Oct", time: "10:00" })).toBe(
      "Used as a source · snapshot of 12 Oct, 10:00",
    );
    expect(translate("zh-CN", "mind.sourceFoot", { date: "10月12日", time: "10:00" })).toBe(
      "已作为来源 · 快照于 10月12日 10:00",
    );
    expect(translate("en", "mind.snapshotAt", { date: "12 Oct", time: "10:00" })).toBe(
      "snapshot of 12 Oct, 10:00",
    );
    expect(translate("zh-CN", "mind.snapshotAt", { date: "10月12日", time: "10:00" })).toBe(
      "快照于 10月12日 10:00",
    );
    expect(translate("en", "claim.ownNote")).toBe("Supported by your own note");
    expect(translate("zh-CN", "claim.ownNote")).toBe("依据来自你自己的笔记");
    expect(translate("en", "claim.ownSource")).toBe("Your own record, not an outside source");
    expect(translate("zh-CN", "claim.ownSource")).toBe("你自己的记录，不是外部来源");
    expect(translate("en", "citation.ownRecord")).toBe("Your own record");
    expect(translate("zh-CN", "citation.ownRecord")).toBe("你自己的记录");
    expect(translate("en", "checks.row.ownNotes", { count: 3 })).toBe("3 only by your own notes");
    expect(translate("en", "checks.row.ownNotes.one")).toBe("1 only by your own note");
    expect(translate("zh-CN", "checks.row.ownNotes", { count: 3 })).toBe("3 句仅以你的笔记为依据");
    expect(translate("zh-CN", "checks.row.ownNotes.one")).toBe("1 句仅以你的笔记为依据");
  });

  test("a Citation to a snapshot reads Your note: its title and the date", () => {
    const label = translate("en", "citation.yourNote", {
      title: "Field visit",
      date: "12 Oct",
    });
    expect(label).toBe("Your note: Field visit, 12 Oct");
    const zh = translate("zh-CN", "citation.yourNote", {
      title: "实地走访",
      date: "10月12日",
    });
    expect(zh).toBe("你的笔记：实地走访，10月12日");

    const shown = citationSource(
      {
        documentName: "Field visit",
        yourNoteAt: new Date().toISOString(),
        pageFrom: null,
        pageTo: null,
        location: null,
      },
      (key, params) => translate("en", key, params),
      "en",
    );
    expect(shown.name.startsWith("Your note: Field visit, ")).toBe(true);
  });
});

function documentCitation(document: { id: string; contentHash: string; name: string }) {
  return {
    passageId: null,
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: null,
    pageTo: null,
    location: null,
    quote: CLAIM,
    check: "found" as const,
    checkReason: null,
  };
}
