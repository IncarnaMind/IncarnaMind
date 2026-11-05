/**
 * How the OS sandbox's Executor measures its running programs against their memory and folder
 * limits (ADR-0025). One tick measures every program it watches, from one listing of the
 * computer's processes: each program's processes (with those of its run launchd took over), on
 * macOS each one's footprint, its working folder's files, and the files its processes hold open
 * that no folder names any more. Windows has no `ps`; its Job Object will hold these limits.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProgramMeter, ProgramUse } from "../core/execution";

const execFileAsync = promisify(execFile);

/** How often every watched program is measured. */
export const WATCH_MS = 250;

/** How long one of the meter's commands may run: past it, what it would count is unknown. */
export const COMMAND_MS = 2000;

/**
 * Runs one of the meter's commands for what it prints; rejects as `execFile` does, with the
 * exit status as `code` and what it printed as `stdout`.
 */
export type MeterCommand = (file: string, args: readonly string[]) => Promise<string>;

/** The system's, in the C locale, each stopped after `COMMAND_MS`. */
export const runCommand: MeterCommand = async (file, args) =>
  (
    await execFileAsync(file, [...args], {
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: COMMAND_MS,
    })
  ).stdout;

/** A process as one tick lists it. */
export interface ListedProcess {
  pid: number;
  ppid: number;
  group: number;
  uid: number;
  /** Resident memory, in bytes. */
  resident: number;
}

export const LISTING_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,uid=,rss="] as const;

/** `ps` run with `LISTING_ARGS`. */
export function readListing(listing: string): ListedProcess[] {
  const listed: ListedProcess[] = [];
  for (const line of listing.split("\n")) {
    const [pid, ppid, group, uid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) continue;
    listed.push({
      pid,
      ppid: ppid ?? 0,
      group: group ?? 0,
      uid: uid ?? -1,
      resident: Number.isFinite(rss) ? (rss ?? 0) * 1024 : 0,
    });
  }
  return listed;
}

/**
 * The processes started as `roots` and all under each: its process group, and every process
 * descended from it, since bubblewrap starts the sandboxed program in a session of its own
 * (`--new-session`).
 */
function programPids(listed: readonly ListedProcess[], roots: readonly number[]): number[] {
  const parents = new Map(listed.map((each) => [each.pid, each.ppid]));
  const groups = new Map(listed.map((each) => [each.pid, each.group]));
  const counted = (pid: number): boolean => {
    for (let at = pid, hops = 0; at > 1 && hops < 4096; at = parents.get(at) ?? 0, hops++) {
      if (roots.includes(at) || roots.includes(groups.get(at) ?? 0)) return true;
    }
    return false;
  };
  return [...parents.keys()].filter(counted);
}

/**
 * The memory of the processes started as `roots` and everything under each, in bytes: each
 * process counts the larger of its resident memory and its footprint in `held`.
 */
export function treeMemory(
  listed: readonly ListedProcess[],
  roots: readonly number[],
  held: ReadonlyMap<number, number> = new Map(),
): number {
  return memoryOf(listed, programPids(listed, roots), held);
}

