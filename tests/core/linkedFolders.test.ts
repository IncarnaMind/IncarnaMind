import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Core,
  type Document,
  type Embedder,
  type Folder,
  InvalidInputError,
  NotFoundError,
  type WatchListener,
} from "../../src/core";
import { suggestLayout } from "../../src/core/documents/library";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  documentAt,
  linkAndProcess,
  sha256,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import { buildPdf } from "../helpers/pdf";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TIDES = "Spring tides happen at new moon and at full moon.\n";
const NEAP = "Neap tides are the smallest of the month, at the quarter moons.\n";
const RIVERS = "Rivers carry silt down to the delta.\n";

/** The Folder at a relative path in a Linked folder. */
const folderAt = (folders: readonly Folder[], relativePath: string) => {
  const folder = folders.find((each) => each.relativePath === relativePath);
  if (!folder) throw new Error(`No Folder at "${relativePath}".`);
  return folder;
};

const pathsOf = (documents: readonly Document[]) => documents.map((each) => each.path).sort();

/** Every file and folder under `root`, with its size, modified time and content hash. */
async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (folder: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name);
      const info = await lstat(path);
      if (info.isDirectory()) {
        entries.push(`${path}/ ${info.mtimeMs}`);
        await visit(path);
      } else {
        const hash = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        entries.push(`${path} ${info.size} ${info.mtimeMs} ${info.mode} ${hash}`);
      }
    }
  };
  await visit(root);
  return entries;
}

