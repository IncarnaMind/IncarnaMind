import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { cutAtWord } from "../shared/naming";

/** Longest a file name made from a title gets, before its extension. */
const MAX_NAME_LENGTH = 120;

/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** How many names a save tries ("Tides 2.docx", "Tides 3.docx"…) before giving up. */
const MAX_TRIES = 1000;

/** The names a save of `name` tries, as `writeNewFile` and `freeFileName` pick them. */
function* nameCandidates(name: string): Generator<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let n = 1; n <= MAX_TRIES; n++) yield n === 1 ? name : `${stem} ${n}${extension}`;
}

/**
 * A file name (without its extension) from a title, e.g. a Mind's or a
 * Document's: without characters file systems refuse, and not too long.
 * `fallback` if nothing is left.
 */
export function safeFileName(title: string, fallback: string): string {
  const name = cutAtWord(
    title
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters can't be in file names.
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, ""),
    MAX_NAME_LENGTH,
  ).replace(/[\s.]+$/, "");
  if (!name) return fallback;
  return WINDOWS_DEVICE.test(name) ? `${name}_` : name;
}

/** A temporary file's name: dot, a random id and "partial", or, from older versions, the file's name before the id. */
const PARTIAL =
  /^\.(?:.*\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/;

/** When this run began: a temporary file older than it was left by a run that ended before its file was named. */
const STARTED = Date.now();

const swept = new Set<string>();

/**
 * Takes out the temporary files an earlier run left in `folder` (a force-quit or a crash between
 * writing and naming a file), once per folder per run. Only those older than this run: a file
 * this run is writing is newer. A folder that can't be read is left.
 */
export async function removeStalePartials(folder: string): Promise<void> {
  if (swept.has(folder)) return;
  swept.add(folder);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((each) => PARTIAL.test(each))
      .map(async (each) => {
        const path = join(folder, each);
        const info = await stat(path).catch(() => null);
        // One that can't be removed now is tried again at the next run.
        if (info?.isFile() && info.mtimeMs < STARTED)
          await rm(path, { force: true }).catch(() => {});
      }),
  );
}

/**
 * Writes a new file in `folder` under `name` ("Tides.docx"), or under the
 * next free name, as Finder does ("Tides 2.docx", "Tides 3.docx"), and
 * returns the name used. The bytes are written and flushed to a temporary
 * file first, and only then does a hard link give it its name, which fails if
 * anything is there already, a file or a link: nothing is ever replaced or
 * followed, and a name is never seen empty or half written, whenever the
 * program stops. The temporary file goes in the end; one a stop leaves is taken
 * out the next run (`removeStalePartials`). Where the file system has no hard
 * links, the name is made first and the finished file renamed onto it.
 */
/** The one name a save was allowed to take, and something is there already. */
export class NameTakenError extends Error {
  override name = "NameTakenError";
}

export async function writeNewFile(
  folder: string,
  name: string,
  data: Uint8Array,
  /** Write this name or nothing: a save the User allowed by name is never written under another. */
  exact = false,
): Promise<string> {
  await removeStalePartials(folder);
  const temporary = join(folder, `.${randomUUID()}.partial`);
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    let linking = true;
    for (const candidate of nameCandidates(name)) {
      const path = join(folder, candidate);
      if (linking) {
        try {
          await link(temporary, path);
          return candidate;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            if (exact) throw new NameTakenError(`"${candidate}" is taken in that folder.`);
            continue;
          }
          // Node reports a FAT or exFAT drive on Windows as EISDIR or EINVAL, a network share by
          // other codes: any refusal of the link falls back, and a real problem (EACCES, ENOSPC)
          // is raised again by the file made below.
          if (code === undefined) throw error;
          linking = false;
        }
      }
      try {
        await (await open(path, "wx")).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          if (exact) throw new NameTakenError(`"${candidate}" is taken in that folder.`);
          continue;
        }
        throw error;
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      return candidate;
    }
    throw new Error(`Every name like "${name}" is taken in that folder.`);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The name a save of `name` would take in `folder`, as `writeNewFile` picks it, without writing:
 * the name itself, or the next free "Tides 2.docx". `taken` holds names chosen in the same batch.
 */
export async function freeFileName(
  folder: string,
  name: string,
  taken: ReadonlySet<string> = new Set(),
): Promise<string> {
  for (const candidate of nameCandidates(name)) {
    if (taken.has(candidate)) continue;
    try {
      await lstat(join(folder, candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error(`Every name like "${name}" is taken in that folder.`);
}

/**
 * Replaces the file at `path` with `data`, written beside it first and then renamed over it, so a
 * reader sees the old file or the new one, never part of either. `stillSo` is asked right before
 * the rename; when it answers false, the file is left as it is and this returns false.
 */
export async function replaceFile(
  path: string,
  data: Uint8Array,
  stillSo: () => Promise<boolean>,
): Promise<boolean> {
  const temporary = join(dirname(path), `.${randomUUID()}.partial`);
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    if (!(await stillSo())) return false;
    await rename(temporary, path);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}
