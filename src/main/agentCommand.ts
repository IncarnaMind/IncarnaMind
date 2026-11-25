/**
 * What every run of the User's own command-line AI shares (ADR-0032), Claude Code's and Codex's
 * alike: finding its command as a terminal would, asking it a short question by its exit code, and
 * reading the stream of JSON lines a run prints, bounded in size and in silence, stopped with every
 * process it started.
 */
import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { stopProcessTree } from "../core/execution";
import { pathFolders } from "./agentPlaces";
import { createLoginShellProcesses } from "./processes";

export const processes = createLoginShellProcesses();

/** How long a short command (its version, its sign-in) may take before it counts as no answer. */
const SHORT_MS = 15_000;

/** How long a stopped command's output may take to close before IncarnaMind stops reading it. */
const STOP_WAIT_MS = 5_000;

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Whether version `found` is older than `lowest`, both as major.minor.patch. */
export const older = (found: string, lowest: string): boolean => {
  const [a, b] = [found, lowest].map((each) => each.split(".").map(Number));
  for (let at = 0; at < 3; at++) {
    const one = a?.[at] ?? 0;
    const two = b?.[at] ?? 0;
    if (one !== two) return one < two;
  }
  return false;
};

export type Short =
  /** `out`: the start of what it printed on both streams; `stdout`: its output alone, whole. */
  | { kind: "exited"; code: number | null; out: string; stdout: string }
  /** The command isn't there. */
  | { kind: "absent" }
  /** It couldn't be started for another reason, or took too long: it says nothing. */
  | { kind: "no-answer" };

/** As much of a short command's output as is read: a model catalog runs to about a megabyte. */
const MAX_SHORT_OUTPUT = 16 * 1024 * 1024;

/**
 * A short command's exit code and what it printed. `env`: variables of its own on top of the login
 * shell's; `cwd`: the folder it runs in; `signal`: stops it, and then it gave no answer.
 */
export async function short(
  command: string,
  args: string[],
  { env, cwd, signal }: { env?: Record<string, string>; cwd?: string; signal?: AbortSignal } = {},
): Promise<Short> {
  if (signal?.aborted) return { kind: "no-answer" };
  let child: Awaited<ReturnType<typeof processes.spawn>>;
  try {
    child = await processes.spawn(command, args, {
      processGroup: true,
      ...(env && { env }),
      ...(cwd && { cwd }),
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") console.warn(`Could not start ${command} ${args.join(" ")} (${code}).`);
    return code === "ENOENT" ? { kind: "absent" } : { kind: "no-answer" };
  }
  let out = "";
  const stdout: Buffer[] = [];
  let kept = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString("utf8");
    });
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    kept += chunk.length;
    if (kept <= MAX_SHORT_OUTPUT) stdout.push(chunk);
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), SHORT_MS);
    onAbort = () => resolve("late");
    signal?.addEventListener("abort", onAbort, { once: true });
    // Stopped while it was starting, before the listener was there.
    if (signal?.aborted) resolve("late");
  });
  const code = await Promise.race([closed, deadline]);
  clearTimeout(timer);
  if (onAbort) signal?.removeEventListener("abort", onAbort);
  if (code !== "late") {
    return {
      kind: "exited",
      code,
      out: out.slice(0, 4096),
      stdout: kept <= MAX_SHORT_OUTPUT ? Buffer.concat(stdout).toString("utf8") : "",
    };
  }
  stopProcessTree(child);
  await drained(child, closed, command);
  return { kind: "no-answer" };
}

/** A file the User's account may run. */
const runnable = async (path: string) =>
  (await stat(path).catch(() => null))?.isFile() === true &&
  (await access(path, constants.X_OK).then(
    () => true,
    () => false,
  ));

/**
 * Where the login shell's PATH holds `command`, as a terminal would find it, looked up without
 * starting it; null where it doesn't.
 */
