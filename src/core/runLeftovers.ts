/**
 * What a program run leaves running outside its process group: a process that started a session
 * of its own (a daemon, a worker pool), and its children. The OS sandbox on Linux ends them with
 * its PID namespace; on macOS, and with no sandbox, nothing else does. A process is the run's when
 * it started while the run did and it carries the run's marker in its environment, works inside
 * the run's own folder, or (on Linux) is in the session the program leads. The folder is there
 * because macOS doesn't show other processes the environment of its own system programs (bash,
 * sleep, perl). Each process is checked again, start time included, right before it is stopped,
 * so a pid the system gave to another process since is left alone, as is the app itself.
 * A process that clears its environment and leaves the folder and the session escapes this; it
 * stays confined by the sandbox and can write nowhere once the run's folder is removed.
 */
import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

/** The variable every process of a run carries: its value is the run's own. */
export const RUN_VARIABLE = "INCARNAMIND_RUN";

/** What tells a run's processes from every other. */
export interface RunIdentity {
  marker: string;
  /** The run's own working folder, as the system resolves it (no links). */
  folder: string;
  /** When the run started, in ms since the epoch. */
  startedMs: number;
  /** The session the program leads, once started (its pid). */
  session?: number;
}

interface Seen {
  pid: number;
  startedMs: number;
  marked: boolean;
  /** Its working folder, where known. */
  cwd: string | null;
  /** Its session, where the system shows it (Linux; macOS's ps doesn't). */
  session: number | null;
}

/** macOS gives a process's start to the second, Linux's boot time too. */
const CLOCK_MS = 1000;

/** A process that keeps forking is followed for this many rounds. */
const ROUNDS = 3;

const execFileAsync = promisify(execFile);

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

function belongs(seen: Seen, run: RunIdentity, endedMs: number): boolean {
  if (seen.pid === process.pid || seen.pid === process.ppid) return false;
  if (seen.startedMs < run.startedMs - CLOCK_MS || seen.startedMs > endedMs + CLOCK_MS) {
    return false;
  }
  return (
    seen.marked ||
    (seen.cwd !== null && inside(seen.cwd, run.folder)) ||
    (run.session !== undefined && seen.session === run.session)
  );
}

/** Linux: every process of this User's, from /proc (another User's environment can't be read). */
async function linuxProcesses(marker: string, only?: number): Promise<Seen[]> {
  const stat = await readFile("/proc/stat", "utf8");
  const bootMs = Number(/^btime (\d+)$/m.exec(stat)?.[1] ?? Number.NaN) * 1000;
  const names = only === undefined ? await readdir("/proc") : [String(only)];
  const seen: Seen[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    // Gone already, or another User's: either way not this run's.
    const environ = await readFile(`/proc/${name}/environ`, "utf8").catch(() => null);
    const fields = await readFile(`/proc/${name}/stat`, "utf8").catch(() => null);
    if (environ === null || fields === null) continue;
    // After the name in parentheses come state, ppid, pgrp, session, …: starttime is the 20th,
    // in ticks of 1/100 s (USER_HZ).
    const after = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
    seen.push({
      pid: Number(name),
      startedMs: bootMs + Number(after[19]) * 10,
      marked: environ.split("\0").includes(`${RUN_VARIABLE}=${marker}`),
      cwd: await readlink(`/proc/${name}/cwd`).catch(() => null),
      session: Number(after[3]),
    });
  }
  return seen;
}

const C_LOCALE = { ...process.env, LC_ALL: "C" };

/** macOS: this User's processes, from ps (start and environment) and lsof (working folder). */
async function macProcesses(marker: string, only?: number): Promise<Seen[]> {
  const which = only === undefined ? ["-A"] : ["-p", String(only)];
  const { stdout: listing } = await execFileAsync(
    "ps",
    [...which, "-E", "-ww", "-o", "pid=,lstart=,command="],
    { env: C_LOCALE, maxBuffer: 64 * 1024 * 1024 },
  ).catch((error: { code?: number; stdout?: string }) => {
    // ps exits 1 when the one pid asked for is gone.
    if (only !== undefined && error.code === 1) return { stdout: "" };
    throw error;
  });
  const uid = process.getuid?.();
  const { stdout: folders } = await execFileAsync(
    "lsof",
    [
      "-a",
      "-d",
      "cwd",
      ...(only === undefined ? ["-u", String(uid)] : ["-p", String(only)]),
      "-Fpn",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  ).catch((error: { code?: number; stdout?: string }) => {
    // lsof exits 1 when it finds nothing, and prints what it could read of the rest.
    if (error.code === 1) return { stdout: error.stdout ?? "" };
    throw error;
  });
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of folders.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) cwds.set(pid, line.slice(1));
  }
  const entry = `${RUN_VARIABLE}=${marker}`;
  const seen: Seen[] = [];
  for (const line of listing.split("\n")) {
    const parts = /^\s*(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    if (!parts) continue;
    const found = Number(parts[1]);
    seen.push({
      pid: found,
      startedMs: Date.parse(parts[2] ?? ""),
      marked: (parts[3] ?? "").split(" ").includes(entry),
      cwd: cwds.get(found) ?? null,
      session: null,
    });
  }
  return seen;
}

function processes(marker: string, only?: number): Promise<Seen[]> {
  if (process.platform === "linux") return linuxProcesses(marker, only);
  if (process.platform === "darwin") return macProcesses(marker, only);
  return Promise.resolve([]);
}

/**
 * Stops, with SIGKILL, every process of `run` still running when it ended at `endedMs`. Returns
 * the pids it stopped. Windows has no sweep: its Job Object will hold the run's processes.
 */
export async function stopLeftovers(run: RunIdentity, endedMs: number): Promise<number[]> {
  const stopped: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const found = (await processes(run.marker)).filter((seen) => belongs(seen, run, endedMs));
    if (found.length === 0) break;
    for (const { pid, startedMs } of found) {
      const [again] = await processes(run.marker, pid);
      if (!again || again.startedMs !== startedMs || !belongs(again, run, endedMs)) continue;
      try {
        process.kill(pid, "SIGKILL");
        stopped.push(pid);
      } catch {
        // Ended between the check and the signal.
      }
    }
  }
  return stopped;
}
