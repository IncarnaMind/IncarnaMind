import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import type { Language } from "../../src/core/language";
import {
  changedSourceLines,
  citationState,
  needsRecheck,
  newVersionCitation,
} from "../../src/shared/citations";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";
import {
  answerEnded,
  askNew,
  checkedResult,
  citationsIn,
  citingModel,
  onlyCitation,
  setUpWithDocuments,
} from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  createSourceFolder,
  linkAndProcess,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import { connectToMind } from "../helpers/mindClient";
import { buildPdf } from "../helpers/pdf";

const SPRING = "Spring tides happen at new moon and at full moon.";

/** The first version: the quote is on page 2. */
const V1 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);
/** The second: the sentence was rewritten, so the quote is nowhere. */
const V2 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides follow the new and the full moon."] },
]);
/** The third: the quote is back, a page later. */
const V3 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["A note on the Sun", "The Sun's pull adds to the Moon's."] },
  { lines: ["Spring and neap tides", SPRING] },
]);

/** The fourth: the quote on two pages, neither of them the page cited. */
const V4 = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  { lines: ["A note on the Sun", "The Sun's pull adds to the Moon's."] },
  { lines: ["Spring and neap tides", SPRING] },
  { lines: ["Tides in brief", SPRING] },
]);

/** Words in a language, as the renderer's `t` gives them. */
const in_ = (language: Language) => (key: MessageKey, params?: MessageParams) =>
  translate(language, key, params);

/** The page rows kept of each version of the Documents, by content hash. */
const pagesByVersion = (dataDir: string) =>
  Object.fromEntries(
    queryDatabase<{ content_hash: string; pages: number }>(
      dataDir,
      `SELECT content_hash, count(*) AS pages FROM document_pages
       WHERE deleted_at IS NULL GROUP BY content_hash`,
    ).map((row) => [row.content_hash, row.pages]),
  );

/** Changes a file added on its own, and waits for its new version to be processed. */
async function changeFile(core: Core, documentId: string, path: string, contents: Uint8Array) {
  await writeFile(path, contents);
  await core.reconcileDocuments();
  const [processed] = await waitForProcessing(core, [documentId]);
  expect(processed?.contentHash).toBe(sha256(contents));
}

/**
 * A Citation of version 1, made while the file changed to version 2 under
 * the Answer being written, and then version 3.
 */
async function citeThenChange(fileName = "Tides.pdf") {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = "Spring tides come at new and full moon [^1].";
  const model = citingModel({
    query: "spring tides",
    records: (passages) => [
      { marker: 1, passage: passages[0]?.id, pageFrom: 2, pageTo: 2, quote: SPRING },
    ],
    answer,
    pause: { after: answer.length, until: released },
  });
  const setup = await setUpWithDocuments(model, [{ name: fileName, contents: V1 }]);
  const { core, client, mind, documents } = setup;
  const document = documents[0];
  if (!document) throw new Error("Nothing was added.");

  const answerId = await askNew(core, client, mind.id, "When are spring tides?");
  await expect.poll(() => citationsIn(client, answerId).length).toBe(1);
  // The file changes before the Answer finishes, so the check runs once version 2 is current.
  await changeFile(core, document.id, document.path, V2);
  const ended = answerEnded(core, answerId);
  release();
  expect((await ended).event).toBe("finished");
  return { ...setup, document, answerId };
}

