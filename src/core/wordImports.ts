/**
 * Importing a Word file as a Mind (#104).
 *
 * The file is checked first (`check`), for the import screen: whether it can
 * be imported, and whether it carries someone else's tracked changes or
 * comments. Importing reads it whole, before any Mind is made, so a file that
 * can't be read is refused with nothing left behind. Then its package is kept
 * in the data folder ("Word imports/<sha256>.docx", migration 75), the Mind is
 * made, titled after the file, and its Blocks are written a batch at a time,
 * the first at once, so a long document shows as it fills in and the app stays
 * responsive; the Mind records how far it has got (`WordImportProgress`) and
 * can't be edited until it is done. An import a quit cut short goes on from
 * where it was at the next start, and one whose Mind was deleted goes on when
 * the Mind is restored: reading the kept package again gives the same Blocks.
 *
 * Each node mapped from the document records where it came from and its
 * fingerprint as imported (`WordSource`), for export to write into the
 * original (#105). Someone else's document makes its Blocks third-party text (#78).
 *
 * The original can also be added to the Library as a Document, in the Mind's
 * Folder (#720), so Answers cite the file as received: the Mind is the User's
 * working copy and is never cited. Both ends know the other: the package's
 * row names the Document (migration 86), and the Mind's Word settings do too.
 * A newer file of the same name imported into the same Folder can become a
 * new version of that Document instead.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import * as Y from "yjs";
import { recordProposalRequest } from "../shared/proposals";
import { setTextOrigin } from "../shared/textOrigins";
import {
  linkWordFileDocument,
  recordWordImportProgress,
  setWordSource,
  startWordImport,
  wordFingerprint,
  wordImportDone,
  wordOriginOf,
} from "../shared/wordFiles";
import { setWordLook, wordLookOf } from "../shared/wordLook";
import type { Logger } from "./adapters";
import { createElement } from "./answers/blocks";
import {
  BLOCK_ID_ATTRIBUTE,
  type CheckedDocument,
  DEFAULT_MIND_KIND,
  type ImportWordFileResult,
  type Mind,
  type WordFileCheck,
  type WordOrigin,
  type WordRefusalReason,
} from "./api";
import { readWordStructure, type WordStructure } from "./documents/formats/docxImport";
import { WORD_LOOK_VERSION } from "./documents/formats/docxLook";
import {
  openWordPackage,
  refusalOf,
  reviewOf,
  type WordReview,
} from "./documents/formats/docxPackage";
import { packageSizeError } from "./documents/formats/zip";
import { InvalidInputError, isRecord, MindReadOnlyError } from "./errors";
import type { MindContent } from "./mindContent";
import { type createMinds, parseFolderChoice } from "./minds";
import type { Database } from "./storage";
import { applyLook, clearLook, type LookPlan, planLook } from "./wordLookBackfill";

/** The folder in the data folder that keeps imported Word packages. */
export const WORD_PACKAGES_FOLDER = "Word imports";

/**
 * How many top-level Blocks go into the Mind in its first change; each change
 * after takes twice as many as the one before, up to `WORD_IMPORT_MOST`. The
 * open editor draws the whole Mind again for each change, so a long document
 * takes a few changes, not hundreds, and still shows how far it has got.
 */
const WORD_IMPORT_BATCH = 200;
const WORD_IMPORT_MOST = 3200;

export interface WordImportsOptions {
  db: Database;
  dataDir: string;
  content: MindContent;
  minds: ReturnType<typeof createMinds>;
  /** Throws unless the Folder exists. */
  requireFolder(folderId: string): void;
  /** Adds the file to the Library, a new one filed in the Folder, and returns its Document; throws when it can't. */
  addOriginal(path: string, folderId: string | null): Promise<string>;
  /** Makes the file a new version of a Document added on its own; false when it can't take it. */
  newVersion(documentId: string, path: string): Promise<boolean>;
  /** A Document's link to its Mind changed: windows hear of it. */
  documentChanged(documentId: string): void;
  mindsChanged(): void;
  now(): string;
  log: Logger;
}

function parsePath(path: unknown): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new InvalidInputError("A Word file's path must be a non-empty string.");
  }
  return path;
}

function parseOrigin(origin: unknown): WordOrigin {
  if (origin !== "own" && origin !== "someone-else") {
    throw new InvalidInputError('origin must be "own" or "someone-else".');
  }
  return origin;
}

/** A Word file read whole, ready to import, and how to tell it is still the file on disk. */
interface ReadFile {
  path: string;
  size: number;
  modified: number;
  bytes: Uint8Array;
  part: string;
  review: WordReview;
  structure: WordStructure;
}

