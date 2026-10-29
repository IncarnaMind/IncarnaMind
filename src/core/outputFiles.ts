/**
 * The files IncarnaMind creates (#124): exports now, and later transcripts,
 * saved web pages and what Tasks make. Each goes to the Output location, which
 * each device keeps: Documents › IncarnaMind until the User picks another, the
 * first save taking it without asking; or inside a Linked folder,
 * e.g. next to the original it was made from, once the User has allowed that
 * folder (ADR-0010). A new file never replaces anything: it takes the next
 * free name. Folders are checked with symbolic links resolved, so nothing
 * lands outside the place the User chose. A file that is IncarnaMind's own
 * writing (an export, a source pack) has its fingerprint recorded first, so
 * checks leave it out of their evidence wherever it ends up (#80).
 *
 * Questions work as consent's do: a save that needs an answer raises
 * "fileWrite.requested" and waits; saves waiting for the same answer share it.
 * The Output location asks only when the default can't take files.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type {
  FileWriteRequest,
  LinkedFolder,
  LinkedFolderWriting,
  OutputFolderProblem,
  OutputSettings,
  OwnFileKind,
  SavedFile,
} from "./api";
import { isInside } from "./documents/files";
import {
  FileWriteCancelledError,
  InvalidInputError,
  LinkedFolderWritesDeclinedError,
  NotFoundError,
} from "./errors";
import type { createEventHub } from "./events";
import { removeStalePartials, safeFileName, writeNewFile } from "./fileNames";
import type { SettingsStore } from "./settings";
import type { Database } from "./storage";

/** The device value holding the Output location: paths belong to one computer (ADR-0003). */
const OUTPUT_LOCATION = "outputLocation";

/** A file to save (see `OutputFiles.save`). */
export interface NewFile {
  /** The name it should have, e.g. "Tides.docx". Characters file systems refuse are replaced. */
  name: string;
  data: Uint8Array;
  /**
   * What IncarnaMind wrote it as, so checks leave it out of their evidence
   * wherever it ends up (#80): an export or a source pack. Null for a source
   * IncarnaMind saves, such as a Transcript or a web page, which counts.
   */
  ownFile: OwnFileKind | null;
  /** The Folder of the Note it was written from; null for none (see ./documents/ownFiles). */
  fromFolder: string | null;
  /**
   * The folder to save it in, if not the Output location: one inside a Linked
   * folder, e.g. next to the original it was made from. Anywhere else is refused,
   * unless `approved`.
   */
  folder?: string;
  /** The User allowed `folder` for this one file (#1110): it may be anywhere. */
  approved?: boolean;
}

export interface OutputFilesOptions {
  db: Database;
  events: ReturnType<typeof createEventHub>;
  now: () => string;
  settings: SettingsStore;
  /** The default Output location: "IncarnaMind" in the User's Documents folder. */
  suggested: string;
  /** The live Linked folders. */
  linkedFolders(): readonly Pick<LinkedFolder, "id" | "path">[];
  /** Records the fingerprint of a file IncarnaMind wrote, before it is written (see ./documents/ownFiles). */
  recordOwnFile(data: Uint8Array, kind: OwnFileKind, folderId: string | null): void;
}

/** A question as a save raises it, before it has an id. */
type Question = FileWriteRequest extends infer R
  ? R extends FileWriteRequest
    ? Omit<R, "requestId">
    : never
  : never;

interface Pending {
  key: string;
  request: FileWriteRequest;
  promise: Promise<void>;
  settle(): void;
  fail(error: Error): void;
}

interface AnswerRow {
  linked_folder_id: string;
  allowed: number;
  updated_at: string;
}

export type OutputFiles = ReturnType<typeof createOutputFiles>;

/** The name to save under: the one asked for, with what file systems refuse taken out. */
function fileNameOf(input: unknown): string {
  if (typeof input !== "string") throw new InvalidInputError("A file name must be text.");
  const extension = extname(input);
  const kept = /^\.[\p{L}\p{N}]{1,16}$/u.test(extension) ? extension : "";
  return `${safeFileName(input.slice(0, input.length - kept.length), "Untitled")}${kept}`;
}

