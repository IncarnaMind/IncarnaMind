/**
 * What a run in the OS sandbox leaves running outside its process group: a daemon, a process
 * that started a session of its own, a worker pool and its children. An earlier sweep told a
 * run's processes by "may write the run's folder, may not write the one above", which another
 * program's sandbox answered too, and stopped that program's commands. So a process is the
 * run's only by what nothing else can carry, never by its name, command line or environment,
 * which the code controls:
 * - macOS: its Seatbelt profile, which a process can't drop or change. Each run's profile allows
 *   looking up a Mach service name made from a fresh id (`runServiceName`, which nothing
 *   serves) and no other name. A process is the run's only when `sandbox_check` says it may look
 *   that name up, may not look up a name beside it (a profile that allows every name, or every
 *   name of ours, may), and may not look up LaunchServices (a process with no profile may); and
 *   it is this User's, started no earlier than the run, and not the app or one of its parents.
 *   Nothing is asked of the run's folder: the run can remove it, and would then be no one's.
 * - Linux: bubblewrap's PID namespace ends every process in it when the program's sandbox ends,
 *   so nothing is signalled; the sweep only checks that nothing of the program's group is left.
 *
 * Finding (`classify`) and stopping (`sweepRun`) are apart, and the stopper is passed in, so a
 * test lists every process of the computer and what it would do to each before any signal.
 * What is found is stopped (SIGSTOP), so none can fork while the rest are found; then every
 * member found again is killed. A run whose processes can't all be stopped is kept, and new runs
 * are refused until a later sweep ends them.
 *
 * Each run is recorded, outside anything the sandbox can write, until its sweep has ended
 * everything; at the next start the app sweeps the runs a crash left behind and removes their
 * folders.
 */
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { COMMAND_MS, type ListedProcess, runCommand } from "./programMeter";
import { type SandboxQuestion, sandboxCheck } from "./sandboxCheck";

const execFileAsync = promisify(execFile);

/** The Mach service name only the profile of run `id` may look up. */
export const runServiceName = (id: string) => `com.incarnamind.run.${id}`;

/** A name beside it that no run's profile allows, and a profile allowing names broadly does. */
const unlistedServiceName = (id: string) => `${runServiceName(id)}.unlisted`;

/** Denied by every run's profile (./sandbox `MAC_DENIED`), allowed to a process with none. */
const LAUNCH_SERVICES = "com.apple.coreservices.launchservicesd";

/**
 * Whether a sweep may signal `pid` at all: never 1 or less, which `kill` reads as init, the
 * caller's own group or every process it may signal, and never the app itself.
 */
export const signallable = (pid: number, app: number): boolean =>
  Number.isSafeInteger(pid) && pid > 1 && pid !== app;

/** One run, as the sweep and the record of it know it. */
export interface RunRecord {
  /** The run's own: its profile's service name is made from it. */
  id: string;
  /** Its working folder, removed with the run's own after a crash. */
  folder: string;
  /** When it started, in ms since the epoch. */
  startedMs: number;
  /** The app that started it: its pid and when that started, to tell it from a later one. */
  owner: { pid: number; startedMs: number };
}

/** A process as the system lists it. `command` is for the dry run's report only. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  group: number;
  startedMs: number;
  command: string;
}

export type Verdict =
  | "member"
  | "not a process to signal"
  | "another user's"
  | "the app or a parent of it"
  | "started before the run"
  | "not in the program's group"
  | "not this run's profile";

export interface Classified {
  pid: number;
  startedMs: number;
  command: string;
  verdict: Verdict;
  /** macOS: sandbox_check's answers, in `questionsFor`'s order (0 allowed, 1 denied, -1 failed). */
  answers?: number[];
}

/** Where the sweep runs, as `classify` needs to know it. */
export interface SweepContext {
  platform: NodeJS.Platform;
  /** This User's id. */
  uid: number;
  /** The app's pid: it and every process above it are never signalled. */
  app: number;
  /** The program's process group (its pid), 0 when it never started. */
  group: number;
}

export type ProfileCheck = (
  questions: readonly SandboxQuestion[],
  options?: { timeoutMs?: number },
) => Promise<number[]>;

/** The answers only a process carrying `run`'s profile gives, to `questionsFor`. */
const MEMBER_ANSWERS = [0, 1, 1];

