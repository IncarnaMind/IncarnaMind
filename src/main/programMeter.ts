/**
 * How the OS sandbox's Executor measures its running programs against their memory and folder
 * limits (ADR-0025). One tick measures every program it watches, from one listing of the
 * computer's processes: each program's processes (with those of its run launchd took over), on
 * macOS each one's footprint, its working folder's files, and the files its processes hold open
 * that no folder names any more. Windows has no `ps`; its Job Object will hold these limits.
 */
import { execFile } from "node:child_process";
import { createReadStream, type Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { ProgramMeter, ProgramUse } from "../core/execution";

const execFileAsync = promisify(execFile);

/** A Linux task as its `/proc/<pid>/stat` line shows it. */
export interface TaskStat {
  comm: string;
  state: string;
  /** The kernel's `PF_*` flags (field 9). */
  flags: number;
  /** When it started, in clock ticks since boot (field 22). */
  started: number;
  /** Its address space in bytes (field 23): 0 once it has given up its memory. */
  vsize: number;
}

/**
 * A read of the disk a run holds couldn't complete: its errno, the path and the pid it was for,
 * and on Linux the task's state and the PID namespaces it is in, which tell what the process was.
 */
export class DiskReadError extends Error {
  readonly task: TaskStat | undefined;
  readonly nspid: readonly string[] | undefined;

  constructor(
    readonly errno: string,
    readonly path: string,
    readonly pid: number,
    { cause, task, nspid }: { cause?: unknown; task?: TaskStat; nspid?: readonly string[] } = {},
  ) {
    const detail = [
      task &&
        `${task.comm}: state ${task.state}, flags 0x${task.flags.toString(16)}, vsize ${task.vsize}`,
      nspid && `NSpid ${nspid.join(" ")}`,
    ].filter(Boolean);
    super(
      `A disk read for process ${pid} failed (${errno}): ${path}${detail.length ? ` (${detail.join("; ")})` : ""}`,
      { cause },
    );
    this.name = "DiskReadError";
    this.task = task;
    this.nspid = nspid;
  }
}

const errnoOf = (error: unknown): string => {
  const e = error as NodeJS.ErrnoException;
  if (typeof e?.code === "string") return e.code;
  if (typeof e?.code === "number") return `exit ${e.code}`;
  return String(e?.errno ?? "unknown");
};

/** Linux `/proc`, as the meter reads it; a test supplies its own with made-up processes. */
export interface ProcReader {
  /** A process's open fds; `tid` reads a live thread's table when the leader's is unreadable. */
  fds(pid: number, tid: number | null): Promise<string[]>;
  readlink(pid: number, tid: number | null, fd: string): Promise<string>;
  size(
    pid: number,
    tid: number | null,
    fd: string,
  ): Promise<{ device: number; inode: string; bytes: number }>;
  /** `/proc/<pid>/maps`, in the chunks it is read in, so a read can stop part way. */
  maps(pid: number, tid: number | null): AsyncIterable<Uint8Array>;
  tasks(pid: number): Promise<number[]>;
  /** `/proc/<pid>/stat`, which stays readable when the task's `fd` doesn't. */
  stat(pid: number, tid: number | null): Promise<string>;
  /** `/proc/<pid>/status`, or the app's own. */
  status(pid: number | "self"): Promise<string>;
  /** The time since boot, in the clock ticks `stat` gives start times in. */
  ticks(): Promise<number>;
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
  if (pids.length === 0) return [];
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
    if (code === SOME_NOT_FOUND && typeof stdout === "string") return unlinkedFiles(stdout);
    if (killed === true || typeof signal === "string") throw new DiskTimeout();
    throw new DiskReadError(errnoOf(error), "lsof", pids[0] ?? 0, { cause: error });
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

/**
 * Most bytes of maps a turn reads across a run's processes: past it the turn reads no further and
 * the disk is unknown, so a run that stays over it can't keep the app streaming its maps (#2351).
 * A Python worker with the scientific stack maps about 320 KB, so 64 of them, a run's process
 * limit, fit under it.
 */
export const MAPS_BUDGET_BYTES = 32 * 1024 * 1024;

/** An fd whose target no longer exists, or a process gone between reads: counted as nothing. */
const GONE = new Set(["ENOENT", "ESRCH"]);

/** The kernel sets it as a task starts to exit, before it gives up its memory and files. */
const PF_EXITING = 0x4;

/**
 * Most descriptors a run's processes may hold for a turn to read them: past it, following each to
 * its target would cost the app about a core while the run went on, so the turn reads none and
 * the disk is unknown (#2351).
 */
export const DESCRIPTORS_CAP = 8192;

/** How many PID namespaces below the app's the User's code runs: bubblewrap's, then the helper's. */
const RUN_NAMESPACE = 2;

/** `stat`'s clock ticks a second (USER_HZ), 100 on every architecture Linux runs Electron on. */
const USER_HZ = 100;

const procBase = (pid: number, tid: number | null) =>
  tid === null ? `/proc/${pid}` : `/proc/${pid}/task/${tid}`;

export const procReader: ProcReader = {
  fds: (pid, tid) => readdir(`${procBase(pid, tid)}/fd`),
  readlink: (pid, tid, fd) => readlink(`${procBase(pid, tid)}/fd/${fd}`),
  async size(pid, tid, fd) {
    const info = await stat(`${procBase(pid, tid)}/fd/${fd}`);
    return { device: info.dev, inode: String(info.ino), bytes: info.size };
  },
  maps: (pid, tid) => createReadStream(`${procBase(pid, tid)}/maps`, { highWaterMark: 64 * 1024 }),
  tasks: async (pid) =>
    (await readdir(`/proc/${pid}/task`)).map(Number).filter((tid) => Number.isSafeInteger(tid)),
  stat: (pid, tid) => readFile(`${procBase(pid, tid)}/stat`, "utf8"),
  status: (pid) => readFile(`/proc/${pid}/status`, "utf8"),
  async ticks() {
    const [seconds = "", hundredths = ""] =
      (await readFile("/proc/uptime", "utf8")).split(" ")[0]?.split(".") ?? [];
    return Number(seconds) * USER_HZ + Number(hundredths.padEnd(2, "0").slice(0, 2));
  },
};

export function statOf(line: string): TaskStat {
  const close = line.lastIndexOf(")");
  const after = line.slice(close + 2).split(" ");
  return {
    comm: line.slice(line.indexOf("(") + 1, close),
    state: after[0] ?? "",
    flags: Number(after[6]),
    started: Number(after[19]),
    vsize: Number(after[20]),
  };
}

/** The task as `stat` shows it now; null once it has gone. */
async function taskStat(reader: ProcReader, pid: number, tid: number | null) {
  try {
    return statOf(await reader.stat(pid, tid));
  } catch (error) {
    if (GONE.has(errnoOf(error))) return null;
    throw new DiskReadError(errnoOf(error), `${procBase(pid, tid)}/stat`, pid, { cause: error });
  }
}

/**
 * Once a task has given up its memory on its way out, the kernel makes its `fd` root's, though it
 * isn't a zombie yet and its files are still closing.
 */
const exiting = (task: TaskStat | null) =>
  task === null ||
  task.state === "Z" ||
  task.state === "X" ||
  (task.flags & PF_EXITING) !== 0 ||
  task.vsize === 0;

/** EACCES on a task's files is its exit, or an error when the task is alive: it hides them. */
async function denied(reader: ProcReader, pid: number, tid: number | null, path: string) {
  const task = await taskStat(reader, pid, tid);
  if (!exiting(task)) throw new DiskReadError("EACCES", path, pid, { task: task ?? undefined });
}

/**
 * The pids `pid` has in each PID namespace it is in, outermost (the one `/proc` was mounted in)
 * first; null once it has gone.
 */
async function nspidOf(reader: ProcReader, pid: number | "self"): Promise<string[] | null> {
  const path = `/proc/${pid}/status`;
  const at = pid === "self" ? 0 : pid;
  let status: string;
  try {
    status = await reader.status(pid);
  } catch (error) {
    if (pid !== "self" && GONE.has(errnoOf(error))) return null;
    throw new DiskReadError(errnoOf(error), path, at, { cause: error });
  }
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  if (!nspid) throw new DiskReadError("no NSpid line", path, at);
  return nspid;
}

/**
 * The unlinked files the Linux processes `pids` of a listing held, as `listedAt` ticks after boot,
 * through their fds and maps. Only the User's processes are read: those in the run's own PID
 * namespace, two below the app's, and below it, but for that namespace's first process, the
 * seccomp helper's inner half. No process can climb to a shallower namespace, and the helper's
 * halves make themselves non-dumpable, so the sandbox's own processes are never read. A turn that
 * didn't find the helper's inner half (before it starts, or if the layout ever changed) is
 * `partial`, like one whose processes hold more than `DESCRIPTORS_CAP` descriptors, which it
 * counts before following any, and one that stops at the first process whose maps pass
 * `MAPS_CAP_BYTES` or at `MAPS_BUDGET_BYTES` of maps in all: the disk is unknown that turn.
 */
async function procUnlinked(
  reader: ProcReader,
  pids: readonly number[],
  listedAt: number,
): Promise<{ files: UnlinkedFile[]; partial: boolean }> {
  const files: UnlinkedFile[] = [];
  const app = (await nspidOf(reader, "self"))?.length ?? 0;
  let helper = false;
  const user: { pid: number; nspid: string[]; fds: string[]; tid: number | null }[] = [];
  let descriptors = 0;
  for (const pid of pids) {
    const nspid = await nspidOf(reader, pid);
    if (nspid === null) continue;
    const depth = nspid.length - app;
    if (depth < 0) {
      throw new DiskReadError("NSpid shallower than the app's", `/proc/${pid}/status`, pid, {
        nspid,
      });
    }
    if (depth < RUN_NAMESPACE) continue;
    if (depth === RUN_NAMESPACE && nspid.at(-1) === "1") {
      helper = true;
      continue;
    }
    const where = await naming(pid, nspid, () => whereToRead(reader, pid, listedAt));
    if (where === "gone") continue;
    descriptors += where.fds.length;
    if (descriptors > DESCRIPTORS_CAP) return { files: [], partial: true };
    user.push({ pid, nspid, ...where });
  }
  let mapsLeft = MAPS_BUDGET_BYTES;
  for (const { pid, nspid, fds, tid } of user) {
    const held = await naming(pid, nspid, () => readFds(reader, pid, fds, tid));
    files.push(...held.files);
    if (held.exited) continue;
    const mapped = await naming(pid, nspid, () =>
      readMaps(reader, pid, tid, Math.min(MAPS_CAP_BYTES, mapsLeft)),
    );
    files.push(...mapped.files);
    if (mapped.capped) return { files, partial: true };
    mapsLeft -= mapped.bytes;
  }
  return { files, partial: !helper };
}

/** `read`'s result; its failure as a `DiskReadError` that names `pid`'s namespaces. */
async function naming<T>(pid: number, nspid: readonly string[], read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    const known = error instanceof DiskReadError ? error : undefined;
    throw new DiskReadError(known?.errno ?? errnoOf(error), known?.path ?? `/proc/${pid}`, pid, {
      cause: known ? known.cause : error,
      task: known?.task,
      nspid,
    });
  }
}

/**
 * Whether to read `pid`, through which task, or that it is gone. A zombie leader whose thread lives
 * on is read through that thread: the leader's own fd folder is denied, or empty when the app runs
 * as root.
 */
async function whereToRead(
  reader: ProcReader,
  pid: number,
  listedAt: number,
): Promise<"gone" | { fds: string[]; tid: number | null }> {
  let fds: string[] | null = null;
  try {
    fds = await reader.fds(pid, null);
  } catch (error) {
    const code = errnoOf(error);
    if (GONE.has(code)) return "gone";
    if (code !== "EACCES") {
      throw new DiskReadError(code, `/proc/${pid}/fd`, pid, { cause: error });
    }
  }
  if (fds !== null && fds.length > 0) return { fds, tid: null };
  const leader = await taskStat(reader, pid, null);
  // Started after the listing: the pid has gone to another process.
  if (leader === null || leader.started > listedAt) return "gone";
  if (fds !== null && leader.state !== "Z") return { fds, tid: null };
  const live = await liveTask(reader, pid);
  if (live !== null) return live;
  if (fds !== null || exiting(leader)) return "gone";
  throw new DiskReadError("EACCES", `/proc/${pid}/fd`, pid, { task: leader });
}

async function liveTask(
  reader: ProcReader,
  pid: number,
): Promise<{ fds: string[]; tid: number } | null> {
  let tasks: number[];
  try {
    tasks = await reader.tasks(pid);
  } catch (error) {
    if (GONE.has(errnoOf(error))) return null;
    throw new DiskReadError(errnoOf(error), `/proc/${pid}/task`, pid, { cause: error });
  }
  let empty: { fds: string[]; tid: number } | null = null;
  for (const tid of tasks) {
    if (tid === pid) continue;
    try {
      const fds = await reader.fds(pid, tid);
      if (fds.length > 0) return { fds, tid };
      // As root a thread on its way out reads empty, not denied, while another still holds the files.
      empty ??= { fds, tid };
    } catch (error) {
      const code = errnoOf(error);
      if (GONE.has(code)) continue;
      const path = `${procBase(pid, tid)}/fd`;
      if (code !== "EACCES") throw new DiskReadError(code, path, pid, { cause: error });
      await denied(reader, pid, tid, path);
    }
  }
  return empty;
}

/** The unlinked regular files `pid` holds through `fds`: those read so far if it `exited`. */
async function readFds(
  reader: ProcReader,
  pid: number,
  fds: readonly string[],
  tid: number | null,
): Promise<{ files: UnlinkedFile[]; exited: boolean }> {
  const files: UnlinkedFile[] = [];
  for (const fd of fds) {
    const path = `${procBase(pid, tid)}/fd/${fd}`;
    try {
      if (!(await reader.readlink(pid, tid, fd)).endsWith(" (deleted)")) continue;
      const { device, inode, bytes } = await reader.size(pid, tid, fd);
      files.push({ pid, device, inode, bytes });
    } catch (error) {
      const code = errnoOf(error);
      if (GONE.has(code)) continue;
      if (code !== "EACCES") throw new DiskReadError(code, path, pid, { cause: error });
      await denied(reader, pid, tid, path);
      return { files, exited: true };
    }
  }
  return { files, exited: false };
}

/**
 * The deleted files `pid` maps, and how many `bytes` of its maps were read; `capped`, and read no
 * further, past `limit`.
 */
async function readMaps(
  reader: ProcReader,
  pid: number,
  tid: number | null,
  limit: number,
): Promise<{ files: UnlinkedFile[]; bytes: number; capped: boolean }> {
  const deleted: string[] = [];
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let partial = "";
  try {
    for await (const chunk of reader.maps(pid, tid)) {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        return { files: unlinkedMappings(pid, deleted.join("\n")), bytes, capped: true };
      }
      const lines = (partial + decoder.write(chunk)).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.endsWith(" (deleted)")) deleted.push(line);
    }
  } catch (error) {
    const code = errnoOf(error);
    if (GONE.has(code)) return { files: [], bytes, capped: false };
    const path = `${procBase(pid, tid)}/maps`;
    if (code !== "EACCES") throw new DiskReadError(code, path, pid, { cause: error });
    await denied(reader, pid, tid, path);
    return { files: [], bytes, capped: false };
  }
  deleted.push(partial + decoder.end());
  return { files: unlinkedMappings(pid, deleted.join("\n")), bytes, capped: false };
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
  adoptedPids: number[];
  memory: number;
  folderUse: number | "unknown";
  /** The named folder bytes from its last walk, and the unlinked bytes from its last good read. */
  named: number;
  unlinked: number;
  walking: boolean;
  /** When its read of open files in flight began. */
  readingSince: number | null;
  /** The app's CPU time, in ms, as that read began. */
  readingCpu: number;
  /** The soonest its next read of open files may begin. */
  nextReadAt: number;
  /** How its last read ended, and when that read began, until a tick acts on it. */
  ended: { ok: boolean; startedAt: number } | null;
  failed: boolean;
  /** When its disk became unknown, in the current run of unknown turns. */
  unknownSince: number | null;
  /** Its folder's device, read as watching starts, before the program can remove the folder. */
  device: Promise<number | undefined>;
}