describe("Linking a folder", { timeout: 30_000 }, () => {
  test("indexes every supported file in it, at any depth, where it is, with its folders as Folders", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    const top = await writeSourceFile(library, "Top.md", `# Top\n\n${TIDES}`);
    const deep = await writeSourceFile(library, "Papers/2026/Deep.txt", NEAP);
    const shallow = await writeSourceFile(library, "Papers/Shallow.md", RIVERS);
    // Left out: unsupported, hidden, .git and node_modules.
    await writeSourceFile(library, "Papers/figure.png", "not a Document");
    await writeSourceFile(library, ".hidden/Secret.md", "hidden");
    await writeSourceFile(library, "Papers/.draft.md", "a hidden file");
    await writeSourceFile(library, ".git/notes.txt", "git");
    await writeSourceFile(library, "code/node_modules/pkg/README.md", "a package");
    const core = startCore(dataDir);

    const linked = await core.addLinkedFolder(library);
    expect(linked).toMatchObject({
      path: library,
      status: "scanning",
      folderId: expect.any(String),
    });
    const documents = await linkAndProcess(core, library);

    expect(pathsOf(documents)).toEqual([deep, shallow, top].sort());
    for (const document of documents) {
      expect(document).toMatchObject({
        linkedFolderId: linked.id,
        fileStatus: "available",
        status: "ready",
      });
    }
    expect(documentAt(documents, deep)).toMatchObject({ name: "Deep", contentHash: sha256(NEAP) });
    // Its folders are Folders, as on disk; only those holding a Document.
    const folders = await core.listFolders();
    expect(folders.map((folder) => folder.relativePath).sort()).toEqual([
      "",
      "Papers",
      "Papers/2026",
    ]);
    const root = folderAt(folders, "");
    const papers = folderAt(folders, "Papers");
    const year = folderAt(folders, "Papers/2026");
    expect(root).toMatchObject({ id: linked.folderId, name: basename(library), parentId: null });
    expect(papers).toMatchObject({ name: "Papers", parentId: root.id, linkedFolderId: linked.id });
    expect(year).toMatchObject({ name: "2026", parentId: papers.id });
    for (const folder of folders) expect(folder.id).toMatch(UUID);
    expect(documentAt(documents, top).folderId).toBe(root.id);
    expect(documentAt(documents, deep).folderId).toBe(year.id);
    const inPapers = await core.listDocuments({ folderId: papers.id, includeSubfolders: true });
    expect(pathsOf(inPapers)).toEqual([deep, shallow].sort());
    expect(await core.listDocuments({ linkedFolderId: null })).toEqual([]);
    expect(pathsOf(await core.listDocuments({ linkedFolderId: linked.id }))).toHaveLength(3);
    // Nothing is copied into the data folder.
    expect(existsSync(join(dataDir, "documents"))).toBe(false);
    expect(await core.listLinkedFolders()).toEqual([
      expect.objectContaining({
        id: linked.id,
        status: "watching",
        layout: "tree",
        progress: { files: 3, indexed: 3 },
        onlineOnly: { files: 0, bytes: 0, downloading: false },
      }),
    ]);
    expect((await core.searchPassages("Neap", { mode: "keyword" }))[0]?.documentId).toBe(
      documentAt(documents, deep).id,
    );
  });

  test("a Folder's id is derived from its Linked folder and path, so it is the same after a restart", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    await writeSourceFile(library, "A/B/notes.md", TIDES);
    const first = startCore(dataDir);
    await linkAndProcess(first, library);
    const before = await first.listFolders();
    first.close();

    const second = startCore(dataDir);
    await second.reconcileDocuments();

    expect(await second.listFolders()).toEqual(before);
  });

  test("a preview counts the files and bytes, and suggests the layout, without indexing anything", async () => {
    const library = await createSourceFolder();
    // Zotero's storage: one folder per item, each with one file (and its hidden cache).
    const pdf = buildPdf([{ lines: ["A paper about tides."] }]);
    const keys = Array.from({ length: 20 }, (_, index) => `KEY${String(index).padStart(5, "0")}`);
    for (const key of keys) {
      await writeSourceFile(library, `storage/${key}/paper.pdf`, pdf);
      await writeSourceFile(library, `storage/${key}/.zotero-ft-cache`, "cache");
    }
    const core = startCore(await createTempDataFolder());

    const preview = await core.previewLinkedFolder(join(library, "storage"));

    expect(preview).toEqual({
      path: join(library, "storage"),
      files: 20,
      bytes: pdf.byteLength * 20,
      onlineOnly: { files: 0, bytes: 0 },
      // Nothing has been read on this computer yet, so there is no telling how long it takes.
      estimatedSeconds: null,
      layout: "flat",
      insideLinkedFolderId: null,
      containsLinkedFolderIds: [],
    });
    expect(await core.listDocuments()).toEqual([]);
    expect(await core.listLinkedFolders()).toEqual([]);

    // Linked, it gets that layout, and the User can change it.
    const linked = await core.addLinkedFolder(join(library, "storage"));
    await core.reconcileDocuments();
    expect((await core.listLinkedFolders())[0]?.layout).toBe("flat");
    expect(await core.setLinkedFolderLayout(linked.id, "tree")).toMatchObject({ layout: "tree" });
    await expect(core.setLinkedFolderLayout(linked.id, "grid" as never)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.previewLinkedFolder(join(library, "nowhere"))).rejects.toThrow(NotFoundError);
    await expect(core.addLinkedFolder("relative/path")).rejects.toThrow(InvalidInputError);
  });

  test("a preview says how long reading takes once files of its kinds have been read on this computer (#1506)", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const notes = join(sources, "Notes");
    const more = join(sources, "More");
    for (const [index, line] of [TIDES, NEAP, RIVERS].entries()) {
      await writeSourceFile(notes, `Note ${index}.md`, `# Note ${index}\n\n${line}`);
      await writeSourceFile(more, `More ${index}.md`, `# More ${index}\n\n${line}`);
    }
    await writeSourceFile(sources, "Papers/tides.pdf", buildPdf([{ lines: ["Spring tides."] }]));
    const estimate = async (core: Core, folder: string) =>
      (await core.previewLinkedFolder(folder)).estimatedSeconds;
    const first = startCore(dataDir);
    expect(await estimate(first, notes)).toBeNull();

    await linkAndProcess(first, notes);

    expect(await estimate(first, more)).toEqual(expect.any(Number));
    // No PDF has been read here yet.
    expect(await estimate(first, sources)).toBeNull();
    first.close();
    // It is this computer's, and kept.
    const core = startCore(dataDir);
    expect(await estimate(core, more)).toEqual(expect.any(Number));

    // Embedding is part of reading, so it takes another time, measured afresh.
    await turnOnEmbeddings(core);
    expect(await estimate(core, more)).toBeNull();
    await linkAndProcess(core, more);
    expect(await estimate(core, notes)).toEqual(expect.any(Number));
  });

  test("a Document whose embedding stopped part way doesn't count: its last turn took only the rest (#1506)", async () => {
    const fake = createFakeEmbedder();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const atSecond = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let long = 0;
    // Holds the long note's second Passage, once, so its folder can be paused meanwhile.
    const embedder: Embedder = {
      load: (files) => fake.load(files),
      embed: async (text) => {
        if (text.includes("Sentence") && ++long === 2) {
          reached();
          await gate;
        }
        return fake.embed(text);
      },
      close: () => fake.close(),
    };
    const sources = await createSourceFolder();
    const notes = join(sources, "Notes");
    const text = Array.from(
      { length: 200 },
      (_, index) => `Sentence ${index} is about tides and the moon.`,
    ).join(" ");
    // Read newest first: the short note on a new worker, which doesn't count, then the long one.
    const longPath = await writeSourceFile(notes, "Long.md", text);
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(longPath, hourAgo, hourAgo);
    await writeSourceFile(notes, "Short.md", `# Short\n\n${TIDES}`);
    await writeSourceFile(join(sources, "More"), "Copy.md", text);
    const core = startCore(await createTempDataFolder(), { embedder });
    await turnOnEmbeddings(core);

    const linked = await core.addLinkedFolder(notes);
    await atSecond;
    await core.setLinkedFolderPaused(linked.id, true);
    release();
    const longOne = async () =>
      (await core.listDocuments()).find((document) => document.name === "Long")?.status;
    await expect.poll(longOne).not.toBe("embedding");
    await core.setLinkedFolderPaused(linked.id, false);
    const documents = await core.listDocuments({ linkedFolderId: linked.id });
    await waitForProcessing(
      core,
      documents.map((document) => document.id),
    );

    expect(await longOne()).toBe("ready");
    expect((await core.previewLinkedFolder(join(sources, "More"))).estimatedSeconds).toBeNull();
  });

  test("only a big library of one-file folders starts flat; a small one keeps its folders", () => {
    const zotero = (items: number) =>
      Array.from({ length: items }, (_, index) => `KEY${index}/paper.pdf`);
    expect(suggestLayout(zotero(20))).toBe("flat");
    expect(suggestLayout([...zotero(20), "KEY0/supplement.pdf", "KEY1/supplement.pdf"])).toBe(
      "flat",
    );
    // Three one-file folders, or nineteen, is someone's own filing: shown as folders.
    expect(suggestLayout(zotero(3))).toBe("tree");
    expect(suggestLayout(zotero(19))).toBe("tree");
    // Twenty folders, but many with several files: folders.
    expect(
      suggestLayout([...zotero(20), ...zotero(5).map((path) => path.replace("paper", "notes"))]),
    ).toBe("tree");
    expect(suggestLayout(["a.pdf", "b.pdf"])).toBe("tree");
  });

  test("new files are indexed newest first, and files modified at the same moment in the order of their paths", async () => {
    const library = await createSourceFolder();
    // Three share a modified time, as files do on a file system that keeps times coarsely,
    // or when copied in together. A folder's files are listed before a file named like it
    // ("Tides" before "Tides 2025.txt"), but by path the file comes first.
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
    const files: [string, Date][] = [
      ["Kitchen/Recipes.txt", at(0)],
      ["Tides/Spring.txt", at(5)],
      ["Tides 2025.txt", at(5)],
      ["Almanac.txt", at(5)],
      ["Coast/Delta.txt", at(9)],
    ];
    for (const [name, time] of files) {
      await utimes(await writeSourceFile(library, name, `${name}: the tide turned.\n`), time, time);
    }
    const core = startCore(await createTempDataFolder());

    await linkAndProcess(core, library);

    // Listed as added, the most recent first: the reverse of the order they were indexed in.
    const listed = await core.listDocuments({
      linkedFolderId: (await core.listLinkedFolders())[0]?.id,
    });
    expect(listed.map((document) => document.name).reverse()).toEqual([
      "Delta",
      "Almanac",
      "Tides 2025",
      "Spring",
      "Recipes",
    ]);
  });

  test("a Document holds its file's own modified time, and a rescan keeps it current", async () => {
    const library = await createSourceFolder();
    const early = new Date(Date.UTC(2024, 1, 3, 8, 0));
    const late = new Date(Date.UTC(2026, 5, 7, 18, 30));
    const old = await writeSourceFile(library, "Old.txt", "The tide turned.\n");
    const recent = await writeSourceFile(library, "Recent.txt", "The tide rose.\n");
    await utimes(old, early, early);
    await utimes(recent, late, late);
    const core = startCore(await createTempDataFolder());

    const documents = await linkAndProcess(core, library);

    expect(documentAt(documents, old).modifiedAt).toBe(early.toISOString());
    expect(documentAt(documents, recent).modifiedAt).toBe(late.toISOString());
    // Touched without a change to what it says: the time follows the file.
    const touched = new Date(Date.UTC(2026, 8, 1, 12, 0));
    await utimes(old, touched, touched);
    await core.reconcileDocuments();
    await waitForDocuments(core, (current) => {
      expect(documentAt(current, old).modifiedAt).toBe(touched.toISOString());
    });
    core.close();
  });

  test("a folder inside a Linked folder is linked already; one around Linked folders takes them in, their Documents keeping their ids", async () => {
    const outer = await createSourceFolder();
    const inner = join(outer, "Inner");
    await writeSourceFile(inner, "a.md", TIDES);
    await writeSourceFile(outer, "b.md", NEAP);
    const core = startCore(await createTempDataFolder());
    const [a] = await linkAndProcess(core, inner);
    const innerFolder = (await core.listLinkedFolders())[0];
    if (!a || !innerFolder) throw new Error("Nothing was linked.");

    // Inside: nothing new.
    await mkdir(join(inner, "Deeper"));
    expect((await core.addLinkedFolder(join(inner, "Deeper"))).id).toBe(innerFolder.id);
    expect(await core.previewLinkedFolder(inner)).toMatchObject({
      insideLinkedFolderId: innerFolder.id,
    });
    expect(await core.previewLinkedFolder(outer)).toMatchObject({
      containsLinkedFolderIds: [innerFolder.id],
    });

    // Around: merged into one.
    const documents = await linkAndProcess(core, outer);
    const linked = await core.listLinkedFolders();
    expect(linked.map((each) => each.path)).toEqual([outer]);
    const outerId = linked[0]?.id;
    expect(documentAt(documents, a.path)).toMatchObject({ id: a.id, linkedFolderId: outerId });
    const folders = await core.listFolders();
    expect(folders.map((folder) => folder.relativePath).sort()).toEqual(["", "Inner"]);
    expect(documentAt(documents, a.path).folderId).toBe(folderAt(folders, "Inner").id);
  });

  test("a file added on its own is in no Folder, and becomes a Linked folder's Document, keeping its id, once it is in one", async () => {
    const library = await createSourceFolder();
    const elsewhere = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const [single] = await addAndProcess(core, [await writeSourceFile(library, "notes.md", TIDES)]);
    if (!single) throw new Error("Nothing was added.");
    expect(single).toMatchObject({ linkedFolderId: null, folderId: null, fileStatus: "available" });
    expect(await core.listDocuments({ linkedFolderId: null })).toEqual([single]);

    const documents = await linkAndProcess(core, library);

    const linked = (await core.listLinkedFolders())[0];
    expect(documents).toEqual([
      expect.objectContaining({
        id: single.id,
        linkedFolderId: linked?.id,
        folderId: linked?.folderId,
      }),
    ]);
    expect(await core.listDocuments({ linkedFolderId: null })).toEqual([]);
    // Added on its own from inside a Linked folder, a file is that folder's Document.
    const other = await writeSourceFile(elsewhere, "other.md", NEAP);
    const inside = await writeSourceFile(library, "Sub/inside.md", RIVERS);
    const { documents: added } = await core.addDocuments([inside, other]);
    expect(added.map((each) => each.linkedFolderId)).toEqual([linked?.id, null]);
  });

  // protects=Undo of a link (#1361) unlinks it but keeps the Documents that were there before, as files added on their own with their ids; fails_when=a kept Document goes, or stays in the gone Linked folder; no_claim=the window's Undo step.
  test("unlinking a folder keeps the Documents asked for, as files added on their own", async () => {
    const library = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const [single] = await addAndProcess(core, [await writeSourceFile(library, "notes.md", TIDES)]);
    if (!single) throw new Error("Nothing was added.");
    await writeSourceFile(library, "b.md", NEAP);
    await linkAndProcess(core, library);
    const linked = (await core.listLinkedFolders())[0];
    if (!linked) throw new Error("Nothing was linked.");

    await core.removeLinkedFolder(linked.id, { keep: [single.id] });

    expect(await core.listLinkedFolders()).toEqual([]);
    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({ id: single.id, linkedFolderId: null, folderId: null }),
    ]);
  });

  // protects=a merge's Undo (#1361) links the inner folder again and its Undo at once unlinks it with its files; fails_when=a file added on its own inside a newly linked folder stays on its own until the first scan; no_claim=what the scan reads.
  test("a folder linked takes the files added on their own inside it at once, keeping their ids", async () => {
    const library = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    const [single] = await addAndProcess(core, [
      await writeSourceFile(library, "A/notes.md", TIDES),
    ]);
    if (!single) throw new Error("Nothing was added.");

    const linked = await core.addLinkedFolder(library);

    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({ id: single.id, linkedFolderId: linked.id }),
    ]);
    await core.removeLinkedFolder(linked.id);
    expect(await core.listDocuments()).toEqual([]);
  });

  test("unlinking a folder removes its Documents and Folders from the index", async () => {
    const library = await createSourceFolder();
    await writeSourceFile(library, "A/a.md", TIDES);
    await writeSourceFile(library, "b.md", NEAP);
    const core = startCore(await createTempDataFolder());
    const documents = await linkAndProcess(core, library);
    const linked = (await core.listLinkedFolders())[0];
    if (!linked) throw new Error("Nothing was linked.");
    const removed: string[][] = [];
    core.on("documents.removed", (ids) => removed.push(ids));

    await core.removeLinkedFolder(linked.id);

    expect(await core.listDocuments()).toEqual([]);
    expect(await core.listFolders()).toEqual([]);
    expect(await core.listLinkedFolders()).toEqual([]);
    expect(await core.searchPassages("tides", { mode: "keyword" })).toEqual([]);
    expect(removed.flat().sort()).toEqual(documents.map((each) => each.id).sort());
    await expect(core.removeLinkedFolder(linked.id)).rejects.toThrow(NotFoundError);
    // Linked again, its files are indexed again.
    expect(pathsOf(await linkAndProcess(core, library))).toEqual(pathsOf(documents));
  });

  test("linking, reconciling, restarting and unlinking leave the folder byte for byte as it was", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    await writeSourceFile(library, "Report.pdf", buildPdf([{ lines: ["Quarterly tides"] }]));
    await writeSourceFile(library, "Notes/notes.md", TIDES);
    await writeSourceFile(library, "Notes/.hidden.md", "hidden");
    await writeSourceFile(library, "Notes/data.csv", "a,b\n1,2\n");
    await writeSourceFile(library, ".git/config", "[core]\n");
    const before = await snapshot(library);

    const first = startCore(dataDir);
    await linkAndProcess(first, library);
    await first.reconcileDocuments();
    const opened = await first.openDocumentFile((await first.listDocuments())[0]?.id as string);
    await opened.stream.cancel();
    first.close();
    const second = startCore(dataDir);
    await second.reconcileDocuments();
    const linked = (await second.listLinkedFolders())[0];
    await second.removeLinkedFolder(linked?.id as string);
    second.close();

    expect(await snapshot(library)).toEqual(before);
  });
});