function questionsFor(pid: number, run: RunRecord): SandboxQuestion[] {
  return [
    { pid, operation: "mach-lookup", value: runServiceName(run.id) },
    { pid, operation: "mach-lookup", value: unlistedServiceName(run.id) },
    { pid, operation: "mach-lookup", value: LAUNCH_SERVICES },
  ];
}

/** ps gives a process's start to the second. */
const CLOCK_MS = 1000;

/** The app and every process above it. */
function appAndParents(rows: readonly ProcessRow[], app: number): Set<number> {
  const parents = new Map(rows.map((each) => [each.pid, each.ppid]));
  const kept = new Set<number>();
  for (let pid = app; pid > 1 && !kept.has(pid); pid = parents.get(pid) ?? 0) kept.add(pid);
  return kept;
}

/**
 * What a sweep of `run` makes of each process in `rows`: only a "member" may be signalled.
 * Nothing here signals; on macOS, `check` is asked about the processes the cheaper tests leave.
 */
export async function classify(
  rows: readonly ProcessRow[],
  run: RunRecord,
  context: SweepContext,
  check: ProfileCheck,
): Promise<Classified[]> {
  const kept = appAndParents(rows, context.app);
  const startedSecond = Math.floor(run.startedMs / CLOCK_MS) * CLOCK_MS;
  const classified: Classified[] = rows.map((row) => {
    const verdict = ((): Verdict | undefined => {
      if (!signallable(row.pid, context.app)) {
        return row.pid === context.app ? "the app or a parent of it" : "not a process to signal";
      }
      if (row.uid !== context.uid) return "another user's";
      if (kept.has(row.pid)) return "the app or a parent of it";
      if (!(row.startedMs >= startedSecond)) return "started before the run";
      if (context.platform === "linux" && (context.group <= 1 || row.group !== context.group)) {
        return "not in the program's group";
      }
      return undefined;
    })();
    return {
      pid: row.pid,
      startedMs: row.startedMs,
      command: row.command,
      verdict: verdict ?? "member",
    };
  });
  if (context.platform !== "darwin") return classified;
  const asked = classified.filter((each) => each.verdict === "member");
  const answers = await check(asked.flatMap((each) => questionsFor(each.pid, run)));
  if (answers.length !== asked.length * MEMBER_ANSWERS.length) {
    throw new Error(`sandbox_check gave ${answers.length} answers to ${asked.length} processes.`);
  }
  asked.forEach((each, at) => {
    const own = answers.slice(at * MEMBER_ANSWERS.length, (at + 1) * MEMBER_ANSWERS.length);
    each.answers = own;
    if (own.some((answer, index) => answer !== MEMBER_ANSWERS[index])) {
      each.verdict = "not this run's profile";
    }
  });
  return classified;
}

const C_LOCALE = { ...process.env, LC_ALL: "C" };

/**
 * A process from its line in Linux's /proc/<pid>/stat; null for a zombie, which has ended and
 * waits only for its parent to reap it, which no signal hastens.
 */
export function procRow(
  pid: number,
  fields: string,
  uid: number,
  bootMs: number,
): ProcessRow | null {
  // After the name in parentheses: state, ppid, pgrp, …; starttime is the 20th, in 1/100 s.
  const after = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
  if (after[0] === "Z") return null;
  return {
    pid,
    ppid: Number(after[1]),
    uid,
    group: Number(after[2]),
    startedMs: bootMs + Number(after[19]) * 10,
    command: fields.slice(fields.indexOf("(") + 1, fields.lastIndexOf(")")),
  };
}

