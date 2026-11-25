/**
 * Where a deck edited by hand is written (#149; ADR-0010, 2026-11-24). A deck IncarnaMind keeps
 * in its data folder (one an agent handed over) takes a new version, one a sitting. A deck of the
 * User's own is written itself, as PowerPoint saves it, only by the User's own hand: before a
 * sitting's first write the file as it stands is kept whole in the data folder (./kept), and every
 * write goes to a file beside it that is then renamed over it, with the file's permissions, so it
 * is never left half written. Each write first checks that the file still holds what was last
 * written there, or what the viewer showed, so nothing another program or agent saved is written
 * over. A file that can't be written says why, and the edit waits to be saved as a copy beside it.
 */
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DeckFileStat, DeckFiles } from "../adapters";
import { HANDED_FOLDER } from "../agentFiles/handOver";
import type { AgentFiles } from "../agentFiles/index";
import type { DeckRestored, DeckUnwritable, Document, SavedFile } from "../api";
import { hashBytes, hashFile, isDataless, isGone, isInside } from "../documents/files";
import { writeWholeFile } from "../documents/writeWhole";
import {
  FileWriteCancelledError,
  FileWriteUnansweredError,
  LinkedFolderWritesDeclinedError,
  NotFoundError,
  TranslatableError,
} from "../errors";
import { removeStalePartials, replaceFile, replaceStageOf } from "../fileNames";
import type { NewFile } from "../outputFiles";
import type { KeptDecks } from "./kept";
import type { DeckPlace, PlaceWritten } from "./sittings";

/**
 * Windows Win32 file attributes that mark a cloud placeholder not downloaded to this computer:
 * FILE_ATTRIBUTE_OFFLINE (0x1000), FILE_ATTRIBUTE_RECALL_ON_OPEN (0x40000), and
 * FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS (0x400000) — used by OneDrive, Dropbox and iCloud Drive.
 */
export const WIN32_CLOUD_ATTRIBUTES = 0x00400000 | 0x00040000 | 0x00001000;

/** Whether a Windows Win32 `FileAttributes` bitmask marks a cloud placeholder not on disk. */
export const isWindowsCloudAttributes = (attributes: number): boolean =>
  Number.isFinite(attributes) && attributes > 0 && (attributes & WIN32_CLOUD_ATTRIBUTES) !== 0;

/** Default Node implementation of `DeckFiles`. */
export function createNodeDeckFiles(
  options: {
    detectDataless?: boolean;
    windowsCloudPlaceholder?: (path: string) => Promise<boolean>;
  } = {},
): DeckFiles {
  const detectDataless = options.detectDataless ?? process.platform === "darwin";
  return {
    async stat(path: string): Promise<DeckFileStat> {
      const info = await stat(path);
      return { mode: info.mode, size: info.size, blocks: info.blocks ?? 0 };
    },
    access: (path, mode) => access(path, mode === "write" ? constants.W_OK : constants.F_OK),
    async isCloudPlaceholder(path: string, info?: DeckFileStat | null): Promise<boolean> {
      if (detectDataless) {
        if (info && isDataless(info)) return true;
        if (!info) {
          const stub = join(dirname(path), `.${basename(path)}.icloud`);
          try {
            await access(stub, constants.F_OK);
            return true;
          } catch {
            // No iCloud stub beside the missing file.
          }
        }
      }
      if (info && options.windowsCloudPlaceholder) {
        try {
          return await options.windowsCloudPlaceholder(path);
        } catch {
          return false;
        }
      }
      return false;
    },
    hashFile: async (path) => (await hashFile(path)).contentHash,
    readFile: async (path) => new Uint8Array(await readFile(path)),
    realpath,
    removeStalePartials,
    writeWholeFile,
    replaceFile,
  };
}

