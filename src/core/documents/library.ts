/**
 * The User's library on disk (ADR-0010): Linked folders, and the files of
 * every Document, indexed where they are. This module keeps the index in step
 * with the disk, and only ever reads the User's files: it never writes,
 * renames or deletes anything in a Linked folder or next to a single file.
 *
 * It works in passes, one at a time. A pass looks at some paths (a whole
 * Linked folder at start-up, after a watcher error, or when linked; the paths
 * a watcher reported; a single file being opened) and compares what is on
 * disk with the Documents indexed there:
 * - a known file is read again only when its size or modified time changed,
 *   and then hashed with SHA-256: the same hash only updates what was seen; a
 *   new one is a new version, processed again;
 * - a new file is hashed: if a Document with that hash lost its file (missing
 *   since, gone in this pass, or a copy left in the data folder by the old
 *   layout), it is that Document, moved, keeping its id, Tags and Citations.
 *   Failing that, it may be one whose file went, moved and edited
 *   (`editedDocument`): a new version of it. Otherwise it is a new Document.
 *   New files are indexed newest first, and those modified at the same moment
 *   in the order of their paths;
 * - a known file that is gone makes its Document missing, or unavailable if
 *   what it was in can't be reached (an unplugged drive).
 *
 * Cloud placeholders (online-only files) are counted, never read, unless the
 * User asks to download them: reading one would download it.
 *
 * Files added on their own are watched too, by the folder they are in
 * (without its subfolders): a change is read as a new version, a deleted
 * file goes missing, and a file moved or renamed into a folder watched so is
 * followed by its content. Nothing else in such a folder is added.
 *
 * A Document is known by where its file belongs, the same on every computer
 * (ADR-0020): its Linked folder and its path inside it, its path inside the
 * data folder, or, for a file added on its own, nothing but its id. Its `path`
 * is where that is on this computer: a Linked folder found somewhere else
 * (`locate`) takes its Documents with it.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";
import type {
  DocumentKind,
  LinkedFolder,
  LinkedFolderLayout,
  LinkedFolderPreview,
  LinkedFolderStatus,
  SkippedFile,
  UnsupportedFile,
} from "../api";
import { InvalidInputError, NotFoundError } from "../errors";
import { type Folders, folderIdFor } from "../folders";
import type { Database } from "../storage";
import { markArrived } from "../tags/held";
import {
  createIgnore,
  type FileIdentity,
  type FoundFile,
  fileIdentity,
  hashFile,
  iCloudStubTarget,
  isDataless,
  isFolder,
  isGone,
  isInside,
  isLegacyCopy,
  kindOf,
  nameFromPath,
  parentOf,
  pathIn,
  relativePath,
  type StatIdentity,
  statFile,
  walk,
} from "./files";
import type { FolderWatcher, WatchFolder } from "./watcher";

/** A Document as this module sees it. */
export interface FileRow {
  id: string;
  path: string;
  name: string;
  kind: string;
  content_hash: string;
  size: number;
  file_mtime_ms: number | null;
  file_status: string;
  linked_folder_id: string | null;
  folder_id: string | null;
  source_kind: string;
  relative_path: string | null;
  status: string;
  /** Unless "failed": the latest version read failed, and this is the last good one. */
  failure_reason: string | null;
  file_device: string | null;
  file_number: string | null;
  file_created_ns: string | null;
}

const FILE_COLUMNS = `id, path, name, kind, content_hash, size, file_mtime_ms, file_status,
  linked_folder_id, folder_id, source_kind, relative_path, status, failure_reason,
  file_device, file_number, file_created_ns`;

/** A file's identity on its disk (`FileIdentity`), set together with `identityValues`. */
const IDENTITY_COLUMNS = "file_device = ?, file_number = ?, file_created_ns = ?";
const identityValues = (identity: FileIdentity | null) =>
  [identity?.device ?? null, identity?.number ?? null, identity?.createdNs ?? null] as const;

/** Set where a Document's path comes to name a file that may be another, until it is seen. */
export const FORGET_FILE_IDENTITY =
  "file_device = NULL, file_number = NULL, file_created_ns = NULL";

/**
 * A file from another disk is only taken for a Document moved and edited
 * (`editedDocument`) if its size is this close to the Document's: within this
 * share of the larger, or this many bytes for small files.
 */
const EDITED_SIZE_SHARE = 0.1;
const EDITED_SIZE_BYTES = 16 * 1024;
const closeInSize = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(EDITED_SIZE_BYTES, EDITED_SIZE_SHARE * Math.max(a, b));

/** The file names that more than one of these files has. */
function repeatedNames(paths: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const path of paths) {
    const name = basename(path);
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return repeated;
}

/**
 * Where a Document's file belongs (`documents.source_kind`): in a Linked
 * folder, in the data folder (a web page's snapshot, saved text, the old
 * layout's copies), or added on its own.
 */
type SourceKind = "linked-folder" | "data-folder" | "file";

/** Where a file belongs, and its Folder: what `placeOf` works out from its path. */
interface Place {
  linkedFolderId: string | null;
  folderId: string | null;
  sourceKind: SourceKind;
  relativePath: string | null;
}

/** At most this many of a Linked folder's files are looked for in a folder offered as its new place. */
const LOCATE_SAMPLE = 100;

interface LinkedFolderRow {
  id: string;
  path: string;
  layout: string | null;
  paused: number;
  ignore_patterns: string;
  created_at: string;
  updated_at: string;
}

const FOLDER_COLUMNS = "id, path, layout, paused, ignore_patterns, created_at, updated_at";

/** Statuses of a Document once processing has finished with it. */
const PROCESSED = "('ready', 'no-text', 'failed')";

/** A folder is laid out flat when this share of its folders with files hold exactly one. */
const FLAT_SHARE = 0.9;
/**
 * …and there are at least this many such folders: a big, Zotero-like
 * library. A small one keeps its folders, which the User made on purpose.
 */
const FLAT_MIN_FOLDERS = 20;

/** How often Linked folders' progress reaches the UI, at most. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * The layout a Linked folder gets: flat when nearly every folder in it that
 * holds supported files holds exactly one, as in Zotero's storage folder
 * (storage/<KEY>/paper.pdf). Takes the files' paths relative to it.
 */
export function suggestLayout(relatives: Iterable<string>): LinkedFolderLayout {
  const perFolder = new Map<string, number>();
  for (const relative of relatives) {
    const parent = parentOf(relative);
    if (parent !== "") perFolder.set(parent, (perFolder.get(parent) ?? 0) + 1);
  }
  if (perFolder.size < FLAT_MIN_FOLDERS) return "tree";
  const single = [...perFolder.values()].filter((count) => count === 1).length;
  return single / perFolder.size >= FLAT_SHARE ? "flat" : "tree";
}

/** What the library needs from the rest of the Documents module. */
export interface LibraryHooks {
  /** Processing is due (a new file, or a new version): queue it, unless its Linked folder is paused. */
  process(documentId: string): void;
  /**
   * A Document found queued, its file still the version it was: queue it if its job was dropped.
   * A job still queued, waiting its turn in the scan lane or under way keeps its place.
   */
  stillQueued(documentId: string): void;
  /** Push a Document's current state. */
  announce(documentId: string): void;
  /** A new Document was stored and announced; its processing isn't queued yet. */
  added(documentId: string): void;
  /** These Documents moved to another Folder, or into or out of a Linked folder. */
  moved(documentIds: string[]): void;
  /** A Document's name followed its file's: its keyword index needs the new name. */
  renamed(documentId: string): void;
  /**
   * Removes these Documents from the index with their Linked folder, keeping
   * the text their Citations quote.
   */
  remove(documentIds: string[], at: string): void;
  /** A Linked folder was paused (hold its queued work) or resumed (queue it again). */
  paused(linkedFolderId: string, paused: boolean): void;
  foldersChanged(): void;
  linkedFoldersChanged(list: LinkedFolder[]): void;
  /** Asks iCloud Drive to download the file an ".icloud" stub stands for. Optional. */
  downloadStub?: (path: string) => Promise<void>;
  reportError(error: unknown): void;
}

export interface LibraryOptions {
  db: Database;
  now: () => string;
  /**
   * The data folder: the files IncarnaMind keeps (web pages' snapshots, saved
   * text) are its Documents' files, and so are copies the old layout made in
   * its `documents/`, until relinked.
   */
  dataDir: string;
  folders: Folders;
  hooks: LibraryHooks;
  watch: WatchFolder;
  stat: StatIdentity;
  retryMs: number;
  detectDataless: boolean;
  /** How long reading these files takes on this computer, in seconds (./readingSpeed). */
  readingSeconds(files: readonly FoundFile[]): number | null;
}