export async function findOnPath(command: string): Promise<string | null> {
  if (isAbsolute(command)) return (await runnable(command)) ? command : null;
  const environment = await processes.environment();
  const value = (name: string) =>
    Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1] ?? "";
  const names =
    process.platform === "win32"
      ? (value("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => `${command}${ext}`)
      : [command];
  for (const folder of pathFolders(environment)) {
    for (const name of names) {
      const path = join(folder, name);
      if (await runnable(path)) return path;
    }
  }
  return null;
}

/** The file a path names once every link is followed, or the path itself where it can't be read. */
export const realPathOf = (path: string): Promise<string> => realpath(path).catch(() => path);

/**
 * Waits for a stopped command's output to close, up to `STOP_WAIT_MS`; past that, stops reading
 * it: a process it started can outlive the stop and hold the output (on Windows, `taskkill /T`
 * misses one whose parent has exited).
 */
export async function drained(
  child: ChildProcess,
  closed: Promise<unknown>,
  agent: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), STOP_WAIT_MS);
  });
  const tooLate = await Promise.race([closed.then(() => false), late]);
  clearTimeout(timer);
  if (!tooLate) return;
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  console.warn(
    `${agent}'s output stayed open after it was stopped, so IncarnaMind stopped reading it.`,
  );
}

/** The run sent nothing for as long as `stallMs`, and was stopped. */
export class StalledError extends Error {
  constructor(agent: string) {
    super(`${agent} stopped sending anything, so the request was stopped.`);
    this.name = "StalledError";
  }
}

/** A line of the run's stream wasn't JSON. */
export class UnreadableLineError extends Error {
  constructor(agent: string) {
    super(`${agent} returned an unreadable result.`);
    this.name = "UnreadableLineError";
  }
}

/** How long a run asked to end may take to end what it started, before all of it is killed. */
const END_GRACE_MS = 2_000;

/** How often the processes a run with its own tools started are looked up while it runs. */
const TREE_EVERY_MS = 2_000;

/** A process as `ps` lists it: its id, parent and group, and when it started. */
export type ProcessRow = { pid: number; ppid: number; pgid: number; started: string };

/** A process a run started, as it was seen: its id and its start never name another process. */
export type SeenProcess = { pid: number; pgid: number; started: string };

const PS_ARGS = ["-axo", "pid=,ppid=,pgid=,lstart="];
const PS_OPTIONS = { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };

const rowsOf = (out: string): ProcessRow[] =>
  out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!match) return [];
    const [, pid, ppid, pgid, started = ""] = match;
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started }];
  });

/** Each process as `ps` lists it; none where it can't be read. */
const listProcesses = (): Promise<ProcessRow[]> =>
  new Promise((resolve) => {
    execFile("/bin/ps", PS_ARGS, PS_OPTIONS, (error, out) => {
      if (error) {
        console.warn("Could not list the processes a run started:", error.message);
        resolve([]);
        return;
      }
      resolve(rowsOf(out));
    });
  });

/** The same, at once: for the moment a run is asked to end, when nothing may be awaited. */
function listProcessesNow(): ProcessRow[] {
  try {
    return rowsOf(
      execFileSync("/bin/ps", PS_ARGS, { ...PS_OPTIONS, encoding: "utf8", timeout: 2_000 }),
    );
  } catch (error) {
    console.warn("Could not list the processes a run started:", error);
    return [];
  }
}

/** Every process under `root` in `rows`. */
function treeIn(rows: readonly ProcessRow[], root: number) {
  const under = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { pid, ppid } of rows) {
      if (under.has(ppid) && !under.has(pid)) {
        under.add(pid);
        grew = true;
      }
    }
  }
  return rows.filter(({ pid }) => under.has(pid) && pid !== root);
}

/**
 * Of the processes a run started, those still running as they were seen, and the groups they
 * lead: an id reused since by a process of the User's is never in it. While `root` runs, what is
 * under it now is the run's too.
 */
export function stillOurs(
  seen: readonly SeenProcess[],
  rows: readonly ProcessRow[],
  root?: { pid: number; running: boolean },
): { pids: number[]; groups: number[] } {
  const now = new Map(rows.map((row) => [row.pid, row]));
  const ours = seen.filter((each) => now.get(each.pid)?.started === each.started);
  const pids = new Set(ours.map((each) => each.pid));
  if (root?.running) for (const each of treeIn(rows, root.pid)) pids.add(each.pid);
  const groups = new Set<number>();
  for (const pid of pids) {
    const row = now.get(pid);
    if (row && row.pgid === pid) groups.add(pid);
  }
  if (root?.running) groups.add(root.pid);
  return { pids: [...pids], groups: [...groups] };
}

