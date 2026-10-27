import { beforeAll, describe, expect, test } from "vitest";
import type { Task } from "../../src/core/api";

/*
 * What the Task commands act on (#1255): the Task the User opened, held in the
 * command's context, so ⌘K's field holding the focus doesn't make a command
 * act on the Mind's newest Task instead. The built app's own flow is in
 * e2e/taskCommands.spec.ts.
 */

/** The renderer's stores read the bridge the preload exposes, as `taskActions.test.ts` gives it. */
let taskFocus: typeof import("../../src/renderer/src/taskFocus");
let useTasks: typeof import("../../src/renderer/src/tasks").useTasks;
let useComposer: typeof import("../../src/renderer/src/composer").useComposer;
beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  taskFocus = await import("../../src/renderer/src/taskFocus");
  useTasks = (await import("../../src/renderer/src/tasks")).useTasks;
  useComposer = (await import("../../src/renderer/src/composer")).useComposer;
});

const task = (id: string, patch: Partial<Task> = {}): Task => ({
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
  startedAt: "2026-10-12T09:00:00.000Z",
  finishedAt: null,
  updatedAt: "2026-10-12T10:05:00.000Z",
  ...patch,
});

const opened = task("opened", { startedAt: "2026-10-12T09:00:00.000Z" });
const newer = task("newer", { startedAt: "2026-10-12T10:00:00.000Z" });
const done = task("done", {
  status: "done",
  startedAt: "2026-10-12T08:00:00.000Z",
  finishedAt: "2026-10-12T08:30:00.000Z",
});

/** What a command's context holds: the Task the User opened it on, done or not. */
const context = (task: string | null) => ({
  selection: [] as const,
  focus: null,
  surface: "palette" as const,
  task,
});

describe("the Task a command acts on", () => {
  test("is the one named in its context, not the Mind's newest", () => {
    useComposer.setState({ seat: { mindId: "mind" } as never });
    useTasks.setState({ tasks: { opened, newer } });
    expect(taskFocus.taskNow(context("opened"))?.id).toBe("opened");
    expect(taskFocus.taskNow(context("newer"))?.id).toBe("newer");
  });

  test("is a done Task the User opened, never another one still going", () => {
    useComposer.setState({ seat: { mindId: "mind" } as never });
    useTasks.setState({ tasks: { newer, done } });
    expect(taskFocus.taskNow(context("done"))?.id).toBe("done");
  });

  test("with none named, is the Mind's newest unfinished Task; with no Mind, none", () => {
    useComposer.setState({ seat: { mindId: "mind" } as never });
    useTasks.setState({ tasks: { opened, newer, done } });
    expect(taskFocus.taskNow(context(null))?.id).toBe("newer");
    expect(taskFocus.taskNow()?.id).toBe("newer");
    useComposer.setState({ seat: null });
    expect(taskFocus.taskNow(context(null))).toBeUndefined();
  });

  test("a Task gone from the list leaves the Mind's newest: nothing acts on an id it can't find", () => {
    useComposer.setState({ seat: { mindId: "mind" } as never });
    useTasks.setState({ tasks: { newer } });
    expect(taskFocus.taskNow(context("opened"))?.id).toBe("newer");
  });
});
