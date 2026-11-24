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
import { constants, type Stats } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HANDED_FOLDER } from "../agentFiles/handOver";
import type { AgentFiles } from "../agentFiles/index";
import type { DeckRestored, DeckUnwritable, Document, SavedFile } from "../api";
import { hashBytes, hashFile, isGone, isInside } from "../documents/files";
import { writeWholeFile } from "../documents/writeWhole";
import { LinkedFolderWritesDeclinedError, NotFoundError, TranslatableError } from "../errors";
import { removeStalePartials, replaceFile } from "../fileNames";
import type { NewFile } from "../outputFiles";
import type { KeptDecks } from "./kept";
import type { DeckPlace, PlaceWritten } from "./sittings";

export interface DeckPlaceDeps {
  dataDir: string;
  document(documentId: string): Document;
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
  now(): string;
  newId(): string;
}

const CHANGED: PlaceWritten = { kind: "changed" };

/** Whether the file at `path` holds the bytes whose fingerprint is `wrote`; false once it is gone. */
async function holds(path: string, wrote: string): Promise<boolean> {
  try {
    return (await hashFile(path)).contentHash === wrote;
  } catch {
    return false;
  }
}

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
 * A deck IncarnaMind keeps: the sitting's first write makes the item's next version (its copy in
 * the item's folder, as an agent's are kept), and every write puts the bytes in the Document's own
 * file and reads it again, as a hand-over does.
 */
function keptVersion(deps: DeckPlaceDeps, documentId: string, base: Uint8Array): DeckPlace {
  let wrote = hashBytes(base);
  let version: { id: string; number: number; file: string } | null = null;
  return {
    write: (bytes) =>
      deps.inHandOverTurn(async () => {
        const { path } = deps.document(documentId);
        if (!(await holds(path, wrote))) return CHANGED;
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
            const file = join(HANDED_FOLDER, item.id, `v${number}`, basename(path));
            await writeWholeFile(join(deps.dataDir, file), bytes, deps.now());
            const made = deps.handed.addVersion(item.id, {
              contentHash,
              size: bytes.byteLength,
              file,
              agent: "",
              title: item.title,
            });
            version = { id: made.id, number: made.number, file };
          } else if (version) {
            await writeWholeFile(join(deps.dataDir, version.file), bytes, deps.now());
            deps.handed.rewriteVersion(version.id, { contentHash, size: bytes.byteLength });
          }
          await writeWholeFile(path, bytes, deps.now());
        } catch (error) {
          const why = unwritable(error);
          if (why) return { kind: "unwritable", why, name: basename(path) };
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
async function lockFileOf(path: string): Promise<string | null> {
  for (const lock of lockFilesOf(path)) {
    try {
      await access(lock);
      return basename(lock);
    } catch {
      // No lock file: the other app, if any, doesn't hold this one.
    }
  }
  return null;
}

/** Steps after the file is written that mustn't undo it: a failure is logged, the write stands. */
async function afterWriting(what: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    console.error(`A deck was written, but ${what} failed.`, error);
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
  let wrote = hashBytes(base);
  let keptId: string | null = null;
  let kept = options.kept ?? false;
  /** A state this sitting kept that wasn't there before: the first write that succeeds lets older go. */
  let keptNew = false;
  return {
    async write(bytes) {
      const { path } = deps.document(documentId);
      const name = basename(path);
      let info: Stats;
      try {
        info = await stat(path);
        // A file the User made read-only stays as it is, though its folder would let a rename in.
        await access(path, constants.W_OK);
        await access(dirname(path), constants.W_OK);
      } catch (error) {
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      // An app that has the file open writes its own copy over ours when it saves.
      const lock = await lockFileOf(path);
      if (lock) return { kind: "unwritable", why: "locked", name, lock };
      if (!(await holds(path, wrote))) return CHANGED;
      await removeStalePartials(dirname(path));
      if (!kept) {
        const contentHash = hashBytes(base);
        const already = deps.kept.find(documentId, contentHash);
        if (already) keptId = already.id;
        else {
          const id = deps.newId();
          const file = deps.kept.fileFor(documentId, id);
          try {
            await writeWholeFile(join(deps.dataDir, file), base, undefined, { durable: true });
          } catch (error) {
            // Not kept, not written: the change waits, and the file stays as it is.
            if ((error as NodeJS.ErrnoException | null)?.code)
              return { kind: "unwritable", why: "unkept", name };
            throw error;
          }
          deps.kept.add(documentId, { id, file, contentHash, size: base.byteLength });
          keptId = id;
          keptNew = true;
        }
        if (options.sitting !== false && keptId) deps.kept.beganFrom(keptId);
        kept = true;
      }
      const expected = wrote;
      try {
        const replaced = await replaceFile(
          path,
          bytes,
          () => holds(path, expected),
          info.mode & 0o7777,
        );
        if (!replaced) return CHANGED;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        // The file and its folder could be written: a rename refused now is another app's hold on it.
        if (code === "EPERM" || code === "EACCES")
          return { kind: "unwritable", why: "locked", name };
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      wrote = hashBytes(bytes);
      let letGo: string[] = [];
      if (keptNew) {
        keptNew = false;
        await afterWriting("letting older kept states go", async () => {
          letGo = (await deps.kept.letGo(documentId)).map((each) => each.keptAt);
        });
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
): Promise<{ documentId: string; file: SavedFile; place: DeckPlace }> {
  const { path } = deps.document(documentId);
  const asked: NewFile = { name: basename(path), data: bytes, ownFile: null, fromFolder: null };
  let file: SavedFile;
  try {
    // The User chose this place by its name, "Save a copy beside it" (#1110 allows one file so).
    file = await deps.save({ ...asked, folder: dirname(path), approved: true });
  } catch (error) {
    // A folder that can't be written, or a Linked folder the User keeps new files out of.
    if (!unwritable(error) && !(error instanceof LinkedFolderWritesDeclinedError)) throw error;
    file = await deps.save(asked);
  }
  let made: string | null = null;
  if (deps.inLinkedFolder(file.path)) {
    await deps.readAgain(file.path);
    made = deps.documentAt(file.path);
  }
  const copyId = made ?? (await deps.addFile(file.path, deps.folderOf(documentId)));
  return { documentId: copyId, file, place: ownFile(deps, copyId, bytes, { kept: true }) };
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
  const kept = deps.kept.byId(input.keptId);
  if (!kept || kept.documentId !== input.documentId) {
    throw new NotFoundError({ key: "error.deck.keptGone" });
  }
  const now = await read(kept.documentId);
  if (hashBytes(now) !== input.shown) throw new TranslatableError({ key: "error.deck.changed" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(deps.dataDir, kept.file)));
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
      values: { name: written.name },
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
