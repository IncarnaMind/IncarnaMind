import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { DEFAULT_ASSISTANT, type LayoutChange, type WindowLayout } from "../../src/core/api";
import type { LayoutSlice } from "../../src/renderer/src/layoutSlice";

/*
 * The core's answers are ordered by hand here, as a slow computer delivers them: a tab
 * operation's answer can come after the assistant was placed again, and must not put the
 * assistant's width back.
 */

interface Asked {
  change: LayoutChange;
  answer: (layout: WindowLayout) => void;
}

const asked: Asked[] = [];
const reads: ((layout: WindowLayout) => void)[] = [];
const bridge = {
  changeLayout: vi.fn(
    (_windowId: string, change: LayoutChange) =>
      new Promise<WindowLayout>((resolve) => asked.push({ change, answer: resolve })),
  ),
  getLayout: vi.fn(() => new Promise<WindowLayout>((resolve) => reads.push(resolve))),
};

const layoutOf = (width: number, tabIds: string[]): WindowLayout => ({
  groups: [
    {
      id: "group",
      tabs: tabIds.map((id) => ({
        id,
        item: { kind: "library" },
        preview: false,
        pinned: false,
        place: null,
        opened: 0,
      })),
      activeTabId: tabIds[0] ?? null,
      width: 1,
    },
  ],
  focusedGroupId: "group",
  reopenable: 0,
  assistant: { ...DEFAULT_ASSISTANT, width },
});

const tabIdsOf = (layout: WindowLayout | null) =>
  layout?.groups.flatMap((group) => group.tabs.map((tab) => tab.id));

let store: UseBoundStore<StoreApi<LayoutSlice>>;
let widths: number[];
let stopWatching: () => void;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { incarnamind: bridge };
  const { createLayoutSlice } = await import("../../src/renderer/src/layoutSlice");
  store = create<LayoutSlice>()((set, get) =>
    createLayoutSlice(set, get, (error) => {
      throw error;
    }),
  );
});

afterAll(() => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
});

beforeEach(() => {
  asked.length = 0;
  reads.length = 0;
  store.setState({ layout: layoutOf(320, ["a", "b"]) });
  widths = [];
  stopWatching = store.subscribe((state) => {
    const width = state.layout?.assistant.width;
    if (width !== undefined && width !== widths.at(-1)) widths.push(width);
  });
});

afterEach(() => stopWatching());

/** The core's n-th request answered with this. */
const answer = (n: number, layout: WindowLayout) => (asked[n] as Asked).answer(layout);

describe("a tab operation's answer", () => {
  test("keeps the assistant's width from the placings made since, and takes the tabs", async () => {
    const { placeAssistant, changeLayout } = store.getState();
    const placings = [placeAssistant({ width: 330 })];
    const closing = changeLayout({ type: "close", tabId: "b" });
    placings.push(placeAssistant({ width: 340 }), placeAssistant({ width: 350 }));
    expect(asked.map((each) => each.change.type)).toEqual([
      "assistant",
      "close",
      "assistant",
      "assistant",
    ]);

    answer(0, layoutOf(330, ["a", "b"]));
    answer(1, layoutOf(330, ["a"]));
    const closed = await closing;
    expect(tabIdsOf(store.getState().layout), "the tabs follow the answer").toEqual(["a"]);
    expect(store.getState().layout?.assistant.width, "the width stays at the last press").toBe(350);
    expect(closed?.assistant.width).toBe(350);

    answer(2, layoutOf(340, ["a"]));
    answer(3, layoutOf(350, ["a"]));
    await Promise.all(placings);
    expect(widths, "the width never steps back").toEqual([330, 340, 350]);
    expect(tabIdsOf(store.getState().layout)).toEqual(["a"]);
  });

  test("does not put the width back when it comes after every answer to a placing", async () => {
    const { placeAssistant, changeLayout } = store.getState();
    const closing = changeLayout({ type: "close", tabId: "b" });
    const placings = [placeAssistant({ width: 330 }), placeAssistant({ width: 340 })];

    answer(1, layoutOf(330, ["a", "b"]));
    answer(2, layoutOf(340, ["a", "b"]));
    await Promise.all(placings);
    answer(0, layoutOf(320, ["a"]));
    await closing;
    expect(store.getState().layout?.assistant.width).toBe(340);
    expect(tabIdsOf(store.getState().layout)).toEqual(["a"]);
    expect(widths).toEqual([330, 340]);
  });

  test("is taken whole when the assistant was not placed meanwhile", async () => {
    const closing = store.getState().changeLayout({ type: "close", tabId: "b" });
    answer(0, layoutOf(400, ["a"]));
    await closing;
    expect(store.getState().layout).toEqual(layoutOf(400, ["a"]));
  });
});

describe("a read of the layout", () => {
  test("keeps the assistant where it was placed while it was read, and takes the tabs", async () => {
    const { loadLayout, placeAssistant } = store.getState();
    const loading = loadLayout();
    const placing = placeAssistant({ width: 360 });
    reads[0]?.(layoutOf(320, ["a"]));
    await loading;

    expect(tabIdsOf(store.getState().layout), "the tabs follow the read").toEqual(["a"]);
    expect(store.getState().layout?.assistant.width, "the width stays at the press").toBe(360);
    answer(0, layoutOf(360, ["a"]));
    await placing;
    expect(widths, "the width never steps back").toEqual([360]);
  });

  test("is taken whole when the assistant was not placed meanwhile", async () => {
    const loading = store.getState().loadLayout();
    reads[0]?.(layoutOf(400, ["a"]));
    await loading;

    expect(store.getState().layout).toEqual(layoutOf(400, ["a"]));
  });
});