describe("While the app runs, a Linked folder is watched", { timeout: 30_000 }, () => {
  test("a new file is indexed, an edited one indexed again as a new version, and a deleted one goes missing", async () => {
    const library = await createSourceFolder();
    const tides = await writeSourceFile(library, "tides.md", TIDES);
    const rivers = await writeSourceFile(library, "Sub/rivers.md", RIVERS);
    const core = startCore(await createTempDataFolder());
    const linked = await linkAndProcess(core, library);
    const before = { tides: documentAt(linked, tides), rivers: documentAt(linked, rivers) };

    // New.
    const neap = await writeSourceFile(library, "Sub/neap.md", NEAP);
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, neap)).toMatchObject({
        status: "ready",
        contentHash: sha256(NEAP),
      });
    });
    // Edited: a new version, processed, replaces the old one in search.
    const edited = `${TIDES}Perigean spring tides are the highest.\n`;
    await writeSourceFile(library, "tides.md", edited);
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, tides)).toMatchObject({
        id: before.tides.id,
        status: "ready",
        contentHash: sha256(edited),
      });
    });
    expect(await core.searchPassages("Perigean", { mode: "keyword" })).toHaveLength(1);
    // Deleted: missing, kept, left out of new searches.
    await rm(rivers);
    const afterDelete = await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, rivers).fileStatus).toBe("missing");
    });
    expect(documentAt(afterDelete, rivers)).toMatchObject({
      id: before.rivers.id,
      status: "ready",
    });
    expect(await core.searchPassages("silt", { mode: "keyword" })).toEqual([]);
    expect(
      await core.searchPassages("silt", { mode: "keyword", documentIds: [before.rivers.id] }),
    ).toEqual([]);
    expect((await core.readDocumentText(before.rivers.id)).pages).toEqual([
      { page: 1, text: RIVERS.trim(), kind: "section", label: { path: [] } },
    ]);
    await expect(core.openDocumentFile(before.rivers.id)).rejects.toThrow(NotFoundError);
    // Back with the same content: not missing any more.
    await writeSourceFile(library, "Sub/rivers.md", RIVERS);
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, rivers)).toMatchObject({
        id: before.rivers.id,
        fileStatus: "available",
      });
    });
    expect(await core.searchPassages("silt", { mode: "keyword" })).toHaveLength(1);
  });

  test("when a watcher fails or overflows, the whole folder is reconciled", async () => {
    const library = await createSourceFolder();
    await writeSourceFile(library, "a.md", TIDES);
    const listeners: WatchListener[] = [];
    // A watcher that reports nothing until it fails.
    const core = startCore(await createTempDataFolder(), {
      linkedFolders: {
        watch: (_root, listener) => {
          listeners.push(listener);
          return { close: () => {} };
        },
      },
    });
    await linkAndProcess(core, library);
    const missed = await writeSourceFile(library, "b.md", NEAP);
    await core
      .listDocuments()
      .then((documents) => expect(pathsOf(documents)).not.toContain(missed));

    listeners.at(-1)?.onError(new Error("Too many changes: events were dropped."));

    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, missed).status).toBe("ready");
    });
  });
});

