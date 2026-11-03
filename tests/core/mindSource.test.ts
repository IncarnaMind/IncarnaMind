/**
 * A Mind used as a source (#335): a snapshot saved as a Document marked
 * "Your note", which keeps what a Citation quoted when the Mind changes,
 * never supports its own Mind, and goes to Recently deleted with Undo.
 */
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { citationNode } from "../../src/shared/blockJson";
import { citationSource, citationState } from "../../src/shared/citations";
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
    const { core } = await setUp();
    const folder = await core.createLibraryGroup({ name: "Field", description: "" });
    const { mind } = await mindWith(core, "Field visit", CLAIM, folder.id);

    const saved = await core.saveMindAsSource(mind.id);
    const document = await ready(core, saved.id);

    expect(document.name).toBe("Field visit");
    expect(document.kind).toBe("markdown");
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
    const supported = await core.checkClaim({ claim: CLAIM, checked: { ownNoteMindIds: [] } });
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
    expect(target.mind.id).toBeTruthy();
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
