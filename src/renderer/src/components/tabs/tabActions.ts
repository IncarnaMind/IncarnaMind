import {
  type LayoutChange,
  type LayoutTab,
  MAX_TAB_GROUPS,
  type WindowLayout,
} from "../../../../core/api";
import { shortcutLabel } from "../../commands/keymap";
import { activeTabOf, focusedGroupOf, groupOfTab, groupsMerged } from "../../layoutSlice";
import { useAppStore } from "../../store";
import { focusTab } from "../../tabFocus";
import { tabTitle } from "../../tabs";
import type { Undoable } from "../../undo";

/*
 * What the tab commands and buttons do beyond one change to the layout: they
 * say why nothing happened, and move the keyboard's focus with the tab.
 */

/** ⌥⌘\: a copy of a tab (the shown one by default) in a new group on the right. */
export async function splitToTheRight(tabId?: string): Promise<void> {
  const store = useAppStore.getState();
  const { layout } = store;
  if (!layout) return;
  const tab = tabId ?? activeTabOf(focusedGroupOf(layout))?.id;
  if (!tab) return;
  if (layout.groups.length >= MAX_TAB_GROUPS) {
    store.showTabNotice({ kind: "maxGroups" });
    return;
  }
  const next = await store.changeLayout({ type: "split", tabId: tab, side: "right", copy: true });
  if (!next) return;
  if (groupsMerged()) store.showTabNotice({ kind: "merged" });
  focusTab(activeTabOf(focusedGroupOf(next))?.id);
}

/** ⌘1–⌘3: the keyboard's focus to a group's shown tab. */
export async function focusGroup(number: number): Promise<void> {
  const store = useAppStore.getState();
  const group = store.layout?.groups[number - 1];
  if (!group) {
    store.showTabNotice({ kind: "noGroup", group: number, shortcut: shortcutLabel("tab.split") });
    return;
  }
  const next = await store.changeLayout({ type: "focus", groupId: group.id });
  if (next) focusTab(group.activeTabId);
}

/** Moves a tab to the group on its left or right, or into a new group on the right. */
export async function moveToGroup(tabId: string, direction: -1 | 1): Promise<void> {
  const store = useAppStore.getState();
  const at = groupOfTab(store.layout, tabId);
  if (!at || !store.layout) return;
  const target = store.layout.groups[at.index + direction];
  const next = target
    ? await store.changeLayout({ type: "move", tabId, groupId: target.id, before: null })
    : await store.changeLayout({ type: "split", tabId, side: "right", copy: false });
  if (next) focusTab(tabId);
}

/** Puts a tab at a place among its group's tabs, by the id of the tab that takes the place after it. */
async function moveTabTo(tabId: string, place: number): Promise<void> {
  const at = groupOfTab(useAppStore.getState().layout, tabId);
  if (!at) return;
  const others = at.group.tabs.filter((tab) => tab.id !== tabId);
  await useAppStore.getState().changeLayout({
    type: "move",
    tabId,
    groupId: at.group.id,
    before: others[place]?.id ?? null,
  });
}

/** The tab next to this one in the same run of pinned or unpinned tabs: none across that line. */
export function neighbourInRun(tabs: LayoutTab[], tab: LayoutTab, step: -1 | 1): LayoutTab | null {
  const neighbour = tabs[tabs.indexOf(tab) + step];
  return neighbour && neighbour.pinned === tab.pinned ? neighbour : null;
}

/**
 * Moves a tab one place earlier or later among its group's tabs, only among those pinned as it
 * is, shows it and offers Undo.
 */
export async function moveWithinGroup(tabId: string, step: -1 | 1): Promise<Undoable | undefined> {
  const store = useAppStore.getState();
  const at = groupOfTab(store.layout, tabId);
  const tab = at?.group.tabs.find((each) => each.id === tabId);
  if (!at || !tab) return;
  const tabs = at.group.tabs;
  const place = tabs.indexOf(tab);
  const neighbour = neighbourInRun(tabs, tab, step);
  if (!neighbour) return;
  const before = step === -1 ? neighbour.id : (tabs[place + 2]?.id ?? null);
  const next = await store.changeLayout({ type: "move", tabId, groupId: at.group.id, before });
  if (!next) return;
  focusTab(tabId);
  return {
    said: (t) =>
      t(step === -1 ? "undo.tabMovedLeft" : "undo.tabMovedRight", {
        name: tabTitle(useAppStore.getState(), tab.item, t),
      }),
    name: (t) => t("undo.name.tabMove"),
    undo: () => moveTabTo(tabId, place),
    redo: () => moveTabTo(tabId, place + step),
  };
}

const openTabs = (layout: WindowLayout | null) =>
  layout?.groups.reduce((sum, group) => sum + group.tabs.length, 0) ?? 0;

/** Closes tabs, then says how many, with Reopen. */
export async function closeSome(change: LayoutChange, tab: LayoutTab): Promise<void> {
  const store = useAppStore.getState();
  // Not from `reopenable`, which stops growing once it holds as many as the core keeps.
  const before = openTabs(store.layout);
  const next = await store.changeLayout(change);
  const count = next ? before - openTabs(next) : 0;
  if (count > 0) store.showTabNotice({ kind: "closed", item: tab.item, count });
}

/** Shows the next or previous tab of the focused group (Ctrl+Tab, Ctrl+Shift+Tab). */
export function cycleTabs(step: 1 | -1): void {
  const store = useAppStore.getState();
  if (!store.layout) return;
  const group = focusedGroupOf(store.layout);
  if (group.tabs.length === 0) return;
  const index = group.tabs.findIndex((tab) => tab.id === group.activeTabId);
  const next = group.tabs[(index + step + group.tabs.length) % group.tabs.length];
  if (next) void store.changeLayout({ type: "show", tabId: next.id });
}

/**
 * The focused group's tab at this place from 1, or its last for 9 (⌃1–⌃9); null where there is
 * none. With the groups merged, their one strip holds every group's tabs, as the User sees them.
 */
export function tabByNumber(number: number): LayoutTab | null {
  const { layout } = useAppStore.getState();
  if (!layout) return null;
  const tabs = groupsMerged()
    ? layout.groups.flatMap((group) => group.tabs)
    : focusedGroupOf(layout).tabs;
  return (number === 9 ? tabs.at(-1) : tabs[number - 1]) ?? null;
}

export async function showTabByNumber(number: number): Promise<void> {
  const tab = tabByNumber(number);
  if (tab) await useAppStore.getState().changeLayout({ type: "show", tabId: tab.id });
}
