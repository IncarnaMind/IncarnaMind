import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  fileWrite,
  type SystemNotifications,
  type Task,
  type TaskApprovalCall,
  type TaskKind,
  type TaskRun,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, nextTurn, queryDatabase, startCore } from "../helpers/core";

/** Waits for a state, with room for a busy machine. */
const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 10_000 });

/** A promise that never settles: a step hung when IncarnaMind closed. */
const never = new Promise<void>(() => {});

/** What a test kind did, as the test steers it. */
interface Probe {
  /** Every Effect performed, by file name, in order. */
  performed: string[];
  /** Hang the write of this file before writing it, or after. */
  hangBefore?: string;
  hangAfter?: string;
}

const FILES = ["a.txt", "b.txt"];

/** A Task that writes each file as an Effect, journalled before and after. */
function filesKind(probe: Probe, folder: string): TaskKind {
  return {
    kind: "test-files",
    async run(task) {
      task.started("plan");
      task.settled("plan", "completed");
      for (const name of FILES) {
        if (task.signal.aborted) return { status: "stopped" };
        const write = await fileWrite(join(folder, name), `contents of ${name}\n`);
        await task.effect(`write:${name}`, write.effect, async () => {
          probe.performed.push(name);
          if (probe.hangBefore === name) await never;
          await write.perform();
          if (probe.hangAfter === name) await never;
        });
      }
      return { status: "done" };
    },
  };
}

const writeCall = (name: string, folder: string): TaskApprovalCall => ({
  mindId: null,
  subject: { kind: "tool", connectorId: "test", tool: "write_file" },
  connector: { id: "test", name: "Test" },
  tool: "write_file",
  title: null,
  input: { name },
  readOnly: false,
  effects: [{ action: "write", scope: { kind: "folder", path: folder } }],
  tainted: false,
});

/** A Task that asks before each file, then writes it. */
function askingKind(probe: Probe, folder: string): TaskKind {
  return {
    kind: "test-asking",
    async run(task) {
      for (const name of FILES) {
        const allowed = await task.approve(`ask:${name}`, writeCall(name, folder));
        if (!allowed) continue;
        const write = await fileWrite(join(folder, name), `contents of ${name}\n`);
        await task.effect(`write:${name}`, write.effect, async () => {
          probe.performed.push(name);
          await write.perform();
        });
      }
      return { status: "done" };
    },
  };
}

/** A Task whose steps wait for their turn: each takes one, and records when it had it. */
function turnKind(log: string[], release: Promise<void>, local = true): TaskKind {
  return {
    kind: "test-turns",
    async run(task: TaskRun) {
      const turn = await task.turn(local);
      log.push("turn");
      await Promise.race([
        release,
        new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve())),
      ]);
      log.push(turn.signal.aborted ? "gave way" : "step done");
      turn.end();
      return { status: "done" };
    },
  };
}

async function waitForTask(core: Core, taskId: string, done: (task: Task) => boolean) {
  let found: Task | undefined;
  await waitFor(async () => {
    found = (await core.listTasks()).find((task) => task.id === taskId);
    expect(found && done(found)).toBe(true);
  });
  return found as Task;
}

const finished = (task: Task) => task.finishedAt !== null;

interface StepRow {
  key: string;
  status: string;
  attempts: number;
  effect: string | null;
}

const stepsOf = (dataDir: string, taskId: string) =>
  queryDatabase<StepRow>(
    dataDir,
    "SELECT key, status, attempts, effect FROM run_steps WHERE run_id = ? ORDER BY rowid",
    [taskId],
  );

