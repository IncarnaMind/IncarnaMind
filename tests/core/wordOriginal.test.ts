/**
 * A Word file imported as a Mind is also added as a Document (#720): the
 * file as received, which Answers cite, while the Mind is the User's working
 * copy. Its own checks never use it as evidence; a newer draft becomes a new
 * version of it; exporting the Mind and deleting either leave the other.
 */
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, Document, ImportWordFileInput } from "../../src/core";
import { citationState } from "../../src/shared/citations";
import { wordFileOf } from "../../src/shared/wordFiles";
import { checkingModel } from "../helpers/checks";
import {
  askAndFinish,
  citingModel,
  onlyCitation,
  shownPassages,
  unaskedModel,
} from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, sha256, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModels } from "../helpers/models";
import { paragraph, wordFile } from "../helpers/word";
import { importWordMind } from "../helpers/wordMinds";

const CAP =
  "Each party's total liability is capped at the fees paid in the twelve months before the claim.";
const PAYMENT = "The Buyer pays each invoice within 30 days of receiving it.";

/** A supply agreement of two clauses; `cap` is clause 9's sentence. */
const contract = (cap = CAP) =>
  wordFile({
    body: [
      paragraph("Supply agreement", { style: "Title" }),
      paragraph("Clause 8 Payment", { style: "Heading1" }),
      paragraph(PAYMENT),
      paragraph("Clause 9 Limitation of liability", { style: "Heading1" }),
      paragraph(cap),
    ].join(""),
  });

async function setUp(model: MockLanguageModelV4 = unaskedModel()) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: scriptedModels(model).createChatModel });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  return { core, dataDir, sources };
}

async function saveContract(folder: string, bytes: Buffer = contract()): Promise<string> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, "Supply agreement.docx");
  await writeFile(path, bytes);
  return path;
}

/** Imports the file with its original, and waits until the original's Document is read. */
async function importWithOriginal(
  core: Core,
  path: string,
  input: Partial<ImportWordFileInput> = {},
): Promise<{ mindId: string; client: MindClient; document: Document }> {
  const imported = await importWordMind(core, { path, origin: "own", addOriginal: true, ...input });
  const documentId = wordFileOf(imported.client.doc)?.documentId;
  if (!documentId) throw new Error("The original wasn't added.");
  const [document] = await waitForProcessing(core, [documentId]);
  return { ...imported, document: document as Document };
}

/** The Mind's paragraph that holds `text`, selected whole. */
function selected(client: MindClient, text: string) {
  let found: { blockId: string; length: number } | null = null;
  readMind(client).descendants((node) => {
    if (found || node.type.name !== "paragraph" || !node.textContent.includes(text)) return;
    found = { blockId: node.attrs.id as string, length: node.textContent.length };
  });
  if (!found) throw new Error(`No paragraph holds "${text}".`);
  const { blockId, length } = found;
  return { from: { blockId, offset: 0 }, to: { blockId, offset: length } };
}

