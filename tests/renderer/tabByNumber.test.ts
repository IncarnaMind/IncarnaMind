import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { Core, LayoutChange, WindowLayout } from "../../src/core";
import type { CommandId } from "../../src/shared/commands";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * ⌃1–⌃8 show the focused group's tab at that place and ⌃9 its last, as in VS Code (#1602); Alt
 * on Windows and Linux, where Ctrl+1–3 go to a group. Run as the window runs them: from the
 * registry and the keymap, with the core's own layouts behind the bridge.
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

type Registry = typeof import("../../src/renderer/src/commands/registry");
type Keys = typeof import("../../src/renderer/src/commands/keys");
type Keymap = typeof import("../../src/renderer/src/commands/keymap");
type Store = typeof import("../../src/renderer/src/store");
type Slice = typeof import("../../src/renderer/src/layoutSlice");
let registry: Registry;
let keys: Keys;
let keymap: Keymap;
let store: Store;
let slice: Slice;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    incarnamind: bridge,
    incarnamindFiles: bridge,
  };
  await import("../../src/renderer/src/commands/app");
  registry = await import("../../src/renderer/src/commands/registry");
  keys = await import("../../src/renderer/src/commands/keys");
  keymap = await import("../../src/renderer/src/commands/keymap");
  store = await import("../../src/renderer/src/store");
  slice = await import("../../src/renderer/src/layoutSlice");
});

afterEach(() => {
  slice.useCardWidth.setState({ width: null });
  core = null;
});

const NOWHERE = { selection: [], focus: null, surface: "mind" } as const;
const NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const idOf = (number: number): CommandId => (number === 9 ? "tab.showLast" : `tab.show${number}`);

/** A window whose first group has five Minds' tabs, the last shown. */
async function fiveTabs() {
  core = startCore(await createTempDataFolder());
  const names = new Map<string, string>();
  const open = async (title: string) => {
    const mind = await running().createMind({ title });
    names.set(mind.id, title);
    return running().changeLayout("main", {
      type: "open",
      item: { kind: "mind", mindId: mind.id },
    });
  };
  for (const title of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]) await open(title);
  await store.useAppStore.getState().loadLayout();
  const layout = () => {
    const now = store.useAppStore.getState().layout;
    if (!now) throw new Error("The window has no layout.");
    return now;
  };
  const nameOf = (group: WindowLayout["groups"][number] | undefined) => {
    const tab = slice.activeTabOf(group);
    return tab?.item.kind === "mind" ? names.get(tab.item.mindId) : undefined;
  };
  /** A copy of the shown tab in a group on the right, which takes the focus, with these Minds after it. */
  const splitWith = async (...titles: string[]) => {
    const shown = slice.activeTabOf(slice.focusedGroupOf(layout()));
    if (!shown) throw new Error("No tab is shown.");
    await running().changeLayout("main", {
      type: "split",
      tabId: shown.id,
      side: "right",
      copy: true,
    });
    for (const title of titles) await open(title);
    await store.useAppStore.getState().loadLayout();
  };
  return {
    splitWith,
    layout,
    /** The shown tab's Mind in the focused group, and in each group. */
    shown: () => nameOf(slice.focusedGroupOf(layout())),
    shownIn: (index: number) => nameOf(layout().groups[index]),
    focusedIndex: () => layout().groups.findIndex((each) => each.id === layout().focusedGroupId),
  };
}

const offeredHere = () =>
  NUMBERS.filter((number) => {
    const command = registry.commands.get(idOf(number));
    return command !== undefined && registry.offered(command, NOWHERE);
  });