/** A Word file read whole and checked, or why it is refused. */
async function readWordFile(path: string): Promise<ReadFile | { refusal: WordRefusalReason }> {
  const extension = extname(path).toLowerCase();
  if (extension === ".doc" || extension === ".dot") return { refusal: "legacy" };
  if (extension === ".docm" || extension === ".dotm") return { refusal: "macros" };
  let size: number;
  let modified: number;
  let bytes: Uint8Array;
  try {
    ({ size, mtimeMs: modified } = await stat(path));
    if (packageSizeError(size)) return { refusal: "too-large" };
    bytes = await readFile(path);
  } catch {
    return { refusal: "unreadable" };
  }
  try {
    const pkg = await openWordPackage(bytes);
    const review = await reviewOf(pkg);
    const structure = await readWordStructure(pkg, review);
    return { path, size, modified, bytes, part: pkg.part, review, structure };
  } catch (error) {
    return { refusal: refusalOf(error, bytes).reason };
  }
}

/** Someone else's when the file carries tracked changes or comments, the User's otherwise. */
const defaultOrigin = (review: WordReview): WordOrigin =>
  review.changes > 0 || review.comments > 0 ? "someone-else" : "own";

/** Records where each node of a Block came from, with its fingerprint as it now is in the Mind. */
export function recordSources(doc: Y.Doc, element: Y.XmlElement, structure: WordStructure): void {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  const source = typeof id === "string" ? structure.sources.get(id) : undefined;
  if (typeof id === "string" && source) {
    setWordSource(doc, id, { ...source, f: wordFingerprint(element) });
  }
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlElement) recordSources(doc, child, structure);
  }
}

/** Records who made each of someone's changes the file has, and when (#108). */
export function recordChanges(doc: Y.Doc, structure: WordStructure): void {
  for (const [request, made] of structure.changes) recordProposalRequest(doc, request, made);
}

