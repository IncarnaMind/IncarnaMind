/**
 * The Executor contract (#61): what every Executor does with a request,
 * whatever its sandbox level. These are the Skill-script suite's cases
 * (tests/core/skillScripts.test.ts), run against the Executor directly:
 * a new temporary working folder, removed afterwards; a timeout and a stop
 * that end every process the program started; output caps; a missing
 * command; no variables that look like secrets. It runs against the local
 * Executor at level "none", and the OS sandbox's at "os" (#65) where it can
 * start; what only the sandbox does is in tests/main/sandbox.test.ts.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, onTestFinished, test, vi } from "vitest";
import type { ExecAllow, ExecRequest, Executor, ProcessLauncher } from "../../src/core";
import {
  createLocalExecutor,
  declaredAccess,
  type ProgramMeter,
  type ProgramUse,
  WORKING_FOLDER,
} from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import { loadOsSandbox } from "../../src/main/sandbox";
import { isRunning } from "../helpers/connectors";
import { createTempDataFolder } from "../helpers/core";
import { createSweepGuard } from "../helpers/sweepGuard";

type Environment = Record<string, string>;

/** PATH, HOME and the temporary folders of the test process only, plus `extra`. */
function smallEnvironment(extra: Environment = {}): Environment {
  const keep = ["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot"];
  const env: Environment = {};
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Node.js running `code`, with `args` after it: `process.argv[1]` is the first. */
const node = (code: string, ...args: string[]) => ({
  command: process.execPath,
  args: ["-e", code, "--", ...args],
});

/** Reports its arguments, its environment and its working folder, and leaves a file there. */
const REPORT = [
  'const { readdirSync, writeFileSync } = require("node:fs");',
  'const before = readdirSync(".");',
  'writeFileSync("made-by-the-program.txt", "x");',
  "console.log(JSON.stringify({ args: process.argv.slice(1), marker: process.env.MARKER, cwd: process.cwd(), before }));",
].join("\n");

/** The test runner's limit for a test that waits on a program that never ends: it stops a hang, it isn't a speed check. */
const RUNNER_LIMIT = 60_000;

/** A word no other process here has in its command line, for a case's programs to carry. */
const markerOf = () => `incarnamind-executor-${randomUUID()}`;

/**
 * The script of a process the program starts, carrying `marker` and "-child" after it, which the
 * program's own command line doesn't have together.
 */
const childScript = (marker: string) =>
  `["-e", "setInterval(() => {}, 1000) // ${marker}" + "-child"]`;

/** Starts a process of its own, writes both pids to the file it's given, then never ends. */
const sleeping = (marker: string) =>
  [
    `// ${marker}`,
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const child = spawn(process.execPath, ${childScript(marker)}, { stdio: "inherit" });`,
    "writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, child: child.pid }));",
    'console.log("started");',
    "setInterval(() => {}, 1000);",
  ].join("\n");

/**
 * Starts a process of its own in the background, writes both pids and ends. The process keeps the
 * run's output open when `holding` (as `cmd &` in a shell does), or closes it.
 */
const background = (marker: string, holding: boolean) =>
  [
    `// ${marker}`,
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const child = spawn(process.execPath, ${childScript(marker)}, { stdio: "${holding ? "inherit" : "ignore"}" });`,
    "writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, child: child.pid }));",
    "child.unref();",
  ].join("\n");

/** Starts a process in a session of its own, which a stop can't reach, holding the output open. */
const escaping = (marker: string) =>
  [
    `// ${marker}`,
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const child = spawn(process.execPath, ${childScript(marker)}, { stdio: "inherit", detached: true });`,
    "writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, child: child.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");

/** What a program wrote once it started: its pid and its child's, as it sees them. */
interface Started {
  pid: number;
  child: number;
  marker: string;
}

/** The pids the program wrote, once it has. */
async function startedIn(file: string, marker: string): Promise<Started> {
  let pids: { pid: number; child: number } | undefined;
  await vi.waitFor(
    async () => {
      pids = JSON.parse(await readFile(file, "utf8"));
    },
    { timeout: 10_000, interval: 25 },
  );
  return { ...(pids as { pid: number; child: number }), marker };
}

/** The pids of the processes here whose command line has `text`. */
function runningWith(text: string): number[] {
  const listing = execFileSync("ps", ["-ww", "-A", "-o", "pid=,command="], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter((line) => line.includes(text))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/**
 * Whether the program's child, or anything of the program (the program, its child, a sandbox
 * around them), still runs. On macOS and Linux they are found by their marker, since a program in
 * bubblewrap's PID namespace sees pids of its own; Windows has no such sandbox, and its pids are
 * the system's.
 */
const childRuns = (started: Started) =>
  process.platform === "win32"
    ? isRunning(started.child)
    : runningWith(`${started.marker}-child`).length > 0;
const anythingRuns = (started: Started) =>
  process.platform === "win32"
    ? isRunning(started.pid) || isRunning(started.child)
    : runningWith(started.marker).length > 0;

/** Waits until nothing of the program runs any more. */
async function expectStopped(started: Started) {
  await vi.waitFor(() => expect(anythingRuns(started)).toBe(false), {
    timeout: 5_000,
    interval: 25,
  });
}

/** A request as a Skill script's would be, for `program`, with what the case changes. */
function request(
  program: { command: string; args: string[] },
  overrides: Partial<ExecRequest> = {},
): ExecRequest {
  return {
    ...program,
    env: {},
    allow: { read: [WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
    timeoutMs: 10_000,
    maxOutputBytes: 20_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** What a program that also writes into `folder` (a case's own record of what ran) is allowed. */
const writingTo = (folder: string): ExecAllow => ({
  read: [WORKING_FOLDER, folder],
  write: [WORKING_FOLDER, folder],
  network: "none",
});

/** What a contract case needs: an Executor whose temporary working folders go into `tempDir`. */
interface Subject {
  executor: Executor;
  tempDir: string;
  /** The command of every process it started, in order. */
  started: string[];
}

/** What an Executor in the contract is built with. */
interface ExecutorParts {
  /** Where its temporary working folders go. */
  tempDir: string;
  /** Starts its processes, with `environment`'s variables. */
  processes: ProcessLauncher;
  environment(): Promise<Environment>;
}

/**
 * The cases every Executor must pass. `make` builds one from `ExecutorParts`;
 * `skip` says why it can't run here, when it can't.
 */
function executorContract(name: string, make: (parts: ExecutorParts) => Executor, skip?: string) {
  const setUp = async (env = smallEnvironment()): Promise<Subject> => {
    const tempDir = await createTempDataFolder();
    const environment = async () => env;
    const launcher = createProcessLauncher(environment);
    const started: string[] = [];
    const processes: ProcessLauncher = {
      spawn: (command, args, options) => {
        started.push(command);
        return launcher.spawn(command, args, options);
      },
    };
    return { executor: make({ tempDir, processes, environment }), tempDir, started };
  };

  const title = `The Executor contract: ${name}${skip === undefined ? "" : ` (skipped: ${skip})`}`;
  describe.skipIf(skip !== undefined)(title, { timeout: 30_000 }, () => {
    test("it runs the program with its arguments as they are, its environment added, in a new, empty temporary folder that is removed afterwards", async () => {
      const { executor, tempDir } = await setUp();
      const args = ["two words", "--flag", "ünïcode $HOME"];

      const run = await executor.run(request(node(REPORT, ...args), { env: { MARKER: "set" } }));

      expect(run).toMatchObject({
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      const report = JSON.parse(run.stdout);
      // No shell in between: "$HOME" stays as it was.
      expect(report.args).toEqual(args);
      expect(report.marker).toBe("set");
      expect(report.cwd.startsWith(await realpath(tempDir))).toBe(true);
      expect(report.before).toEqual([]);
      expect(existsSync(report.cwd)).toBe(false);
      expect(await readdir(tempDir)).toEqual([]);
    });

    test("variables whose names look like secrets aren't passed on; those the request sets are", async () => {
      const secrets = {
        GITHUB_TOKEN: "t",
        AWS_SECRET_ACCESS_KEY: "s",
        OPENAI_API_KEY: "k",
        PGPASSWORD: "p",
        GOOGLE_APPLICATION_CREDENTIALS: "c",
        npm_config__authToken: "lower case too",
      };
      const { executor } = await setUp(smallEnvironment({ ...secrets, PLAIN_SETTING: "kept" }));
      const names = "console.log(JSON.stringify(Object.keys(process.env)))";

      const run = await executor.run(
        request(node(names), { env: { REQUEST_TOKEN: "the caller's own" } }),
      );

      const seen: string[] = JSON.parse(run.stdout);
      expect(seen).toContain("PLAIN_SETTING");
      expect(seen).toContain("REQUEST_TOKEN");
      for (const name of Object.keys(secrets)) expect(seen).not.toContain(name);
    });

    test("a working folder it is given is used, and kept", async () => {
      const { executor, tempDir } = await setUp();
      const cwd = await createTempDataFolder();

      const run = await executor.run(request(node(REPORT), { cwd }));

      expect(JSON.parse(run.stdout).cwd).toBe(await realpath(cwd));
      expect(await readdir(cwd)).toEqual(["made-by-the-program.txt"]);
      expect(await readdir(tempDir)).toEqual([]);
    });

    test("it gets no input", async () => {
      const { executor } = await setUp();
      const code =
        'process.stdin.resume(); process.stdin.on("end", () => console.log("no input"));';

      const run = await executor.run(request(node(code), { timeoutMs: 5_000 }));

      expect(run).toMatchObject({ exitCode: 0, timedOut: false, stdout: "no input\n" });
    });

    test("a program that fails: its exit code and error output", async () => {
      const { executor } = await setUp();

      const run = await executor.run(request(node('console.error("boom"); process.exitCode = 3;')));

      expect(run).toEqual({
        exitCode: 3,
        timedOut: false,
        stdout: "",
        stderr: "boom\n",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });

    test(
      "one that runs past its timeout is stopped with every process it started; what it wrote is kept",
      async () => {
        const { executor, tempDir } = await setUp();
        const pidFolder = await createTempDataFolder();
        const pidFile = join(pidFolder, "pids.json");
        const marker = markerOf();

        // The program never ends on its own, so a run that comes back at all was stopped by the
        // timeout; if it didn't, the test runner's limit ends the test.
        const run = await executor.run(
          request(node(sleeping(marker), pidFile), {
            timeoutMs: 1_000,
            allow: writingTo(pidFolder),
          }),
        );

        expect(run).toMatchObject({ exitCode: null, timedOut: true, stdout: "started\n" });
        await expectStopped(await startedIn(pidFile, marker));
        expect(await readdir(tempDir)).toEqual([]);
      },
      RUNNER_LIMIT,
    );

    test.skipIf(process.platform === "win32")(
      "what it left running in the background ends when it does, its output open or not",
      async () => {
        const { executor } = await setUp();
        for (const holding of [false, true]) {
          const pidFolder = await createTempDataFolder();
          const pidFile = join(pidFolder, "pids.json");
          const marker = markerOf();

          // Left running and holding the output, it would keep the run until its timeout.
          const run = await executor.run(
            request(node(background(marker, holding), pidFile), {
              timeoutMs: 30_000,
              allow: writingTo(pidFolder),
            }),
          );

          expect(run).toMatchObject({ exitCode: 0, timedOut: false });
          await expectStopped(await startedIn(pidFile, marker));
        }
      },
      RUNNER_LIMIT,
    );

    test(
      "its signal stops it at once, with every process it started",
      async () => {
        const { executor, tempDir } = await setUp();
        const pidFolder = await createTempDataFolder();
        const pidFile = join(pidFolder, "pids.json");
        const stop = new AbortController();
        const marker = markerOf();

        const running = executor.run(
          request(node(sleeping(marker), pidFile), {
            signal: stop.signal,
            allow: writingTo(pidFolder),
          }),
        );
        const started = await startedIn(pidFile, marker);
        expect(childRuns(started)).toBe(true);
        stop.abort();
        // The program never ends on its own, so this settles only if the signal stopped it.
        const run = await running;

        expect(run).toMatchObject({ exitCode: null, timedOut: false });
        await expectStopped(started);
        expect(await readdir(tempDir)).toEqual([]);
      },
      RUNNER_LIMIT,
    );

    test("a signal stopped already: it doesn't run", async () => {
      const { executor, tempDir, started } = await setUp();
      const logFolder = await createTempDataFolder();
      const log = join(logFolder, "ran.log");
      const stop = new AbortController();
      stop.abort(new Error("Stopped before it started."));

      await expect(
        executor.run(
          request(node('require("node:fs").writeFileSync(process.argv[1], "ran")', log), {
            signal: stop.signal,
            allow: writingTo(logFolder),
          }),
        ),
      ).rejects.toThrow("Stopped before it started.");

      expect(started).toEqual([]);
      expect(existsSync(log)).toBe(false);
      expect(await readdir(tempDir)).toEqual([]);
    });

    test.skipIf(process.platform === "win32")(
      "a process in a session of its own doesn't keep the run waiting, and in the OS sandbox ends with it",
      async () => {
        const { executor } = await setUp();
        const pidFolder = await createTempDataFolder();
        const pidFile = join(pidFolder, "pids.json");
        const marker = markerOf();
        // The test's own clean-up, as the Executor can't end what escaped with no sandbox: the
        // child it wrote down, by its pid, while that pid is still the child with its marker.
        onTestFinished(async () => {
          const started = await readFile(pidFile, "utf8").catch(() => null);
          const child = started === null ? 0 : (JSON.parse(started) as { child: number }).child;
          if (child > 1 && runningWith(`${marker}-child`).includes(child)) {
            process.kill(child, "SIGKILL");
          }
        });

        const run = await executor.run(
          request(node(escaping(marker), pidFile), {
            timeoutMs: 1_000,
            allow: writingTo(pidFolder),
          }),
        );
        await startedIn(pidFile, marker);

        // Out of the program's group, it holds the output open. In the OS sandbox the run's sweep
        // finds it by its profile and ends it; with no sandbox nothing tells it from any other.
        expect(run).toMatchObject({ exitCode: null, timedOut: true });
        if (executor.level === "os") {
          await vi.waitFor(() => expect(runningWith(`${marker}-child`)).toEqual([]), {
            timeout: 5_000,
            interval: 25,
          });
        } else {
          expect(runningWith(`${marker}-child`)).toHaveLength(1);
        }
        expect(
          runningWith(marker).filter((pid) => !runningWith(`${marker}-child`).includes(pid)),
        ).toEqual([]);
      },
      RUNNER_LIMIT,
    );

    test("output is cut per stream, with a flag: the start of the standard output, the end of the error output", async () => {
      const { executor } = await setUp();
      const flood = [
        'process.stdout.write("S".repeat(30000) + "TAIL-OUT\\n");',
        'process.stderr.write("HEAD-ERR\\n" + "E".repeat(30000));',
      ].join("\n");

      const run = await executor.run(request(node(flood)));

      expect(run).toEqual({
        exitCode: 0,
        timedOut: false,
        stdout: "S".repeat(20_000),
        stderr: "E".repeat(20_000),
        stdoutTruncated: true,
        stderrTruncated: true,
      });
    });

    test("a character cut in half where the output is cut is left out", async () => {
      const { executor } = await setUp();
      // "abcé" and "éxyz" are five bytes each in UTF-8: "é" is two.
      const code = 'process.stdout.write("abcé"); process.stderr.write("éxyz");';

      const run = await executor.run(request(node(code), { maxOutputBytes: 4 }));

      expect(run).toMatchObject({
        stdout: "abc",
        stderr: "xyz",
        stdoutTruncated: true,
        stderrTruncated: true,
      });
    });

    test("a command that isn't found rejects with ENOENT, and its working folder is removed", async () => {
      const { executor, tempDir } = await setUp();

      await expect(
        executor.run(request({ command: "incarnamind-no-such-command", args: [] })),
      ).rejects.toMatchObject({ code: "ENOENT" });

      expect(await readdir(tempDir)).toEqual([]);
    });
  });
}

const failOnError = (error: unknown) => {
  throw error;
};

executorContract("the local executor (sandbox level none)", ({ tempDir, processes }) =>
  createLocalExecutor({ processes, tempDir, reportError: failOnError }),
);

const osSandbox = await loadOsSandbox();
const guard = createSweepGuard();
// Outside each case's temporary folder, which the contract checks is left empty.
const runRecords = guard.records(await mkdtemp(join(tmpdir(), "incarnamind-test-runs-")));
afterAll(async () => {
  // Each pid a run's sweep signalled was a member of one of this file's own runs.
  expect(guard.refused).toEqual([]);
  await rm(runRecords, { recursive: true, force: true });
});
executorContract(
  "the OS sandbox (sandbox level os)",
  ({ tempDir, processes, environment }) => {
    if (!osSandbox.available) throw new Error(osSandbox.reason);
    // The folders it denies are stand-ins: the real home is never read or written.
    return osSandbox.createExecutor({
      processes,
      environment,
      tempDir,
      denyRead: [join(tempDir, "stand-in-home"), join(tempDir, "stand-in-data")],
      reportError: failOnError,
      runRecords,
      sweep: { stopper: guard.stopper },
    });
  },
  osSandbox.available ? undefined : osSandbox.reason,
);

describe("Declared access, from the sandbox level", () => {
  const allow = {
    read: ["/skills/toolbox", WORKING_FOLDER],
    write: [WORKING_FOLDER],
    network: "none",
  } as const;

  test('the local executor is at level "none"', async () => {
    const executor = createLocalExecutor({
      processes: createProcessLauncher(async () => smallEnvironment()),
      tempDir: await createTempDataFolder(),
      reportError: () => undefined,
    });
    expect(executor.level).toBe("none");
  });

  test('at "none" nothing is enforced: a program can read, write and reach anything, whatever it was allowed', () => {
    expect(declaredAccess("none", allow)).toEqual({
      confined: false,
      read: "anywhere",
      write: "anywhere",
      network: "any",
    });
  });

  test('from "os" up, exactly what it was allowed', () => {
    for (const level of ["os", "container", "remote"] as const) {
      expect(declaredAccess(level, allow)).toEqual({ confined: true, ...allow });
    }
  });
});

test("a program with a memory or folder limit doesn't run where nothing can measure it", async () => {
  const started: string[] = [];
  const executor = createLocalExecutor({
    processes: {
      spawn: async (command) => {
        started.push(command);
        throw new Error("Nothing is to start.");
      },
    },
    tempDir: await createTempDataFolder(),
    reportError: failOnError,
  });
  const run = (limits: ExecRequest["limits"]) =>
    executor.run({
      command: "/bin/sleep",
      args: ["1"],
      env: {},
      allow: { read: [], write: [], network: "none" },
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
      limits,
    });
  const refusal = "This Executor can't measure a program's memory or folder";
  await expect(run({ memoryBytes: 2_000_000_000 })).rejects.toThrow(refusal);
  await expect(run({ folderBytes: 200_000_000 })).rejects.toThrow(refusal);
  expect(started).toEqual([]);
});

test("a program is stopped at the first limit its meter measures it past, and a part it couldn't read is reported once and stops nothing", async () => {
  const reports: unknown[] = [];
  const watching: { use: (use: ProgramUse) => void; unmeasured: (error: unknown) => void }[] = [];
  let stopped = 0;
  const meter: ProgramMeter = {
    watch(_root, _folder, use, unmeasured) {
      watching.push({ use, unmeasured });
      return () => {
        stopped += 1;
      };
    },
  };
  const executor = createLocalExecutor({
    processes: createProcessLauncher(async () => smallEnvironment()),
    tempDir: await createTempDataFolder(),
    reportError: (error) => reports.push(error),
    confinement: {
      level: "os",
      confine: async ({ command, args, env }) => ({ command, args, env, meter }),
      release: () => {},
    },
  });
  const run = executor.run({
    command: "/bin/sleep",
    args: ["30"],
    env: {},
    allow: { read: [], write: [], network: "none" },
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    limits: { memoryBytes: 1000, folderBytes: 500 },
  });
  await vi.waitFor(() => expect(watching).toHaveLength(1));
  const watched = watching[0];
  if (!watched) throw new Error("Nothing was watched.");
  watched.unmeasured(new Error("lsof didn't answer in time."));
  watched.unmeasured(new Error("lsof didn't answer in time."));
  // At its limits, not past them: the first limit it goes past is the one it is stopped at.
  watched.use({ memory: 1000, folder: 500 });
  watched.use({ memory: 1001, folder: 0 });

  await expect(run).resolves.toMatchObject({ exitCode: null, timedOut: false, limit: "memory" });
  expect(reports.map(String)).toEqual(["Error: lsof didn't answer in time."]);
  expect(stopped).toBe(1);
});

test("a program whose folder the meter can't measure is stopped, so one run can't hide another's disk use", async () => {
  const watching: ((use: ProgramUse) => void)[] = [];
  const meter: ProgramMeter = {
    watch(_root, _folder, use) {
      watching.push(use);
      return () => undefined;
    },
  };
  const executor = createLocalExecutor({
    processes: createProcessLauncher(async () => smallEnvironment()),
    tempDir: await createTempDataFolder(),
    reportError: failOnError,
    confinement: {
      level: "os",
      confine: async ({ command, args, env }) => ({ command, args, env, meter }),
      release: () => {},
    },
  });
  const run = executor.run({
    command: "/bin/sleep",
    args: ["30"],
    env: {},
    allow: { read: [], write: [], network: "none" },
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    limits: { folderBytes: 500 },
  });
  await vi.waitFor(() => expect(watching).toHaveLength(1));
  const use = watching[0];
  if (!use) throw new Error("Nothing was watched.");
  use({ memory: 0, folder: 10 });
  use({ memory: 0, folder: "unknown" });
  await expect(run).resolves.toMatchObject({
    exitCode: null,
    timedOut: false,
    limit: "folder-unknown",
  });
});