describe("While the app runs, files added on their own are watched", { timeout: 30_000 }, () => {
  test("an edited one is indexed again, a renamed or moved one followed, and a deleted one goes missing", async () => {
    const downloads = await createSourceFolder();
    const desk = await createSourceFolder();
    const notes = await writeSourceFile(downloads, "notes.md", TIDES);
    const core = startCore(await createTempDataFolder());
    const [added] = await addAndProcess(core, [
      notes,
      await writeSourceFile(desk, "desk.md", NEAP),
    ]);
    if (!added) throw new Error("Nothing was added.");
    const current = (documents: readonly Document[]) =>
      documents.find((each) => each.id === added.id);

    // Edited: a new version, processed, without a reconcile being asked for.
    const edited = `${TIDES}Perigean spring tides are the highest.\n`;
    await writeSourceFile(downloads, "notes.md", edited);
    await waitForDocuments(core, (documents) => {
      expect(current(documents)).toMatchObject({ status: "ready", contentHash: sha256(edited) });
    });
    expect(await core.searchPassages("Perigean", { mode: "keyword" })).toHaveLength(1);

    // Renamed where it is: the same Document, its name following the file's.
    const renamed = join(downloads, "tide notes.md");
    await rename(notes, renamed);
    await waitForDocuments(core, (documents) => {
      expect(current(documents)).toMatchObject({
        path: renamed,
        name: "tide notes",
        fileStatus: "available",
        linkedFolderId: null,
      });
    });

    // Moved to the folder of another file added on its own: followed there.
    const moved = join(desk, "tide notes.md");
    await rename(renamed, moved);
    await waitForDocuments(core, (documents) => {
      expect(current(documents)).toMatchObject({ path: moved, fileStatus: "available" });
    });
    expect(await core.searchPassages("Perigean", { documentIds: [added.id] })).toHaveLength(1);

    // A file that was never added, next to one that was, isn't added.
    const unrelated = await writeSourceFile(desk, "unrelated.md", RIVERS);
    // Deleted: missing, kept, and left out of new searches.
    await rm(moved);
    await waitForDocuments(core, (documents) => {
      expect(current(documents)).toMatchObject({ fileStatus: "missing", status: "ready" });
    });
    expect(pathsOf(await core.listDocuments())).not.toContain(unrelated);
    expect(await core.searchPassages("Perigean", { mode: "keyword" })).toEqual([]);
  });

  test("each folder holding one is watched, not below it, for as long as it holds one", async () => {
    const downloads = await createSourceFolder();
    const desk = await createSourceFolder();
    const library = await createSourceFolder();
    await writeSourceFile(library, "linked.md", RIVERS);
    const watched: { root: string; recursive: boolean; closed: boolean }[] = [];
    const core = startCore(await createTempDataFolder(), {
      linkedFolders: {
        watch: (root, _listener, options) => {
          const entry = { root, recursive: options?.recursive ?? true, closed: false };
          watched.push(entry);
          return {
            close: () => {
              entry.closed = true;
            },
          };
        },
      },
    });
    const open = () =>
      watched
        .filter((each) => !each.closed)
        .map((each) => ({ root: each.root, recursive: each.recursive }))
        .sort((a, b) => a.root.localeCompare(b.root));
    await linkAndProcess(core, library);
    const [, onDesk] = await addAndProcess(core, [
      await writeSourceFile(downloads, "a.md", TIDES),
      await writeSourceFile(desk, "b.md", NEAP),
    ]);

    expect(open()).toEqual(
      [
        { root: library, recursive: true },
        { root: downloads, recursive: false },
        { root: desk, recursive: false },
      ].sort((a, b) => a.root.localeCompare(b.root)),
    );

    // Its last one removed from IncarnaMind, a folder isn't watched any more.
    await core.deleteDocument(onDesk?.id as string);
    expect(open()).toEqual(
      [
        { root: library, recursive: true },
        { root: downloads, recursive: false },
      ].sort((a, b) => a.root.localeCompare(b.root)),
    );
  });
});