function memoryOf(
  listed: readonly ListedProcess[],
  pids: readonly number[],
  held: ReadonlyMap<number, number>,
): number {
  const counted = new Set(pids);
  let bytes = 0;
  for (const each of listed) {
    if (counted.has(each.pid)) bytes += Math.max(each.resident, held.get(each.pid) ?? 0);
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
async function macFootprints(
  command: MeterCommand,
  pids: readonly number[],
): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  const args = ["--noCategories", "-f", "bytes", ...pids.flatMap((pid) => ["-p", String(pid)])];
  try {
    return footprints(await command("/usr/bin/footprint", args));
  } catch (error) {
    if ((error as { code?: unknown }).code === NONE_LEFT) return new Map();
    throw error;
  }
}

/** A file a process holds open with no link left, and its size in bytes. */
export interface UnlinkedFile {
  pid: number;
  device: number;
  inode: string;
  bytes: number;
}

/** Each regular file with no link left in an `lsof -F pftDisk` listing. */
export function unlinkedFiles(listing: string): UnlinkedFile[] {
  const files: UnlinkedFile[] = [];
  let pid = 0;
  let file: Record<string, string> = {};
  const done = () => {
    if (file.t === "REG" && file.k === "0" && file.D !== undefined && file.i !== undefined) {
      files.push({
        pid,
        device: Number.parseInt(file.D, 16),
        inode: file.i,
        bytes: Number(file.s ?? 0),
      });
    }
    file = {};
  };
  for (const line of listing.split("\n")) {
    const field = line.slice(0, 1);
    if (field === "p" || field === "f") done();
    if (field === "p") pid = Number(line.slice(1));
    else if (field !== "") file[field] = line.slice(1);
  }
  done();
  return files;
}

/** lsof's exit status when some of what it was asked for isn't there, such as a pid that has ended. */
const SOME_NOT_FOUND = 1;

async function macUnlinked(command: MeterCommand, pids: readonly number[]) {
  // -b: no stat or readlink, which wait on a volume that doesn't answer; it halves lsof's time.
  const args = ["-n", "-P", "-w", "-b", "-a", "+L1", "-p", pids.join(","), "-F", "pftDisk"];
  try {
    return unlinkedFiles(await command("/usr/sbin/lsof", args));
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    if (code === SOME_NOT_FOUND && typeof stdout === "string") return unlinkedFiles(stdout);
    throw error;
  }
}

/** glibc's `makedev`: the device number `stat` gives, from the major and minor `maps` shows. */
const linuxDevice = (major: number, minor: number) =>
  (minor & 0xff) +
  (major & 0xfff) * 2 ** 8 +
  Math.floor(minor / 2 ** 8) * 2 ** 20 +
  Math.floor(major / 2 ** 12) * 2 ** 44;

/**
 * The files a Linux process maps that no folder names any more, from its `/proc/<pid>/maps`,
 * each with the most of it any mapping reaches: the length itself is read only by following
 * `/proc/<pid>/map_files`, which takes CAP_SYS_ADMIN.
 */
export function unlinkedMappings(pid: number, maps: string): UnlinkedFile[] {
  const files = new Map<string, UnlinkedFile>();
  for (const line of maps.split("\n")) {
    const mapping =
      /^([0-9a-f]+)-([0-9a-f]+) \S+ ([0-9a-f]+) ([0-9a-f]+):([0-9a-f]+) (\d+)\s+.* \(deleted\)$/.exec(
        line,
      );
    const inode = mapping?.[6];
    if (!mapping || inode === undefined || inode === "0") continue;
    const [start, end, offset, major, minor] = mapping
      .slice(1, 6)
      .map((hex) => Number.parseInt(hex ?? "", 16));
    const device = linuxDevice(major ?? 0, minor ?? 0);
    const reach = (offset ?? 0) + (end ?? 0) - (start ?? 0);
    const seen = files.get(`${device}:${inode}`);
    files.set(`${device}:${inode}`, {
      pid,
      device,
      inode,
      bytes: Math.max(seen?.bytes ?? 0, reach),
    });
  }
  return [...files.values()];
}

const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function procUnlinked(pids: readonly number[]): Promise<UnlinkedFile[]> {
  const files: UnlinkedFile[] = [];
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
      if (info?.isFile() && info.nlink === 0) {
        files.push({ pid, device: info.dev, inode: String(info.ino), bytes: info.size });
      }
    }
    const maps = await readFile(`/proc/${pid}/maps`, "utf8").catch((error: unknown) => {
      if (gone(error)) return "";
      throw error;
    });
    files.push(...unlinkedMappings(pid, maps));
  }
  return files;
}

/**
 * The bytes of `files` that `pids` hold, each file once however many hold it, on the working
 * folder's `device` where it is known: the only disk the program can write. Elsewhere such a file
 * is memory (a shared anonymous mapping, a memfd), which its memory limit counts.
 */
export function heldBytes(
  files: readonly UnlinkedFile[],
  pids: ReadonlySet<number>,
  device: number | undefined,
): number {
  const sizes = new Map<string, number>();
  for (const each of files) {
    if (!pids.has(each.pid) || (device !== undefined && each.device !== device)) continue;
    const file = `${each.device}:${each.inode}`;
    sizes.set(file, Math.max(sizes.get(file) ?? 0, each.bytes));
  }
  let bytes = 0;
  for (const size of sizes.values()) bytes += size;
  return bytes;
}