describe("Go to Tab", () => {
  test("with five tabs, ⌃3 shows the third and ⌃9 the fifth; ⌃6 to ⌃8 aren't offered and change nothing", async () => {
    const window = await fiveTabs();
    expect(window.shown()).toBe("Epsilon");

    await registry.commands.run("tab.show3", NOWHERE);
    expect(window.shown()).toBe("Gamma");
    await registry.commands.run("tab.show1", NOWHERE);
    expect(window.shown()).toBe("Alpha");
    await registry.commands.run("tab.showLast", NOWHERE);
    expect(window.shown()).toBe("Epsilon");

    expect(offeredHere()).toEqual([1, 2, 3, 4, 5, 9]);
    const before = window.layout();
    for (const number of [6, 7, 8]) await registry.commands.run(idOf(number), NOWHERE);
    expect(window.layout()).toBe(before);
  });

  test("in a second group they act on that group's tabs, and on the first group's once it has the focus", async () => {
    const window = await fiveTabs();
    await window.splitWith("Zeta", "Eta");
    expect(window.focusedIndex()).toBe(1);
    expect(window.shownIn(1)).toBe("Eta");

    await registry.commands.run("tab.show1", NOWHERE);
    expect(window.shownIn(1)).toBe("Epsilon");
    expect(window.shownIn(0)).toBe("Epsilon");
    await registry.commands.run("tab.showLast", NOWHERE);
    expect(window.shownIn(1)).toBe("Eta");
    expect(offeredHere()).toEqual([1, 2, 3, 9]);

    const first = window.layout().groups[0];
    if (!first) throw new Error("There is no first group.");
    await store.useAppStore.getState().changeLayout({ type: "focus", groupId: first.id });
    await registry.commands.run("tab.show2", NOWHERE);
    expect(window.focusedIndex()).toBe(0);
    expect(window.shownIn(0)).toBe("Beta");
    expect(window.shownIn(1)).toBe("Eta");
  });

  test("with the groups merged into one strip, they count every tab in it, as the User sees them", async () => {
    const window = await fiveTabs();
    await window.splitWith("Zeta");
    slice.useCardWidth.setState({ width: 600 });
    expect(slice.groupsMerged()).toBe(true);

    expect(offeredHere()).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
    await registry.commands.run("tab.show2", NOWHERE);
    expect(window.focusedIndex()).toBe(0);
    expect(window.shown()).toBe("Beta");
    await registry.commands.run("tab.show7", NOWHERE);
    expect(window.focusedIndex()).toBe(1);
    expect(window.shown()).toBe("Zeta");
  });

  test("with no tabs open, none is offered", async () => {
    core = startCore(await createTempDataFolder());
    await store.useAppStore.getState().loadLayout();
    expect(offeredHere()).toEqual([]);
  });

  test("are ⌃1–⌃9 on macOS and Alt+1–9 on Windows and Linux, so ⌘1–⌘3 and Ctrl+1–3 still go to a group", () => {
    for (const number of NUMBERS) {
      const shortcut = registry.commands.get(idOf(number))?.shortcut;
      if (!shortcut) throw new Error(`${idOf(number)} has no keys.`);
      expect(keys.keysLabel(keys.keysOn(shortcut.keys, true), true)).toBe(`⌃${number}`);
      expect(keys.keysLabel(keys.keysOn(shortcut.keys, false), false)).toBe(`Alt+${number}`);
    }
    for (const number of [1, 2, 3]) {
      const group = registry.commands.get(`group.focus${number}`)?.shortcut;
      if (!group) throw new Error(`group.focus${number} has no keys.`);
      expect(keys.keysLabel(keys.keysOn(group.keys, true), true)).toBe(`⌘${number}`);
      expect(keys.keysLabel(keys.keysOn(group.keys, false), false)).toBe(`Ctrl+${number}`);
    }
  });

  test("their labels say which tab, in English and Chinese", () => {
    const say = (id: CommandId, language: "en" | "zh-CN") => {
      const command = registry.commands.get(id);
      if (!command) throw new Error(`There is no ${id}.`);
      return registry.labelOf(command, NOWHERE, (key, params) => translate(language, key, params));
    };
    expect(say("tab.show3", "en")).toBe("Go to Tab 3");
    expect(say("tab.showLast", "en")).toBe("Go to Last Tab");
    expect(say("tab.show3", "zh-CN")).toBe("转到第 3 个标签页");
    expect(say("tab.showLast", "zh-CN")).toBe("转到最后一个标签页");
  });

  test("by the keys: the keymap takes ⌃3 (Alt+3) and shows the third tab, and leaves ⌃7 (Alt+7) alone with five tabs", async () => {
    const window = await fiveTabs();
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const globals = globalThis as unknown as { document?: unknown };
    const page = globals.document;
    globals.document = { querySelector: () => null };
    const press = (number: number) =>
      ({
        key: String(number),
        code: `Digit${number}`,
        metaKey: false,
        ctrlKey: mac,
        altKey: !mac,
        shiftKey: false,
        target: null,
        getModifierState: () => false,
        preventDefault: () => undefined,
      }) as unknown as KeyboardEvent;
    try {
      expect(keymap.runShortcut(press(3), NOWHERE)).toBe(true);
      await expect.poll(() => window.shown()).toBe("Gamma");
      expect(keymap.runShortcut(press(7), NOWHERE)).toBe(false);
      expect(window.shown()).toBe("Gamma");
    } finally {
      globals.document = page;
    }
  });
});

describe("Alt and the keypad", () => {
  test("Alt with a keypad digit types a character by its code on Windows, so it is no Alt+digit shortcut", () => {
    const held = (code: string) => ({
      key: "1",
      code,
      metaKey: false,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
    });
    expect(keys.pressed("Alt+1", held("Digit1"), false)).toBe(true);
    expect(keys.pressed("Alt+1", held("Numpad1"), false)).toBe(false);
    expect(
      keys.pressed("CmdOrCtrl+1", { ...held("Numpad1"), altKey: false, ctrlKey: true }, false),
    ).toBe(true);
  });
});
