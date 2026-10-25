import { describe, expect, test } from "vitest";
import type { CitationAttributes, Core, Document } from "../../src/core";
import { citationState } from "../../src/shared/citations";
import { quoteInUnits } from "../../src/shared/locations";
import type { UnitKind } from "../../src/shared/units";
import { askAndFinish, citingModel, onlyCitation, setUpWithDocuments } from "../helpers/citations";
import { nextEvent, queryDatabase, startCore } from "../helpers/core";
import {
  createSourceFolder,
  documentAt,
  linkAndProcess,
  writeSourceFile,
} from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

/*
 * Unlinking a Linked folder takes its Documents out of the index, but keeps
 * the stored text of the Units its Citations point to, so the Citations that
 * quote them stay checkable.
 */

const SPRING = "Spring tides happen at new moon and at full moon.";
const SILT = "Rivers carry silt down to the delta.";

/** Three pages: the quote is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

/** The Units whose text is stored and not deleted, in order. */
const storedUnits = (dataDir: string) =>
  queryDatabase<{
    document_id: string;
    content_hash: string;
    page: number;
    kind: UnitKind;
    text: string;
  }>(
    dataDir,
    `SELECT document_id, content_hash, page, kind, text FROM document_pages
     WHERE deleted_at IS NULL ORDER BY document_id, content_hash, page`,
  );

/** A copy of a Citation in a Note, as the editor keeps one: in another Mind, closed. */
async function citeInAnotherMind(core: Core, document: Document, unit: number) {
  const mind = await core.createMind({ title: "Reading notes" });
  const client = await connectToMind(core, mind.id);
  const cited = note("Rivers build deltas");
  const attributes: CitationAttributes = {
    passageId: "passage",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    pageFrom: unit,
    pageTo: unit,
    location: null,
    quote: SILT,
    check: "found",
    checkReason: null,
  };
  cited.content?.push({ type: "citation", attrs: attributes });
  writeMind(client, [cited]);
  await client.settled();
  await core.closeMind(mind.id);
  return { mind, citation: attributes };
}

/**
 * A folder with a PDF and a Markdown file, linked; an Answer citing page 2 of
 * the PDF; and a Note, in another Mind, citing the Markdown file's first Unit.
 */
async function citeThenUnlink() {
  const model = citingModel({
    query: "spring tides",
    records: (passages) => [
      {
        marker: 1,
        passage: passages.find((passage) => passage.document === "Tides")?.id,
        pageFrom: 2,
        pageTo: 2,
        quote: SPRING,
      },
    ],
    answer: "Spring tides come at new and full moon [^1].",
  });
  const setup = await setUpWithDocuments(model, []);
  const { core, client, mind } = setup;
  const library = await createSourceFolder();
  const tidesPath = await writeSourceFile(library, "Tides.pdf", TIDES);
  const riversPath = await writeSourceFile(library, "Rivers.md", `# Rivers\n\n${SILT}\n`);
  const documents = await linkAndProcess(core, library);
  const tides = documentAt(documents, tidesPath);
  const rivers = documentAt(documents, riversPath);

  const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
  const answered = onlyCitation(client, answerId);
  expect(answered).toMatchObject({
    documentId: tides.id,
    contentHash: tides.contentHash,
    pageFrom: 2,
    pageTo: 2,
    check: "found",
  });
  const noted = await citeInAnotherMind(core, rivers, 1);
  const linked = (await core.listLinkedFolders())[0];
  if (!linked) throw new Error("Nothing was linked.");

  const changed = nextEvent(core, "keptCitationTexts.changed");
  const events: string[] = [];
  core.on("keptCitationTexts.changed", () => events.push("kept"));
  core.on("documents.removed", () => events.push("removed"));
  await core.removeLinkedFolder(linked.id);
  const kept = await changed;
  return { ...setup, library, linked, tides, rivers, answered, noted, kept, events };
}

