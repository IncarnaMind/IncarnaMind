/**
 * How the OS sandbox's Executor measures its running programs against their memory and folder
 * limits (ADR-0025). One tick measures every program it watches, from one listing of the
 * computer's processes: each program's processes (with those of its run launchd took over), on
 * macOS each one's footprint, its working folder's files, and the files its processes hold open
 * that no folder names any more. Windows has no `ps`; its Job Object will hold these limits.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProgramMeter, ProgramUse } from "../core/execution";

const execFileAsync = promisify(execFile);

/** A read of the disk a run holds couldn't complete: its errno, the path and the pid it was for. */
export class DiskReadError extends Error {
  constructor(
    readonly errno: string,
    readonly path: string,
    readonly pid: number,
  ) {
    super(`A disk read for process ${pid} failed (${errno}): ${path}`);
    this.name = "DiskReadError";
  }
}

const errnoOf = (error: unknown): string => {
  const e = error as NodeJS.ErrnoException;
  return typeof e?.code === "string" ? e.code : String(e?.errno ?? "unknown");
};

/**
 * Linux `/proc`, as `procUnlinked` reads it; a test supplies its own with made-up processes.
 * `readStat` is `/proc/<pid>/stat` (readable even for a process this app can't dump), used to tell
 * a process that is exiting, a zombie or a reused pid from one that is only guarding its `fd`.
 */
export interface ProcReader {
  /** A process's open fds; `tid` reads a live thread's table when the leader's is unreadable. */
  fds(pid: number, tid: number | null): Promise<string[]>;
  readlink(pid: number, tid: number | null, fd: string): Promise<string>;
  size(
    pid: number,
    tid: number | null,
    fd: string,
  ): Promise<{ device: number; inode: string; bytes: number }>;
  maps(pid: number, tid: number | null): Promise<string>;
  /** The live threads of `pid` other than a dead leader. */
  tasks(pid: number): Promise<number[]>;
  readStat(pid: number): Promise<string>;
}

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

/** A read stopped at its deadline (a killed lsof, a hung `/proc`): the disk is unknown this turn. */
export class DiskTimeout extends Error {
  constructor() {
    super("A disk read didn't finish in time.");
    this.name = "DiskTimeout";
  }
}