describe("the original as a Document", () => {
  test("is added in the Mind's Folder, and the Mind and the Document each know the other", async () => {
    const { core, sources } = await setUp();
    const legal = await core.createLibraryGroup({ name: "Legal", description: "" });
    const path = await saveContract(sources);

    const { mindId, client, document } = await importWithOriginal(core, path, {
      folderId: legal.id,
    });

    expect((await core.listMinds()).find((mind) => mind.id === mindId)?.folderId).toBe(legal.id);
    expect(document).toMatchObject({
      kind: "docx",
      path: await realpath(path),
      contentHash: sha256(await readFile(path)),
      linkedFolderId: null,
      status: "ready",
      importedAs: mindId,
      ownFile: null,
    });
    const { assignments } = await core.getLibrary();
    expect(assignments.find((each) => each.documentId === document.id)).toMatchObject({
      groupId: legal.id,
      source: "user",
    });
    expect(wordFileOf(client.doc)?.documentId).toBe(document.id);
  });

  test("imported twice, the file is one Document, which both Minds name", async () => {
    const { core, sources } = await setUp();
    const path = await saveContract(sources);

    const first = await importWithOriginal(core, path);
    const second = await importWithOriginal(core, path);

    expect(second.document.id).toBe(first.document.id);
    expect((await core.listDocuments()).map((each) => [each.id, each.importedAs])).toEqual([
      [first.document.id, second.mindId],
    ]);
    expect(wordFileOf(first.client.doc)?.documentId).toBe(first.document.id);
  });

  test("that the Library can't take is said, and adding it again links it", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, async () => {
    const errors: { event: string; fields: unknown }[] = [];
    const log = {
      info: () => undefined,
      warn: () => undefined,
      error: (event: string, fields?: unknown) => errors.push({ event, fields }),
    };
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { log });
    const path = await saveContract(await createTempDataFolder());
    expect((await core.checkWordFile(path)).refusal).toBeNull();
    // Read when checked, then not readable: the import goes on from what it read.
    await chmod(path, 0o000);
    const result = await core.importWordFile({ path, origin: "own", addOriginal: true });
    await chmod(path, 0o644);

    expect(result).toMatchObject({ ok: true, originalAdded: false });
    if (!result.ok) throw new Error("Refused.");
    expect(await core.listDocuments()).toEqual([]);
    expect(errors).toContainEqual({
      event: "word.import.originalNotAdded",
      fields: { file: "Supply agreement.docx", error: expect.stringMatching(/\S/) },
    });

    expect(await core.addWordOriginal(result.mind.id, path)).toBe(true);
    const client = await connectToMind(core, result.mind.id);
    const [document] = await core.listDocuments();
    expect(document?.importedAs).toBe(result.mind.id);
    expect(wordFileOf(client.doc)?.documentId).toBe(document?.id);
  });

  test("left unticked, the Mind is imported alone", async () => {
    const { core, sources } = await setUp();
    const path = await saveContract(sources);

    const result = await core.importWordFile({ path, origin: "own" });
    expect(result).not.toHaveProperty("originalAdded");
    if (!result.ok) throw new Error("Refused.");
    const client = await connectToMind(core, result.mind.id);

    expect(await core.listDocuments()).toEqual([]);
    expect(wordFileOf(client.doc)?.documentId).toBeNull();
  });

  test("a Question asked in the Mind cites the original's clause", async () => {
    const model = citingModel({
      query: "liability cap",
      records: (passages) => [
        { marker: 1, passage: passages.find((each) => each.text.includes(CAP))?.id, quote: CAP },
      ],
      answer: "Liability is capped at a year's fees [^1].",
    });
    const { core, sources } = await setUp(model);
    const { mindId, client, document } = await importWithOriginal(
      core,
      await saveContract(sources),
    );

    const { answerId } = await askAndFinish(core, client, mindId, "What is the liability cap?");

    expect(onlyCitation(client, answerId)).toMatchObject({
      documentId: document.id,
      contentHash: document.contentHash,
      quote: CAP,
      check: "found",
      location: { kind: "section", heading: "Clause 9 Limitation of liability" },
    });
  });
});

describe("the Mind's own checks", () => {
  test("never use its original as evidence, though Answers may", async () => {
    const calls: ModelCall[] = [];
    const model = checkingModel({ [CAP]: { verdict: "supported", quote: CAP } }, calls);
    const { core, sources } = await setUp(model);
    const { mindId, client, document } = await importWithOriginal(
      core,
      await saveContract(join(sources, "Received")),
    );
    const memo = await writeSourceFile(
      sources,
      "Negotiation notes.md",
      "We asked for the liability cap to be the fees paid in the last twelve months.",
    );
    await addAndProcess(core, [memo]);
    expect(
      (await core.searchPassages("liability capped twelve months", { mode: "keyword" })).map(
        (passage) => passage.documentId,
      ),
    ).toContain(document.id);

    for (const action of ["check-against-documents", "find-support"] as const) {
      const result = await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId,
        action,
        ...selected(client, CAP),
      });
      expect(result).toMatchObject({ kind: "checked", sentences: 1 });
    }

    const searched = calls.flatMap((call) =>
      call.results
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text)),
    );
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.map((passage) => passage.document)).not.toContain(document.name);
    readMind(client).descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name !== "claimCheck") continue;
        expect(mark.attrs.evidence?.documentId ?? null).not.toBe(document.id);
      }
    });
  });

  test("with only its original to search, have nothing to check against", async () => {
    const { core, sources } = await setUp(checkingModel({}));
    const { mindId, client } = await importWithOriginal(core, await saveContract(sources));

    const result = await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId,
      action: "check-against-documents",
      ...selected(client, CAP),
    });

    expect(result).toEqual({ kind: "no-documents", folderId: null });
  });
});

