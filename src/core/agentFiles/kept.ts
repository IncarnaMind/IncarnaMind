/**
 * What IncarnaMind keeps in the data folder of the files outside agents hand over (#3412) goes with
 * the file's Document once it is deleted for good (#3505): each item's folder in "Handed files",
 * its versions' copies and the Document's own file. Only IncarnaMind's copies are removed, never
 * the file at the path the agent named, and never through a symbolic link.
 */
import type { Stats } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isGone, isInside, pathIn } from "../documents/files";
import type { Database } from "../storage";
import { HANDED_FOLDER } from "./handOver";

/** Whether `path` is in the data folder's "Handed files", and not that folder itself. */
export const isKeptCopy = (dataDir: string, path: string): boolean => {
  const root = join(dataDir, HANDED_FOLDER);
  return path !== root && isInside(root, path);
};

/** Removes a file or folder kept in "Handed files", which must be reached without a link. */
async function removeKept(dataDir: string, target: string): Promise<void> {
  if (!isKeptCopy(dataDir, target)) throw new Error(`Not removed, not a kept copy: ${target}`);
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isGone(error)) return;
    throw error;
  }
  const parent = dirname(target);
  const [realData, realParent] = await Promise.all([realpath(dataDir), realpath(parent)]);
  if (info.isSymbolicLink() || realParent !== join(realData, relative(dataDir, parent))) {
    throw new Error(`Not removed, a symbolic link is in the way: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

/**
 * Removes the folder of each item that ended with its Document (its rows deleted, as
 * `recentlyDeleted` does when the Document is deleted for good), and `ownFiles`: the files of
 * Documents deleted for good that an item which goes on with a newer Document no longer needs.
 * The file of a Document that can still come back stays, and the rest of its item's folder goes.
 * Run again at each start, so a removal that failed is tried again; each failure is reported.
 */
export async function dropPurgedHanded(options: {
  db: Database;
  dataDir: string;
  ownFiles: readonly string[];
  reportError(error: unknown): void;
}): Promise<void> {
  const { db, dataDir, reportError } = options;
  // Read before anything is awaited: the core may close meanwhile, and the database with it.
  const endedIds = db
    .all<{ id: string }>("SELECT id FROM agent_files WHERE deleted_at IS NOT NULL")
    .map((row) => row.id);
  const holding = db
    .all<{ relative_path: string }>(
      `SELECT relative_path FROM documents
       WHERE purged_at IS NULL AND source_kind = 'data-folder'
         AND relative_path >= ? AND relative_path < ?`,
      [`${HANDED_FOLDER}/`, `${HANDED_FOLDER}0`],
    )
    .map((row) => pathIn(dataDir, row.relative_path));
  const root = join(dataDir, HANDED_FOLDER);
  const listing = (folder: string) =>
    readdir(folder).catch((error: unknown) => {
      if (!isGone(error)) reportError(error);
      return [];
    });
  const there = new Set(await listing(root));
  const targets = new Set(options.ownFiles);
  for (const folder of endedIds.filter((id) => there.has(id)).map((id) => join(root, id))) {
    const held = holding.filter((path) => isInside(folder, path));
    if (held.length === 0) {
      targets.add(folder);
      continue;
    }
    for (const name of await listing(folder)) {
      const entry = join(folder, name);
      if (!held.some((path) => isInside(entry, path))) targets.add(entry);
    }
  }
  const outermost = [...targets].filter(
    (target) => ![...targets].some((other) => other !== target && isInside(other, target)),
  );
  await Promise.all(outermost.map((target) => removeKept(dataDir, target).catch(reportError)));
}
