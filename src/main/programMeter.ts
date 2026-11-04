/**
 * How the OS sandbox's Executor measures a running program against its memory and folder limits
 * (ADR-0025): its processes from `ps`, and on macOS each one's footprint, the files of its
 * working folder, and the files its processes hold open that no folder names any more. Windows
 * has no `ps`; its Job Object will hold these limits.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProgramMeter } from "../core/execution";

const execFileAsync = promisify(execFile);

interface ProcessListing {
  parents: Map<number, number>;
  groups: Map<number, number>;
  resident: Map<number, number>;
}

/** `ps -A -o pid=,ppid=,pgid=,rss=`, resident memory in bytes. */
function readListing(listing: string): ProcessListing {
  const read: ProcessListing = { parents: new Map(), groups: new Map(), resident: new Map() };
  for (const line of listing.split("\n")) {
    const [pid, ppid, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || !Number.isFinite(pid) || pid <= 0) continue;
    read.parents.set(pid, ppid ?? 0);
    read.groups.set(pid, pgid ?? 0);
    read.resident.set(pid, Number.isFinite(rss) ? (rss ?? 0) * 1024 : 0);
  }
  return read;
}

/**
 * The processes started as `roots` and all under each: its process group, and every process
 * descended from it, since bubblewrap starts the sandboxed program in a session of its own
 * (`--new-session`).
 */
function programPids({ parents, groups }: ProcessListing, roots: readonly number[]): number[] {
  const counted = (pid: number): boolean => {
    for (let at = pid, hops = 0; at > 1 && hops < 4096; at = parents.get(at) ?? 0, hops++) {
      if (roots.includes(at) || roots.includes(groups.get(at) ?? 0)) return true;
    }
    return false;
  };
  return [...parents.keys()].filter(counted);
}

/** `ps`'s listing of every process. */
async function listing(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid=,rss="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * The memory of the processes started as `roots` and everything under each, in bytes, from a
 * `ps` listing: each process counts the larger of its resident memory and its footprint in `held`.
 */
export function treeMemory(
  listing: string,
  roots: readonly number[],
  held: ReadonlyMap<number, number> = new Map(),
): number {
  const read = readListing(listing);
  let bytes = 0;
  for (const pid of programPids(read, roots)) {
    bytes += Math.max(read.resident.get(pid) ?? 0, held.get(pid) ?? 0);
  }
  return bytes;
}

/** Each process's `phys_footprint`, in bytes, from `footprint --noCategories -f bytes`. */
export function footprints(report: string): Map<number, number> {
  const held = new Map<number, number>();
  let pid: number | undefined;
  for (const line of report.split("\n")) {
    const header = /\[(\d+)\]: \d+-bit/.exec(line);
    if (header) pid = Number(header[1]);
    const bytes = /^\s*phys_footprint: (\d+) B$/.exec(line);
    if (bytes && pid !== undefined) held.set(pid, Number(bytes[1]));
  }
  return held;
}

/** `footprint`'s exit status when none of the processes it was given is left. */
const NONE_LEFT = 66;

/**
 * macOS swaps and compresses what a program holds once memory runs short, and resident memory
 * stops counting it, so a program could hold any amount and stay under its limit. Its
 * footprint counts it, as Activity Monitor does.
 */
async function macFootprints(pids: number[]): Promise<Map<number, number>> {
  if (process.platform !== "darwin" || pids.length === 0) return new Map();
  const args = ["--noCategories", "-f", "bytes", ...pids.flatMap((pid) => ["-p", String(pid)])];
  try {
    const { stdout } = await execFileAsync("/usr/bin/footprint", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return footprints(stdout);
  } catch (error) {
    if ((error as { code?: unknown }).code === NONE_LEFT) return new Map();
    throw error;
  }
}

/**
 * The program's memory, in bytes; where its footprint can't be read, its resident memory alone,
 * and `unmeasured` is told why.
 */
async function programMemory(
  roots: readonly number[],
  unmeasured: (error: unknown) => void,
): Promise<number> {
  const stdout = await listing();
  const held = await macFootprints(programPids(readListing(stdout), roots)).catch(
    (error: unknown) => {
      unmeasured(error);
      return new Map<number, number>();
    },
  );
  return treeMemory(stdout, roots, held);
}

/**
 * Each regular file with no link left in an `lsof -F ftDisk` listing, by device and inode (a file
 * two processes hold, or one holds twice, counts once), with its size in bytes.
 */
export function unlinkedFiles(listing: string): Map<string, number> {
  const files = new Map<string, number>();
  let file: Record<string, string> = {};
  const done = () => {
    if (file.t === "REG" && file.k === "0" && file.D !== undefined && file.i !== undefined) {
      files.set(`${file.D}:${file.i}`, Number(file.s ?? 0));
    }
    file = {};
  };
  for (const line of listing.split("\n")) {
    const field = line.slice(0, 1);
    if (field === "p" || field === "f") done();
    if (field !== "") file[field] = line.slice(1);
  }
  done();
  return files;
}

/** lsof's exit status when some of what it was asked for isn't there, such as a pid that has ended. */
const SOME_NOT_FOUND = 1;

async function macUnlinked(pids: readonly number[]): Promise<Map<string, number>> {
  const args = ["-n", "-P", "-w", "-a", "+L1", "-p", pids.join(","), "-F", "ftDisk"];
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", args, { maxBuffer: 16 * 1024 * 1024 });
    return unlinkedFiles(stdout);
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    if (code === SOME_NOT_FOUND && typeof stdout === "string") return unlinkedFiles(stdout);
    throw error;
  }
}

const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function procUnlinked(pids: readonly number[]): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch((error: unknown) => {
      if (gone(error)) return [];
      throw error;
    });
    for (const fd of fds) {
      const info = await stat(`/proc/${pid}/fd/${fd}`).catch((error: unknown) => {
        if (gone(error)) return null;
        throw error;
      });
      if (info?.isFile() && info.nlink === 0) files.set(`${info.dev}:${info.ino}`, info.size);
    }
  }
  return files;
}

/**
 * The bytes of the files `pids` hold open that no folder names any more: written in the working
 * folder and unlinked, they still take the disk, but no walk of the folder finds them.
 */
async function unlinkedBytes(pids: readonly number[]): Promise<number> {
  if (pids.length === 0) return 0;
  const files = process.platform === "darwin" ? await macUnlinked(pids) : await procUnlinked(pids);
  let bytes = 0;
  for (const size of files.values()) bytes += size;
  return bytes;
}

/**
 * The bytes the files under `folder` hold; links aren't followed. A folder in it that can't be
 * read (the code can take its own folder's read permission away) holds files nothing counts, so
 * it counts as more than any limit.
 */
async function folderSize(folder: string): Promise<number> {
  let total = 0;
  const pending = [folder];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // Removed since it was listed: nothing left to count.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return Number.POSITIVE_INFINITY;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += (await lstat(path).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/**
 * The working folder's files, and those the program's processes hold with no name left; where
 * those can't be read, the folder's alone, and `unmeasured` is told why.
 */
async function programFolder(
  folder: string,
  roots: readonly number[],
  unmeasured: (error: unknown) => void,
): Promise<number> {
  const named = await folderSize(folder);
  if (named === Number.POSITIVE_INFINITY) return named;
  const pids = programPids(readListing(await listing()), roots);
  return (
    named +
    (await unlinkedBytes(pids).catch((error: unknown) => {
      unmeasured(error);
      return 0;
    }))
  );
}

export const programMeter: ProgramMeter = { memory: programMemory, folder: programFolder };