describe("Unlinking a folder keeps the text its Citations quote", { timeout: 30_000 }, () => {
  test("its Documents leave the index, but the Units Citations point to are kept, so the Citations stay checkable", async () => {
    const { core, dataDir, mind, tides, rivers, answered, noted, kept, events } =
      await citeThenUnlink();

    // Out of the sidebar, every search and every Search scope, as before.
    expect(await core.listDocuments()).toEqual([]);
    expect(await core.searchPassages("spring tides", { mode: "keyword" })).toEqual([]);
    expect(
      await core.searchPassages("spring tides", { mode: "keyword", documentIds: [tides.id] }),
    ).toEqual([]);
    // Their Passages and vectors are dropped.
    expect(
      queryDatabase(
        dataDir,
        "SELECT 1 FROM passages WHERE deleted_at IS NULL OR embedding IS NOT NULL",
      ),
    ).toEqual([]);

    // Only the Units a Citation points to are kept: page 2 of the PDF, the Markdown file's Unit 1.
    const keptTexts = [
      { documentId: tides.id, contentHash: tides.contentHash, units: [2] },
      { documentId: rivers.id, contentHash: rivers.contentHash, units: [1] },
    ].sort((a, b) => a.documentId.localeCompare(b.documentId));
    expect(kept).toEqual(keptTexts);
    expect(await core.listKeptCitationTexts()).toEqual(keptTexts);
    // Said before the Documents go, so their Citations never show "can't check" in between.
    expect(events).toEqual(["kept", "removed"]);
    const units = storedUnits(dataDir);
    expect(units.map((unit) => [unit.document_id, unit.content_hash, unit.page])).toEqual(
      keptTexts.flatMap((text) =>
        text.units.map((unit) => [text.documentId, text.contentHash, unit]),
      ),
    );
    // Each quote is in the text kept at its Location, as the check found it.
    const at = (documentId: string) => units.filter((unit) => unit.document_id === documentId);
    expect(quoteInUnits(at(tides.id), SPRING)).not.toBeNull();
    expect(quoteInUnits(at(rivers.id), SILT)).not.toBeNull();

    // So the Citations keep their check, in the Answer and in the Note alike.
    const live = await core.listDocuments();
    const texts = await core.listKeptCitationTexts();
    for (const citation of [answered, noted.citation]) {
      expect(citationState(citation, live, texts)).toEqual({
        check: "found",
        reason: null,
        documentId: null,
        changedAfterCited: false,
      });
    }
    // A Citation of a Unit that wasn't kept can't be checked.
    expect(citationState({ ...answered, pageFrom: 3, pageTo: 3 }, live, texts)).toMatchObject({
      check: "cant-check",
      reason: "document-removed",
    });
    // Exported, the Answer's Citation isn't marked unverified.
    expect(await core.previewMindExport(mind.id, { format: "docx" })).toMatchObject({
      citations: 1,
      unverifiedCitations: 0,
    });
  });

  test("linked again, its Documents are found again by content, and the kept text stays for the Citations", async () => {
    const { core, dataDir, library, tides, rivers, answered, noted, kept } = await citeThenUnlink();

    const again = await linkAndProcess(core, library);
    // The same files, once each: the kept text doesn't bring the old Documents back.
    expect(again.map((each) => each.path).sort()).toEqual([rivers.path, tides.path].sort());
    expect(await core.listDocuments()).toHaveLength(2);
    const newTides = documentAt(again, tides.path);
    expect(newTides.id).not.toBe(tides.id);
    expect(newTides.contentHash).toBe(tides.contentHash);
    expect(await core.searchPassages("spring tides", { mode: "keyword" })).toHaveLength(1);

    // The Citations open the Documents found again by their content.
    const live = await core.listDocuments();
    expect(citationState(answered, live, kept)).toEqual({
      check: "found",
      reason: null,
      documentId: newTides.id,
      changedAfterCited: false,
    });
    expect(citationState(noted.citation, live, kept).documentId).toBe(
      documentAt(again, rivers.path).id,
    );
    // The kept text is untouched, beside the new Documents' own.
    expect(await core.listKeptCitationTexts()).toEqual(kept);
    const units = storedUnits(dataDir);
    expect(units.filter((unit) => unit.document_id === newTides.id)).toHaveLength(3);
    expect(units.filter((unit) => unit.document_id === tides.id).map((unit) => unit.page)).toEqual([
      2,
    ]);

    // Unlinked again, the Citations still check against the text kept the first time.
    const linked = (await core.listLinkedFolders())[0];
    await core.removeLinkedFolder(linked?.id as string);
    expect(await core.listDocuments()).toEqual([]);
    expect(await core.listKeptCitationTexts()).toEqual(kept);
    expect(storedUnits(dataDir)).toHaveLength(2);
    expect(citationState(answered, [], kept)).toMatchObject({ check: "found" });
  });

  test("the kept text goes at a start once no Citation quotes it", async () => {
    const { core, dataDir, mind, rivers, noted } = await citeThenUnlink();
    core.close();

    // Still quoted: kept.
    const second = startCore(dataDir);
    expect(await second.listKeptCitationTexts()).toHaveLength(2);
    await second.deleteMind(mind.id);
    second.close();

    // Waiting in Recently deleted, the Mind can come back with its Citation: the text stays.
    const waiting = startCore(dataDir);
    expect(await waiting.listKeptCitationTexts()).toHaveLength(2);
    // The Answer's Citation goes with its Mind, once the Mind is deleted for good; the Note's stays.
    await waiting.deletePermanently([{ kind: "mind", id: mind.id }]);
    waiting.close();

    const third = startCore(dataDir);
    expect(await third.listKeptCitationTexts()).toEqual([
      { documentId: rivers.id, contentHash: rivers.contentHash, units: [1] },
    ]);
    await third.deleteMind(noted.mind.id);
    await third.deletePermanently([{ kind: "mind", id: noted.mind.id }]);
    third.close();

    const fourth = startCore(dataDir);
    expect(await fourth.listKeptCitationTexts()).toEqual([]);
    expect(storedUnits(dataDir)).toEqual([]);
  });
});