/**
 * The bytes the files under `folder` hold; links aren't followed. A folder in it that can't be
 * read (the code can take its own folder's read permission away) holds files nothing counts, so
 * it counts as more than any limit.
 */
export async function folderSize(folder: string): Promise<number> {
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

/** The run's processes launchd took over when their parents ended, told from a tick's listing. */
export type AdoptedFinder = (group: number, listed: readonly ListedProcess[]) => Promise<number[]>;

interface Watched {
  root: number;
  folder: string;
  adopted: AdoptedFinder | undefined;
  use(use: ProgramUse): void;
  unmeasured(error: unknown): void;
  /** What its processes held with no name left when last counted. */
  unlinked: number;
  /** Its working folder's device, once read. */
  device: number | undefined;
}

export interface Meters {
  /** A meter for one program; `adopted` finds its run's processes launchd took over. */
  meter(adopted?: AdoptedFinder): ProgramMeter;
  /** Measures every watched program once, as each `WATCH_MS` does. */
  tick(): Promise<void>;
}

export interface MetersOptions {
  /** A test's commands; `runCommand` otherwise. */
  command?: MeterCommand;
  platform?: NodeJS.Platform;
  /** A test's folder sizes; `folderSize` otherwise. */
  folder?: (folder: string) => Promise<number>;
  /** False: only `tick` measures, as a test drives it. */
  interval?: boolean;
}

/**
 * Measures every program it watches each `WATCH_MS`, from one listing of the computer's
 * processes. Footprints and unlinked files, the two slower reads, take turns, so each count is at
 * most one tick old and no limit is caught more than one tick late. A part that can't be read
 * counts nothing and is reported: only what was measured stops a program.
 */
export function createMeters(options: MetersOptions = {}): Meters {
  const command = options.command ?? runCommand;
  const platform = options.platform ?? process.platform;
  const sizeOf = options.folder ?? folderSize;
  const watched = new Set<Watched>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let turn = 0;
  let held = new Map<number, number>();

  const reportAll = (programs: readonly Watched[], error: unknown) => {
    for (const each of programs) each.unmeasured(error);
  };

  async function measure(programs: readonly Watched[]) {
    const listed = readListing(await command("ps", LISTING_ARGS));
    const pids = new Map<Watched, number[]>();
    for (const each of programs) {
      const adopted = each.adopted
        ? await each.adopted(each.root, listed).catch((error: unknown) => {
            each.unmeasured(error);
            return [];
          })
        : [];
      pids.set(each, programPids(listed, [each.root, ...adopted]));
    }
    const all = [...new Set([...pids.values()].flat())];
    const footprintTurn = turn++ % 2 === 0;
    if (platform === "darwin" && footprintTurn) {
      held = await macFootprints(command, all).catch((error: unknown) => {
        reportAll(programs, error);
        return new Map<number, number>();
      });
    } else if (!footprintTurn) {
      const files = await (platform === "darwin"
        ? all.length > 0
          ? macUnlinked(command, all)
          : Promise.resolve([])
        : procUnlinked(all)
      ).catch((error: unknown) => {
        reportAll(programs, error);
        return null;
      });
      for (const each of programs) {
        each.device ??= await stat(each.folder).then(
          (info) => info.dev,
          () => undefined,
        );
        each.unlinked = files === null ? 0 : heldBytes(files, new Set(pids.get(each)), each.device);
      }
    }
    for (const each of programs) {
      const memory = memoryOf(listed, pids.get(each) ?? [], held);
      const folder = (await sizeOf(each.folder)) + each.unlinked;
      // One that has ended or was stopped while this tick read is no longer the meter's to judge.
      if (watched.has(each)) each.use({ memory, folder });
    }
  }

  async function tick() {
    if (ticking || watched.size === 0) return;
    ticking = true;
    const programs = [...watched];
    try {
      await measure(programs);
    } catch (error) {
      reportAll(programs, error);
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    meter: (adopted) => ({
      watch(root, folder, use, unmeasured) {
        const each: Watched = {
          root,
          folder,
          adopted,
          use,
          unmeasured,
          unlinked: 0,
          device: undefined,
        };
        watched.add(each);
        if (options.interval !== false && timer === undefined) {
          timer = setInterval(() => void tick(), WATCH_MS);
        }
        return () => {
          watched.delete(each);
          if (watched.size === 0 && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        };
      },
    }),
  };
}
