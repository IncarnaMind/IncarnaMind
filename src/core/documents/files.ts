/**
 * The User's files, read where they are (ADR-0010). IncarnaMind only ever
 * reads them: nothing here writes, renames or deletes anything outside the
 * data folder.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { type BigIntStats, createReadStream, type Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import type { DocumentKind } from "../api";

/**
 * The file extensions of each kind of Document, lower case, without the dot.
 * A new kind is added here, with its extractor (./extract).
 */
export const DOCUMENT_EXTENSIONS: Readonly<Record<DocumentKind, readonly string[]>> = {
  pdf: ["pdf"],
  text: ["txt"],
  markdown: ["md", "markdown"],
  docx: ["docx"],
  pptx: ["pptx"],
  xlsx: ["xlsx"],
  csv: ["csv"],
  // Saved by their address, never added as files: a .html file isn't a web page Document.
  web: [],
  transcript: ["vtt"],
};

/**
 * Document formats IncarnaMind doesn't read yet, by extension: a file with one
 * is left out of a search, and says so (#740). Other kinds of file (pictures,
 * programs, mail) aren't Documents, and aren't named.
 */
export const UNREAD_FORMATS: ReadonlySet<string> = new Set([
  ".doc",
  ".dot",
  ".docm",
  ".xls",
  ".xlt",
  ".xlsm",
  ".xlsb",
  ".ppt",
  ".pot",
  ".pps",
  ".pptm",
  ".wps",
  ".et",
  ".dps",
  ".caj",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".numbers",
  ".key",
  ".wpd",
]);

const KINDS: ReadonlyMap<string, DocumentKind> = new Map(
  Object.entries(DOCUMENT_EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [`.${extension}`, kind as DocumentKind] as const),
  ),
);

/** The kind of Document a file would be, from its extension; undefined if it isn't supported. */
export const kindOf = (path: string): DocumentKind | undefined =>
  KINDS.get(extname(path).toLowerCase());

/** The file name without its extension, or the whole name if that leaves nothing. */
export const nameFromPath = (path: string) =>
  basename(path, extname(path)).trim() || basename(path);