describe("Reconciling at a start", { timeout: 30_000 }, () => {
  test("changes made while the app was closed are found: new, edited and deleted files", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    const tides = await writeSourceFile(library, "tides.md", TIDES);
    const rivers = await writeSourceFile(library, "rivers.md", RIVERS);
    const first = startCore(dataDir);
    const before = await linkAndProcess(first, library);
    first.close();

    const neap = await writeSourceFile(library, "Sub/neap.md", NEAP);
    const edited = `${TIDES}King tides flood the quay.\n`;
    await writeSourceFile(library, "tides.md", edited);
    await rm(rivers);
    const second = startCore(dataDir);
    await second.reconcileDocuments();
    const after = await waitForProcessing(
      second,
      (await second.listDocuments()).map((each) => each.id),
    );

    expect(documentAt(after, tides)).toMatchObject({
      id: documentAt(before, tides).id,
      contentHash: sha256(edited),
      status: "ready",
    });
    expect(documentAt(after, rivers)).toMatchObject({
      id: documentAt(before, rivers).id,
      fileStatus: "missing",
    });
    expect(documentAt(after, neap).status).toBe("ready");
    expect(await second.searchPassages("King", { mode: "keyword" })).toHaveLength(1);
  });

  test("a file whose size and modified time are unchanged isn't read again", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    await writeSourceFile(library, "tides.md", TIDES);
    const first = startCore(dataDir);
    const [before] = await linkAndProcess(first, library);
    first.close();

    const second = startCore(dataDir);
    const seen: Document[] = [];
    second.on("document.status", (document) => seen.push(document));
    await second.reconcileDocuments();

    expect(seen).toEqual([]);
    expect(await second.listDocuments()).toEqual([before]);
  });

  test("files added on their own are missing when gone from their folder, unavailable when their folder is gone too", async () => {
    const dataDir = await createTempDataFolder();
    const kept = await createSourceFolder();
    const gone = await createSourceFolder();
    const first = startCore(dataDir);
    const [x, y] = await addAndProcess(first, [
      await writeSourceFile(kept, "x.md", TIDES),
      await writeSourceFile(gone, "y.md", NEAP),
    ]);
    first.close();
    await rm(join(kept, "x.md"));
    await rm(gone, { recursive: true });

    const second = startCore(dataDir);
    await second.reconcileDocuments();

    const documents = await second.listDocuments();
    expect(documents.find((each) => each.id === x?.id)?.fileStatus).toBe("missing");
    expect(documents.find((each) => each.id === y?.id)?.fileStatus).toBe("unavailable");
    // An unavailable Document stays searchable; a missing one doesn't.
    expect(
      (await second.searchPassages("tides", { mode: "keyword" })).map((each) => each.documentId),
    ).toEqual([y?.id]);
  });

  test("a Linked folder that can't be reached keeps its Documents searchable, and comes back by itself", async () => {
    const dataDir = await createTempDataFolder();
    const drive = await createSourceFolder();
    const library = join(drive, "Library");
    await writeSourceFile(library, "tides.md", TIDES);
    const first = startCore(dataDir);
    const [tides] = await linkAndProcess(first, library);
    first.close();
    // The drive is unplugged.
    await rename(library, join(drive, "Elsewhere"));

    const second = startCore(dataDir);
    await second.reconcileDocuments();

    expect(await second.listDocuments()).toEqual([
      expect.objectContaining({ id: tides?.id, fileStatus: "unavailable", status: "ready" }),
    ]);
    expect((await second.listLinkedFolders())[0]?.status).toBe("unavailable");
    expect(await second.searchPassages("tides", { mode: "keyword" })).toHaveLength(1);
    await expect(second.openDocumentFile(tides?.id as string)).rejects.toThrow(NotFoundError);

    // Plugged in again: found by the next try.
    await rename(join(drive, "Elsewhere"), library);
    await waitForDocuments(second, (documents) => {
      expect(documents[0]?.fileStatus).toBe("available");
    });
    await second.reconcileDocuments();
    expect((await second.listLinkedFolders())[0]?.status).toBe("watching");
  });
});

