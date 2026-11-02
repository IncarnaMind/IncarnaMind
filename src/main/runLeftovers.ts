/**
 * What a run in the OS sandbox leaves running outside its process group: a daemon, a process
 * that started a session of its own, a worker pool and its children. Each is found by what it
 * can't drop or fake, never by its name, command line or environment, which the code controls:
 * - macOS: its Seatbelt profile. `sandbox_check` says the process may write the run's working
 *   folder and may not write the folder above it, which is true only of a process carrying this
 *   run's profile (another run's may not write this folder; a process with no profile may write
 *   both).
 * - Linux: bubblewrap's PID namespace ends every process in it with the program; what is checked
 *   is that nothing of the program's process group is left.
 *
 * Only this User's processes that started while the run did are looked at, never the app or one
 * of its parents. Each one found is stopped (SIGSTOP), so none can fork while the rest are
 * found, then checked again by pid and start time and killed: a pid the system has given to
 * another process since is left alone. A run whose processes can't all be stopped is kept, and
 * new runs are refused until a later sweep ends them.
 *
 * Each run is recorded, outside anything the sandbox can write, until its sweep has ended
 * everything; at the next start the app sweeps the runs a crash left behind and removes their
 * folders.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { sandboxCheck } from "./sandboxCheck";

const execFileAsync = promisify(execFile);

/** One run, as the sweep and the record of it know it. */
export interface RunRecord {
  id: string;
  /** Its working folder: the one folder its profile lets it write. */
  folder: string;
  /** A folder its profile denies writing and no profile-less process is denied: its parent. */
  denied: string;
  /** When it started, in ms since the epoch. */
  startedMs: number;
  /** The app that started it: its pid and when that started, to tell it from a later one. */
  owner: { pid: number; startedMs: number };
}

interface Seen {
  pid: number;
  ppid: number;
  uid: number;
  startedMs: number;
  group: number;
}

/** ps gives a process's start to the second. */
const CLOCK_MS = 1000;

/** Stopping, finding what forked in between, and stopping again, at most this often. */
const ROUNDS = 6;

/** How often, and how far apart, a sweep looks again for processes it killed to be gone. */
const SETTLE_CHECKS = 20;
const SETTLE_MS = 100;

const C_LOCALE = { ...process.env, LC_ALL: "C" };

/** This User's processes and when each started; on Linux from /proc, elsewhere from ps. */
async function processes(): Promise<Seen[]> {
  if (process.platform === "linux") {
    const stat = await readFile("/proc/stat", "utf8");
    const bootMs = Number(/^btime (\d+)$/m.exec(stat)?.[1] ?? Number.NaN) * 1000;
    const seen: Seen[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      // Gone already: not this run's to stop.
      const fields = await readFile(`/proc/${name}/stat`, "utf8").catch(() => null);
      const owner = await lstat(`/proc/${name}`).catch(() => null);
      if (fields === null || owner === null) continue;
      // After the name in parentheses: state, ppid, pgrp, …; starttime is the 20th, in 1/100 s.
      const after = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      seen.push({
        pid: Number(name),
        ppid: Number(after[1]),
        uid: owner.uid,
        group: Number(after[2]),
        startedMs: bootMs + Number(after[19]) * 10,
      });
    }
    return seen;
  }
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid=,uid=,lstart="], {
    env: C_LOCALE,
    maxBuffer: 16 * 1024 * 1024,
  });
  const seen: Seen[] = [];
  for (const line of stdout.split("\n")) {
    const parts =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})$/.exec(
        line.trimEnd(),
      );
    if (!parts) continue;
    seen.push({
      pid: Number(parts[1]),
      ppid: Number(parts[2]),
      group: Number(parts[3]),
      uid: Number(parts[4]),
      startedMs: Date.parse(parts[5] ?? ""),
    });
  }
  return seen;
}

/** The app and every process above it, which a sweep never touches. */
function appAndParents(seen: readonly Seen[]): Set<number> {
  const parents = new Map(seen.map((each) => [each.pid, each.ppid]));
  const kept = new Set<number>();
  for (let pid = process.pid; pid > 1 && !kept.has(pid); pid = parents.get(pid) ?? 0) {
    kept.add(pid);
  }
  return kept;
}

/** Of `seen`, those of this User's that started while `run` did and could be its. */
function candidates(seen: readonly Seen[], run: RunRecord, endedMs: number): Seen[] {
  const kept = appAndParents(seen);
  const uid = process.getuid?.();
  return seen.filter(
    (each) =>
      each.uid === uid &&
      !kept.has(each.pid) &&
      each.startedMs >= run.startedMs - CLOCK_MS &&
      each.startedMs <= endedMs + CLOCK_MS,
  );
}

/** Which of `seen` carry `run`'s profile (macOS) or are in the program's group (Linux). */
async function members(seen: readonly Seen[], run: RunRecord, group: number): Promise<Seen[]> {
  if (process.platform === "linux") return seen.filter((each) => group > 0 && each.group === group);
  const answers = await sandboxCheck(
    seen.flatMap((each) => [
      { pid: each.pid, operation: "file-write-create" as const, value: run.folder },
      { pid: each.pid, operation: "file-write-create" as const, value: run.denied },
    ]),
  );
  return seen.filter((_, at) => answers[2 * at] === 0 && answers[2 * at + 1] === 1);
}

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    // Ended since it was seen.
    return false;
  }
};

