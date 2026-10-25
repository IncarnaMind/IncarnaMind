import { readFileSync } from "node:fs";
import { cp, mkdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  type Core,
  DATABASE_FILE,
  type Document,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { migrate, migrations } from "../../src/core/storage/migrations";
import { citationState } from "../../src/shared/citations";
import { askAndFinish, citingModel, onlyCitation, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  createSourceFolder,
  documentAt,
  linkAndProcess,
  sha256,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { appendParagraph, connectToMind } from "../helpers/mindClient";
import { buildPdf } from "../helpers/pdf";

/*
 * A Document is known by where its file belongs, not by its path on one
 * computer (ADR-0020): its Linked folder and its path inside it, its place in
 * the data folder, or its id for a file added on its own. A Linked folder
 * found somewhere else, on this computer or another, keeps its Documents,
 * their versions and the Citations that quote them.
 */

const SPRING = "Spring tides happen at new moon and at full moon.";
const SILT = "Rivers carry silt down to the delta.";
const NEAP = "Neap tides are the smallest of the month, at the quarter moons.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Three pages: the quote is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

const ARTICLE = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");

/** The live Passages' ids: processing a Document again replaces its Passages. */
const passageIds = (dataDir: string) =>
  queryDatabase<{ id: string }>(
    dataDir,
    "SELECT id FROM passages WHERE deleted_at IS NULL ORDER BY id",
  ).map((row) => row.id);

/** Each live Document's place, as stored. */
const places = (dataDir: string) =>
  queryDatabase<{ id: string; source_kind: string; relative_path: string | null }>(
    dataDir,
    "SELECT id, source_kind, relative_path FROM documents ORDER BY id",
  );

const linkedFolderOf = async (core: Core) => {
  const [linked] = await core.listLinkedFolders();
  if (!linked) throw new Error("Nothing is linked.");
  return linked;
};

/** What a Document is, wherever its file is: its id, version, Folder and Tags. */
const identities = (documents: readonly Document[]) =>
  documents
    .map((each) => ({
      id: each.id,
      name: each.name,
      contentHash: each.contentHash,
      folderId: each.folderId,
      linkedFolderId: each.linkedFolderId,
      tags: each.tags.map((tag) => tag.tagId),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

/**
 * A folder, "Library", on a drive: a PDF at its top and notes in a subfolder,
 * linked; an Answer citing page 2 of the PDF; and a Tag on the notes.
 */
async function citeInLinkedFolder() {
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
  const drive = await createSourceFolder();
  const library = join(drive, "Library");
  const tidesPath = await writeSourceFile(library, "Tides.pdf", TIDES);
  const riversPath = await writeSourceFile(
    library,
    join("Notes", "Rivers.md"),
    `# Rivers\n\n${SILT}\n`,
  );
  const documents = await linkAndProcess(core, library);
  const tides = documentAt(documents, tidesPath);
  const rivers = documentAt(documents, riversPath);
  const tag = await core.createTag({ name: "Geography" });
  await core.addDocumentTag(rivers.id, tag.id);

  const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
  const cited = onlyCitation(client, answerId);
  expect(cited).toMatchObject({
    documentId: tides.id,
    contentHash: tides.contentHash,
    check: "found",
  });
  return { ...setup, drive, library, tides, rivers, tag, answerId, cited };
}

describe("A Linked folder found somewhere else keeps its Documents", { timeout: 60_000 }, () => {
  test("moved while the app was closed, it is unavailable until located; then every Document, version, Tag and Citation is as it was, and nothing is processed again", async () => {
    const { core, dataDir, mind, library, tides, rivers, answerId, cited } =
      await citeInLinkedFolder();
    const before = identities(await core.listDocuments());
    const foldersBefore = (await core.listFolders()).map((folder) => folder.id).sort();
    const passagesBefore = passageIds(dataDir);
    const linked = await linkedFolderOf(core);
    await core.close();
    // Moved to another place, under another name, as on another computer.
    const elsewhere = join(await createSourceFolder(), "Library (2026)");
    await rename(library, elsewhere);

    const second = startCore(dataDir);
    await second.reconcileDocuments();
    expect(await linkedFolderOf(second)).toMatchObject({ id: linked.id, status: "unavailable" });
    expect((await second.listDocuments()).map((each) => each.fileStatus)).toEqual([
      "unavailable",
      "unavailable",
    ]);

    const located = await second.locateLinkedFolder(linked.id, elsewhere);
    expect(located).toMatchObject({ id: linked.id, path: elsewhere });
    await second.reconcileDocuments();
    const documents = await waitForDocuments(second, (current) => {
      expect(current.map((each) => each.fileStatus)).toEqual(["available", "available"]);
    });

    // The same Documents, at their places in the folder where it is now.
    expect(identities(documents)).toEqual(before);
    expect(documentAt(documents, join(elsewhere, "Tides.pdf")).id).toBe(tides.id);
    expect(documentAt(documents, join(elsewhere, "Notes", "Rivers.md")).id).toBe(rivers.id);
    expect(documents.map((each) => each.status)).toEqual(["ready", "ready"]);
    expect(passageIds(dataDir)).toEqual(passagesBefore);
    // Its Folders keep their ids; its own is named as the folder is now.
    const folders = await second.listFolders();
    expect(folders.map((folder) => folder.id).sort()).toEqual(foldersBefore);
    expect(folders.find((folder) => folder.id === located.folderId)?.name).toBe("Library (2026)");
    expect((await linkedFolderOf(second)).status).toBe("watching");

    // The Citation is as it was, still found, and opens its Document.
    const client = await connectToMind(second, mind.id);
    const citation = onlyCitation(client, answerId);
    expect(citation).toEqual(cited);
    expect(citationState(citation, documents)).toEqual({
      check: "found",
      reason: null,
      documentId: tides.id,
      changedAfterCited: false,
    });
    expect(
      await second.recheckCitation({ documentId: tides.id, quote: SPRING, pageFrom: 2, pageTo: 2 }),
    ).toMatchObject({ check: "found", contentHash: tides.contentHash });
    const file = await second.openDocumentFile(tides.id);
    expect(Buffer.from(await new Response(file.stream).arrayBuffer())).toEqual(Buffer.from(TIDES));
    await second.close();

    // Where it is now is kept.
    const third = startCore(dataDir);
    await third.reconcileDocuments();
    expect(await linkedFolderOf(third)).toMatchObject({ path: elsewhere, status: "watching" });
    expect(identities(await third.listDocuments())).toEqual(before);
  });

  test("copied to another computer, its files are compared by content: only what changed is processed", async () => {
    const dataDir = await createTempDataFolder();
    const drive = await createSourceFolder();
    const library = join(drive, "Library");
    const same = await writeSourceFile(library, "same.md", `# Same\n\n${SPRING}\n`);
    const edited = await writeSourceFile(library, "edited.md", `# Edited\n\n${SILT}\n`);
    const gone = await writeSourceFile(library, "gone.md", `# Gone\n\n${NEAP}\n`);
    const first = startCore(dataDir);
    const documents = await linkAndProcess(first, library);
    const linked = await linkedFolderOf(first);
    const samePassages = queryDatabase<{ id: string }>(
      dataDir,
      "SELECT id FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY id",
      [documentAt(documents, same).id],
    );
    await first.close();

    // A copy: every file has a new modified time. One was edited there, one deleted, one added.
    const copy = join(await createSourceFolder(), "Library");
    await cp(library, copy, { recursive: true });
    await rm(library, { recursive: true });
    const later = new Date(Date.now() + 60_000);
    await utimes(join(copy, "same.md"), later, later);
    await writeFile(join(copy, "edited.md"), `# Edited\n\n${SILT} It builds a fan of land.\n`);
    await rm(join(copy, "gone.md"));
    await writeSourceFile(copy, "added.md", "# Added\n\nA new file.\n");

    const second = startCore(dataDir);
    await second.locateLinkedFolder(linked.id, copy);
    await second.reconcileDocuments();
    const after = await waitForDocuments(second, (current) => {
      expect(current.find((each) => each.name === "added")?.status).toBe("ready");
      expect(current.find((each) => each.name === "edited")?.contentHash).not.toBe(
        documentAt(documents, edited).contentHash,
      );
    });
    await waitForProcessing(
      second,
      after.map((each) => each.id),
    );

    const byName = new Map((await second.listDocuments()).map((each) => [each.name, each]));
    // Read to compare, not processed again: the same Passages.
    expect(byName.get("same")).toMatchObject({
      id: documentAt(documents, same).id,
      contentHash: documentAt(documents, same).contentHash,
      fileStatus: "available",
      status: "ready",
    });
    expect(
      queryDatabase(
        dataDir,
        "SELECT id FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY id",
        [documentAt(documents, same).id],
      ),
    ).toEqual(samePassages);
    // Edited there: a new version of the same Document.
    expect(byName.get("edited")).toMatchObject({
      id: documentAt(documents, edited).id,
      status: "ready",
    });
    // Deleted there: missing. Added there: a new Document.
    expect(byName.get("gone")).toMatchObject({
      id: documentAt(documents, gone).id,
      fileStatus: "missing",
    });
    expect(byName.get("added")?.id).not.toBe(undefined);
    expect(byName.get("added")?.linkedFolderId).toBe(linked.id);
  });

  test("a folder that isn't it is refused, and nothing changes", async () => {
    const dataDir = await createTempDataFolder();
    const drive = await createSourceFolder();
    const library = join(drive, "Library");
    await writeSourceFile(library, "tides.md", `# Tides\n\n${SPRING}\n`);
    await writeSourceFile(library, "rivers.md", `# Rivers\n\n${SILT}\n`);
    const other = join(drive, "Other");
    await writeSourceFile(other, join("Inside", "neap.md"), `# Neap\n\n${NEAP}\n`);
    const core = startCore(dataDir);
    const linked = (await core.addLinkedFolder(library)).id;
    await core.addLinkedFolder(other);
    await core.reconcileDocuments();
    const documents = await waitForProcessing(
      core,
      (await core.listDocuments()).map((each) => each.id),
    );
    const before = identities(documents);
    const empty = join(drive, "Empty");
    await mkdir(empty);
    // A copy where one of its files was added on its own already.
    const copy = join(await createSourceFolder(), "Library");
    await cp(library, copy, { recursive: true });
    const [single] = (await core.addDocuments([join(copy, "tides.md")])).documents;

    await expect(core.locateLinkedFolder(linked, empty)).rejects.toMatchObject({
      message: "That folder doesn’t hold “Library”’s files. Choose the folder that does.",
      wording: { key: "error.linkedFolder.notThis", values: { name: "Library" } },
    });
    await expect(core.locateLinkedFolder(linked, join(other, "Inside"))).rejects.toThrow(
      /overlaps a Linked folder/,
    );
    await expect(core.locateLinkedFolder(linked, drive)).rejects.toThrow(
      /overlaps a Linked folder/,
    );
    await expect(core.locateLinkedFolder(linked, copy)).rejects.toThrow(
      "“tides.md” is already in IncarnaMind. Delete it, then locate the folder again.",
    );

    expect((await core.listLinkedFolders()).find((each) => each.id === linked)?.path).toBe(library);
    const now = await core.listDocuments();
    expect(identities(now.filter((each) => each.id !== single?.id))).toEqual(before);
    expect(
      now
        .filter((each) => each.linkedFolderId === linked)
        .map((each) => each.path)
        .sort(),
    ).toEqual([join(library, "rivers.md"), join(library, "tides.md")]);
  });

  test("a file the User removed stays out once the folder is found somewhere else", async () => {
    const dataDir = await createTempDataFolder();
    const library = join(await createSourceFolder(), "Library");
    const unwanted = await writeSourceFile(library, "unwanted.md", `# Unwanted\n\n${NEAP}\n`);
    await writeSourceFile(library, "wanted.md", `# Wanted\n\n${SPRING}\n`);
    const first = startCore(dataDir);
    const documents = await linkAndProcess(first, library);
    await first.deleteDocument(documentAt(documents, unwanted).id);
    const linked = await linkedFolderOf(first);
    await first.close();
    const elsewhere = join(await createSourceFolder(), "Library");
    await rename(library, elsewhere);

    const second = startCore(dataDir);
    await second.locateLinkedFolder(linked.id, elsewhere);
    await second.reconcileDocuments();

    expect((await second.listDocuments()).map((each) => each.path)).toEqual([
      join(elsewhere, "wanted.md"),
    ]);
  });
});

describe("The files IncarnaMind keeps are in the data folder, wherever it is", {
  timeout: 30_000,
}, () => {
  test("a web page's snapshot and saved text are found in a copy of the data folder, and the workspace is the same", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const saved = await first.saveWebPage({ address: "https://reader.example/tea", html: ARTICLE });
    if (saved.outcome !== "saved") throw new Error("The page wasn't saved.");
    const text = await first.saveTextAsDocument({ name: "Pasted", text: SPRING });
    await waitForProcessing(first, [saved.document.id, text.id]);
    await first.close();
    const kept = places(dataDir).filter((row) => row.source_kind === "data-folder");
    expect(kept).toEqual(
      [
        {
          id: saved.document.id,
          source_kind: "data-folder",
          relative_path: `Web pages/${saved.document.id}.html`,
        },
        { id: text.id, source_kind: "data-folder", relative_path: "Saved text/Pasted.md" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const workspace = queryDatabase(dataDir, "SELECT id FROM workspace");

    // The whole data folder, copied somewhere else.
    const copy = await createTempDataFolder();
    await cp(dataDir, copy, { recursive: true });
    await rm(dataDir, { recursive: true });
    const second = startCore(copy);
    await second.reconcileDocuments();

    const real = await realpath(copy);
    const documents = await second.listDocuments();
    expect(
      documentAt(documents, join(real, "Web pages", `${saved.document.id}.html`)),
    ).toMatchObject({
      id: saved.document.id,
      fileStatus: "available",
      status: "ready",
    });
    expect(documentAt(documents, join(real, "Saved text", "Pasted.md"))).toMatchObject({
      id: text.id,
      fileStatus: "available",
    });
    const opened = await second.openDocumentFile(text.id);
    expect(await new Response(opened.stream).text()).toBe(`${SPRING}\n`);
    expect(queryDatabase(copy, "SELECT id FROM workspace")).toEqual(workspace);
  });
});

describe("The workspace and Minds' content schema version", { timeout: 30_000 }, () => {
  test("one workspace id is made at a data folder's first start and kept, as is the version each Mind records", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const mind = await first.createMind({ title: "Tides" });
    const client = await connectToMind(first, mind.id);
    appendParagraph(client, "Spring tides come at new and full moon.");
    await client.settled();
    await first.close();
    const workspace = queryDatabase<{ id: string; deleted_at: string | null }>(
      dataDir,
      "SELECT id, deleted_at FROM workspace",
    );
    expect(workspace).toEqual([{ id: expect.stringMatching(UUID), deleted_at: null }]);

    const second = startCore(dataDir);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await second.openMind(mind.id)).state);
    await second.close();

    expect(queryDatabase(dataDir, "SELECT id, deleted_at FROM workspace")).toEqual(workspace);
    expect(doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
      CONTENT_SCHEMA_VERSION,
    );
  });
});

/**
 * Takes out what migration 58 added, leaving the data folder as the version
 * before it left it: the rows the core wrote are what that version wrote too.
 */
function asBeforeMigration58(dataDir: string): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.exec(`
      DROP INDEX documents_by_place;
      ALTER TABLE documents DROP COLUMN source_kind;
      ALTER TABLE documents DROP COLUMN relative_path;
      DROP TABLE workspace;
      DELETE FROM schema_migrations WHERE version = 58;
    `);
  } finally {
    db.close();
  }
}

describe("Migration 58: a data folder made by the previous version", { timeout: 60_000 }, () => {
  test("its Documents are known by their places without being read or processed again, and their Citations stay found", async () => {
    const { core, dataDir, mind, library, tides, rivers, answerId, cited } =
      await citeInLinkedFolder();
    const single = await writeSourceFile(
      await createSourceFolder(),
      "neap.md",
      `# Neap\n\n${NEAP}\n`,
    );
    const [own] = (await core.addDocuments([single])).documents;
    const saved = await core.saveWebPage({ address: "https://reader.example/tea", html: ARTICLE });
    if (!own || saved.outcome !== "saved") throw new Error("Not added.");
    await waitForProcessing(core, [own.id, saved.document.id]);
    const removed = await writeSourceFile(library, "removed.md", `# Removed\n\n${NEAP}\n`);
    await core.reconcileDocuments();
    const removedId = documentAt(await core.listDocuments(), removed).id;
    await waitForProcessing(core, [removedId]);
    await core.deleteDocument(removedId);
    const before = identities(await core.listDocuments());
    const passagesBefore = passageIds(dataDir);
    const linked = await linkedFolderOf(core);
    await core.close();
    asBeforeMigration58(dataDir);

    const second = startCore(dataDir);
    await second.reconcileDocuments();

    // Each Document's place, filled in from where its file was.
    expect(places(dataDir)).toEqual(
      [
        { id: tides.id, source_kind: "linked-folder", relative_path: "Tides.pdf" },
        { id: rivers.id, source_kind: "linked-folder", relative_path: "Notes/Rivers.md" },
        { id: removedId, source_kind: "linked-folder", relative_path: "removed.md" },
        { id: own.id, source_kind: "file", relative_path: null },
        {
          id: saved.document.id,
          source_kind: "data-folder",
          relative_path: `Web pages/${saved.document.id}.html`,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // Nothing read or processed again; the Citation is as it was, and found.
    const documents = await second.listDocuments();
    expect(identities(documents)).toEqual(before);
    expect(documents.map((each) => each.status)).toEqual(["ready", "ready", "ready", "ready"]);
    expect(passageIds(dataDir)).toEqual(passagesBefore);
    const client = await connectToMind(second, mind.id);
    const citation = onlyCitation(client, answerId);
    expect(citation).toEqual(cited);
    expect(citationState(citation, documents).check).toBe("found");
    expect(queryDatabase(dataDir, "SELECT id FROM workspace")).toEqual([
      { id: expect.stringMatching(UUID) },
    ]);
    await second.close();

    // And the folder can move now.
    const elsewhere = join(await createSourceFolder(), "Library");
    await rename(library, elsewhere);
    const third = startCore(dataDir);
    await third.reconcileDocuments();
    expect((await linkedFolderOf(third)).status).toBe("unavailable");
    await third.locateLinkedFolder(linked.id, elsewhere);
    await third.reconcileDocuments();
    const moved = await waitForDocuments(third, (current) => {
      expect(current.filter((each) => each.fileStatus !== "available")).toEqual([]);
    });
    expect(identities(moved)).toEqual(before);
    expect(documentAt(moved, join(elsewhere, "Notes", "Rivers.md")).id).toBe(rivers.id);
    // The file the User removed stays out there too.
    expect(moved.map((each) => each.id)).not.toContain(removedId);
    expect(passageIds(dataDir)).toEqual(passagesBefore);
  });

  test("relative paths are filled in for Linked folders on any system", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(
        db,
        migrations.filter((migration) => migration.version < 58),
      );
      const at = "2026-10-01T09:00:00.000Z";
      const folders = [
        ["mac", "/Users/ada/Papers"],
        ["windows", "C:\\Users\\ada\\Papers"],
        ["share", "\\\\server\\team\\Papers"],
        ["root", "/"],
        ["drive", "D:\\"],
      ] as const;
      for (const [id, path] of folders) {
        db.run(
          "INSERT INTO linked_folders (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [id, path, at, at],
        );
      }
      const documents = [
        ["a", "/Users/ada/Papers/2019/Tides.pdf", "mac"],
        ["b", "C:\\Users\\ada\\Papers\\2019\\Tides.pdf", "windows"],
        ["c", "\\\\server\\team\\Papers\\Tides.pdf", "share"],
        ["d", "/notes/Tides.md", "root"],
        ["e", "D:\\Tides.pdf", "drive"],
        ["f", "/Users/ada/Elsewhere/Tides.pdf", "mac"],
        ["g", "/Users/ada/Papers 2/Tides.pdf", "mac"],
        ["h", "/Users/ada/Downloads/Tides.pdf", null],
      ] as const;
      for (const [id, path, linkedFolderId] of documents) {
        db.run(
          `INSERT INTO documents (id, content_hash, name, kind, size, status, path,
             linked_folder_id, created_at, updated_at)
           VALUES (?, ?, 'Tides', 'pdf', 1, 'ready', ?, ?, ?, ?)`,
          [id, sha256(id), path, linkedFolderId, at, at],
        );
      }

      migrate(db);

      expect(db.all("SELECT id, source_kind, relative_path FROM documents ORDER BY id")).toEqual([
        { id: "a", source_kind: "linked-folder", relative_path: "2019/Tides.pdf" },
        { id: "b", source_kind: "linked-folder", relative_path: "2019/Tides.pdf" },
        { id: "c", source_kind: "linked-folder", relative_path: "Tides.pdf" },
        { id: "d", source_kind: "linked-folder", relative_path: "notes/Tides.md" },
        { id: "e", source_kind: "linked-folder", relative_path: "Tides.pdf" },
        // Not inside its Linked folder, which never happens: no place, rather than a wrong one.
        { id: "f", source_kind: "linked-folder", relative_path: null },
        { id: "g", source_kind: "linked-folder", relative_path: null },
        { id: "h", source_kind: "file", relative_path: null },
      ]);
    } finally {
      db.close();
    }
  });
});
