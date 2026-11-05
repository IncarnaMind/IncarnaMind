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

/** The unlinked files `pids` hold, read the way this platform allows. */
async function readUnlinked(
  platform: NodeJS.Platform,
  command: MeterCommand,
  pids: readonly number[],
): Promise<UnlinkedFile[]> {
  if (pids.length === 0) return [];
  return platform === "darwin" ? macUnlinked(command, pids) : procUnlinked(pids);
}

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
 * folder's `device` where it is known: the only disk the program can write. A file elsewhere isn't
 * on a disk the program can fill, so the folder limit leaves it out; a memfd it never maps is held
 * by no limit, but it can't grow the folder either.
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

/**
 * The run's processes launchd took over when their parents ended, told from a tick's listing;
 * `started` caches orphan start times so every run on a tick shares one lookup.
 */
export type AdoptedFinder = (
  group: number,
  listed: readonly ListedProcess[],
  started: Map<number, number | null>,
) => Promise<number[]>;

interface Watched {
  root: number;
  folder: string;
  adopted: AdoptedFinder | undefined;
  use(use: ProgramUse): void;
  unmeasured(error: unknown): void;
  unlinked: number;
  lastFolder: number;
  lastMemory: number;
  /** Consecutive turns its own disk use couldn't be read; past the grace, the folder is unknown. */
  unknownTurns: number;
  device: number | undefined;
  deviceRead: boolean;
  /** Its folder read hasn't returned: the next tick leaves it to finish rather than stack another. */
  busy: boolean;
}

export interface Meters {
  meter(adopted?: AdoptedFinder): ProgramMeter;
  /** Measures every watched program once, as each `WATCH_MS` does; its own disk reads run after. */
  tick(): Promise<void>;
  /** Waits for the disk reads this tick's `tick` set going, so a test can read what they report. */
  settle(): Promise<void>;
}

export interface MetersOptions {
  command?: MeterCommand;
  platform?: NodeJS.Platform;
  folder?: (folder: string) => Promise<number>;
  /** False: only `tick` measures, as a test drives it. */
  interval?: boolean;
}

/** How many turns in a row a program's own disk use may be unreadable before its folder is unknown. */
const UNKNOWN_FOLDER_TURNS = 2;

const TIMED_OUT: unique symbol = Symbol("timed out");

/** `work`'s result, or `TIMED_OUT` if it takes longer than `ms`; the work runs on, its throw caught. */
async function within<T>(ms: number, work: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  const running: Promise<T | typeof TIMED_OUT> = work().catch(() => TIMED_OUT);
  try {
    return await Promise.race([running, limit]);
  } finally {
    clearTimeout(timer);
    void running.catch(() => undefined);
  }
}

/**
 * Measures every program it watches each `WATCH_MS`. One listing of the computer's processes a
 * tick serves them all, and memory is judged from it before the slower reads, so one run never
 * waits on another's. Footprints and unlinked files take turns, so neither is more than one tick
 * old. Each read stops after `COMMAND_MS`; a program's own folder walk runs on its own, and when
 * its disk use stays unreadable its folder is reported unknown, which stops that run and no other.
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
  const reading = new Set<Promise<void>>();

  /** Schedules a program's own disk read, which runs on its own so no run waits on another. */
  const read = (work: Promise<void>) => {
    reading.add(work);
    void work.finally(() => reading.delete(work));
  };

  const reportAll = (programs: readonly Watched[], error: unknown) => {
    for (const each of programs) each.unmeasured(error);
  };

  /** Reads each program's own folder and unlinked files, then reports what it holds. Runs on its own. */
  async function account(
    each: Watched,
    pids: readonly number[] | null,
    unlinkedTurn: boolean,
    shared: UnlinkedFile[] | "failed" | null,
  ) {
    if (each.busy) return;
    each.busy = true;
    try {
      if (!each.deviceRead) {
        each.device = await stat(each.folder).then(
          (info) => info.dev,
          () => undefined,
        );
        each.deviceRead = true;
      }
      if (unlinkedTurn) {
        const own =
          shared === "failed" || shared === null
            ? pids === null
              ? TIMED_OUT
              : await within(COMMAND_MS, () => readUnlinked(platform, command, pids))
            : shared;
        if (own === TIMED_OUT || pids === null) {
          each.unknownTurns += 1;
        } else {
          each.unlinked = heldBytes(own, new Set(pids), each.device);
          each.unknownTurns = 0;
        }
      }
      const walked = await within(COMMAND_MS, () => sizeOf(each.folder));
      // Open files it holds that no limit could read stop it; a folder walk that is only slow this
      // tick keeps the last count, so many small files that take a while to walk don't stop a run.
      if (each.unknownTurns >= UNKNOWN_FOLDER_TURNS) {
        if (watched.has(each)) each.use({ memory: each.lastMemory, folder: "unknown" });
      } else {
        if (walked !== TIMED_OUT) each.lastFolder = walked + each.unlinked;
        if (watched.has(each)) each.use({ memory: each.lastMemory, folder: each.lastFolder });
      }
    } finally {
      each.busy = false;
    }
  }

  async function measure(programs: readonly Watched[]) {
    let listed: ListedProcess[];
    try {
      listed = readListing(await command("ps", LISTING_ARGS));
    } catch (error) {
      // No processes to read: memory can't be judged, so leave each run's own folder read to fail
      // closed if its disk use stays unreadable.
      reportAll(programs, error);
      for (const each of programs) read(account(each, null, turn % 2 === 1, "failed"));
      turn += 1;
      return;
    }
    const started = new Map<number, number | null>();
    const pids = new Map<Watched, number[]>();
    for (const each of programs) {
      const adopted = each.adopted
        ? await each.adopted(each.root, listed, started).catch((error: unknown) => {
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
    }
    // Memory from the listing first, before the slower disk reads, so a program that allocates
    // fast is stopped without waiting on any run's folder.
    for (const each of programs) {
      each.lastMemory = memoryOf(listed, pids.get(each) ?? [], held);
      if (watched.has(each)) each.use({ memory: each.lastMemory, folder: each.lastFolder });
    }
    let shared: UnlinkedFile[] | "failed" | null = null;
    if (!footprintTurn) {
      const read = await within(COMMAND_MS, () => readUnlinked(platform, command, all));
      if (read === TIMED_OUT) {
        shared = "failed";
        reportAll(programs, new Error("The open files of the running programs couldn't be read."));
      } else {
        shared = read;
      }
    }
    for (const each of programs) read(account(each, pids.get(each) ?? [], !footprintTurn, shared));
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
    settle: async () => {
      await Promise.allSettled([...reading]);
    },
    meter: (adopted) => ({
      watch(root, folder, use, unmeasured) {
        const each: Watched = {
          root,
          folder,
          adopted,
          use,
          unmeasured,
          unlinked: 0,
          lastFolder: 0,
          lastMemory: 0,
          unknownTurns: 0,
          device: undefined,
          deviceRead: false,
          busy: false,
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