const killNow = (target: number) => {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Gone already.
  }
};

/**
 * Ends what runs of the processes noted in `folder`, each file one run's, that a crash or a forced
 * quit left behind, and forgets them (#3653). Only one that still runs as it was noted.
 */
export async function endLeftRuns(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length === 0) return;
  const rows = await listProcesses();
  for (const name of names) {
    const file = join(folder, name);
    try {
      const noted = JSON.parse(await readFile(file, "utf8")) as SeenProcess[];
      const { pids, groups } = stillOurs(Array.isArray(noted) ? noted : [], rows);
      const ownGroup = rows.find((row) => row.pid === process.pid)?.pgid;
      for (const group of groups) if (group > 1 && group !== ownGroup) killNow(-group);
      for (const pid of pids) killNow(pid);
    } catch (error) {
      console.warn("Could not end what a run left running:", error);
    }
    await rm(file, { force: true });
  }
}

/**
 * Keeps track of the processes a run with its own tools starts, and ends them all (#3653). Claude
 * Code runs each command in a shell that leads a group of its own, so killing the run's group
 * alone leaves a command it moved to the background running. Ending, the run is asked to end at
 * once, before anything is awaited, since a quitting IncarnaMind may never come back to finish;
 * Claude Code then ends what it started. What still runs after a short wait, of what was seen under
 * it, is killed, each checked first to be the process that was seen. With `folder`, what it
 * started is noted there while it runs, for the next start to end after a crash. On Windows
 * `taskkill /T` ends the tree.
 */
