import { describe, expect, test } from "vitest";
import type { Task } from "../../src/core/api";
import {
  chipOf,
  interleave,
  taskGroups,
  taskInFocus,
  threadTasks,
} from "../../src/renderer/src/taskGroups";
import { resultLine, stepLine } from "../../src/renderer/src/taskText";
import { translate } from "../../src/shared/i18n";

const task = (id: string, patch: Partial<Task>): Task => ({
  id,
  kind: "comparison",
  mindId: "mind",
  blockId: "table",
  question: null,
  review: null,
  status: "running",
  pausedReason: null,
  resetsAt: null,
  ask: null,
  progress: { done: 2, total: 6 },
  problem: null,
  cost: null,
  actions: ["pause", "stop"],
  steps: [],
  stepCount: 0,
  queued: [],
  remaining: [],
  summary: null,
  startedAt: "2026-10-12T10:00:00.000Z",
  finishedAt: null,
  updatedAt: "2026-10-12T10:05:00.000Z",
  ...patch,
});

const running = task("running", {});
const asking = task("asking", {
  startedAt: "2026-10-12T11:00:00.000Z",
  ask: { kind: "approval", stepKey: "ask:a", number: 1 },
});
const capped = task("capped", { status: "paused", pausedReason: "cost-cap" });
const pausedByUser = task("paused", { status: "paused", pausedReason: "user" });
const done = task("done", {
  status: "done",
  progress: { done: 9, total: 9 },
  finishedAt: "2026-10-12T09:00:00.000Z",
});
const stopped = task("stopped", { status: "stopped", finishedAt: "2026-10-12T12:00:00.000Z" });

describe("the Tasks chip", () => {
  test("shows only while a Task runs or needs the User, counting each", () => {
    expect(chipOf([])).toBeNull();
    expect(chipOf([done, stopped, pausedByUser])).toBeNull();
    expect(chipOf([running])).toEqual({ running: 1, needsYou: 0 });
    expect(chipOf([running, asking, capped])).toEqual({ running: 1, needsYou: 2 });
  });

  test("its popover lists Needs you, then Running (those the User paused too), then Recent, newest first", () => {
    const groups = taskGroups([done, running, stopped, asking, capped, pausedByUser]);
    expect(groups.needsYou.map((each) => each.id)).toEqual(["asking", "capped"]);
    expect(groups.running.map((each) => each.id)).toEqual(["running", "paused"]);
    expect(groups.recent.map((each) => each.id)).toEqual(["stopped", "done"]);
  });

  test("says what each does and how each ended, in English and Chinese", () => {
    const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("en", key, params);
    const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate("zh-CN", key, params);
    expect(stepLine(running, en, "en")).toBe("Filling cell 3 of 6");
    expect(stepLine(asking, en, "en")).toBe("Waiting for your approval");
    expect(stepLine(pausedByUser, en, "en")).toBe("Paused");
    expect(resultLine(done, en)).toBe("9 cells");
    expect(resultLine(stopped, en)).toBe("Stopped");
    expect(stepLine(running, zh, "zh-CN")).toBe("正在填写第 3 个单元格，共 6 个");
    expect(resultLine(done, zh)).toBe("9 个单元格");
    expect(translate("zh-CN", "tasks.chip.running", { count: 1 })).toBe("1 个进行中");
  });
});

describe("the Task in focus", () => {
  const at = (time: string) => `2026-10-12T${time}:00.000Z`;
  const older = task("older", { startedAt: at("09:00") });
  const newer = task("newer", { startedAt: at("10:00") });
  const elsewhere = task("elsewhere", { mindId: "other", startedAt: at("11:00") });

  test("is the Task whose block or row holds the focus, done or not", () => {
    // The focused one is not the first: it still wins.
    expect(taskInFocus([newer, older], "mind", "older")?.id).toBe("older");
    expect(taskInFocus([older, newer], "mind", "newer")?.id).toBe("newer");
    // A done Task holding the focus is never swapped for one still going: a command would act on it.
    expect(taskInFocus([older, done], "mind", "done")?.id).toBe("done");
    expect(taskInFocus([done, newer], "mind", "done")?.id).toBe("done");
    expect(taskInFocus([stopped, elsewhere], "other", "stopped")?.id).toBe("stopped");
  });

  test("else it is the newest unfinished Task of the Mind in focus, wherever it sits in the list", () => {
    expect(taskInFocus([older, newer, elsewhere], "mind", null)?.id).toBe("newer");
    expect(taskInFocus([elsewhere, newer, older], "mind", null)?.id).toBe("newer");
    // The Mind in focus decides, not the newest Task of every Mind.
    expect(taskInFocus([older, elsewhere], "other", null)?.id).toBe("elsewhere");
  });

  test("a paused Task and one that needs the User are in focus too, while the chip can be hidden", () => {
    // Paused by the User, the chip hides; a limit pauses it "needs you", and the chip shows.
    expect(chipOf([pausedByUser])).toBeNull();
    expect(taskInFocus([pausedByUser], "mind", null)?.id).toBe("paused");
    expect(chipOf([capped])).not.toBeNull();
    expect(taskInFocus([capped], "mind", null)?.id).toBe("capped");
    expect(taskInFocus([asking], "mind", null)?.id).toBe("asking");
  });

  test("no Mind in focus and no Task holding it leaves none", () => {
    expect(taskInFocus([running, elsewhere], null, null)).toBeUndefined();
    expect(taskInFocus([], "mind", null)).toBeUndefined();
    expect(taskInFocus([done, stopped], "mind", null)).toBeUndefined();
  });
});

describe("a Task's progress in the thread", () => {
  const message = (id: string, createdAt: string) => ({ id, createdAt });
  const at = (time: string) => `2026-10-12T${time}:00.000Z`;

  test("shows the read Mind's Tasks going, those seen going, the one asked for, and those since the thread began", () => {
    const old = task("old", { status: "done", startedAt: at("08:00"), finishedAt: at("08:05") });
    const recent = task("recent", {
      status: "done",
      startedAt: at("10:30"),
      finishedAt: at("10:40"),
    });
    const going = task("going", { startedAt: at("07:00") });
    const elsewhere = task("elsewhere", { mindId: "other" });
    const all = [old, recent, going, elsewhere];
    const thread = { since: at("10:00"), seen: new Set<string>() };
    expect(threadTasks(all, "mind", thread, null).map((each) => each.id)).toEqual([
      "going",
      "recent",
    ]);
    expect(threadTasks(all, "mind", thread, "old").map((each) => each.id)).toEqual([
      "going",
      "old",
      "recent",
    ]);
    expect(threadTasks(all, null, thread, null)).toEqual([]);
    // Seen going, it stays once it is done, though it started before the thread.
    const finished = { ...going, status: "done" as const, finishedAt: at("11:00") };
    expect(threadTasks([finished], "mind", thread, null).map((each) => each.id)).toEqual(["going"]);
  });

  test("each Task sits where it started among the messages", () => {
    const first = task("first", { startedAt: at("09:00") });
    const second = task("second", { startedAt: at("10:30") });
    const third = task("third", { startedAt: at("12:00") });
    const entries = interleave(
      [message("question", at("10:00")), message("answer", at("10:01"))],
      [first, second, third],
    );
    expect(
      entries.map((entry) => (entry.kind === "task" ? entry.task.id : entry.message.id)),
    ).toEqual(["first", "question", "answer", "second", "third"]);
  });
});