export interface DeckPlaceDeps {
  dataDir: string;
  document(documentId: string): Document;
  /** The file's path, the Document live or in Recently deleted, whose file is still there. */
  pathOf(documentId: string): string;
  /** Reads the file at `path` again: its Document's new version, or a Linked folder's new file. */
  readAgain(path: string): Promise<unknown>;
  /** The live Document at `path`; null for none. */
  documentAt(path: string): string | null;
  /** Adds a file in no Linked folder as a Document of its own, filed in the Folder (null: none). */
  addFile(path: string, folderId: string | null): Promise<string>;
  /** The Folder a Document is filed in; null for none. */
  folderOf(documentId: string): string | null;
  /** Whether a path is inside a live Linked folder. */
  inLinkedFolder(path: string): boolean;
  /** Saves a new file in the Output location, or in `folder` inside a Linked folder (ADR-0010). */
  save(file: NewFile): Promise<SavedFile>;
  handed: Pick<AgentFiles, "holding" | "versions" | "addVersion" | "rewriteVersion">;
  kept: Pick<KeptDecks, "add" | "find" | "letGo" | "fileFor" | "byId" | "beganFrom">;
  /** Writes of a deck IncarnaMind keeps take turns with agents' hand-overs of it. */
  inHandOverTurn<T>(run: () => Promise<T>): Promise<T>;
  /** File-system adapter; defaults to Node's fs operations. */
  files?: DeckFiles;
  now(): string;
  newId(): string;
}

const CHANGED: PlaceWritten = { kind: "changed" };

const defaultFiles = createNodeDeckFiles();
const filesOf = (deps: DeckPlaceDeps): DeckFiles => deps.files ?? defaultFiles;

/** Why a file can't be written, in the words the line uses; null for any other failure. */
function unwritable(error: unknown): DeckUnwritable["why"] | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (isGone(error)) return "gone";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "read-only";
  if (code === "EBUSY" || code === "ETXTBSY") return "locked";
  if (code === "ENOSPC" || code === "EDQUOT") return "full";
  return null;
}

/**
 * Why saving a copy beside the deck (and in the Output location) failed, for the line in the
 * viewer and the quit sheet; null for user cancellations or non-filesystem errors.
 */
export function copyFailureOf(error: unknown): NonNullable<DeckUnwritable["copyFailed"]> | null {
  if (
    error instanceof FileWriteCancelledError ||
    error instanceof FileWriteUnansweredError ||
    error instanceof LinkedFolderWritesDeclinedError
  ) {
    return null;
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return "full";
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "ENOENT" ||
    code === "ENOTDIR"
  ) {
    return "folder";
  }
  if (code === "EBUSY" || code === "ETXTBSY" || code === "EIO") return "other";
  return null;
}

/** Distinguishes a missing file from an iCloud `.Name.icloud` stub that isn't downloaded. */
async function goneOrCloud(files: DeckFiles, path: string, name: string): Promise<PlaceWritten> {
  return {
    kind: "unwritable",
    why: (await files.isCloudPlaceholder(path, null)) ? "cloud" : "gone",
    name,
  };
}

/**
 * Checks whether `path` still holds `wrote`. Unlike a boolean check, a read failure (file deleted,
 * evicted to a cloud stub, or exclusively locked on Windows) stays unwritable rather than
 * reporting `changed` and dropping the edit in hand.
 */
async function checkHolds(
  files: DeckFiles,
  path: string,
  wrote: string,
  name: string,
): Promise<{ kind: "same" } | PlaceWritten> {
  try {
    return (await files.hashFile(path)) === wrote ? { kind: "same" } : CHANGED;
  } catch (error) {
    if (isGone(error)) return goneOrCloud(files, path, name);
    const why = unwritable(error);
    if (why) return { kind: "unwritable", why: why === "read-only" ? "locked" : why, name };
    throw error;
  }
}

/**
 * A deck IncarnaMind keeps: the sitting's first write makes the item's next version (its copy in
 * the item's folder, as an agent's are kept), and every write puts the bytes in the Document's own
 * file and reads it again, as a hand-over does.
 */