/** How ps prints when a process started, in the C locale. */
const PS_START = String.raw`\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}`;
const PS_ROW = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(${PS_START}) (.*)$`);
const PS_STARTED = new RegExp(String.raw`^\s*(\d+)\s+(${PS_START})\s*$`);

/** Every process of the computer and when each started; on Linux from /proc, elsewhere from ps. */
export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === "linux") {
    const stat = await readFile("/proc/stat", "utf8");
    const bootMs = Number(/^btime (\d+)$/m.exec(stat)?.[1] ?? Number.NaN) * 1000;
    const rows: ProcessRow[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      // Gone already: not this run's to stop.
      const fields = await readFile(`/proc/${name}/stat`, "utf8").catch(() => null);
      const owner = await lstat(`/proc/${name}`).catch(() => null);
      if (fields === null || owner === null) continue;
      const row = procRow(Number(name), fields, owner.uid, bootMs);
      if (row) rows.push(row);
    }
    return rows;
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid=,uid=,lstart=,comm="],
    { env: C_LOCALE, maxBuffer: 16 * 1024 * 1024 },
  );
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const parts = PS_ROW.exec(line.trimEnd());
    if (!parts) continue;
    rows.push({
      pid: Number(parts[1]),
      ppid: Number(parts[2]),
      group: Number(parts[3]),
      uid: Number(parts[4]),
      startedMs: Date.parse(parts[5] ?? ""),
      command: (parts[6] ?? "").trim(),
    });
  }
  return rows;
}

/** Sends `signal` to one pid; false when it has gone. */
export type Stopper = (
  pid: number,
  signal: "SIGSTOP" | "SIGKILL" | "SIGCONT",
) => boolean | Promise<boolean>;

/** When each of `pids` started, from ps; one that has ended is left out. */
export async function startTimes(pids: readonly number[]): Promise<Map<number, number>> {
  const started = new Map<number, number>();
  if (pids.length === 0) return started;
  const stdout = await runCommand("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]).catch(
    (error: { code?: unknown; stdout?: unknown }) => {
      // ps's exit status when a pid it was given has ended.
      if (error.code === 1 && typeof error.stdout === "string") return error.stdout;
      throw error;
    },
  );
  for (const line of stdout.split("\n")) {
    const parts = PS_STARTED.exec(line);
    if (parts) started.set(Number(parts[1]), Date.parse(parts[2] ?? ""));
  }
  return started;
}

/** The stopper the app uses. */
export const killProcess: Stopper = (pid, signal) => {
  if (!signallable(pid, process.pid)) {
    throw new Error(`The sweep was asked to signal ${pid}, which it never does.`);
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    // Ended since it was listed; anything else (EPERM) is not known to have stopped it.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

/** Told of each signal a sweep sends: its pid, the signal and why, never a command or text. */
export type SignalLog = (fields: { pid: number; signal: string; reason: string }) => void;

/** What a sweep reads the computer with and signals through: the real ones, or a test's. */
export interface SweepDeps {
  list(): Promise<ProcessRow[]>;
  /** When each of these processes started (`startTimes`). */
  started(pids: readonly number[]): Promise<Map<number, number>>;
  check: ProfileCheck;
  stopper: Stopper;
  log: SignalLog;
  platform: NodeJS.Platform;
  uid: number;
  app: number;
}

/** Stopping, finding what forked in between, and stopping again, at most this often. */
const ROUNDS = 6;

/** How often, and how far apart, a sweep looks again for processes it killed to be gone. */
const SETTLE_CHECKS = 20;
const SETTLE_MS = 100;

async function members(run: RunRecord, group: number, deps: SweepDeps): Promise<Classified[]> {
  const context = { platform: deps.platform, uid: deps.uid, app: deps.app, group };
  const classified = await classify(await deps.list(), run, context, deps.check);
  return classified.filter((each) => each.verdict === "member");
}

/**
 * Stops every process of `run` still running; `group` is its program's process group. Every
 * signal goes to a member the same step found: each is stopped, so none can fork; once no new
 * one turns up, every member found again is killed. On Linux nothing is signalled. Resolves
 * with the pids still running after a bounded wait: none when the run is over.
 */
export async function sweepRun(run: RunRecord, group: number, deps: SweepDeps): Promise<number[]> {
  if (deps.platform === "darwin") {
    const stopped = new Set<string>();
    const key = (each: Classified) => `${each.pid}@${each.startedMs}`;
    for (let round = 0; round < ROUNDS; round++) {
      const found = (await members(run, group, deps)).filter((each) => !stopped.has(key(each)));
      if (found.length === 0) break;
      for (const each of found) {
        deps.log({ pid: each.pid, signal: "SIGSTOP", reason: "run's profile" });
        if (await deps.stopper(each.pid, "SIGSTOP")) stopped.add(key(each));
      }
    }
    const again = await members(run, group, deps);
    for (const each of again) {
      deps.log({ pid: each.pid, signal: "SIGKILL", reason: "run's profile, found again" });
      await deps.stopper(each.pid, "SIGKILL");
    }
    // A member can end between its listing and its SIGSTOP, and its pid go to another process:
    // one this sweep stopped that isn't found again is let go on.
    const killed = new Set(again.map(key));
    for (const stoppedKey of stopped) {
      if (killed.has(stoppedKey)) continue;
      const pid = Number(stoppedKey.split("@")[0]);
      deps.log({ pid, signal: "SIGCONT", reason: "stopped, not found again" });
      await deps.stopper(pid, "SIGCONT");
    }
  }
  // SIGKILL ends a process soon after, not at once: wait for that, a bounded while.
  let left: Classified[] = [];
  for (let wait = 0; wait < SETTLE_CHECKS; wait++) {
    left = await members(run, group, deps);
    if (left.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
  return left.map((each) => each.pid);
}

/**
 * The run's processes launchd took over when their parents ended (a daemon), which the program's
 * tree no longer holds, from a tick's listing: each of this User's orphans is asked once, as the
 * sweep asks of a member, and `known` keeps an answer sandbox_check gave in full. `started` is a
 * start time belongs to a pid, not a run, so it is read once a tick and reused across runs. On
 * Linux none: bubblewrap's PID namespace keeps them under the program.
 */
export async function adoptedMembers(
  run: RunRecord,
  group: number,
  listed: readonly ListedProcess[],
  deps: Pick<SweepDeps, "started" | "check" | "platform" | "uid" | "app">,
  known: Map<number, boolean>,
  started: Map<number, number | null> = new Map(),
): Promise<number[]> {
  if (deps.platform !== "darwin") return [];
  // A pid goes to another process only once the system has been through all the others, never
  // between two listings a tick apart: one gone from this listing is forgotten.
  const present = new Set(listed.map((each) => each.pid));
  for (const pid of known.keys()) if (!present.has(pid)) known.delete(pid);
  const orphans = listed.filter((each) => each.ppid === 1 && each.uid === deps.uid);
  const unasked = orphans.filter((each) => !known.has(each.pid));
  if (unasked.length > 0) {
    const toRead = unasked.filter((each) => !started.has(each.pid)).map((each) => each.pid);
    if (toRead.length > 0) {
      const read = await deps.started(toRead);
      for (const pid of toRead) started.set(pid, read.get(pid) ?? null);
    }
    const rows = unasked.flatMap((each) => {
      const startedMs = started.get(each.pid);
      return startedMs === undefined || startedMs === null
        ? []
        : [{ ...each, startedMs, command: "" }];
    });
    const context = { platform: deps.platform, uid: deps.uid, app: deps.app, group };
    const check: ProfileCheck = (questions) => deps.check(questions, { timeoutMs: COMMAND_MS });
    for (const each of await classify(rows, run, context, check)) {
      if (each.answers?.some((answer) => answer !== 0 && answer !== 1)) continue;
      known.set(each.pid, each.verdict === "member");
    }
  }
  return orphans.filter((each) => known.get(each.pid) === true).map((each) => each.pid);
}

/** Where runs are recorded until their sweep is done: a folder of this User's own. */
async function recordsFolder(folder: string): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`${folder} isn't a private folder of this User's.`);
  }
  return folder;
}

/** The folder a run's leftovers live in: the code run's own (around work/), or the script's. */
function runFolder(folder: string): string | null {
  if (basename(dirname(folder)).startsWith("incarnamind-code-")) return dirname(folder);
  if (basename(folder).startsWith("incarnamind-script-")) return folder;
  return null;
}

/** A run as its sweeper knows it once recorded. */
export interface SweptRun {
  /** Stops what the run left; never rejects. */
  sweep(group: number): Promise<void>;
  /** Its processes launchd adopted, from a tick's listing (`adoptedMembers`). */
  adopted(
    group: number,
    listed: readonly ListedProcess[],
    started: Map<number, number | null>,
  ): Promise<number[]>;
}

export interface RunSweeper {
  /** Records run `id` before its program starts. */
  begin(id: string, folder: string): Promise<SweptRun>;
  /** Why no run may start now: a process of an earlier one that couldn't be stopped. */
  stuck(): Promise<string | null>;
}

export interface RunSweeperOptions {
  /** Hears every failure; nothing here throws into a run. */
  report(error: unknown): void;
  log?: SignalLog;
  /** `killProcess` unless a test passes one that records instead. */
  stopper?: Stopper;
  /** Where runs are recorded. */
  records: string;
  /** A test's listing, profile check and system; this computer's otherwise. */
  computer?: Pick<SweepDeps, "list" | "check" | "platform"> & Partial<Pick<SweepDeps, "started">>;
}

/** A record as `begin` writes it; anything else in the folder is no run's. */
function readRecord(text: string): RunRecord | null {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null) return null;
  const { id, folder, startedMs, owner } = read as Record<string, unknown>;
  const { pid, startedMs: ownerStarted } = (owner ?? {}) as Record<string, unknown>;
  return typeof id === "string" &&
    /^[0-9a-f-]{36}$/.test(id) &&
    typeof folder === "string" &&
    typeof startedMs === "number" &&
    typeof pid === "number" &&
    typeof ownerStarted === "number"
    ? { id, folder, startedMs, owner: { pid, startedMs: ownerStarted } }
    : null;
}

/** Sweeps runs, and at its creation the runs a crash of an earlier app left behind. */
export function createRunSweeper(options: RunSweeperOptions): RunSweeper {
  const { report } = options;
  const uid = process.getuid?.();
  const deps: SweepDeps = {
    list: options.computer?.list ?? listProcesses,
    started: options.computer?.started ?? startTimes,
    check: options.computer?.check ?? sandboxCheck,
    stopper: options.stopper ?? killProcess,
    log: options.log ?? (() => {}),
    platform: options.computer?.platform ?? process.platform,
    uid: uid ?? -1,
    app: process.pid,
  };
  const records = recordsFolder(options.records);
  const stuck = new Map<string, { run: RunRecord; group: number }>();
  const owner = deps
    .list()
    .then((rows) => {
      const self = rows.find((each) => each.pid === process.pid);
      if (!self) throw new Error("This app's own process isn't listed.");
      return { pid: process.pid, startedMs: self.startedMs };
    })
    .catch((error: unknown) => {
      report(error);
      return null;
    });

  const recordOf = async (run: RunRecord) => join(await records, `${run.id}.json`);

  async function sweepAndForget(run: RunRecord, group: number): Promise<void> {
    let left: number[];
    try {
      left = await sweepRun(run, group, deps);
    } catch (error) {
      // Not known to be over, so it is treated as still running, and kept for the next start.
      stuck.set(run.id, { run, group });
      await writeFile(await recordOf(run), JSON.stringify(run), { mode: 0o600 });
      throw error;
    }
    if (left.length > 0) {
      stuck.set(run.id, { run, group });
      await writeFile(await recordOf(run), JSON.stringify(run), { mode: 0o600 });
      throw new Error(
        `${left.length} process(es) of an earlier run (${left.join(", ")}) couldn't be stopped.`,
      );
    }
    stuck.delete(run.id);
    await rm(await recordOf(run), { force: true });
  }

  // Runs a crash left: their app is gone (or its pid is another process's now). Each is swept
  // on its own, so one that can't be read or stopped leaves the others to be.
  const stale = (async () => {
    const folder = await records;
    const alive = new Map((await deps.list()).map((each) => [each.pid, each.startedMs]));
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = readRecord(await readFile(join(folder, name), "utf8"));
        if (run === null) {
          await rm(join(folder, name), { force: true });
          throw new Error(`${name} in ${folder} wasn't a run's record, so it was removed.`);
        }
        if (alive.get(run.owner.pid) === run.owner.startedMs) continue;
        await sweepAndForget(run, 0);
        const leftover = runFolder(run.folder);
        if (leftover) await rm(leftover, { recursive: true, force: true });
      } catch (error) {
        report(error);
      }
    }
  })().catch(report);

  return {
    async begin(id, folder) {
      await stale;
      const app = await owner;
      if (uid === undefined || app === null) {
        throw new Error(
          "The app's own process can't be told apart, so no run's leftovers could be found.",
        );
      }
      const run: RunRecord = { id, folder, startedMs: Date.now(), owner: app };
      await writeFile(join(await records, `${run.id}.json`), JSON.stringify(run), {
        mode: 0o600,
      });
      const known = new Map<number, boolean>();
      return {
        sweep: (group) => sweepAndForget(run, group).catch(report),
        adopted: (group, listed, started) =>
          adoptedMembers(run, group, listed, deps, known, started),
      };
    },
    async stuck() {
      await stale;
      for (const { run, group } of [...stuck.values()]) {
        await sweepAndForget(run, group).catch(report);
      }
      return stuck.size === 0
        ? null
        : "A process of an earlier run in the sandbox couldn't be stopped, so no new program runs here until IncarnaMind is restarted.";
    },
  };
}