export function createWordImports(options: WordImportsOptions) {
  const { db, content, minds, log } = options;
  const folder = join(options.dataDir, WORD_PACKAGES_FOLDER);
  /** Packages being kept for an import whose Mind isn't recorded yet: never dropped. */
  const keeping = new Set<string>();
  /** Minds whose Blocks are being written now, so a Mind never has two writers. */
  const writing = new Set<string>();
  /** Each import going on, by its Mind, until every Block is written. */
  const going = new Map<string, Promise<void>>();
  let closed = false;
  /** The file the import screen checked last, read whole, so importing it doesn't read it again. */
  let checked: ReadFile | null = null;

  /** The file last checked, if it is the one at `path` and hasn't changed since. */
  const unchangedSinceChecked = async (path: string): Promise<ReadFile | null> => {
    if (!checked || checked.path !== path) return null;
    try {
      const { size, mtimeMs } = await stat(path);
      return size === checked.size && mtimeMs === checked.modified ? checked : null;
    } catch {
      return null;
    }
  };

  const packagePath = (sha256: string) => join(folder, `${sha256}.docx`);

  /** Keeps the package, once per content: written beside, then renamed into place. */
  const keepPackage = async (sha256: string, bytes: Uint8Array) => {
    await mkdir(folder, { recursive: true });
    const path = packagePath(sha256);
    try {
      await stat(path);
      return;
    } catch {
      // Not kept yet.
    }
    const temporary = join(folder, `${sha256}.${randomUUID()}.partial`);
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  };

  /**
   * Writes the import's Blocks from `from` on, a batch at a time, after those
   * already written; marks the import complete once all are. Stops if the
   * Mind is deleted meanwhile, and does nothing for a Mind that already has a
   * writer.
   */
  const writeBlocks = async (
    mindId: string,
    structure: WordStructure,
    origin: WordOrigin,
    from: number,
    first: boolean,
  ) => {
    if (writing.has(mindId)) return;
    writing.add(mindId);
    try {
      const total = structure.blocks.length;
      let done = from;
      let size = WORD_IMPORT_BATCH;
      let last: Y.XmlElement | null = null;
      while (done < total) {
        // Other work runs between batches.
        if (!first) await new Promise<void>((resolve) => setImmediate(resolve));
        first = false;
        if (closed) return;
        if (!db.get("SELECT 1 FROM minds WHERE id = ? AND deleted_at IS NULL", [mindId])) return;
        const batch = structure.blocks.slice(done, done + size);
        size = Math.min(size * 2, WORD_IMPORT_MOST);
        const written = done;
        content.edit(mindId, (blocks) => {
          const doc = blocks.doc;
          if (!doc) return;
          if (written === from) recordChanges(doc, structure);
          const elements = batch.map(createElement);
          const after = last ? blocks.toArray().indexOf(last) + 1 : 0;
          blocks.insert(after > 0 ? after : Math.min(written, blocks.length), elements);
          for (const element of elements) recordSources(doc, element, structure);
          if (origin === "someone-else") {
            const ids = elements.flatMap((element) => {
              const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
              return typeof id === "string" ? [id] : [];
            });
            setTextOrigin(doc, ids, "imported");
          }
          recordWordImportProgress(doc, written + batch.length, total);
          last = elements.at(-1) ?? last;
        });
        done += batch.length;
      }
      const at = options.now();
      db.run(
        "UPDATE word_packages SET completed_at = ?, updated_at = ? WHERE mind_id = ? AND deleted_at IS NULL",
        [at, at, mindId],
      );
      log.info("word.import.done", { blocks: total });
    } finally {
      writing.delete(mindId);
    }
  };

  /**
   * The Document of the last import of a file of this name into the Folder, added on its
   * own, which a different file can become a new version of.
   */
  const earlierDraft = (
    fileName: string,
    path: string,
    sha256: string,
    folderId: string | null,
  ): WordFileCheck["earlierDraft"] => {
    const row = db.get<{ id: string; name: string }>(
      `SELECT d.id, d.name FROM word_packages p
       JOIN documents d ON d.id = p.document_id
       JOIN minds m ON m.id = p.mind_id
       WHERE p.file_name = ? AND m.folder_id IS ? AND p.deleted_at IS NULL
         AND d.deleted_at IS NULL AND d.source_kind = 'file' AND d.path != ?
         AND d.content_hash != ?
       ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1`,
      [fileName, folderId, path, sha256],
    );
    return row ? { documentId: row.id, name: row.name } : null;
  };

  /** The Document the original becomes: a new version of an earlier draft's, or its own. */
  const addOriginal = async (
    path: string,
    folderId: string | null,
    newVersionOf: string | null,
  ): Promise<string | null> => {
    try {
      if (newVersionOf !== null && (await options.newVersion(newVersionOf, path))) {
        return newVersionOf;
      }
      return await options.addOriginal(path, folderId);
    } catch (error) {
      log.error("word.import.originalNotAdded", {
        file: basename(path),
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const start = (
    mindId: string,
    structure: WordStructure,
    origin: WordOrigin,
    from: number,
  ): Promise<void> => {
    const run: Promise<void> = writeBlocks(mindId, structure, origin, from, from === 0)
      .catch((error: unknown) => {
        log.error("word.import.failed", { error: error instanceof Error ? error.name : "unknown" });
      })
      .finally(() => {
        if (going.get(mindId) === run) going.delete(mindId);
      });
    going.set(mindId, run);
    return run;
  };

  return {
    /** See `CoreApi.checkWordFile`. */
    async check(input: unknown, folderInput?: unknown): Promise<WordFileCheck> {
      const path = parsePath(input);
      const folderId = parseFolderChoice(folderInput);
      const fileName = basename(path);
      const read = await readWordFile(path);
      checked = "refusal" in read ? null : read;
      if ("refusal" in read) {
        return {
          fileName,
          refusal: read.refusal,
          origin: "own",
          authors: [],
          changes: 0,
          comments: 0,
          earlierDraft: null,
        };
      }
      const sha256 = createHash("sha256").update(read.bytes).digest("hex");
      return {
        fileName,
        refusal: null,
        origin: defaultOrigin(read.review),
        ...read.review,
        earlierDraft: earlierDraft(fileName, path, sha256, folderId),
      };
    },

    /**
     * See `CoreApi.importWordFile`. With `original`, the file is already in the Library as that
     * Document, and the Mind takes its title (Verify, #110).
     */
    async import(
      input: unknown,
      original?: { documentId: string; title: string },
    ): Promise<ImportWordFileResult> {
      if (!isRecord(input)) throw new InvalidInputError("importWordFile expects an object.");
      const path = parsePath(input.path);
      const origin = parseOrigin(input.origin);
      const folderId = parseFolderChoice(input.folderId);
      if (folderId !== null) options.requireFolder(folderId);
      const newVersionOf =
        typeof input.newVersionOf === "string" && input.newVersionOf !== ""
          ? input.newVersionOf
          : null;

      const read = (await unchangedSinceChecked(path)) ?? (await readWordFile(path));
      checked = null;
      if ("refusal" in read) {
        log.info("word.import.refused", { reason: read.refusal });
        return { ok: false, refusal: read.refusal };
      }
      const { bytes, structure, part } = read;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      keeping.add(sha256);
      const fileName = basename(path);
      const title = original?.title ?? basename(fileName, extname(fileName)).trim();
      let mind: Mind;
      let documentId: string | null = original?.documentId ?? null;
      try {
        await keepPackage(sha256, bytes);
        if (!original && input.addOriginal === true)
          documentId = await addOriginal(path, folderId, newVersionOf);
        const at = options.now();
        mind = db.transaction(() => {
          const made = minds.create({ title, kind: DEFAULT_MIND_KIND, folderId });
          db.run(
            `INSERT INTO word_packages (id, mind_id, sha256, file_name, size, document_id,
               look_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              made.id,
              sha256,
              fileName,
              bytes.byteLength,
              documentId,
              WORD_LOOK_VERSION,
              at,
              at,
            ],
          );
          return made;
        });
      } finally {
        keeping.delete(sha256);
      }
      content.edit(mind.id, (blocks) => {
        if (blocks.doc) {
          startWordImport(
            blocks.doc,
            { name: fileName, sha256, size: bytes.byteLength, part, documentId },
            origin,
            structure.report,
            structure.blocks.length,
          );
          setWordLook(blocks.doc, structure.look);
        }
      });
      if (structure.lookUnreadable.length > 0) {
        log.warn("word.look.partsUnreadable", { parts: structure.lookUnreadable.join(", ") });
      }
      log.info("word.import.started", {
        blocks: structure.blocks.length,
        paragraphs: structure.report.paragraphs,
        tables: structure.report.tables,
        images: structure.report.images,
        kept: Object.values(structure.report.kept).reduce((sum, count) => sum + (count ?? 0), 0),
      });
      // The first batch is written before this returns, so the Mind never opens empty.
      start(mind.id, structure, origin, 0);
      options.mindsChanged();
      if (documentId !== null) options.documentChanged(documentId);
      return {
        ok: true,
        mind,
        ...(input.addOriginal === true && { originalAdded: documentId !== null }),
      };
    },

    /** Resolves once every Block of the Mind's import is written; at once when none is going on. */
    written(mindId: string): Promise<void> {
      return going.get(mindId) ?? Promise.resolve();
    },

    /** See `CoreApi.addWordOriginal`. */
    async addOriginal(mindId: string, input: unknown): Promise<boolean> {
      const path = parsePath(input);
      const row = db.get<{ id: string }>(
        "SELECT id FROM word_packages WHERE mind_id = ? AND deleted_at IS NULL",
        [mindId],
      );
      if (!row) throw new InvalidInputError({ key: "error.mind.notFromWord" });
      const documentId = await addOriginal(path, minds.get(mindId).folderId, null);
      if (documentId === null) return false;
      db.run("UPDATE word_packages SET document_id = ?, updated_at = ? WHERE id = ?", [
        documentId,
        options.now(),
        row.id,
      ]);
      content.edit(mindId, (blocks) => {
        if (blocks.doc) linkWordFileDocument(blocks.doc, documentId);
      });
      options.documentChanged(documentId);
      return true;
    },

    /**
     * Goes on with imports that stopped, from where each got to, reading its
     * kept package again: a quit cut them short (all of them, run once at
     * start-up), or their Mind was deleted and is back (`only` names those).
     */
    resume(only?: readonly string[]): void {
      const unfinished = db
        .all<{ mind_id: string; sha256: string }>(
          `SELECT p.mind_id, p.sha256 FROM word_packages p JOIN minds m ON m.id = p.mind_id
           WHERE p.completed_at IS NULL AND p.deleted_at IS NULL AND m.deleted_at IS NULL`,
        )
        .filter(({ mind_id: mindId }) => only === undefined || only.includes(mindId));
      for (const { mind_id: mindId, sha256 } of unfinished) {
        const resumed = (async () => {
          const bytes = await readFile(packagePath(sha256));
          const pkg = await openWordPackage(bytes);
          const structure = await readWordStructure(pkg, await reviewOf(pkg));
          const { done, origin } = content.peek(mindId, (blocks) => ({
            done: blocks.doc ? wordImportDone(blocks.doc) : 0,
            origin: (blocks.doc && wordOriginOf(blocks.doc)) ?? "own",
          }));
          await start(mindId, structure, origin, done);
        })();
        resumed.catch((error: unknown) => {
          log.error("word.import.resumeFailed", {
            error: error instanceof Error ? error.name : "unknown",
          });
        });
      }
    },

    /**
     * The package a Mind was imported from, for export to write into (#105):
     * found by the Mind in the database, never by what its document says,
     * which another client could have written.
     */
    async packageOf(mindId: string): Promise<Uint8Array> {
      const row = db.get<{ sha256: string }>(
        "SELECT sha256 FROM word_packages WHERE mind_id = ? AND deleted_at IS NULL",
        [mindId],
      );
      try {
        if (!row || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error("No package.");
        return await readFile(packagePath(row.sha256));
      } catch (error) {
        log.error("word.export.packageMissing", {
          code: (error as NodeJS.ErrnoException).code ?? "unknown",
        });
        throw new Error(
          "The Word file this Mind was imported from is missing from IncarnaMind's data folder.",
        );
      }
    },

    /**
     * A Mind's original, for its checks to leave out (#720): the Document it was also added
     * as, and any copy of the file as imported. Null for a Mind not imported from Word.
     */
    originalOf(mindId: string): CheckedDocument | null {
      const row = db.get<{ document_id: string | null; sha256: string }>(
        "SELECT document_id, sha256 FROM word_packages WHERE mind_id = ? AND deleted_at IS NULL",
        [mindId],
      );
      if (!row) return null;
      return {
        ...(row.document_id !== null && { documentIds: [row.document_id] }),
        contentHashes: [row.sha256],
      };
    },

    /** Not an Undo step: it is the core's change, and the editor undoes only its own. */
    async addLooks(): Promise<void> {
      const imported = db.all<{ id: string; mind_id: string; sha256: string }>(
        `SELECT p.id, p.mind_id, p.sha256 FROM word_packages p JOIN minds m ON m.id = p.mind_id
         WHERE p.completed_at IS NOT NULL AND p.deleted_at IS NULL AND m.deleted_at IS NULL
           AND (p.look_version IS NULL OR p.look_version < ?)
         ORDER BY p.created_at, p.rowid`,
        [WORD_LOOK_VERSION],
      );
      const recorded = (rowId: string) =>
        db.run("UPDATE word_packages SET look_version = ?, updated_at = ? WHERE id = ?", [
          WORD_LOOK_VERSION,
          options.now(),
          rowId,
        ]);
      for (const { id: rowId, mind_id: mindId, sha256 } of imported) {
        if (closed) return;
        // Yields between Minds so start-up work isn't held up.
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          let bytes: Uint8Array;
          try {
            if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("No package.");
            bytes = await readFile(packagePath(sha256));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            log.info("word.look.packageMissing", { mindId });
            continue;
          }
          const pkg = await openWordPackage(bytes);
          const structure = await readWordStructure(pkg, await reviewOf(pkg));
          if (closed) return;
          const wasLoaded = content.isLoaded(mindId);
          let plan: LookPlan | null;
          try {
            // Planned inside the edit so it applies to the content it was planned on.
            plan = content.edit(mindId, (blocks) => {
              const doc = blocks.doc;
              if (!doc) return null;
              const look = wordLookOf(doc);
              if (look && look.version >= WORD_LOOK_VERSION) return null;
              if (look) clearLook(doc, blocks, structure.look);
              const planned = planLook(doc, blocks, structure, look?.version ?? null);
              applyLook(doc, planned);
              setWordLook(doc, structure.look);
              return planned;
            });
          } finally {
            if (!wasLoaded) content.close(mindId);
          }
          recorded(rowId);
          if (plan) {
            log.info("word.look.added", {
              mindId,
              given: plan.given,
              editedSinceImport: plan.editedSinceImport,
            });
          }
        } catch (error) {
          if (error instanceof MindReadOnlyError) continue;
          log.error("word.look.failed", {
            mindId,
            error: error instanceof Error ? error.name : "unknown",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      log.info("word.look.done", { minds: imported.length });
    },

    /** Stops writing Blocks: each import goes on from where it got to at the next start. */
    close(): void {
      closed = true;
    },

    /** Removes the kept packages no Mind keeps any longer, and files a quit left half written. */
    async dropPurged(): Promise<void> {
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        return;
      }
      const kept = new Set(
        db
          .all<{ sha256: string }>(
            "SELECT DISTINCT sha256 FROM word_packages WHERE deleted_at IS NULL",
          )
          .map((row) => row.sha256),
      );
      for (const name of names) {
        const sha256 = name.endsWith(".docx") ? name.slice(0, -".docx".length) : null;
        if (sha256 !== null && kept.has(sha256)) continue;
        if ([...keeping].some((each) => name.startsWith(each))) continue;
        await rm(join(folder, name), { force: true });
      }
    },
  };
}