function keptVersion(deps: DeckPlaceDeps, documentId: string, base: Uint8Array): DeckPlace {
  const files = filesOf(deps);
  let wrote = hashBytes(base);
  let version: { id: string; number: number; file: string } | null = null;
  return {
    write: (bytes) =>
      deps.inHandOverTurn(async () => {
        const { path } = deps.document(documentId);
        const name = basename(path);
        const held = await checkHolds(files, path, wrote, name);
        if (held.kind !== "same") return held;
        const contentHash = hashBytes(bytes);
        const item = deps.handed.holding(documentId)[0];
        // A version that has a check Note of its own (a hand-over of these bytes may have given it
        // one) keeps the bytes the Note describes: the next write makes a new version.
        const stored =
          item && version
            ? deps.handed.versions(item.id).find((each) => each.id === version?.id)
            : undefined;
        if (
          stored &&
          (stored.mindId !== null || stored.checkedAt !== null || stored.unread !== null)
        )
          version = null;
        // A disk that refuses part way keeps the change waiting; tried again, it finishes the
        // version it began rather than making another.
        try {
          if (item && !version) {
            const number = item.version + 1;
            const file = join(HANDED_FOLDER, item.id, `v${number}`, name);
            await files.writeWholeFile(join(deps.dataDir, file), bytes, deps.now());
            const made = deps.handed.addVersion(item.id, {
              contentHash,
              size: bytes.byteLength,
              file,
              agent: "",
              title: item.title,
            });
            version = { id: made.id, number: made.number, file };
          } else if (version) {
            await files.writeWholeFile(join(deps.dataDir, version.file), bytes, deps.now());
            deps.handed.rewriteVersion(version.id, { contentHash, size: bytes.byteLength });
          }
          await files.writeWholeFile(path, bytes, deps.now());
        } catch (error) {
          const why = unwritable(error);
          if (why) return { kind: "unwritable", why, name };
          throw error;
        }
        wrote = contentHash;
        await afterWriting("reading the file again", () => deps.readAgain(path));
        return {
          kind: "written",
          documentId,
          saved: { kind: "version", number: version?.number ?? null },
        };
      }),
  };
}

/** The lock files another app leaves beside a file it has open: PowerPoint's and WPS's, LibreOffice's. */
const lockFilesOf = (path: string) => {
  const name = basename(path);
  return [join(dirname(path), `~$${name}`), join(dirname(path), `.~lock.${name}#`)];
};

/** The name of the lock file another app left beside the file, if one is there. */
async function lockFileOf(files: DeckFiles, path: string): Promise<string | null> {
  for (const lock of lockFilesOf(path)) {
    try {
      await files.access(lock, "exists");
      return basename(lock);
    } catch {
      // No lock file: the other app, if any, doesn't hold this one.
    }
  }
  return null;
}

/** Steps after the file is written that mustn't undo it: a failure is logged, the write stands. */
async function afterWriting(what: string, step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (error) {
    console.error(`A deck was written, but ${what} failed.`, error);
    return false;
  }
}

/**
 * A deck of the User's own, written itself. `base` is what the sitting read, which the viewer
 * showed. `kept`: nothing to keep (a copy this sitting just made). `sitting`: false for a write
 * that isn't a sitting's (Put back), whose kept state Put back as it was mustn't name.
 */