describe("Moves and renames", { timeout: 30_000 }, () => {
  test("a file moved or renamed is the same Document: its id, Tags and name follow it", async () => {
    const library = await createSourceFolder();
    const original = await writeSourceFile(library, "Papers/old name.md", TIDES);
    const core = startCore(await createTempDataFolder());
    const [document] = await linkAndProcess(core, library);
    if (!document) throw new Error("Nothing was linked.");
    const tag = await core.createTag({ name: "Oceans" });
    await core.addDocumentTag(document.id, tag.id);
    const moves: Document[][] = [];
    core.on("documents.moved", (moved) => moves.push(moved));

    const moved = join(library, "Archive", "new name.md");
    await mkdir(join(library, "Archive"));
    await rename(original, moved);

    const after = await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([expect.objectContaining({ id: document.id, path: moved })]);
    });
    const folders = await core.listFolders();
    expect(after[0]).toMatchObject({
      name: "new name",
      fileStatus: "available",
      folderId: folderAt(folders, "Archive").id,
      tags: [expect.objectContaining({ tagId: tag.id })],
      status: "ready",
    });
    // The Papers Folder held nothing else: it has gone.
    expect(folders.map((folder) => folder.relativePath).sort()).toEqual(["", "Archive"]);
    expect(moves.flat().map((each) => each.id)).toContain(document.id);
    // Its Passages, and so its Citations and Search scopes, follow it.
    expect(
      (await core.searchPassages("Spring", { documentIds: [document.id] }))[0]?.documentId,
    ).toBe(document.id);
    expect(
      await core.recheckCitation({
        documentId: document.id,
        quote: "Spring tides happen at new moon",
        pageFrom: null,
        pageTo: null,
      }),
    ).toMatchObject({ check: "found", contentHash: document.contentHash });

    // A name the User chose stays when the file is renamed.
    await core.renameDocument(document.id, "Tide notes");
    const renamed = join(library, "Archive", "renamed again.md");
    await rename(moved, renamed);
    await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([
        expect.objectContaining({ id: document.id, path: renamed, name: "Tide notes" }),
      ]);
    });
  });

  test("a file moved while the app was closed is found again by its content", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    await writeSourceFile(library, "A/tides.md", TIDES);
    const first = startCore(dataDir);
    const [document] = await linkAndProcess(first, library);
    first.close();
    await rename(join(library, "A"), join(library, "B"));

    const second = startCore(dataDir);
    await second.reconcileDocuments();

    expect(await second.listDocuments()).toEqual([
      expect.objectContaining({
        id: document?.id,
        path: join(library, "B", "tides.md"),
        fileStatus: "available",
      }),
    ]);
  });

  test("a file added on its own and moved into a Linked folder is the same Document", async () => {
    const library = await createSourceFolder();
    const downloads = await createSourceFolder();
    const core = startCore(await createTempDataFolder());
    await linkAndProcess(core, library);
    const [single] = await addAndProcess(core, [
      await writeSourceFile(downloads, "paper.md", NEAP),
    ]);

    await rename(join(downloads, "paper.md"), join(library, "paper.md"));

    await waitForDocuments(core, (documents) => {
      expect(documents).toEqual([
        expect.objectContaining({
          id: single?.id,
          path: join(library, "paper.md"),
          linkedFolderId: expect.any(String),
        }),
      ]);
    });
  });
});