export function wholeTree(child: ChildProcess, closed: Promise<unknown>, folder?: string) {
  const { pid } = child;
  const posix = pid !== undefined && process.platform !== "win32";
  const seen = new Map<number, SeenProcess>();
  let ownGroup: number | null = null;
  const running = () => child.exitCode === null && child.signalCode === null;
  const noted = folder && pid !== undefined ? join(folder, `${pid}.json`) : null;
  let noting = Promise.resolve();
  const note = () => {
    if (!noted || !folder) return;
    const list = JSON.stringify([...seen.values()]);
    noting = noting
      .then(async () => {
        await mkdir(folder, { recursive: true });
        await writeFile(noted, list);
      })
      .catch((error: unknown) => console.warn("Could not note what a run started:", error));
  };
  const seeIn = (rows: readonly ProcessRow[]) => {
    if (pid === undefined) return;
    ownGroup ??= rows.find((row) => row.pid === process.pid)?.pgid ?? null;
    const before = seen.size;
    for (const each of rows.filter((row) => row.pid === pid && running())) {
      seen.set(each.pid, { pid: each.pid, pgid: each.pgid, started: each.started });
    }
    if (running()) {
      for (const each of treeIn(rows, pid)) {
        seen.set(each.pid, { pid: each.pid, pgid: each.pgid, started: each.started });
      }
    }
    if (seen.size !== before) note();
  };
  const look = async () => {
    if (posix) seeIn(await listProcesses());
  };
  void look();
  const watch = setInterval(() => void look(), TREE_EVERY_MS);
  watch.unref?.();
  let ending = false;
  return {
    end(): void {
      if (ending) return;
      ending = true;
      clearInterval(watch);
      if (!posix || pid === undefined) {
        stopProcessTree(child);
        return;
      }
      if (running()) {
        // What runs under it now, before it is asked to end: a command started since the last
        // look would otherwise leave with its parent unseen.
        seeIn(listProcessesNow());
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // Not a group leader after all: the run alone is asked.
          child.kill("SIGTERM");
        }
      }
      void (async () => {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          closed,
          new Promise((resolve) => {
            timer = setTimeout(resolve, END_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        const rows = await listProcesses();
        const { pids, groups } = stillOurs([...seen.values()], rows, { pid, running: running() });
        // Never IncarnaMind's own group, which a process that didn't start a group of its own shares.
        for (const group of groups) if (group > 1 && group !== ownGroup) killNow(-group);
        for (const each of pids) killNow(each);
        await noting;
        if (noted) {
          await rm(noted, { force: true }).catch((error: unknown) =>
            console.warn("Could not forget what a run started:", error),
          );
        }
      })();
    },
  };
}

export interface JsonLines<T> {
  /** The agent's name, in what is logged and thrown. */
  agent: string;
  /**
   * Ends the command and everything it started, in place of killing its process group: for a run
   * whose commands lead groups of their own.
   */
  end?(): void;
  signal: AbortSignal;
  /** The most its whole messages may hold; past it, it is stopped. */
  maxBytes: number;
  /** The most it may print in all, the messages `counted` leaves out included. */
  rawMaxBytes: number;
  /** Whether a message counts towards `maxBytes`: one that repeats what whole messages say doesn't. */
  counted?(message: Record<string, unknown>): boolean;
  /** How long it may send nothing before it is stopped as stalled. */
  stallMs?: number;
  /** Whether it waits on something that may take long without a word, which doesn't count towards `stallMs`. */
  busy?(): boolean;
  /** Written to its input before the first line is read. */
  begin?(stdin: Writable): void;
  /** Each message, from the first; a value ends the reading with it, and one that throws stops it. */
  onMessage(message: Record<string, unknown>, stdin: Writable): T | undefined;
}

/**
 * Reads a started command's stream of JSON lines until `onMessage` gives a value, then stops the
 * command and every process it started; stopped at once when `signal` aborts, when it prints more
 * than it may, when it stays silent past `stallMs`, or when a line isn't JSON.
 */
export async function readJsonLines<T>(child: ChildProcess, run: JsonLines<T>): Promise<T> {
  const { signal, agent } = run;
  let open = true;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      open = false;
      resolve();
    }),
  );
  // The whole group, whatever its leader's own state: a process it started can hold the output
  // after the leader exits. A group's id isn't reused while any member of it lives.
  const kill = () => {
    if (run.end) run.end();
    else if (open) stopProcessTree(child);
  };
  child.on("error", kill);
  child.stdin?.on("error", kill);
  child.stderr?.resume();
  if (!child.stdin || !child.stdout) {
    kill();
    await drained(child, closed, agent);
    throw new Error(`${agent} input or output is unavailable.`);
  }
  const stdin = child.stdin;
  const lines = createInterface({ input: child.stdout });
  // Stopped: the reading ends now, not once every holder of the output lets it go.
  const stop = () => {
    kill();
    lines.close();
  };
  let bytes = 0;
  let raw = 0;
  let tooMuch = false;
  // A clock that stands still while the computer sleeps: a sleep isn't a stall.
  let heard = performance.now();
  let stalled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    heard = performance.now();
    raw += chunk.length;
    if (raw <= run.rawMaxBytes) return;
    tooMuch = true;
    stop();
  });
  const { stallMs } = run;
  const watch =
    stallMs === undefined
      ? undefined
      : setInterval(
          () => {
            if (run.busy?.()) heard = performance.now();
            if (performance.now() - heard <= stallMs) return;
            stalled = true;
            stop();
          },
          Math.min(5_000, stallMs / 4),
        );
  watch?.unref?.();
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    run.begin?.(stdin);
    for await (const line of lines) {
      signal.throwIfAborted();
      // Lines read before the output passed its limit still come once it is stopped: none counts.
      if (tooMuch) break;
      let message: Record<string, unknown>;
      try {
        message = object(JSON.parse(line));
      } catch {
        throw new UnreadableLineError(agent);
      }
      if (run.counted?.(message) ?? true) bytes += Buffer.byteLength(line);
      if (bytes > run.maxBytes) {
        tooMuch = true;
        stop();
        break;
      }
      const end = run.onMessage(message, stdin);
      if (end !== undefined) return end;
    }
    signal.throwIfAborted();
    if (stalled) throw new StalledError(agent);
    if (tooMuch) throw new Error(`${agent} printed more than IncarnaMind reads of one request.`);
    throw new Error(`${agent} could not complete the request.`);
  } finally {
    clearInterval(watch);
    signal.removeEventListener("abort", stop);
    stop();
    await drained(child, closed, agent);
  }
}
