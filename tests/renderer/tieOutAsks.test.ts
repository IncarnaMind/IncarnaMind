import { beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Tie out figures (#2313): the whole-Note Check it starts goes through the same price question as
 * every other way in, and in a narrow window the schedule comes to the front once the User
 * answers. A rejected start is the caller's to report, never swallowed.
 */

const bridge = vi.hoisted(() => ({ getFigureSchedule: vi.fn() }));
const mindCheck = vi.hoisted(() => ({
  asking: {} as Record<string, unknown>,
  listeners: new Set<(state: { asking: Record<string, unknown> }) => void>(),
  asked: vi.fn(),
}));
const narrow = vi.hoisted(() => ({ value: false }));
const store = vi.hoisted(() => ({
  changeLayout: vi.fn(async (_options: { focus?: boolean }) => {}),
  openMind: vi.fn(async () => {}),
  layout: {
    groups: [
      {
        id: "group",
        tabs: [{ id: "tab", item: { kind: "mind", mindId: "mind" } }],
        activeTabId: "tab",
      },
    ],
  },
}));
vi.mock("../../src/renderer/src/core", () => ({ core: bridge }));
vi.mock("../../src/renderer/src/mindCheck", () => ({
  startCheckAsking: mindCheck.asked,
  useMindCheck: {
    getState: () => ({ asking: mindCheck.asking }),
    subscribe: (listener: (state: { asking: Record<string, unknown> }) => void) => {
      mindCheck.listeners.add(listener);
      return () => mindCheck.listeners.delete(listener);
    },
  },
}));
vi.mock("../../src/renderer/src/layoutSlice", () => ({
  frontTabOfMind: () => ({ id: "tab" }),
  groupsMerged: () => narrow.value,
}));
vi.mock("../../src/renderer/src/store", () => ({ useAppStore: { getState: () => store } }));

const { tieOutFigures } = await import("../../src/renderer/src/figures");

const schedule = (state: "not-checked" | "supported") => ({
  rows: [{ shown: { state } }],
});

beforeEach(() => {
  vi.clearAllMocks();
  mindCheck.asking = {};
  mindCheck.listeners.clear();
  mindCheck.asked.mockResolvedValue(null);
  bridge.getFigureSchedule.mockResolvedValue(schedule("not-checked"));
  narrow.value = false;
});

describe("Tie out figures starts the Check the same way every other way in does", () => {
  test("a figure to check starts the asking Check; a checked one starts none", async () => {
    await tieOutFigures("mind");
    expect(mindCheck.asked).toHaveBeenCalledWith("mind");
    expect(store.changeLayout).toHaveBeenCalledOnce();

    mindCheck.asked.mockClear();
    bridge.getFigureSchedule.mockResolvedValue(schedule("supported"));
    await tieOutFigures("mind");
    expect(mindCheck.asked).not.toHaveBeenCalled();
  });

  test("in a narrow window the schedule waits until the question is answered, then comes forward", async () => {
    narrow.value = true;
    mindCheck.asking = { mind: { requestId: "asked" } };
    mindCheck.asked.mockResolvedValue({ kind: "asked", requestId: "asked" });

    const running = tieOutFigures("mind");
    await vi.waitFor(() => expect(store.changeLayout).toHaveBeenCalledTimes(1));
    expect(store.changeLayout.mock.calls[0]?.[0]).toMatchObject({ focus: false });
    mindCheck.asking = {};
    for (const listener of mindCheck.listeners) listener({ asking: {} });
    await running;

    expect(store.changeLayout).toHaveBeenCalledTimes(2);
    expect(store.changeLayout.mock.calls[1]?.[0]).not.toHaveProperty("focus", false);
  });

  test("a start that rejects is not swallowed", async () => {
    const failure = new Error("The note couldn't open.");
    mindCheck.asked.mockRejectedValue(failure);
    await expect(tieOutFigures("mind")).rejects.toThrow("The note couldn't open.");
  });
});
