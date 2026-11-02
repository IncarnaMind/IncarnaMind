/**
 * Which processes a run's sweep would signal (ADR-0025), before it signals any. An earlier sweep
 * told a run's processes by "may write the run's folder, may not write the one above", which
 * another program's sandbox answered too, and stopped that program's commands. Here the sweep's
 * classifier reads every process of this computer, and its stopper only records: no test sends
 * a signal to anything but the processes it started itself, each held by its pid.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WORKING_FOLDER } from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import {
  type Classified,
  classify,
  listProcesses,
  type ProcessRow,
  type RunRecord,
  type Stopper,
  type SweepDeps,
  signallable,
  sweepRun,
} from "../../src/main/runLeftovers";
import { loadOsSandbox } from "../../src/main/sandbox";
import { sandboxCheck } from "../../src/main/sandboxCheck";

const RUN: RunRecord = {
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
  folder: "/runs/incarnamind-code-1/work",
  startedMs: Date.parse("2026-11-02T10:00:00.400Z"),
  owner: { pid: 500, startedMs: Date.parse("2026-11-02T09:00:00Z") },
};

const row = (pid: number, fields: Partial<ProcessRow> = {}): ProcessRow => ({
  pid,
  ppid: 1,
  uid: 501,
  group: pid,
  startedMs: Date.parse("2026-11-02T10:00:01Z"),
  command: `p${pid}`,
  ...fields,
});

/** The app (500), under its parent 400, under launchd. */
const APP = [row(400, { startedMs: 0 }), row(500, { ppid: 400, startedMs: 0 })];

const CONTEXT = { platform: "darwin" as const, uid: 501, app: 500, group: 600 };

/** A sandbox_check stand-in: each pid's four answers, as `classify` asks them. */
function answering(byPid: Record<number, number[]>) {
  const asked: number[] = [];
  const check = async (questions: readonly { pid: number }[]) => {
    asked.push(...new Set(questions.map((question) => question.pid)));
    return questions.map((question, at) => byPid[question.pid]?.[at % 4] ?? -1);
  };
  return { check, asked };
}

const OURS = [0, 1, 1, 0];

describe("the sweep's classifier, on a listing it is given", () => {
  test("a member is this User's, not the app, started with the run, and gives the run's four answers", async () => {
    const rows = [
      ...APP,
      row(601),
      row(602, { uid: 0 }),
      row(603, { startedMs: Date.parse("2026-11-02T09:59:59Z") }),
      row(604),
      row(605),
      row(606),
      row(607),
      row(608),
      row(609),
      row(1),
      row(0),
    ];
    const { check, asked } = answering({
      601: OURS,
      602: OURS,
      603: OURS,
      604: [1, 1, 0, 0],
      605: [0, 0, 1, 0],
      606: [0, 1, 0, 0],
      607: [0, 1, 1, 1],
      608: [-1, -1, -1, -1],
      609: [1, 1, 1, 0],
      1: OURS,
      0: OURS,
    });
    const verdicts = (await classify(rows, RUN, CONTEXT, check)).map(
      (each) => `${each.pid} ${each.verdict}`,
    );
    expect(verdicts).toEqual([
      "400 the app or a parent of it",
      "500 the app or a parent of it",
      "601 member",
      "602 another user's",
      "603 started before the run",
      "604 not this run's profile",
      "605 not this run's profile",
      "606 not this run's profile",
      "607 not this run's profile",
      "608 not this run's profile",
      "609 not this run's profile",
      "1 not a process to signal",
      "0 not a process to signal",
    ]);
    expect(asked).toEqual([601, 604, 605, 606, 607, 608, 609]);
  });

  test("a process that started in the run's second counts; a start it can't read doesn't", async () => {
    const rows = [
      row(601, { startedMs: Date.parse("2026-11-02T10:00:00Z") }),
      row(602, { startedMs: Number.NaN }),
    ];
    const { check } = answering({ 601: OURS, 602: OURS });
    const verdicts = (await classify(rows, RUN, CONTEXT, check)).map((each) => each.verdict);
    expect(verdicts).toEqual(["member", "started before the run"]);
  });

  test("never a pid kill reads as more than one process, nor the app's", () => {
    expect(
      [2, 601, 1, 0, -1, -601, 1.5, Number.NaN, 500].map((pid) => signallable(pid, 500)),
    ).toEqual([true, true, false, false, false, false, false, false, false]);
  });

  test("a check that answers for the wrong number of processes fails the sweep", async () => {
    await expect(classify([row(601)], RUN, CONTEXT, async () => [0, 1, 1])).rejects.toThrow(
      "sandbox_check gave 3 answers to 1 processes.",
    );
  });

  test("on Linux a member is in the program's group, and nothing is asked of the sandbox", async () => {
    const rows = [
      ...APP,
      row(601, { group: 600 }),
      row(602, { group: 602 }),
      row(603, { group: 600, uid: 0 }),
    ];
    const { check, asked } = answering({});
    const linux = { ...CONTEXT, platform: "linux" as const };
    const verdicts = (await classify(rows, RUN, linux, check)).map(
      (each) => `${each.pid} ${each.verdict}`,
    );
    expect(verdicts.slice(2)).toEqual([
      "601 member",
      "602 not in the program's group",
      "603 another user's",
    ]);
    expect(asked).toEqual([]);
    const none = await classify(rows, RUN, { ...linux, group: 0 }, check);
    expect(none.filter((each) => each.verdict === "member")).toEqual([]);
  });
});