describe("Versions of a Document", { timeout: 30_000 }, () => {
  test("a Citation is checked against the version it quoted, and says when the Document changed after it was cited", async () => {
    const { core, client, document, answerId } = await citeThenChange();

    const citation = onlyCitation(client, answerId);
    expect(citation).toMatchObject({
      documentId: document.id,
      contentHash: sha256(V1),
      pageFrom: 2,
      pageTo: 2,
      check: "found",
      checkReason: null,
    });
    const documents = await core.listDocuments();
    expect(documents[0]?.contentHash).toBe(sha256(V2));
    expect(citationState(citation, documents)).toEqual({
      check: "found",
      reason: null,
      documentId: document.id,
      changedAfterCited: true,
    });
    // Search and new Answers use the current version only: "happen" was only in version 1.
    expect(await core.searchPassages("happen", { mode: "keyword" })).toEqual([]);
    expect(await core.searchPassages("follow", { mode: "keyword" })).toHaveLength(1);

    // Checked again against the current version, where the quote isn't, asked where it stands
    // now as the card and the viewer ask (#3041): nowhere.
    const input = {
      documentId: document.id,
      quote: SPRING,
      pageFrom: 2,
      pageTo: 2,
      lookElsewhere: true,
    };
    expect(await core.recheckCitation({ ...input, mindId: null })).toEqual({
      check: "not-found",
      checkReason: "quote-not-on-pages",
      contentHash: sha256(V2),
      passageId: expect.any(String),
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "page", from: 2, to: 2 },
      elsewhere: null,
    });
    await changeFile(core, document.id, document.path, V3);
    const rechecked = await core.recheckCitation({ ...input, mindId: null });
    // Back a page later: still not found at the page it cites, which it keeps, and on page 3.
    expect(rechecked).toEqual({
      check: "not-found",
      checkReason: "quote-not-on-pages",
      contentHash: sha256(V3),
      passageId: expect.any(String),
      pageFrom: 2,
      pageTo: 2,
      location: { kind: "page", from: 2, to: 2 },
      elsewhere: { location: { kind: "page", from: 3, to: 3 } },
    });
    // Written onto the Citation, it no longer says the Document changed.
    expect(
      citationState({ ...citation, ...rechecked }, await core.listDocuments()).changedAfterCited,
    ).toBe(false);
    await expect(
      core.recheckCitation({ mindId: null, ...input, documentId: "gone" }),
    ).resolves.toMatchObject({
      check: "cant-check",
      checkReason: "document-removed",
    });
  });

  // protects=a Citation to page 2 whose quote the new version holds on page 3 says on its card and in its viewer, from the one answer, where the quote is now, whether it kept its version or not and when its page is past the end (rows A to D); one whose quote is on two other pages says it is in another place; one whose quote is nowhere says it is no longer there; and every field of its check, Needs re-check and Update the sentence… are what they were without the look; fails_when=a quote the version holds reads as no longer in it, one of two places is named, or the check, its page or anything an action reads changes; no_claim=how the card and the viewer draw the line (tests/renderer/quoteStanding.test.ts).
  test("a quote now on another page says where it is, and its check stays at the page it cites (#3041)", async () => {
    const { core, client, document, answerId } = await citeThenChange();
    const citation = onlyCitation(client, answerId);
    const kept = sha256(V1);
    /** Asked as a Note's Citation is, then as its open card is: the same check, and where the quote is beside it. */
    async function lineOf(pageFrom: number, contentHash: string | null) {
      const asked = {
        mindId: null,
        documentId: document.id,
        quote: SPRING,
        pageFrom,
        pageTo: pageFrom,
        contentHash,
        location: { kind: "page" as const, from: pageFrom, to: pageFrom },
      };
      const before = checkedResult(await core.recheckCitation(asked));
      const after = checkedResult(await core.recheckCitation({ ...asked, lookElsewhere: true }));
      expect("elsewhere" in before).toBe(false);
      const { elsewhere, ...check } = after;
      expect(check).toEqual(before);
      expect(before).toMatchObject({
        check: "not-found",
        checkReason: "quote-not-on-pages",
        pageFrom,
        pageTo: pageFrom,
      });
      const documents = await core.listDocuments();
      const cited = { ...citation, ...asked };
      const state = citationState(cited, documents);
      expect(needsRecheck(state, cited, after)).toBe(needsRecheck(state, cited, before));
      expect(newVersionCitation(cited, after)).toEqual(newVersionCitation(cited, before));
      const live = documents.find((each) => each.id === document.id);
      const lines = (["en", "zh-CN"] as const).map(
        (language) =>
          changedSourceLines(true, asked, after, live, language, in_(language)).note?.quote,
      );
      return { elsewhere, lines };
    }

    // Version 2 holds the quote nowhere.
    for (const contentHash of [kept, null]) {
      expect(await lineOf(2, contentHash)).toEqual({
        elsewhere: null,
        lines: ["Its quote is no longer in the new version.", "新版本中已找不到这条引文。"],
      });
    }

    // Version 3 holds it on page 3: A, B, C and D.
    await changeFile(core, document.id, document.path, V3);
    for (const [pageFrom, contentHash] of [
      [2, kept],
      [2, null],
      [9999, null],
      [9999, kept],
    ] as const) {
      expect(await lineOf(pageFrom, contentHash)).toEqual({
        elsewhere: { location: { kind: "page", from: 3, to: 3 } },
        lines: ["Its quote is now at p. 3.", "引文已移到第 3 页。"],
      });
    }
    // At the page that holds it, it is still here, and nothing more is looked for.
    const atPage = checkedResult(
      await core.recheckCitation({
        mindId: null,
        documentId: document.id,
        quote: SPRING,
        pageFrom: 3,
        pageTo: 3,
        contentHash: kept,
        lookElsewhere: true,
      }),
    );
    expect(atPage).toMatchObject({ check: "found", pageFrom: 3 });
    expect("elsewhere" in atPage).toBe(false);

    // Version 4 holds it on pages 3 and 4: neither is named.
    await changeFile(core, document.id, document.path, V4);
    for (const contentHash of [kept, null]) {
      expect(await lineOf(2, contentHash)).toEqual({
        elsewhere: { location: null },
        lines: ["Its quote is in another place in the new version.", "引文在新版本中换了位置。"],
      });
    }
  });

  test("old versions' text is kept while a Citation quotes it, and goes at a start once none does", async () => {
    const { core, dataDir, document, mind } = await citeThenChange();
    await changeFile(core, document.id, document.path, V3);
    // Version 1 is cited, version 2 isn't, version 3 is current.
    expect(pagesByVersion(dataDir)).toEqual({
      [sha256(V1)]: 2,
      [sha256(V2)]: 2,
      [sha256(V3)]: 3,
    });
    core.close();

    const second = startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2, [sha256(V3)]: 3 });
    expect(
      queryDatabase(dataDir, "SELECT 1 FROM passages WHERE content_hash = ?", [sha256(V2)]),
    ).toEqual([]);
    // The Mind waits in Recently deleted and can come back with its Citation, so version 1 stays.
    await second.deleteMind(mind.id);
    second.close();

    const third = startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2, [sha256(V3)]: 3 });
    // The Citation goes with its Mind once it is deleted for good: nothing quotes version 1 any more.
    await third.deletePermanently([{ kind: "mind", id: mind.id }]);
    third.close();

    startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V3)]: 3 });
  });

  test("a Mind in Recently deleted keeps the version its Citation quotes through a restart, and restored, the Citation still opens it", async () => {
    const { core, dataDir, document, mind, answerId } = await citeThenChange("潮汐.pdf");
    const nothingCited = await core.createMind({ title: "Nothing cited" });
    await core.deleteMind(mind.id);
    await core.deleteMind(nothingCited.id);
    core.close();

    const second = startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2, [sha256(V2)]: 2 });
    await second.restore([{ kind: "mind", id: mind.id }]);
    second.close();

    const third = startCore(dataDir);
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2, [sha256(V2)]: 2 });
    const citation = onlyCitation(await connectToMind(third, mind.id), answerId);
    expect(citation).toMatchObject({ documentId: document.id, contentHash: sha256(V1) });
    expect(
      await third.readableQuote({
        documentId: document.id,
        contentHash: sha256(V1),
        pageFrom: 2,
        pageTo: 2,
        quote: SPRING,
      }),
    ).toBe(SPRING);
  });
});