/** A folder's real path, links followed; throws if it isn't a folder. */
async function realFolder(path: string): Promise<string> {
  const real = await realpath(path);
  if (!(await stat(real)).isDirectory())
    throw new InvalidInputError({ key: "error.path.notFolder" });
  return real;
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isGone = (error: unknown) => codeOf(error) === "ENOENT";
const isRefused = (error: unknown) => ["EACCES", "EPERM", "EROFS"].includes(codeOf(error) ?? "");

/**
 * The default Output location, made with the folders above it if need be, or
 * why it can't take new files.
 */
async function usableDefault(
  folder: string,
): Promise<{ ok: true; real: string } | { ok: false; reason: OutputFolderProblem }> {
  try {
    await mkdir(folder, { recursive: true });
    const real = await realpath(folder);
    await access(real, constants.W_OK);
    return { ok: true, real };
  } catch (error) {
    if (isRefused(error)) return { ok: false, reason: "not-writable" };
    // A file where a folder on the way should be.
    if (["EEXIST", "ENOTDIR", "ENOENT"].includes(codeOf(error) ?? "")) {
      return { ok: false, reason: "missing" };
    }
    throw error;
  }
}

export function createOutputFiles(options: OutputFilesOptions) {
  const { db, events, now, settings } = options;
  const pending = new Map<string, Pending>();
  /** Files saved since the core started: the only ones the window may ask to show. */
  const saved = new Set<string>();

  const location = (): string | null => {
    const value = settings.readDeviceValue(OUTPUT_LOCATION);
    return typeof value === "string" ? value : null;
  };

  // What a force-quit left in the Output location goes now, not at its next save.
  const chosen = location();
  if (chosen !== null) void removeStalePartials(chosen);

  const liveFolder = (linkedFolderId: string) =>
    options.linkedFolders().find((each) => each.id === linkedFolderId);

  /** The Linked folder a folder is in, if any. */
  const ownerOf = (folder: string) =>
    options
      .linkedFolders()
      .filter((each) => isInside(each.path, folder))
      .sort((a, b) => b.path.length - a.path.length)[0];

  const answerOf = (linkedFolderId: string) =>
    db.get<AnswerRow>(
      `SELECT linked_folder_id, allowed, updated_at FROM linked_folder_writes
       WHERE linked_folder_id = ? AND deleted_at IS NULL`,
      [linkedFolderId],
    );

  const current = (): OutputSettings => {
    const paths = new Map(options.linkedFolders().map((each) => [each.id, each.path]));
    const linkedFolders: LinkedFolderWriting[] = [];
    for (const row of db.all<AnswerRow>(
      `SELECT linked_folder_id, allowed, updated_at FROM linked_folder_writes
       WHERE deleted_at IS NULL ORDER BY created_at, rowid`,
    )) {
      const path = paths.get(row.linked_folder_id);
      if (path === undefined) continue;
      linkedFolders.push({
        linkedFolderId: row.linked_folder_id,
        path,
        allowed: row.allowed === 1,
        decidedAt: row.updated_at,
      });
    }
    return { location: location(), suggested: options.suggested, linkedFolders };
  };

  const changed = () => events.emit("outputSettings.changed", current());

  const record = (linkedFolderId: string, allowed: boolean) => {
    const at = now();
    db.transaction(() => {
      if (answerOf(linkedFolderId)) {
        db.run(
          `UPDATE linked_folder_writes SET allowed = ?, updated_at = ?
           WHERE linked_folder_id = ? AND deleted_at IS NULL`,
          [allowed ? 1 : 0, at, linkedFolderId],
        );
      } else {
        db.run(
          `INSERT INTO linked_folder_writes (id, linked_folder_id, allowed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [randomUUID(), linkedFolderId, allowed ? 1 : 0, at, at],
        );
      }
    });
  };

  /** Raises a question, or joins the one already waiting for the same answer. */
  const ask = (key: string, question: Question): Promise<void> => {
    for (const entry of pending.values()) if (entry.key === key) return entry.promise;
    let settle!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const request: FileWriteRequest = { ...question, requestId: randomUUID() };
    pending.set(request.requestId, { key, request, promise, settle, fail });
    events.emit("fileWrite.requested", request);
    return promise;
  };

  /** Lets the saves waiting for an answer go on; each checks what was answered. */
  const finish = (key: string) => {
    for (const entry of [...pending.values()]) {
      if (entry.key !== key) continue;
      pending.delete(entry.request.requestId);
      events.emit("fileWrite.resolved", { requestId: entry.request.requestId });
      entry.settle();
    }
  };

  const setLocation = async (input: unknown): Promise<OutputSettings> => {
    if (typeof input !== "string" || !isAbsolute(input)) {
      throw new InvalidInputError("The output location must be an absolute folder path.");
    }
    let real: string;
    try {
      real = await realFolder(input);
    } catch (error) {
      if (!isGone(error)) throw error;
      if (input !== options.suggested) throw new NotFoundError({ key: "error.path.noFolder" });
      await mkdir(input, { recursive: true });
      real = await realFolder(input);
    }
    settings.writeDeviceValue(OUTPUT_LOCATION, real);
    changed();
    finish("output-location");
    return current();
  };

  /** Asks where new files go, saying why the default can't take this one; cancels if none is chosen. */
  const askForLocation = async (fileName: string, problem: OutputFolderProblem): Promise<void> => {
    await ask("output-location", {
      kind: "output-location",
      suggested: options.suggested,
      fileName,
      problem,
    });
    if (location() === null) throw new FileWriteCancelledError();
  };

  /**
   * The Output location, made again if it was removed from a folder still
   * there. None chosen yet, the default, without asking, kept once a
   * file is written there; asking, saying why, if it can't take files.
   */
  const outputFolder = async (
    fileName: string,
  ): Promise<{ folder: string; defaulted: boolean }> => {
    let chosen = location();
    if (chosen === null) {
      const usable = await usableDefault(options.suggested);
      if (usable.ok) return { folder: usable.real, defaulted: true };
      await askForLocation(fileName, usable.reason);
      chosen = location();
      if (chosen === null) throw new FileWriteCancelledError();
    }
    let real: string;
    try {
      real = await realFolder(chosen);
    } catch (error) {
      if (!isGone(error)) throw error;
      await mkdir(chosen);
      real = await realFolder(chosen);
    }
    // A link put in its place, or above it, that leads elsewhere.
    if (!isInside(chosen, real)) throw new InvalidInputError({ key: "error.files.outside" });
    return { folder: real, defaulted: false };
  };

  /**
   * A folder the caller named, links followed: inside the Output location or a Linked folder,
   * or anywhere the User allowed for this file.
   */
  const givenFolder = async (folder: unknown, approved: boolean): Promise<string> => {
    if (typeof folder !== "string" || !isAbsolute(folder)) {
      throw new InvalidInputError("A folder must be given as an absolute path.");
    }
    const real = await realFolder(folder);
    const chosen = location();
    if (!approved && (chosen === null || !isInside(chosen, real)) && !ownerOf(real)) {
      throw new InvalidInputError({ key: "error.files.outside" });
    }
    return real;
  };

  /**
   * True if the User allows new files in the Linked folder. Not answered yet,
   * it asks, and resolves false once answered, for the save to look again.
   */
  const allowedIn = async (
    linked: Pick<LinkedFolder, "id" | "path">,
    fileName: string,
  ): Promise<boolean> => {
    const answer = answerOf(linked.id);
    if (answer?.allowed === 1) return true;
    if (answer) throw new LinkedFolderWritesDeclinedError(linked.id, linked.path);
    await ask(`linked-folder:${linked.id}`, {
      kind: "linked-folder",
      linkedFolderId: linked.id,
      linkedFolderPath: linked.path,
      fileName,
    });
    return false;
  };

  /** Allows or stops new files in a live Linked folder, from Settings or its question. */
  const setLinkedFolderWriting = (linkedFolderId: unknown, allowed: unknown): OutputSettings => {
    if (typeof linkedFolderId !== "string" || !liveFolder(linkedFolderId)) {
      throw new NotFoundError({ key: "error.linkedFolder.notFound" });
    }
    if (typeof allowed !== "boolean") throw new InvalidInputError("allowed must be true or false.");
    record(linkedFolderId, allowed);
    changed();
    finish(`linked-folder:${linkedFolderId}`);
    return current();
  };

  return {
    settings: current,
    setLocation,
    setLinkedFolderWriting,

    requests: (): FileWriteRequest[] => [...pending.values()].map((entry) => entry.request),

    async respond(requestId: unknown, accept: unknown): Promise<void> {
      if (typeof requestId !== "string") throw new InvalidInputError("requestId must be text.");
      if (typeof accept !== "boolean") throw new InvalidInputError("accept must be true or false.");
      const entry = pending.get(requestId);
      if (!entry) return; // Already answered, e.g. in another window.
      const { request } = entry;
      if (request.kind === "linked-folder") {
        setLinkedFolderWriting(request.linkedFolderId, accept);
      } else if (accept) {
        await setLocation(request.suggested);
      } else {
        finish(entry.key);
      }
    },

    /**
     * Saves a new file: in the Output location (the default the first time),
     * or in `folder`, asking first where the User hasn't answered yet. Throws
     * `FileWriteCancelledError` if the default couldn't take it and they
     * chose no other, `LinkedFolderWritesDeclinedError`
     * if the folder is in a Linked folder they said no to, and
     * `InvalidInputError` if it leads anywhere else.
     */
    async save(file: NewFile): Promise<SavedFile> {
      const name = fileNameOf(file.name);
      // Checked again after every answer: the folder may have been unlinked meanwhile.
      for (;;) {
        const { folder, defaulted } =
          file.folder === undefined
            ? await outputFolder(name)
            : { folder: await givenFolder(file.folder, file.approved === true), defaulted: false };
        const linked = ownerOf(folder);
        if (linked && !(await allowedIn(linked, name))) continue;
        // Before the file exists, so a Linked folder can't index it as the User's.
        if (file.ownFile) options.recordOwnFile(file.data, file.ownFile, file.fromFolder);
        let used: string;
        try {
          used = await writeNewFile(folder, name, file.data);
        } catch (error) {
          // macOS can refuse Documents only when a file is made in it, after the folder looked fine.
          if (!defaulted || !isRefused(error)) throw error;
          await askForLocation(name, "not-writable");
          continue;
        }
        if (defaulted) {
          settings.writeDeviceValue(OUTPUT_LOCATION, folder);
          changed();
        }
        const path = join(folder, used);
        saved.add(path);
        const inDefaultFolder =
          defaulted ||
          (await realFolder(options.suggested).then(
            (real) => real === folder,
            () => false,
          ));
        return { path, name: used, folder, defaulted, inDefaultFolder };
      }
    },

    /** Whether IncarnaMind saved this file since it started. */
    saved: (path: unknown): path is string => typeof path === "string" && saved.has(path),

    /** A Linked folder was unlinked: its answer goes with it, and saves waiting on it look again. */
    forgetLinkedFolder(linkedFolderId: string): void {
      const answered = answerOf(linkedFolderId) !== undefined;
      if (answered) {
        const at = now();
        db.run(
          `UPDATE linked_folder_writes SET deleted_at = ?, updated_at = ?
           WHERE linked_folder_id = ? AND deleted_at IS NULL`,
          [at, at, linkedFolderId],
        );
      }
      finish(`linked-folder:${linkedFolderId}`);
      if (answered) changed();
    },

    /** Fails every save still waiting, so nothing is left hanging after the core closes. */
    close(): void {
      for (const entry of pending.values()) entry.fail(new Error("IncarnaMind closed."));
      pending.clear();
    },
  };
}
