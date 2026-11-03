import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CITATION_NODE,
  type Core,
  DATABASE_FILE,
  MIND_CONTENT_FIELD,
  NotFoundError,
  QUESTION_BLOCK,
} from "../../src/core";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { type Database, migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import {
  createSourceFolder,
  linkAndProcess,
  sha256,
  storedFile,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";

const NOTES = "# Tide notes\n\nSpring tides happen at new moon and at full moon.\n";
const HASH = sha256(NOTES);
const DOCUMENT = "8a3e4c1e-2f8b-4d7a-9c1e-0b2a6d5e4f01";
const FOLDER = "5c7d2a90-6e14-4b3f-8a2d-1f0e9c8b7a62";
const TAG = "b1f0e2d3-4c5a-4b6e-8f7a-9d0c1b2a3e45";
const MIND = "e4d3c2b1-a0f9-4e8d-9c7b-6a5f4e3d2c10";
const QUESTION = "f0e1d2c3-b4a5-4968-8776-5a4b3c2d1e0f";
const AT = "2026-10-01T09:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

/** A Mind with a Question scoped to the old Folder, and an Answer citing the Document. */
function mindContent(): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const question = new Y.XmlElement(QUESTION_BLOCK);
  question.setAttribute("id", QUESTION);
  question.setAttribute("scopeFolderIds", [FOLDER] as unknown as string);
  question.insert(0, [new Y.XmlText("When are spring tides?")]);
  const paragraph = new Y.XmlElement("paragraph");
  const citation = new Y.XmlElement(CITATION_NODE);
  for (const [name, value] of Object.entries({
    passageId: "old-passage",
    documentId: DOCUMENT,
    documentName: "Tide notes",
    contentHash: HASH,
    quote: "Spring tides happen at new moon and at full moon.",
    check: "found",
  })) {
    citation.setAttribute(name, value);
  }
  paragraph.insert(0, [new Y.XmlText("At new and full moon "), citation]);
  blocks.insert(0, [question, paragraph]);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * A data folder as the copy layout left it (before migration 21): one ready
 * Document copied into documents/ under its hash, filed in an in-app Folder,
 * with a Tag, and a Mind citing it.
 */
async function copyLayoutDataFolder(more?: (db: Database) => void): Promise<string> {
  const dataDir = await createTempDataFolder();
  await mkdir(join(dataDir, "documents"));
  await writeFile(storedFile(dataDir, HASH), NOTES);
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    migrate(
      db,
      migrations.filter((migration) => migration.version < 21),
    );
    more?.(db);
    db.run(
      `INSERT INTO folders (id, parent_id, name, created_at, updated_at) VALUES (?, NULL, 'Ocean', ?, ?)`,
      [FOLDER, AT, AT],
    );
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, page_count, folder_id,
         processing_version, tagging_status, created_at, updated_at)
       VALUES (?, ?, 'Tide notes', 'markdown', ?, 'ready', NULL, ?, ?, 'tagged', ?, ?)`,
      [DOCUMENT, HASH, Buffer.byteLength(NOTES), FOLDER, BigInt(PROCESSING_VERSION), AT, AT],
    );
    db.run(
      `INSERT INTO passages (id, document_id, position, page_from, page_to, window_from, window_to,
         text, created_at, updated_at)
       VALUES ('old-passage', ?, 0, NULL, NULL, 0, 0, ?, ?, ?)`,
      [DOCUMENT, NOTES, AT, AT],
    );
    db.run(
      `INSERT INTO document_pages (id, document_id, page, text, created_at, updated_at)
       VALUES ('old-page', ?, NULL, ?, ?, ?)`,
      [DOCUMENT, NOTES, AT, AT],
    );
    db.run(
      `INSERT INTO tags (id, name, description, preset, created_at, updated_at)
       VALUES (?, 'Oceans', '', NULL, ?, ?)`,
      [TAG, AT, AT],
    );
    db.run(
      `INSERT INTO document_tags (id, document_id, tag_id, source, created_at, updated_at)
       VALUES ('old-link', ?, ?, 'user', ?, ?)`,
      [DOCUMENT, TAG, AT, AT],
    );
    db.run(`INSERT INTO minds (id, title, created_at, updated_at) VALUES (?, 'Tides', ?, ?)`, [
      MIND,
      AT,
      AT,
    ]);
    db.run(
      `INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at)
       VALUES ('old-update', ?, ?, ?, ?)`,
      [MIND, mindContent(), AT, AT],
    );
  } finally {
    db.close();
  }
  return dataDir;
}

/** The Citations' attributes in a Mind's state. */
function citationsIn(state: Uint8Array): Record<string, unknown>[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const found: Record<string, unknown>[] = [];
  const visit = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === CITATION_NODE) found.push(child.getAttributes());
      else visit(child);
    }
  };
  visit(doc.getXmlFragment(MIND_CONTENT_FIELD));
  return found;
}

describe("Migration 21: from copies in the data folder to Documents in place", {
  timeout: 30_000,
}, () => {
  test("copied Documents become files added on their own, in the data folder, keeping their Tags, Minds and Citations", async () => {
    const dataDir = await copyLayoutDataFolder();
    const legacy = join(dataDir, "documents", `${HASH}.md`);

    const core = startCore(dataDir);

    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({
        id: DOCUMENT,
        name: "Tide notes",
        contentHash: HASH,
        // Named with its kind's extension, so another app can open it.
        path: legacy,
        fileStatus: "available",
        linkedFolderId: null,
        folderId: null,
        tags: [expect.objectContaining({ tagId: TAG, source: "user" })],
      }),
    ]);
    expect(existsSync(storedFile(dataDir, HASH))).toBe(false);
    expect(existsSync(legacy)).toBe(true);
    // Each Passage and page is of the version it was built from.
    expect(queryDatabase(dataDir, "SELECT content_hash FROM passages")).toEqual([
      { content_hash: HASH },
    ]);
    expect(queryDatabase(dataDir, "SELECT content_hash FROM document_pages")).toEqual([
      { content_hash: HASH },
    ]);
    // The Mind and its Citation are as they were, and the Citation still checks.
    const { state } = await core.openMind(MIND);
    expect(citationsIn(state)).toEqual([
      expect.objectContaining({ documentId: DOCUMENT, contentHash: HASH, check: "found" }),
    ]);
    expect(
      await core.recheckCitation({
        mindId: null,
        documentId: DOCUMENT,
        quote: "Spring tides happen at new moon and at full moon.",
        pageFrom: null,
        pageTo: null,
      }),
    ).toMatchObject({ check: "found", contentHash: HASH });
    const file = await core.openDocumentFile(DOCUMENT);
    expect(await new Response(file.stream).text()).toBe(NOTES);
  });

  test("the in-app Folders are dropped: their Documents are unfiled, and a Search scope naming one finds it deleted", async () => {
    const dataDir = await copyLayoutDataFolder();

    const core = startCore(dataDir);

    expect(await core.listFolders()).toEqual([]);
    await expect(core.listDocuments({ folderId: FOLDER })).rejects.toThrow(NotFoundError);
    expect(
      queryDatabase<{ deleted: number }>(
        dataDir,
        "SELECT deleted_at IS NOT NULL AS deleted FROM folders WHERE id = ?",
        [FOLDER],
      ),
    ).toEqual([{ deleted: 1 }]);
    // The Question still names the Folder; the editor shows it as a deleted Folder.
    const { state } = await core.openMind(MIND);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const question = doc.getXmlFragment(MIND_CONTENT_FIELD).get(0) as Y.XmlElement;
    expect(question.getAttribute("scopeFolderIds")).toEqual([FOLDER]);
  });

  test("linking the folder the original is in relinks the Document: same id, and the copy goes", async () => {
    const dataDir = await copyLayoutDataFolder();
    const papers = await createSourceFolder();
    const original = await writeSourceFile(papers, "Tide notes.md", NOTES);
    const core = startCore(dataDir);

    await core.addLinkedFolder(papers);
    await core.reconcileDocuments();

    const [document] = await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([
        expect.objectContaining({
          id: DOCUMENT,
          path: original,
          linkedFolderId: expect.any(String),
          tags: [expect.objectContaining({ tagId: TAG })],
        }),
      ]);
    });
    expect(document?.contentHash).toBe(HASH);
    expect(existsSync(join(dataDir, "documents", `${HASH}.md`))).toBe(false);
    expect(citationsIn((await core.openMind(MIND)).state)[0]).toMatchObject({
      documentId: DOCUMENT,
    });
  });
});

// The old layout's delete removed the copy, unless a live Document had the same hash.
const deletedEarlier =
  (id: string, contentHash: string, deletedAt: string, kind = "markdown") =>
  (db: Database) =>
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, processing_version,
       tagging_status, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Old tide notes', ?, ?, 'ready', ?, 'tagged', ?, ?, ?)`,
      [
        id,
        contentHash,
        kind,
        Buffer.byteLength(NOTES),
        BigInt(PROCESSING_VERSION),
        deletedAt,
        deletedAt,
        deletedAt,
      ],
    );