describe("Duplicates, removals and pausing", { timeout: 30_000 }, () => {
  test("the same file in two places is two Documents, and search shows each Passage once, from the copy in the scope", async () => {
    const library = await createSourceFolder();
    const first = await writeSourceFile(library, "A/notes.md", TIDES);
    const second = await writeSourceFile(library, "B/copy of notes.md", TIDES);
    const core = startCore(await createTempDataFolder());

    const documents = await linkAndProcess(core, library);

    expect(documents).toHaveLength(2);
    const [a, b] = [documentAt(documents, first), documentAt(documents, second)];
    expect(a.contentHash).toBe(b.contentHash);
    const all = await core.searchPassages("Spring tides");
    expect(all).toHaveLength(1);
    expect(
      (await core.searchPassages("Spring tides", { documentIds: [b.id] }))[0]?.documentId,
    ).toBe(b.id);
    expect(
      (await core.searchPassages("Spring tides", { documentIds: [a.id] }))[0]?.documentId,
    ).toBe(a.id);
  });

  test("a Document the User removes from a Linked folder stays out of the index while its file is there", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    const unwanted = await writeSourceFile(library, "unwanted.md", NEAP);
    await writeSourceFile(library, "wanted.md", TIDES);
    const first = startCore(dataDir);
    const documents = await linkAndProcess(first, library);

    await first.deleteDocument(documentAt(documents, unwanted).id);
    await first.reconcileDocuments();
    expect(pathsOf(await first.listDocuments())).not.toContain(unwanted);
    first.close();
    const second = startCore(dataDir);
    await second.reconcileDocuments();

    expect(pathsOf(await second.listDocuments())).toEqual([join(library, "wanted.md")]);
    // Its file wasn't touched.
    expect(await readFile(unwanted, "utf8")).toBe(NEAP);
  });

  test("pausing a Linked folder holds its indexing until it is resumed", async () => {
    const library = await createSourceFolder();
    await writeSourceFile(library, "a.md", TIDES);
    const core = startCore(await createTempDataFolder());
    await linkAndProcess(core, library);
    const linked = (await core.listLinkedFolders())[0];
    if (!linked) throw new Error("Nothing was linked.");

    expect(await core.setLinkedFolderPaused(linked.id, true)).toMatchObject({ status: "paused" });
    const later = await writeSourceFile(library, "b.md", NEAP);
    await core.reconcileDocuments();
    expect(pathsOf(await core.listDocuments())).not.toContain(later);

    expect(await core.setLinkedFolderPaused(linked.id, false)).toMatchObject({
      status: "scanning",
    });
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, later).status).toBe("ready");
    });
    expect((await core.listLinkedFolders())[0]).toMatchObject({
      status: "watching",
      progress: { files: 2, indexed: 2 },
    });
    await expect(core.setLinkedFolderPaused(linked.id, "yes" as never)).rejects.toThrow(
      InvalidInputError,
    );
  });
});

