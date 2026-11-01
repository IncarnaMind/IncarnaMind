/**
 * The execution seam (ADR-0013; docs/designs/agent-extensibility.md §4.7):
 * every program a Tool starts goes through an `Executor` with a sandbox
 * level. This module has the local one, at level "none" unless it is given
 * a `Confinement` (the desktop app's OS sandbox, at "os": src/main/sandbox.ts):
 *
 * - The program runs as the User, started through the core's
 *   `ProcessLauncher` with the login-shell environment plus the request's,
 *   less the variables whose names look like secrets (`looksLikeSecret`),
 *   at every level.
 * - Without a `cwd`, each run gets a new, empty temporary working folder,
 *   removed afterwards.
 * - It runs with no input, until it exits or its timeout. On a timeout or its
 *   signal it is stopped with every process it started (its process group on
 *   macOS and Linux, its process tree on Windows).
 * - What it writes is kept up to `maxOutputBytes` per stream: the start of
 *   its standard output, the end of its error output (where errors usually
 *   are), each flagged when cut.
 *
 * Nothing it was allowed is enforced at "none": `declaredAccess` says what a
 * program can then reach, for approvals. A `Confinement` enforces it: the OS
 * sandbox (Seatbelt, bubblewrap) now; a container or a remote machine later,
 * behind the same `Executor`, so the Tools that use it don't change.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  ExecAllow,
  ExecFolder,
  ExecRequest,
  ExecResult,
  Executor,
  ProcessLauncher,
  SandboxLevel,
} from "./adapters";

/** The run's own working folder, in an `ExecRequest`'s `allow` sets. */
export const WORKING_FOLDER = { kind: "working-folder" } as const satisfies ExecFolder;

/** A folder of an `allow` set as a path, given the run's working folder. */
export const folderPath = (folder: ExecFolder, workingFolder: string): string =>
  typeof folder === "string" ? folder : workingFolder;

/**
 * Whether an environment variable's name looks like it holds a secret: it
 * contains KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL, in any case
 * (`GITHUB_TOKEN`, `OPENAI_API_KEY`, `PGPASSWORD`). Programs that Tools run
 * don't get these from the login shell, at any level: a sandbox confines
 * files and the network, not what a program is handed.
 */
export const looksLikeSecret = (name: string): boolean =>
  /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(name);

/** A program as an Executor starts it: what it runs, and the variables added to its environment. */
export interface Program {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

/**
 * How an Executor above level "none" confines the programs it runs: the
 * desktop app's OS sandbox (src/main/sandbox.ts).
 */
export interface Confinement {
  readonly level: Exclude<SandboxLevel, "none">;
  /**
   * The program to start in place of the request's, so that it, and every
   * process it starts, can touch only what the request allows, its working
   * folder being `workingFolder`.
   *
   * Rejects when the program can't be confined (the sandbox can't start, or
   * it can't give what the request asks): the run fails with that error, and
   * nothing runs unconfined. A command that isn't found rejects with an
   * error whose `code` is "ENOENT".
   */
  confine(request: ExecRequest, workingFolder: string): Promise<Program>;
  /** Called once for each program `confine` gave, when it has ended or couldn't start. */
  release(): void;
}

/**
 * What a program can reach, as approvals see it: what it was allowed, or
 * "anywhere" (any host) where nothing confines it.
 */
export interface ExecAccess {
  /** Whether what it was allowed is enforced. */
  confined: boolean;
  read: "anywhere" | ExecAllow["read"];
  write: "anywhere" | ExecAllow["write"];
  network: ExecAllow["network"];
}

/**
 * What a program run with `allow` can reach on an Executor at `level`:
 * exactly `allow` from "os" up, where the sandbox enforces it; anything at
 * "none", where nothing does, whatever it was allowed.
 */
export function declaredAccess(level: SandboxLevel, allow: ExecAllow): ExecAccess {
  if (level === "none") {
    return { confined: false, read: "anywhere", write: "anywhere", network: "any" };
  }
  return { confined: true, read: allow.read, write: allow.write, network: allow.network };
}

/**
 * Stops a process and every process it started, at once: its process group
 * on macOS and Linux (it was started as the group's leader), its process
 * tree on Windows. Best effort: one that has gone already is fine.
 */
function stopProcessTree(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) return;
  const killChild = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  };
  if (process.platform === "win32") {
    try {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.on("error", killChild);
    } catch {
      killChild();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Not a group leader after all (a launcher that ignored `processGroup`), or gone.
    killChild();
  }
}

