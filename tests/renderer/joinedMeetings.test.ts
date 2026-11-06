import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  undoMeetingJoin: vi.fn(),
  listJoinedMeetings: vi.fn(async () => []),
  joinedMeetingsSaid: vi.fn(async () => undefined),
}));
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));

import type { JoinedMeeting } from "../../src/core/api";
import { useJoinedMeetings } from "../../src/renderer/src/joinedMeetings";
import { CONFIRMATION_SHOWN_MS } from "../../src/renderer/src/notices";

const join: JoinedMeeting = {
  id: "join-1",
  mindId: "mind-1",
  folderId: "folder-1",
  noteMoved: true,
};

const rows = () => useJoinedMeetings.getState().joined.map((each) => [each.id, each.undone]);

const deferred = () => {
  let settle = () => {};
  bridge.undoMeetingJoin.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  return () => settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  bridge.undoMeetingJoin.mockReset();
  useJoinedMeetings.setState({ joined: [join], loaded: true });
});

afterEach(() => {
  vi.useRealTimers();
  useJoinedMeetings.setState({ joined: [], loaded: false });
});

describe("A joined line's Undo (#2579)", () => {
  test("says it worked only after Core has taken the join back", async () => {
    const settle = deferred();
    const undone = useJoinedMeetings.getState().undo(join.id);
    await vi.advanceTimersByTimeAsync(CONFIRMATION_SHOWN_MS + 1);
    expect(rows()).toEqual([[join.id, undefined]]);
    settle();
    await undone;
    expect(rows()).toEqual([[join.id, true]]);
    await vi.advanceTimersByTimeAsync(CONFIRMATION_SHOWN_MS);
    expect(rows()).toEqual([]);
  });

  test("leaves the line and its Undo when Core refuses", async () => {
    const refused = new Error("The join isn't there.");
    bridge.undoMeetingJoin.mockRejectedValue(refused);
    await expect(useJoinedMeetings.getState().undo(join.id)).rejects.toBe(refused);
    expect(rows()).toEqual([[join.id, undefined]]);
    await vi.advanceTimersByTimeAsync(CONFIRMATION_SHOWN_MS * 2);
    expect(rows()).toEqual([[join.id, undefined]]);
  });

  test("a second click while Core is working asks it once", async () => {
    const settle = deferred();
    const first = useJoinedMeetings.getState().undo(join.id);
    await useJoinedMeetings.getState().undo(join.id);
    expect(bridge.undoMeetingJoin).toHaveBeenCalledTimes(1);
    settle();
    await first;
    expect(rows()).toEqual([[join.id, true]]);
  });
});
