import { beforeEach, expect, test, vi } from "vitest";
import type { WrittenCheckProgress } from "../../src/core/api";

/*
 * Two writes in one Note are checked at once (#2830): the Note's badge counts every check there
 * as one done-of-total, never jumping back when one ends, and its Stop stops them all.
 */

const cancelled = vi.hoisted(() => [] as string[]);
vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    cancelCheck: async (requestId: string) => {
      cancelled.push(requestId);
    },
  },
}));

const { stopCheck, useChecks } = await import("../../src/renderer/src/checks");
const { heardWrittenProgress, useWrittenChecks, writtenInNote } = await import(
  "../../src/renderer/src/writtenChecks"
);

const NOTE = "note-1";
const heard = (request: string, done: number, total: number, running = true, waiting = false) =>
  heardWrittenProgress({
    mindId: NOTE,
    request,
    done,
    total,
    running,
    waiting,
  } satisfies WrittenCheckProgress);
const badge = () => writtenInNote(useWrittenChecks.getState(), NOTE);

beforeEach(() => {
  cancelled.length = 0;
  useWrittenChecks.setState({ running: {}, byNote: {} });
  useChecks.setState({ running: {}, background: {} });
});

// protects=the badge counts both writes' checks in a Note as one, and keeps an ended one's count while the other runs, so it never falls from 40 of 40 to 3 of 12; fails_when=it shows only the oldest check, or jumps back when one ends; no_claim=the badge's words.
test("the badge counts every write's check in the Note as one, an ended one too until all end", () => {
  heard("first", 0, 40);
  // The second waits for the first: its sentences are in the total from the start.
  heard("second", 0, 12, true, true);
  expect(badge()).toEqual({ done: 0, total: 52 });

  heard("first", 40, 40);
  heard("second", 3, 12);
  heard("first", 40, 40, false);
  expect(badge()).toEqual({ done: 43, total: 52 });
  expect(useChecks.getState().running[NOTE]?.requestId).toBe("second");

  heard("second", 12, 12, false);
  expect(badge()).toBeNull();
  expect(useChecks.getState().running[NOTE]).toBeUndefined();
});

// protects=Stop on the badge stops every write's check running in the Note, not only the first; fails_when=the second check goes on after Stop; no_claim=what the sentences say once stopped.
test("Stop on the badge stops every write's check in the Note", () => {
  heard("first", 1, 40);
  heard("second", 0, 12);

  stopCheck(NOTE);

  expect(cancelled.sort()).toEqual(["first", "second"]);
});
