import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Core, LayoutChange } from "../../src/core";
import type { CommandId } from "../../src/shared/commands";
import { createTempDataFolder, startCore } from "../helpers/core";
import { stubEditorDom } from "../helpers/editorDom";

/*
 * A tab shown by a command takes the focus into its Note only when the User ran the command, by
 * its shortcut or from ⌘K (#3115): run by the assistant, it shows the tab and leaves the focus
 * where the User is, as in the composer they are typing in. Run from the registry, as the window
 * and the assistant run them, with the core's own layouts behind the bridge.
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
type Store = typeof import("../../src/renderer/src/store");
type Slice = typeof import("../../src/renderer/src/layoutSlice");
type TabFocus = typeof import("../../src/renderer/src/tabFocus");
let registry: Registry;
let store: Store;
let slice: Slice;
let tabFocus: TabFocus;

beforeAll(async () => {
  stubEditorDom();
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  await import("../../src/renderer/src/commands/app");
  registry = await import("../../src/renderer/src/commands/registry");
  store = await import("../../src/renderer/src/store");
  slice = await import("../../src/renderer/src/layoutSlice");
  tabFocus = await import("../../src/renderer/src/tabFocus");
});

afterEach(() => {
  core = null;
});

const NOWHERE = { selection: [], focus: null, surface: "mind" } as const;
const BY_THE_ASSISTANT = { ...NOWHERE, assistant: true } as const;

/** A window with three Notes' tabs, the last shown, each Note's text ready to take the focus. */
async function threeNotes() {
  core = startCore(await createTempDataFolder());
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    const mind = await running().createMind({ title });
    await running().changeLayout("main", { type: "open", item: { kind: "mind", mindId: mind.id } });
  }
  await store.useAppStore.getState().loadLayout();
  const group = () => {
    const layout = store.useAppStore.getState().layout;
    if (!layout) throw new Error("The window has no layout.");
    return slice.focusedGroupOf(layout);
  };
  const tab = (index: number) => {
    const found = group().tabs[index];
    if (!found) throw new Error(`There is no tab ${index}.`);
    return found.id;
  };
  const taken: string[] = [];
  for (const each of group().tabs) tabFocus.takeContentFocus(each.id, () => taken.push(each.id));
  const shown = () => slice.activeTabOf(group())?.id;
  return { tab, taken, shown };
}

describe("a tab shown by a command", () => {
  // protects=Next tab, Previous tab and Go to Tab run by the assistant show the tab and put no focus in its Note, so the composer the User is typing in keeps it; run by the User, the same commands put the focus in the Note's text (#3115); fails_when=the assistant's command moves the focus out of where the User types, or the User's shortcut leaves it off the Note; no_claim=which commands the assistant may run, which tests/core holds.
  test.each<[CommandId, number]>([
    ["tab.next", 0],
    ["tab.previous", 1],
    ["tab.show1", 0],
  ])(
    "%s run by the assistant leaves the focus; run by the User, it goes into the Note",
    async (id, index) => {
      const window = await threeNotes();
      const wanted = window.tab(index);
      await registry.commands.run(id, BY_THE_ASSISTANT);
      await vi.waitFor(() => expect(window.shown()).toBe(wanted));
      expect(window.taken).toEqual([]);

      await store.useAppStore.getState().changeLayout({ type: "show", tabId: window.tab(2) });
      await registry.commands.run(id, NOWHERE);
      await vi.waitFor(() => expect(window.shown()).toBe(wanted));
      expect(window.taken).toEqual([wanted]);
    },
  );
});