/** The first `limit` bytes of a stream, and whether there was more. */
class Head {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (this.kept >= this.limit) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    const room = this.limit - this.kept;
    if (chunk.length > room) this.truncated = true;
    const part = chunk.subarray(0, room);
    this.chunks.push(part);
    this.kept += part.length;
  }
  /** As text; a character cut in half at the end is left out. */
  text(): string {
    return new StringDecoder("utf8").write(Buffer.concat(this.chunks));
  }
}

/** The last `limit` bytes of a stream, and whether there was more. */
class Tail {
  private buffer = Buffer.alloc(0);
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.limit) {
      this.truncated = true;
      this.buffer = Buffer.from(this.buffer.subarray(this.buffer.length - this.limit));
    }
  }
  /** As text; a character cut in half at the start is left out. */
  text(): string {
    let start = 0;
    // UTF-8 continuation bytes are 10xxxxxx.
    while (start < this.buffer.length && ((this.buffer[start] as number) & 0xc0) === 0x80) start++;
    return this.buffer.subarray(start).toString("utf8");
  }
}

/** How long a stopped program's output may stay open before the run ends without it. */
const STOP_GRACE_MS = 2000;

/** Waits for the process to end, keeping what it writes; stops it on its timeout or signal. */
const collect = (child: ChildProcess, request: ExecRequest) =>
  new Promise<ExecResult>((resolve) => {
    const stdout = new Head(request.maxOutputBytes);
    const stderr = new Tail(request.maxOutputBytes);
    let timedOut = false;
    let stopped = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", stop);
      resolve({
        exitCode: stopped ? null : code,
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };
    function stop() {
      if (stopped) return;
      stopped = true;
      stopProcessTree(child);
      // A process that escaped (e.g. it started a session of its own) may keep the output
      // open: after a grace period the run ends anyway, without it.
      setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode);
      }, STOP_GRACE_MS).unref();
    }
    // It gets no input.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    request.signal.addEventListener("abort", stop, { once: true });
    // Once it has exited and its output has closed (a process it started may keep that open).
    child.once("close", (code) => finish(code));
    // Stopped while it was starting: there was nothing to stop until now.
    if (request.signal.aborted) stop();
  });

export interface LocalExecutorOptions {
  /** Starts the programs, with the User's login-shell environment. */
  processes: ProcessLauncher;
  /** Where each run without a `cwd` gets its temporary working folder. */
  tempDir: string;
  /** Told when a run's temporary working folder can't be removed. */
  reportError(error: unknown): void;
  /** Confines each program, at its level. Not given: level "none", nothing confined. */
  confinement?: Confinement;
}

/**
 * The Executor on this computer: programs run as the User, at sandbox level
 * "none", or confined by its `confinement` at that one's level.
 */
export function createLocalExecutor(options: LocalExecutorOptions): Executor {
  const { confinement } = options;
  return {
    level: confinement?.level ?? "none",
    async run(request) {
      request.signal.throwIfAborted();
      const cwd = request.cwd ?? (await mkdtemp(join(options.tempDir, "incarnamind-script-")));
      const temporary = request.cwd === undefined ? cwd : undefined;
      try {
        const program = confinement ? await confinement.confine(request, cwd) : request;
        try {
          const child = await options.processes.spawn(program.command, program.args, {
            cwd,
            env: program.env,
            omitEnv: looksLikeSecret,
            processGroup: true,
          });
          return await collect(child, request);
        } finally {
          confinement?.release();
        }
      } finally {
        if (temporary !== undefined) {
          await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(
            options.reportError,
          );
        }
      }
    },
  };
}