/** A computer the sweep reads: `table` is what ps lists now; `stopper` records and acts on it. */
function computer(table: ProcessRow[], ours: Set<number>, platform: NodeJS.Platform = "darwin") {
  const sent: string[] = [];
  const stopper: Stopper = (pid, signal) => {
    sent.push(`${signal} ${pid}`);
    const at = table.findIndex((each) => each.pid === pid);
    if (at < 0) return false;
    if (signal === "SIGKILL") table.splice(at, 1);
    return true;
  };
  const deps: SweepDeps = {
    list: async () => table.map((each) => ({ ...each })),
    check: async (questions) =>
      questions.map((question, at) => (ours.has(question.pid) ? (OURS[at % 4] ?? -1) : 1)),
    stopper,
    log: () => {},
    platform,
    uid: 501,
    app: 500,
  };
  return { deps, sent };
}

describe("the sweep's stops, through a stopper that records", () => {
  test("stops each member, finds them again, then kills only those found again", async () => {
    const table = [...APP, row(601), row(602), row(700)];
    const { deps, sent } = computer(table, new Set([601, 602]));
    expect(await sweepRun(RUN, 600, deps)).toEqual([]);
    expect(sent).toEqual(["SIGSTOP 601", "SIGSTOP 602", "SIGKILL 601", "SIGKILL 602"]);
    expect(table.map((each) => each.pid)).toEqual([400, 500, 700]);
  });

  test("a pid that isn't the run's when it is found again is left alone", async () => {
    const table = [...APP, row(601)];
    const { deps, sent } = computer(table, new Set([601]));
    const list = deps.list;
    let calls = 0;
    deps.list = async () => {
      calls += 1;
      // After the first listing, 601 has gone and its pid is a later process of no sandbox.
      if (calls === 2)
        table.splice(2, 1, row(601, { startedMs: Date.parse("2026-11-02T10:00:09Z") }));
      return list();
    };
    deps.check = async (questions) =>
      questions.map((_, at) => (calls === 1 ? (OURS[at % 4] ?? -1) : 0));
    expect(await sweepRun(RUN, 600, deps)).toEqual([]);
    expect(sent).toEqual(["SIGSTOP 601"]);
  });

  test("what a member forked before it was stopped is stopped in the next round", async () => {
    const table = [...APP, row(601)];
    const { deps, sent } = computer(table, new Set([601, 602]));
    const stopper = deps.stopper;
    deps.stopper = (pid, signal) => {
      if (pid === 601 && signal === "SIGSTOP") table.push(row(602, { ppid: 601 }));
      return stopper(pid, signal);
    };
    expect(await sweepRun(RUN, 600, deps)).toEqual([]);
    expect(sent).toEqual(["SIGSTOP 601", "SIGSTOP 602", "SIGKILL 601", "SIGKILL 602"]);
  });

  test("a member that won't end is reported, so new runs are refused", async () => {
    const table = [...APP, row(601)];
    const { deps } = computer(table, new Set([601]));
    deps.stopper = () => true;
    expect(await sweepRun(RUN, 600, deps)).toEqual([601]);
  });

  test("on Linux it signals nothing", async () => {
    const table = [...APP, row(601, { group: 600 })];
    const { deps, sent } = computer(table, new Set(), "linux");
    expect(await sweepRun(RUN, 600, deps)).toEqual([601]);
    expect(sent).toEqual([]);
  });
});