/** The next version, written half-way, as a sync client leaves a file it is still downloading. */
const HALF_V2 = V2.subarray(0, Math.floor(V2.length / 2));

const documentIds = (results: readonly { documentId: string }[]) => [
  ...new Set(results.map((result) => result.documentId)),
];

/** Writes a new version of a Linked file, reconciles, and waits for it to be processed. */
async function rewrite(core: Core, documentId: string, path: string, contents: Uint8Array) {
  await writeFile(path, contents);
  await core.reconcileDocuments();
  const [processed] = await waitForProcessing(core, [documentId]);
  if (!processed) throw new Error("The Document went.");
  return processed;
}

/** A Linked folder holding Tides.pdf at version 1, processed, with embeddings on, so it has vectors. */
async function linkedTides() {
  const dataDir = await createTempDataFolder();
  const library = await createSourceFolder();
  const path = await writeSourceFile(library, "Tides.pdf", V1);
  const core = startCore(dataDir);
  await turnOnEmbeddings(core);
  const [document] = await linkAndProcess(core, library);
  if (!document) throw new Error("Nothing was linked.");
  return { dataDir, core, path, document };
}

describe("A new version that can't be read", { timeout: 30_000 }, () => {
  test("leaves the last good version indexed and searched, says it failed, and a later change or Retry reads the file again", async () => {
    const { dataDir, core, path, document } = await linkedTides();
    expect(document).toMatchObject({ status: "ready", contentHash: sha256(V1), pageCount: 2 });

    const failed = await rewrite(core, document.id, path, HALF_V2);

    // Shown as failed, so the User can retry, with the version still indexed.
    expect(failed).toMatchObject({
      id: document.id,
      status: "failed",
      failure: { reason: "unreadable", message: expect.any(String) },
      contentHash: sha256(V1),
      pageCount: 2,
      fileStatus: "available",
      progress: null,
    });
    // That version's text, Passages and vectors are still searched, and its text read.
    expect(documentIds(await core.searchPassages("happen", { mode: "keyword" }))).toEqual([
      document.id,
    ]);
    expect(documentIds(await core.searchPassages("spring tides", { mode: "vector" }))).toEqual([
      document.id,
    ]);
    expect(documentIds(await core.searchPassages("full moon"))).toEqual([document.id]);
    expect(await core.readDocumentText(document.id)).toMatchObject({
      contentHash: sha256(V1),
      pages: [expect.objectContaining({ page: 1 }), expect.objectContaining({ page: 2 })],
    });
    expect(pagesByVersion(dataDir)).toEqual({ [sha256(V1)]: 2 });
    core.close();

    // After a restart it is the same: the half-written file isn't read again by itself.
    const second = startCore(dataDir);
    const seen: Document[] = [];
    second.on("document.status", (each) => seen.push(each));
    await second.reconcileDocuments();
    expect(seen).toEqual([]);
    expect(await second.listDocuments()).toEqual([failed]);
    expect(documentIds(await second.searchPassages("full moon"))).toEqual([document.id]);

    // Retry reads it again; still half-written, it fails again, and the version stays.
    expect(await second.retryDocument(document.id)).toMatchObject({
      status: "queued",
      failure: null,
      contentHash: sha256(V1),
    });
    const [retried] = await waitForProcessing(second, [document.id]);
    expect(retried).toMatchObject({ status: "failed", contentHash: sha256(V1) });
    expect(documentIds(await second.searchPassages("happen", { mode: "keyword" }))).toEqual([
      document.id,
    ]);

    // Written in full, the next change is read, and replaces the old version in search.
    const fixed = await rewrite(second, document.id, path, V2);
    expect(fixed).toMatchObject({ status: "ready", failure: null, contentHash: sha256(V2) });
    expect(await second.searchPassages("happen", { mode: "keyword" })).toEqual([]);
    expect(documentIds(await second.searchPassages("follow", { mode: "keyword" }))).toEqual([
      document.id,
    ]);
  });

  test("a file put back as the version indexed is ready again, without being read", async () => {
    const { core, path, document } = await linkedTides();
    await rewrite(core, document.id, path, HALF_V2);
    const seen: Document[] = [];
    core.on("document.status", (each) => seen.push(each));

    await writeFile(path, V1);
    await core.reconcileDocuments();

    expect(seen.map((each) => each.status)).toEqual(["ready"]);
    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({ status: "ready", failure: null, contentHash: sha256(V1) }),
    ]);
  });

  test("a Document that never had a version read still fails as it did, with nothing to search", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    const path = await writeSourceFile(library, "Tides.pdf", HALF_V2);
    const core = startCore(dataDir);

    const [failed] = await linkAndProcess(core, library);

    expect(failed).toMatchObject({
      status: "failed",
      failure: { reason: "unreadable" },
      contentHash: sha256(HALF_V2),
    });
    expect(await core.searchPassages("moon")).toEqual([]);
    // Another unreadable version: still failed, now of that version.
    const broken = new TextEncoder().encode("%PDF-1.7\nnot the rest of a PDF");
    expect(await rewrite(core, failed?.id as string, path, broken)).toMatchObject({
      status: "failed",
      contentHash: sha256(broken),
    });
    expect(await core.searchPassages("moon")).toEqual([]);
  });
});