async function macUnlinked(
  command: MeterCommand,
  pids: readonly number[],
): Promise<UnlinkedFile[]> {
  // -b: no stat or readlink, which wait on a volume that doesn't answer; it halves lsof's time.
  const args = ["-n", "-P", "-w", "-b", "-a", "+L1", "-p", pids.join(","), "-F", "pftDisk"];
  try {
    return unlinkedFiles(await command("/usr/sbin/lsof", args));
  } catch (error) {
    const { code, stdout, killed, signal } = error as {
      code?: unknown;
      stdout?: unknown;
      killed?: unknown;
      signal?: unknown;
    };
    // Some pids gone: lsof still printed the rest.
    if (code === SOME_NOT_FOUND && typeof stdout === "string") return unlinkedFiles(stdout);
    // Stopped at its deadline (COMMAND_MS): unknown this turn, not an error.
    if (killed === true || typeof signal === "string") throw new DiskTimeout();
    throw new DiskReadError(errnoOf(error), "lsof", 0);
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

/** Most bytes of `/proc/<pid>/maps` read before a pid counts as unknown for the turn (~65k maps). */
export const MAPS_CAP_BYTES = 6 * 1024 * 1024;

/** An fd whose target no longer exists, or a process gone between reads: counted as nothing. */
const GONE = new Set(["ENOENT", "ESRCH"]);

/** `/proc/<pid>` or, with a live thread, `/proc/<pid>/task/<tid>`. */
const procBase = (pid: number, tid: number | null) =>
  tid === null ? `/proc/${pid}` : `/proc/${pid}/task/${tid}`;

/** The real `/proc`, as the app reads it. */
export const procReader: ProcReader = {
  fds: (pid, tid) => readdir(`${procBase(pid, tid)}/fd`),
  readlink: (pid, tid, fd) => readlink(`${procBase(pid, tid)}/fd/${fd}`),
  async size(pid, tid, fd) {
    const info = await stat(`${procBase(pid, tid)}/fd/${fd}`);
    return { device: info.dev, inode: String(info.ino), bytes: info.size };
  },
  maps: (pid, tid) => readFile(`${procBase(pid, tid)}/maps`, "utf8"),
  tasks: async (pid) =>
    (await readdir(`/proc/${pid}/task`)).map(Number).filter((tid) => Number.isSafeInteger(tid)),
  readStat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
};

/** The state letter and start time (field 22) of a `/proc/<pid>/stat` line. */
export function statOf(line: string): { state: string; started: number } {
  const after = line.slice(line.lastIndexOf(")") + 2).split(" ");
  return { state: after[0] ?? "", started: Number(after[19]) };
}

/** The unlinked files `pids` hold, read the way this platform allows; `capped` when a pid's maps
 * passed the cap, so the turn is unknown. Throws `DiskReadError` on a real read error (stops the
 * run) or `DiskTimeout` on a read that passed its deadline (unknown that turn). */
async function readUnlinked(
  platform: NodeJS.Platform,
  command: MeterCommand,
  pids: readonly number[],
  reader: ProcReader,
  firstSeen: Map<number, number>,
): Promise<{ files: UnlinkedFile[]; capped: boolean }> {
  if (pids.length === 0) return { files: [], capped: false };
  if (platform === "darwin") return { files: await macUnlinked(command, pids), capped: false };
  const files: UnlinkedFile[] = [];
  let capped = false;
  for (const pid of pids) {
    const where = await whereToRead(reader, pid, firstSeen);
    if (where === "gone") continue;
    files.push(...(await readFds(reader, pid, where.fds, where.tid)));
    const read = await readMaps(reader, pid, where.tid);
    files.push(...read.files);
    capped ||= read.capped;
  }
  return { files, capped };
}

/**
 * Whether to read `pid` (and through which task), or that it is gone. On EACCES its `/proc/<pid>/
 * stat` tells a process that is exiting, a zombie or a reused pid (gone) from a live one guarding
 * its `fd` (an error, failing closed); a zombie leader with a live task is read through that task.
 */
async function whereToRead(
  reader: ProcReader,
  pid: number,
  firstSeen: Map<number, number>,
): Promise<"gone" | { fds: string[]; tid: number | null }> {
  try {
    return { fds: await reader.fds(pid, null), tid: null };
  } catch (error) {
    const code = errnoOf(error);
    if (GONE.has(code)) return "gone";
    if (code !== "EACCES") throw new DiskReadError(code, `/proc/${pid}/fd`, pid);
    let stat: { state: string; started: number };
    try {
      stat = statOf(await reader.readStat(pid));
    } catch (statError) {
      if (GONE.has(errnoOf(statError))) return "gone";
      throw new DiskReadError(errnoOf(statError), `/proc/${pid}/stat`, pid);
    }
    const seen = firstSeen.get(pid);
    if (seen === undefined) firstSeen.set(pid, stat.started);
    else if (seen !== stat.started) return "gone";
    const live = await liveTask(reader, pid);
    if (live !== null) return live;
    // Exiting or a zombie with no live task left: gone. A live, non-dumpable process: an error.
    if (stat.state === "Z" || stat.state === "X") return "gone";
    throw new DiskReadError("EACCES", `/proc/${pid}/fd`, pid);
  }
}

/** A thread of `pid` other than a dead leader whose `fd` can be read, and its fds; null when none. */
async function liveTask(
  reader: ProcReader,
  pid: number,
): Promise<{ fds: string[]; tid: number } | null> {
  const tasks = await reader.tasks(pid).catch(() => [] as number[]);
  for (const tid of tasks) {
    if (tid === pid) continue;
    try {
      return { fds: await reader.fds(pid, tid), tid };
    } catch {
      // That thread is gone too; try the next.
    }
  }
  return null;
}

/** The unlinked regular files `pid` holds open through `fds` (of a live task when `tid` is set). */
async function readFds(
  reader: ProcReader,
  pid: number,
  fds: readonly string[],
  tid: number | null,
): Promise<UnlinkedFile[]> {
  const files: UnlinkedFile[] = [];
  for (const fd of fds) {
    let target: string;
    try {
      target = await reader.readlink(pid, tid, fd);
    } catch (error) {
      // One fd closed since the listing: skip it, never the whole process.
      if (GONE.has(errnoOf(error))) continue;
      throw new DiskReadError(errnoOf(error), `${procBase(pid, tid)}/fd/${fd}`, pid);
    }
    if (!target.endsWith(" (deleted)")) continue;
    try {
      const { device, inode, bytes } = await reader.size(pid, tid, fd);
      files.push({ pid, device, inode, bytes });
    } catch (error) {
      if (GONE.has(errnoOf(error))) continue;
      throw new DiskReadError(errnoOf(error), `${procBase(pid, tid)}/fd/${fd}`, pid);
    }
  }
  return files;
}

/** The deleted files `pid` maps (through a live task when `tid` is set); `capped` past the byte cap. */
async function readMaps(
  reader: ProcReader,
  pid: number,
  tid: number | null,
): Promise<{ files: UnlinkedFile[]; capped: boolean }> {
  let text: string;
  try {
    text = await reader.maps(pid, tid);
  } catch (error) {
    // The process (or task) is gone: keep what its fds gave.
    if (GONE.has(errnoOf(error))) return { files: [], capped: false };
    throw new DiskReadError(errnoOf(error), `${procBase(pid, tid)}/maps`, pid);
  }
  const capped = text.length > MAPS_CAP_BYTES;
  return { files: unlinkedMappings(pid, capped ? text.slice(0, MAPS_CAP_BYTES) : text), capped };
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

/** How a run's last disk read ended; `null` once a tick has acted on it. */
type DiskOutcome = "ok" | "timeout" | "error" | null;

interface Watched {
  root: number;
  folder: string;
  adopted: AdoptedFinder | undefined;
  use(use: ProgramUse): void;
  unmeasured(error: unknown): void;
  /** The open bytes with no name, and the named folder bytes, when last read well; kept otherwise. */
  unlinked: number;
  lastNamed: number;
  lastMemory: number;
  /** When the current run of unreadable turns began (ms); null while the disk is readable. */
  unknownSince: number | null;
  /** The last read's end a tick hasn't acted on yet; a real error stops the run at once. */
  outcome: DiskOutcome;
  /** A read is in flight, and when it began, so an overdue one counts as unknown each tick. */
  reading: boolean;
  readStartedAt: number | null;
  device: number | undefined;
  deviceRead: boolean;
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
  /** A test's `/proc`; the real one otherwise. */
  reader?: ProcReader;
  /** A test's clock (fake timers); `Date.now` otherwise. */
  now?: () => number;
  /** False: only `tick` measures, as a test drives it. */
  interval?: boolean;
}

/** Past this, a disk read in flight counts as unknown for the turn (it isn't cancellable). */
const DISK_DEADLINE_MS = COMMAND_MS;

/** A run whose disk has stayed unreadable this long in a row is stopped (`disk-unmeasured`). */
export const UNKNOWN_DISK_MS = 10_000;

/** How a read of the open files ended. */
type DiskRead =
  | { kind: "ok"; files: UnlinkedFile[]; capped: boolean }
  | { kind: "timeout" }
  | { kind: "error"; error: DiskReadError };

async function classifyUnlinked(
  read: Promise<{ files: UnlinkedFile[]; capped: boolean }>,
): Promise<DiskRead> {
  try {
    const { files, capped } = await read;
    return { kind: "ok", files, capped };
  } catch (error) {
    if (error instanceof DiskTimeout) return { kind: "timeout" };
    if (error instanceof DiskReadError) return { kind: "error", error };
    return { kind: "error", error: new DiskReadError(errnoOf(error), "?", 0) };
  }
}

/**
 * Measures every program it watches each `WATCH_MS`. One listing of the computer's processes a
 * tick serves them all, and resident memory is judged from it before the slower disk reads, so one
 * run never waits on another's. Each run reads its own open files and walks its own folder on its
 * own; a read that errs stops that run at once (`disk-unmeasured`), a read that is slow leaves the
 * disk unknown for the turn, and a run whose disk stays unknown for more than `UNKNOWN_DISK_MS` in
 * a row is stopped. The clock is checked every tick, so a read that never returns still stops it.
 */
export function createMeters(options: MetersOptions = {}): Meters {
  const command = options.command ?? runCommand;
  const platform = options.platform ?? process.platform;
  const sizeOf = options.folder ?? folderSize;
  const reader = options.reader ?? procReader;
  const now = options.now ?? Date.now;
  const watched = new Set<Watched>();
  /** Each pid's start time when a read first saw it, to tell a reused pid from a guarded one. */
  const firstSeen = new Map<number, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let turn = 0;
  let held = new Map<number, number>();
  const reading = new Set<Promise<void>>();

  const schedule = (work: Promise<void>) => {
    reading.add(work);
    void work.finally(() => reading.delete(work));
  };

  const reportAll = (programs: readonly Watched[], error: unknown) => {
    for (const each of programs) each.unmeasured(error);
  };

  /** Reads one run's open files and walks its folder; records how the read ended. */
  async function account(each: Watched, pids: readonly number[]) {
    try {
      if (!each.deviceRead) {
        each.device = await stat(each.folder).then(
          (info) => info.dev,
          () => undefined,
        );
        each.deviceRead = true;
      }
      if (pids.length > 0) {
        const read = await classifyUnlinked(
          readUnlinked(platform, command, pids, reader, firstSeen),
        );
        if (read.kind === "error") {
          each.unmeasured(read.error);
          each.outcome = "error";
          return;
        }
        if (read.kind === "timeout") {
          each.outcome = "timeout";
          return;
        }
        each.unlinked = heldBytes(read.files, new Set(pids), each.device);
        if (read.capped) {
          each.outcome = "timeout";
          return;
        }
      }
      each.lastNamed = await sizeOf(each.folder);
      each.outcome = "ok";
    } finally {
      each.reading = false;
      each.readStartedAt = null;
    }
  }

  /** From its last read and any overdue in-flight read, what this run's folder is this tick. */
  function verdict(each: Watched, at: number): number | "unknown" {
    const status =
      each.outcome ??
      (each.reading && each.readStartedAt !== null && at - each.readStartedAt > DISK_DEADLINE_MS
        ? "timeout"
        : "pending");
    each.outcome = null;
    if (status === "error") return "unknown";
    if (status === "ok") each.unknownSince = null;
    else if (status === "timeout") each.unknownSince ??= each.readStartedAt ?? at;
    if (each.unknownSince !== null && at - each.unknownSince > UNKNOWN_DISK_MS) return "unknown";
    return each.lastNamed + each.unlinked;
  }

  /** Reports every run's memory and folder this tick, and starts a fresh read where none is pending. */
  function report(programs: readonly Watched[], pids: Map<Watched, number[]>) {
    const at = now();
    for (const each of programs) {
      const folder = verdict(each, at);
      if (watched.has(each)) each.use({ memory: each.lastMemory, folder });
      if (folder !== "unknown" && !each.reading) {
        each.reading = true;
        each.readStartedAt = at;
        schedule(account(each, pids.get(each) ?? []));
      }
    }
  }

  async function measure(programs: readonly Watched[]) {
    // The open-file read runs every tick (so a failed one keeps the disk unknown, which a folder
    // walk on an off tick must not reset); macOS footprints, which only refine memory, alternate.
    const footprintTurn = turn++ % 2 === 0;
    let listed: ListedProcess[];
    try {
      listed = readListing(await command("ps", LISTING_ARGS));
    } catch (error) {
      // No listing: memory can't be judged this tick; mark the turn unknown so a lasting failure
      // fails closed, and report from the last memory.
      reportAll(programs, error);
      for (const each of programs) each.outcome = "timeout";
      report(programs, new Map());
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
    if (platform === "darwin" && footprintTurn) {
      held = await macFootprints(command, all).catch((error: unknown) => {
        reportAll(programs, error);
        return new Map<number, number>();
      });
    }
    for (const each of programs) each.lastMemory = memoryOf(listed, pids.get(each) ?? [], held);
    report(programs, pids);
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
          lastNamed: 0,
          lastMemory: 0,
          unknownSince: null,
          outcome: null,
          reading: false,
          readStartedAt: null,
          device: undefined,
          deviceRead: false,
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