describe("a newer draft", () => {
  test("of the same name in the same Folder is offered as a new version, and Citations of the first keep their text", async () => {
    const model = citingModel({
      query: "liability cap",
      records: (passages) => [
        { marker: 1, passage: passages.find((each) => each.text.includes(CAP))?.id, quote: CAP },
      ],
      answer: "Liability is capped at a year's fees [^1].",
    });
    const { core, dataDir, sources } = await setUp(model);
    const first = await importWithOriginal(core, await saveContract(join(sources, "v1")));
    const { answerId } = await askAndFinish(
      core,
      first.client,
      first.mindId,
      "What is the liability cap?",
    );
    const NEWER = "Each party's total liability is capped at twice the fees paid in a year.";
    const newer = await saveContract(join(sources, "v2"), contract(NEWER));

    const check = await core.checkWordFile(newer, null);
    expect(check.earlierDraft).toEqual({ documentId: first.document.id, name: "Supply agreement" });
    const legal = await core.createLibraryGroup({ name: "Legal", description: "" });
    expect((await core.checkWordFile(newer, legal.id)).earlierDraft).toBeNull();

    const second = await importWordMind(core, {
      path: newer,
      origin: "own",
      addOriginal: true,
      newVersionOf: first.document.id,
    });

    expect(wordFileOf(second.client.doc)?.documentId).toBe(first.document.id);
    await expect
      .poll(async () =>
        (await core.listDocuments()).map((each) => [each.id, each.contentHash, each.importedAs]),
      )
      .toEqual([[first.document.id, sha256(contract(NEWER)), second.mindId]]);

    const citation = onlyCitation(first.client, answerId);
    expect(citation).toMatchObject({ contentHash: first.document.contentHash, quote: CAP });
    expect(citationState(citation, await core.listDocuments())).toMatchObject({
      check: "found",
      changedAfterCited: true,
    });
    const kept = queryDatabase<{ text: string }>(
      dataDir,
      "SELECT text FROM document_pages WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL",
      [first.document.id, first.document.contentHash],
    );
    expect(kept.map((page) => page.text).join("\n")).toContain(CAP);
  });

  test("the same file again is no newer draft", async () => {
    const { core, sources } = await setUp();
    await importWithOriginal(core, await saveContract(join(sources, "v1")));
    const copy = await saveContract(join(sources, "copy"));

    expect((await core.checkWordFile(copy, null)).earlierDraft).toBeNull();
  });
});

describe("the Document stays as it was", () => {
  test("when the Mind is exported, edited or not", async () => {
    const { core, sources, dataDir } = await setUp();
    const path = await saveContract(sources);
    const bytes = await readFile(path);
    const { mindId, document } = await importWithOriginal(core, path);
    const passagesOf = () =>
      queryDatabase<{ text: string }>(
        dataDir,
        "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position",
        [document.id],
      );
    const passages = passagesOf();

    await core.exportMind(mindId, { format: "docx" });
    await core.exportMind(mindId, { format: "markdown" });

    const [after] = await core.listDocuments();
    expect(after).toMatchObject({
      id: document.id,
      contentHash: document.contentHash,
      ownFile: null,
      status: "ready",
    });
    expect(await readFile(path)).toEqual(bytes);
    expect(passagesOf()).toEqual(passages);
  });
});

describe("deleting one", () => {
  test("leaves the other", async () => {
    const { core, sources } = await setUp();
    const first = await importWithOriginal(core, await saveContract(join(sources, "v1")));

    await core.deleteMind(first.mindId);
    const [kept] = await core.listDocuments();
    expect(kept).toMatchObject({ id: first.document.id, importedAs: null, status: "ready" });

    const second = await importWithOriginal(core, await saveContract(join(sources, "v2")));
    await core.deleteDocument(second.document.id);
    expect((await core.listMinds()).map((mind) => mind.id)).toContain(second.mindId);
    expect(wordFileOf(second.client.doc)?.documentId).toBe(second.document.id);
  });
});
