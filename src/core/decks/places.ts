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
import { NotFoundError, TranslatableError } from "../errors";
import { replaceFile } from "../fileNames";
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
  handed: Pick<AgentFiles, "holding" | "addVersion" | "rewriteVersion">;
  kept: Pick<KeptDecks, "keep" | "fileFor" | "byId">;
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
        wrote = contentHash;
        await deps.readAgain(path);
        return {
          kind: "written",
          documentId,
          saved: { kind: "version", number: version?.number ?? null },
        };
      }),
  };
}

/**
 * A deck of the User's own, written itself. `base` is what the sitting read, which the viewer
 * showed; `keptAlready` when there is nothing to keep (a copy this sitting just made).
 */
export function ownFile(
  deps: DeckPlaceDeps,
  documentId: string,
  base: Uint8Array,
  keptAlready = false,
): DeckPlace {
  let wrote = hashBytes(base);
  let keptId: string | null = null;
  let kept = keptAlready;
  return {
    async write(bytes) {
      const { path } = deps.document(documentId);
      const name = basename(path);
      let info: Stats;
      try {
        info = await stat(path);
        // A file the User made read-only stays as it is, though its folder would let a rename in.
        await access(path, constants.W_OK);
      } catch (error) {
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      if (!(await holds(path, wrote))) return CHANGED;
      let letGo: string[] = [];
      if (!kept) {
        const id = deps.newId();
        const file = deps.kept.fileFor(documentId, id);
        await writeWholeFile(join(deps.dataDir, file), base);
        const dropped = await deps.kept.keep(documentId, {
          id,
          file,
          contentHash: hashBytes(base),
          size: base.byteLength,
        });
        letGo = dropped.map((each) => each.keptAt);
        keptId = id;
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
        const why = unwritable(error);
        if (why) return { kind: "unwritable", why, name };
        throw error;
      }
      wrote = hashBytes(bytes);
      await deps.readAgain(path);
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
    if (!unwritable(error)) throw error;
    file = await deps.save(asked);
  }
  let made: string | null = null;
  if (deps.inLinkedFolder(file.path)) {
    await deps.readAgain(file.path);
    made = deps.documentAt(file.path);
  }
  const copyId = made ?? (await deps.addFile(file.path, deps.folderOf(documentId)));
  return { documentId: copyId, file, place: ownFile(deps, copyId, bytes, true) };
}

/** The one place that decides where a sitting on this Document writes. */
export function deckPlaceFor(deps: DeckPlaceDeps, documentId: string, base: Uint8Array): DeckPlace {
  const { path, linkedFolderId } = deps.document(documentId);
  const keptHere = linkedFolderId === null && isInside(deps.dataDir, path);
  return keptHere ? keptVersion(deps, documentId, base) : ownFile(deps, documentId, base);
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
  const written = await ownFile(deps, kept.documentId, now).write(bytes);
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
  };
}