const sandbox = await loadOsSandbox();

/** Where the dry run writes every process it classified, when a person runs it to read. */
const REPORT = process.env.INCARNAMIND_TEST_SWEEP_REPORT;

/** Starts a process in a session of its own, writes both pids beside it, then never ends. */
const SETSID = [
  'const { spawn } = require("node:child_process");',
  'const { writeFileSync } = require("node:fs");',
  'const child = spawn("/bin/sleep", ["600"], { stdio: "ignore", detached: true });',
  'writeFileSync("pids.json", JSON.stringify({ pid: process.pid, child: child.pid }));',
  "setInterval(() => {}, 1000);",
].join("\n");

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Profiles of other programs' sandboxes: each lets its process write the runs' folders. */
const FOREIGN_PROFILES = {
  "allows everything": "(version 1)(allow default)",
  "allows everything but LaunchServices":
    '(version 1)(allow default)(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
  "allows every name of IncarnaMind's and no other":
    '(version 1)(allow default)(deny mach-lookup)(allow mach-lookup (global-name-prefix "com.incarnamind."))',
};

describe.runIf(process.platform === "darwin" && sandbox.available)(
  "the sweep's dry run, over every process of this computer",
  () => {
    const own: ChildProcess[] = [];
    const foreign = new Map<string, number>();
    let root = "";
    const report: Record<string, unknown> = {};

    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "incarnamind-test-sweep-")));
      const start = (label: string, command: string, args: string[]) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        own.push(child);
        foreign.set(label, child.pid ?? 0);
      };
      for (const [label, profile] of Object.entries(FOREIGN_PROFILES)) {
        start(label, SANDBOX_EXEC, ["-p", profile, "/bin/sleep", "600"]);
      }
      start("no sandbox", "/bin/sleep", ["600"]);
      // An agent's sandbox, as Claude Code's is: sandbox-runtime's own profile, which may write
      // the runs' folders.
      const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
      const { argv } = await SandboxManager.wrapWithSandboxArgv("exec /bin/sleep 600", undefined, {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      });
      start("sandbox-runtime's own profile", argv[0] ?? "/bin/bash", argv.slice(1));
      await vi.waitFor(
        async () => {
          const rows = await listProcesses();
          for (const pid of foreign.values()) {
            const sleeping = rows.some(
              (each) => (each.pid === pid || each.ppid === pid) && each.command === "/bin/sleep",
            );
            if (!sleeping) throw new Error(`${pid} isn't sleeping yet.`);
          }
        },
        { timeout: 20_000, interval: 100 },
      );
    }, 30_000);

    afterAll(async () => {
      for (const each of own) {
        try {
          if (each.pid) process.kill(-each.pid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
      if (REPORT) await writeFile(REPORT, `${JSON.stringify(report, null, 1)}\n`);
      await rm(root, { recursive: true, force: true });
    });

    /** The sleeping process each foreign profile holds: the one started, or its child. */
    const sleeper = (rows: readonly Classified[], all: readonly ProcessRow[], pid: number) => {
      const found = all.find(
        (each) => (each.pid === pid || each.ppid === pid) && each.command === "/bin/sleep",
      );
      return rows.find((each) => each.pid === found?.pid);
    };

    const context = (group: number) => ({
      platform: process.platform,
      uid: process.getuid?.() ?? -1,
      app: process.pid,
      group,
    });

    test("with no run active, no process is a member, and every other sandbox is told apart", async () => {
      const folder = join(root, "no-run");
      await mkdir(folder);
      const run: RunRecord = {
        id: randomUUID(),
        folder,
        // Every process of this User's is asked about, whenever it started.
        startedMs: 0,
        owner: { pid: process.pid, startedMs: 0 },
      };
      const rows = await listProcesses();
      const classified = await classify(rows, run, context(0), sandboxCheck);
      report.noRun = { run: run.id, classified };
      expect(classified.filter((each) => each.verdict === "member")).toEqual([]);
      expect(
        classified.filter((each) => each.verdict === "not this run's profile").length,
      ).toBeGreaterThan(foreign.size);
      const verdicts = Object.fromEntries(
        [...foreign].map(([label, pid]) => {
          const found = sleeper(classified, rows, pid);
          return [label, `${found?.verdict} ${found?.answers?.join(",")}`];
        }),
      );
      expect(verdicts).toEqual({
        "allows everything": "not this run's profile 0,0,0,0",
        "allows everything but LaunchServices": "not this run's profile 0,0,1,0",
        "allows every name of IncarnaMind's and no other": "not this run's profile 0,0,1,0",
        "no sandbox": "not this run's profile 0,0,0,0",
        "sandbox-runtime's own profile": "not this run's profile 1,1,0,0",
      });
      expect(classified.find((each) => each.pid === process.pid)?.verdict).toBe(
        "the app or a parent of it",
      );
    }, 60_000);

    test("with two runs active, each run's members are its own processes, and its sweep stops only them", async () => {
      const records = join(root, "records");
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      if (!sandbox.available) throw new Error("No OS sandbox.");
      const decoys = await Promise.all(
        ["a", "b"].map(async (name) => {
          const folder = join(root, `run-${name}`);
          await mkdir(folder);
          const sent: string[] = [];
          const stopper: Stopper = (pid, signal) => {
            sent.push(`${signal} ${pid}`);
            return true;
          };
          const errors: unknown[] = [];
          const executor = sandbox.createExecutor({
            processes: createProcessLauncher(async () => env),
            environment: async () => env,
            tempDir: root,
            denyRead: [],
            reportError: (error) => errors.push(error),
            sweep: { stopper, records },
          });
          const stop = new AbortController();
          const running = executor.run({
            command: process.execPath,
            args: ["-e", SETSID],
            cwd: folder,
            env: {},
            allow: { read: [WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" },
            timeoutMs: 120_000,
            maxOutputBytes: 1024,
            signal: stop.signal,
          });
          return { name, folder, sent, errors, stop, running };
        }),
      );
      const pids = await Promise.all(
        decoys.map(({ folder }) =>
          vi.waitFor(
            async () =>
              JSON.parse(await readFile(join(folder, "pids.json"), "utf8")) as {
                pid: number;
                child: number;
              },
            { timeout: 20_000, interval: 50 },
          ),
        ),
      );
      const recorded: RunRecord[] = [];
      for (const name of await readdir(records)) {
        recorded.push(JSON.parse(await readFile(join(records, name), "utf8")));
      }
      expect(recorded).toHaveLength(2);

      const rows = await listProcesses();
      const members: Record<string, number[]> = {};
      for (const [at, decoy] of decoys.entries()) {
        const run = recorded.find((each) => each.folder === decoy.folder);
        if (!run) throw new Error(`No record of run ${decoy.name}.`);
        const classified = await classify(rows, run, context(pids[at]?.pid ?? 0), sandboxCheck);
        report[`run-${decoy.name}`] = { run: run.id, decoy: pids[at], classified };
        members[decoy.name] = classified
          .filter((each) => each.verdict === "member")
          .map((each) => each.pid)
          .sort((a, b) => a - b);
      }
      const [a, b] = pids;
      expect(members).toEqual({
        a: [a?.pid ?? 0, a?.child ?? 0].sort((x, y) => x - y),
        b: [b?.pid ?? 0, b?.child ?? 0].sort((x, y) => x - y),
      });

      for (const decoy of decoys) decoy.stop.abort();
      await Promise.all(decoys.map((decoy) => decoy.running));
      const signalled = decoys.map(({ sent }) => [
        ...new Set(sent.map((each) => Number(each.split(" ")[1]))),
      ]);
      report.signalsRecorded = Object.fromEntries(decoys.map(({ name, sent }) => [name, sent]));
      expect(signalled[0]?.every((pid) => pid === a?.pid || pid === a?.child)).toBe(true);
      expect(signalled[1]?.every((pid) => pid === b?.pid || pid === b?.child)).toBe(true);
      expect(decoys[0]?.sent).toContain(`SIGKILL ${a?.child}`);
      expect(decoys[1]?.sent).toContain(`SIGKILL ${b?.child}`);

      // The children the recording stopper left running: each still the run's, so the test
      // ends them itself, by pid.
      const after = await listProcesses();
      for (const [at, decoy] of decoys.entries()) {
        const run = recorded.find((each) => each.folder === decoy.folder);
        if (!run) continue;
        const left = (await classify(after, run, context(0), sandboxCheck)).filter(
          (each) => each.verdict === "member",
        );
        expect(left.map((each) => each.pid)).toEqual([pids[at]?.child]);
        for (const each of left) process.kill(each.pid, "SIGKILL");
      }
      for (const [label, pid] of foreign) {
        expect([label, after.some((each) => each.pid === pid)]).toEqual([label, true]);
      }
    }, 90_000);
  },
);
