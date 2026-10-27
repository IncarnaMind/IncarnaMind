import { type LayoutGroup, type LayoutTab, MAX_TAB_GROUPS } from "../../../core/api";
import {
  closeSome,
  cycleTabs,
  focusGroup,
  moveToGroup,
  moveWithinGroup,
  neighbourInRun,
  showTabByNumber,
  splitToTheRight,
  tabByNumber,
} from "../components/tabs/tabActions";
import { activeTabOf, focusedGroupOf, groupOfTab, groupsMerged } from "../layoutSlice";
import { useAppStore } from "../store";
import { type Command, type CommandContext, fromMenu } from "./registry";

/*
 * The tabs' and groups' commands (#264), as in VS Code and a browser. Each
 * acts on the tab it is run on (a tab's menu passes it as the focus), else on
 * the tab the keyboard is on, else on the focused group's shown tab.
 */

interface Target {
  tab: LayoutTab;
  group: LayoutGroup;
  /** The group's place from the left. */
  index: number;
}

/** The tab the keyboard is on, if it is on one. */
const keyboardTab = () =>
  document.activeElement?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;

function targetOf(ctx: CommandContext): Target | null {
  const { layout } = useAppStore.getState();
  if (!layout) return null;
  const id =
    ctx.focus?.kind === "tab"
      ? ctx.focus.id
      : (keyboardTab() ?? activeTabOf(focusedGroupOf(layout))?.id);
  const at = id ? groupOfTab(layout, id) : null;
  const tab = at?.group.tabs.find((each) => each.id === id);
  return at && tab ? { tab, ...at } : null;
}

const groupCount = () => useAppStore.getState().layout?.groups.length ?? 0;

/** Whether a tab moves right into a group that is there, rather than into a new one. */
const groupOnTheRight = (target: Target | null) =>
  target !== null && target.index < groupCount() - 1;

/** Runs `act` on the command's tab, if it has one. */
const onTarget =
  (act: (target: Target) => ReturnType<Command["run"]>) =>
  (ctx: CommandContext): ReturnType<Command["run"]> => {
    const target = targetOf(ctx);
    if (target) return act(target);
  };

const store = () => useAppStore.getState();

/** ⌘1–⌘3 go to a group, as in VS Code. */
const focusGroupCommands = [1, 2, 3].map(
  (number): Command => ({
    id: `group.focus${number}`,
    label: (_ctx, t) => t("command.group.focus", { n: number }),
    shortcut: { keys: `CmdOrCtrl+${number}` },
    palette: false,
    group: "open",
    reversible: true,
    run: () => focusGroup(number),
  }),
);

/**
 * ⌃1–⌃8 show a tab of the focused group by its place, ⌃9 its last, as in VS Code: Alt on Windows
 * and Linux, where Ctrl+1–3 go to a group.
 */
const showTabCommands = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
  (number): Command => ({
    id: number === 9 ? "tab.showLast" : `tab.show${number}`,
    label:
      number === 9 ? "command.tab.showLast" : (_ctx, t) => t("command.tab.show", { n: number }),
    shortcut: { keys: { mac: `Ctrl+${number}`, other: `Alt+${number}` } },
    group: "open",
    reversible: true,
    when: () => tabByNumber(number) !== null,
    run: () => showTabByNumber(number),
  }),
);