/** Whether `path` is `folder` itself or somewhere inside it. Both absolute. */
export function isInside(folder: string, path: string): boolean {
  if (path === folder) return true;
  return path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** `path` relative to `folder`, with "/" between names whatever the OS: "" for the folder itself. */
export const relativePath = (folder: string, path: string): string =>
  relative(folder, path).split(sep).join("/");

/** The file at `relative` ("/" between names) inside `folder`, on this computer. */
export const pathIn = (folder: string, relative: string) => join(folder, ...relative.split("/"));

// The old layout, before ADR-0010, copied each Document's file into the data folder's "documents",
// named by its content hash: a file of the User's in there, such as a Linked folder's, is not one.
export const isLegacyCopy = (dataDir: string, path: string): boolean =>
  dirname(path) === join(dataDir, "documents") &&
  /^[0-9a-f]{64}(\.[a-z0-9]+)?$/.test(basename(path));

/** The relative path of the folder a relative file path is in: "" at the top. */
export const parentOf = (relative: string): string => {
  const at = relative.lastIndexOf("/");
  return at === -1 ? "" : relative.slice(0, at);
};

/** The error means there is nothing at the path (or a file where a folder should be). */
export const isGone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Cloud placeholders: files a sync service lists without having downloaded
 * them. Reading one makes the service download it, so IncarnaMind never
 * reads them unless the User asks.
 *
 * - iCloud Drive before macOS 14 leaves a hidden stub, ".Paper.pdf.icloud",
 *   in place of "Paper.pdf".
 * - Since then, iCloud Drive, Dropbox, Google Drive and OneDrive on macOS
 *   leave "dataless" files: the file's size is set, but no block of it is
 *   stored on disk (`stat` reports zero blocks). Only checked on macOS, where
 *   APFS reports blocks reliably; Windows reports none for every file, and
 *   Linux file systems mounted from the network often do too.
 */
export function iCloudStubTarget(name: string): string | null {
  const match = /^\.(.+)\.icloud$/.exec(name);
  return match?.[1] ?? null;
}

export const isDataless = (stats: Pick<Stats, "size" | "blocks">): boolean =>
  stats.size > 0 && stats.blocks === 0;

/** Names never indexed in a Linked folder, wherever they are. Hidden names (".git") are left out too. */
const ALWAYS_IGNORED = new Set(["node_modules"]);

/** A glob over names: "*" matches within a name, "**" across "/", "?" one character. */
function globPattern(pattern: string): RegExp {
  let source = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at] as string;
    if (char === "*" && pattern[at + 1] === "*") {
      source += ".*";
      at++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * Whether a file or folder in a Linked folder is left out, given its path
 * relative to the Linked folder. Hidden files and folders (".git",
 * ".DS_Store"), Office's lock files ("~$Report.docx"), node_modules, and
 * anything matching one of the Linked folder's extra patterns: a pattern with
 * a "/" is matched against the whole relative path, one without against each
 * name in it.
 */
export function createIgnore(patterns: readonly string[] = []): (relative: string) => boolean {
  const whole = patterns.filter((pattern) => pattern.includes("/")).map(globPattern);
  const names = patterns.filter((pattern) => !pattern.includes("/")).map(globPattern);
  return (relative) => {
    if (relative === "") return false;
    for (const name of relative.split("/")) {
      // "~$Report.docx": the lock file Office keeps beside a file it has open.
      if (name.startsWith(".") || name.startsWith("~$") || ALWAYS_IGNORED.has(name)) return true;
      if (names.some((pattern) => pattern.test(name))) return true;
    }
    return whole.some((pattern) => pattern.test(relative));
  };
}

/** A supported file found in a folder, from its metadata only: nothing of it is read. */
export interface FoundFile {
  /** Absolute. For an iCloud stub, the path of the file it stands for. */
  path: string;
  kind: DocumentKind;
  size: number;
  mtimeMs: number;
  /** A cloud placeholder, not downloaded: never read unless the User asks. */
  onlineOnly: boolean;
}

export interface WalkOptions {
  /** The Linked folder `start` is in: ignore rules apply to paths relative to it. */
  root: string;
  ignore: (relative: string) => boolean;
  /** Check for dataless placeholders (macOS). */
  detectDataless: boolean;
}

/** What `walk` found: supported files, files of formats not read, and the folders it went through. */
export interface WalkResult {
  files: FoundFile[];
  /** Files in a format IncarnaMind doesn't read (`UNREAD_FORMATS`): their absolute paths. */
  unsupported: string[];
  /** Absolute paths of the folders walked, `start` included if it is one. */
  folders: string[];
}

/**
 * Lists the supported files at `start` and, if it is a folder, below it, at
 * any depth, from their metadata. Ignored names and symbolic links (which
 * could loop) are skipped; a folder that can't be listed is skipped too.
 * Rejects only if `start` itself can't be read, e.g. it is gone.
 */
export async function walk(start: string, options: WalkOptions): Promise<WalkResult> {
  const result: WalkResult = { files: [], unsupported: [], folders: [] };
  const consider = async (path: string, stats?: Stats): Promise<void> => {
    const name = basename(path);
    const stubTarget = iCloudStubTarget(name);
    if (stubTarget) {
      const target = join(dirname(path), stubTarget);
      const kind = kindOf(target);
      if (!kind || options.ignore(relativePath(options.root, target))) return;
      const info = stats ?? (await lstat(path));
      if (!info.isFile()) return;
      result.files.push({ path: target, kind, size: 0, mtimeMs: info.mtimeMs, onlineOnly: true });
      return;
    }
    if (options.ignore(relativePath(options.root, path))) return;
    const info = stats ?? (await lstat(path));
    if (info.isDirectory()) {
      result.folders.push(path);
      let entries: string[];
      try {
        entries = await readdir(path);
      } catch (error) {
        if (path === start) throw error;
        return; // a folder that can't be listed is left out
      }
      for (const entry of entries) {
        try {
          await consider(join(path, entry));
        } catch {
          // gone meanwhile, or can't be read: left out
        }
      }
      return;
    }
    if (!info.isFile()) return;
    const kind = kindOf(path);
    if (!kind) {
      if (UNREAD_FORMATS.has(extname(path).toLowerCase())) result.unsupported.push(path);
      return;
    }
    result.files.push({
      path,
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      onlineOnly: options.detectDataless && isDataless(info),
    });
  };
  await consider(start, await lstat(start));
  return result;
}

/** A file's size and modified time, or undefined if there is no file at the path. */
export async function statFile(path: string): Promise<Stats | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info : undefined;
  } catch (error) {
    if (isGone(error)) return undefined;
    throw error;
  }
}