const OLD_DOCUMENT = "3d1c9b7a-5e2f-4a8b-9c6d-7e0f1a2b3c4d";

describe("A copied Document in Recently deleted (#1432)", { timeout: 30_000 }, () => {
  const copyIn = (dataDir: string) => join(dataDir, "documents", `${HASH}.md`);
  const restore = (core: Core, id = DOCUMENT) => core.restore([{ kind: "document", id }]);
  const opened = async (core: Core, id = DOCUMENT) =>
    new Response((await core.openDocumentFile(id)).stream).text();

  test("its copy stays while it waits, so Undo brings it back with a file that opens, twice over", async () => {
    const dataDir = await copyLayoutDataFolder();
    const core = startCore(dataDir);
    await core.renameDocument(DOCUMENT, "潮汐笔记");

    await core.deleteDocument(DOCUMENT);

    expect(existsSync(copyIn(dataDir))).toBe(true);
    expect(await core.listDeleted()).toEqual([
      expect.objectContaining({ kind: "document", id: DOCUMENT, name: "潮汐笔记" }),
    ]);
    await restore(core);
    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({
        id: DOCUMENT,
        name: "潮汐笔记",
        path: copyIn(dataDir),
        fileStatus: "available",
        tags: [expect.objectContaining({ tagId: TAG })],
      }),
    ]);
    expect(await opened(core)).toBe(NOTES);

    await core.deleteDocument(DOCUMENT);
    await expect(core.deleteDocument(DOCUMENT)).rejects.toThrow(NotFoundError);
    await restore(core);
    await restore(core);
    expect(await opened(core)).toBe(NOTES);
  });

  test("deleted permanently, its copy goes", async () => {
    const dataDir = await copyLayoutDataFolder();
    const core = startCore(dataDir);
    await core.deleteDocument(DOCUMENT);

    await core.deletePermanently([{ kind: "document", id: DOCUMENT }]);

    expect(existsSync(copyIn(dataDir))).toBe(false);
    expect(await core.listDeleted()).toEqual([]);
  });

  test("after 30 days in Recently deleted, its copy goes at the next start", async () => {
    const dataDir = await copyLayoutDataFolder();
    const clock = manualClock();
    const before = startCore(dataDir, { now: clock.now });
    await before.deleteDocument(DOCUMENT);
    before.close();
    clock.advance(31 * DAY);

    const core = startCore(dataDir, { now: clock.now });

    await vi.waitFor(() => expect(existsSync(copyIn(dataDir))).toBe(false));
    expect(await core.listDeleted()).toEqual([]);
  });

  test("a quit after Delete permanently, before its copy went: the copy goes at the next start", async () => {
    const dataDir = await copyLayoutDataFolder();
    const before = startCore(dataDir);
    await before.deleteDocument(DOCUMENT);
    before.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET purged_at = ? WHERE id = ?", [
        new Date().toISOString(),
        DOCUMENT,
      ]);
    } finally {
      db.close();
    }

    startCore(dataDir);

    await vi.waitFor(() => expect(existsSync(copyIn(dataDir))).toBe(false));
  });

  test("a copy another Document still has stays when one of them is deleted for good", async () => {
    // Deleted before the upgrade and then added again: both are the one copy.
    const dataDir = await copyLayoutDataFolder(
      deletedEarlier(OLD_DOCUMENT, HASH, "2026-09-01T09:00:00.000Z"),
    );

    const core = startCore(dataDir);

    expect(
      queryDatabase(
        dataDir,
        "SELECT id, path, purged_at IS NOT NULL AS purged FROM documents ORDER BY id",
      ),
    ).toEqual([
      { id: OLD_DOCUMENT, path: copyIn(dataDir), purged: 1 },
      { id: DOCUMENT, path: copyIn(dataDir), purged: 0 },
    ]);
    await core.deletePermanently([{ kind: "document", id: OLD_DOCUMENT }]);
    expect(existsSync(copyIn(dataDir))).toBe(true);
    expect(await opened(core)).toBe(NOTES);
  });

  test("a copy a live Document of another kind has stays its own, also when the other is deleted for good", async () => {
    // The same bytes deleted as a text file before the upgrade, then added again as Markdown.
    const dataDir = await copyLayoutDataFolder(
      deletedEarlier(OLD_DOCUMENT, HASH, new Date(Date.now() - DAY).toISOString(), "text"),
    );

    const core = startCore(dataDir);

    expect(await opened(core)).toBe(NOTES);
    await core.deletePermanently([{ kind: "document", id: OLD_DOCUMENT }]);
    expect(existsSync(copyIn(dataDir))).toBe(true);
    expect(await opened(core)).toBe(NOTES);
  });

  test("a copy added again as a Document stays when the old one is deleted for good, with the data folder reached through a link", async () => {
    const dataDir = await copyLayoutDataFolder();
    const link = join(await createTempDataFolder(), "IncarnaMind");
    await symlink(dataDir, link);
    const core = startCore(link);
    await core.deleteDocument(DOCUMENT);
    const {
      documents: [again],
    } = await core.addDocuments([join(link, "documents", `${HASH}.md`)]);
    if (!again) throw new Error("The copy wasn't added.");
    expect(again.id).not.toBe(DOCUMENT);

    await core.deletePermanently([{ kind: "document", id: DOCUMENT }]);

    expect(await opened(core, again.id)).toBe(NOTES);
  });

  test("a file of the User's in the data folder is never removed by the purge: a Linked folder's there, or one kept when its folder was unlinked", async () => {
    const dataDir = await copyLayoutDataFolder();
    const core = startCore(dataDir);
    const papers = await createSourceFolder();
    const original = await writeSourceFile(papers, "Tide notes.md", NOTES);
    await core.addLinkedFolder(papers);
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([expect.objectContaining({ id: DOCUMENT, path: original })]);
    });
    const kept = join(dataDir, "documents", "Kept");
    const neap = await writeSourceFile(
      kept,
      "Neap tides.md",
      "# Neap tides\n\nNeap tides come at the quarter moons.\n",
    );
    const king = await writeSourceFile(
      kept,
      "King tides.md",
      "# King tides\n\nThe highest tides.\n",
    );
    const linked = await linkAndProcess(core, kept);
    const neapId = linked.find((each) => each.path.endsWith("Neap tides.md"))?.id;
    const kingId = linked.find((each) => each.path.endsWith("King tides.md"))?.id;
    if (!neapId || !kingId)
      throw new Error("The Linked folder inside the data folder wasn't read.");

    await core.deleteDocuments([DOCUMENT, neapId]);
    const [folder] = (await core.listLinkedFolders()).filter((each) => each.path.endsWith("Kept"));
    if (!folder) throw new Error("The Linked folder inside the data folder isn't there.");
    await core.removeLinkedFolder(folder.id, { keep: [kingId] });
    await core.deleteDocument(kingId);
    await core.deletePermanently([
      { kind: "document", id: DOCUMENT },
      { kind: "document", id: neapId },
      { kind: "document", id: kingId },
    ]);

    expect(await readFile(original, "utf8")).toBe(NOTES);
    expect(existsSync(neap)).toBe(true);
    expect(existsSync(king)).toBe(true);
  });

  test("many deleted and restored together all keep their copies", async () => {
    const tables = Array.from({ length: 300 }, (_, at) => ({
      id: `00000000-0000-4000-8000-${String(at).padStart(12, "0")}`,
      text: `# Tide table ${at}\n\nHigh water at ${at}:00.\n`,
    }));
    const ids = tables.map((table) => table.id);
    const dataDir = await copyLayoutDataFolder((db) => {
      for (const { id, text } of tables) {
        db.run(
          `INSERT INTO documents (id, content_hash, name, kind, size, status, processing_version,
             tagging_status, created_at, updated_at)
           VALUES (?, ?, 'Tide table', 'markdown', ?, 'ready', ?, 'tagged', ?, ?)`,
          [id, sha256(text), Buffer.byteLength(text), BigInt(PROCESSING_VERSION), AT, AT],
        );
      }
    });
    await Promise.all(tables.map(({ text }) => writeFile(storedFile(dataDir, sha256(text)), text)));
    const core = startCore(dataDir);

    await core.deleteDocuments(ids);
    await core.restore(ids.map((id) => ({ kind: "document" as const, id })));

    const restored = (await core.listDocuments()).filter((each) => ids.includes(each.id));
    expect(restored).toHaveLength(tables.length);
    expect(
      restored.filter((each) => each.fileStatus !== "available" || !existsSync(each.path)),
    ).toEqual([]);
    for (const { id, text } of tables.slice(-2)) expect(await opened(core, id)).toBe(text);
  });

  test("one whose copy an earlier build removed at delete comes back missing, keeping its text, and Locate file… finds its file", async () => {
    const dataDir = await copyLayoutDataFolder();
    const core = startCore(dataDir);
    await core.deleteDocument(DOCUMENT);
    await rm(copyIn(dataDir));

    await restore(core);

    await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([
        expect.objectContaining({
          id: DOCUMENT,
          fileStatus: "missing",
          tags: [expect.objectContaining({ tagId: TAG })],
        }),
      ]);
    });
    await expect(core.openDocumentFile(DOCUMENT)).rejects.toThrow(NotFoundError);
    expect(
      await core.recheckCitation({
        mindId: null,
        documentId: DOCUMENT,
        quote: "Spring tides happen at new moon and at full moon.",
        pageFrom: null,
        pageTo: null,
      }),
    ).toMatchObject({ check: "found", contentHash: HASH });
    // Locate file… adds the file the User picks: the original, moved since it was copied.
    const original = await writeSourceFile(await createSourceFolder(), "潮汐 notes.md", NOTES);
    const { documents } = await core.addDocuments([original]);
    expect(documents).toEqual([
      expect.objectContaining({ id: DOCUMENT, path: original, fileStatus: "available" }),
    ]);
    expect(await opened(core)).toBe(NOTES);
  });

  test("one an earlier build restored without its copy shows missing at the next start, until its original's folder is linked", async () => {
    const dataDir = await copyLayoutDataFolder();
    startCore(dataDir).close();
    await rm(copyIn(dataDir));

    const core = startCore(dataDir);
    await core.reconcileDocuments();

    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({ id: DOCUMENT, fileStatus: "missing" }),
    ]);
    const papers = await createSourceFolder();
    const original = await writeSourceFile(papers, "Tide notes.md", NOTES);
    await core.addLinkedFolder(papers);
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([
        expect.objectContaining({
          id: DOCUMENT,
          path: original,
          linkedFolderId: expect.any(String),
          fileStatus: "available",
          tags: [expect.objectContaining({ tagId: TAG })],
        }),
      ]);
    });
  });

  test("one deleted before the upgrade can be restored: it comes back missing, as the old delete removed its copy", async () => {
    const oldHash = sha256("Neap tides come between.");
    const dataDir = await copyLayoutDataFolder(
      deletedEarlier(OLD_DOCUMENT, oldHash, new Date(Date.now() - DAY).toISOString()),
    );
    const core = startCore(dataDir);
    expect(await core.listDeleted()).toEqual([
      expect.objectContaining({ kind: "document", id: OLD_DOCUMENT, name: "Old tide notes" }),
    ]);

    await restore(core, OLD_DOCUMENT);

    await waitForDocuments(core, (documents) => {
      expect(documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: OLD_DOCUMENT,
            path: join(dataDir, "documents", oldHash),
            fileStatus: "missing",
          }),
        ]),
      );
    });
  });
});
