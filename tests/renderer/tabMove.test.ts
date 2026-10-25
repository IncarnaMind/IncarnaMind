import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { Core, LayoutChange } from "../../src/core";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * A tab moved a place within its group keeps its place by the tabs either side of it, so an
 * earlier tab closing doesn't move it when Undo puts it back (#1640). A step that can't be done
 * is refused with the reason, not counted as done.
 */

let core: Core | null = null;
const running = () => {
  if (!core) throw new Error("No core is running.");
  return core;
};
const bridge = new Proxy(
  {},
  {
    get: (_target, name) =>
      name === "getLayout"
        ? (windowId: string) => running().getLayout(windowId)
        : name === "changeLayout"
          ? (windowId: string, change: LayoutChange) => running().changeLayout(windowId, change)
          : () => () => undefined,
  },
);

type Store = typeof import("../../src/renderer/src/store");
type Actions = typeof import("../../src/renderer/src/components/tabs/tabActions");
type Undo = typeof import("../../src/renderer/src/undo");
let store: Store;
let actions: Actions;
let undo: Undo;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  // The focus a moved tab takes is drawn by the browser, which a test doesn't have.
  (
    globalThis as unknown as { requestAnimationFrame: (draw: () => void) => number }
  ).requestAnimationFrame = () => 0;
  store = await import("../../src/renderer/src/store");
  actions = await import("../../src/renderer/src/components/tabs/tabActions");
  undo = await import("../../src/renderer/src/undo");
});

beforeEach(() => {
  undo.useUndo.setState({ done: [], undone: [], line: null, running: null });
});

afterEach(() => {
  core = null;
});

const english: Translate = (key, params) => translate("en", key, params);

async function windowOf(titles: readonly string[]) {
  core = startCore(await createTempDataFolder());
  const names = new Map<string, string>();
  const groups = () => store.useAppStore.getState().layout?.groups ?? [];
  const group = () => {
    const first = groups()[0];
    if (!first) throw new Error("The window has no first group.");
    return first;
  };
  const open = async (title: string) => {
    const mind = await running().createMind({ title });
    names.set(mind.id, title);
    await running().changeLayout("main", {
      type: "open",
      item: { kind: "mind", mindId: mind.id },
    });
    await store.useAppStore.getState().loadLayout();
  };
  for (const title of titles) await open(title);
  const tabNamed = (title: string) => {
    for (const each of groups()) {
      const tab = each.tabs.find(
        (one) => one.item.kind === "mind" && names.get(one.item.mindId) === title,
      );
      if (tab) return tab;
    }
    throw new Error(`No tab is named ${title}.`);
  };
  const idOf = (title: string) => tabNamed(title).id;
  const close = async (title: string) => {
    await running().changeLayout("main", { type: "close", tabId: idOf(title) });
    await store.useAppStore.getState().loadLayout();
  };
  const show = async (title: string) => {
    await running().changeLayout("main", { type: "show", tabId: idOf(title) });
    await store.useAppStore.getState().loadLayout();
  };
  const pin = async (title: string) => {
    await running().changeLayout("main", { type: "pin", tabId: idOf(title), pinned: true });
    await store.useAppStore.getState().loadLayout();
  };
  const toItsOwnGroup = async (title: string) => {
    await running().changeLayout("main", {
      type: "split",
      tabId: idOf(title),
      side: "right",
      copy: false,
    });
    await store.useAppStore.getState().loadLayout();
  };
  const order = () =>
    group().tabs.map((tab) =>
      tab.item.kind === "mind" ? (names.get(tab.item.mindId) ?? "?") : tab.item.kind,
    );
  return {
    open,
    idOf,
    pinnedOf: (title: string) => tabNamed(title).pinned,
    close,
    order,
    pin,
    toItsOwnGroup,
    show,
  };
}

async function moveLater(tabId: string): Promise<void> {
  const change = await actions.moveWithinGroup(tabId, 1);
  if (!change) throw new Error("The tab didn't move.");
  undo.useUndo.getState().push(change);
}

const problem = () => undo.useUndo.getState().line?.problem;

test("Undo puts a moved tab back between the tabs it was between, though a tab before it has closed", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Beta"));
  expect(window.order()).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);

  await window.close("Alpha");
  expect(window.order()).toEqual(["Gamma", "Beta", "Delta"]);

  await undo.useUndo.getState().undo();
  expect(window.order()).toEqual(["Beta", "Gamma", "Delta"]);
  await undo.useUndo.getState().redo();
  expect(window.order()).toEqual(["Gamma", "Beta", "Delta"]);
});

test("With the tab on its right closed, Undo still puts it right after the tab on its left", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Beta"));
  await window.close("Gamma");
  await window.show("Alpha");
  await window.open("Zeta");
  expect(window.order()).toEqual(["Alpha", "Zeta", "Beta", "Delta"]);

  await undo.useUndo.getState().undo();
  expect(window.order()).toEqual(["Alpha", "Beta", "Zeta", "Delta"]);
});

test("Undo of a move whose tab has closed is refused, saying why, rather than counted as done", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Beta"));
  await window.close("Beta");

  await undo.useUndo.getState().undo();
  expect(problem()?.step).toBe("undo");
  expect(problem()?.reason(english)).toBe("the tab has closed");
  expect(undo.useUndo.getState().done).toEqual([]);
  expect(window.order()).toEqual(["Alpha", "Gamma", "Delta"]);
});

test("Undo the core turns down is refused, saying so, rather than counted as done", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Beta"));
  // Closed in another window: the core has no such tab, and this window's copy is out of date.
  await running().changeLayout("main", { type: "close", tabId: window.idOf("Beta") });

  await undo.useUndo.getState().undo();
  expect(problem()?.step).toBe("undo");
  expect(problem()?.reason(english)).toBe("the tabs couldn’t be changed");
  expect(undo.useUndo.getState().done).toEqual([]);
});

test("Undo refuses when the tabs either side of the moved one have both closed", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Beta"));
  await window.close("Alpha");
  await window.close("Gamma");
  expect(window.order()).toEqual(["Beta", "Delta"]);

  await undo.useUndo.getState().undo();
  expect(problem()?.reason(english)).toBe("the tabs either side of it have closed");
});

test("Undo keeps a Pin made after the move, refusing a place that would take it away", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Beta"));
  await window.pin("Beta");
  const withPin = window.order();
  expect(withPin).toEqual(["Beta", "Alpha", "Gamma", "Delta"]);

  await undo.useUndo.getState().undo();
  expect(problem()?.reason(english)).toBe("the pinned tabs have changed since");
  expect(window.order()).toEqual(withPin);
  expect(window.pinnedOf("Beta")).toBe(true);
});

test("Undo refuses when the tab has gone to another group, rather than change nothing quietly", async () => {
  const window = await windowOf(["Alpha", "Beta", "Gamma", "Delta"]);
  await moveLater(window.idOf("Alpha"));
  await window.toItsOwnGroup("Alpha");
  expect(window.order()).toEqual(["Beta", "Gamma", "Delta"]);

  await undo.useUndo.getState().undo();
  expect(problem()?.reason(english)).toBe("the tab is in another group now");
  expect(window.order()).toEqual(["Beta", "Gamma", "Delta"]);
});