describe("Files that can't be read now", { timeout: 30_000 }, () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a file that can't be read waits, and is indexed once it can be",
    async () => {
      const library = await createSourceFolder();
      await writeSourceFile(library, "open.md", TIDES);
      const locked = await writeSourceFile(library, "locked.md", NEAP);
      await chmod(locked, 0o000);
      const core = startCore(await createTempDataFolder());

      const documents = await linkAndProcess(core, library);
      expect(pathsOf(documents)).toEqual([join(library, "open.md")]);

      await chmod(locked, 0o644);
      await waitForDocuments(core, (listed) => {
        expect(documentAt(listed, locked).status).toBe("ready");
      });
    },
  );

  test("online-only files are counted, never read, until the User asks to download them", async (context) => {
    const library = await createSourceFolder();
    await writeSourceFile(library, "local.md", TIDES);
    // A file whose size is set but none of whose blocks are stored: a dataless placeholder.
    const placeholder = join(library, "Online.txt");
    const handle = await open(placeholder, "w");
    await handle.truncate(40_000);
    await handle.close();
    if ((await lstat(placeholder)).blocks !== 0) context.skip(); // no sparse files here
    // iCloud Drive's stub for a file that isn't downloaded.
    await writeSourceFile(library, ".Stubbed.md.icloud", "plist");
    const commands: string[][] = [];
    const core = startCore(await createTempDataFolder(), {
      linkedFolders: { detectDatalessFiles: true },
      // iCloud Drive's command-line tool, which downloads a stub's file on macOS.
      processes: {
        spawn: async (command, args) => {
          commands.push([command, ...args]);
          const child = new EventEmitter() as ChildProcess;
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      },
    });

    expect(await core.previewLinkedFolder(library)).toMatchObject({
      files: 1,
      onlineOnly: { files: 2, bytes: 40_000 },
    });
    const documents = await linkAndProcess(core, library);
    expect(pathsOf(documents)).toEqual([join(library, "local.md")]);
    const linked = (await core.listLinkedFolders())[0];
    expect(linked?.onlineOnly).toEqual({ files: 2, bytes: 40_000, downloading: false });

    await core.downloadOnlineOnlyFiles(linked?.id as string);
    await core.reconcileDocuments();

    // Read now (and downloaded, for a real placeholder). The stub's file isn't there yet:
    // on macOS, iCloud Drive was asked to download it.
    expect(pathsOf(await core.listDocuments())).toContain(placeholder);
    expect((await core.listLinkedFolders())[0]?.onlineOnly).toMatchObject({ files: 1 });
    if (process.platform === "darwin") {
      expect(commands).toEqual([["brctl", "download", join(library, "Stubbed.md")]]);
    }
  });
});

describe("Documents' files", { timeout: 30_000 }, () => {
  test("open in the default app and show in the folder through the shell, at the file's real path", async () => {
    const library = await createSourceFolder();
    const path = await writeSourceFile(library, "Report.md", TIDES);
    const opened: string[] = [];
    const shown: string[] = [];
    const core: Core = startCore(await createTempDataFolder(), {
      shell: {
        openPath: async (each) => {
          opened.push(each);
        },
        showItemInFolder: (each) => shown.push(each),
      },
    });
    const [document] = await linkAndProcess(core, library);
    if (!document) throw new Error("Nothing was linked.");

    await core.openDocumentInApp(document.id);
    await core.showDocumentInFolder(document.id);

    expect(opened).toEqual([path]);
    expect(shown).toEqual([path]);
    // A missing file can't be opened or shown.
    await rm(path);
    await core.reconcileDocuments();
    await expect(core.openDocumentInApp(document.id)).rejects.toThrow(NotFoundError);
    await expect(core.showDocumentInFolder(document.id)).rejects.toThrow(NotFoundError);
    expect(opened).toHaveLength(1);
  });
});