export interface Meters {
  meter(adopted?: AdoptedFinder): ProgramMeter;
  /** Measures every watched program once, as each `WATCH_MS` does; its slower reads run after. */
  tick(): Promise<void>;
  /** Waits for the reads `tick` set going, so a test can read what they report. */
  settle(): Promise<void>;
}

export interface MetersOptions {
  command?: MeterCommand;
  platform?: NodeJS.Platform;
  folder?: (folder: string) => Promise<number>;
  reader?: ProcReader;
  now?: () => number;
  /** The CPU time the app has used, in ms. */
  cpu?: () => number;
  /** False: only `tick` measures, as a test drives it. */
  interval?: boolean;
}

const appCpu = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** Past this, a read in flight leaves the disk unknown each tick (it isn't cancellable). */
const DISK_DEADLINE_MS = COMMAND_MS;

/** A run whose disk has stayed unknown for longer than this in a row is stopped. */
export const UNKNOWN_DISK_MS = 10_000;

/**
 * A run's next read of its open files begins no sooner than this many times its last read's cost
 * after that read began, the cost being the longer of its wall time and the CPU time the app used
 * meanwhile, on every thread: a read of 30 MB of maps took about 1.8 times its wall time in CPU. A
 * cost counts up to the read's 2 s deadline, so the wait is 8 s at most. While a read costs no
 * more, a run that makes its reads heavy keeps the app reading a quarter of the time and a quarter
 * of a core at most (#2351).
 */
export const READ_PACE = 4;

/**
 * Measures every program it watches each `WATCH_MS`, from one listing of the computer's processes
 * a tick, which judges resident memory before anything slower. Each run walks its folder and reads
 * the files its processes hold open with no name, each with one read in flight. A read that fails
 * stops that run at once (`disk-unmeasured`). One that is slow, past its 2 s deadline, leaves the
 * disk unknown for that turn while every limit keeps running on what was last read; a run whose
 * disk stays unknown for more than `UNKNOWN_DISK_MS` in a row is stopped. The clock is checked every
 * tick, so a read that never returns stops its run too. A run's next read waits on its last one's
 * cost (`READ_PACE`). On macOS one lsof reads every run's open files every other turn, and
 * each run reads its own when that fails; on Linux each reads `/proc`.
 */
export function createMeters(options: MetersOptions = {}): Meters {
  const command = options.command ?? runCommand;
  const platform = options.platform ?? process.platform;
  const sizeOf = options.folder ?? folderSize;
  const reader = options.reader ?? procReader;
  const now = options.now ?? Date.now;
  const cpu = options.cpu ?? appCpu;
  const watched = new Set<Watched>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let refining = false;
  let turn = 0;
  let held = new Map<number, number>();
  const pending = new Set<Promise<void>>();

  const schedule = (work: Promise<void>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  const reportAll = (programs: readonly Watched[], error: unknown) => {
    for (const each of programs) if (watched.has(each)) each.unmeasured(error);
  };

  const pidsOf = (each: Watched, listed: readonly ListedProcess[]) =>
    programPids(listed, [each.root, ...each.adoptedPids]);

  function walk(each: Watched) {
    each.walking = true;
    schedule(
      sizeOf(each.folder)
        .then(
          (bytes) => {
            each.named = bytes;
          },
          (error: unknown) => {
            if (watched.has(each)) each.unmeasured(error);
          },
        )
        .finally(() => {
          each.walking = false;
        }),
    );
  }

  function readEnded(each: Watched, startedAt: number) {
    const at = now();
    each.readingSince = null;
    const cost = Math.max(at - startedAt, cpu() - each.readingCpu);
    each.nextReadAt = startedAt + READ_PACE * Math.min(cost, DISK_DEADLINE_MS);
  }

  /** Records how a run's read of its open files ended; a failed one stops the run before it's told. */
  async function settleRead(
    each: Watched,
    pids: readonly number[],
    startedAt: number,
    read: () => Promise<{ files: UnlinkedFile[]; partial: boolean }>,
  ) {
    let result: { files: UnlinkedFile[]; partial: boolean };
    let device: number | undefined;
    try {
      device = await each.device;
      result = await read();
    } catch (error) {
      readEnded(each, startedAt);
      if (!watched.has(each)) return;
      if (error instanceof DiskTimeout) {
        each.ended = { ok: false, startedAt };
        return;
      }
      each.failed = true;
      each.unmeasured(error);
      return;
    }
    readEnded(each, startedAt);
    if (!watched.has(each)) return;
    const bytes = heldBytes(result.files, new Set(pids), device);
    each.unlinked = result.partial ? Math.max(each.unlinked, bytes) : bytes;
    each.ended = { ok: !result.partial, startedAt };
  }

  async function readShared(batch: readonly { each: Watched; pids: number[] }[], at: number) {
    let shared: UnlinkedFile[] | undefined;
    let failure: unknown;
    try {
      shared = await macUnlinked(command, [...new Set(batch.flatMap(({ pids }) => pids))]);
    } catch (error) {
      failure = error;
    }
    await Promise.all(
      batch.map(async ({ each, pids }) => {
        await settleRead(each, pids, at, async () => ({
          files: shared ?? (await macUnlinked(command, pids)),
          partial: false,
        }));
        // A run whose own read failed reported that; the others hear why they read their own.
        if (shared === undefined && !each.failed && watched.has(each)) {
          each.unmeasured(
            new Error("The open files of every run couldn't be read at once.", { cause: failure }),
          );
        }
      }),
    );
  }

  function verdict(each: Watched, at: number, unknownTurn: boolean): number | "unknown" {
    if (each.failed) return "unknown";
    const ended = each.ended;
    each.ended = null;
    if (ended?.ok) {
      // A read that began before the disk became unknown says nothing of it since.
      if (each.unknownSince === null || ended.startedAt >= each.unknownSince) {
        each.unknownSince = null;
      }
    } else if (ended) {
      each.unknownSince ??= ended.startedAt;
    }
    if (each.readingSince !== null && at - each.readingSince > DISK_DEADLINE_MS) {
      each.unknownSince ??= each.readingSince;
    }
    if (unknownTurn) each.unknownSince ??= at;
    if (each.unknownSince !== null && at - each.unknownSince > UNKNOWN_DISK_MS) return "unknown";
    return each.named + each.unlinked;
  }

  /** Reports each run's resident memory and folder, and starts the reads none has in flight. */
  function report(
    programs: readonly Watched[],
    listing: { listed: ListedProcess[]; listedAt: number } | null,
    unlinkedTurn: boolean,
  ) {
    const at = now();
    const batch: { each: Watched; pids: number[] }[] = [];
    for (const each of programs) {
      if (!watched.has(each)) continue;
      const pids = listing ? pidsOf(each, listing.listed) : [];
      if (listing) each.memory = memoryOf(listing.listed, pids, held);
      each.folderUse = verdict(each, at, listing === null);
      each.use({ memory: each.memory, folder: each.folderUse });
      if (each.folderUse === "unknown" || !watched.has(each)) continue;
      if (!each.walking) walk(each);
      if (listing && unlinkedTurn && each.readingSince === null && at >= each.nextReadAt) {
        each.readingSince = at;
        each.readingCpu = cpu();
        batch.push({ each, pids });
      }
    }
    if (listing === null || batch.length === 0) return;
    if (platform === "darwin") {
      schedule(readShared(batch, at));
      return;
    }
    for (const { each, pids } of batch) {
      schedule(settleRead(each, pids, at, () => procUnlinked(reader, pids, listing.listedAt)));
    }
  }

  /**
   * Tells each run's adopted processes and, on macOS on its turn, the footprints, then reports the
   * memory they add: apart from the tick, so no lookup holds back any run's resident memory.
   */
  async function refine(
    programs: readonly Watched[],
    listed: readonly ListedProcess[],
    footprintTurn: boolean,
  ) {
    const started = new Map<number, number | null>();
    for (const each of programs) {
      if (!each.adopted || !watched.has(each)) continue;
      try {
        each.adoptedPids = await each.adopted(each.root, listed, started);
      } catch (error) {
        each.unmeasured(error);
      }
    }
    if (platform === "darwin" && footprintTurn) {
      const all = [...new Set(programs.flatMap((each) => pidsOf(each, listed)))];
      try {
        held = await macFootprints(command, all);
      } catch (error) {
        held = new Map();
        reportAll(programs, error);
      }
    }
    for (const each of programs) {
      const memory = memoryOf(listed, pidsOf(each, listed), held);
      if (memory === each.memory || !watched.has(each)) continue;
      each.memory = memory;
      each.use({ memory, folder: each.folderUse });
    }
  }

  async function measure(programs: readonly Watched[]) {
    // macOS runs footprint and lsof, each a process of its own, on alternate turns.
    const footprintTurn = turn % 2 === 0;
    turn += 1;
    let listed: ListedProcess[];
    let listedAt = 0;
    try {
      listed = readListing(await command("ps", LISTING_ARGS));
      if (platform === "linux") listedAt = await reader.ticks();
    } catch (error) {
      report(programs, null, false);
      reportAll(programs, error);
      return;
    }
    report(programs, { listed, listedAt }, platform !== "darwin" || !footprintTurn);
    if (refining) return;
    refining = true;
    schedule(
      refine(programs, listed, footprintTurn).finally(() => {
        refining = false;
      }),
    );
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
      await Promise.allSettled([...pending]);
    },
    meter: (adopted) => ({
      watch(root, folder, use, unmeasured) {
        const each: Watched = {
          root,
          folder,
          adopted,
          use,
          unmeasured,
          adoptedPids: [],
          memory: 0,
          folderUse: 0,
          named: 0,
          unlinked: 0,
          walking: false,
          readingSince: null,
          readingCpu: 0,
          nextReadAt: Number.NEGATIVE_INFINITY,
          ended: null,
          failed: false,
          unknownSince: null,
          device: stat(folder).then(
            (info) => info.dev,
            () => undefined,
          ),
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