describe("the Task journal", () => {
  test("the database syncs each commit to disk (synchronous=FULL)", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      expect(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
    } finally {
      db.close();
    }
  });

  test("each step is journalled as started, then completed, and the Task as done", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const probe: Probe = { performed: [] };
    const core = startCore(dataDir, { taskKinds: [filesKind(probe, folder)] });
    const task = core.startTask("test-files", null, { folder });
    expect(task.status).toBe("running");
    const done = await waitForTask(core, task.id, finished);
    expect(done.status).toBe("done");
    expect(stepsOf(dataDir, task.id).map((step) => [step.key, step.status])).toEqual([
      ["plan", "completed"],
      ["write:a.txt", "completed"],
      ["write:b.txt", "completed"],
    ]);
    const effect = JSON.parse(stepsOf(dataDir, task.id)[1]?.effect ?? "{}");
    expect(effect).toMatchObject({
      kind: "file-write",
      path: join(folder, "a.txt"),
      previous: null,
    });
    expect(await readFile(join(folder, "b.txt"), "utf8")).toBe("contents of b.txt\n");
  });

  test("a step completed before a quit isn't done again: the Task goes on at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const probe: Probe = { performed: [], hangBefore: "b.txt" };
    const core = startCore(dataDir, { taskKinds: [filesKind(probe, folder)] });
    const task = core.startTask("test-files", null, { folder });
    await waitFor(() => expect(probe.performed).toEqual(["a.txt", "b.txt"]));
    core.close();

    // b.txt's write never began: its file is as it was (none), so it is written now.
    const again: Probe = { performed: [] };
    const reopened = startCore(dataDir, { taskKinds: [filesKind(again, folder)] });
    const done = await waitForTask(reopened, task.id, finished);
    expect(done.status).toBe("done");
    expect(again.performed).toEqual(["b.txt"]);
    expect(stepsOf(dataDir, task.id).find((step) => step.key === "write:b.txt")).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("an Effect a crash left open is checked: the file holds what it wrote, so it counts as done", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const probe: Probe = { performed: [], hangAfter: "a.txt" };
    const core = startCore(dataDir, { taskKinds: [filesKind(probe, folder)] });
    const task = core.startTask("test-files", null, { folder });
    await waitFor(async () =>
      expect(await readFile(join(folder, "a.txt"), "utf8").catch(() => "")).not.toBe(""),
    );
    core.close();
    expect(stepsOf(dataDir, task.id).at(-1)).toMatchObject({
      key: "write:a.txt",
      status: "started",
    });

    const again: Probe = { performed: [] };
    const reopened = startCore(dataDir, { taskKinds: [filesKind(again, folder)] });
    await waitForTask(reopened, task.id, finished);
    expect(again.performed).toEqual(["b.txt"]);
  });

  test("an Effect whose file someone else changed can't be told: the Task asks, and does it again or skips it", async () => {
    for (const answer of ["redo", "skip"] as const) {
      const dataDir = await createTempDataFolder();
      const folder = await createTempDataFolder();
      const probe: Probe = { performed: [], hangAfter: "a.txt" };
      const core = startCore(dataDir, { taskKinds: [filesKind(probe, folder)] });
      const task = core.startTask("test-files", null, { folder });
      await waitFor(async () =>
        expect(await readFile(join(folder, "a.txt"), "utf8").catch(() => "")).not.toBe(""),
      );
      core.close();
      await writeFile(join(folder, "a.txt"), "the User's own words\n");

      const again: Probe = { performed: [] };
      const reopened = startCore(dataDir, { taskKinds: [filesKind(again, folder)] });
      const asking = await waitForTask(reopened, task.id, (each) => each.ask !== null);
      expect(asking).toMatchObject({
        status: "paused",
        pausedReason: "closed",
        ask: { kind: "unknown-outcome", stepKey: "write:a.txt", number: 1 },
      });
      expect(again.performed).toEqual([]);

      await reopened.answerTaskAsk(task.id, answer);
      await waitForTask(reopened, task.id, finished);
      expect(again.performed).toEqual(answer === "redo" ? ["a.txt", "b.txt"] : ["b.txt"]);
      expect(await readFile(join(folder, "a.txt"), "utf8")).toBe(
        answer === "redo" ? "contents of a.txt\n" : "the User's own words\n",
      );
      reopened.close();
    }
  });

  test("a Task waiting for approval when IncarnaMind closes comes back paused, Needs you, and asks again", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const probe: Probe = { performed: [] };
    const core = startCore(dataDir, { taskKinds: [askingKind(probe, folder)] });
    const task = core.startTask("test-asking", null, { folder });
    const first = await waitFor(async () => {
      const [request] = await core.listApprovalRequests();
      if (!request) throw new Error("Not asked yet.");
      return request;
    });
    expect(first).toMatchObject({ taskId: task.id, answerId: task.id, toolCallId: "ask:a.txt" });
    await core.respondToApproval(first.requestId, "allow-once");
    const second = await waitFor(async () => {
      const request = (await core.listApprovalRequests()).find(
        (each) => each.toolCallId === "ask:b.txt",
      );
      if (!request) throw new Error("Not asked yet.");
      return request;
    });
    expect(second.taskId).toBe(task.id);
    expect((await core.listTasks())[0]?.ask).toEqual({
      kind: "approval",
      stepKey: "ask:b.txt",
      number: 2,
    });
    core.close();

    const again: Probe = { performed: [] };
    const reopened = startCore(dataDir, { taskKinds: [askingKind(again, folder)] });
    const paused = (await reopened.listTasks())[0];
    expect(paused).toMatchObject({
      id: task.id,
      status: "paused",
      pausedReason: "closed",
      ask: { kind: "approval", stepKey: "ask:b.txt", number: 2 },
    });
    const asked = (await reopened.listApprovalRequests()).find((each) => each.taskId === task.id);
    expect(asked?.toolCallId).toBe("ask:b.txt");
    if (!asked) throw new Error("It wasn't asked again.");
    await reopened.respondToApproval(asked.requestId, "always-allow");
    await waitForTask(reopened, task.id, finished);
    // a.txt was written before the quit, and isn't written again.
    expect([...probe.performed, ...again.performed]).toEqual(["a.txt", "b.txt"]);
    expect(
      queryDatabase<{ policy: string }>(
        dataDir,
        "SELECT policy FROM approval_policies WHERE subject_id = 'test:write_file' AND deleted_at IS NULL",
      ),
    ).toEqual([{ policy: "always" }]);

    reopened.close();

    // Always allowed now: another Task's call of that Tool goes on without asking.
    const elsewhere = await createTempDataFolder();
    const next: Probe = { performed: [] };
    const later = startCore(dataDir, { taskKinds: [askingKind(next, elsewhere)] });
    const another = later.startTask("test-asking", null, { folder: elsewhere });
    await waitForTask(later, another.id, finished);
    expect(next.performed).toEqual(["a.txt", "b.txt"]);
    expect(await later.listApprovalRequests()).toEqual([]);
  });

  test("a Task's view says what its kind lets the User do, and its latest steps in its words; every step on asking", async () => {
    const dataDir = await createTempDataFolder();
    const steps = ["one", "two", "three", "four", "five", "six"];
    const counting: TaskKind = {
      kind: "test-counting",
      actions: ["plan", "pause", "stop"],
      describeSteps: (_task, keys) => keys.map((key) => `Step ${key}`),
      async run(task) {
        for (const key of steps) {
          task.started(key);
          task.settled(key, key === "five" ? "failed" : "completed");
        }
        task.started("seven");
        await never;
        return { status: "done" };
      },
    };
    const core = startCore(dataDir, { taskKinds: [counting] });
    const task = core.startTask("test-counting", null, {});
    const shown = await waitForTask(core, task.id, (each) => each.stepCount === 7);
    expect(shown.actions).toEqual(["plan", "pause", "stop"]);
    expect(shown.steps).toEqual([
      { key: "four", text: "Step four", status: "done" },
      { key: "five", text: "Step five", status: "failed" },
      { key: "six", text: "Step six", status: "done" },
      { key: "seven", text: "Step seven", status: "running" },
    ]);
    expect((await core.listTaskSteps(task.id)).map((step) => step.text)).toEqual([
      "Step one",
      "Step two",
      "Step three",
      "Step four",
      "Step five",
      "Step six",
      "Step seven",
    ]);
    // A kind that says nothing of its actions offers Pause and Stop.
    const folder = await createTempDataFolder();
    const other = startCore(await createTempDataFolder(), {
      taskKinds: [filesKind({ performed: [] }, folder)],
    });
    const files = other.startTask("test-files", null, {});
    expect((await waitForTask(other, files.id, finished)).actions).toEqual(["pause", "stop"]);
    core.close();
    other.close();
  });

  test("Pause stops it where it is, Resume goes on, Stop ends it and withdraws what it asks", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const probe: Probe = { performed: [] };
    const core = startCore(dataDir, { taskKinds: [askingKind(probe, folder)] });
    const task = core.startTask("test-asking", null, { folder });
    await waitFor(async () => expect(await core.listApprovalRequests()).toHaveLength(1));

    const paused = await core.pauseTask(task.id);
    expect(paused).toMatchObject({ status: "paused", pausedReason: "user", ask: null });
    expect(await core.listApprovalRequests()).toEqual([]);

    const resumed = await core.resumeTask(task.id);
    expect(resumed.status).toBe("running");
    await waitFor(async () => expect(await core.listApprovalRequests()).toHaveLength(1));

    const stopped = await core.stopTask(task.id);
    expect(stopped).toMatchObject({ status: "stopped", ask: null });
    expect(stopped.finishedAt).not.toBeNull();
    expect(await core.listApprovalRequests()).toEqual([]);
    expect(probe.performed).toEqual([]);
  });

  test("Tasks give way: no step starts while an Answer is written or a Meeting recorded, and one on this computer yields", async () => {
    const { createTasks } = await import("../../src/core/runs/tasks");
    const { migrate } = await import("../../src/core/storage");
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(db);
    const log: string[] = [];
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running: boolean[] = [];
    const tasks = createTasks({
      db,
      now: () => new Date().toISOString(),
      kinds: [turnKind(log, released)],
      approvals: { decide: () => "ask", request: async () => true },
      retention: { retain: () => {}, release: () => {} },
      cost: () => null,
      changed: () => {},
      notify: () => {},
      stepsRunning: (value) => running.push(value),
      reportError: (error) => {
        throw error;
      },
    });
    try {
      tasks.setAnswering(true);
      const task = tasks.start("test-turns", null, {});
      await nextTurn();
      expect(log).toEqual([]);
      tasks.setAnswering(false);
      tasks.setRecording(true);
      await nextTurn();
      expect(log).toEqual([]);
      tasks.setRecording(false);
      await waitFor(() => expect(log).toEqual(["turn"]));
      // Background jobs wait while the step runs.
      expect(running).toEqual([true]);
      tasks.setAnswering(true);
      await waitFor(() => expect(log).toEqual(["turn", "gave way"]));
      expect(running).toEqual([true, false]);
      tasks.setAnswering(false);
      release();
      await waitFor(() => expect(tasks.get(task.id).status).toBe("done"));
    } finally {
      tasks.close();
      db.close();
    }
  });

  test("it notifies only when its Mind isn't on screen", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const shown: { title: string; body: string }[] = [];
    let front: string[] = [];
    const notifications: SystemNotifications = {
      show: (note, onScreen) => {
        if (!onScreen(front)) shown.push(note);
      },
    };
    const probe: Probe = { performed: [] };
    const core = startCore(dataDir, { taskKinds: [askingKind(probe, folder)], notifications });
    const mind = await core.createMind({ title: "Peer comparison" });
    await core.changeLayout("main", {
      type: "open",
      item: { kind: "mind", mindId: mind.id },
      where: { in: "place" },
    });
    front = ["main"];
    const task = core.startTask("test-asking", mind.id, { folder });
    await waitFor(async () => expect(await core.listApprovalRequests()).toHaveLength(1));
    expect(shown).toEqual([]);

    // The window isn't in front: the next ask notifies.
    front = [];
    const [request] = await core.listApprovalRequests();
    if (!request) throw new Error("Not asked.");
    await core.respondToApproval(request.requestId, "allow-once");
    await waitFor(() =>
      expect(shown).toEqual([{ title: "Task needs you", body: "Peer comparison" }]),
    );
    const [next] = (await core.listApprovalRequests()).filter((each) => each.taskId === task.id);
    if (!next) throw new Error("Not asked.");
    await core.respondToApproval(next.requestId, "allow-once");
    await waitFor(() => expect(shown.at(-1)?.title).toBe("Task finished"));
  });

  test("with Task notifications turned off it says nothing, and the Task still runs and lists", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createTempDataFolder();
    const shown: { title: string; body: string }[] = [];
    const notifications: SystemNotifications = {
      show: (note) => shown.push(note),
    };
    const probe: Probe = { performed: [] };
    const core = startCore(dataDir, { taskKinds: [askingKind(probe, folder)], notifications });
    const mind = await core.createMind({ title: "Peer comparison" });
    await core.updateSettings({ user: { taskNotifications: false } });

    const task = core.startTask("test-asking", mind.id, { folder });
    for (let allowed = 0; allowed < FILES.length; allowed++) {
      await waitFor(async () => expect(await core.listApprovalRequests()).toHaveLength(1));
      const [request] = await core.listApprovalRequests();
      if (!request) throw new Error("Not asked.");
      await core.respondToApproval(request.requestId, "allow-once");
    }
    await waitFor(async () => {
      expect((await core.listTasks()).find((each) => each.id === task.id)?.status).toBe("done");
    });
    expect(probe.performed).toEqual(FILES);
    expect(shown).toEqual([]);
  });
});
