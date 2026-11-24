/**
 * Writes a Document's file whole or not at all: a partial file beside it, a
 * rename over it, so a quit halfway never leaves a Document reading half its
 * words (the path Fetch again writes its new version by).
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { hashBytes } from "./files";

export interface WrittenFile {
  path: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

/**
 * `at`: the time the version is dated, ISO 8601, set before the rename so no reader sees another.
 * `durable`: on the disk before it is named, and its name too, for a copy that must survive a
 * power cut that follows (a deck kept before the User's own file is written over, #149).
 */
export async function writeWholeFile(
  path: string,
  bytes: Uint8Array,
  at?: string,
  options: { durable?: boolean } = {},
): Promise<WrittenFile> {
  const made = await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.part`;
  try {
    const file = await open(partial, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      if (options.durable) await file.sync();
    } finally {
      await file.close();
    }
    const taken = at === undefined ? null : new Date(at);
    if (taken !== null && !Number.isNaN(taken.getTime())) await utimes(partial, taken, taken);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  // Its name, and the name of every folder this call made, flushed too: a copy that must survive a
  // power cut isn't counted as kept until they are.
  if (options.durable) {
    const folders = [dirname(path)];
    for (let folder = dirname(path); made && folder !== dirname(made); folder = dirname(folder)) {
      folders.push(dirname(folder));
    }
    for (const folder of folders) {
      await syncFolder(folder).catch((error: unknown) => {
        // A file system that keeps no folder flush (some network and FUSE mounts) has nothing to
        // flush: as on Windows, that counts as flushed. Any other failure fails the copy.
        if (!FLUSH_UNSUPPORTED.has((error as NodeJS.ErrnoException | null)?.code ?? ""))
          throw error;
      });
    }
  }
  const { mtimeMs } = await stat(path);
  return { path, contentHash: hashBytes(bytes), size: bytes.byteLength, mtimeMs };
}

/** The errors of a folder flush the file system doesn't do at all. */
const FLUSH_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** Flushes a folder's entries to the disk; Windows opens no folder for that, and flushes them itself. */
async function syncFolder(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
