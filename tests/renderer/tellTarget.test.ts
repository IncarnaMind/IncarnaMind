import { beforeAll, describe, expect, test } from "vitest";
import type { Task } from "../../src/core/api";

let tellProblemOf: typeof import("../../src/renderer/src/tellTarget").tellProblemOf;
beforeAll(async () => {
  const bridge = new Proxy({}, { get: () => () => () => undefined });
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  ({ tellProblemOf } = await import("../../src/renderer/src/tellTarget"));
});

const task = (status: Task["status"]): Task => ({
  id: "task",
  kind: "research",
  mindId: "mind",
  blockId: null,
  question: null,
  review: null,
  status,
  pausedReason: null,
  resetsAt: null,
  ask: null,
  progress: null,
  problem: null,
  cost: null,
  actions: ["plan", "tell", "pause", "stop"],
  steps: [],
  stepCount: 0,
  queued: [],
  remaining: [],
  summary: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: status === "running" || status === "paused" ? null : "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
});

describe("the composer's target when a Task is missing or finished", () => {
  test("a missing Task gets an explicit warning rather than an invisible blocked target", () => {
    expect(tellProblemOf(true, undefined)).toBe("missing");
    expect(tellProblemOf(true, null)).toBeNull();
    expect(tellProblemOf(false, undefined)).toBeNull();
  });

  test("stopped and failed are finished without implying successful completion", () => {
    for (const status of ["done", "stopped", "failed"] as const) {
      expect(tellProblemOf(true, task(status))).toBe("finished");
    }
    expect(tellProblemOf(true, task("running"))).toBeNull();
  });
});
