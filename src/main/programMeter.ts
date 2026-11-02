/**
 * How the OS sandbox's Executor measures a running program against its memory and folder limits
 * (ADR-0025): its processes from `ps`, and on macOS each one's footprint, and the files of its
 * working folder. Windows has no `ps`; its Job Object will hold these limits.
 */
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
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
 * The program started as `root` and everything under it: its process group, and every process
 * descended from it, since bubblewrap starts the sandboxed program in a session of its own
 * (`--new-session`).
 */
function programPids({ parents, groups }: ProcessListing, root: number): number[] {
  const counted = (pid: number): boolean => {
    for (let at = pid, hops = 0; at > 1 && hops < 4096; at = parents.get(at) ?? 0, hops++) {
      if (at === root || groups.get(at) === root) return true;
    }
    return false;
  };
  return [...parents.keys()].filter(counted);
}

/**
 * The memory of the program started as `root` and everything under it, in bytes, from a `ps`
 * listing: each process counts the larger of its resident memory and its footprint in `held`.
 */
export function treeMemory(
  listing: string,
  root: number,
  held: ReadonlyMap<number, number> = new Map(),
): number {
  const read = readListing(listing);
  let bytes = 0;
  for (const pid of programPids(read, root)) {
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
async function programMemory(root: number, unmeasured: (error: unknown) => void): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid=,rss="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const held = await macFootprints(programPids(readListing(stdout), root)).catch(
    (error: unknown) => {
      unmeasured(error);
      return new Map<number, number>();
    },
  );
  return treeMemory(stdout, root, held);
}

/** The bytes the files under `folder` hold; links aren't followed. */
async function folderSize(folder: string): Promise<number> {
  let total = 0;
  const pending = [folder];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += (await lstat(path).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

export const programMeter: ProgramMeter = { memory: programMemory, folder: folderSize };