/** Reads what a file's identity on its disk is made of: Node's `stat`, with exact numbers. */
export type StatIdentity = (
  path: string,
) => Promise<Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">>;

export const statIdentity: StatIdentity = (path) => stat(path, { bigint: true });

/**
 * Which file this is on this computer's disks (#389): its device, and its file
 * number with its creation time, which stay the same while it is moved or
 * edited in place on that disk. A file number can be given to a new file once
 * its own is deleted; the creation time tells them apart. Decimal text, since
 * file numbers can be too big for a JavaScript number (Windows' are 64-bit).
 * `number` and `createdNs` are null where the file system gives none.
 */
export interface FileIdentity {
  device: string;
  number: string | null;
  createdNs: string | null;
}

export const fileIdentity = (
  stats: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">,
): FileIdentity => ({
  device: String(stats.dev),
  number: stats.ino > 0n ? String(stats.ino) : null,
  createdNs: stats.birthtimeNs > 0n ? String(stats.birthtimeNs) : null,
});

/** Whether there is a folder at the path. Any failure counts as no. */
export async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface HashedFile {
  /** SHA-256 of the bytes read, hex. */
  contentHash: string;
  size: number;
}

/** Reads a file through once, hashing it. Rejects if it can't be read (e.g. ENOENT). */
export async function hashFile(path: string): Promise<HashedFile> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { contentHash: hash.digest("hex"), size };
}

export const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Opens a file for reading, as a Web stream of its bytes, with its size now.
 * Rejects (e.g. with ENOENT) if it can't be opened, before any byte is read.
 */
export async function openFile(
  path: string,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  const stream = createReadStream(path);
  try {
    await once(stream, "open");
  } catch (error) {
    stream.destroy();
    throw error;
  }
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return { stream: Readable.toWeb(stream) as ReadableStream<Uint8Array>, size };
}

/** The pictures a Markdown file may show from beside it, by extension, with their media types. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** The largest picture shown beside a Markdown file, in bytes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Opens a picture a Markdown file shows (`![…](figures/map.png)`): `path`, as
 * written in the file, from the file's own folder or below it, links
 * followed and still inside it. Only images; nothing above the folder.
 * Rejects if it isn't one.
 */
export async function openImageBeside(
  documentPath: string,
  path: string,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number; type: string }> {
  const parts = path.split(/[\\/]/);
  if (path === "" || isAbsolute(path) || parts.includes("..")) {
    throw new Error("Only a picture in the file's folder, or below it, is shown.");
  }
  const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()];
  if (!type) throw new Error("Not a picture.");
  const folder = await realpath(dirname(documentPath));
  const target = await realpath(join(folder, ...parts));
  if (target === folder || !isInside(folder, target)) {
    throw new Error("Only a picture in the file's folder, or below it, is shown.");
  }
  const info = await stat(target);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("Not a picture to show.");
  return { ...(await openFile(target)), type };
}
