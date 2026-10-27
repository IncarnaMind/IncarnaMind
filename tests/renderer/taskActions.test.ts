import { beforeAll, describe, expect, test } from "vitest";
import type { Task } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";

/** The renderer's store reads the bridge the preload exposes, as `commands.test.ts` gives it. */
let taskActions: typeof import("../../src/renderer/src/taskActions");
beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  taskActions = await import("../../src/renderer/src/taskActions");
});

const task = (patch: Partial<Task> = {}): Task => ({
  id: "task",
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

const running = task();
const paused = task({ status: "paused", pausedReason: "user" });
const capped = task({ status: "paused", pausedReason: "cost-cap" });
const asking = task({ ask: { kind: "approval", stepKey: "ask:a", number: 1 } });
const done = task({ status: "done", finishedAt: "2026-10-12T09:00:00.000Z" });
const stopped = task({ status: "stopped", finishedAt: "2026-10-12T12:00:00.000Z" });
const plain = task({ actions: ["stop"] });

describe("the Task commands' states", () => {
  test("no Task in focus takes nothing", () => {
    expect(taskActions.taskOffers(undefined, "pause")).toBe(false);
    expect(taskActions.taskOffers(undefined, "resume")).toBe(false);
    expect(taskActions.taskOffers(undefined, "stop")).toBe(false);
  });

  test("a running Task takes Pause and Stop, not Resume", () => {
    expect(taskActions.taskOffers(running, "pause")).toBe(true);
    expect(taskActions.taskOffers(running, "resume")).toBe(false);
    expect(taskActions.taskOffers(running, "stop")).toBe(true);
  });

  test("a Task the User paused takes Resume and Stop, not Pause", () => {
    expect(taskActions.taskOffers(paused, "pause")).toBe(false);
    expect(taskActions.taskOffers(paused, "resume")).toBe(true);
    expect(taskActions.taskOffers(paused, "stop")).toBe(true);
    expect(taskActions.taskOffers(capped, "resume")).toBe(true);
  });

  test("a Task that needs the User takes Stop only: Resume waits for the ask", () => {
    expect(taskActions.taskOffers(asking, "pause")).toBe(false);
    expect(taskActions.taskOffers(asking, "resume")).toBe(false);
    expect(taskActions.taskOffers(asking, "stop")).toBe(true);
  });

  test("a finished Task, done or stopped, takes nothing", () => {
    for (const command of ["pause", "resume", "stop"] as const) {
      expect(taskActions.taskOffers(done, command)).toBe(false);
      expect(taskActions.taskOffers(stopped, command)).toBe(false);
    }
  });

  test("a Task whose kind doesn't pause still stops, and only what it lists is offered", () => {
    expect(taskActions.taskOffers(plain, "pause")).toBe(false);
    expect(taskActions.taskOffers(plain, "stop")).toBe(true);
  });
});

describe("the Tasks popover row's actions", () => {
  const english = (key: Parameters<typeof translate>[1]) => translate("en", key);
  const chinese = (key: Parameters<typeof translate>[1]) => translate("zh-CN", key);

  test("a Task still going offers Stop, named with its key for the tooltip", () => {
    for (const each of [running, paused, capped, asking]) {
      const actions = taskActions.taskRowActions(each, english);
      expect(actions.map((action) => action.key)).toEqual(["stop"]);
      expect(actions[0]?.label).toBe("Stop");
      expect(actions[0]?.shortcut).toBe("task.stop");
    }
  });

  test("a finished Task offers none", () => {
    expect(taskActions.taskRowActions(done, english)).toEqual([]);
    expect(taskActions.taskRowActions(stopped, english)).toEqual([]);
  });

  test("what a row's Stop says is in the interface's language", () => {
    expect(taskActions.taskRowActions(running, chinese)[0]?.label).toBe("停止");
  });
});