/**
 * Stops every process of `run` (and, on Linux, of the program's process group `group`) still
 * running at `endedMs`. Resolves with the pids it couldn't stop: none when the run is over.
 */
export async function sweepRun(run: RunRecord, group: number, endedMs: number): Promise<number[]> {
  const stopped = new Map<number, number>();
  for (let round = 0; round < ROUNDS; round++) {
    const found = (await members(candidates(await processes(), run, endedMs), run, group)).filter(
      (each) => !stopped.has(each.pid),
    );
    if (found.length === 0) break;
    for (const each of found) {
      if (signal(each.pid, "SIGSTOP")) stopped.set(each.pid, each.startedMs);
    }
  }
  if (stopped.size > 0) {
    const now = new Map((await processes()).map((each) => [each.pid, each.startedMs]));
    for (const [pid, startedMs] of stopped) {
      if (now.get(pid) === startedMs) signal(pid, "SIGKILL");
    }
  }
  // SIGKILL ends a process soon after, not at once: wait for that, a bounded while.
  let left: Seen[] = [];
  for (let wait = 0; wait < SETTLE_CHECKS; wait++) {
    left = await members(candidates(await processes(), run, Date.now()), run, group);
    if (left.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
  return left.map((each) => each.pid);
}

/** Where runs are recorded until their sweep is done: a folder of this User's own. */
async function recordsFolder(): Promise<string> {
  const folder = join(tmpdir(), `incarnamind-runs-${process.getuid?.() ?? 0}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`${folder} isn't a private folder of this User's.`);
  }
  return folder;
}

/** When this app process started, as `processes` reads every start. */
async function ownStart(): Promise<number> {
  const self = (await processes()).find((each) => each.pid === process.pid);
  if (!self) throw new Error("This app's own process isn't listed.");
  return self.startedMs;
}

/** The folder a run's leftovers live in: the code run's own (around work/), or the script's. */
function runFolder(folder: string): string | null {
  if (basename(dirname(folder)).startsWith("incarnamind-code-")) return dirname(folder);
  if (basename(folder).startsWith("incarnamind-script-")) return folder;
  return null;
}

export interface RunSweeper {
  /** Records a run before its program starts; `sweep` ends what it leaves. */
  begin(folder: string, denied: string): Promise<(group: number) => Promise<void>>;
  /** Why no run may start now: a process of an earlier one that couldn't be stopped. */
  stuck(): Promise<string | null>;
}

/**
 * Sweeps runs, and at its creation the runs a crash of an earlier app left behind. `report`
 * hears every failure; nothing here throws into a run.
 */
export function createRunSweeper(report: (error: unknown) => void): RunSweeper {
  const stuck = new Map<string, { run: RunRecord; group: number }>();
  const owner = ownStart().then(
    (startedMs) => ({ pid: process.pid, startedMs }),
    (error: unknown) => {
      report(error);
      return { pid: process.pid, startedMs: 0 };
    },
  );

  async function sweepAndForget(run: RunRecord, group: number): Promise<void> {
    let left: number[];
    try {
      left = await sweepRun(run, group, Date.now());
    } catch (error) {
      // Not known to be over, so it is treated as still running.
      stuck.set(run.id, { run, group });
      throw error;
    }
    if (left.length > 0) {
      stuck.set(run.id, { run, group });
      throw new Error(
        `${left.length} process(es) of an earlier run (${left.join(", ")}) couldn't be stopped.`,
      );
    }
    stuck.delete(run.id);
    await rm(join(await recordsFolder(), `${run.id}.json`), { force: true });
  }

  // Runs a crash left: their app is gone (or its pid is another process's now).
  const stale = (async () => {
    const folder = await recordsFolder();
    const alive = new Map((await processes()).map((each) => [each.pid, each.startedMs]));
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const run = JSON.parse(await readFile(join(folder, name), "utf8")) as RunRecord;
      if (alive.get(run.owner.pid) === run.owner.startedMs) continue;
      const exists = await lstat(run.folder).then(
        () => true,
        () => false,
      );
      if (exists) await sweepAndForget(run, 0);
      else await rm(join(folder, name), { force: true });
      const leftover = runFolder(run.folder);
      if (leftover) await rm(leftover, { recursive: true, force: true });
    }
  })().catch(report);

  return {
    async begin(folder, denied) {
      await stale;
      const run: RunRecord = {
        id: randomUUID(),
        folder,
        denied,
        startedMs: Date.now(),
        owner: await owner,
      };
      await writeFile(join(await recordsFolder(), `${run.id}.json`), JSON.stringify(run), {
        mode: 0o600,
      });
      return (group) => sweepAndForget(run, group).catch(report);
    },
    async stuck() {
      await stale;
      for (const { run, group } of [...stuck.values()]) {
        await sweepAndForget(run, group).catch(report);
      }
      const left = [...stuck.values()];
      return left.length === 0
        ? null
        : "A program from an earlier run is still running and couldn't be stopped, so no new one starts. Quitting and reopening IncarnaMind tries again.";
    },
  };
}
