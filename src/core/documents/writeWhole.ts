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
  await mkdir(dirname(path), { recursive: true });
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
  // The file is in place: a folder that can't be flushed leaves it there, only less sure of a power cut.
  if (options.durable) {
    await syncFolder(dirname(path)).catch((error: unknown) =>
      console.error("A folder couldn't be flushed to the disk.", dirname(path), error),
    );
  }
  const { mtimeMs } = await stat(path);
  return { path, contentHash: hashBytes(bytes), size: bytes.byteLength, mtimeMs };
}

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