export const tabCommands: readonly Command[] = [
  {
    ...fromMenu("tab.close"),
    menuLabel: "tabs.menu.close",
    group: "danger",
    reversible: true,
    when: (ctx) => targetOf(ctx) !== null,
    run(ctx) {
      const tab = targetOf(ctx)?.tab;
      if (!tab) return;
      // Not run on the tab itself, a pinned one stays, as in VS Code, saying how to close it.
      if (tab.pinned && ctx.focus?.kind !== "tab") {
        store().showTabNotice({ kind: "pinned", item: tab.item });
      } else store().closeTab(tab.id);
    },
  },
  {
    ...fromMenu("tab.reopen"),
    group: "open",
    reversible: true,
    when: () => (store().layout?.reopenable ?? 0) > 0,
    run: () => store().reopenTab(),
  },
  {
    ...fromMenu("tab.split"),
    menuLabel: "tabs.menu.split",
    group: "open",
    reversible: true,
    when: (ctx) => targetOf(ctx) !== null,
    run: onTarget(({ tab }) => splitToTheRight(tab.id)),
  },
  {
    id: "tab.next",
    label: "command.tab.next",
    shortcut: { keys: "Ctrl+Tab" },
    group: "open",
    reversible: true,
    run: () => cycleTabs(1),
  },
  {
    id: "tab.previous",
    label: "command.tab.previous",
    shortcut: { keys: "Ctrl+Shift+Tab" },
    group: "open",
    reversible: true,
    run: () => cycleTabs(-1),
  },
  ...showTabCommands,
  ...focusGroupCommands,
  {
    id: "tab.keep",
    label: "command.tab.keep",
    menuLabel: "tabs.menu.keep",
    group: "main",
    reversible: true,
    when: (ctx) => targetOf(ctx)?.tab.preview === true,
    run: onTarget(async ({ tab }) => {
      await store().changeLayout({ type: "keep", tabId: tab.id });
    }),
  },
  {
    id: "tab.pin",
    label: (ctx, t) => t(targetOf(ctx)?.tab.pinned ? "command.tab.unpin" : "command.tab.pin"),
    menuLabel: (ctx, t) => t(targetOf(ctx)?.tab.pinned ? "tabs.menu.unpin" : "tabs.menu.pin"),
    group: "main",
    reversible: true,
    when: (ctx) => targetOf(ctx) !== null,
    run: onTarget(async ({ tab }) => {
      await store().changeLayout({ type: "pin", tabId: tab.id, pinned: !tab.pinned });
    }),
  },
  {
    id: "tab.moveEarlier",
    label: "command.tab.moveEarlier",
    // Chrome's and VS Code's key for moving a tab or editor left among its neighbours.
    shortcut: { keys: "Ctrl+Shift+PageUp" },
    group: "move",
    reversible: true,
    when: (ctx) => {
      const target = targetOf(ctx);
      return target !== null && neighbourInRun(target.group.tabs, target.tab, -1) !== null;
    },
    run: onTarget(({ tab }) => moveWithinGroup(tab.id, -1)),
  },
  {
    id: "tab.moveLater",
    label: "command.tab.moveLater",
    shortcut: { keys: "Ctrl+Shift+PageDown" },
    group: "move",
    reversible: true,
    when: (ctx) => {
      const target = targetOf(ctx);
      return target !== null && neighbourInRun(target.group.tabs, target.tab, 1) !== null;
    },
    run: onTarget(({ tab }) => moveWithinGroup(tab.id, 1)),
  },
  {
    id: "tab.moveLeft",
    label: "command.tab.moveLeft",
    menuLabel: "tabs.menu.moveLeft",
    group: "move",
    reversible: true,
    when: (ctx) => (targetOf(ctx)?.index ?? 0) > 0,
    run: onTarget(({ tab }) => moveToGroup(tab.id, -1)),
  },
  {
    id: "tab.moveRight",
    label: (ctx, t) =>
      t(groupOnTheRight(targetOf(ctx)) ? "command.tab.moveRight" : "command.tab.moveNew"),
    menuLabel: (ctx, t) =>
      t(groupOnTheRight(targetOf(ctx)) ? "tabs.menu.moveRight" : "tabs.menu.moveNew"),
    group: "move",
    reversible: true,
    when: (ctx) => {
      const target = targetOf(ctx);
      return (
        groupOnTheRight(target) ||
        (target !== null && groupCount() < MAX_TAB_GROUPS && target.group.tabs.length > 1)
      );
    },
    run: onTarget(({ tab }) => moveToGroup(tab.id, 1)),
  },
  {
    id: "tab.rename",
    label: "command.tab.rename",
    menuLabel: "tabs.menu.rename",
    // A tab list's own key, as F2 renames in any list.
    shortcut: { keys: "F2", list: true },
    group: "edit",
    reversible: true,
    // Not from another list's F2: only on a tab, or on the shown one from ⌘K, where its Mind's own Rename comes first.
    when: (ctx) =>
      targetOf(ctx)?.tab.item.kind === "mind" &&
      (ctx.focus?.kind === "tab" ||
        (ctx.surface === "palette" && ctx.here?.["mind.rename"] === undefined) ||
        keyboardTab() !== undefined),
    run: onTarget(({ tab }) => store().renameTab(tab.id)),
  },
  {
    id: "tab.closeOthers",
    label: "command.tab.closeOthers",
    menuLabel: "tabs.menu.closeOthers",
    group: "danger",
    reversible: true,
    when: (ctx) => (targetOf(ctx)?.group.tabs.length ?? 0) > 1,
    run: onTarget(({ tab }) => closeSome({ type: "closeOthers", tabId: tab.id }, tab)),
  },
  {
    id: "tab.closeToTheRight",
    label: "command.tab.closeRight",
    menuLabel: "tabs.menu.closeRight",
    group: "danger",
    reversible: true,
    when: (ctx) => {
      const target = targetOf(ctx);
      return target !== null && target.group.tabs.at(-1)?.id !== target.tab.id;
    },
    run: onTarget(({ tab }) => closeSome({ type: "closeToTheRight", tabId: tab.id }, tab)),
  },
  {
    id: "group.close",
    label: "command.group.close",
    group: "main",
    reversible: true,
    when: (ctx) => targetOf(ctx) !== null,
    run: onTarget(({ tab, group }) => closeSome({ type: "closeGroup", groupId: group.id }, tab)),
  },
  {
    id: "group.equalize",
    label: "command.group.equalize",
    group: "main",
    reversible: true,
    when: () => groupCount() > 1 && !groupsMerged(),
    run: async () => {
      await store().changeLayout({ type: "equalize" });
    },
  },
];
