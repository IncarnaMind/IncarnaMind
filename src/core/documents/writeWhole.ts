/**
 * Writes a Document's file whole or not at all: a partial file beside it, a
 * rename over it, so a quit halfway never leaves a Document reading half its
 * words (the path Fetch again writes its new version by).
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashBytes } from "./files";

export interface WrittenFile {
  path: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

/** `at`: the time the version is dated, ISO 8601, set before the rename so no reader sees another. */
export async function writeWholeFile(
  path: string,
  bytes: Uint8Array,
  at?: string,
): Promise<WrittenFile> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(partial, bytes, { mode: 0o600 });
    const taken = at === undefined ? null : new Date(at);
    if (taken !== null && !Number.isNaN(taken.getTime())) await utimes(partial, taken, taken);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const { mtimeMs } = await stat(path);
  return { path, contentHash: hashBytes(bytes), size: bytes.byteLength, mtimeMs };
}