/** What one pass looks at. */
interface PassRequest {
  /** Every Linked folder, whole, and every single file. */
  all: boolean;
  /** These Linked folders, whole. */
  folders: Set<string>;
  /** These paths, and everything below them. */
  paths: Set<string>;
}

const emptyRequest = (): PassRequest => ({ all: false, folders: new Set(), paths: new Set() });

/** A file found on disk, with the Linked folder it is in. */
interface Found extends FoundFile {
  owner: LinkedFolderRow | null;
}

/** Whether a file can be opened for reading, without reading any of it. */
async function canOpen(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `folder` holds one of a Linked folder's files at its relative path,
 * those whose file was last seen first: a few of them are enough to tell the
 * folder it moved to from a wrong one, which would leave all of them missing.
 */
async function holdsAny(
  folder: string,
  documents: readonly { relative_path: string; file_status: string }[],
): Promise<boolean> {
  const sample = [...documents]
    .sort((a, b) => Number(a.file_status === "missing") - Number(b.file_status === "missing"))
    .slice(0, LOCATE_SAMPLE);
  for (const each of sample) {
    if (await statFile(pathIn(folder, each.relative_path)).catch(() => undefined)) return true;
  }
  return false;
}

/** Strings from `from` (inclusive) to `to` (exclusive): every path inside the folder `prefix`. */
const insideRange = (prefix: string) => {
  const folder = prefix.endsWith(sep) ? prefix : `${prefix}${sep}`;
  const next = String.fromCharCode(sep.charCodeAt(0) + 1);
  return [folder, `${folder.slice(0, -1)}${next}`] as const;
};

/** A Linked folder's id, as the API takes it. */
function parseLinkedFolderId(idInput: unknown): string {
  if (typeof idInput !== "string" || idInput === "") {
    throw new InvalidInputError("A Linked folder id is required.");
  }
  return idInput;
}

export function createLibrary(options: LibraryOptions) {
  const { db, now, folders, hooks } = options;
  /** The data folder as given, then with links resolved, as the files added from it are. */
  const dataFolders = [...new Set([options.dataDir, realpathSync(options.dataDir)])];
  const realDataFolder = dataFolders.at(-1) ?? options.dataDir;

  /** A path's place inside the data folder ("/" between names), or null if it isn't in it. */
  const insideDataFolder = (path: string): string | null => {
    const folder = dataFolders.find((each) => path !== each && isInside(each, path));
    return folder === undefined ? null : relativePath(folder, path);
  };

  // The files IncarnaMind keeps are wherever the data folder is now, also when it moved
  // or was copied to another computer. Files added on their own from inside it (the old
  // layout's copies, saved text) are such files. Derived on each computer, like `path`,
  // so updated_at is left alone.
  db.transaction(() => {
    for (const row of db.all<{
      id: string;
      path: string | null;
      source_kind: string;
      relative_path: string | null;
    }>(
      `SELECT id, path, source_kind, relative_path FROM documents
       WHERE linked_folder_id IS NULL AND source_kind IN ('data-folder', 'file')`,
    )) {
      if (row.source_kind === "data-folder" && row.relative_path !== null) {
        const relative = row.relative_path;
        if (!dataFolders.some((folder) => pathIn(folder, relative) === row.path)) {
          db.run(`UPDATE documents SET path = ?, ${FORGET_FILE_IDENTITY} WHERE id = ?`, [
            pathIn(realDataFolder, relative),
            row.id,
          ]);
        }
        continue;
      }
      const relative = row.path === null ? null : insideDataFolder(row.path);
      if (row.source_kind === "file" && relative !== null) {
        db.run("UPDATE documents SET source_kind = 'data-folder', relative_path = ? WHERE id = ?", [
          relative,
          row.id,
        ]);
      }
    }
  });

  const watchers = new Map<string, FolderWatcher>();
  /** The folders holding files added on their own, each watched without its subfolders. */
  const singleWatchers = new Map<string, FolderWatcher>();
  /** Such folders whose watcher failed: watched again, and looked at, at the next retry. */
  const singleWatchesFailed = new Set<string>();
  const statuses = new Map<string, Exclude<LinkedFolderStatus, "paused">>();
  /** Each Linked folder's cloud placeholders: path to size. */
  const onlineOnly = new Map<string, Map<string, number>>();
  /** Each Linked folder's files in a format not read (#740): their absolute paths. */
  const unsupported = new Map<string, Set<string>>();
  /** Linked folders whose placeholders the User asked to download: read in their next whole pass. */
  const downloading = new Set<string>();
  /** Files found but not yet added in the pass under way, per Linked folder: counted in its progress. */
  const pendingNew = new Map<string, number>();
  /** New files that couldn't be read: tried again later. */
  const unreadable = new Set<string>();
  /** Documents found missing in the pass under way, and in the one before: see `editedDocument`. */
  let missingNow = new Set<string>();
  let missingBefore = new Set<string>();
  let closed = false;

  // --- Linked folder rows -------------------------------------------------

  const baselineScanned = (id: string) =>
    db.get<{ id: string }>(
      "SELECT id FROM linked_folder_baselines WHERE linked_folder_id = ? AND deleted_at IS NULL",
      [id],
    ) !== undefined;
  const liveFolders = () =>
    db.all<LinkedFolderRow>(
      `SELECT ${FOLDER_COLUMNS} FROM linked_folders WHERE deleted_at IS NULL ORDER BY path`,
    );

  const folderRow = (id: string) =>
    db.get<LinkedFolderRow>(
      `SELECT ${FOLDER_COLUMNS} FROM linked_folders WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );

  const ignoreOf = (row: LinkedFolderRow) => {
    let patterns: unknown;
    try {
      patterns = JSON.parse(row.ignore_patterns);
    } catch {
      patterns = [];
    }
    return createIgnore(
      Array.isArray(patterns) ? patterns.filter((each) => typeof each === "string") : [],
    );
  };

  /** The live Linked folder a path is in (the innermost, though they never nest), or undefined. */
  const ownerOf = (path: string, rows = liveFolders()) =>
    rows.filter((row) => isInside(row.path, path)).sort((a, b) => b.path.length - a.path.length)[0];

  const statusOf = (row: LinkedFolderRow): LinkedFolderStatus =>
    row.paused ? "paused" : (statuses.get(row.id) ?? "scanning");

  function toLinkedFolder(row: LinkedFolderRow): LinkedFolder {
    const counts = db.get<{ files: number; indexed: number | null }>(
      `SELECT count(*) AS files, sum(status IN ${PROCESSED}) AS indexed FROM documents
       WHERE linked_folder_id = ? AND deleted_at IS NULL AND file_status <> 'missing'`,
      [row.id],
    );
    const placeholders = onlineOnly.get(row.id) ?? new Map<string, number>();
    let bytes = 0;
    for (const size of placeholders.values()) bytes += size;
    return {
      id: row.id,
      path: row.path,
      folderId: folderIdFor(row.id, ""),
      status: statusOf(row),
      layout: row.layout === "flat" ? "flat" : "tree",
      progress: {
        files: (counts?.files ?? 0) + (pendingNew.get(row.id) ?? 0),
        indexed: counts?.indexed ?? 0,
      },
      onlineOnly: { files: placeholders.size, bytes, downloading: downloading.has(row.id) },
      unsupportedFiles: unsupported.get(row.id)?.size ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const list = (): LinkedFolder[] => liveFolders().map(toLinkedFolder);

  const announceFolders = () => {
    if (!closed) hooks.linkedFoldersChanged(list());
  };

  /** Progress reaches the UI at most every PROGRESS_INTERVAL_MS. */
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const announceProgress = () => {
    if (progressTimer || closed) return;
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      announceFolders();
    }, PROGRESS_INTERVAL_MS);
    progressTimer.unref?.();
  };

  const setStatus = (id: string, status: Exclude<LinkedFolderStatus, "paused">) => {
    if (statuses.get(id) === status) return;
    statuses.set(id, status);
    announceFolders();
  };

  // --- Passes, one at a time ------------------------------------------------

  let chain: Promise<unknown> = Promise.resolve();
  /** Runs `task` after every task queued before it. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  /** Work queued or under way; `idle()` waits for none. */
  let outstanding = 0;
  let idleWaiters: (() => void)[] = [];
  const begin = () => {
    outstanding++;
  };
  const end = () => {
    outstanding--;
    if (outstanding > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const idle = () =>
    outstanding === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => idleWaiters.push(resolve));

  /** Changes reported but not yet looked at: one pass takes them all. */
  let pending = emptyRequest();
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  /** Queues a pass over what `change` names, merged with any other queued meanwhile. */
  function request(change: {
    all?: boolean;
    folders?: Iterable<string>;
    paths?: Iterable<string>;
  }): void {
    if (closed) return;
    if (change.all) pending.all = true;
    for (const id of change.folders ?? []) pending.folders.add(id);
    for (const path of change.paths ?? []) pending.paths.add(path);
    if (pendingTimer) return;
    begin();
    // A moment's wait, so paths reported together (a folder renamed) go in one pass.
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      const taken = pending;
      pending = emptyRequest();
      exclusive(() => runTracked(taken))
        .catch((error: unknown) => hooks.reportError(error))
        .finally(end);
    }, 20);
    pendingTimer.unref?.();
  }

  /** Whether a pass is under way: a long one (a big folder linked) shouldn't hold up opening a file. */
  let passRunning = false;
  async function runTracked(taken: PassRequest): Promise<void> {
    passRunning = true;
    try {
      await runPass(taken);
    } finally {
      passRunning = false;
    }
  }

  // --- Watching -------------------------------------------------------------

  function startWatcher(id: string): void {
    // The folder as it is now: a pass reads every row first, and one can be paused or unlinked
    // while an earlier folder is scanned (#2302).
    const row = folderRow(id);
    if (closed || !row || row.paused || watchers.has(row.id)) return;
    const ignore = ignoreOf(row);
    const watcher = options.watch(row.path, {
      onChange(paths) {
        const current = folderRow(row.id);
        if (!current || current.paused) return;
        const relevant = paths.filter((path) => {
          if (!isInside(row.path, path)) return false;
          if (iCloudStubTarget(basename(path))) return true;
          return !ignore(relativePath(row.path, path));
        });
        if (relevant.length > 0) request({ paths: relevant });
      },
      onError() {
        // Events may have been missed: look at the whole folder, then watch it again.
        watchers.delete(row.id);
        request({ folders: [row.id] });
      },
    });
    watchers.set(row.id, watcher);
  }

  const stopWatcher = (id: string) => {
    watchers.get(id)?.close();
    watchers.delete(id);
  };

  /** The paths of the files added on their own in a folder (not in its subfolders). */
  const singlesIn = (folder: string) =>
    db
      .all<{ path: string }>(
        `SELECT path FROM documents WHERE deleted_at IS NULL AND linked_folder_id IS NULL`,
      )
      .map((row) => row.path)
      .filter((path) => dirname(path) === folder);

  /**
   * Watches each folder holding a file added on its own, as long as it holds
   * one and can be reached; one inside a Linked folder is left to its watcher, and
   * the old layout's copies in the data folder aren't watched.
   */
  function watchSingles(): void {
    if (closed) return;
    const linked = liveFolders();
    const wanted = new Set<string>();
    for (const { path } of db.all<{ path: string }>(
      `SELECT path FROM documents
       WHERE deleted_at IS NULL AND linked_folder_id IS NULL AND file_status <> 'unavailable'`,
    )) {
      if (!isLegacyCopy(options.dataDir, path) && !ownerOf(path, linked)) wanted.add(dirname(path));
    }
    for (const [folder, watcher] of singleWatchers) {
      if (wanted.has(folder)) continue;
      watcher.close();
      singleWatchers.delete(folder);
    }
    for (const folder of wanted) {
      if (singleWatchers.has(folder) || singleWatchesFailed.has(folder)) continue;
      const watcher = options.watch(
        folder,
        {
          onChange(paths) {
            // A file added on its own, or a file that may be one, moved or renamed.
            const relevant = paths.flatMap((path) => {
              if (path === folder) return singlesIn(folder); // something changed, not said what
              return dirname(path) === folder && kindOf(path) ? [path] : [];
            });
            if (relevant.length > 0) request({ paths: relevant });
          },
          onError() {
            // Events may have been missed: its files are looked at again with the next retry.
            if (singleWatchers.get(folder) === watcher) singleWatchers.delete(folder);
            singleWatchesFailed.add(folder);
          },
        },
        { recursive: false },
      );
      // A watcher that failed at once has already said so.
      if (!singleWatchesFailed.has(folder)) singleWatchers.set(folder, watcher);
    }
  }

  // --- Documents --------------------------------------------------------------

  const documentAt = (path: string) =>
    db.get<FileRow>(`SELECT ${FILE_COLUMNS} FROM documents WHERE path = ? AND deleted_at IS NULL`, [
      path,
    ]);

  const documentById = (id: string) =>
    db.get<FileRow>(`SELECT ${FILE_COLUMNS} FROM documents WHERE id = ? AND deleted_at IS NULL`, [
      id,
    ]);

  /** Which file is at a path on this computer's disks now, or null if it can't be told. */
  const identify = (path: string): Promise<FileIdentity | null> =>
    options.stat(path).then(fileIdentity, () => null);

  /** The live Documents at `path` or inside it. */
  const documentsUnder = (path: string) => {
    const [from, to] = insideRange(path);
    return db.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM documents
       WHERE deleted_at IS NULL AND (path = ? OR (path >= ? AND path < ?))`,
      [path, from, to],
    );
  };

  /**
   * Where a file belongs: its Linked folder, its path there and its Folder;
   * else its path in the data folder; else nowhere but itself, added on its own.
   */
  const placeOf = (path: string, owner: LinkedFolderRow | null): Place => {
    if (owner) {
      const relative = relativePath(owner.path, path);
      return {
        linkedFolderId: owner.id,
        folderId: folderIdFor(owner.id, parentOf(relative)),
        sourceKind: "linked-folder",
        relativePath: relative,
      };
    }
    const kept = insideDataFolder(path);
    return {
      linkedFolderId: null,
      folderId: null,
      sourceKind: kept === null ? "file" : "data-folder",
      relativePath: kept,
    };
  };

  /** A Place's columns, set together with `placeValues`. */
  const PLACE_COLUMNS = "linked_folder_id = ?, folder_id = ?, source_kind = ?, relative_path = ?";
  const placeValues = (place: Place) =>
    [place.linkedFolderId, place.folderId, place.sourceKind, place.relativePath] as const;

  const placeDiffers = (row: FileRow, place: Place) =>
    row.linked_folder_id !== place.linkedFolderId ||
    row.folder_id !== place.folderId ||
    row.source_kind !== place.sourceKind ||
    row.relative_path !== place.relativePath;

  /**
   * The User removed the Document at this path from this Linked folder: its
   * file stays out, wherever the folder is.
   */
  const removedByUser = (path: string, owner: LinkedFolderRow) =>
    db.get(
      `SELECT 1 FROM documents
       WHERE linked_folder_id = ? AND relative_path = ? AND deleted_at IS NOT NULL`,
      [owner.id, relativePath(owner.path, path)],
    ) !== undefined;

  /** The owner may have been removed or paused since the pass began: then its files are left alone. */
  const ownerStillActive = (owner: LinkedFolderRow | null) => {
    if (!owner) return true;
    const current = folderRow(owner.id);
    return current !== undefined && !current.paused;
  };

  /** Records what changed about a Document; the pass pushes it once at the end. */
  interface Changes {
    announced: Set<string>;
    moved: Set<string>;
    folders: Set<string>;
    added?: (documentId: string) => void;
  }

  function setFileStatus(row: FileRow, status: string, changes: Changes): void {
    if (row.file_status === status) return;
    db.run("UPDATE documents SET file_status = ?, updated_at = ? WHERE id = ?", [
      status,
      now(),
      row.id,
    ]);
    changes.announced.add(row.id);
  }

  /**
   * A known Document whose file is still at its path: reads it again only if
   * its size or modified time changed. Returns false if it turned out to be
   * gone after all.
   */
  async function checkKnown(row: FileRow, file: Found, changes: Changes): Promise<boolean> {
    const place = placeOf(row.path, file.owner);
    const placeChanged = placeDiffers(row, place);
    const unchanged = row.size === file.size && row.file_mtime_ms === file.mtimeMs;
    // A placeholder isn't read: what was indexed of it stands.
    if (file.onlineOnly || unchanged) {
      // Back after being out of reach, or unreadable: it can be opened again, or still waits.
      if (row.file_status !== "available" && !file.onlineOnly && !(await canOpen(row.path))) {
        setFileStatus(row, "unavailable", changes);
        return true;
      }
      if (placeChanged || row.file_status !== "available") {
        db.run(
          `UPDATE documents SET ${PLACE_COLUMNS}, file_status = 'available', updated_at = ?
           WHERE id = ?`,
          [...placeValues(place), now(), row.id],
        );
        changes.announced.add(row.id);
      }
      if (placeChanged) noteMoved(row, place, changes);
      if (row.file_device === null) await noteIdentity(row);
      if (row.status === "queued") hooks.stillQueued(row.id);
      return true;
    }
    let hashed: Awaited<ReturnType<typeof hashFile>>;
    try {
      hashed = await hashFile(row.path);
    } catch (error) {
      if (isGone(error)) return false;
      setFileStatus(row, "unavailable", changes);
      return true;
    }
    const identity = await identify(row.path);
    const current = documentById(row.id);
    if (!current || current.path !== row.path) return true; // removed or moved meanwhile
    const newVersion = hashed.contentHash !== current.content_hash;
    // Put back as the version indexed, after a version that couldn't be read: nothing failed now.
    const recovered = !newVersion && current.status !== "failed" && current.failure_reason !== null;
    db.run(
      `UPDATE documents SET size = ?, file_mtime_ms = ?, file_status = 'available',
         ${PLACE_COLUMNS}, ${IDENTITY_COLUMNS}, updated_at = ?
       WHERE id = ?`,
      [
        hashed.size,
        file.mtimeMs,
        ...placeValues(place),
        ...identityValues(identity),
        now(),
        row.id,
      ],
    );
    if (recovered) {
      db.run(
        `UPDATE documents SET failure_reason = NULL, failure_message = NULL
         WHERE id = ? AND status <> 'failed'`,
        [row.id],
      );
    }
    // Only what the UI shows is announced: a modified time alone isn't. (A new
    // version is announced as it is queued.)
    if (placeChanged || recovered || current.file_status !== "available") {
      changes.announced.add(row.id);
    }
    if (placeChanged) noteMoved(row, place, changes);
    // A new version is processed; its text replaces the old one's in search once indexed.
    if (newVersion) hooks.process(row.id);
    else if (current.status === "queued") hooks.stillQueued(row.id);
    return true;
  }

  /** Records which file a Document's is on this computer's disks, unless it moved meanwhile. */
  async function noteIdentity(row: FileRow): Promise<void> {
    const identity = await identify(row.path);
    if (!identity) return;
    db.run(`UPDATE documents SET ${IDENTITY_COLUMNS} WHERE id = ? AND path = ?`, [
      ...identityValues(identity),
      row.id,
      row.path,
    ]);
  }

  function noteMoved(
    row: Pick<FileRow, "id" | "linked_folder_id" | "folder_id">,
    place: { linkedFolderId: string | null; folderId: string | null },
    changes: Changes,
  ): void {
    if (row.folder_id !== place.folderId || row.linked_folder_id !== place.linkedFolderId) {
      changes.moved.add(row.id);
    }
    if (row.linked_folder_id) changes.folders.add(row.linked_folder_id);
    if (place.linkedFolderId) changes.folders.add(place.linkedFolderId);
  }

  function consumeMatchedSource(row: FileRow, removed: FileRow[]): void {
    const at = removed.findIndex((each) => each.id === row.id);
    if (at !== -1) removed.splice(at, 1);
  }

  /**
   * The Document a new file is, moved: one with the same content whose file
   * went, in this pass (`removed`) or before (missing), or whose copy in the
   * data folder the old layout made. With `single`, only a file added on its
   * own, and not such a copy.
   */
  async function movedDocument(
    contentHash: string,
    path: string,
    removed: FileRow[],
    single = false,
  ): Promise<FileRow | undefined> {
    const name = basename(path);
    const inPass = removed
      .filter((row) => row.content_hash === contentHash && (!single || !row.linked_folder_id))
      .sort((a, b) => Number(basename(b.path) === name) - Number(basename(a.path) === name))[0];
    if (inPass) return inPass;
    const candidates = db.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM documents
       WHERE content_hash = ? AND path <> ? AND deleted_at IS NULL
         ${single ? "AND linked_folder_id IS NULL" : ""}
       ORDER BY file_status = 'missing' DESC, created_at`,
      [contentHash, path],
    );
    for (const row of candidates) {
      if (single && isLegacyCopy(options.dataDir, row.path)) continue;
      if (row.file_status === "missing" || isLegacyCopy(options.dataDir, row.path)) return row;
      // Gone, though no event has said so yet: moved before its old path was looked at.
      if (row.file_status === "available" && !(await statFile(row.path).catch(() => true))) {
        return row;
      }
    }
    return undefined;
  }

  /**
   * The Document a new file is, moved and edited where IncarnaMind didn't see
   * it (#389), once its content matched none: the one whose file went that was
   * this file on its disk. Or one whose file went in this pass or was found
   * missing in the last, with the file's name: on the same disk, saved by an
   * editor that replaces the file (#604), the one with its creation time, or
   * else one with an older modified time; from another disk, which gives the
   * file a new number, one with an older modified time and a size close to
   * its. Those without the creation time only if no other new file in the
   * pass has that name (`twins`). Never one of two that fit. With `single`,
   * only a file added on its own.
   */
  async function editedDocument(
    file: Found,
    identity: FileIdentity | null,
    removed: FileRow[],
    twins: ReadonlySet<string>,
    single = false,
  ): Promise<FileRow | undefined> {
    if (!identity) return undefined;
    const fits = (row: FileRow) =>
      row.kind === file.kind &&
      !isLegacyCopy(options.dataDir, row.path) &&
      (!single || !row.linked_folder_id);
    let candidates = (await sameFileGone(file.path, identity, removed)).filter(fits);
    const named = candidates.length === 0 ? goneWithName(file, removed).filter(fits) : [];
    if (named.length > 0) candidates = savedAgain(file, identity, named, twins);
    const [match] = candidates;
    if (!match || candidates.length > 1) return undefined;
    return match;
  }

  /** The Documents whose file went that had this identity: the same device, file number and creation time. */
  async function sameFileGone(
    path: string,
    identity: FileIdentity,
    removed: readonly FileRow[],
  ): Promise<FileRow[]> {
    const { device, number, createdNs } = identity;
    if (number === null || createdNs === null) return [];
    const found = new Map<string, FileRow>();
    for (const row of removed) {
      if (
        row.file_device === device &&
        row.file_number === number &&
        row.file_created_ns === createdNs
      ) {
        found.set(row.id, row);
      }
    }
    for (const row of db.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM documents
       WHERE file_number = ? AND file_device = ? AND file_created_ns = ? AND path <> ?
         AND deleted_at IS NULL`,
      [number, device, createdNs, path],
    )) {
      if (found.has(row.id)) continue;
      // Gone, though no event has said so yet; one still there is a second link to the file.
      if (
        row.file_status === "missing" ||
        (row.file_status === "available" && !(await statFile(row.path).catch(() => true)))
      ) {
        found.set(row.id, row);
      }
    }
    return [...found.values()];
  }

  /**
   * The ones of `named` (`goneWithName`) a file could be, its content and
   * number new. On its disk: the ones that had its creation time, which Word
   * keeps when it saves by replacing the file; else, as Pages saves, those
   * with an older modified time, whatever their size, since an editor's save
   * can make a file several times larger. From another disk: those with an
   * older modified time and a size close to its. Only the creation time
   * holds when another new file has the name.
   */
  function savedAgain(
    file: Found,
    identity: FileIdentity,
    named: readonly FileRow[],
    twins: ReadonlySet<string>,
  ): FileRow[] {
    const sameDisk = named.filter((row) => row.file_device === identity.device);
    const created = sameDisk.filter(
      (row) => identity.createdNs !== null && row.file_created_ns === identity.createdNs,
    );
    if (created.length > 0 || twins.has(basename(file.path))) return created;
    const older = (row: FileRow) => row.file_mtime_ms !== null && file.mtimeMs > row.file_mtime_ms;
    return named.filter(
      (row) =>
        older(row) && (row.file_device === identity.device || closeInSize(row.size, file.size)),
    );
  }

  /**
   * The Documents whose file went in this pass or was found missing in the
   * last, with the file's name, whose disk was known.
   */
  function goneWithName(file: Found, removed: readonly FileRow[]): FileRow[] {
    const recent = new Map<string, FileRow>();
    for (const row of removed) {
      if (row.file_status === "available" || missingBefore.has(row.id)) recent.set(row.id, row);
    }
    if (missingBefore.size > 0) {
      for (const row of db.all<FileRow>(
        `SELECT ${FILE_COLUMNS} FROM documents
         WHERE id IN (SELECT value FROM json_each(?)) AND file_status = 'missing'
           AND deleted_at IS NULL`,
        [JSON.stringify([...missingBefore])],
      )) {
        if (!recent.has(row.id)) recent.set(row.id, row);
      }
    }
    const name = basename(file.path);
    return [...recent.values()].filter(
      (row) => row.file_device !== null && basename(row.path) === name,
    );
  }

  /**
   * Points a Document at its file's new path, keeping its id, Tags and
   * Citations; a new version of it is processed. Returns false if that can't
   * be done any more: the Document changed meanwhile, or another one is at
   * the path.
   */
  async function relocate(
    row: FileRow,
    file: Found,
    seen: { size: number; identity: FileIdentity | null; newVersion: boolean },
    changes: Changes,
  ): Promise<boolean> {
    const current = documentById(row.id);
    const there = documentAt(file.path);
    if (!current || current.path !== row.path || (there && there.id !== row.id)) return false;
    const place = placeOf(file.path, file.owner);
    // A name that was the file's name follows the file; one the User chose stays.
    const name = row.name === nameFromPath(row.path) ? nameFromPath(file.path) : row.name;
    db.run(
      `UPDATE documents SET path = ?, ${PLACE_COLUMNS}, file_status = 'available',
         size = ?, file_mtime_ms = ?, name = ?, ${IDENTITY_COLUMNS}, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [
        file.path,
        ...placeValues(place),
        seen.size,
        file.mtimeMs,
        name,
        ...identityValues(seen.identity),
        now(),
        row.id,
      ],
    );
    changes.announced.add(row.id);
    noteMoved(row, place, changes);
    if (name !== row.name) hooks.renamed(row.id);
    if (seen.newVersion || current.status === "queued") hooks.process(row.id);
    // The old layout's copy in the data folder isn't needed once the original is linked.
    if (isLegacyCopy(options.dataDir, row.path)) {
      await rm(row.path, { force: true }).catch((error: unknown) => hooks.reportError(error));
    }
    return true;
  }

  /**
   * A file not indexed at its path: the Document it is, moved, or a new one.
   * Returns its Document's id, or undefined if it wasn't added.
   */
  async function addFound(
    file: Found,
    removed: FileRow[],
    changes: Changes,
    explicit: boolean,
    twins: ReadonlySet<string>,
    /** When IncarnaMind saw it arrive new (see `arrivalOf`); null when a later scan found it. */
    arrival: string | null,
  ): Promise<string | undefined> {
    if (!explicit && file.owner && removedByUser(file.path, file.owner)) return undefined;
    let hashed: Awaited<ReturnType<typeof hashFile>>;
    try {
      hashed = await hashFile(file.path);
    } catch (error) {
      if (!isGone(error)) unreadable.add(file.path);
      return undefined;
    }
    unreadable.delete(file.path);
    // A paused (or removed) Linked folder's files are left alone, unless the User adds one.
    if (closed || (!explicit && !ownerStillActive(file.owner))) return undefined;
    const identity = await identify(file.path);
    const moved =
      (await movedDocument(hashed.contentHash, file.path, removed)) ??
      (await editedDocument(file, identity, removed, twins));
    if (closed || (!explicit && !ownerStillActive(file.owner))) return undefined;
    const seen = {
      size: hashed.size,
      identity,
      newVersion: moved?.content_hash !== hashed.contentHash,
    };
    if (moved && (await relocate(moved, file, seen, changes))) {
      consumeMatchedSource(moved, removed);
      return moved.id;
    }
    // Checked just before writing, with nothing awaited in between: another task may have added it.
    const there = documentAt(file.path);
    if (there) return there.id;
    if (closed || (!explicit && !ownerStillActive(file.owner))) return undefined;
    const place = placeOf(file.path, file.owner);
    const id = randomUUID();
    const at = now();
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, path, linked_folder_id,
         folder_id, source_kind, relative_path, file_status, file_mtime_ms, file_device,
         file_number, file_created_ns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        hashed.contentHash,
        nameFromPath(file.path),
        file.kind,
        hashed.size,
        file.path,
        ...placeValues(place),
        file.mtimeMs,
        ...identityValues(identity),
        at,
        at,
      ],
    );
    if (arrival !== null) markArrived(db, id, arrival);
    hooks.announce(id);
    (changes.added ?? hooks.added)(id);
    hooks.process(id);
    if (place.linkedFolderId) changes.folders.add(place.linkedFolderId);
    return id;
  }

  /**
   * A file at a path where files added on their own are watched, with no
   * Document there: one of them, moved or renamed, if one whose file went
   * has its content, or was this file before it was edited. Nothing else
   * there is added.
   */
  async function arrived(
    file: Found,
    removed: FileRow[],
    changes: Changes,
    twins: ReadonlySet<string>,
  ): Promise<void> {
    // Read only if a file added on its own, of this size, can have its content.
    const sameSize = (row: Pick<FileRow, "size" | "linked_folder_id">) =>
      !row.linked_folder_id && row.size === file.size;
    const possible =
      removed.some(sameSize) ||
      db.get(
        `SELECT 1 FROM documents
         WHERE deleted_at IS NULL AND linked_folder_id IS NULL AND size = ? AND path <> ?
           AND file_status IN ('available', 'missing')`,
        [file.size, file.path],
      ) !== undefined;
    let hashed: Awaited<ReturnType<typeof hashFile>> | undefined;
    if (possible) {
      try {
        hashed = await hashFile(file.path);
      } catch {
        return; // gone again, or not readable: not one to follow now
      }
    }
    const identity = await identify(file.path);
    if (closed || documentAt(file.path)) return;
    const moved =
      (hashed && (await movedDocument(hashed.contentHash, file.path, removed, true))) ??
      (await editedDocument(file, identity, removed, twins, true));
    if (!moved || closed) return;
    const seen = {
      size: hashed?.size ?? file.size,
      identity,
      newVersion: moved.content_hash !== hashed?.contentHash,
    };
    if (await relocate(moved, file, seen, changes)) consumeMatchedSource(moved, removed);
  }

  /**
   * A known Document whose file is gone: missing, or unavailable when what it
   * was in can't be reached (for a single file, its folder is gone too).
   */
  async function gone(row: FileRow, owner: LinkedFolderRow | null, changes: Changes) {
    const current = documentById(row.id);
    if (!current || current.path !== row.path) return;
    const status = owner || (await isFolder(dirname(row.path))) ? "missing" : "unavailable";
    if (status === "missing" && current.file_status !== "missing") missingNow.add(row.id);
    setFileStatus(current, status, changes);
  }

  /** A Linked folder's root can't be reached: its Documents stay searchable, but can't be opened. */
  function unreachable(row: LinkedFolderRow, changes: Changes): void {
    stopWatcher(row.id);
    const affected = db.all<{ id: string }>(
      `SELECT id FROM documents
       WHERE linked_folder_id = ? AND deleted_at IS NULL AND file_status = 'available'`,
      [row.id],
    );
    if (affected.length > 0) {
      db.run(
        `UPDATE documents SET file_status = 'unavailable', updated_at = ?
         WHERE linked_folder_id = ? AND deleted_at IS NULL AND file_status = 'available'`,
        [now(), row.id],
      );
      for (const { id } of affected) changes.announced.add(id);
    }
    setStatus(row.id, "unavailable");
  }

  /** Makes a Linked folder's Folders those its Documents are in. Returns whether any changed. */
  function syncFolders(id: string): boolean {
    const row = folderRow(id);
    if (!row) return false;
    const relatives = db
      .all<{ path: string }>(
        "SELECT path FROM documents WHERE linked_folder_id = ? AND deleted_at IS NULL",
        [id],
      )
      .map((each) => parentOf(relativePath(row.path, each.path)));
    return folders.sync(id, row.path, relatives);
  }

  /** The Folders, events and statuses at the end of a pass. */
  function finish(changes: Changes, scanned: Set<string>): void {
    let foldersChanged = false;
    for (const id of changes.folders) if (syncFolders(id)) foldersChanged = true;
    for (const id of scanned) {
      const row = folderRow(id);
      if (!row) continue;
      if (!baselineScanned(id)) {
        const at = now();
        db.run(
          `INSERT INTO linked_folder_baselines (id, linked_folder_id, scanned_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [randomUUID(), id, at, at, at],
        );
      }
      if (row.layout === null) {
        const relatives = db
          .all<{ path: string }>(
            "SELECT path FROM documents WHERE linked_folder_id = ? AND deleted_at IS NULL",
            [id],
          )
          .map((each) => relativePath(row.path, each.path));
        db.run("UPDATE linked_folders SET layout = ?, updated_at = ? WHERE id = ?", [
          suggestLayout(relatives),
          now(),
          id,
        ]);
      }
      downloading.delete(id);
      if (!row.paused) {
        statuses.set(id, "watching");
        startWatcher(id);
      }
    }
    watchSingles();
    if (foldersChanged) hooks.foldersChanged();
    for (const id of changes.announced) hooks.announce(id);
    if (changes.moved.size > 0) hooks.moved([...changes.moved]);
    announceFolders();
  }

  async function runPass(request: PassRequest): Promise<void> {
    if (closed) return;
    missingBefore = missingNow;
    missingNow = new Set();
    const changes: Changes = { announced: new Set(), moved: new Set(), folders: new Set() };
    const linked = liveFolders();
    /** Documents looked at, by path, and files found there, by path. */
    const known = new Map<string, FileRow>();
    const found = new Map<string, Found>();
    /** Linked folders scanned whole and reachable. */
    const scanned = new Set<string>();

    for (const row of linked) {
      if (row.paused) continue;
      const whole = request.all || request.folders.has(row.id);
      const parts = whole
        ? [row.path]
        : topmost(
            [...request.paths].filter(
              (path) => isInside(row.path, path) && ownerOf(path, linked)?.id === row.id,
            ),
          );
      if (parts.length === 0) continue;
      if (!(await isFolder(row.path))) {
        unreachable(row, changes);
        continue;
      }
      if (whole) {
        statuses.set(row.id, "scanning");
        announceFolders();
      } else if (statuses.get(row.id) === "unavailable") {
        // Back after being out of reach: look at all of it.
        request.folders.add(row.id);
        parts.splice(0, parts.length, row.path);
        statuses.set(row.id, "scanning");
      }
      startWatcher(row.id); // before reading, so nothing that changes meanwhile is missed
      changes.folders.add(row.id);
      if (parts[0] === row.path) scanned.add(row.id);
      const ignore = ignoreOf(row);
      const placeholders = onlineOnly.get(row.id) ?? new Map<string, number>();
      onlineOnly.set(row.id, placeholders);
      const notRead = unsupported.get(row.id) ?? new Set<string>();
      unsupported.set(row.id, notRead);
      for (const part of parts) {
        for (const document of documentsUnder(part)) known.set(document.path, document);
        let files: FoundFile[] = [];
        let unread: string[] = [];
        try {
          ({ files, unsupported: unread } = await walk(part, {
            root: row.path,
            ignore,
            detectDataless: options.detectDataless,
          }));
        } catch {
          // Gone: whatever was indexed there is gone too.
        }
        for (const path of placeholders.keys()) if (isInside(part, path)) placeholders.delete(path);
        for (const path of notRead) if (isInside(part, path)) notRead.delete(path);
        for (const path of unread) notRead.add(path);
        for (const file of files) {
          if (!file.onlineOnly || known.has(file.path)) {
            // A known Document's placeholder isn't read either (see `checkKnown`).
            found.set(file.path, { ...file, owner: row });
          } else if (!downloading.has(row.id)) {
            placeholders.set(file.path, file.size);
          } else if (await statFile(file.path).catch(() => undefined)) {
            // Asked to download: reading a dataless file downloads it. (An
            // iCloud stub's file is only there once iCloud has downloaded it.)
            found.set(file.path, { ...file, onlineOnly: false, owner: row });
          } else {
            placeholders.set(file.path, file.size);
          }
        }
      }
    }

    // Files added on their own: each looked at by itself.
    const singles = request.all
      ? db.all<FileRow>(
          `SELECT ${FILE_COLUMNS} FROM documents WHERE deleted_at IS NULL AND linked_folder_id IS NULL`,
        )
      : [...request.paths].flatMap((path) =>
          documentsUnder(path).filter((row) => row.linked_folder_id === null),
        );
    // Paths reported in a folder of files added on their own, with no Document there.
    const arrivals: Found[] = [];
    for (const path of request.all ? [] : request.paths) {
      const kind = kindOf(path);
      if (!kind || ownerOf(path, linked) || documentAt(path)) continue;
      const info = await statFile(path).catch(() => undefined);
      if (!info || (options.detectDataless && isDataless(info))) continue;
      arrivals.push({
        path,
        kind,
        size: info.size,
        mtimeMs: info.mtimeMs,
        onlineOnly: false,
        owner: null,
      });
    }
    for (const row of singles) {
      if (known.has(row.path) || ownerOf(row.path, linked)) continue;
      known.set(row.path, row);
      let info: Awaited<ReturnType<typeof statFile>>;
      try {
        info = await statFile(row.path);
      } catch {
        known.delete(row.path);
        setFileStatus(row, "unavailable", changes);
        continue;
      }
      if (info) {
        found.set(row.path, {
          path: row.path,
          kind: row.kind as DocumentKind,
          size: info.size,
          mtimeMs: info.mtimeMs,
          onlineOnly: options.detectDataless && isDataless(info),
          owner: null,
        });
      }
    }

    // Known files first: what is gone is known before new files are matched against it.
    const removed: FileRow[] = [];
    for (const row of known.values()) {
      const file = found.get(row.path);
      found.delete(row.path);
      if (closed) return;
      if (!file || !(await checkKnown(row, file, changes))) removed.push(row);
    }

    // New files, newest first. Files modified at the same moment (a file system
    // that keeps times coarsely, or files copied in together) go in the order of
    // their paths, not in the order the file system happens to list them.
    const fresh = [...found.values()].sort(
      (a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    for (const file of fresh) {
      if (file.owner) pendingNew.set(file.owner.id, (pendingNew.get(file.owner.id) ?? 0) + 1);
    }
    const twins = repeatedNames([...fresh, ...arrivals].map((file) => file.path));
    /**
     * When IncarnaMind saw a file arrive new (#2308): a Linked folder's first scan finds what the
     * User linked, as they linked it; after that, its watcher reports a file the moment it arrives.
     * A later scan, on a resume or a restart, finds files that were there before: null.
     */
    const arrivalOf = (owner: LinkedFolderRow | null): string | null => {
      if (!owner) return null;
      if (!baselineScanned(owner.id)) return owner.created_at;
      return scanned.has(owner.id) ? null : now();
    };
    announceFolders();
    try {
      for (const file of fresh) {
        if (closed) return;
        await addFound(file, removed, changes, false, twins, arrivalOf(file.owner));
        if (file.owner) {
          pendingNew.set(file.owner.id, (pendingNew.get(file.owner.id) ?? 1) - 1);
          announceProgress();
        }
      }
    } finally {
      for (const file of fresh) if (file.owner) pendingNew.delete(file.owner.id);
    }
    // A file added on its own, moved or renamed, perhaps.
    for (const file of arrivals) {
      if (closed) return;
      await arrived(file, removed, changes, twins);
    }

    // What is still unmatched has gone.
    for (const row of removed) {
      const owner = row.linked_folder_id ? (ownerOf(row.path, linked) ?? null) : null;
      await gone(row, owner, changes);
    }
    finish(changes, scanned);
  }

  /** The paths not inside another of them. */
  function topmost(paths: string[]): string[] {
    const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
    const kept: string[] = [];
    for (const path of sorted) if (!kept.some((each) => isInside(each, path))) kept.push(path);
    return kept;
  }

  // --- Trying again -----------------------------------------------------------

  const retry = () => {
    if (closed) return;
    const linked = liveFolders();
    const folderIds = linked
      .filter((row) => !row.paused && statuses.get(row.id) === "unavailable")
      .map((row) => row.id);
    const unreachableIds = new Set(folderIds);
    // Folders of files added on their own whose watcher failed: watched again once looked at.
    const unwatched = [...singleWatchesFailed].flatMap(singlesIn);
    singleWatchesFailed.clear();
    const paths = [
      ...unreadable,
      ...unwatched,
      ...db
        .all<{ path: string; linked_folder_id: string | null }>(
          `SELECT path, linked_folder_id FROM documents
           WHERE deleted_at IS NULL AND file_status = 'unavailable'`,
        )
        .filter((row) => row.linked_folder_id === null || !unreachableIds.has(row.linked_folder_id))
        .map((row) => row.path),
    ];
    if (folderIds.length > 0 || paths.length > 0) request({ folders: folderIds, paths });
    // A watched folder can vanish without an event (a drive unplugged): look for it.
    for (const row of linked) {
      if (row.paused || statuses.get(row.id) !== "watching") continue;
      void isFolder(row.path).then((there) => {
        if (!there) request({ folders: [row.id] });
      });
    }
  };
  const retryTimer = setInterval(retry, options.retryMs);
  retryTimer.unref?.();

  // --- The interface ----------------------------------------------------------

  async function resolveFolder(input: unknown): Promise<string> {
    if (typeof input !== "string" || !isAbsolute(input)) {
      throw new InvalidInputError("A Linked folder must be given as an absolute folder path.");
    }
    let real: string;
    try {
      real = await realpath(input);
    } catch {
      throw new NotFoundError({ key: "error.path.noFolder" });
    }
    if (!(await isFolder(real))) throw new InvalidInputError({ key: "error.path.notFolder" });
    return real;
  }

  const getRow = (idInput: unknown): LinkedFolderRow => {
    const row = folderRow(parseLinkedFolderId(idInput));
    if (!row) throw new NotFoundError({ key: "error.linkedFolder.notFound" });
    return row;
  };

  /** The files in a format not read (#740), in the Linked folders still there, with where each is. */
  const unsupportedFiles = (): UnsupportedFile[] =>
    liveFolders().flatMap((row) =>
      [...(unsupported.get(row.id) ?? [])].sort().map((path) => ({
        path,
        name: basename(path),
        extension: extname(path).toLowerCase(),
        linkedFolderId: row.id,
        relativeFolder: parentOf(relativePath(row.path, path)),
      })),
    );

  return {
    list,
    unsupportedFiles,

    /** Starts watching every Linked folder, and reconciles everything with the disk. */
    start(): void {
      for (const row of liveFolders()) statuses.set(row.id, "scanning");
      request({ all: true });
    },

    /** Resolves when no pass is queued or under way. */
    idle,

    /** Reconciles everything with the disk now. Resolves when done. */
    async sync(): Promise<void> {
      request({ all: true });
      await idle();
    },

    /**
     * Reconciles these paths (e.g. a file about to be opened) now, and
     * resolves when done. While a pass is under way, which may take long, they
     * are queued for the next one instead, and it resolves at once, unless
     * `wait`: then it resolves after the pass that reads them, for a caller
     * that reads what it just wrote (a Meeting's finished Transcript, #763).
     */
    async check(paths: readonly string[], wait = false): Promise<void> {
      if (passRunning) {
        request({ paths });
        if (wait) await idle();
        return;
      }
      begin();
      try {
        await exclusive(() =>
          runTracked({ all: false, folders: new Set(), paths: new Set(paths) }),
        );
      } finally {
        end();
      }
    },

    async preview(input: unknown): Promise<LinkedFolderPreview> {
      const path = await resolveFolder(input);
      const linked = liveFolders();
      const outer = ownerOf(path, linked);
      const { files } = await walk(path, {
        root: path,
        ignore: createIgnore(),
        detectDataless: options.detectDataless,
      });
      const local = files.filter((file) => !file.onlineOnly);
      const placeholders = files.filter((file) => file.onlineOnly);
      const seconds = options.readingSeconds(local);
      return {
        path,
        files: local.length,
        bytes: local.reduce((sum, file) => sum + file.size, 0),
        onlineOnly: {
          files: placeholders.length,
          bytes: placeholders.reduce((sum, file) => sum + file.size, 0),
        },
        estimatedSeconds: seconds === null ? null : Math.ceil(seconds),
        layout: suggestLayout(local.map((file) => relativePath(path, file.path))),
        insideLinkedFolderId: outer?.id ?? null,
        containsLinkedFolderIds: linked
          .filter((row) => row.path !== path && isInside(path, row.path))
          .map((row) => row.id),
      };
    },

    /**
     * Links a folder (see `CoreApi.addLinkedFolder`). Nested Linked folders
     * are merged into the outer one: a folder inside one adds nothing, and
     * one around others takes their place. The Documents already inside it,
     * theirs and files added on their own, are its at once, keeping their ids.
     */
    async add(input: unknown): Promise<LinkedFolder> {
      const path = await resolveFolder(input);
      const linked = liveFolders();
      const outer = ownerOf(path, linked);
      if (outer) return toLinkedFolder(outer);
      const at = now();
      const id = randomUUID();
      const taken: string[] = [];
      db.transaction(() => {
        db.run(
          `INSERT INTO linked_folders (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          [id, path, at, at],
        );
        for (const inner of linked.filter((row) => isInside(path, row.path))) {
          stopWatcher(inner.id);
          statuses.delete(inner.id);
          onlineOnly.delete(inner.id);
          unsupported.delete(inner.id);
          db.run("UPDATE linked_folders SET deleted_at = ?, updated_at = ? WHERE id = ?", [
            at,
            at,
            inner.id,
          ]);
          folders.removeAll(inner.id, at);
        }
        const owner = folderRow(id);
        if (!owner) return;
        // Taken now rather than at its first scan, so unlinking it straight away takes them too.
        for (const document of documentsUnder(path)) {
          db.run(`UPDATE documents SET ${PLACE_COLUMNS}, updated_at = ? WHERE id = ?`, [
            ...placeValues(placeOf(document.path, owner)),
            at,
            document.id,
          ]);
          taken.push(document.id);
        }
      });
      const foldersChanged = taken.length > 0 && syncFolders(id);
      if (taken.length > 0) hooks.moved(taken);
      if (foldersChanged) hooks.foldersChanged();
      statuses.set(id, "scanning");
      request({ folders: [id] });
      announceFolders();
      const row = folderRow(id);
      if (!row) throw new Error("The Linked folder wasn't saved.");
      return toLinkedFolder(row);
    },

    /**
     * Unlinks a folder: its Documents and Folders leave the index, but for
     * the text their Citations quote, and for the Documents in `keep`, which
     * stay as files added on their own. Nothing on disk changes.
     */
    remove(idInput: unknown, keepInput: unknown = []): void {
      const row = getRow(idInput);
      if (!Array.isArray(keepInput) || !keepInput.every((id) => typeof id === "string")) {
        throw new InvalidInputError({ key: "error.linkedFolder.keep" });
      }
      const keep = new Set<string>(keepInput);
      stopWatcher(row.id);
      const at = now();
      const live = db.all<{ id: string; path: string }>(
        "SELECT id, path FROM documents WHERE linked_folder_id = ? AND deleted_at IS NULL",
        [row.id],
      );
      const ids = live.filter((each) => !keep.has(each.id)).map((each) => each.id);
      const kept = live.filter((each) => keep.has(each.id));
      let foldersChanged = false;
      db.transaction(() => {
        hooks.remove(ids, at);
        db.run("UPDATE linked_folders SET deleted_at = ?, updated_at = ? WHERE id = ?", [
          at,
          at,
          row.id,
        ]);
        for (const document of kept) {
          db.run(`UPDATE documents SET ${PLACE_COLUMNS}, updated_at = ? WHERE id = ?`, [
            ...placeValues(placeOf(document.path, null)),
            at,
            document.id,
          ]);
        }
        foldersChanged = folders.removeAll(row.id, at);
      });
      if (kept.length > 0) hooks.moved(kept.map((each) => each.id));
      statuses.delete(row.id);
      onlineOnly.delete(row.id);
      unsupported.delete(row.id);
      downloading.delete(row.id);
      for (const path of unreadable) if (isInside(row.path, path)) unreadable.delete(path);
      watchSingles(); // a file added on its own inside it is watched by itself now
      if (foldersChanged) hooks.foldersChanged();
      announceFolders();
    },

    /**
     * Brings back a Linked folder the User unlinked, as Undo after Remove the examples
     * does (#1292), and reads its files again: the Documents that left the index with
     * it, which the caller restores, and the folder. Refused when there is no such folder.
     */
    restore(idInput: unknown): { folder: LinkedFolder; went: string[] } {
      const row = db.get<LinkedFolderRow & { deleted_at: string | null }>(
        `SELECT ${FOLDER_COLUMNS}, deleted_at FROM linked_folders WHERE id = ?`,
        [parseLinkedFolderId(idInput)],
      );
      if (!row) throw new NotFoundError({ key: "error.linkedFolder.notFound" });
      if (row.deleted_at === null) return { folder: toLinkedFolder(row), went: [] };
      // The Documents that went with it, by the unlink's own moment: one deleted earlier stays deleted.
      const went = db
        .all<{ id: string }>(
          "SELECT id FROM documents WHERE linked_folder_id = ? AND deleted_at = ?",
          [row.id, row.deleted_at],
        )
        .map((each) => each.id);
      db.run("UPDATE linked_folders SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
        now(),
        row.id,
      ]);
      statuses.set(row.id, "scanning");
      request({ folders: [row.id] });
      announceFolders();
      const live = folderRow(row.id);
      if (!live) throw new Error("The Linked folder wasn't saved.");
      return { folder: toLinkedFolder(live), went };
    },

    /**
     * Points a Linked folder at where it is on this computer now (see
     * `CoreApi.locateLinkedFolder`): each of its Documents is looked for at
     * its path inside it, keeping its id, versions and Citations, and the
     * next pass reads only what changed. Refused, and nothing changes, for a
     * folder that overlaps another Linked folder, holds none of its files,
     * or holds one of them already added on its own.
     */
    async locate(idInput: unknown, input: unknown): Promise<LinkedFolder> {
      const row = getRow(idInput);
      const path = await resolveFolder(input);
      const name = basename(row.path) || row.path;
      if (path !== row.path) {
        const others = liveFolders().filter((each) => each.id !== row.id);
        if (others.some((each) => isInside(each.path, path) || isInside(path, each.path))) {
          throw new InvalidInputError({ key: "error.linkedFolder.overlaps", values: { name } });
        }
        const placed = db.all<{
          id: string;
          relative_path: string;
          live: number;
          file_status: string;
        }>(
          `SELECT id, relative_path, deleted_at IS NULL AS live, file_status FROM documents
           WHERE linked_folder_id = ? AND relative_path IS NOT NULL`,
          [row.id],
        );
        const live = placed.filter((each) => each.live === 1);
        if (live.length > 0 && !(await holdsAny(path, live))) {
          throw new InvalidInputError({ key: "error.linkedFolder.notThis", values: { name } });
        }
        const taken = live
          .map((each) => documentAt(pathIn(path, each.relative_path)))
          .find((other) => other !== undefined && other.linked_folder_id !== row.id);
        if (taken) {
          throw new InvalidInputError({
            key: "error.linkedFolder.taken",
            values: { file: basename(taken.path) },
          });
        }
        db.transaction(() => {
          db.run("UPDATE linked_folders SET path = ? WHERE id = ?", [path, row.id]);
          // Each path is unique: set aside first, as one Document's new path may be another's old one.
          db.run(
            `UPDATE documents SET path = 'locating:' || id, ${FORGET_FILE_IDENTITY}
             WHERE linked_folder_id = ? AND relative_path IS NOT NULL`,
            [row.id],
          );
          for (const each of placed) {
            db.run("UPDATE documents SET path = ? WHERE id = ?", [
              pathIn(path, each.relative_path),
              each.id,
            ]);
          }
        });
        stopWatcher(row.id);
        onlineOnly.delete(row.id);
        unsupported.delete(row.id);
        for (const file of unreadable) if (isInside(row.path, file)) unreadable.delete(file);
      }
      statuses.set(row.id, "scanning");
      request({ folders: [row.id] });
      announceFolders();
      return toLinkedFolder(getRow(row.id));
    },

    setLayout(idInput: unknown, layout: unknown): LinkedFolder {
      const row = getRow(idInput);
      if (layout !== "tree" && layout !== "flat") {
        throw new InvalidInputError('A Linked folder\'s layout is "tree" or "flat".');
      }
      db.run("UPDATE linked_folders SET layout = ?, updated_at = ? WHERE id = ?", [
        layout,
        now(),
        row.id,
      ]);
      announceFolders();
      return toLinkedFolder(getRow(row.id));
    },

    setPaused(idInput: unknown, paused: unknown): LinkedFolder {
      const row = getRow(idInput);
      if (typeof paused !== "boolean") throw new InvalidInputError("paused must be true or false.");
      if (Boolean(row.paused) !== paused) {
        db.run("UPDATE linked_folders SET paused = ?, updated_at = ? WHERE id = ?", [
          paused ? 1 : 0,
          now(),
          row.id,
        ]);
        if (paused) stopWatcher(row.id);
        hooks.paused(row.id, paused);
        if (!paused) {
          statuses.set(row.id, "scanning");
          // Nothing was read while it was paused: look at all of it.
          request({ folders: [row.id] });
        }
        announceFolders();
      }
      return toLinkedFolder(getRow(row.id));
    },

    /** Downloads and indexes the folder's online-only files: reading one downloads it. */
    downloadOnlineOnly(idInput: unknown): LinkedFolder {
      const row = getRow(idInput);
      downloading.add(row.id);
      for (const path of onlineOnly.get(row.id)?.keys() ?? []) {
        const stub = join(dirname(path), `.${basename(path)}.icloud`);
        if (hooks.downloadStub) {
          void statFile(stub)
            .then((info) => (info ? hooks.downloadStub?.(path) : undefined))
            .catch((error: unknown) => hooks.reportError(error));
        }
      }
      request({ folders: [row.id] });
      announceFolders();
      return toLinkedFolder(row);
    },

    /** Whether a Linked folder is paused: its Documents' work waits. */
    isPaused(linkedFolderId: string | null): boolean {
      if (!linkedFolderId) return false;
      return Boolean(folderRow(linkedFolderId)?.paused);
    },

    /** A Document's status changed: its Linked folder's progress may have. */
    progressed(linkedFolderId: string | null): void {
      if (linkedFolderId) announceProgress();
    },

    /** The User removed a Document from the index, or restored one: its Folder may hold nothing now, or something again. */
    documentsChanged(linkedFolderId: string | null): void {
      if (!linkedFolderId) {
        watchSingles(); // its folder may hold no file added on its own now, or one again
        return;
      }
      if (syncFolders(linkedFolderId)) hooks.foldersChanged();
      announceFolders();
    },

    /**
     * Adds files on their own (see `CoreApi.addDocuments`), in order: the
     * Document of each, or why it was skipped. Not held up by a pass under
     * way: every write checks what is there just before it.
     */
    addFiles(
      paths: readonly string[],
      added?: (documentId: string) => void,
    ): Promise<(string | SkippedFile["reason"])[]> {
      begin();
      return (async () => {
        const changes: Changes = {
          announced: new Set(),
          moved: new Set(),
          folders: new Set(),
          added,
        };
        const results: (string | SkippedFile["reason"])[] = [];
        const linked = liveFolders();
        const twins = repeatedNames(paths);
        for (const path of paths) {
          const kind = kindOf(path);
          if (!kind) {
            results.push("unsupported-type");
            continue;
          }
          let real: string;
          let info: Awaited<ReturnType<typeof statFile>>;
          try {
            real = await realpath(path);
            info = await statFile(real);
          } catch {
            info = undefined;
            real = path;
          }
          if (!info) {
            results.push("unreadable");
            continue;
          }
          const inFolder = ownerOf(real, linked);
          const owner =
            inFolder && !ignoreOf(inFolder)(relativePath(inFolder.path, real)) ? inFolder : null;
          const file: Found = {
            path: real,
            kind,
            size: info.size,
            mtimeMs: info.mtimeMs,
            onlineOnly: false,
            owner,
          };
          const existing = documentAt(real);
          if (existing) {
            if (!(await checkKnown(existing, file, changes))) {
              await gone(existing, owner, changes);
              results.push("unreadable");
            } else {
              results.push(existing.id);
            }
            continue;
          }
          results.push((await addFound(file, [], changes, true, twins, now())) ?? "unreadable");
        }
        finish(changes, new Set());
        return results;
      })().finally(end);
    },

    /**
     * Makes a file the new version of a Document added on its own (#720: a newer draft of
     * a Word file imported before), keeping its id, Tags, Folder and Citations; the old
     * version's text stays while a Citation quotes it. False when it can't be: the
     * Document is gone or in a Linked folder, or the file is another Document, in a
     * Linked folder, of another kind, or unreadable.
     */
    newVersionFrom(documentId: string, path: string): Promise<boolean> {
      begin();
      return (async () => {
        const row = documentById(documentId);
        const kind = kindOf(path);
        if (row?.source_kind !== "file" || kind !== row.kind) return false;
        let real: string;
        let info: Awaited<ReturnType<typeof statFile>>;
        try {
          real = await realpath(path);
          info = await statFile(real);
        } catch {
          return false;
        }
        if (!info || documentAt(real) || ownerOf(real)) return false;
        let hashed: Awaited<ReturnType<typeof hashFile>>;
        try {
          hashed = await hashFile(real);
        } catch {
          return false;
        }
        const changes: Changes = { announced: new Set(), moved: new Set(), folders: new Set() };
        const file: Found = {
          path: real,
          kind,
          size: info.size,
          mtimeMs: info.mtimeMs,
          onlineOnly: false,
          owner: null,
        };
        const seen = {
          size: hashed.size,
          identity: await identify(real),
          newVersion: hashed.contentHash !== row.content_hash,
        };
        const moved = await relocate(row, file, seen, changes);
        finish(changes, new Set());
        return moved;
      })().finally(end);
    },

    close(): void {
      closed = true;
      clearInterval(retryTimer);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
        end();
      }
      if (progressTimer) clearTimeout(progressTimer);
      for (const id of [...watchers.keys()]) stopWatcher(id);
      for (const watcher of singleWatchers.values()) watcher.close();
      singleWatchers.clear();
    },
  };
}