export function ownFile(
  deps: DeckPlaceDeps,
  documentId: string,
  base: Uint8Array,
  options: { kept?: boolean; sitting?: boolean } = {},
): DeckPlace {
  const files = filesOf(deps);
  let wrote = hashBytes(base);
  let keptId: string | null = null;
  let kept = options.kept ?? false;
  /** A state this sitting kept that wasn't there before: the first write that succeeds lets older go. */
  let keptNew = false;
  /** The sitting is marked as begun from its kept state only once a write of it has landed. */
  let began = options.sitting === false;
  return {
    async write(bytes) {
      const { path } = deps.document(documentId);
      const name = basename(path);
      let info: DeckFileStat;
      try {
        info = await files.stat(path);
      } catch (error) {
        if (isGone(error)) return goneOrCloud(files, path, name);
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      // Checked before `access` and before reading bytes so a cloud placeholder is never hydrated.
      if (await files.isCloudPlaceholder(path, info)) {
        return { kind: "unwritable", why: "cloud", name };
      }
      try {
        // A file the User made read-only stays as it is, though its folder would let a rename in.
        await files.access(path, "write");
      } catch (error) {
        if (isGone(error)) return goneOrCloud(files, path, name);
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      try {
        await files.access(dirname(path), "write");
      } catch (error) {
        const why = unwritable(error);
        // The folder, not the file, refuses: the line names it, and a copy can't go beside it.
        if (why === "read-only")
          return { kind: "unwritable", why: "folder", name, folder: basename(dirname(path)) };
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      // An app that has the file open writes its own copy over ours when it saves.
      const lock = await lockFileOf(files, path);
      if (lock) return { kind: "unwritable", why: "locked", name, lock };
      const held = await checkHolds(files, path, wrote, name);
      if (held.kind !== "same") return held;
      await files.removeStalePartials(dirname(path));
      if (!kept) {
        const contentHash = hashBytes(base);
        const already = deps.kept.find(documentId, contentHash);
        if (already) keptId = already.id;
        else {
          const id = deps.newId();
          const file = deps.kept.fileFor(documentId, id);
          try {
            await files.writeWholeFile(join(deps.dataDir, file), base, undefined, {
              durable: true,
            });
          } catch (error) {
            // Not kept, not written: the change waits, and the file stays as it is.
            const why = unwritable(error);
            if (why === "full") return { kind: "unwritable", why: "full", name };
            if ((error as NodeJS.ErrnoException | null)?.code)
              return { kind: "unwritable", why: "unkept", name };
            throw error;
          }
          deps.kept.add(documentId, { id, file, contentHash, size: base.byteLength });
          keptId = id;
          keptNew = true;
        }
        kept = true;
      }
      const expected = wrote;
      let holdFailure: PlaceWritten | null = null;
      try {
        const replaced = await files.replaceFile(
          path,
          bytes,
          async () => {
            const still = await checkHolds(files, path, expected, name);
            if (still.kind === "same") return true;
            if (still.kind === "unwritable") holdFailure = still;
            return false;
          },
          info.mode & 0o7777,
        );
        if (holdFailure) return holdFailure;
        if (!replaced) return CHANGED;
      } catch (error) {
        if (isGone(error)) return goneOrCloud(files, path, name);
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (
          replaceStageOf(error) === "temp" &&
          (code === "EPERM" || code === "EACCES" || code === "EROFS")
        ) {
          return { kind: "unwritable", why: "folder", name, folder: basename(dirname(path)) };
        }
        // The file and its folder could be written: a rename refused now is another app's hold on it.
        if (code === "EPERM" || code === "EACCES") {
          return { kind: "unwritable", why: "locked", name };
        }
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      wrote = hashBytes(bytes);
      if (!began && keptId) deps.kept.beganFrom(keptId);
      began = true;
      let letGo: string[] = [];
      // Tried again with the sitting's next write if it fails, so no more are kept than the limit.
      if (keptNew) {
        keptNew = !(await afterWriting("letting older kept states go", async () => {
          letGo = (await deps.kept.letGo(documentId)).map((each) => each.keptAt);
        }));
      }
      await afterWriting("reading the file again", () => deps.readAgain(path));
      return {
        kind: "written",
        documentId,
        saved: { kind: "file", name, keptId, letGo },
      };
    },
  };
}

/**
 * Saves `bytes` as a new file beside the deck's own, as it couldn't be written (in the Output
 * location when its folder takes nothing), and makes it a Document: the place later writes of the
 * sitting go to.
 */
export async function copyBeside(
  deps: DeckPlaceDeps,
  documentId: string,
  bytes: Uint8Array,
  unasked = false,
): Promise<{ documentId: string; file: SavedFile; beside: boolean; place: DeckPlace }> {
  const files = filesOf(deps);
  // A deck moved to Recently deleted keeps its file: a change that waits is still saved beside it.
  const path = deps.pathOf(documentId);
  const asked: NewFile = {
    name: basename(path),
    data: bytes,
    ownFile: null,
    fromFolder: null,
    ...(unasked && { unasked }),
  };
  const saveFile = (file: NewFile) =>
    files.saveCopy ? files.saveCopy(file, () => deps.save(file)) : deps.save(file);
  let file: SavedFile;
  try {
    // The User chose this place by its name, "Save a copy beside it" (#1110 allows one file so).
    file = await saveFile({ ...asked, folder: dirname(path), approved: true });
  } catch (error) {
    // A folder that can't be written, a Linked folder the User keeps new files out of, or one
    // whose question can't be asked now: the Output location takes it.
    if (
      !unwritable(error) &&
      !(error instanceof LinkedFolderWritesDeclinedError) &&
      !(error instanceof FileWriteUnansweredError)
    )
      throw error;
    file = await saveFile(asked);
  }
  let made: string | null = null;
  if (deps.inLinkedFolder(file.path)) {
    await deps.readAgain(file.path);
    made = deps.documentAt(file.path);
  }
  const copyId = made ?? (await deps.addFile(file.path, deps.folderOf(documentId)));
  const beside = await files.realpath(dirname(path)).then(
    (folder) => folder === dirname(file.path),
    () => false,
  );
  return { documentId: copyId, file, beside, place: ownFile(deps, copyId, bytes, { kept: true }) };
}

/** The one place that decides where a sitting on this Document writes. */
export function deckPlaceFor(deps: DeckPlaceDeps, documentId: string, base: Uint8Array): DeckPlace {
  const { path, linkedFolderId } = deps.document(documentId);
  // Only an item an agent handed over has versions; any other file, the data folder's copies of
  // converted decks among them, is written itself, kept first.
  const handed =
    linkedFolderId === null &&
    isInside(deps.dataDir, path) &&
    deps.handed.holding(documentId).length > 0;
  return handed ? keptVersion(deps, documentId, base) : ownFile(deps, documentId, base);
}

/**
 * Puts a deck of the User's own back as it stood when `keptId` was kept, keeping the file as it is
 * now first, so the restore is undone by restoring that. `shown`: the version the viewer shows,
 * which must be what the file holds.
 */
export async function restoreKept(
  deps: DeckPlaceDeps,
  read: (documentId: string) => Promise<Uint8Array>,
  input: { documentId: unknown; keptId: unknown; shown: unknown },
): Promise<DeckRestored> {
  const files = filesOf(deps);
  const kept = deps.kept.byId(input.keptId);
  if (!kept || kept.documentId !== input.documentId) {
    throw new NotFoundError({ key: "error.deck.keptGone" });
  }
  const now = await read(kept.documentId);
  if (hashBytes(now) !== input.shown) throw new TranslatableError({ key: "error.deck.changed" });
  let bytes: Uint8Array;
  try {
    bytes = await files.readFile(join(deps.dataDir, kept.file));
  } catch (error) {
    if (isGone(error)) throw new NotFoundError({ key: "error.deck.keptGone" });
    throw error;
  }
  if (hashBytes(bytes) !== kept.contentHash)
    throw new NotFoundError({ key: "error.deck.keptGone" });
  const written = await ownFile(deps, kept.documentId, now, { sitting: false }).write(bytes);
  if (written.kind === "changed") throw new TranslatableError({ key: "error.deck.changed" });
  if (written.kind === "unwritable") {
    throw new TranslatableError({
      key: `error.deck.unwritable.${written.why}`,
      values: { name: written.name, folder: written.folder ?? "" },
    });
  }
  return {
    documentId: kept.documentId,
    keptAt: kept.keptAt,
    before: written.saved.kind === "file" ? written.saved.keptId : null,
    bytes,
    contentHash: kept.contentHash,
    letGo: written.saved.kind === "file" ? written.saved.letGo : [],
  };
}
